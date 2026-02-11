import React from "react";
import { EmptyState } from "../ui/EmptyState";
import { useAppStore } from "../../state/appStore";
import { PaneHeader } from "../ui/PaneHeader";

export function LaneDetail() {
  const laneId = useAppStore((s) => s.selectedLaneId);
  return (
    <div className="flex h-full flex-col">
      <PaneHeader title="Changes" meta={laneId ?? "no lane selected"} />
      <div className="flex-1 overflow-auto p-3">
        <EmptyState
          title="Diff viewer (stub)"
          description="Phase 1 adds Monaco diff + file tree + quick edit. For Phase -1, this is a placeholder."
        />
      </div>
    </div>
  );
}
