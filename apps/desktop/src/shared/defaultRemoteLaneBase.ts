// Timing and freshness rules for fetching the branch a new lane starts from
// (`LaneStart.on === "remote"`): the chat launch's fetch stage
// (`chatLaunchStartFetch.ts`) waits briefly on a fresh `origin/<branch>` and
// for the whole fetch on a stale one, and its stage row reports the age.

/** How long a new lane waits for the fetch when its remote-tracking base looks fresh. */
export const DEFAULT_LANE_BASE_REMOTE_FETCH_TIMEOUT_MS = 4_000;

/** `git fetch --prune`'s own budget (`gitOperationsService.fetch`). */
export const GIT_FETCH_TIMEOUT_MS = 60_000;

/**
 * How long a new lane waits for the fetch when its base looks stale: the
 * fetch's whole budget plus a little slack for the lane-operation queue.
 */
export const STALE_LANE_BASE_FETCH_WAIT_MS = GIT_FETCH_TIMEOUT_MS + 5_000;

/** The last fetch is older than this: the remote-tracking base is treated as stale. */
export const LANE_BASE_STALE_FETCH_AGE_MS = 24 * 60 * 60 * 1000;

/** The base commit is older than this: the remote-tracking base is treated as stale. */
export const LANE_BASE_STALE_COMMIT_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * True when a remote-tracking base may be far behind the remote: it was last
 * fetched more than a day ago (or never, as far as we can tell), or its tip
 * commit is more than three days old. A stale base waits for the fetch.
 */
export function isLaneBaseStale(args: {
  lastFetchedAtMs: number | null;
  committedAtMs: number | null;
  nowMs: number;
}): boolean {
  if (args.lastFetchedAtMs == null || args.nowMs - args.lastFetchedAtMs > LANE_BASE_STALE_FETCH_AGE_MS) return true;
  return args.committedAtMs != null && args.nowMs - args.committedAtMs > LANE_BASE_STALE_COMMIT_AGE_MS;
}

/** "3 days", "5 hours", "12 minutes", "just now" — for "last fetched N ago". */
export function formatLaneBaseAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}
