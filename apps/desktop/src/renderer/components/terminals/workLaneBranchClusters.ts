import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";

/**
 * Same-branch adjacency for the Work by-lane list.
 *
 * The sidebar stays grouped by lane name. The uncommon case — two worktree
 * lanes on different machines tracking the same feature branch — only tucks
 * those groups next to each other. Primaries and default trunks are excluded:
 * every machine has a Primary on `main`, and boxing those would fire constantly.
 */

const DEFAULT_TRUNK_BRANCHES = new Set(["main", "master"]);

export function sharedBranchClusterKey(args: {
  branchRef?: string | null;
  laneType?: string | null;
}): string | null {
  if (args.laneType === "primary") return null;
  const branch = branchNameFromLaneRef(args.branchRef).trim().toLowerCase();
  if (!branch || DEFAULT_TRUNK_BRANCHES.has(branch)) return null;
  return branch;
}

export type SharedBranchShelfItem = {
  id: string;
  clusterKey: string | null;
  shelf: "working" | "snoozed" | "settled" | null;
};

export function inboxIdsKeptForSharedBranch(
  items: readonly SharedBranchShelfItem[],
): ReadonlySet<string> {
  const kept = new Set<string>();
  const byKey = new Map<string, SharedBranchShelfItem[]>();
  for (const item of items) {
    if (!item.clusterKey) continue;
    const list = byKey.get(item.clusterKey) ?? [];
    list.push(item);
    byKey.set(item.clusterKey, list);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    if (!group.some((item) => item.shelf === null)) continue;
    for (const item of group) {
      if (item.shelf !== null) kept.add(item.id);
    }
  }
  return kept;
}

export function applySharedBranchAdjacency<T>(
  items: readonly T[],
  getClusterKey: (item: T) => string | null,
): { item: T; clusterKey: string | null }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getClusterKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const clustered = new Set(
    [...counts.entries()].filter(([, count]) => count >= 2).map(([key]) => key),
  );
  const remaining = [...items];
  const result: { item: T; clusterKey: string | null }[] = [];
  while (remaining.length > 0) {
    const item = remaining.shift();
    if (item === undefined) break;
    const key = getClusterKey(item);
    const clusterKey = key && clustered.has(key) ? key : null;
    result.push({ item, clusterKey });
    if (!clusterKey) continue;
    for (let index = 0; index < remaining.length; ) {
      const candidate = remaining[index];
      if (candidate !== undefined && getClusterKey(candidate) === clusterKey) {
        remaining.splice(index, 1);
        result.push({ item: candidate, clusterKey });
      } else {
        index += 1;
      }
    }
  }
  return result;
}

export function consecutiveSharedBranchRuns<T extends { clusterKey: string | null }>(
  items: readonly T[],
): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (item.clusterKey && last?.[0]?.clusterKey === item.clusterKey) {
      last.push(item);
    } else {
      runs.push([item]);
    }
  }
  return runs;
}

/**
 * GitHub-stack adjacency for the Work by-lane list.
 *
 * Lanes whose primary PR sits in the same GitHub stack are pulled together at
 * the slot of the first one, top layer first (3/3, 2/3, 1/3), so the stack
 * reads as one chain instead of being torn apart by recency. A stack needs two
 * visible members to count; the rest of the list keeps its order.
 */
export type LaneStackPlacement = { key: string; position: number };

export function applyStackAdjacency<T>(
  items: readonly T[],
  getStack: (item: T) => LaneStackPlacement | null,
): { item: T; stackKey: string | null }[] {
  const placements = items.map((item) => getStack(item));
  const members = new Map<string, number[]>();
  placements.forEach((placement, index) => {
    if (!placement) return;
    const list = members.get(placement.key) ?? [];
    list.push(index);
    members.set(placement.key, list);
  });
  const result: { item: T; stackKey: string | null }[] = [];
  const emitted = new Set<string>();
  items.forEach((item, index) => {
    const placement = placements[index] ?? null;
    const group = placement ? members.get(placement.key) : undefined;
    if (!placement || !group || group.length < 2) {
      result.push({ item, stackKey: null });
      return;
    }
    if (emitted.has(placement.key)) return;
    emitted.add(placement.key);
    const ordered = [...group].sort(
      (a, b) => (placements[b]?.position ?? 0) - (placements[a]?.position ?? 0) || a - b,
    );
    for (const memberIndex of ordered) {
      const member = items[memberIndex];
      if (member !== undefined) result.push({ item: member, stackKey: placement.key });
    }
  });
  return result;
}
