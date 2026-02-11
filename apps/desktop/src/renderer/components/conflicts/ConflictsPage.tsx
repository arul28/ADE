import React from "react";
import { useAppStore } from "../../state/appStore";
import type { BatchAssessmentResult, ConflictOverlap, ConflictStatus, RiskMatrixEntry } from "../../../shared/types";
import { Button } from "../ui/Button";
import { RiskMatrix } from "./RiskMatrix";
import { ConflictSummary } from "./ConflictSummary";
import { MergeSimulationPanel } from "./MergeSimulationPanel";

type ViewMode = "summary" | "matrix";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function statusRank(value: ConflictStatus["status"]): number {
  if (value === "conflict-active") return 5;
  if (value === "conflict-predicted") return 4;
  if (value === "behind-base") return 3;
  if (value === "unknown") return 2;
  return 1;
}

function statusDotClass(status: ConflictStatus["status"] | null): string {
  if (status === "conflict-active") return "bg-red-600";
  if (status === "conflict-predicted") return "bg-orange-500";
  if (status === "behind-base") return "bg-amber-500";
  if (status === "merge-ready") return "bg-emerald-500";
  return "bg-muted-fg";
}

export function ConflictsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [batch, setBatch] = React.useState<BatchAssessmentResult | null>(null);
  const [overlaps, setOverlaps] = React.useState<ConflictOverlap[]>([]);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [selectedPair, setSelectedPair] = React.useState<{ laneAId: string; laneBId: string } | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>("summary");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus>();
    for (const status of batch?.lanes ?? []) {
      map.set(status.laneId, status);
    }
    return map;
  }, [batch]);

  const matrixByPair = React.useMemo(() => {
    const map = new Map<string, RiskMatrixEntry>();
    for (const entry of batch?.matrix ?? []) {
      map.set(pairKey(entry.laneAId, entry.laneBId), entry);
    }
    return map;
  }, [batch]);

  const sortedLanes = React.useMemo(() => {
    return [...lanes].sort((a, b) => {
      const statusA = statusByLane.get(a.id)?.status ?? "unknown";
      const statusB = statusByLane.get(b.id)?.status ?? "unknown";
      const rankDelta = statusRank(statusB) - statusRank(statusA);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name);
    });
  }, [lanes, statusByLane]);

  const selectedLane = React.useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? null,
    [lanes, selectedLaneId]
  );

  const selectedStatus = selectedLaneId ? statusByLane.get(selectedLaneId) ?? null : null;

  const selectedPairEntry = React.useMemo(() => {
    if (!selectedPair) return null;
    return matrixByPair.get(pairKey(selectedPair.laneAId, selectedPair.laneBId)) ?? null;
  }, [matrixByPair, selectedPair]);

  const loadBatch = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextBatch] = await Promise.all([
        window.ade.conflicts.getBatchAssessment(),
        lanes.length ? Promise.resolve() : refreshLanes()
      ]);
      setBatch(nextBatch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lanes.length, refreshLanes]);

  const loadLaneOverlaps = React.useCallback(async (laneId: string) => {
    try {
      const next = await window.ade.conflicts.listOverlaps({ laneId });
      setOverlaps(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOverlaps([]);
    }
  }, []);

  React.useEffect(() => {
    void loadBatch();
  }, [loadBatch]);

  React.useEffect(() => {
    if (!selectedLaneId && sortedLanes[0]?.id) {
      setSelectedLaneId(sortedLanes[0].id);
    }
  }, [selectedLaneId, sortedLanes]);

  React.useEffect(() => {
    if (!selectedLaneId) {
      setOverlaps([]);
      return;
    }
    void loadLaneOverlaps(selectedLaneId);
  }, [selectedLaneId, loadLaneOverlaps]);

  React.useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type !== "prediction-complete") return;
      void loadBatch();
      if (selectedLaneId && event.laneIds.includes(selectedLaneId)) {
        void loadLaneOverlaps(selectedLaneId);
      }
    });
    return unsubscribe;
  }, [loadBatch, loadLaneOverlaps, selectedLaneId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="text-sm font-semibold text-fg">Conflict Radar</div>
        <div className="text-xs text-muted-fg">
          lanes: {lanes.length} · conflicts: {batch?.lanes.filter((entry) => entry.status === "conflict-predicted" || entry.status === "conflict-active").length ?? 0}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setViewMode("summary")}>
            Summary
          </Button>
          <Button size="sm" variant="outline" onClick={() => setViewMode("matrix")}>
            Matrix
          </Button>
          <Button size="sm" variant="outline" onClick={() => void window.ade.conflicts.runPrediction({})}>
            Run Prediction
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadBatch()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {error ? <div className="border-b border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-200">{error}</div> : null}

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_320px]">
        <aside className="min-h-0 overflow-auto border-r border-border bg-card/20 p-2">
          {sortedLanes.map((lane) => {
            const status = statusByLane.get(lane.id) ?? null;
            const selected = lane.id === selectedLaneId;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => {
                  setSelectedLaneId(lane.id);
                  setViewMode("summary");
                }}
                className={`mb-2 block w-full rounded border px-2 py-2 text-left ${
                  selected ? "border-accent bg-accent/20" : "border-border bg-card/50 hover:bg-muted/70"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusDotClass(status?.status ?? null)}`} />
                  <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                </div>
                <div className="mt-1 text-[11px] text-muted-fg">
                  {(status?.status ?? "unknown")} · overlaps {status?.overlappingFileCount ?? 0}
                </div>
              </button>
            );
          })}
        </aside>

        <main className="min-h-0 overflow-auto border-r border-border p-3">
          {viewMode === "matrix" ? (
            <div className="space-y-3">
              <RiskMatrix
                lanes={sortedLanes}
                entries={batch?.matrix ?? []}
                selectedPair={selectedPair}
                onSelectPair={(pair) => {
                  setSelectedPair(pair);
                  setViewMode("matrix");
                  if (pair.laneAId !== pair.laneBId) {
                    setSelectedLaneId(pair.laneAId);
                  } else {
                    setSelectedLaneId(pair.laneAId);
                  }
                }}
              />
              {selectedPairEntry ? (
                <div className="rounded border border-border bg-card/40 p-3 text-xs">
                  <div className="font-semibold text-fg">
                    Pair: {lanes.find((lane) => lane.id === selectedPairEntry.laneAId)?.name ?? selectedPairEntry.laneAId}
                    {" vs "}
                    {lanes.find((lane) => lane.id === selectedPairEntry.laneBId)?.name ?? selectedPairEntry.laneBId}
                  </div>
                  <div className="mt-1 text-muted-fg">
                    risk: {selectedPairEntry.riskLevel} · overlap files: {selectedPairEntry.overlapCount} · has conflict: {selectedPairEntry.hasConflict ? "yes" : "no"}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <ConflictSummary lane={selectedLane} status={selectedStatus} overlaps={overlaps} />
              <MergeSimulationPanel
                lanes={sortedLanes}
                initialLaneAId={selectedLaneId}
                initialLaneBId={selectedPair && selectedPair.laneAId !== selectedPair.laneBId ? selectedPair.laneBId : null}
              />
            </div>
          )}
        </main>

        <aside className="min-h-0 overflow-auto bg-card/10 p-3">
          <div className="rounded border border-border bg-card/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Resolution Proposals</div>
            <div className="mt-2 text-xs text-muted-fg">
              Hosted proposal generation is intentionally deferred. This panel reserves the Phase 5 layout surface and
              currently focuses on prediction, matrix analysis, and merge simulation.
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
