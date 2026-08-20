import { randomUUID } from "node:crypto";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthCredentialState,
  GitHubAppUserAuthStatus,
} from "../../../shared/types";
import {
  ADE_GITHUB_APP_CLIENT_ID,
  type GitHubAppDeviceCode,
  type GitHubAppUserTokenRecord,
  pollGitHubAppDeviceFlow,
  refreshGitHubAppUserToken,
  startGitHubAppDeviceFlow,
} from "./githubAppUserAuth";
import {
  emptyLedger,
  parseStoredAppUserAuth,
  readIsoAfter,
  serializeStoredAppUserAuth,
  type StoredAppUserAuth,
  type StoredRefreshFailure,
} from "./githubAppUserAuthLedger";
import {
  GitHubAppUserAuthError,
  classifyRefreshFailure,
  describeGitHubAppUserAuthFailure,
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
const MAX_PENDING_DEVICE_AUTH_SESSIONS = 5;
/** How long one process may hold the right to run the refresh POST. */
const REFRESH_LEASE_MS = 60_000;
const REFRESH_BACKOFF_BASE_MS = 60_000;
const REFRESH_BACKOFF_MAX_MS = 60 * 60_000;
const LEASE_POLL_INTERVAL_MS = 250;
/** Bounds the wait for a peer's refresh at roughly three seconds. */
const LEASE_POLL_MAX_ATTEMPTS = 12;
/**
 * What a person is told when GitHub throttles the sign-in endpoint itself.
 *
 * Re-authorizing is what a user reaches for when the credential broke, and it
 * goes to the same host that is throttling ADE. Say that, rather than handing
 * back a status code.
 */
const GITHUB_SIGN_IN_RATE_LIMITED_COPY =
  "GitHub is rate-limiting ADE's sign-in requests right now. Try again in a few minutes.";

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

  const isAccessTokenFresh = (record: GitHubAppUserTokenRecord): boolean => {
    const refreshCutoff = now() + GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS;
    return !record.expiresAt || readIsoAfter(record.expiresAt, refreshCutoff);
  };

  /**
   * What one atomic look at the refresh ledger decided.
   *
   * Declared once, because the helper that produces it, the loop that drives it
   * and the errors it turns into all have to agree on the same set of outcomes.
   */
  type RefreshLeaseAttempt =
    | { outcome: "missing" }
    | { outcome: "fresh"; record: GitHubAppUserTokenRecord }
    | { outcome: "needs_reauth"; failure: StoredRefreshFailure | null }
    | { outcome: "blocked"; retryAt: string | null; failure: StoredRefreshFailure | null }
    | { outcome: "held"; leaseUntil: string | null; failure: StoredRefreshFailure | null }
    | { outcome: "acquired"; record: GitHubAppUserTokenRecord };

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
      const decline = (result: RefreshLeaseAttempt) => ({ next: undefined, result });
      const failure = stored.refresh.lastFailure;
      if (!stored.token?.accessToken) return decline({ outcome: "missing" });
      if (isAccessTokenFresh(stored.token)) {
        return decline({ outcome: "fresh", record: stored.token });
      }
      if (stored.refresh.dead || refreshTokenUnusable(stored.token)) {
        return decline({ outcome: "needs_reauth", failure });
      }
      if (readIsoAfter(stored.refresh.notBeforeAt, now())) {
        return decline({ outcome: "blocked", retryAt: stored.refresh.notBeforeAt, failure });
      }
      if (
        readIsoAfter(stored.refresh.leaseUntil, now())
        && stored.refresh.leaseHolder !== leaseHolderId
      ) {
        return decline({ outcome: "held", leaseUntil: stored.refresh.leaseUntil, failure });
      }
      const leaseUntil = new Date(now() + REFRESH_LEASE_MS).toISOString();
      return {
        next: {
          token: stored.token,
          refresh: { ...stored.refresh, leaseUntil, leaseHolder: leaseHolderId },
        },
        result: { outcome: "acquired", record: stored.token },
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
    const current = readStoredAuth();
    if (!current.token?.accessToken) throw missingAuthError();
    if (isAccessTokenFresh(current.token)) return current.token;
    if (current.refresh.dead) throw needsReauthError(current.refresh.lastFailure);
    if (readIsoAfter(current.refresh.notBeforeAt, now())) {
      throw blockedError(current.refresh.notBeforeAt, current.refresh.lastFailure);
    }
    // Stale but healthy. The next call runs the gate again and renews it; this
    // call must not report a failure that belongs to a replaced credential.
    return current.token;
  };

  const runRefreshPost = async (record: GitHubAppUserTokenRecord): Promise<GitHubAppUserTokenRecord> => {
    const epochAtStart = authEpoch;
    // Held for the whole call: every write below is allowed only over the
    // credential this exact token belongs to.
    const postedRefreshToken = record.refreshToken;
    try {
      const refreshed = await refreshGitHubAppUserToken({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        refreshToken: postedRefreshToken!,
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
    }
  };

  /**
   * Remembers, for this process only, that a peer still held the lease when the
   * wait ran out.
   */
  const rememberPeerLease = (leaseUntil: string | null): void => {
    const until = leaseUntil ? Date.parse(leaseUntil) : NaN;
    if (!Number.isFinite(until) || until <= now()) return;
    coordinatorFor(storeIdentity).peerLeaseUntilMs = until;
  };

  /**
   * The one refresh body, run under this process's coordinator and the on-disk
   * lease. Every gate is judged inside `acquireRefreshLease`, so each turn takes
   * one locked look at the store and a peer's outcome is honoured, not raced.
   */
  const refreshUnderLease = async (): Promise<GitHubAppUserTokenRecord> => {
    for (let attempt = 0; attempt <= LEASE_POLL_MAX_ATTEMPTS; attempt += 1) {
      const lease = acquireRefreshLease();
      if (lease.outcome === "missing") throw missingAuthError();
      if (lease.outcome === "fresh") return lease.record;
      if (lease.outcome === "needs_reauth") throw needsReauthError(lease.failure);
      if (lease.outcome === "blocked") throw blockedError(lease.retryAt, lease.failure);
      if (lease.outcome === "acquired") return await runRefreshPost(lease.record);
      // A peer is mid-refresh. Never POST the same refresh token behind it: the
      // peer may already have rotated it, and GitHub answers a reused refresh
      // token by revoking the credential outright.
      if (attempt === LEASE_POLL_MAX_ATTEMPTS) {
        rememberPeerLease(lease.leaseUntil);
        throw blockedError(lease.leaseUntil, lease.failure);
      }
      await sleep(LEASE_POLL_INTERVAL_MS);
    }
    throw blockedError(null, readStoredAuth().refresh.lastFailure);
  };

  const getValidAppUserTokenForRelay = async (): Promise<string> => {
    const stored = readStoredAuth();
    const coordinator = coordinatorFor(storeIdentity);
    if (!stored.token?.accessToken) throw missingAuthError();
    if (isAccessTokenFresh(stored.token)) {
      // A fresh token proves the peer's refresh landed, so the remembered
      // deadline has done its job.
      coordinator.peerLeaseUntilMs = 0;
      return stored.token.accessToken;
    }
    if (stored.refresh.dead) throw needsReauthError(stored.refresh.lastFailure);
    if (readIsoAfter(stored.refresh.notBeforeAt, now())) {
      throw blockedError(stored.refresh.notBeforeAt, stored.refresh.lastFailure);
    }
    // A peer still held the lease when an earlier wait ran out. Polling for
    // three more seconds cannot learn anything before that deadline passes, and
    // every project scope in this process would pay the wait separately.
    if (coordinator.peerLeaseUntilMs > now()) {
      throw blockedError(
        new Date(coordinator.peerLeaseUntilMs).toISOString(),
        stored.refresh.lastFailure,
      );
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
      if (described.status === 429) throw new Error(GITHUB_SIGN_IN_RATE_LIMITED_COPY);
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
      const message = described.status === 429
        ? GITHUB_SIGN_IN_RATE_LIMITED_COPY
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
