import type { LaneSummary } from "../../../../shared/types";

export function branchNameFromRef(ref?: string | null): string {
  const trimmed = (ref ?? "").trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  if (trimmed.startsWith("refs/remotes/")) {
    const remoteRef = trimmed.slice("refs/remotes/".length);
    const slashIndex = remoteRef.indexOf("/");
    return slashIndex >= 0 ? remoteRef.slice(slashIndex + 1) : remoteRef;
  }
  if (trimmed.startsWith("origin/")) return trimmed.slice("origin/".length);
  return trimmed;
}

export function resolveLaneBaseBranch(args: {
  lane: LaneSummary | null;
  lanes: LaneSummary[];
  primaryBranchRef?: string | null;
}): string {
  if (!args.lane) return branchNameFromRef(args.primaryBranchRef ?? "main");
  if (args.lane.parentLaneId) {
    const parent = args.lanes.find((entry) => entry.id === args.lane?.parentLaneId) ?? null;
    if (parent?.branchRef) return branchNameFromRef(parent.branchRef);
  }
  return branchNameFromRef(args.lane.baseRef || args.primaryBranchRef || "main");
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
