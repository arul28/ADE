import React, { useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { LaneRow } from "./LaneRow";
import { PaneHeader } from "../ui/PaneHeader";
import { Button } from "../ui/Button";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";

export function LaneList({
  selectedLaneIds,
  primaryLaneId,
  onLaneSelect,
  filterQuery,
  onFilterQueryChange
}: {
  selectedLaneIds?: string[];
  primaryLaneId?: string | null;
  onLaneSelect?: (laneId: string, args: { extend: boolean }) => void;
  filterQuery?: string;
  onFilterQueryChange?: (value: string) => void;
} = {}) {
  const lanes = useAppStore((s) => s.lanes);
  const storeSelectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [localFilter, setLocalFilter] = useState("");

  const activeIds = selectedLaneIds ?? (storeSelectedLaneId ? [storeSelectedLaneId] : []);
  const selectedIdSet = new Set(activeIds);
  const effectivePrimaryId = primaryLaneId ?? storeSelectedLaneId;
  const effectiveFilter = filterQuery ?? localFilter;

  const visibleLanes = useMemo(() => {
    const needle = effectiveFilter.trim().toLowerCase();
    if (!needle) return lanes;
    return lanes.filter((lane) => {
      const name = lane.name.toLowerCase();
      const branch = lane.branchRef.toLowerCase();
      const type = lane.laneType.toLowerCase();
      return name.includes(needle) || branch.includes(needle) || type.includes(needle);
    });
  }, [lanes, effectiveFilter]);

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
        <div className="mb-2">
          <input
            id="lanes-filter-input"
            value={effectiveFilter}
            onChange={(event) => {
              const next = event.target.value;
              if (onFilterQueryChange) onFilterQueryChange(next);
              else setLocalFilter(next);
            }}
            placeholder="Filter lanes…"
            className="h-8 w-full rounded border border-border bg-card/70 px-2 text-xs outline-none placeholder:text-muted-fg"
          />
        </div>
        {visibleLanes.length === 0 ? (
          <EmptyState
            title={lanes.length === 0 ? "No lanes yet" : "No lanes match"}
            description={
              lanes.length === 0
                ? "Create a lane from the top bar. Lanes are real git worktrees."
                : "Adjust the lane filter or create a new lane."
            }
          />
        ) : (
          <div className="space-y-2">
            {visibleLanes.map((lane) => (
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
