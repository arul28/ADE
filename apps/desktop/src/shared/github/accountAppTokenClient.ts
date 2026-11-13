import {
  GITHUB_APP_CLIENT_SAFETY_SEC,
  GITHUB_APP_PATHS,
  GITHUB_APP_SIGN_IN_ID_PATTERN,
  githubAppSignInPath,
  type GithubAppAdoptRequest,
  type GithubAppClientKind,
  type GithubAppDisconnectResponse,
  type GithubAppNeedsReauthReason,
  type GithubAppSignInReadResponse,
  type GithubAppSignInStartResponse,
  type GithubAppStatusResponse,
} from "../../../../account-directory/src/githubApp/contract";
import { readBoundedAccountDirectoryJson } from "../accountDirectory";

/**
 * The client side of the ADE GitHub App sign-in that belongs to the account
 * (server: `apps/account-directory/src/githubApp`).
 *
 * The account directory keeps the refresh token and renews the access token.
 * A machine asks it for the current access token only when its cached one
 * reaches its stop time, so this module adds no timer.
 *
 * Isomorphic: `fetch`, the account token and the cache store are injected, so
 * the desktop main process, the brain (also on a cloud computer) and tests use
 * the same code. The cache store is the machine credential store on a
 * machine. The desktop and the brain on one machine read the same entry, and
 * a fetch lease in that entry keeps two processes from asking at the same
 * time.
 *
 * Nothing here logs or returns a refresh token: the server never sends one.
 * The access token leaves only through `getToken`.
 */

/** The machine credential store key of the cache entry. */
export const GITHUB_ACCOUNT_APP_TOKEN_KEY = "github.accountAppToken.v1";

/** How long one process may hold the right to ask the server for a token. Longer than one request. */
const FETCH_LEASE_MS = 50_000;
const LEASE_POLL_INTERVAL_MS = 250;
/** About three seconds of waiting for a peer's answer. */
const LEASE_POLL_MAX_ATTEMPTS = 12;
/**
 * One token request. The server may first wait out its closing window (15 s)
 * and then renew at GitHub (up to 20 s), so a shorter limit would abort a
 * renewal that works and leave a network failure cached for a minute.
 */
const REQUEST_TIMEOUT_MS = 45_000;
/** A token the inventory read may still hand out after this entry says stop. */
const DEFAULT_HOLD_MARGIN_MS = 30_000;
/** At most one "rejected" question per token per process in this window. */
const REJECTED_GUARD_MS = 60_000;

/** How long a negative answer stands before a machine asks again. */
const RETRY_NOT_CONNECTED_MS = 60 * 60_000;
const RETRY_NEEDS_REAUTH_MS = 60 * 60_000;
const RETRY_UNSUPPORTED_MS = 6 * 60 * 60_000;
const RETRY_UNAVAILABLE_MIN_MS = 30_000;
const RETRY_UNAVAILABLE_DEFAULT_MS = 60_000;
const RETRY_UNAVAILABLE_MAX_MS = 60 * 60_000;

/**
 * - `active`: a token is cached (it may be past its stop time; then the next
 *   read asks again).
 * - `not_connected`: the account has no GitHub App sign-in.
 * - `needs_reauth`: the account's sign-in ended; a person must connect again.
 * - `unavailable`: the server or GitHub did not answer; ADE asks again later.
 * - `unsupported`: the server has no GitHub App routes yet, or no secrets.
 * - `signed_out`: this machine has no ADE account.
 * - `unknown`: nothing asked yet.
 */
export type AccountAppState =
  | "active"
  | "not_connected"
  | "needs_reauth"
  | "unavailable"
  | "unsupported"
  | "signed_out"
  | "unknown";

export type AccountAppCacheEntry = {
  v: 1;
  accountUserId: string;
  state: Exclude<AccountAppState, "signed_out" | "unknown">;
  accessToken?: string;
  /** Epoch ms: stop handing out `accessToken` at this instant. */
  useUntilEpochMs?: number;
  generation?: number;
  githubLogin?: string | null;
  githubUserId?: number | null;
  /** Why a sign-in ended (`needs_reauth`) or why the routes are off (`unsupported`). */
  stateReason?: string | null;
  /** Epoch ms: a negative answer stands until this instant. */
  retryAtEpochMs?: number;
  fetchLeaseUntil?: number;
  fetchLeaseHolder?: string;
};

export type AccountAppCacheView = {
  state: AccountAppState;
  githubLogin: string | null;
  stateReason: string | null;
  /** A token that may be handed out now, or null. */
  usableToken: string | null;
  retryAtEpochMs: number | null;
};

export type AccountAppTokenResult =
  | { ok: true; token: string; githubLogin: string | null; generation: number | null; verified: boolean }
  | { ok: false; state: Exclude<AccountAppState, "active">; reason: string | null; retryAtEpochMs: number | null };

/** A request to the account directory that came back, with its parsed body. */
export type AccountDirectoryAnswer = {
  status: number;
  body: unknown;
  retryAfterSec: number | null;
};

export type AccountAppTokenStore = {
  /** The raw cache value, or null. */
  read(): string | null;
  /**
   * One atomic read-modify-write of the cache key, shared by every process on
   * the machine. Return `undefined` to write nothing, `null` to delete.
   */
  update(mutator: (current: string | null) => string | null | undefined): void;
  /** Names the storage, so every client over one file shares one in-flight read. */
  identity(): string;
};

export type AccountAppTokenClientOptions = {
  fetchImpl?: typeof fetch;
  getAccountAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  getAccountUserId: () => string | null;
  getDirectoryBaseUrl: () => string | null;
  /** Null keeps the cache in this process only (web, tests). */
  store: AccountAppTokenStore | null;
  /** Names this process in the fetch lease. */
  holderId: string;
  /** `desktop` and `cli` get a browser page at the end of a sign-in. */
  clientKind: GithubAppClientKind;
  holdMarginMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    info?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shortString(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

const CACHE_STATES = new Set(["active", "not_connected", "needs_reauth", "unavailable", "unsupported"]);

export function parseAccountAppCacheEntry(raw: string | null | undefined): AccountAppCacheEntry | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1) return null;
    const accountUserId = shortString(parsed.accountUserId, 512);
    const state = typeof parsed.state === "string" && CACHE_STATES.has(parsed.state)
      ? parsed.state as AccountAppCacheEntry["state"]
      : null;
    if (!accountUserId || !state) return null;
    const entry: AccountAppCacheEntry = { v: 1, accountUserId, state };
    const accessToken = shortString(parsed.accessToken, 4096);
    if (accessToken) entry.accessToken = accessToken;
    const useUntil = finiteNumber(parsed.useUntilEpochMs);
    if (useUntil != null) entry.useUntilEpochMs = useUntil;
    const generation = finiteNumber(parsed.generation);
    if (generation != null) entry.generation = generation;
    entry.githubLogin = shortString(parsed.githubLogin, 100);
    entry.githubUserId = finiteNumber(parsed.githubUserId);
    entry.stateReason = shortString(parsed.stateReason, 64);
    const retryAt = finiteNumber(parsed.retryAtEpochMs);
    if (retryAt != null) entry.retryAtEpochMs = retryAt;
    const leaseUntil = finiteNumber(parsed.fetchLeaseUntil);
    const leaseHolder = shortString(parsed.fetchLeaseHolder, 128);
    if (leaseUntil != null && leaseHolder) {
      entry.fetchLeaseUntil = leaseUntil;
      entry.fetchLeaseHolder = leaseHolder;
    }
    return entry;
  } catch {
    return null;
  }
}

/** SHA-256 of a token, lowercase hex, as the server's `rejectedTokenSha256` wants it. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorCodeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (isRecord(error)) return shortString(error.code, 64);
  return null;
}

function errorReasonOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (isRecord(error)) return shortString(error.reason, 64) ?? shortString(body.reason, 64);
  return shortString(body.reason, 64);
}

/**
 * The stop time of a token received at `receivedAt`.
 *
 * The server's deadline already holds a margin; the client stops
 * `GITHUB_APP_CLIENT_SAFETY_SEC` before it, and a further `holdMargin` covers
 * the reads that keep a resolved token for a short time (the credential
 * inventory caches for 30 s). The hold margin never takes more than half of
 * what is left, so a short degraded answer still serves a little while.
 */
export function accountAppUseUntil(receivedAt: number, useForSec: number, holdMarginMs: number): number {
  const usableMs = Math.max(0, (useForSec - GITHUB_APP_CLIENT_SAFETY_SEC) * 1000);
  return receivedAt + usableMs - Math.min(holdMarginMs, usableMs / 2);
}

function retryAfterMs(retryAfterSec: number | null): number {
  const requested = retryAfterSec != null ? retryAfterSec * 1000 : RETRY_UNAVAILABLE_DEFAULT_MS;
  return Math.min(Math.max(requested, RETRY_UNAVAILABLE_MIN_MS), RETRY_UNAVAILABLE_MAX_MS);
}

type StoreScope = {
  inFlight: Promise<AccountAppTokenResult> | null;
  inFlightKey: string | null;
  /** Token digest → when this process last told the server it was rejected. */
  rejectedAt: Map<string, number>;
  memory: string | null;
};

const scopes = new Map<string, StoreScope>();
let anonymousScopeCounter = 0;

function scopeFor(identity: string): StoreScope {
  let scope = scopes.get(identity);
  if (!scope) {
    scope = { inFlight: null, inFlightKey: null, rejectedAt: new Map(), memory: null };
    scopes.set(identity, scope);
  }
  return scope;
}

export function createAccountAppTokenClient(options: AccountAppTokenClientOptions) {
  const now = options.now ?? (() => Date.now());
  // The lease wait keeps the process alive on purpose: it is short (one
  // lease at most), and a one-shot CLI process that waits for another
  // process's fetch must not exit before it reads the result.
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const holdMarginMs = options.holdMarginMs ?? DEFAULT_HOLD_MARGIN_MS;
  const scope = scopeFor(options.store?.identity() ?? `ade.account-app.memory.${(anonymousScopeCounter += 1)}`);

  const readRaw = (): string | null => {
    if (!options.store) return scope.memory;
    try {
      return options.store.read();
    } catch {
      return null;
    }
  };

  const update = (mutator: (current: string | null) => string | null | undefined): void => {
    if (!options.store) {
      const next = mutator(scope.memory);
      if (next !== undefined) scope.memory = next;
      return;
    }
    options.store.update(mutator);
  };

  /** The cache entry for the signed-in account, or null (another account's entry reads as none). */
  const readEntry = (userId: string): AccountAppCacheEntry | null => {
    const entry = parseAccountAppCacheEntry(readRaw());
    return entry && entry.accountUserId === userId ? entry : null;
  };

  const usableToken = (entry: AccountAppCacheEntry | null, at: number): string | null =>
    entry?.state === "active" && entry.accessToken && (entry.useUntilEpochMs ?? 0) > at
      ? entry.accessToken
      : null;

  const writeEntry = (userId: string, next: Omit<AccountAppCacheEntry, "v" | "accountUserId">): void => {
    try {
      update((current) => {
        const existing = parseAccountAppCacheEntry(current);
        // The account changed while the request ran: the answer belongs to the
        // old account, so it must not land under the new one.
        if (options.getAccountUserId() !== userId) return undefined;
        const entry: AccountAppCacheEntry = { v: 1, accountUserId: userId, ...next };
        // A peer's lease outlives this write; ours ends with it.
        if (
          existing?.accountUserId === userId
          && existing.fetchLeaseHolder
          && existing.fetchLeaseHolder !== options.holderId
          && (existing.fetchLeaseUntil ?? 0) > now()
        ) {
          entry.fetchLeaseHolder = existing.fetchLeaseHolder;
          entry.fetchLeaseUntil = existing.fetchLeaseUntil;
        }
        return JSON.stringify(entry);
      });
    } catch (error) {
      options.logger?.warn?.("github.account_app_cache_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** One request to the account directory with the account token; one retry after a 401. */
  const directoryRequest = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<AccountDirectoryAnswer | { error: "signed_out" | "no_directory" | "network" }> => {
    const baseUrl = options.getDirectoryBaseUrl();
    if (!baseUrl) return { error: "no_directory" };
    // The ADE account this request is for. A switch while it runs must not
    // send it (or its 401 retry) with another account's bearer: a Disconnect
    // started under one account would end another's grant.
    const startAccount = options.getAccountUserId()?.trim() || null;
    const sameAccount = (): boolean => (options.getAccountUserId()?.trim() || null) === startAccount;
    const send = async (forceRefresh: boolean): Promise<Response | "signed_out"> => {
      if (!sameAccount()) return "signed_out";
      const token = (await options.getAccountAccessToken(forceRefresh ? { forceRefresh: true } : undefined).catch(() => null))?.trim();
      if (!token || !sameAccount()) return "signed_out";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    let response: Response | "signed_out";
    try {
      response = await send(false);
      if (response !== "signed_out" && response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        response = await send(true);
      }
      if (response !== "signed_out" && !sameAccount()) {
        await response.body?.cancel().catch(() => undefined);
        response = "signed_out";
      }
    } catch {
      return { error: "network" };
    }
    if (response === "signed_out") return { error: "signed_out" };
    const retryAfterRaw = Number(response.headers.get("retry-after"));
    const retryAfterSec = Number.isFinite(retryAfterRaw) && retryAfterRaw >= 0 ? retryAfterRaw : null;
    let parsed: unknown;
    if (response.status === 204) {
      parsed = null;
      await response.body?.cancel().catch(() => undefined);
    } else {
      try {
        parsed = await readBoundedAccountDirectoryJson(response);
      } catch {
        parsed = undefined;
        await response.body?.cancel().catch(() => undefined);
      }
    }
    // The account can change while the body is read: that answer is not this account's.
    if (!sameAccount()) return { error: "signed_out" };
    return { status: response.status, body: parsed, retryAfterSec };
  };

  const negative = (
    userId: string,
    state: Exclude<AccountAppCacheEntry["state"], "active">,
    retryInMs: number,
    reason: string | null,
    keep: AccountAppCacheEntry | null,
  ): AccountAppTokenResult => {
    const retryAtEpochMs = now() + retryInMs;
    writeEntry(userId, {
      state,
      stateReason: reason,
      retryAtEpochMs,
      // The login stays for the status line ("needs reconnecting: @x").
      githubLogin: keep?.githubLogin ?? null,
      githubUserId: keep?.githubUserId ?? null,
    });
    return { ok: false, state, reason, retryAtEpochMs };
  };

  /** Asks the server for the current token and records the answer. */
  const fetchToken = async (
    userId: string,
    rejectedSha: string | null,
    previous: AccountAppCacheEntry | null,
  ): Promise<AccountAppTokenResult> => {
    const answer = await directoryRequest("POST", GITHUB_APP_PATHS.token, rejectedSha
      ? { reason: "rejected", rejectedTokenSha256: rejectedSha }
      : { reason: "expired" });
    if ("error" in answer) {
      if (answer.error === "signed_out") {
        return { ok: false, state: "signed_out", reason: null, retryAtEpochMs: null };
      }
      if (answer.error === "no_directory") {
        return { ok: false, state: "unsupported", reason: "no_directory", retryAtEpochMs: null };
      }
      return negative(userId, "unavailable", RETRY_UNAVAILABLE_DEFAULT_MS, "network", previous);
    }
    const code = errorCodeOf(answer.body);
    if (answer.status === 200 && isRecord(answer.body)) {
      const accessToken = shortString(answer.body.accessToken, 4096);
      const useForSec = finiteNumber(answer.body.useForSec);
      if (accessToken && useForSec != null && useForSec > GITHUB_APP_CLIENT_SAFETY_SEC) {
        const receivedAt = now();
        const githubLogin = shortString(answer.body.githubLogin, 100);
        const generation = finiteNumber(answer.body.generation);
        writeEntry(userId, {
          state: "active",
          accessToken,
          useUntilEpochMs: accountAppUseUntil(receivedAt, useForSec, holdMarginMs),
          generation: generation ?? undefined,
          githubLogin,
          githubUserId: finiteNumber(answer.body.githubUserId),
          stateReason: answer.body.degraded === true ? "degraded" : null,
        });
        options.logger?.info?.("github.account_app_token_received", {
          generation,
          reason: rejectedSha ? "rejected" : "expired",
          verified: answer.body.verified === true,
          degraded: answer.body.degraded === true,
        });
        return { ok: true, token: accessToken, githubLogin, generation, verified: answer.body.verified === true };
      }
      return negative(userId, "unavailable", RETRY_UNAVAILABLE_DEFAULT_MS, "bad_answer", previous);
    }
    if (answer.status === 404 && code === "not_connected") {
      return negative(userId, "not_connected", RETRY_NOT_CONNECTED_MS, null, null);
    }
    if (answer.status === 409 && code === "needs_reauth") {
      return negative(userId, "needs_reauth", RETRY_NEEDS_REAUTH_MS, errorReasonOf(answer.body), previous);
    }
    if (answer.status === 503 && code === "github_app_not_configured") {
      return negative(userId, "unsupported", RETRY_UNSUPPORTED_MS, "not_configured", previous);
    }
    // A route the server does not know: a directory older than the GitHub App
    // routes. The machine behaves as before them.
    if ((answer.status === 404 || answer.status === 405) && code !== "not_connected") {
      return negative(userId, "unsupported", RETRY_UNSUPPORTED_MS, "old_server", previous);
    }
    if (answer.status === 429 || answer.status === 503) {
      return negative(userId, "unavailable", retryAfterMs(answer.retryAfterSec), code, previous);
    }
    return negative(userId, "unavailable", RETRY_UNAVAILABLE_DEFAULT_MS, `http_${answer.status}`, previous);
  };

  type LeaseAttempt = { kind: "cached"; token: string; entry: AccountAppCacheEntry } | { kind: "held" } | { kind: "acquired" };

  const acquireLease = (userId: string, rejectedSha: string | null, rejectedToken: string | null): LeaseAttempt => {
    let result: LeaseAttempt = { kind: "acquired" };
    try {
      update((current) => {
        const at = now();
        const parsed = parseAccountAppCacheEntry(current);
        const entry = parsed?.accountUserId === userId ? parsed : null;
        const token = usableToken(entry, at);
        if (entry && token && (!rejectedSha || token !== rejectedToken)) {
          result = { kind: "cached", token, entry };
          return undefined;
        }
        if (
          entry?.fetchLeaseHolder
          && entry.fetchLeaseHolder !== options.holderId
          && (entry.fetchLeaseUntil ?? 0) > at
          && (entry.fetchLeaseUntil ?? 0) <= at + FETCH_LEASE_MS
        ) {
          result = { kind: "held" };
          return undefined;
        }
        result = { kind: "acquired" };
        const next: AccountAppCacheEntry = entry
          ? { ...entry }
          : { v: 1, accountUserId: userId, state: "unavailable", retryAtEpochMs: 0 };
        next.fetchLeaseHolder = options.holderId;
        next.fetchLeaseUntil = at + FETCH_LEASE_MS;
        return JSON.stringify(next);
      });
    } catch {
      // A store that refuses the write cannot coordinate; ask anyway.
      result = { kind: "acquired" };
    }
    return result;
  };

  const releaseLease = (): void => {
    try {
      update((current) => {
        const entry = parseAccountAppCacheEntry(current);
        if (!entry || entry.fetchLeaseHolder !== options.holderId) return undefined;
        const next = { ...entry };
        delete next.fetchLeaseHolder;
        delete next.fetchLeaseUntil;
        return JSON.stringify(next);
      });
    } catch {
      // The lease ends on its own.
    }
  };

  const resolveToken = async (
    userId: string,
    rejectedToken: string | null,
    force: boolean,
  ): Promise<AccountAppTokenResult> => {
    const rejectedSha = rejectedToken ? await sha256Hex(rejectedToken) : null;
    let entry = readEntry(userId);
    const cached = usableToken(entry, now());
    if (cached && (!rejectedToken || cached !== rejectedToken)) {
      return { ok: true, token: cached, githubLogin: entry?.githubLogin ?? null, generation: entry?.generation ?? null, verified: false };
    }
    if (!force && !rejectedToken && entry && entry.state !== "active" && (entry.retryAtEpochMs ?? 0) > now()) {
      return { ok: false, state: entry.state, reason: entry.stateReason ?? null, retryAtEpochMs: entry.retryAtEpochMs ?? null };
    }
    let lease = acquireLease(userId, rejectedSha, rejectedToken);
    for (let attempt = 0; lease.kind === "held" && attempt < LEASE_POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(LEASE_POLL_INTERVAL_MS);
      entry = readEntry(userId);
      const token = usableToken(entry, now());
      if (entry && token && (!rejectedToken || token !== rejectedToken)) {
        return { ok: true, token, githubLogin: entry.githubLogin ?? null, generation: entry.generation ?? null, verified: false };
      }
      // A peer answered with a negative: take it rather than ask again.
      if (entry && entry.state !== "active" && !entry.fetchLeaseHolder && (entry.retryAtEpochMs ?? 0) > now() && !force) {
        return { ok: false, state: entry.state, reason: entry.stateReason ?? null, retryAtEpochMs: entry.retryAtEpochMs ?? null };
      }
      lease = acquireLease(userId, rejectedSha, rejectedToken);
    }
    if (lease.kind === "cached") {
      return { ok: true, token: lease.token, githubLogin: lease.entry.githubLogin ?? null, generation: lease.entry.generation ?? null, verified: false };
    }
    // Still held after the wait: the peer is slow. The server answers two
    // askers with the same token, so asking now costs one request, not a
    // second refresh.
    try {
      return await fetchToken(userId, rejectedSha, entry);
    } finally {
      releaseLease();
    }
  };

  /**
   * The current access token of the account's GitHub App sign-in.
   *
   * `afterRejected`: GitHub answered 401 to this token. The client asks the
   * server once (the server checks the token at GitHub at most once a minute
   * per account), and at most once a minute per token in this process.
   * `force`: ignore a negative answer that still stands (a person pressed
   * "Check again", or a sign-in just finished).
   * `userRequested`: a person pressed Refresh. With `afterRejected`, the
   * question goes to the server even inside the one-minute window, so each
   * press asks once; background callers keep the window.
   */
  const getToken = async (
    args: { afterRejected?: string | null; force?: boolean; userRequested?: boolean } = {},
  ): Promise<AccountAppTokenResult> => {
    const userId = options.getAccountUserId()?.trim() || null;
    if (!userId) return { ok: false, state: "signed_out", reason: null, retryAtEpochMs: null };
    const rejected = args.afterRejected?.trim() || null;
    if (rejected) {
      const digest = await sha256Hex(rejected);
      const last = scope.rejectedAt.get(digest) ?? 0;
      if (args.userRequested !== true && now() - last < REJECTED_GUARD_MS) {
        return { ok: false, state: "unavailable", reason: "rejected_recently", retryAtEpochMs: last + REJECTED_GUARD_MS };
      }
      scope.rejectedAt.set(digest, now());
      // Old digests are worth nothing after the guard window.
      for (const [key, at] of scope.rejectedAt) {
        if (now() - at >= REJECTED_GUARD_MS) scope.rejectedAt.delete(key);
      }
    }
    // A token is the answer for the account that asked: one that arrives after
    // a switch to another account is not handed to the caller.
    const forThisAccount = (answer: AccountAppTokenResult): AccountAppTokenResult =>
      (options.getAccountUserId()?.trim() || null) === userId
        ? answer
        : { ok: false, state: "unavailable", reason: "account_changed", retryAtEpochMs: null };
    const key = `${userId}:${rejected ? "rejected" : "current"}:${args.force ? "force" : ""}`;
    if (scope.inFlight && scope.inFlightKey === key) return forThisAccount(await scope.inFlight);
    if (scope.inFlight && !rejected && scope.inFlightKey?.startsWith(`${userId}:`)) {
      // Another read for this account is asking already; its answer serves this one.
      const answer = await scope.inFlight.catch(() => null);
      if (answer?.ok) return forThisAccount(answer);
    }
    const work = resolveToken(userId, rejected, args.force === true);
    scope.inFlight = work;
    scope.inFlightKey = key;
    try {
      return forThisAccount(await work);
    } finally {
      if (scope.inFlight === work) {
        scope.inFlight = null;
        scope.inFlightKey = null;
      }
    }
  };

  /** What the cache says now, with no request. */
  const peek = (): AccountAppCacheView => {
    const userId = options.getAccountUserId()?.trim() || null;
    if (!userId) return { state: "signed_out", githubLogin: null, stateReason: null, usableToken: null, retryAtEpochMs: null };
    const entry = readEntry(userId);
    if (!entry) return { state: "unknown", githubLogin: null, stateReason: null, usableToken: null, retryAtEpochMs: null };
    return {
      state: entry.state,
      githubLogin: entry.githubLogin ?? null,
      stateReason: entry.stateReason ?? null,
      usableToken: usableToken(entry, now()),
      retryAtEpochMs: entry.retryAtEpochMs ?? null,
    };
  };

  /** Drops a negative answer, so the next read asks. A cached token stays. */
  const clearNegative = (): void => {
    try {
      update((current) => {
        const entry = parseAccountAppCacheEntry(current);
        if (!entry || entry.state === "active") return undefined;
        return null;
      });
    } catch {
      // Nothing to clear.
    }
  };

  /** Drops the cache entry, token included (sign-out, account switch, disconnect). */
  const clearCache = (): void => {
    try {
      update((current) => (current == null ? undefined : null));
    } catch (error) {
      options.logger?.warn?.("github.account_app_cache_clear_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Drops an entry that belongs to another account (an account switch). */
  const dropForeignEntry = (): void => {
    const userId = options.getAccountUserId()?.trim() || null;
    try {
      update((current) => {
        const entry = parseAccountAppCacheEntry(current);
        if (current == null) return undefined;
        if (entry && userId && entry.accountUserId === userId) return undefined;
        return null;
      });
    } catch {
      // Read paths ignore a foreign entry anyway.
    }
  };

  const status = async (): Promise<
    | { ok: true; status: GithubAppStatusResponse }
    | { ok: false; error: "signed_out" | "unsupported" | "unavailable" }
  > => {
    const answer = await directoryRequest("GET", GITHUB_APP_PATHS.status);
    if ("error" in answer) return { ok: false, error: answer.error === "signed_out" ? "signed_out" : answer.error === "no_directory" ? "unsupported" : "unavailable" };
    if (answer.status === 200 && isRecord(answer.body)) {
      const body = answer.body;
      const parsed: GithubAppStatusResponse = {
        connected: body.connected === true,
        state: body.state === "active" || body.state === "needs_reauth" ? body.state : null,
        stateReason: shortString(body.stateReason, 64) as GithubAppNeedsReauthReason | null,
        githubLogin: shortString(body.githubLogin, 100),
        githubUserId: finiteNumber(body.githubUserId),
        connectedAt: finiteNumber(body.connectedAt),
        refreshExpiresAt: finiteNumber(body.refreshExpiresAt),
        origin: body.origin === "web_flow" || body.origin === "adopted_device_flow" ? body.origin : null,
      };
      // A status read that says "not connected" makes a cached token useless,
      // and one that says "connected" ends a stale negative answer.
      const userId = options.getAccountUserId()?.trim() || null;
      if (userId) {
        const entry = readEntry(userId);
        if (!parsed.connected && entry?.state === "active") clearCache();
        if (parsed.connected && parsed.state === "active" && entry && entry.state !== "active") clearNegative();
      }
      return { ok: true, status: parsed };
    }
    const code = errorCodeOf(answer.body);
    if (answer.status === 503 && code === "github_app_not_configured") return { ok: false, error: "unsupported" };
    if (answer.status === 404 || answer.status === 405) return { ok: false, error: "unsupported" };
    return { ok: false, error: "unavailable" };
  };

  const startSignIn = async (): Promise<
    | { ok: true; signIn: GithubAppSignInStartResponse }
    | { ok: false; error: string; message: string | null }
  > => {
    const answer = await directoryRequest("POST", GITHUB_APP_PATHS.signIn, { client: options.clientKind });
    if ("error" in answer) return { ok: false, error: answer.error === "no_directory" ? "unsupported" : answer.error, message: null };
    if (answer.status === 200 || answer.status === 201) {
      const body = isRecord(answer.body) ? answer.body : {};
      const signInId = shortString(body.signInId, 64);
      const authorizeUrl = shortString(body.authorizeUrl, 4096);
      const expiresAt = finiteNumber(body.expiresAt);
      if (signInId && GITHUB_APP_SIGN_IN_ID_PATTERN.test(signInId) && authorizeUrl && expiresAt != null) {
        return { ok: true, signIn: { signInId, authorizeUrl, expiresAt } };
      }
      return { ok: false, error: "unavailable", message: null };
    }
    const code = errorCodeOf(answer.body);
    const message = isRecord(answer.body) && isRecord(answer.body.error) ? shortString(answer.body.error.message, 300) : null;
    if (answer.status === 503 && code === "github_app_not_configured") return { ok: false, error: "unsupported", message };
    if (answer.status === 404 || answer.status === 405) return { ok: false, error: "unsupported", message: null };
    if (answer.status === 429) return { ok: false, error: "rate_limited", message };
    return { ok: false, error: code ?? "unavailable", message };
  };

  const readSignIn = async (signInId: string): Promise<
    | { ok: true; signIn: GithubAppSignInReadResponse }
    | { ok: false; error: string }
  > => {
    if (!GITHUB_APP_SIGN_IN_ID_PATTERN.test(signInId)) return { ok: false, error: "invalid_args" };
    const answer = await directoryRequest("GET", githubAppSignInPath(signInId));
    if ("error" in answer) return { ok: false, error: answer.error };
    if (answer.status === 200 && isRecord(answer.body)) {
      const body = answer.body;
      const statusValue = body.status === "pending" || body.status === "done" || body.status === "failed" || body.status === "expired"
        ? body.status
        : null;
      if (!statusValue) return { ok: false, error: "unavailable" };
      const resultCode = body.resultCode === "ok" || body.resultCode === "denied" || body.resultCode === "error" ? body.resultCode : null;
      if (statusValue === "done") {
        // The account has a new grant: any negative answer or old token here is stale.
        clearCache();
      }
      return { ok: true, signIn: { status: statusValue, resultCode, githubLogin: shortString(body.githubLogin, 100) } };
    }
    return { ok: false, error: errorCodeOf(answer.body) ?? `http_${answer.status}` };
  };

  const signOut = async (): Promise<
    | { ok: true; result: GithubAppDisconnectResponse }
    | { ok: false; error: string }
  > => {
    const answer = await directoryRequest("DELETE", GITHUB_APP_PATHS.grant);
    if ("error" in answer) return { ok: false, error: answer.error };
    if (answer.status === 200 && isRecord(answer.body)) {
      clearCache();
      return {
        ok: true,
        result: {
          ok: true,
          deletedAtGitHub: answer.body.deletedAtGitHub === true,
          revokeAtGitHubUrl: shortString(answer.body.revokeAtGitHubUrl, 300) ?? "https://github.com/settings/apps/authorizations",
        },
      };
    }
    return { ok: false, error: errorCodeOf(answer.body) ?? `http_${answer.status}` };
  };

  /**
   * Hands a machine's own device-flow record to the account.
   * `adopted`: the server holds it now. `already_connected`: the account has a
   * grant (compare `githubLogin`). `rejected`: the server refused this record
   * (not this App's token, or GitHub refused it). `unavailable`: try later.
   */
  const adopt = async (record: GithubAppAdoptRequest): Promise<
    | { kind: "adopted"; githubLogin: string | null }
    | { kind: "already_connected"; githubLogin: string | null }
    | { kind: "rejected"; code: string | null }
    | { kind: "unsupported" }
    | { kind: "unavailable"; retryAfterSec: number | null }
    | { kind: "signed_out" }
  > => {
    const answer = await directoryRequest("POST", GITHUB_APP_PATHS.adopt, record);
    if ("error" in answer) {
      if (answer.error === "signed_out") return { kind: "signed_out" };
      if (answer.error === "no_directory") return { kind: "unsupported" };
      return { kind: "unavailable", retryAfterSec: null };
    }
    const code = errorCodeOf(answer.body);
    const login = isRecord(answer.body)
      ? shortString(answer.body.githubLogin, 100) ?? (isRecord(answer.body.error) ? shortString(answer.body.error.githubLogin, 100) : null)
      : null;
    if (answer.status === 201 || answer.status === 200) {
      clearCache();
      return { kind: "adopted", githubLogin: login };
    }
    if (answer.status === 409 && code === "already_connected") return { kind: "already_connected", githubLogin: login };
    if (answer.status === 503 && code === "github_app_not_configured") return { kind: "unsupported" };
    if (answer.status === 404 || answer.status === 405) return { kind: "unsupported" };
    if (answer.status === 400 || answer.status === 422) return { kind: "rejected", code };
    return { kind: "unavailable", retryAfterSec: answer.retryAfterSec };
  };

  /** Deletes one machine token at GitHub through the server. True when the server took it. */
  const retire = async (accessToken: string): Promise<boolean> => {
    const answer = await directoryRequest("POST", GITHUB_APP_PATHS.retire, { accessToken });
    return !("error" in answer) && (answer.status === 204 || answer.status === 200);
  };

  return {
    getToken,
    peek,
    clearNegative,
    clearCache,
    dropForeignEntry,
    status,
    startSignIn,
    readSignIn,
    signOut,
    adopt,
    retire,
  };
}

export type AccountAppTokenClient = ReturnType<typeof createAccountAppTokenClient>;

/** Drops every process-wide in-flight read and rejected-token memory (tests and harnesses). */
export function resetAccountAppTokenClientScopes(): void {
  scopes.clear();
}
