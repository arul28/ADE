import React from "react";
import { AlertTriangle, GitBranch } from "lucide-react";
import { useAppStore } from "../../../state/appStore";
import { useConflictsState, useConflictsDispatch } from "../state/ConflictsContext";
import { fetchOverlaps, fetchGitConflictState } from "../state/conflictsActions";
import { MergeHeading } from "../shared/MergeHeading";
import { ConflictSummary } from "../ConflictSummary";
import { MergeSimulationPanel } from "../MergeSimulationPanel";
import { RiskMatrix } from "../RiskMatrix";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import type { ConflictStatus, RiskMatrixEntry } from "../../../../shared/types";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function ConflictDetailPane() {
  const lanes = useAppStore((s) => s.lanes);
  const dispatch = useConflictsDispatch();
  const {
    batch,
    selectedLaneId,
    selectedPair,
    overlaps,
    viewMode,
    gitConflict,
    gitConflictBusy,
    loading,
    progress,
    error,
    proposalPeerLaneId,
  } = useConflictsState();

  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);
  const selectedLane = React.useMemo(() => lanes.find((l) => l.id === selectedLaneId) ?? null, [lanes, selectedLaneId]);

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus>();
    for (const s of batch?.lanes ?? []) map.set(s.laneId, s);
    return map;
  }, [batch]);

  const matrixByPair = React.useMemo(() => {
    const map = new Map<string, RiskMatrixEntry>();
    for (const entry of batch?.matrix ?? []) map.set(pairKey(entry.laneAId, entry.laneBId), entry);
    return map;
  }, [batch]);

  const selectedStatus = selectedLaneId ? statusByLane.get(selectedLaneId) ?? null : null;

  // Source = selected lane, target from shared context
  const sourceLaneId = selectedLaneId;
  const targetLaneId = proposalPeerLaneId ?? selectedLane?.parentLaneId ?? primaryLane?.id ?? null;

  // Sync target into context when selected lane changes
  React.useEffect(() => {
    const newTarget = selectedLane?.parentLaneId ?? primaryLane?.id ?? null;
    dispatch({ type: "SET_PROPOSAL_PEER_LANE_ID", laneId: newTarget });
  }, [selectedLane, primaryLane, dispatch]);

  // Load overlaps and git state when lane changes
  React.useEffect(() => {
    if (!selectedLaneId) return;
    fetchOverlaps(dispatch, selectedLaneId);
    fetchGitConflictState(dispatch, selectedLaneId);
  }, [selectedLaneId, dispatch]);

  if (!selectedLane) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center text-sm text-muted-fg">
          <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-muted-fg/50" />
          Select a lane to inspect conflicts
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3 space-y-4">
      {/* Merge heading: "Merge X into Y" */}
      <MergeHeading
        lanes={lanes}
        sourceLaneId={sourceLaneId}
        targetLaneId={targetLaneId}
        onSourceChange={(id) => dispatch({ type: "SET_SELECTED_LANE", laneId: id })}
        onTargetChange={(id) => dispatch({ type: "SET_PROPOSAL_PEER_LANE_ID", laneId: id })}
      />

      {/* Lane info card */}
      <div className="rounded-xl shadow-card bg-card/30 p-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-accent" />
          <span className="truncate text-sm font-semibold text-fg">{selectedLane.name}</span>
          {selectedLane.laneType === "primary" && (
            <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] text-muted-fg ring-1 ring-inset ring-muted-fg/20">
              (edit-protected)
            </span>
          )}
        </div>
        <div className="mt-2 rounded-lg bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-fg">
          <span className="text-muted-fg/60">branch</span>{" "}
          <span className="text-fg">{selectedLane.branchRef}</span>
          <span className="mx-2 text-muted-fg/30">|</span>
          <span className="text-muted-fg/60">base</span>{" "}
          <span className="text-fg/80">{selectedLane.baseRef}</span>
        </div>
      </div>

      {/* Progress indicator */}
      {loading && progress && (
        <div className="rounded-lg bg-muted/20 p-2 text-xs text-muted-fg">
          Analyzing... {progress.completedPairs}/{progress.totalPairs} pairs
        </div>
      )}

      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* View mode toggle */}
      <div className="flex rounded-lg border border-border/50 text-[10px] font-medium">
        {(["summary", "matrix"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => dispatch({ type: "SET_VIEW_MODE", mode })}
            className={cn(
              "flex-1 px-3 py-1.5 transition-colors first:rounded-l-lg last:rounded-r-lg",
              viewMode === mode ? "bg-accent/15 text-accent" : "text-muted-fg hover:text-fg"
            )}
          >
            {mode === "summary" ? "Summary" : "Risk Matrix"}
          </button>
        ))}
      </div>

      {viewMode === "summary" ? (
        <>
          {/* Conflict Summary */}
          <ConflictSummary lane={selectedLane} status={selectedStatus} overlaps={overlaps} />

          {/* Git conflict state */}
          {gitConflict?.inProgress && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-red-600">
                <AlertTriangle className="h-4 w-4" />
                Active {gitConflict.kind} in progress
              </div>
              {gitConflict.conflictedFiles.length > 0 && (
                <div className="mt-2 text-xs text-muted-fg">
                  {gitConflict.conflictedFiles.length} conflicted file(s)
                </div>
              )}
            </div>
          )}

          {/* Merge simulation (auto-run when both lanes selected) */}
          {sourceLaneId && targetLaneId && (
            <MergeSimulationPanel
              lanes={lanes}
              initialLaneAId={sourceLaneId}
              initialLaneBId={targetLaneId}
            />
          )}
        </>
      ) : (
        /* Risk Matrix view */
        <RiskMatrix
          lanes={lanes}
          entries={batch?.matrix ?? []}
          overlaps={batch?.overlaps ?? []}
          selectedPair={selectedPair}
          loading={loading}
          progress={progress}
          onSelectPair={(pair) => dispatch({ type: "SET_SELECTED_PAIR", pair })}
        />
      )}
    </div>
  );
}
