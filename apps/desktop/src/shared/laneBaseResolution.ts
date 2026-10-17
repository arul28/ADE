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

type LaneBaseBranchLike = {
  laneType?: LaneType | string | null;
  branchRef?: string | null;
  baseRef?: string | null;
};

/**
 * True for a primary lane checked out on its own base branch.
 *
 * One definition for every surface that answers "does this lane name a pull
 * request": the renderer's lane selectors, the host's single-PR display
 * selector and `getForLane` bridge, and the CLI's lane-link envelope. The
 * Primary lane cannot be deleted, so a chat-linked merged PR would otherwise
 * stay pinned to `main` forever.
 *
 * Callers pass the branch they mean. Lane surfaces pass the live checkout
 * (`effectiveLanePrBranchRef`) because that is the branch whose PRs they show;
 * the host and CLI pass the recorded `branch_ref` because they have no lane
 * status. The primary lane's record is re-synced to its live HEAD on every lane
 * list (`syncPrimaryLaneBranchRef`), so the two agree outside a transient
 * window.
 */
export function laneIsOnBaseBranch(lane: LaneBaseBranchLike): boolean {
  if (lane.laneType !== "primary") return false;
  const laneBranch = branchNameFromLaneRef(lane.branchRef);
  const baseBranch = branchNameFromLaneRef(lane.baseRef);
  return Boolean(laneBranch && baseBranch && laneBranch === baseBranch);
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
