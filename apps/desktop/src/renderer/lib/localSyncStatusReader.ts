import type { SyncRoleSnapshot } from "../../shared/types";

/**
 * Shared reader for `ade.sync.getLocalStatus`.
 *
 * Every subscriber of the `sync-status` broadcast re-reads the LOCAL snapshot
 * when an event lands (the event is an invalidation, not the payload — see
 * AppShell / useSyncConnections). That is fine while the local runtime answers
 * in milliseconds. It is not fine while the runtime is degraded: the call then
 * takes seconds and can sit until the 30s IPC timeout, the broadcast keeps
 * firing, and each event stacks another in-flight invoke on top of the ones
 * still waiting. A measured perf run saw 64k calls in 7 minutes, 71% of them
 * timing out at exactly 30000ms — a backlog, not a poll.
 *
 * Two properties fix that without touching the healthy cadence:
 *  - Coalescing: concurrent readers share one in-flight invoke, so N
 *    subscribers reacting to the same event cost one IPC, never N.
 *  - Backoff: after a failed or degraded read, further reads are served from
 *    the last known answer until the backoff window elapses (base -> x2 ->
 *    max). A healthy read resets the window immediately, so a healthy app
 *    issues exactly the same calls it always did.
 */

export const LOCAL_SYNC_STATUS_BACKOFF_BASE_MS = 1_000;
export const LOCAL_SYNC_STATUS_BACKOFF_MAX_MS = 30_000;

/**
 * Delay before the next allowed read after `consecutiveFailures` unhealthy
 * reads. Zero while healthy, then base * 2^(n-1) capped at max.
 */
export function localSyncStatusBackoffMs(
  consecutiveFailures: number,
  options?: { baseMs?: number; maxMs?: number },
): number {
  const baseMs = options?.baseMs ?? LOCAL_SYNC_STATUS_BACKOFF_BASE_MS;
  const maxMs = options?.maxMs ?? LOCAL_SYNC_STATUS_BACKOFF_MAX_MS;
  if (consecutiveFailures <= 0) return 0;
  // Exponent is bounded before the shift so a long outage cannot overflow.
  const steps = Math.min(consecutiveFailures - 1, 32);
  return Math.min(maxMs, baseMs * 2 ** steps);
}

/**
 * A snapshot the main process could not source from the local runtime. The
 * main process marks these explicitly (`degradedReason`); nothing is inferred
 * from route health, which is legitimately all-down on healthy standalone
 * machines that host nothing.
 */
export function isDegradedLocalSyncSnapshot(snapshot: SyncRoleSnapshot): boolean {
  return typeof snapshot.degradedReason === "string" && snapshot.degradedReason.length > 0;
}

type ReaderState = {
  inFlight: Promise<SyncRoleSnapshot> | null;
  lastSnapshot: SyncRoleSnapshot | null;
  lastError: unknown;
  consecutiveFailures: number;
  nextAttemptAtMs: number;
  /** Monotonic id stamped on every issued request. */
  issuedSeq: number;
  /** Highest request id that has already written the health bookkeeping. */
  lastSettledSeq: number;
  /** Request id currently occupying `inFlight`; 0 when none. */
  inFlightSeq: number;
  /**
   * Bumped by the test reset so a read left dangling by a prior test can
   * never settle into the fresh state. Production never bumps this.
   */
  generation: number;
};

const state: ReaderState = {
  inFlight: null,
  lastSnapshot: null,
  lastError: null,
  consecutiveFailures: 0,
  nextAttemptAtMs: 0,
  issuedSeq: 0,
  lastSettledSeq: 0,
  inFlightSeq: 0,
  generation: 0,
};

/**
 * The identity a request carries from issue to settle.
 *
 * Since `force` lets a second read run alongside the shared one, two requests
 * can be in flight at once and can finish out of order — a forced read
 * typically beats the older shared read that is sitting at the 30s IPC timeout.
 * Settling is therefore last-ISSUED-wins, not last-to-finish: `seq` orders the
 * requests, and `failuresAtIssue` is the failure count this request saw when it
 * started, so two concurrent failures record one failed generation instead of
 * two.
 */
type IssuedRequest = { seq: number; failuresAtIssue: number; generation: number };

function issueRequest(): IssuedRequest {
  state.issuedSeq += 1;
  return {
    seq: state.issuedSeq,
    failuresAtIssue: state.consecutiveFailures,
    generation: state.generation,
  };
}

/** True when a newer request has already settled, making this result stale. */
function isStale(request: IssuedRequest): boolean {
  return request.generation !== state.generation || request.seq < state.lastSettledSeq;
}

/**
 * A settle from a newer request proves any older promise still occupying
 * `inFlight` is doomed to a stale answer (typically a read stuck at the 30s
 * IPC timeout). Evict it so later non-forced callers issue a fresh read
 * instead of coalescing onto it; its own `.finally` no-ops once evicted.
 */
function evictOlderInFlight(request: IssuedRequest): void {
  if (state.inFlight !== null && state.inFlightSeq < request.seq) {
    state.inFlight = null;
    state.inFlightSeq = 0;
  }
}

/** Test seam; production always uses the real clock. */
let now: () => number = () => Date.now();

function settleHealthy(request: IssuedRequest, snapshot: SyncRoleSnapshot): void {
  if (isStale(request)) return;
  state.lastSettledSeq = request.seq;
  state.lastSnapshot = snapshot;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.nextAttemptAtMs = 0;
  evictOlderInFlight(request);
}

function settleUnhealthy(
  request: IssuedRequest,
  snapshot: SyncRoleSnapshot | null,
  error: unknown,
): void {
  if (isStale(request)) return;
  state.lastSettledSeq = request.seq;
  state.lastSnapshot = snapshot;
  state.lastError = snapshot ? null : error;
  state.consecutiveFailures = request.failuresAtIssue + 1;
  state.nextAttemptAtMs = now() + localSyncStatusBackoffMs(state.consecutiveFailures);
  evictOlderInFlight(request);
}

/**
 * Read this machine's sync snapshot, coalesced across callers and backed off
 * while the local runtime is unhealthy.
 *
 * While backed off the last known answer is replayed; if the very first read
 * failed outright there is nothing to replay and the cached rejection is
 * re-thrown, which keeps the existing "Couldn't load connection details" UX.
 */
export function readLocalSyncStatus(
  options?: { force?: boolean },
): Promise<SyncRoleSnapshot> {
  // `force` is for reads a person asked for (a Try again click, the initial
  // open of Connections, a read right after a device mutation). Those are
  // bounded by the user, so neither the backoff window nor an already in-flight
  // read — which may have been issued before the thing they just changed — may
  // swallow them.
  if (state.inFlight && !options?.force) return state.inFlight;
  if (!options?.force && state.consecutiveFailures > 0 && now() < state.nextAttemptAtMs) {
    return state.lastSnapshot
      ? Promise.resolve(state.lastSnapshot)
      : Promise.reject(state.lastError);
  }
  const issued = issueRequest();
  const request = Promise.resolve()
    .then(() => window.ade.sync.getLocalStatus())
    .then(
      (snapshot) => {
        if (isDegradedLocalSyncSnapshot(snapshot)) settleUnhealthy(issued, snapshot, null);
        else settleHealthy(issued, snapshot);
        return snapshot;
      },
      (error: unknown) => {
        settleUnhealthy(issued, null, error);
        throw error;
      },
    )
    .finally(() => {
      if (state.inFlight === request) {
        state.inFlight = null;
        state.inFlightSeq = 0;
      }
    });
  // A forced read never displaces the shared in-flight promise: later
  // non-forced callers keep coalescing onto the read that was already running.
  // Its result still settles the shared health bookkeeping above, last ISSUED
  // request winning — so a stale read finishing after a newer one cannot undo
  // the newer answer, and a newer settle evicts the older shared promise.
  if (state.inFlight === null) {
    state.inFlight = request;
    state.inFlightSeq = issued.seq;
  }
  return request;
}

/** Test-only: drop all cached state and restore the real clock. */
export function resetLocalSyncStatusReaderForTests(clock?: () => number): void {
  state.inFlight = null;
  state.lastSnapshot = null;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.nextAttemptAtMs = 0;
  state.issuedSeq = 0;
  state.lastSettledSeq = 0;
  state.inFlightSeq = 0;
  // Invalidate any read a prior test left dangling; it can never settle here.
  state.generation += 1;
  now = clock ?? (() => Date.now());
}
