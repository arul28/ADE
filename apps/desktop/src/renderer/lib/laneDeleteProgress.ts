import type { LaneDeleteProgress } from "../../shared/types";

export function createPendingLaneDeleteProgress(laneId: string): LaneDeleteProgress {
  return {
    laneId,
    steps: [],
    startedAt: new Date().toISOString(),
    overallStatus: "running",
    cancellable: false,
  };
}

export function isLaneDeleteProgressActive(
  progress: LaneDeleteProgress | null | undefined,
): boolean {
  return progress?.overallStatus === "running";
}

export function getLaneDeleteStatusLabel(
  progress: LaneDeleteProgress | null | undefined,
): string {
  if (progress?.overallStatus === "completed_with_warnings") return "Deleted with warnings";
  return progress?.overallStatus === "completed" ? "Deleted" : "Deleting";
}
