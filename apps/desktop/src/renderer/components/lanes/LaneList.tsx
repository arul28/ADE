import React, { useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { LaneRow } from "./LaneRow";
import { PaneHeader } from "../ui/PaneHeader";
import { Button } from "../ui/Button";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import type { LaneSummary } from "../../../shared/types";

function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const childrenByParent = new Map<string, LaneSummary[]>();
  const roots: LaneSummary[] = [];

  for (const lane of lanes) {
    if (!lane.parentLaneId || !laneById.has(lane.parentLaneId)) {
      roots.push(lane);
      continue;
    }
    const children = childrenByParent.get(lane.parentLaneId) ?? [];
    children.push(lane);
    childrenByParent.set(lane.parentLaneId, children);
  }

  const byCreatedAsc = (a: LaneSummary, b: LaneSummary) => {
    const aTs = Date.parse(a.createdAt);
    const bTs = Date.parse(b.createdAt);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  };

  const orderedRoots = [...roots].sort((a, b) => {
    const aPrimary = a.laneType === "primary" ? 1 : 0;
    const bPrimary = b.laneType === "primary" ? 1 : 0;
    if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    return byCreatedAsc(a, b);
  });
  for (const [parentId, children] of childrenByParent.entries()) {
    childrenByParent.set(parentId, [...children].sort(byCreatedAsc));
  }

  const out: LaneSummary[] = [];
  const visit = (lane: LaneSummary) => {
    out.push(lane);
    for (const child of childrenByParent.get(lane.id) ?? []) {
      visit(child);
    }
  };
  for (const root of orderedRoots) {
    visit(root);
  }

  const seen = new Set(out.map((lane) => lane.id));
  const dangling = lanes.filter((lane) => !seen.has(lane.id)).sort(byCreatedAsc);
  return out.concat(dangling);
}

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
  const stackOrderedLanes = useMemo(() => sortLanesForStackGraph(lanes), [lanes]);

  const visibleLanes = useMemo(() => {
    const needle = effectiveFilter.trim().toLowerCase();
    if (!needle) return stackOrderedLanes;
    return stackOrderedLanes.filter((lane) => {
      const name = lane.name.toLowerCase();
      const branch = lane.branchRef.toLowerCase();
      const type = lane.laneType.toLowerCase();
      return name.includes(needle) || branch.includes(needle) || type.includes(needle);
    });
  }, [stackOrderedLanes, effectiveFilter]);

  const isLastSiblingByLaneId = useMemo(() => {
    const siblingsByParent = new Map<string, string[]>();
    for (const lane of visibleLanes) {
      if (!lane.parentLaneId) continue;
      const list = siblingsByParent.get(lane.parentLaneId) ?? [];
      list.push(lane.id);
      siblingsByParent.set(lane.parentLaneId, list);
    }
    const out = new Map<string, boolean>();
    for (const siblingIds of siblingsByParent.values()) {
      siblingIds.forEach((id, index) => {
        out.set(id, index === siblingIds.length - 1);
      });
    }
    return out;
  }, [visibleLanes]);

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
                isLastSibling={isLastSiblingByLaneId.get(lane.id) ?? false}
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
        <div className="mt-3 rounded-lg border border-border bg-card/60 p-2">
          <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-muted-fg">Stack Graph</div>
          <div className="space-y-0.5">
            {visibleLanes.map((lane) => (
              <button
                key={`stack:${lane.id}`}
                type="button"
                className={cn(
                  "relative flex w-full items-center justify-between rounded px-1 py-1 text-left text-[11px] transition-colors",
                  selectedIdSet.has(lane.id) ? "bg-accent/15 text-fg" : "text-muted-fg hover:bg-muted/50 hover:text-fg"
                )}
                onClick={() => {
                  if (onLaneSelect) onLaneSelect(lane.id, { extend: false });
                  else selectLane(lane.id);
                }}
                title={lane.parentLaneId ? "Child lane" : "Stack root"}
              >
                <span className="relative inline-flex items-center gap-1.5 truncate" style={{ paddingLeft: `${2 + lane.stackDepth * 16}px` }}>
                  {lane.parentLaneId ? (
                    <>
                      <span
                        className="pointer-events-none absolute w-px bg-border/50"
                        style={
                          isLastSiblingByLaneId.get(lane.id)
                            ? { left: `${(lane.stackDepth - 1) * 16 + 8}px`, top: "0px", bottom: "50%" }
                            : { left: `${(lane.stackDepth - 1) * 16 + 8}px`, top: "0px", bottom: "0px" }
                        }
                      />
                      <span
                        className="pointer-events-none absolute h-px bg-border/50"
                        style={{ left: `${lane.stackDepth * 16 - 8}px`, width: "8px" }}
                      />
                    </>
                  ) : null}
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      lane.laneType === "primary" ? "bg-emerald-500" : lane.status.dirty ? "bg-amber-500" : "bg-sky-500"
                    )}
                  />
                  <span className="truncate">{lane.name}</span>
                </span>
                <span className="ml-2 shrink-0 font-mono text-[10px]">
                  {lane.status.ahead}↑ {lane.status.behind}↓
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
