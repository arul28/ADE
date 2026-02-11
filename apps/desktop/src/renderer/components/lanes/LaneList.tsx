import React from "react";
import { useAppStore } from "../../state/appStore";
import { LaneRow } from "./LaneRow";
import { PaneHeader } from "../ui/PaneHeader";

export function LaneList() {
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title="Lanes" meta={`${lanes.length}`} />
      <div className="flex-1 overflow-auto p-2">
        <div className="space-y-2">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              selected={lane.id === selectedLaneId}
              onSelect={() => selectLane(lane.id)}
            />
          ))}
        </div>
        <div className="mt-3 rounded-lg border border-border bg-card/60 p-3 text-xs text-muted-fg">
          Stack graph (placeholder)
        </div>
      </div>
    </div>
  );
}
