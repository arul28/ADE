import type {
  BranchDiffChanges,
  DiffChanges,
  GitCommitSummary,
  GitConflictState,
  GitStashSummary,
  GitUpstreamSyncStatus,
} from "../../../shared/types";

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
 *
 * The Git pane's other per-lane state (uncommitted changes, stashes, sync and
 * conflict state) is kept here too, under the same scope key.
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
}

/** A fresh read equal to what is already rendered keeps the old object, so React skips the re-render. */
export function isSameListResult<T>(previous: T | null | undefined, next: T): boolean {
  return previous != null && JSON.stringify(previous) === JSON.stringify(next);
}

/* ---- The Git pane's uncommitted changes, stashes and sync state ---- */

type LaneGitActionsCachedState = {
  changes?: DiffChanges;
  stashes: GitStashSummary[];
  syncStatus: GitUpstreamSyncStatus | null;
  forcePushSuggested: boolean;
  conflictState: GitConflictState | null;
  stuckRebase: GitConflictState | null;
  updatedAtMs: number;
};

export const EMPTY_CHANGES: DiffChanges = { unstaged: [], staged: [] };
const MAX_LANE_GIT_ACTIONS_CACHE_ENTRIES = 96;
const laneGitActionsStateByScope = new Map<string, LaneGitActionsCachedState>();

export function readLaneGitActionsCachedState(
  projectKey: string | null | undefined,
  laneId: string | null,
): LaneGitActionsCachedState | null {
  const key = laneGitListScope(projectKey, laneId);
  if (!key) return null;
  const cached = laneGitActionsStateByScope.get(key) ?? null;
  if (!cached) return null;
  laneGitActionsStateByScope.delete(key);
  laneGitActionsStateByScope.set(key, cached);
  return cached;
}

export function patchLaneGitActionsCachedState(
  projectKey: string | null | undefined,
  laneId: string | null,
  patch: Partial<Omit<LaneGitActionsCachedState, "updatedAtMs">>,
): LaneGitActionsCachedState | null {
  const key = laneGitListScope(projectKey, laneId);
  if (!key) return null;
  const previous = laneGitActionsStateByScope.get(key);
  const next: LaneGitActionsCachedState = {
    // A cleared entry keeps `changes` undefined: defaulting it back to the
    // empty placeholder would read as "changes already loaded" on the next mount.
    changes: previous ? previous.changes : EMPTY_CHANGES,
    stashes: previous?.stashes ?? [],
    syncStatus: previous?.syncStatus ?? null,
    forcePushSuggested: previous?.forcePushSuggested ?? false,
    conflictState: previous?.conflictState ?? null,
    stuckRebase: previous?.stuckRebase ?? null,
    ...patch,
    updatedAtMs: Date.now(),
  };
  laneGitActionsStateByScope.delete(key);
  laneGitActionsStateByScope.set(key, next);
  while (laneGitActionsStateByScope.size > MAX_LANE_GIT_ACTIONS_CACHE_ENTRIES) {
    const oldest = laneGitActionsStateByScope.keys().next().value;
    if (!oldest) break;
    laneGitActionsStateByScope.delete(oldest);
  }
  return next;
}

/**
 * Runs before every local git mutation on a lane. Drops the lane's cached
 * Branch diff, History and uncommitted changes, so a remount before the
 * post-mutation refresh lands shows the loading state and never the rows from
 * before the mutation.
 */
export function invalidateLaneGitCaches(projectKey: string | null | undefined, laneId: string | null): void {
  invalidateLaneGitListCache(projectKey, laneId);
  const key = laneGitListScope(projectKey, laneId);
  const cached = key ? laneGitActionsStateByScope.get(key) : undefined;
  if (key && cached?.changes) {
    laneGitActionsStateByScope.set(key, { ...cached, changes: undefined, updatedAtMs: Date.now() });
  }
}

export function __resetLaneGitListCacheForTests(): void {
  entries.clear();
  laneGitActionsStateByScope.clear();
}
