import React from "react";
import { LaneTerminalsPanel } from "./LaneTerminalsPanel";

export function LaneWorkPane({
  laneId
}: {
  laneId: string | null;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 p-2">
          <LaneTerminalsPanel overrideLaneId={laneId} />
        </div>
      </div>
    </div>
  );
}
