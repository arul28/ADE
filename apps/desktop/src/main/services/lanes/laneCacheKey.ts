import type { LaneSummary } from "../../../shared/types";

export type LaneCacheKeySource = Pick<
  LaneSummary,
  "id" | "parentLaneId" | "branchRef" | "baseRef" | "worktreePath" | "archivedAt"
>;

export function serializeLaneCacheKeyFields(lane: LaneCacheKeySource) {
  return {
    id: lane.id,
    parentLaneId: lane.parentLaneId,
    branchRef: lane.branchRef,
    baseRef: lane.baseRef,
    worktreePath: lane.worktreePath,
    archivedAt: lane.archivedAt,
  };
}
