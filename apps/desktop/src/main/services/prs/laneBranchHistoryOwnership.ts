import type { LaneSummary } from "../../../shared/types";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import { normalizeBranchName } from "../shared/utils";

/**
 * Which lane owns a PR whose head is a branch from a lane's branch history
 * (see `lanes/laneBranchHistory.ts`). Pure rules; the PR service does the
 * GitHub reads and the linking.
 */

/** branch → ids of the active lanes whose worktree has used it. */
export type LaneBranchHistoryIndex = Map<string, Set<string>>;

const laneBranchKey = (ref: string): string => normalizeBranchName(branchNameFromLaneRef(ref));

export function buildLaneBranchHistoryIndex(
  entries: ReadonlyArray<{ laneId: string; branchRef: string }>,
): LaneBranchHistoryIndex {
  const index: LaneBranchHistoryIndex = new Map();
  for (const entry of entries) {
    const branch = laneBranchKey(entry.branchRef);
    if (!branch) continue;
    const laneIds = index.get(branch) ?? new Set<string>();
    laneIds.add(entry.laneId);
    index.set(branch, laneIds);
  }
  return index;
}

/**
 * The one lane whose worktree used `headBranch` without recording it as its
 * branch — the follow-up branch an agent cut inside its lane. `null` when a
 * lane records the branch (the strict branch match owns that case), when no
 * lane or more than one lane used it, or when the lane is primary or archived.
 */
export function resolveLaneBranchHistoryOwner(
  headBranch: string,
  lanes: readonly LaneSummary[],
  history: LaneBranchHistoryIndex,
): LaneSummary | null {
  if (lanes.some((lane) => !lane.archivedAt && laneBranchKey(lane.branchRef) === headBranch)) return null;
  const laneIds = history.get(headBranch);
  if (!laneIds || laneIds.size !== 1) return null;
  const [laneId] = laneIds;
  const lane = lanes.find((entry) => entry.id === laneId) ?? null;
  if (!lane || lane.archivedAt || lane.laneType === "primary") return null;
  return lane;
}

// A reused branch name can carry PRs from long before this lane existed. Only
// a PR opened while the lane was alive is its work. Five minutes of slack
// covers clock skew between this machine and GitHub.
const CREATED_SKEW_MS = 5 * 60_000;

export function prOpenedDuringLane(createdAt: string | null, lane: Pick<LaneSummary, "createdAt">): boolean {
  const prMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const laneMs = Date.parse(lane.createdAt);
  if (!Number.isFinite(prMs) || !Number.isFinite(laneMs)) return false;
  return prMs >= laneMs - CREATED_SKEW_MS;
}

/** One PR per branch, as the strict match keeps one per lane: the open one, else the newest. */
export function pickLaneBranchHistoryPr<T extends { prNumber: number; isOpen: boolean }>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (
      !best
      || (candidate.isOpen && !best.isOpen)
      || (candidate.isOpen === best.isOpen && candidate.prNumber > best.prNumber)
    ) {
      best = candidate;
    }
  }
  return best;
}
