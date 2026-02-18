import React from "react";
import { GitMerge } from "lucide-react";
import type { LaneSummary } from "../../../../shared/types";
import { LaneDropdown } from "./LaneDropdown";

type MergeHeadingProps = {
  lanes: LaneSummary[];
  sourceLaneId: string | null;
  targetLaneId: string | null;
  onSourceChange: (laneId: string) => void;
  onTargetChange: (laneId: string) => void;
};

export function MergeHeading({
  lanes,
  sourceLaneId,
  targetLaneId,
  onSourceChange,
  onTargetChange
}: MergeHeadingProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
      <span>Merge</span>
      <LaneDropdown
        lanes={lanes}
        value={sourceLaneId}
        onChange={onSourceChange}
        placeholder="Source lane..."
      />
      <GitMerge className="h-5 w-5 text-muted-fg" />
      <span>into</span>
      <LaneDropdown
        lanes={lanes}
        value={targetLaneId}
        onChange={onTargetChange}
        placeholder="Target lane..."
      />
    </div>
  );
}
