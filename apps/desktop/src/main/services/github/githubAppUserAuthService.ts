import { randomUUID } from "node:crypto";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthCredentialState,
  GitHubAppUserAuthRefreshError,
  GitHubAppUserAuthStatus,
  GitHubAuthFailure,
  GitHubRateLimitState,
} from "../../../shared/types";
import { classifyGitHubAuthFailure } from "./githubRateLimit";
import {
  ADE_GITHUB_APP_CLIENT_ID,
  GitHubOAuthError,
  isDefinitiveGitHubOAuthError,
  type GitHubAppDeviceCode,
  type GitHubAppUserTokenRecord,
  pollGitHubAppDeviceFlow,
  refreshGitHubAppUserToken,
  startGitHubAppDeviceFlow,
} from "./githubAppUserAuth";
import {
  createGitHubRelayAuthAuditLog,
  type GitHubRelayAuthAuditLog,
} from "./githubRelayConfig";
import { GITHUB_REST_API_VERSION } from "./githubApiVersion";
import { asString } from "../shared/utils";

export const GITHUB_APP_USER_TOKEN_KEY = "github.appUserToken.v1";
const GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const MAX_PENDING_DEVICE_AUTH_SESSIONS = 5;
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

type GitHubAppDeviceAuthSession = GitHubAppDeviceCode & {
  sessionId: string;
  intervalSec: number;
};

type GitHubAppUserAuthLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type RefreshFailureKind = GitHubAppUserAuthRefreshError["kind"];

/**
 * The persistent memory of how the last refresh went, stored INSIDE the
 * credential record so every process that reads the credential also reads the
 * backoff that applies to it.
 *
 * Without this the only coordination was a per-instance in-flight promise, and
 * a machine runs many instances: one per project scope in the desktop app, one
 * per project scope in the brain, plus the CLI. Each of them independently
 * POSTed the same refresh token, GitHub's rotation-reuse detection revoked the
 * credential, and the resulting dead token was retried by all of them until
 * GitHub rate-limited the whole OAuth host.
 */
type RefreshLedger = {
  /** No refresh may be attempted before this instant. */
  notBeforeAt: string | null;
  consecutiveFailures: number;
  /** GitHub rejected the refresh token itself; only re-authorization fixes it. */
  dead: boolean;
  leaseUntil: string | null;
  leaseHolder: string | null;
  /** Bumped on every successful refresh, for log correlation across processes. */
  generation: number;
  lastFailure: {
    kind: RefreshFailureKind;
    message: string;
    status: number | null;
    oauthError: string | null;
    retryAfterSec: number | null;
    at: string;
  } | null;
};

type StoredAppUserAuth = {
  token: GitHubAppUserTokenRecord | null;
  refresh: RefreshLedger;
};

type RefreshFailure = {
  kind: RefreshFailureKind;
  message: string;
  status: number | null;
  oauthError: string | null;
  retryAfterSec: number | null;
  dead: boolean;
};

/**
 * Why ADE cannot hand out an App user token right now, in terms the UI can
 * render without guessing.
 */
export class GitHubAppUserAuthError extends Error {
  constructor(
    message: string,
    readonly credentialState: Exclude<GitHubAppUserAuthCredentialState, "authorized">,
    readonly retryAt: string | null,
    readonly failureKind: RefreshFailureKind | null,
    readonly status: number | null,
    readonly oauthError: string | null,
  ) {
    super(message);
    this.name = "GitHubAppUserAuthError";
  }
}

/**
 * The parts of a failed token lookup a caller needs to classify it, whether the
 * failure came from this service or straight from the OAuth transport.
 *
 * Duck-typed for the same reason `githubAuthFailureKindOf` is: the desktop
 * service and the headless twin both call this, and an `instanceof` check
 * answers wrong across module instances.
 */
export function describeGitHubAppUserAuthFailure(error: unknown): {
  message: string;
  status: number | null;
  oauthError: string | null;
  retryAt: string | null;
  credentialState: GitHubAppUserAuthCredentialState | null;
  failureKind: RefreshFailureKind | null;
} {
  const candidate = error as Partial<GitHubAppUserAuthError> & Partial<GitHubOAuthError> | null;
  return {
    message: error instanceof Error ? error.message : String(error),
    status: typeof candidate?.status === "number" ? candidate.status : null,
    oauthError: typeof candidate?.oauthError === "string" ? candidate.oauthError : null,
    retryAt: typeof candidate?.retryAt === "string" ? candidate.retryAt : null,
    credentialState: typeof candidate?.credentialState === "string"
      ? candidate.credentialState
      : null,
    failureKind: typeof candidate?.failureKind === "string" ? candidate.failureKind : null,
  };
}

/**
 * Turns a failed App user token lookup into the credential-failure shape the
 * GitHub status surfaces already speak, with the OAuth details that decide the
 * kind carried across instead of being flattened into a message string.
 */
export function classifyAppUserAuthFailure(error: unknown): {
  authFailure: GitHubAuthFailure;
  rateLimit: GitHubRateLimitState | null;
  described: ReturnType<typeof describeGitHubAppUserAuthFailure>;
} {
  const described = describeGitHubAppUserAuthFailure(error);
  const classified = classifyGitHubAuthFailure({
    status: described.status ?? undefined,
    message: described.message,
    oauthError: described.oauthError,
    retryAt: described.retryAt,
  });
  if (described.credentialState === "needs_reauth") {
    // The refresh token is gone, expired, or rejected. Only re-authorization
    // helps, so it must never be reported as a rate limit that will pass.
    return {
      described,
      rateLimit: classified.rateLimit,
      authFailure: { kind: "invalid_token", message: described.message, retryAt: null },
    };
  }
  return { ...classified, described };
}

/**
 * One refresh at a time per credential store, for every service instance in the
 * process. Keyed by the storage the instances share, NOT by the instance.
 */
type StoreCoordinator = { inFlight: Promise<GitHubAppUserTokenRecord> | null };

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
    coordinator = { inFlight: null };
    storeCoordinators.set(identity, coordinator);
  }
  return coordinator;
}

/** Drops the process-wide coordinators so one test cannot leak into the next. */
export function resetGitHubAppUserAuthCoordinatorsForTests(): void {
  storeCoordinators.clear();
}

function emptyLedger(): RefreshLedger {
  return {
    notBeforeAt: null,
    consecutiveFailures: 0,
    dead: false,
    leaseUntil: null,
    leaseHolder: null,
    generation: 0,
    lastFailure: null,
  };
}

function readIsoAfter(iso: string | null | undefined, cutoffMs: number): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > cutoffMs;
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseLedger(value: unknown): RefreshLedger {
  const base = emptyLedger();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const raw = value as Record<string, unknown>;
  const failure = raw.lastFailure && typeof raw.lastFailure === "object" && !Array.isArray(raw.lastFailure)
    ? raw.lastFailure as Record<string, unknown>
    : null;
  const kind = trimmedOrNull(failure?.kind);
  return {
    notBeforeAt: trimmedOrNull(raw.notBeforeAt),
    consecutiveFailures: typeof raw.consecutiveFailures === "number" && Number.isFinite(raw.consecutiveFailures)
      ? Math.max(0, Math.trunc(raw.consecutiveFailures))
      : 0,
    dead: raw.dead === true,
    leaseUntil: trimmedOrNull(raw.leaseUntil),
    leaseHolder: trimmedOrNull(raw.leaseHolder),
    generation: typeof raw.generation === "number" && Number.isFinite(raw.generation)
      ? Math.max(0, Math.trunc(raw.generation))
      : 0,
    lastFailure: failure && kind
      ? {
        kind: kind as RefreshFailureKind,
        message: trimmedOrNull(failure.message) ?? "GitHub refused to renew the ADE GitHub App authorization.",
        status: typeof failure.status === "number" && Number.isFinite(failure.status)
          ? Math.trunc(failure.status)
          : null,
        oauthError: trimmedOrNull(failure.oauthError),
        retryAfterSec: typeof failure.retryAfterSec === "number" && Number.isFinite(failure.retryAfterSec)
          ? Math.max(0, Math.trunc(failure.retryAfterSec))
          : null,
        at: trimmedOrNull(failure.at) ?? new Date().toISOString(),
      }
      : null,
  };
}

function parseStoredAppUserAuth(raw: string): StoredAppUserAuth {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const accessToken = trimmedOrNull(parsed.accessToken);
  const refresh = parseLedger(parsed.refresh);
  if (!accessToken) return { token: null, refresh };
  return {
    token: {
      accessToken,
      tokenType: trimmedOrNull(parsed.tokenType) ?? "bearer",
      scope: trimmedOrNull(parsed.scope),
      expiresAt: trimmedOrNull(parsed.expiresAt),
      refreshToken: trimmedOrNull(parsed.refreshToken),
      refreshTokenExpiresAt: trimmedOrNull(parsed.refreshTokenExpiresAt),
      userLogin: trimmedOrNull(parsed.userLogin),
      updatedAt: trimmedOrNull(parsed.updatedAt) ?? new Date().toISOString(),
    },
    refresh,
  };
}

function serializeStoredAppUserAuth(stored: StoredAppUserAuth): string | null {
  if (!stored.token) return null;
  return JSON.stringify({ ...stored.token, refresh: stored.refresh });
}

function classifyRefreshFailure(error: unknown): RefreshFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GitHubOAuthError || (error as { name?: string })?.name === "GitHubOAuthError") {
    const oauth = error as GitHubOAuthError;
    const status = typeof oauth.status === "number" ? oauth.status : null;
    const oauthError = oauth.oauthError ?? null;
    const retryAfterSec = oauth.retryAfterSec ?? null;
    if (isDefinitiveGitHubOAuthError(oauthError)) {
      return { kind: "dead_token", message, status, oauthError, retryAfterSec, dead: true };
    }
    if (status === 429 || oauthError === "too_many_requests" || retryAfterSec != null) {
      return { kind: "rate_limited", message, status, oauthError, retryAfterSec, dead: false };
    }
    if (status != null && status >= 500) {
      return { kind: "outage", message, status, oauthError, retryAfterSec, dead: false };
    }
    if (status === 400 || status === 401 || status === 403) {
      // GitHub reports a rejected credential as HTTP 200 with an error body, so
      // a 4xx here is the client credentials or the grant itself being refused.
      // Retrying cannot change either.
      return { kind: "dead_token", message, status, oauthError, retryAfterSec, dead: true };
    }
    return { kind: "unknown", message, status, oauthError, retryAfterSec, dead: false };
  }
  return { kind: "network", message, status: null, oauthError: null, retryAfterSec: null, dead: false };
}

function refreshBackoffMs(failure: RefreshFailure, consecutiveFailures: number): number {
  const exponential = Math.min(
    REFRESH_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    REFRESH_BACKOFF_MAX_MS,
  );
  const requested = failure.retryAfterSec != null ? failure.retryAfterSec * 1_000 : 0;
  return Math.max(exponential, requested);
}

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
  const appDeviceAuthSessions = new Map<string, GitHubAppDeviceAuthSession>();
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

  const pruneExpiredDeviceAuthSessions = (requestedSessionId?: string): boolean => {
    const nowMs = now();
    let requestedExpired = false;
    for (const [sessionId, session] of appDeviceAuthSessions.entries()) {
      if (Date.parse(session.expiresAt) <= nowMs) {
        appDeviceAuthSessions.delete(sessionId);
        if (sessionId === requestedSessionId) requestedExpired = true;
      }
    }
    return requestedExpired;
  };

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
   * mutator decided. A store without `updateKeySync` degrades to a plain
   * read-modify-write: still correct inside one process, and the only stores
   * without it are process-local ones.
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
      if (store.updateKeySync) {
        store.updateKeySync(GITHUB_APP_USER_TOKEN_KEY, applyRaw);
        return result;
      }
      const next = applyRaw(store.getSync(GITHUB_APP_USER_TOKEN_KEY)?.trim() || null);
      if (next === undefined) return result;
      if (next === null) store.deleteSync(GITHUB_APP_USER_TOKEN_KEY);
      else store.setSync(GITHUB_APP_USER_TOKEN_KEY, next);
      return result;
    } catch (error) {
      args.logger.warn("github.app_user_token_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const refreshTokenUnusable = (record: GitHubAppUserTokenRecord): boolean => {
    // A missing refreshTokenExpiresAt is unknown, not expired — attempt the
    // refresh instead of writing off a possibly-valid credential.
    if (!record.refreshToken) return true;
    return record.refreshTokenExpiresAt != null
      && !readIsoAfter(record.refreshTokenExpiresAt, now());
  };

  const credentialStateOf = (stored: StoredAppUserAuth): GitHubAppUserAuthCredentialState => {
    if (!stored.token?.accessToken) return "missing";
    if (stored.refresh.dead || refreshTokenUnusable(stored.token)) return "needs_reauth";
    if (readIsoAfter(stored.refresh.notBeforeAt, now())) return "blocked";
    return "authorized";
  };

  const appUserAuthStatus = (patch: Partial<GitHubAppUserAuthStatus> = {}): GitHubAppUserAuthStatus => {
    const stored = readStoredAuth();
    const credentialState = credentialStateOf(stored);
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
    null,
    null,
  );

  const needsReauthError = (failure: RefreshLedger["lastFailure"]): GitHubAppUserAuthError =>
    new GitHubAppUserAuthError(
      "ADE GitHub App authorization expired. Re-authorize ADE with GitHub.",
      "needs_reauth",
      null,
      failure?.kind ?? null,
      failure?.status ?? null,
      failure?.oauthError ?? null,
    );

  const blockedError = (
    retryAt: string | null,
    failure: RefreshLedger["lastFailure"],
  ): GitHubAppUserAuthError => new GitHubAppUserAuthError(
    // The deadline rides on `retryAt` rather than inside the sentence: callers
    // that show it to a person format it, and callers that log it read the field.
    "GitHub paused ADE's authorization renewal. ADE retries on its own.",
    "blocked",
    retryAt,
    failure?.kind ?? null,
    failure?.status ?? null,
    failure?.oauthError ?? null,
  );

  const isAccessTokenFresh = (record: GitHubAppUserTokenRecord): boolean => {
    const refreshCutoff = now() + GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS;
    return !record.expiresAt || readIsoAfter(record.expiresAt, refreshCutoff);
  };

  /**
   * Takes the refresh lease, or reports who already holds it.
   *
   * The record to POST is captured INSIDE this atomic update. Capturing it from
   * an earlier read leaves a window where a peer finishes its refresh, rotates
   * the token, and releases the lease — and the old refresh token gets POSTed
   * anyway, which GitHub answers by revoking the credential. For the same
   * reason a token found already fresh here is returned instead of leased.
   */
  const acquireRefreshLease = (): {
    acquired: boolean;
    leaseUntil: string | null;
    record: GitHubAppUserTokenRecord | null;
    alreadyFresh: boolean;
  } =>
    updateStoredAuth<{
      acquired: boolean;
      leaseUntil: string | null;
      record: GitHubAppUserTokenRecord | null;
      alreadyFresh: boolean;
    }>((stored) => {
      if (!stored.token) {
        return { next: undefined, result: { acquired: false, leaseUntil: null, record: null, alreadyFresh: false } };
      }
      if (isAccessTokenFresh(stored.token)) {
        return {
          next: undefined,
          result: { acquired: false, leaseUntil: null, record: stored.token, alreadyFresh: true },
        };
      }
      const held = readIsoAfter(stored.refresh.leaseUntil, now())
        && stored.refresh.leaseHolder !== leaseHolderId;
      if (held) {
        return {
          next: undefined,
          result: { acquired: false, leaseUntil: stored.refresh.leaseUntil, record: null, alreadyFresh: false },
        };
      }
      const leaseUntil = new Date(now() + REFRESH_LEASE_MS).toISOString();
      return {
        next: {
          token: stored.token,
          refresh: { ...stored.refresh, leaseUntil, leaseHolder: leaseHolderId },
        },
        result: { acquired: true, leaseUntil, record: stored.token, alreadyFresh: false },
      };
    });

  const persistRefreshSuccess = (refreshed: GitHubAppUserTokenRecord): number =>
    updateStoredAuth<number>((stored) => {
      // A record that vanished while the POST was in flight was cleared by a
      // sign-out. Writing the refreshed token back would undo it.
      if (!stored.token) return { next: undefined, result: 0 };
      const generation = stored.refresh.generation + 1;
      return {
        next: { token: refreshed, refresh: { ...emptyLedger(), generation } },
        result: generation,
      };
    });

  type PersistedRefreshFailure = {
    notBeforeAt: string | null;
    backoffMs: number;
    consecutiveFailures: number;
  };

  const persistRefreshFailure = (failure: RefreshFailure): PersistedRefreshFailure =>
    updateStoredAuth<PersistedRefreshFailure>((stored) => {
    if (!stored.token) {
      return { next: undefined, result: { notBeforeAt: null, backoffMs: 0, consecutiveFailures: 0 } };
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
          dead: stored.refresh.dead || failure.dead,
          leaseUntil: null,
          leaseHolder: null,
          lastFailure: {
            kind: failure.kind,
            message: failure.message,
            status: failure.status,
            oauthError: failure.oauthError,
            retryAfterSec: failure.retryAfterSec,
            at: new Date(now()).toISOString(),
          },
        },
      },
      result: { notBeforeAt, backoffMs, consecutiveFailures },
    };
  });

  const runRefreshPost = async (record: GitHubAppUserTokenRecord): Promise<GitHubAppUserTokenRecord> => {
    const epochAtStart = authEpoch;
    try {
      const refreshed = await refreshGitHubAppUserToken({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        refreshToken: record.refreshToken!,
        fetchImpl: (input, init) => args.fetchImpl(String(input), init),
        userAgent: args.userAgent,
        fetchUserLogin: fetchAppUserLogin,
      });
      if (authEpoch !== epochAtStart) {
        // Auth was cleared or replaced while this POST was in flight; the store
        // is the truth, not this result.
        const current = readStoredAuth();
        if (!current.token) throw missingAuthError();
        return current.token;
      }
      const generation = persistRefreshSuccess(refreshed);
      args.logger.info("github.app_user_token_refresh_succeeded", {
        generation,
        userLogin: refreshed.userLogin,
        expiresAt: refreshed.expiresAt,
        refreshTokenRotated: refreshed.refreshToken !== record.refreshToken,
      });
      return refreshed;
    } catch (error) {
      if (error instanceof GitHubAppUserAuthError) throw error;
      const failure = classifyRefreshFailure(error);
      const persisted = persistRefreshFailure(failure);
      args.logger.warn("github.app_user_token_refresh_failed", {
        error: failure.message,
        kind: failure.kind,
        status: failure.status,
        oauthError: failure.oauthError,
        retryAfterSec: failure.retryAfterSec,
        backoffMs: persisted.backoffMs,
        consecutiveFailures: persisted.consecutiveFailures,
        dead: failure.dead,
      });
      throw failure.dead
        ? needsReauthError({
          kind: failure.kind,
          message: failure.message,
          status: failure.status,
          oauthError: failure.oauthError,
          retryAfterSec: failure.retryAfterSec,
          at: new Date(now()).toISOString(),
        })
        : blockedError(persisted.notBeforeAt, {
          kind: failure.kind,
          message: failure.message,
          status: failure.status,
          oauthError: failure.oauthError,
          retryAfterSec: failure.retryAfterSec,
          at: new Date(now()).toISOString(),
        });
    }
  };

  /**
   * The one refresh body, run under this process's coordinator and the on-disk
   * lease. Every gate here is checked against a FRESH read of the store, so a
   * peer's outcome is honoured instead of raced.
   */
  const refreshUnderLease = async (): Promise<GitHubAppUserTokenRecord> => {
    for (let attempt = 0; attempt <= LEASE_POLL_MAX_ATTEMPTS; attempt += 1) {
      const stored = readStoredAuth();
      if (!stored.token?.accessToken) throw missingAuthError();
      if (isAccessTokenFresh(stored.token)) return stored.token;
      if (stored.refresh.dead) throw needsReauthError(stored.refresh.lastFailure);
      if (refreshTokenUnusable(stored.token)) throw needsReauthError(stored.refresh.lastFailure);
      if (readIsoAfter(stored.refresh.notBeforeAt, now())) {
        throw blockedError(stored.refresh.notBeforeAt, stored.refresh.lastFailure);
      }
      const lease = acquireRefreshLease();
      if (lease.alreadyFresh && lease.record) return lease.record;
      if (lease.acquired && lease.record) return await runRefreshPost(lease.record);
      if (lease.acquired) throw missingAuthError();
      // A peer is mid-refresh. Never POST the same refresh token behind it: the
      // peer may already have rotated it, and GitHub answers a reused refresh
      // token by revoking the credential outright.
      if (attempt === LEASE_POLL_MAX_ATTEMPTS) {
        throw blockedError(lease.leaseUntil, stored.refresh.lastFailure);
      }
      await sleep(LEASE_POLL_INTERVAL_MS);
    }
    throw blockedError(null, readStoredAuth().refresh.lastFailure);
  };

  const getValidAppUserTokenForRelay = async (): Promise<string> => {
    const stored = readStoredAuth();
    if (!stored.token?.accessToken) throw missingAuthError();
    if (isAccessTokenFresh(stored.token)) return stored.token.accessToken;
    if (stored.refresh.dead) throw needsReauthError(stored.refresh.lastFailure);
    if (readIsoAfter(stored.refresh.notBeforeAt, now())) {
      throw blockedError(stored.refresh.notBeforeAt, stored.refresh.lastFailure);
    }
    const coordinator = coordinatorFor(storeIdentity);
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

  const startDeviceAuth = async (): Promise<GitHubAppDeviceAuthStartResult> => {
    pruneExpiredDeviceAuthSessions();
    // Cap pending sessions so a runaway caller cannot grow the map or spam
    // GitHub's device endpoint via ADE; evict oldest first.
    while (appDeviceAuthSessions.size >= MAX_PENDING_DEVICE_AUTH_SESSIONS) {
      const oldest = appDeviceAuthSessions.keys().next().value;
      if (!oldest) break;
      appDeviceAuthSessions.delete(oldest);
    }
    let device: GitHubAppDeviceCode;
    try {
      device = await startGitHubAppDeviceFlow({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        fetchImpl: (input, init) => args.fetchImpl(String(input), init),
        userAgent: args.userAgent,
      });
    } catch (error) {
      const described = describeGitHubAppUserAuthFailure(error);
      args.logger.warn("github.app_user_device_start_failed", {
        error: described.message,
        status: described.status,
        oauthError: described.oauthError,
      });
      // Re-authorizing is what a user reaches for when the credential broke, and
      // it goes to the same host that is throttling ADE. Say that, rather than
      // handing back a status code.
      if (described.status === 429) {
        throw new Error(
          "GitHub is rate-limiting ADE's sign-in requests right now. Try again in a few minutes.",
        );
      }
      throw error;
    }
    const sessionId = randomUUID();
    appDeviceAuthSessions.set(sessionId, { ...device, sessionId });
    return {
      sessionId,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: device.expiresAt,
      intervalSec: device.intervalSec,
    };
  };

  const pollDeviceAuth = async (pollArgs: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult> => {
    const requestedSessionExpired = pruneExpiredDeviceAuthSessions(pollArgs.sessionId);
    const session = appDeviceAuthSessions.get(pollArgs.sessionId);
    if (!session) {
      if (requestedSessionExpired) {
        return {
          status: "expired",
          intervalSec: null,
          message: "GitHub device authorization expired.",
          authStatus: appUserAuthStatus(),
        };
      }
      return {
        status: "error",
        intervalSec: null,
        message: "GitHub device authorization session was not found.",
        authStatus: appUserAuthStatus(),
      };
    }
    let result: Awaited<ReturnType<typeof pollGitHubAppDeviceFlow>>;
    try {
      result = await pollGitHubAppDeviceFlow({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        deviceCode: session.deviceCode,
        intervalSec: session.intervalSec,
        fetchImpl: (input, init) => args.fetchImpl(String(input), init),
        userAgent: args.userAgent,
        fetchUserLogin: fetchAppUserLogin,
      });
    } catch (error) {
      // A transport failure is a poll RESULT, not a thrown IPC error: the caller
      // is a polling UI, and it can only pace itself if it is told what
      // happened. A 429 here is GitHub throttling ADE, not a denied user.
      const described = describeGitHubAppUserAuthFailure(error);
      const rateLimited = described.status === 429;
      const message = rateLimited
        ? "GitHub is rate-limiting ADE's sign-in requests right now. Try again in a few minutes."
        : described.message;
      args.logger.warn("github.app_user_device_poll_failed", {
        error: described.message,
        status: described.status,
        oauthError: described.oauthError,
      });
      return {
        status: "error",
        intervalSec: null,
        message,
        authStatus: appUserAuthStatus({ error: message }),
      };
    }
    if (result.status === "pending" || result.status === "slow_down") {
      session.intervalSec = result.intervalSec;
      appDeviceAuthSessions.set(session.sessionId, session);
      return {
        status: result.status,
        intervalSec: result.intervalSec,
        message: result.message,
        authStatus: appUserAuthStatus(),
      };
    }
    appDeviceAuthSessions.delete(pollArgs.sessionId);
    if (result.status === "authorized") {
      authEpoch += 1;
      persistAppUserTokenRecord(result.token);
      return {
        status: "authorized",
        intervalSec: null,
        message: null,
        authStatus: appUserAuthStatus(),
      };
    }
    return {
      status: result.status,
      intervalSec: null,
      message: result.message,
      authStatus: appUserAuthStatus({ error: result.message }),
    };
  };

  const clearAuth = (): GitHubAppUserAuthStatus => {
    authEpoch += 1;
    persistAppUserTokenRecord(null);
    appDeviceAuthSessions.clear();
    return appUserAuthStatus();
  };

  return {
    getAuthStatus: appUserAuthStatus,
    startDeviceAuth,
    pollDeviceAuth,
    clearAuth,
    getStoredTokenForHealth: () => readAppUserTokenRecord()?.accessToken ?? null,
    getValidTokenForRelay: getValidAppUserTokenForRelay,
    auditLog,
  };
}
