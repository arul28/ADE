import type { LaneSummary } from "../../../../shared/types";
import { branchNameFromLaneRef, resolveStableLaneBaseBranch } from "../../../../shared/laneBaseResolution";

export function branchNameFromRef(ref?: string | null): string {
  return branchNameFromLaneRef(ref);
}

export function resolveLaneBaseBranch(args: {
  lane: LaneSummary | null;
  lanes: LaneSummary[];
  primaryBranchRef?: string | null;
}): string {
  if (!args.lane) return branchNameFromRef(args.primaryBranchRef ?? "main");
  const parent = args.lane.parentLaneId
    ? args.lanes.find((entry) => entry.id === args.lane?.parentLaneId) ?? null
    : null;
  return resolveStableLaneBaseBranch({
    lane: args.lane,
    parent,
    primaryBranchRef: args.primaryBranchRef,
  });
}

export function describePrTargetDiff(args: {
  lane: LaneSummary | null;
  lanes: LaneSummary[];
  targetBranch?: string | null;
  primaryBranchRef?: string | null;
}): string | null {
  if (!args.lane) return null;
  const targetBranch = branchNameFromRef(args.targetBranch);
  if (!targetBranch) return null;
  const laneBaseBranch = resolveLaneBaseBranch({
    lane: args.lane,
    lanes: args.lanes,
    primaryBranchRef: args.primaryBranchRef,
  });
  if (!laneBaseBranch || laneBaseBranch === targetBranch) return null;
  return `targets ${targetBranch}, but this lane currently tracks ${laneBaseBranch}. If you want to move the lane onto ${targetBranch}, use rebase or reparent instead of only retargeting the PR.`;
}
