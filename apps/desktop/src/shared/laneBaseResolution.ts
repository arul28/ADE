import type { LaneType } from "./types";

type LaneLike = {
  baseRef?: string | null;
  parentLaneId?: string | null;
};

type ParentLike = {
  laneType?: LaneType | null;
  branchRef?: string | null;
} | null;

export function branchNameFromLaneRef(ref?: string | null): string {
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

export function shouldLaneTrackParent(args: {
  lane: LaneLike | null | undefined;
  parent: ParentLike;
}): boolean {
  const lane = args.lane ?? null;
  const parent = args.parent ?? null;
  if (!lane?.parentLaneId || !parent) return false;

  const parentBranch = branchNameFromLaneRef(parent.branchRef);
  if (!parentBranch) return false;

  return parent.laneType !== "primary";
}

export function resolveStableLaneBaseBranch(args: {
  lane: LaneLike | null | undefined;
  parent?: ParentLike;
  primaryBranchRef?: string | null;
}): string {
  const lane = args.lane ?? null;
  const parent = args.parent ?? null;
  if (shouldLaneTrackParent({ lane, parent })) {
    return branchNameFromLaneRef(parent?.branchRef);
  }

  const baseBranch = branchNameFromLaneRef(lane?.baseRef);
  if (baseBranch) return baseBranch;
  return branchNameFromLaneRef(args.primaryBranchRef ?? "main");
}
