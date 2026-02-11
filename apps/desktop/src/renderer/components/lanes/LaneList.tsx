import React from "react";
import { useAppStore } from "../../state/appStore";
import { LaneRow } from "./LaneRow";
import { PaneHeader } from "../ui/PaneHeader";
import { Button } from "../ui/Button";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";

export function LaneList({
  selectedLaneIds,
  primaryLaneId,
  onLaneSelect
}: {
  selectedLaneIds?: string[];
  primaryLaneId?: string | null;
  onLaneSelect?: (laneId: string, args: { extend: boolean }) => void;
} = {}) {
  const lanes = useAppStore((s) => s.lanes);
  const storeSelectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const activeIds = selectedLaneIds ?? (storeSelectedLaneId ? [storeSelectedLaneId] : []);
  const selectedIdSet = new Set(activeIds);
  const effectivePrimaryId = primaryLaneId ?? storeSelectedLaneId;

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title="Lanes"
        meta={`${lanes.length}`}
        right={
          <Button
            variant="ghost"
            size="sm"
            title="Refresh lanes"
            onClick={() => {
              refreshLanes().catch(() => {
                // ignore
              });
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-2">
        {lanes.length === 0 ? (
          <EmptyState
            title="No lanes yet"
            description="Create a lane from the top bar. Lanes are real git worktrees."
          />
        ) : (
          <div className="space-y-2">
            {lanes.map((lane) => (
              <LaneRow
                key={lane.id}
                lane={lane}
                selected={selectedIdSet.has(lane.id)}
                primary={lane.id === effectivePrimaryId}
                onSelect={(args) => {
                  if (onLaneSelect) {
                    onLaneSelect(lane.id, args);
                    return;
                  }
                  selectLane(lane.id);
                }}
              />
            ))}
          </div>
        )}
        <div className="mt-3 rounded-lg border border-border bg-card/60 p-3 text-xs text-muted-fg">
          Stack graph (placeholder)
        </div>
      </div>
    </div>
  );
}
