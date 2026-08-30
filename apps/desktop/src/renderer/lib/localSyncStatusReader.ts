import type { SyncGetStatusArgs, SyncRoleSnapshot } from "../../shared/types";

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
};

const state: ReaderState = {
  inFlight: null,
  lastSnapshot: null,
  lastError: null,
  consecutiveFailures: 0,
  nextAttemptAtMs: 0,
};

/** Test seam; production always uses the real clock. */
let now: () => number = () => Date.now();

function settleHealthy(snapshot: SyncRoleSnapshot): void {
  state.lastSnapshot = snapshot;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.nextAttemptAtMs = 0;
}

function settleUnhealthy(snapshot: SyncRoleSnapshot | null, error: unknown): void {
  state.lastSnapshot = snapshot;
  state.lastError = snapshot ? null : error;
  state.consecutiveFailures += 1;
  state.nextAttemptAtMs = now() + localSyncStatusBackoffMs(state.consecutiveFailures);
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
  args?: SyncGetStatusArgs,
  options?: { force?: boolean },
): Promise<SyncRoleSnapshot> {
  if (state.inFlight) return state.inFlight;
  // `force` is for reads a person asked for (a Try again click, a read right
  // after a device mutation). Those are bounded by the user, so the backoff
  // window must not swallow them.
  if (!options?.force && state.consecutiveFailures > 0 && now() < state.nextAttemptAtMs) {
    return state.lastSnapshot
      ? Promise.resolve(state.lastSnapshot)
      : Promise.reject(state.lastError);
  }
  const request = Promise.resolve()
    .then(() => window.ade.sync.getLocalStatus(args))
    .then(
      (snapshot) => {
        if (isDegradedLocalSyncSnapshot(snapshot)) settleUnhealthy(snapshot, null);
        else settleHealthy(snapshot);
        return snapshot;
      },
      (error: unknown) => {
        settleUnhealthy(null, error);
        throw error;
      },
    )
    .finally(() => {
      if (state.inFlight === request) state.inFlight = null;
    });
  state.inFlight = request;
  return request;
}

/** Test-only: drop all cached state and restore the real clock. */
export function resetLocalSyncStatusReaderForTests(clock?: () => number): void {
  state.inFlight = null;
  state.lastSnapshot = null;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.nextAttemptAtMs = 0;
  now = clock ?? (() => Date.now());
}
