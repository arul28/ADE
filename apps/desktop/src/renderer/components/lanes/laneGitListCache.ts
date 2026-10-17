import type { BranchDiffChanges, GitCommitSummary, GitHubPrListItem, PrSummary } from "../../../shared/types";

/**
 * The last successful Branch diff and History read for each lane, kept across
 * pane mounts so a revisit paints those rows at once. The same reads run as
 * before, and their result replaces these rows when it lands.
 *
 * Entries are keyed by project (runtime pin) and lane, and each one records the
 * branch it was read for, so a branch change never paints the old branch's rows.
 * Every local git mutation in the lane pane runs `invalidateLaneGitCaches` first,
 * which calls `invalidateLaneGitListCache` and also drops the uncommitted changes.
 * A read that started before any invalidation is never written back, so rows
 * from before a mutation cannot return through a read that was still in flight.
 */

type LaneGitListEntry = {
  branchRef: string | null;
  branchChanges?: BranchDiffChanges;
  commits?: GitCommitSummary[];
};

export type LaneGitListSnapshot = Pick<LaneGitListEntry, "branchChanges" | "commits">;

const MAX_LANE_GIT_LIST_CACHE_ENTRIES = 20;
const entries = new Map<string, LaneGitListEntry>();
let invalidationEpoch = 0;

export function laneGitListScope(projectKey: string | null | undefined, laneId: string | null): string | null {
  if (!laneId) return null;
  return `${projectKey?.trim() || "__project__"}::${laneId}`;
}

/** Read before a fetch starts and pass it to `writeLaneGitListCache` when the result lands. */
export function laneGitListEpoch(): number {
  return invalidationEpoch;
}

export function readLaneGitListCache(scope: string | null, branchRef: string | null): LaneGitListSnapshot | null {
  if (!scope) return null;
  const entry = entries.get(scope);
  if (!entry) return null;
  entries.delete(scope);
  entries.set(scope, entry);
  if (entry.branchRef !== branchRef) return null;
  return { branchChanges: entry.branchChanges, commits: entry.commits };
}

export function writeLaneGitListCache(
  scope: string | null,
  epochAtStart: number,
  branchRef: string | null,
  patch: LaneGitListSnapshot,
): void {
  if (!scope || epochAtStart !== invalidationEpoch) return;
  const previous = entries.get(scope);
  const base: LaneGitListEntry = previous?.branchRef === branchRef ? previous : { branchRef };
  entries.delete(scope);
  entries.set(scope, { ...base, ...patch });
  while (entries.size > MAX_LANE_GIT_LIST_CACHE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function invalidateLaneGitListCache(projectKey: string | null | undefined, laneId: string | null): void {
  invalidationEpoch += 1;
  const scope = laneGitListScope(projectKey, laneId);
  if (scope) entries.delete(scope);
  if (laneId) overviewByLane.delete(laneId);
}

/* ───────────── Lane overview (dashboard) ─────────────
 * The dashboard's per-lane reads (sync status, recent commits, operations, chat
 * and CLI sessions) keep their last successful result the same way. Every entry
 * is keyed by lane id first, so a git mutation that invalidates the lane drops
 * all of its overview rows, whichever machine's pin they were read through. */

export type LaneOverviewField = "upstream" | "commits" | "operations" | "sessions";

type LaneOverviewSlot = { branchKey: string; value: unknown };
type LaneOverviewByPin = Map<string, Partial<Record<LaneOverviewField, LaneOverviewSlot>>>;

const overviewByLane = new Map<string, LaneOverviewByPin>();

export type LaneOverviewPrs = { prs: PrSummary[]; githubPrs: GitHubPrListItem[] };
const overviewPrsByProject = new Map<string, LaneOverviewPrs>();

const MAX_LANE_OVERVIEW_ENTRIES = 20;

/** `pinKey` is the lane's machine pin (null for the tab's machine). */
export function readLaneOverviewField<T>(
  pinKey: string | null,
  laneId: string | null,
  field: LaneOverviewField,
  branchKey: string,
): T | undefined {
  if (!laneId) return undefined;
  const slot = overviewByLane.get(laneId)?.get(pinKey ?? "")?.[field];
  if (!slot || slot.branchKey !== branchKey) return undefined;
  return slot.value as T;
}

/** A read that started before any invalidation is never written back, as for the Git lists. */
export function writeLaneOverviewField<T>(
  pinKey: string | null,
  laneId: string | null,
  epochAtStart: number,
  field: LaneOverviewField,
  branchKey: string,
  value: T,
): void {
  if (!laneId || epochAtStart !== invalidationEpoch) return;
  const byPin = overviewByLane.get(laneId) ?? new Map();
  overviewByLane.delete(laneId);
  const pinEntry = byPin.get(pinKey ?? "") ?? {};
  byPin.set(pinKey ?? "", { ...pinEntry, [field]: { branchKey, value } });
  overviewByLane.set(laneId, byPin);
  while (overviewByLane.size > MAX_LANE_OVERVIEW_ENTRIES) {
    const oldest = overviewByLane.keys().next().value;
    if (oldest === undefined) break;
    overviewByLane.delete(oldest);
  }
}

/** Sessions and operations are read for a lane, not a branch, so they key on the empty branch. */
export const LANE_OVERVIEW_ANY_BRANCH = "";

export function readLaneOverviewPrs(projectStateKey: string | null): LaneOverviewPrs | null {
  if (!projectStateKey) return null;
  return overviewPrsByProject.get(projectStateKey) ?? null;
}

export function writeLaneOverviewPrs(projectStateKey: string | null, patch: Partial<LaneOverviewPrs>): void {
  if (!projectStateKey) return;
  const previous = overviewPrsByProject.get(projectStateKey) ?? { prs: [], githubPrs: [] };
  overviewPrsByProject.delete(projectStateKey);
  overviewPrsByProject.set(projectStateKey, { ...previous, ...patch });
  while (overviewPrsByProject.size > MAX_LANE_OVERVIEW_ENTRIES) {
    const oldest = overviewPrsByProject.keys().next().value;
    if (oldest === undefined) break;
    overviewPrsByProject.delete(oldest);
  }
}

/** A fresh read equal to what is already rendered keeps the old object, so React skips the re-render. */
export function isSameListResult<T>(previous: T | null | undefined, next: T): boolean {
  return previous != null && JSON.stringify(previous) === JSON.stringify(next);
}

export function __resetLaneGitListCacheForTests(): void {
  entries.clear();
  overviewByLane.clear();
  overviewPrsByProject.clear();
}
