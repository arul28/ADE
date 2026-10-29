import type { LaneSummary, PrSummary } from "../../../../shared/types";
import { branchNameFromLaneRef } from "../../../../shared/laneBaseResolution";

export function branchNameFromRef(ref?: string | null): string {
  return branchNameFromLaneRef(ref);
}

/**
 * The branch a lane is compared to and its PR targets by default: its open
 * PR's base branch when it has one, else the lane's base (the project's
 * default branch), the same rule GitHub uses.
 */
export function resolveLaneBaseBranch(args: {
  lane: LaneSummary | null;
  primaryBranchRef?: string | null;
  pullRequests?: readonly PrSummary[] | null;
}): string {
  const fallback = branchNameFromRef(args.primaryBranchRef ?? "main") || "main";
  if (!args.lane) return fallback;
  const laneId = args.lane.id;
  const openPr = args.pullRequests?.find(
    (pr) => pr.laneId === laneId && (pr.state === "open" || pr.state === "draft") && Boolean(pr.baseBranch),
  );
  return branchNameFromRef(openPr?.baseBranch) || branchNameFromRef(args.lane.baseRef) || fallback;
}

export function describePrTargetDiff(args: {
  lane: LaneSummary | null;
  targetBranch?: string | null;
  primaryBranchRef?: string | null;
  pullRequests?: readonly PrSummary[] | null;
}): string | null {
  if (!args.lane) return null;
  const targetBranch = branchNameFromRef(args.targetBranch);
  if (!targetBranch) return null;
  const laneBaseBranch = resolveLaneBaseBranch({
    lane: args.lane,
    primaryBranchRef: args.primaryBranchRef,
    pullRequests: args.pullRequests,
  });
  if (!laneBaseBranch || laneBaseBranch === targetBranch) return null;
  return `targets ${targetBranch}, but this lane is compared to ${laneBaseBranch}. The PR will include every commit on this lane that ${targetBranch} does not have.`;
}
