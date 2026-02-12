import React from "react";
import { useAppStore } from "../../state/appStore";
import type { BatchAssessmentResult, ConflictOverlap, ConflictStatus, RiskMatrixEntry } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { RiskMatrix } from "./RiskMatrix";
import { ConflictSummary } from "./ConflictSummary";
import { MergeSimulationPanel } from "./MergeSimulationPanel";
import { cn } from "../ui/cn";

type ViewMode = "summary" | "matrix";
type LaneStatusFilter = "conflict" | "at-risk" | "clean" | "unknown" | null;

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

function classifyStatus(status: ConflictStatus["status"] | undefined): Exclude<LaneStatusFilter, null> {
  if (status === "conflict-active" || status === "conflict-predicted") return "conflict";
  if (status === "behind-base") return "at-risk";
  if (status === "merge-ready") return "clean";
  return "unknown";
}

function filterLaneByStatus(status: ConflictStatus["status"] | undefined, filter: LaneStatusFilter): boolean {
  if (!filter) return true;
  return classifyStatus(status) === filter;
}

export function ConflictsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  const [batch, setBatch] = React.useState<BatchAssessmentResult | null>(null);
  const [overlaps, setOverlaps] = React.useState<ConflictOverlap[]>([]);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [selectedPair, setSelectedPair] = React.useState<{ laneAId: string; laneBId: string } | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>("summary");
  const [statusFilter, setStatusFilter] = React.useState<LaneStatusFilter>(null);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState<{ completedPairs: number; totalPairs: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [comparisonLaneIds, setComparisonLaneIds] = React.useState<string[]>([]);
  const [runningSelectedCompare, setRunningSelectedCompare] = React.useState(false);

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

  const laneSummaryCounts = React.useMemo(() => {
    const counts: Record<Exclude<LaneStatusFilter, null>, number> = {
      conflict: 0,
      "at-risk": 0,
      clean: 0,
      unknown: 0
    };
    for (const lane of sortedLanes) {
      counts[classifyStatus(statusByLane.get(lane.id)?.status)] += 1;
    }
    return counts;
  }, [sortedLanes, statusByLane]);

  const filteredLanes = React.useMemo(
    () => sortedLanes.filter((lane) => filterLaneByStatus(statusByLane.get(lane.id)?.status, statusFilter)),
    [sortedLanes, statusByLane, statusFilter]
  );

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
      setProgress(nextBatch.progress ?? null);
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
    if (selectedLaneId && !lanes.some((lane) => lane.id === selectedLaneId)) {
      setSelectedLaneId(lanes[0]?.id ?? null);
    }
  }, [lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) {
      setOverlaps([]);
      return;
    }
    void loadLaneOverlaps(selectedLaneId);
  }, [selectedLaneId, loadLaneOverlaps]);

  React.useEffect(() => {
    const unsubscribe = window.ade.conflicts.onEvent((event) => {
      if (event.type === "prediction-progress") {
        setProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
        return;
      }
      setProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
      void loadBatch();
      if (selectedLaneId && event.laneIds.includes(selectedLaneId)) {
        void loadLaneOverlaps(selectedLaneId);
      }
    });
    return unsubscribe;
  }, [loadBatch, loadLaneOverlaps, selectedLaneId]);

  const toggleStatusFilter = (value: Exclude<LaneStatusFilter, null>) => {
    setStatusFilter((prev) => (prev === value ? null : value));
  };

  React.useEffect(() => {
    if (!batch?.truncated) return;
    const allowedLaneIds = new Set(lanes.map((lane) => lane.id));
    setComparisonLaneIds((prev) => {
      const preserved = prev.filter((laneId) => allowedLaneIds.has(laneId));
      if (preserved.length > 0) {
        return preserved.slice(0, batch.maxAutoLanes ?? 15);
      }
      const fallback = (batch.comparedLaneIds ?? lanes.map((lane) => lane.id))
        .filter((laneId) => allowedLaneIds.has(laneId))
        .slice(0, batch.maxAutoLanes ?? 15);
      return fallback;
    });
  }, [batch?.truncated, batch?.comparedLaneIds, batch?.maxAutoLanes, lanes]);

  const toggleComparisonLane = (laneId: string) => {
    const max = batch?.maxAutoLanes ?? 15;
    setComparisonLaneIds((prev) => {
      if (prev.includes(laneId)) return prev.filter((entry) => entry !== laneId);
      if (prev.length >= max) return prev;
      return [...prev, laneId];
    });
  };

  const runSelectedComparison = async () => {
    if (comparisonLaneIds.length < 2) {
      setError("Select at least 2 lanes to run pairwise risk comparison.");
      return;
    }
    setRunningSelectedCompare(true);
    setError(null);
    try {
      const next = await window.ade.conflicts.runPrediction({ laneIds: comparisonLaneIds });
      setBatch(next);
      setProgress(next.progress ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningSelectedCompare(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="text-sm font-semibold text-fg">Conflict Radar</div>
        <div className="text-xs text-muted-fg">
          lanes: {lanes.length} · conflicts: {batch?.lanes.filter((entry) => entry.status === "conflict-predicted" || entry.status === "conflict-active").length ?? 0}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant={viewMode === "summary" ? "primary" : "outline"} onClick={() => setViewMode("summary")}>
            Summary
          </Button>
          <Button size="sm" variant={viewMode === "matrix" ? "primary" : "outline"} onClick={() => setViewMode("matrix")}>
            Matrix
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void window.ade.conflicts
                .runPrediction(batch?.truncated && comparisonLaneIds.length > 1 ? { laneIds: comparisonLaneIds } : {})
                .then((next) => {
                  setBatch(next);
                  setProgress(next.progress ?? null);
                })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            Run Prediction
          </Button>
          <Button size="sm" variant="outline" onClick={() => void loadBatch()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {error ? <div className="border-b border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-200">{error}</div> : null}

      {batch?.truncated ? (
        <div className="border-b border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
          <div>
            Too many lanes for automatic risk assessment. Showing {batch.comparedLaneIds?.length ?? batch.maxAutoLanes ?? 15} of {batch.totalLanes ?? lanes.length} lanes.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {lanes.map((lane) => {
              const checked = comparisonLaneIds.includes(lane.id);
              return (
                <button
                  key={lane.id}
                  type="button"
                  onClick={() => toggleComparisonLane(lane.id)}
                  className={cn(
                    "rounded border px-2 py-0.5 text-[11px]",
                    checked
                      ? "border-amber-300/70 bg-amber-500/25 text-amber-100"
                      : "border-amber-700/60 bg-transparent text-amber-200/80"
                  )}
                >
                  {checked ? "✓ " : ""}{lane.name}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-amber-100/90">
              selected {comparisonLaneIds.length}/{batch.maxAutoLanes ?? 15}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void runSelectedComparison()}
              disabled={runningSelectedCompare || comparisonLaneIds.length < 2}
            >
              {runningSelectedCompare ? "Computing…" : "Compare selected"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_320px]">
        <aside className="min-h-0 overflow-auto border-r border-border bg-card/20 p-2">
          <div className="mb-2 flex flex-wrap gap-1">
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("conflict")}
              className={cn("cursor-pointer border-red-500/50 text-red-300", statusFilter === "conflict" && "bg-red-500/30")}
            >
              ●{laneSummaryCounts.conflict} conflict
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("at-risk")}
              className={cn("cursor-pointer border-amber-500/50 text-amber-300", statusFilter === "at-risk" && "bg-amber-500/30")}
            >
              ●{laneSummaryCounts["at-risk"]} at-risk
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("clean")}
              className={cn("cursor-pointer border-emerald-500/50 text-emerald-300", statusFilter === "clean" && "bg-emerald-500/30")}
            >
              ●{laneSummaryCounts.clean} clean
            </Chip>
            <Chip
              role="button"
              onClick={() => toggleStatusFilter("unknown")}
              className={cn("cursor-pointer border-border text-muted-fg", statusFilter === "unknown" && "bg-muted/70 text-fg")}
            >
              ●{laneSummaryCounts.unknown} unknown
            </Chip>
          </div>

          {filteredLanes.map((lane) => {
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
                overlaps={batch?.overlaps ?? []}
                selectedPair={selectedPair}
                loading={loading}
                progress={progress}
                onSelectPair={(pair) => {
                  setSelectedPair(pair);
                  setViewMode("matrix");
                  setSelectedLaneId(pair.laneAId);
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
