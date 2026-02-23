import React from "react";
import { ArrowDown, ArrowUp, Check, Circle, SpinnerGap, X } from "@phosphor-icons/react";
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

  const [execBusy, setExecBusy] = React.useState(false);
  const [execError, setExecError] = React.useState<string | null>(null);
  const [execResult, setExecResult] = React.useState<string | null>(null);

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

  const executeStackedPrs = async () => {
    const targetBranch = (() => {
      const targetLane = lanes.find((l) => l.id === multiMergeTargetLaneId);
      if (targetLane) {
        const ref = targetLane.branchRef.trim();
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
      return primaryLane?.branchRef ?? "main";
    })();
    setExecBusy(true);
    setExecError(null);
    setExecResult(null);
    try {
      const result = await window.ade.prs.createStacked({
        laneIds: multiMergeSourceLaneIds,
        targetBranch,
        draft: false,
      });
      if (result.errors.length > 0) {
        setExecError(result.errors.map((e) => `${e.laneId}: ${e.error}`).join("\n"));
      }
      setExecResult(`Created ${result.prs.length} stacked PR(s)`);
    } catch (err: any) {
      setExecError(err?.message ?? String(err));
    } finally {
      setExecBusy(false);
    }
  };

  const executeIntegrationMerge = async () => {
    const baseBranch = (() => {
      const targetLane = lanes.find((l) => l.id === multiMergeTargetLaneId);
      if (targetLane) {
        const ref = targetLane.branchRef.trim();
        return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
      return primaryLane?.branchRef ?? "main";
    })();
    const name = multiMergeIntegrationName.trim();
    if (!name) return;

    setExecBusy(true);
    setExecError(null);
    setExecResult(null);
    try {
      const result = await window.ade.prs.createIntegration({
        sourceLaneIds: multiMergeSourceLaneIds,
        integrationLaneName: name,
        baseBranch,
        title: `Integration: ${name}`,
        draft: false,
      });
      const failedMerges = result.mergeResults.filter((r) => !r.success);
      if (failedMerges.length > 0) {
        setExecError(failedMerges.map((r) => `${r.laneId}: ${r.error ?? "failed"}`).join("\n"));
      }
      dispatch({ type: "SET_INTEGRATION_LANE_ID", laneId: result.integrationLaneId });
      setExecResult(`Created integration PR #${result.pr.githubPrNumber}`);
    } catch (err: any) {
      setExecError(err?.message ?? String(err));
    } finally {
      setExecBusy(false);
    }
  };

  // Per-pair conflict risk from batch matrix data
  const pairConflictRisk = React.useMemo(() => {
    const map = new Map<string, string>();
    if (!batch?.matrix) return map;
    for (const entry of batch.matrix) {
      const key = pairKey(entry.laneAId, entry.laneBId);
      map.set(key, entry.riskLevel ?? "none");
    }
    return map;
  }, [batch]);

  return (
    <div className="h-full overflow-auto p-4 space-y-5">
      {/* Mode selector */}
      <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-1">
        <div className="flex text-xs font-medium">
          {(["stacked", "integration"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => dispatch({ type: "SET_MULTI_MERGE_MODE", mode })}
              className={cn(
                "flex-1 px-3 py-2 rounded-md transition-all duration-150",
                multiMergeMode === mode
                  ? "bg-accent text-accent-fg shadow-sm"
                  : "text-muted-fg hover:text-fg hover:bg-muted/40"
              )}
            >
              {mode === "stacked" ? "Stacked Merge" : "Integration Merge"}
            </button>
          ))}
        </div>
      </div>

      {/* Target lane */}
      <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
        <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Target Lane</div>
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
        <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
          <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Integration Lane Name</div>
          <input
            type="text"
            value={multiMergeIntegrationName}
            onChange={(e) => dispatch({ type: "SET_MULTI_MERGE_INTEGRATION_NAME", name: e.target.value })}
            className="w-full rounded-lg border border-border/15 bg-surface-recessed px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            placeholder="integration"
          />
        </div>
      )}

      {/* Source lane selection */}
      <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
        <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">
          Source Lanes
          <span className="ml-2 text-fg font-semibold normal-case tracking-normal">{multiMergeSourceLaneIds.length} selected</span>
        </div>
        <div className="max-h-44 overflow-y-auto rounded-lg border border-border/10 bg-card/30 p-1.5 space-y-1">
          {availableSources.map((lane) => {
            const checked = multiMergeSourceLaneIds.includes(lane.id);
            const status = statusByLane.get(lane.id);
            const riskDot = status?.status === "conflict-active" || status?.status === "conflict-predicted" ? "bg-red-400" : status?.status === "behind-base" ? "bg-amber-400" : status?.status === "merge-ready" ? "bg-emerald-400" : "bg-neutral-400";
            return (
              <label
                key={lane.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs cursor-pointer transition-all duration-150 border border-transparent",
                  checked
                    ? "bg-accent/10 border-accent/15 shadow-[0_0_10px_-3px_rgba(6,214,160,0.15)]"
                    : "hover:bg-card/50 hover:border-border/10 hover:shadow-card"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSource(lane.id)}
                  className="rounded border-border accent-accent"
                />
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", riskDot)} />
                <span className="truncate font-medium text-fg">{lane.name}</span>
                <span className="ml-auto text-[11px] text-muted-fg/60 capitalize">
                  {status?.status ?? "unknown"}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Per-pair conflict indicators */}
      {multiMergeSourceLaneIds.length > 1 && (
        <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
          <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Pair Conflict Risk</div>
          <div className="space-y-1">
            {multiMergeSourceLaneIds.map((idA, i) =>
              multiMergeSourceLaneIds.slice(i + 1).map((idB) => {
                const risk = pairConflictRisk.get(pairKey(idA, idB)) ?? "unknown";
                const laneA = lanes.find((l) => l.id === idA);
                const laneB = lanes.find((l) => l.id === idB);
                const dotColor = risk === "high" ? "bg-red-400" : risk === "medium" ? "bg-amber-400" : risk === "low" ? "bg-emerald-400" : "bg-neutral-400";
                return (
                  <div key={`${idA}::${idB}`} className="flex items-center gap-2 rounded-md border border-border/10 bg-card/30 px-2.5 py-1.5 text-xs">
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor)} />
                    <span className="truncate font-medium text-fg">{laneA?.name ?? idA}</span>
                    <span className="text-muted-fg/40">&harr;</span>
                    <span className="truncate font-medium text-fg">{laneB?.name ?? idB}</span>
                    <span className={cn(
                      "ml-auto text-[11px] font-medium capitalize",
                      risk === "high" ? "text-red-400" : risk === "medium" ? "text-amber-400" : risk === "low" ? "text-emerald-400" : "text-muted-fg/60"
                    )}>{risk}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Merge order (reorderable) */}
      {multiMergeSourceLaneIds.length > 0 && (
        <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5 space-y-2.5">
          <div className="text-xs font-medium tracking-widest uppercase text-muted-fg">Merge Order</div>
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
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-all duration-150",
                    isActive
                      ? "border-accent/20 bg-accent/10 shadow-[0_0_10px_-3px_rgba(6,214,160,0.15)]"
                      : isCompleted
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-border/10 bg-card/30 hover:border-border/15 hover:shadow-card"
                  )}
                >
                  <span className="w-5 text-center text-muted-fg/60 font-mono font-semibold">{idx + 1}</span>
                  {isCompleted ? (
                    <Check size={12} className="text-emerald-400" />
                  ) : isActive ? (
                    <SpinnerGap size={12} className="animate-spin text-accent" />
                  ) : (
                    <Circle size={12} className="text-muted-fg/30" />
                  )}
                  <span className="truncate font-medium text-fg">{lane?.name ?? id}</span>
                  <span className="ml-auto text-[11px] text-muted-fg/60 capitalize">{status?.status ?? ""}</span>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => moveSource(idx, "up")}
                      disabled={idx === 0}
                      className="p-1 rounded text-muted-fg hover:text-fg hover:bg-card/60 disabled:opacity-30 transition-colors"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={() => moveSource(idx, "down")}
                      disabled={idx === multiMergeSourceLaneIds.length - 1}
                      className="p-1 rounded text-muted-fg hover:text-fg hover:bg-card/60 disabled:opacity-30 transition-colors"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      onClick={() => toggleSource(id)}
                      className="p-1 rounded text-muted-fg hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action area */}
      <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm shadow-card p-3.5">
        {multiMergeMode === "stacked" ? (
          <Button
            size="sm"
            variant="primary"
            className="w-full shadow-card font-semibold tracking-wide"
            disabled={multiMergeSourceLaneIds.length === 0 || !multiMergeTargetLaneId || execBusy}
            onClick={() => void executeStackedPrs()}
          >
            {execBusy ? "Creating PRs..." : "Create Stacked PRs"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            className="w-full shadow-card font-semibold tracking-wide"
            disabled={
              multiMergeSourceLaneIds.length === 0 ||
              !multiMergeTargetLaneId ||
              !multiMergeIntegrationName.trim() ||
              execBusy
            }
            onClick={() => void executeIntegrationMerge()}
          >
            {execBusy ? "Creating..." : "Create Integration PR"}
          </Button>
        )}
      </div>

      {/* Error display */}
      {(execError || mergePlanError || integrationError) && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-xs text-red-400 whitespace-pre-wrap">
          {execError || mergePlanError || integrationError}
        </div>
      )}

      {/* Success result */}
      {execResult && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2.5 text-xs text-emerald-400">
          {execResult}
        </div>
      )}
    </div>
  );
}
