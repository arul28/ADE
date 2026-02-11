import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { X } from "lucide-react";
import { useDockLayout } from "../ui/DockLayoutState";
import { SplitPane, SplitPanePanel, SplitPaneSeparator } from "../ui/SplitPane";
import { LaneDetail } from "./LaneDetail";
import { LaneInspector } from "./LaneInspector";
import { LaneList } from "./LaneList";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

const FALLBACK_LAYOUT = { left: 24, center: 76 } as const;

export function LanesPage() {
  const { layout, loaded, saveLayout } = useDockLayout("lanes.cockpit", FALLBACK_LAYOUT);
  const [params] = useSearchParams();
  const selectLane = useAppStore((s) => s.selectLane);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const focusSession = useAppStore((s) => s.focusSession);
  const lanes = useAppStore((s) => s.lanes);
  const [activeLaneIds, setActiveLaneIds] = useState<string[]>([]);

  const lanesById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);

  useEffect(() => {
    const laneId = params.get("laneId");
    const sessionId = params.get("sessionId");
    if (laneId) selectLane(laneId);
    if (sessionId) focusSession(sessionId);
  }, [params, selectLane, focusSession]);

  useEffect(() => {
    setActiveLaneIds((prev) => {
      const valid = prev.filter((id) => lanesById.has(id));
      if (selectedLaneId && lanesById.has(selectedLaneId)) {
        if (valid.includes(selectedLaneId)) return valid;
        return [selectedLaneId, ...valid];
      }
      if (valid.length > 0) return valid;
      return lanes[0]?.id ? [lanes[0].id] : [];
    });
  }, [selectedLaneId, lanes, lanesById]);

  const handleLaneSelect = (laneId: string, args: { extend: boolean }) => {
    if (!args.extend) {
      setActiveLaneIds([laneId]);
      selectLane(laneId);
      return;
    }

    const isActive = activeLaneIds.includes(laneId);
    const next = isActive ? activeLaneIds.filter((id) => id !== laneId) : [...activeLaneIds, laneId];
    const normalized = next.length > 0 ? next : [laneId];
    setActiveLaneIds(normalized);
    const nextPrimary = normalized.includes(laneId) ? laneId : normalized[0] ?? null;
    selectLane(nextPrimary);
  };

  const removeSplitLane = (laneId: string) => {
    const next = activeLaneIds.filter((id) => id !== laneId);
    const normalized = next.length > 0 ? next : selectedLaneId ? [selectedLaneId] : [];
    setActiveLaneIds(normalized);
    if (!normalized.includes(selectedLaneId ?? "")) {
      selectLane(normalized[0] ?? null);
    }
  };

  if (!loaded) return null;

  const visibleLaneIds = activeLaneIds.filter((id) => lanesById.has(id));

  return (
    <div className="h-full min-w-0 bg-bg">
      <SplitPane id="lanes.cockpit" defaultLayout={layout} onLayoutChanged={saveLayout}>
        <SplitPanePanel id="left" minSize="18%" defaultSize="24%" className="h-full flex flex-col min-w-0">
          <LaneList selectedLaneIds={visibleLaneIds} primaryLaneId={selectedLaneId} onLaneSelect={handleLaneSelect} />
        </SplitPanePanel>

        <SplitPaneSeparator className="w-px bg-border hover:bg-accent hover:w-1 transition-all z-10" />

        <SplitPanePanel id="center" minSize="48%" defaultSize="76%" className="h-full flex flex-col min-w-0 bg-bg">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            {visibleLaneIds.map((laneId) => {
              const lane = lanesById.get(laneId);
              const isPrimary = laneId === selectedLaneId;
              const closable = visibleLaneIds.length > 1;
              return (
                <div
                  key={laneId}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "inline-flex max-w-[220px] items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                    isPrimary
                      ? "border-accent bg-accent/10 text-fg"
                      : "border-border bg-card/70 text-muted-fg hover:text-fg hover:border-muted-fg"
                  )}
                  onClick={(event) => handleLaneSelect(laneId, { extend: event.shiftKey })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleLaneSelect(laneId, { extend: event.shiftKey });
                    }
                  }}
                  title="Shift-click to add/remove this lane from split view"
                >
                  <span className="truncate">{lane?.name ?? laneId}</span>
                  {closable ? (
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted/60"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeSplitLane(laneId);
                      }}
                      title="Close split lane"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <div className="ml-auto text-[11px] text-muted-fg">Shift-click lanes to split</div>
          </div>

          {visibleLaneIds.length === 0 ? (
            <div className="flex-1 min-h-0">
              <EmptyState title="No lane selected" description="Pick a lane to view changes and terminals." />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto">
              <div className="flex h-full min-w-full">
                {visibleLaneIds.map((laneId, index) => (
                  <div
                    key={laneId}
                    className={cn(
                      "min-w-[560px] flex-1 border-r border-border",
                      index === visibleLaneIds.length - 1 && "border-r-0"
                    )}
                  >
                    <Group id={`lane-stack:${laneId}`} orientation="vertical" className="h-full w-full">
                      <Panel id={`lane-changes:${laneId}`} minSize={30} defaultSize={66}>
                        <LaneDetail overrideLaneId={laneId} isPrimary={laneId === selectedLaneId} />
                      </Panel>
                      <Separator className="h-px bg-border transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent" />
                      <Panel id={`lane-inspector:${laneId}`} minSize={20} defaultSize={34}>
                        <LaneInspector overrideLaneId={laneId} hideHeader />
                      </Panel>
                    </Group>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SplitPanePanel>
      </SplitPane>
    </div>
  );
}
