import React from "react";
import { ArrowDown, ArrowUp, Check, Circle, Loader2, X } from "lucide-react";
import { useAppStore } from "../../../state/appStore";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import { LaneDropdown } from "../shared/LaneDropdown";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import type { ConflictStatus, LaneSummary, MultiMergeMode } from "../../../../shared/types";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function MultiMergePreviewPane() {
  const lanes = useAppStore((s) => s.lanes);
  const dispatch = useConflictsDispatch();
  const {
    batch,
    multiMergeMode,
    multiMergeTargetLaneId,
    multiMergeSourceLaneIds,
    multiMergeIntegrationName,
    mergePlan,
    mergePlanBusy,
    mergePlanError,
    integrationBusy,
    integrationError,
    integrationLaneId,
  } = useConflictsState();

  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus>();
    for (const s of batch?.lanes ?? []) map.set(s.laneId, s);
    return map;
  }, [batch]);

  // Available source lanes (not target, not primary if target is primary)
  const availableSources = React.useMemo(() => {
    return lanes.filter((l) => l.id !== multiMergeTargetLaneId);
  }, [lanes, multiMergeTargetLaneId]);

  const toggleSource = (laneId: string) => {
    const current = multiMergeSourceLaneIds;
    const next = current.includes(laneId)
      ? current.filter((id) => id !== laneId)
      : [...current, laneId];
    dispatch({ type: "SET_MULTI_MERGE_SOURCES", laneIds: next });
  };

  const moveSource = (index: number, direction: "up" | "down") => {
    const arr = [...multiMergeSourceLaneIds];
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= arr.length) return;
    [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
    dispatch({ type: "SET_MULTI_MERGE_SOURCES", laneIds: arr });
  };

  const initMergePlan = () => {
    const targetLaneId = multiMergeTargetLaneId ?? primaryLane?.id ?? lanes[0]?.id ?? "";
    dispatch({
      type: "SET_MERGE_PLAN",
      plan: {
        targetLaneId,
        sourceLaneIds: multiMergeSourceLaneIds,
        cursor: 0,
        activeMerge: null,
      },
    });
  };

  const createIntegrationLane = async () => {
    const baseLaneId = multiMergeTargetLaneId ?? primaryLane?.id;
    if (!baseLaneId) return;
    const name = multiMergeIntegrationName.trim();
    if (!name) return;

    dispatch({ type: "SET_INTEGRATION_BUSY", busy: true });
    dispatch({ type: "SET_INTEGRATION_ERROR", error: null });
    try {
      const created = await window.ade.lanes.createChild({
        parentLaneId: baseLaneId,
        name,
        description: "Integration lane created by ADE Conflicts assistant",
      });
      dispatch({ type: "SET_INTEGRATION_LANE_ID", laneId: created.id });
      dispatch({
        type: "SET_MERGE_PLAN",
        plan: {
          targetLaneId: created.id,
          sourceLaneIds: multiMergeSourceLaneIds,
          cursor: 0,
          activeMerge: null,
        },
      });
    } catch (err: any) {
      dispatch({ type: "SET_INTEGRATION_ERROR", error: err?.message ?? String(err) });
    } finally {
      dispatch({ type: "SET_INTEGRATION_BUSY", busy: false });
    }
  };

  return (
    <div className="h-full overflow-auto p-3 space-y-4">
      {/* Mode selector */}
      <div className="flex rounded-lg border border-border/50 text-xs font-medium">
        {(["stacked", "integration"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => dispatch({ type: "SET_MULTI_MERGE_MODE", mode })}
            className={cn(
              "flex-1 px-3 py-2 transition-colors first:rounded-l-lg last:rounded-r-lg",
              multiMergeMode === mode ? "bg-accent/15 text-accent" : "text-muted-fg hover:text-fg"
            )}
          >
            {mode === "stacked" ? "Stacked Merge" : "Integration Merge"}
          </button>
        ))}
      </div>

      {/* Target lane */}
      <div>
        <div className="mb-1 text-xs font-medium text-fg">Target Lane</div>
        <LaneDropdown
          lanes={lanes}
          value={multiMergeTargetLaneId}
          onChange={(id) => dispatch({ type: "SET_MULTI_MERGE_TARGET", laneId: id })}
          placeholder="Select target lane..."
          className="w-full"
        />
      </div>

      {/* Integration lane name (integration mode) */}
      {multiMergeMode === "integration" && (
        <div>
          <div className="mb-1 text-xs font-medium text-fg">Integration Lane Name</div>
          <input
            type="text"
            value={multiMergeIntegrationName}
            onChange={(e) => dispatch({ type: "SET_MULTI_MERGE_INTEGRATION_NAME", name: e.target.value })}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            placeholder="integration"
          />
        </div>
      )}

      {/* Source lane selection */}
      <div>
        <div className="mb-1 text-xs font-medium text-fg">
          Source Lanes ({multiMergeSourceLaneIds.length} selected)
        </div>
        <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-card/50 p-2 space-y-1">
          {availableSources.map((lane) => {
            const checked = multiMergeSourceLaneIds.includes(lane.id);
            const status = statusByLane.get(lane.id);
            return (
              <label
                key={lane.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer transition-colors",
                  checked ? "bg-accent/10" : "hover:bg-muted/30"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSource(lane.id)}
                  className="rounded border-border"
                />
                <span className="truncate font-medium text-fg">{lane.name}</span>
                <span className="ml-auto text-[10px] text-muted-fg">
                  {status?.status ?? "unknown"}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Merge order (reorderable) */}
      {multiMergeSourceLaneIds.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-fg">Merge Order</div>
          <div className="space-y-1">
            {multiMergeSourceLaneIds.map((id, idx) => {
              const lane = lanes.find((l) => l.id === id);
              const status = statusByLane.get(id);
              const planStep = mergePlan?.sourceLaneIds.indexOf(id) ?? -1;
              const isCompleted = mergePlan && planStep >= 0 && planStep < (mergePlan.cursor ?? 0);
              const isActive = mergePlan?.activeMerge?.sourceLaneId === id;
              return (
                <div
                  key={id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs",
                    isActive ? "border-accent bg-accent/10" : isCompleted ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-card/50"
                  )}
                >
                  <span className="w-5 text-center text-muted-fg">{idx + 1}</span>
                  {isCompleted ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : isActive ? (
                    <Loader2 className="h-3 w-3 animate-spin text-accent" />
                  ) : (
                    <Circle className="h-3 w-3 text-muted-fg/40" />
                  )}
                  <span className="truncate font-medium text-fg">{lane?.name ?? id}</span>
                  <span className="ml-auto text-[10px] text-muted-fg">{status?.status ?? ""}</span>
                  <button
                    onClick={() => moveSource(idx, "up")}
                    disabled={idx === 0}
                    className="p-0.5 text-muted-fg hover:text-fg disabled:opacity-30"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => moveSource(idx, "down")}
                    disabled={idx === multiMergeSourceLaneIds.length - 1}
                    className="p-0.5 text-muted-fg hover:text-fg disabled:opacity-30"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => toggleSource(id)}
                    className="p-0.5 text-muted-fg hover:text-red-500"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-2">
        {multiMergeMode === "stacked" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={multiMergeSourceLaneIds.length === 0 || !multiMergeTargetLaneId || mergePlanBusy}
            onClick={initMergePlan}
          >
            {mergePlanBusy ? "Merging..." : "Start Stacked Merge"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={
              multiMergeSourceLaneIds.length === 0 ||
              !multiMergeTargetLaneId ||
              !multiMergeIntegrationName.trim() ||
              integrationBusy
            }
            onClick={() => void createIntegrationLane()}
          >
            {integrationBusy ? "Creating..." : "Create Integration Lane & Merge"}
          </Button>
        )}
      </div>

      {/* Error display */}
      {(mergePlanError || integrationError) && (
        <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
          {mergePlanError || integrationError}
        </div>
      )}

      {/* Integration lane created */}
      {integrationLaneId && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700">
          Integration lane created. Merge plan is active.
        </div>
      )}
    </div>
  );
}
