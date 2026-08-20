import { randomUUID } from "node:crypto";
import { updateCredentialKeySync } from "../../../../../ade-cli/src/services/credentials/updateCredentialKey";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthCredentialState,
  GitHubAppUserAuthStatus,
} from "../../../shared/types";
import {
  ADE_GITHUB_APP_CLIENT_ID,
  type GitHubAppUserTokenRecord,
  refreshGitHubAppUserToken,
} from "./githubAppUserAuth";
import { createGitHubAppUserDeviceFlow } from "./githubAppUserAuthDeviceFlow";
import {
  emptyLedger,
  parseStoredAppUserAuth,
  readIsoActiveWithin,
  readIsoAfter,
  serializeStoredAppUserAuth,
  type StoredAppUserAuth,
  type StoredRefreshFailure,
} from "./githubAppUserAuthLedger";
import {
  GitHubAppUserAuthError,
  classifyRefreshFailure,
  type RefreshFailure,
} from "./githubAppUserAuthFailure";
import {
  createGitHubRelayAuthAuditLog,
  type GitHubRelayAuthAuditLog,
} from "./githubRelayConfig";
import { GITHUB_REST_API_VERSION } from "./githubApiVersion";
import { asString } from "../shared/utils";

export const GITHUB_APP_USER_TOKEN_KEY = "github.appUserToken.v1";
const GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
/** How long one process may hold the right to run the refresh POST. */
const REFRESH_LEASE_MS = 60_000;
const REFRESH_BACKOFF_BASE_MS = 60_000;
const REFRESH_BACKOFF_MAX_MS = 60 * 60_000;
const LEASE_POLL_INTERVAL_MS = 250;
/** Bounds the wait for a peer's refresh at roughly three seconds. */
const LEASE_POLL_MAX_ATTEMPTS = 12;

export type GitHubAppUserAuthCredentialStore = {
  getSync(key: string): string | null | undefined;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
  /**
   * Atomic read-modify-write of ONE key, when the store supports it.
   *
   * The refresh ledger below is shared by every ADE process on the machine, so
   * "read, decide, write" has to be one step or two processes can both conclude
   * they hold the refresh lease. Return `undefined` to write nothing, `null` to
   * delete the key.
   */
  updateKeySync?(
    key: string,
    mutator: (current: string | null) => string | null | undefined,
  ): void;
  /** A stable name for the underlying storage, shared by every store over it. */
  credentialStoreIdentity?(): string;
};

type GitHubAppUserAuthLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

/**
 * One refresh at a time per credential store, for every service instance in the
 * process. Keyed by the storage the instances share, NOT by the instance.
 */
type StoreCoordinator = {
  inFlight: Promise<GitHubAppUserTokenRecord> | null;
  /**
   * When a peer process was still holding the on-disk lease at the end of a
   * wait, in epoch milliseconds, or 0 when no peer is known to hold it.
   *
   * Process-local and never written to disk. Without it every caller in this
   * process re-runs the whole three-second poll before reaching the same
   * verdict, which turns one peer's slow refresh into a stall for every project
   * scope in the app.
   */
  peerLeaseUntilMs: number;
};

const storeCoordinators = new Map<string, StoreCoordinator>();
const unnamedStoreIdentities = new WeakMap<object, string>();
let anonymousStoreCounter = 0;

/**
 * The name every service instance over one storage must agree on.
 *
 * A store that cannot name itself falls back to per-OBJECT identity rather than
 * a shared constant: two unrelated stores must not share a coordinator, and the
 * real stores all report a path.
 */
function resolveStoreIdentity(
  store: GitHubAppUserAuthCredentialStore | null | undefined,
  declared: string | null | undefined,
): string {
  const explicit = declared?.trim();
  if (explicit) return explicit;
  if (!store) return `ade.memory-credential-store.${(anonymousStoreCounter += 1)}`;
  const named = store.credentialStoreIdentity?.().trim();
  if (named) return named;
  const existing = unnamedStoreIdentities.get(store);
  if (existing) return existing;
  const assigned = `ade.unnamed-credential-store.${(anonymousStoreCounter += 1)}`;
  unnamedStoreIdentities.set(store, assigned);
  return assigned;
}

function coordinatorFor(identity: string): StoreCoordinator {
  let coordinator = storeCoordinators.get(identity);
  if (!coordinator) {
    coordinator = { inFlight: null, peerLeaseUntilMs: 0 };
    storeCoordinators.set(identity, coordinator);
  }
  return coordinator;
}

/** Drops the process-wide coordinators so one test cannot leak into the next. */
export function resetGitHubAppUserAuthCoordinatorsForTests(): void {
  storeCoordinators.clear();
}

function refreshBackoffMs(
  failure: Pick<StoredRefreshFailure, "retryAfterSec">,
  consecutiveFailures: number,
): number {
  const exponential = Math.min(
    REFRESH_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    REFRESH_BACKOFF_MAX_MS,
  );
  const requested = failure.retryAfterSec != null ? failure.retryAfterSec * 1_000 : 0;
  // Capped at the same bound the readers accept. A longer pause than this is
  // indistinguishable from a poisoned deadline, and a deadline the readers
  // discard is worse than a short one: it puts every process straight back into
  // the refresh storm this ledger exists to stop.
  return Math.min(Math.max(exponential, requested), REFRESH_BACKOFF_MAX_MS);
}

/** True when the backoff deadline is both in the future and plausible. */
function backoffActive(notBeforeAt: string | null, nowMs: number): boolean {
  return readIsoActiveWithin(notBeforeAt, nowMs, REFRESH_BACKOFF_MAX_MS);
}

/** True when the refresh lease is both in the future and plausible. */
function leaseActive(leaseUntil: string | null, nowMs: number): boolean {
  return readIsoActiveWithin(leaseUntil, nowMs, REFRESH_LEASE_MS);
}

/** A credential ADE can actually POST a refresh for. */
type UsableRefreshRecord = GitHubAppUserTokenRecord & { refreshToken: string };

/**
 * True when the stored credential still carries a refresh token worth POSTing.
 *
 * A missing `refreshTokenExpiresAt` is unknown, not expired — attempt the
 * refresh instead of writing off a possibly-valid credential.
 */
function hasUsableRefreshToken(
  record: GitHubAppUserTokenRecord,
  nowMs: number,
): record is UsableRefreshRecord {
  if (!record.refreshToken) return false;
  return record.refreshTokenExpiresAt == null
    || readIsoAfter(record.refreshTokenExpiresAt, nowMs);
}

/** True while the access token is good for longer than the refresh skew. */
function isAccessTokenFresh(record: GitHubAppUserTokenRecord, nowMs: number): boolean {
  const refreshCutoff = nowMs + GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS;
  return !record.expiresAt || readIsoAfter(record.expiresAt, refreshCutoff);
}

/**
 * What the stored credential is, judged once and read by every gate.
 *
 * Declared here because four callers used to run their own copy of this
 * ladder in three different orders, and the orders disagreed: one of them
 * handed out a lapsed access token whose refresh token had already expired,
 * which every other gate called `needs_reauth`.
 *
 * The order is the contract:
 *  1. `missing`     — nothing stored at all.
 *  2. `fresh`       — the access token is still good, so nothing below may
 *     refuse the call. A renewal pause must never withhold a working token,
 *     and an App configured for non-expiring user tokens has no refresh token
 *     to judge in the first place. `renewableRecord` says whether that token
 *     has a future once it lapses, which is what the STATUS axis reports on.
 *  3. `needs_reauth`— lapsed, and the refresh token is gone, expired, or
 *     rejected. Nobody can renew this credential, so no gate may hand it out:
 *     serving it produced a GitHub 401 the user had no way to act on.
 *  4. `blocked`     — lapsed, and a refresh deadline has not passed yet.
 *  5. `refreshable` — lapsed, healthy, and ADE may POST a refresh for it.
 */
export type StoredAuthVerdict =
  | { outcome: "missing" }
  | {
    outcome: "fresh";
    record: GitHubAppUserTokenRecord;
    /** Null when this token cannot be renewed once it lapses. */
    renewableRecord: UsableRefreshRecord | null;
  }
  | { outcome: "needs_reauth"; failure: StoredRefreshFailure | null }
  | { outcome: "blocked"; retryAt: string | null; failure: StoredRefreshFailure | null }
  | { outcome: "refreshable"; record: UsableRefreshRecord };

export function judgeStoredAuth(stored: StoredAppUserAuth, nowMs: number): StoredAuthVerdict {
  const failure = stored.refresh.lastFailure;
  const token = stored.token;
  if (!token?.accessToken) return { outcome: "missing" };
  // The type predicate sits at the end of the `&&` chain, so the true branch
  // hands back the narrowed record and no cast is needed below.
  const renewableRecord: UsableRefreshRecord | null =
    !stored.refresh.dead && hasUsableRefreshToken(token, nowMs) ? token : null;
  if (isAccessTokenFresh(token, nowMs)) {
    return { outcome: "fresh", record: token, renewableRecord };
  }
  if (!renewableRecord) return { outcome: "needs_reauth", failure };
  if (backoffActive(stored.refresh.notBeforeAt, nowMs)) {
    return { outcome: "blocked", retryAt: stored.refresh.notBeforeAt, failure };
  }
  return { outcome: "refreshable", record: renewableRecord };
}

function credentialStateOf(
  stored: StoredAppUserAuth,
  nowMs: number,
): GitHubAppUserAuthCredentialState {
  const verdict = judgeStoredAuth(stored, nowMs);
  if (verdict.outcome === "missing") return "missing";
  // A working token that is GOING TO LAPSE with no renewal left is something
  // the user must replace, and this axis is where ADE asks them to — hours
  // before it lapses, rather than at the moment it stops working. A token
  // with no expiry at all (an App configured for non-expiring user tokens)
  // never lapses, so the missing refresh token is not a problem to report.
  if (verdict.outcome === "fresh") {
    const lapses = Boolean(verdict.record.expiresAt);
    return !lapses || verdict.renewableRecord ? "authorized" : "needs_reauth";
  }
  if (verdict.outcome === "needs_reauth") return "needs_reauth";
  if (verdict.outcome === "blocked") return "blocked";
  return "authorized";
}

/**
 * What one atomic look at the refresh ledger decided: the shared verdict, plus
 * the two outcomes only the lease itself can reach.
 *
 * `refreshable` never escapes the lease acquisition — it is exactly the case
 * the lease then takes or finds already held.
 */
type RefreshLeaseAttempt =
  | Exclude<StoredAuthVerdict, { outcome: "refreshable" }>
  | { outcome: "held"; leaseUntil: string | null }
  | { outcome: "acquired"; record: UsableRefreshRecord };

export function createGitHubAppUserAuthService(args: {
  credentialStore?: GitHubAppUserAuthCredentialStore | null;
  logger: GitHubAppUserAuthLogger;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  userAgent: string;
  /**
   * Names the storage this service shares with its siblings. Defaults to what
   * the store reports, so every service instance over one credential file lands
   * on one coordinator.
   */
  storeIdentity?: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): {
  getAuthStatus(patch?: Partial<GitHubAppUserAuthStatus>): GitHubAppUserAuthStatus;
  startDeviceAuth(): Promise<GitHubAppDeviceAuthStartResult>;
  pollDeviceAuth(args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult>;
  clearAuth(): GitHubAppUserAuthStatus;
  getStoredTokenForHealth(): string | null;
  getValidTokenForRelay(): Promise<string>;
  auditLog: GitHubRelayAuthAuditLog;
} {
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const leaseHolderId = randomUUID();
  // Only serves a service built WITHOUT a credential store. A store that reads
  // empty is a cleared credential, not a cache miss: falling back to memory
  // there resurrected credentials another process had signed out.
  let appUserTokenMemory: StoredAppUserAuth | null = null;
  // Bumped whenever stored auth is replaced or cleared outside the refresh
  // path, so an in-flight refresh cannot overwrite the newer auth state.
  let authEpoch = 0;

  const storeIdentity = resolveStoreIdentity(args.credentialStore, args.storeIdentity);

  const auditLog = createGitHubRelayAuthAuditLog(args.logger.info.bind(args.logger));

  const readStoredAuth = (): StoredAppUserAuth => {
    if (!args.credentialStore) return appUserTokenMemory ?? { token: null, refresh: emptyLedger() };
    try {
      const raw = args.credentialStore.getSync(GITHUB_APP_USER_TOKEN_KEY)?.trim() || "";
      if (!raw) return { token: null, refresh: emptyLedger() };
      return parseStoredAppUserAuth(raw);
    } catch {
      args.logger.warn("github.app_user_token_read_failed", {
        error: "failed to parse stored app user token",
      });
      return { token: null, refresh: emptyLedger() };
    }
  };

  const readAppUserTokenRecord = (): GitHubAppUserTokenRecord | null => readStoredAuth().token;

  const writeStoredAuth = (stored: StoredAppUserAuth | null): void => {
    appUserTokenMemory = stored;
    if (!args.credentialStore) return;
    try {
      const serialized = stored ? serializeStoredAppUserAuth(stored) : null;
      if (serialized) args.credentialStore.setSync(GITHUB_APP_USER_TOKEN_KEY, serialized);
      else args.credentialStore.deleteSync(GITHUB_APP_USER_TOKEN_KEY);
    } catch (error) {
      args.logger.warn("github.app_user_token_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const persistAppUserTokenRecord = (record: GitHubAppUserTokenRecord | null): void => {
    writeStoredAuth(record ? { token: record, refresh: emptyLedger() } : null);
  };

  /**
   * Applies `mutator` to the stored credential as one step, and returns what the
   * mutator decided. `updateCredentialKeySync` holds the ladder: a store with no
   * atomic update degrades to a plain read-modify-write, still correct inside
   * one process, and the only stores without one are process-local ones.
   */
  const updateStoredAuth = <T>(
    mutator: (stored: StoredAppUserAuth) => { next: StoredAppUserAuth | null | undefined; result: T },
  ): T => {
    let result!: T;
    const parseCurrent = (current: string | null): StoredAppUserAuth => {
      if (!current?.trim()) return { token: null, refresh: emptyLedger() };
      try {
        return parseStoredAppUserAuth(current);
      } catch {
        // Unparseable is reported as absent, and every mutator declines to write
        // over an absent record — so a corrupt value is left for a reader to
        // report rather than overwritten from inside a refresh.
        return { token: null, refresh: emptyLedger() };
      }
    };
    const applyRaw = (current: string | null): string | null | undefined => {
      const stored = parseCurrent(current);
      const decision = mutator(stored);
      result = decision.result;
      if (decision.next === undefined) return undefined;
      if (decision.next === null) return null;
      appUserTokenMemory = decision.next;
      return serializeStoredAppUserAuth(decision.next);
    };
    const store = args.credentialStore;
    if (!store) {
      const decision = mutator(appUserTokenMemory ?? { token: null, refresh: emptyLedger() });
      if (decision.next !== undefined) appUserTokenMemory = decision.next;
      return decision.result;
    }
    try {
      updateCredentialKeySync(store, GITHUB_APP_USER_TOKEN_KEY, applyRaw);
      return result;
    } catch (error) {
      args.logger.warn("github.app_user_token_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const appUserAuthStatus = (patch: Partial<GitHubAppUserAuthStatus> = {}): GitHubAppUserAuthStatus => {
    const stored = readStoredAuth();
    const credentialState = credentialStateOf(stored, now());
    const failure = stored.refresh.lastFailure;
    return {
      configured: true,
      tokenStored: Boolean(stored.token?.accessToken),
      userLogin: stored.token?.userLogin ?? null,
      expiresAt: stored.token?.expiresAt ?? null,
      refreshTokenExpiresAt: stored.token?.refreshTokenExpiresAt ?? null,
      credentialState,
      refreshBlockedUntil: credentialState === "blocked" ? stored.refresh.notBeforeAt : null,
      lastRefreshError: failure
        ? {
          kind: failure.kind,
          message: failure.message,
          status: failure.status,
          at: failure.at,
        }
        : null,
      checkedAt: new Date(now()).toISOString(),
      error: null,
      ...patch,
    };
  };

  const fetchAppUserLogin = async (accessToken: string): Promise<string | null> => {
    const response = await args.fetchImpl("https://api.github.com/user", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": args.userAgent,
        "x-github-api-version": GITHUB_REST_API_VERSION,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return null;
    return asString(payload.login).trim() || null;
  };

  const missingAuthError = (): GitHubAppUserAuthError => new GitHubAppUserAuthError(
    "Authorize the ADE GitHub App with GitHub before using the hosted relay.",
    "missing",
    null,
    null,
  );

  const needsReauthError = (failure: StoredRefreshFailure | null): GitHubAppUserAuthError =>
    new GitHubAppUserAuthError(
      "ADE GitHub App authorization expired. Re-authorize ADE with GitHub.",
      "needs_reauth",
      null,
      failure,
    );

  const blockedError = (
    retryAt: string | null,
    failure: StoredRefreshFailure | null,
  ): GitHubAppUserAuthError => new GitHubAppUserAuthError(
    // The deadline rides on `retryAt` rather than inside the sentence: callers
    // that show it to a person format it, and callers that log it read the field.
    "GitHub paused ADE's authorization renewal. ADE retries on its own.",
    "blocked",
    retryAt,
    failure,
  );

  /**
   * Throws the error that states why an unusable verdict cannot be served.
   *
   * Three call sites translate the same three outcomes into the same three
   * errors, and they must keep agreeing: a gate that reports `blocked` where
   * another reports `needs_reauth` asks the user to re-authorize a credential
   * ADE is about to renew by itself.
   */
  function rejectVerdict(
    verdict: Extract<
      StoredAuthVerdict,
      { outcome: "missing" | "needs_reauth" | "blocked" }
    >,
  ): never {
    if (verdict.outcome === "missing") throw missingAuthError();
    if (verdict.outcome === "needs_reauth") throw needsReauthError(verdict.failure);
    throw blockedError(verdict.retryAt, verdict.failure);
  }

  /**
   * Judges every refresh gate and takes the lease, as ONE atomic step.
   *
   * The record to POST is captured INSIDE this atomic update. Capturing it from
   * an earlier read leaves a window where a peer finishes its refresh, rotates
   * the token, and releases the lease — and the old refresh token gets POSTed
   * anyway, which GitHub answers by revoking the credential. The dead and
   * backoff gates are judged here for the same reason, and so that one turn of
   * the wait loop costs one locked read instead of two.
   */
  const acquireRefreshLease = (): RefreshLeaseAttempt =>
    updateStoredAuth<RefreshLeaseAttempt>((stored) => {
      const nowMs = now();
      const decline = (result: RefreshLeaseAttempt) => ({ next: undefined, result });
      const verdict = judgeStoredAuth(stored, nowMs);
      if (verdict.outcome !== "refreshable") return decline(verdict);
      if (
        leaseActive(stored.refresh.leaseUntil, nowMs)
        && stored.refresh.leaseHolder !== leaseHolderId
      ) {
        // No failure travels with this one: a peer holding the lease is ADE
        // renewing the credential, and GitHub has said nothing about it.
        return decline({ outcome: "held", leaseUntil: stored.refresh.leaseUntil });
      }
      const leaseUntil = new Date(nowMs + REFRESH_LEASE_MS).toISOString();
      return {
        next: {
          token: verdict.record,
          refresh: { ...stored.refresh, leaseUntil, leaseHolder: leaseHolderId },
        },
        result: { outcome: "acquired", record: verdict.record },
      };
    });

  /** Stamps one classified failure with the instant it happened. */
  const stampFailure = (failure: RefreshFailure): StoredRefreshFailure => ({
    kind: failure.kind,
    message: failure.message,
    status: failure.status,
    oauthError: failure.oauthError,
    retryAfterSec: failure.retryAfterSec,
    at: new Date(now()).toISOString(),
  });

  /**
   * Writes a refreshed credential back, but only over the credential that was
   * POSTed.
   *
   * A record that vanished while the POST was in flight was cleared by a
   * sign-out, and a record whose refresh token changed was replaced by a device
   * flow that finished meanwhile. Writing this result over either one undoes a
   * newer, deliberate decision.
   */
  const persistRefreshSuccess = (
    refreshed: GitHubAppUserTokenRecord,
    postedRefreshToken: string | null,
  ): { written: boolean; generation: number } =>
    updateStoredAuth<{ written: boolean; generation: number }>((stored) => {
      if (!stored.token || stored.token.refreshToken !== postedRefreshToken) {
        return { next: undefined, result: { written: false, generation: 0 } };
      }
      const generation = stored.refresh.generation + 1;
      return {
        next: { token: refreshed, refresh: { ...emptyLedger(), generation } },
        result: { written: true, generation },
      };
    });

  type PersistedRefreshFailure = {
    notBeforeAt: string | null;
    backoffMs: number;
    consecutiveFailures: number;
    /** True when the stored credential was no longer the one that was POSTed. */
    declined: boolean;
  };

  /**
   * Records a failed refresh against the credential that was POSTed.
   *
   * Declines the write when the stored credential is a different one. A failure
   * that belongs to a credential nobody holds any more must not mark a fresh
   * one dead — that is how a completed re-authorization looked to the user like
   * nothing had changed.
   */
  const persistRefreshFailure = (
    failure: StoredRefreshFailure,
    dead: boolean,
    postedRefreshToken: string | null,
  ): PersistedRefreshFailure =>
    updateStoredAuth<PersistedRefreshFailure>((stored) => {
      if (!stored.token || stored.token.refreshToken !== postedRefreshToken) {
        return {
          next: undefined,
          result: { notBeforeAt: null, backoffMs: 0, consecutiveFailures: 0, declined: true },
        };
      }
      const consecutiveFailures = stored.refresh.consecutiveFailures + 1;
      const backoffMs = refreshBackoffMs(failure, consecutiveFailures);
      const notBeforeAt = new Date(now() + backoffMs).toISOString();
      return {
        next: {
          // The credential itself is kept even when it is dead: the UI can only
          // say "re-authorize" if it can still see that a credential is there.
          token: stored.token,
          refresh: {
            ...stored.refresh,
            notBeforeAt,
            consecutiveFailures,
            dead: stored.refresh.dead || dead,
            leaseUntil: null,
            leaseHolder: null,
            lastFailure: failure,
          },
        },
        result: { notBeforeAt, backoffMs, consecutiveFailures, declined: false },
      };
    });

  /**
   * Serves whatever the store holds right now.
   *
   * Used by the two paths where this POST's outcome no longer describes the
   * stored credential: auth was replaced while the request was in flight, or
   * the write was declined because the refresh token had already been rotated.
   */
  const serveCurrentStoredAuth = (): GitHubAppUserTokenRecord => {
    const verdict = judgeStoredAuth(readStoredAuth(), now());
    if (verdict.outcome !== "fresh" && verdict.outcome !== "refreshable") {
      rejectVerdict(verdict);
    }
    // Fresh, or stale but healthy. The next call runs the gate again and renews
    // it; this call must not report a failure that belongs to a replaced
    // credential.
    return verdict.record;
  };

  /**
   * Hands the on-disk lease back when this process still holds it.
   *
   * The lease also expires on its own after {@link REFRESH_LEASE_MS}, so this is
   * about latency, not correctness: without it a refresh that dies before it can
   * record an outcome — a credential-store write that throws, most of all —
   * makes every other process wait out the full minute for nothing.
   */
  const releaseRefreshLease = (): void => {
    updateStoredAuth<void>((stored) => {
      if (!stored.token || stored.refresh.leaseHolder !== leaseHolderId) {
        return { next: undefined, result: undefined };
      }
      return {
        next: {
          token: stored.token,
          refresh: { ...stored.refresh, leaseUntil: null, leaseHolder: null },
        },
        result: undefined,
      };
    });
  };

  const runRefreshPost = async (record: UsableRefreshRecord): Promise<GitHubAppUserTokenRecord> => {
    const epochAtStart = authEpoch;
    // Held for the whole call: every write below is allowed only over the
    // credential this exact token belongs to.
    const postedRefreshToken = record.refreshToken;
    // Both persist paths clear the lease as part of the record they write, so
    // only an exit that reaches NEITHER of them leaves it held.
    let ledgerWritten = false;
    try {
      const refreshed = await refreshGitHubAppUserToken({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        refreshToken: postedRefreshToken,
        fetchImpl: (input, init) => args.fetchImpl(String(input), init),
        userAgent: args.userAgent,
        fetchUserLogin: fetchAppUserLogin,
      });
      if (authEpoch !== epochAtStart) {
        // Auth was cleared or replaced while this POST was in flight; the store
        // is the truth, not this result.
        return serveCurrentStoredAuth();
      }
      const persisted = persistRefreshSuccess(refreshed, postedRefreshToken);
      ledgerWritten = true;
      if (!persisted.written) {
        args.logger.info("github.app_user_token_refresh_superseded", {
          userLogin: refreshed.userLogin,
        });
        return serveCurrentStoredAuth();
      }
      args.logger.info("github.app_user_token_refresh_succeeded", {
        generation: persisted.generation,
        userLogin: refreshed.userLogin,
        expiresAt: refreshed.expiresAt,
        refreshTokenRotated: refreshed.refreshToken !== record.refreshToken,
      });
      return refreshed;
    } catch (error) {
      if (error instanceof GitHubAppUserAuthError) throw error;
      const failure = classifyRefreshFailure(error);
      const stamped = stampFailure(failure);
      const persisted = persistRefreshFailure(stamped, failure.dead, postedRefreshToken);
      ledgerWritten = true;
      args.logger.warn("github.app_user_token_refresh_failed", {
        error: failure.message,
        kind: failure.kind,
        status: failure.status,
        oauthError: failure.oauthError,
        retryAfterSec: failure.retryAfterSec,
        backoffMs: persisted.backoffMs,
        consecutiveFailures: persisted.consecutiveFailures,
        dead: failure.dead,
        superseded: persisted.declined,
      });
      // Nothing was written, because the stored credential is not the one this
      // failure is about. Serve the current state instead of reporting a dead
      // credential over a live one.
      if (persisted.declined) return serveCurrentStoredAuth();
      throw failure.dead
        ? needsReauthError(stamped)
        : blockedError(persisted.notBeforeAt, stamped);
    } finally {
      if (!ledgerWritten) {
        try {
          releaseRefreshLease();
        } catch {
          // The store that just refused the outcome will refuse this too. The
          // lease expires on its own, and reporting a second store failure over
          // the first one helps nobody.
        }
      }
    }
  };

  /**
   * Remembers, for this process only, that a peer still held the lease when the
   * wait ran out.
   */
  const rememberPeerLease = (leaseUntil: string | null): void => {
    if (!leaseUntil || !leaseActive(leaseUntil, now())) return;
    coordinatorFor(storeIdentity).peerLeaseUntilMs = Date.parse(leaseUntil);
  };

  /**
   * The one refresh body, run under this process's coordinator and the on-disk
   * lease. Every gate is judged inside `acquireRefreshLease`, so each turn takes
   * one locked look at the store and a peer's outcome is honoured, not raced.
   */
  const refreshUnderLease = async (): Promise<GitHubAppUserTokenRecord> => {
    for (let attempt = 0; attempt <= LEASE_POLL_MAX_ATTEMPTS; attempt += 1) {
      const lease = acquireRefreshLease();
      if (lease.outcome === "fresh") return lease.record;
      if (lease.outcome === "acquired") return await runRefreshPost(lease.record);
      if (lease.outcome !== "held") rejectVerdict(lease);
      // A peer is mid-refresh. Never POST the same refresh token behind it: the
      // peer may already have rotated it, and GitHub answers a reused refresh
      // token by revoking the credential outright.
      if (attempt === LEASE_POLL_MAX_ATTEMPTS) {
        rememberPeerLease(lease.leaseUntil);
        // No failure: ADE is renewing, and every surface that reads this must
        // say so rather than blame GitHub for a wait ADE itself is causing.
        throw blockedError(lease.leaseUntil, null);
      }
      await sleep(LEASE_POLL_INTERVAL_MS);
    }
    throw blockedError(null, readStoredAuth().refresh.lastFailure);
  };

  const getValidAppUserTokenForRelay = async (): Promise<string> => {
    const coordinator = coordinatorFor(storeIdentity);
    const verdict = judgeStoredAuth(readStoredAuth(), now());
    if (verdict.outcome === "fresh") {
      // A fresh token proves the peer's refresh landed, so the remembered
      // deadline has done its job.
      coordinator.peerLeaseUntilMs = 0;
      return verdict.record.accessToken;
    }
    if (verdict.outcome !== "refreshable") rejectVerdict(verdict);
    // A peer still held the lease when an earlier wait ran out. Polling for
    // three more seconds cannot learn anything before that deadline passes, and
    // every project scope in this process would pay the wait separately. This
    // is ADE waiting on ADE, so it carries no failure.
    const nowMs = now();
    if (coordinator.peerLeaseUntilMs > nowMs
      && coordinator.peerLeaseUntilMs <= nowMs + REFRESH_LEASE_MS) {
      throw blockedError(new Date(coordinator.peerLeaseUntilMs).toISOString(), null);
    }
    coordinator.peerLeaseUntilMs = 0;
    if (!coordinator.inFlight) {
      coordinator.inFlight = refreshUnderLease();
      // Nothing is awaiting this copy, and an unhandled rejection here would be
      // reported before the real awaiters attach.
      coordinator.inFlight.catch(() => undefined);
    }
    const inFlight = coordinator.inFlight;
    try {
      return (await inFlight).accessToken;
    } finally {
      if (coordinator.inFlight === inFlight) coordinator.inFlight = null;
    }
  };

  const deviceFlow = createGitHubAppUserDeviceFlow({
    fetchImpl: args.fetchImpl,
    userAgent: args.userAgent,
    logger: args.logger,
    fetchAppUserLogin,
    persistAppUserTokenRecord,
    bumpAuthEpoch: () => {
      authEpoch += 1;
    },
    appUserAuthStatus,
    now,
  });

  const clearAuth = (): GitHubAppUserAuthStatus => {
    authEpoch += 1;
    persistAppUserTokenRecord(null);
    deviceFlow.clearSessions();
    return appUserAuthStatus();
  };

  return {
    getAuthStatus: appUserAuthStatus,
    startDeviceAuth: deviceFlow.startDeviceAuth,
    pollDeviceAuth: deviceFlow.pollDeviceAuth,
    clearAuth,
    getStoredTokenForHealth: () => readAppUserTokenRecord()?.accessToken ?? null,
    getValidTokenForRelay: getValidAppUserTokenForRelay,
    auditLog,
  };
}
