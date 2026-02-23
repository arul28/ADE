import React from "react";
import type { LaneSummary, MergeSimulationResult } from "../../../shared/types";
import { Button } from "../ui/Button";
import { ConflictFileDiff } from "./ConflictFileDiff";

export function MergeSimulationPanel({
  lanes,
  initialLaneAId,
  initialLaneBId
}: {
  lanes: LaneSummary[];
  initialLaneAId?: string | null;
  initialLaneBId?: string | null;
}) {
  const [laneAId, setLaneAId] = React.useState(initialLaneAId ?? lanes[0]?.id ?? "");
  const [laneBId, setLaneBId] = React.useState(initialLaneBId ?? "");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<MergeSimulationResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedConflictPath, setSelectedConflictPath] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (initialLaneAId) setLaneAId(initialLaneAId);
  }, [initialLaneAId]);

  React.useEffect(() => {
    if (initialLaneBId !== undefined && initialLaneBId !== null) {
      setLaneBId(initialLaneBId);
    }
  }, [initialLaneBId]);

  const runSimulation = async () => {
    if (!laneAId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.ade.conflicts.simulateMerge({
        laneAId,
        laneBId: laneBId || undefined
      });
      setResult(next);
      setSelectedConflictPath(next.conflictingFiles[0]?.path ?? null);
      if (next.outcome === "error") {
        setError(next.error ?? "Simulation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded shadow-card bg-card/30 p-3">
      <div className="text-[13px] font-semibold text-fg/70">Merge Simulation</div>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
        <select
          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs"
          value={laneAId}
          onChange={(event) => setLaneAId(event.target.value)}
        >
          {lanes.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.name}
            </option>
          ))}
        </select>
        <select
          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs"
          value={laneBId}
          onChange={(event) => setLaneBId(event.target.value)}
        >
          <option value="">(compare to base)</option>
          {lanes
            .filter((lane) => lane.id !== laneAId)
            .map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
        </select>
        <Button size="sm" variant="primary" onClick={() => void runSimulation()} disabled={busy || !laneAId}>
          {busy ? "Running..." : "Simulate"}
        </Button>
      </div>

      {error ? <div className="rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-200">{error}</div> : null}

      {result ? (
        <div className="space-y-2">
          <div className="rounded-lg bg-card/60 p-2 text-xs">
            <div>
              Outcome: <span className="font-semibold text-fg">{result.outcome}</span>
            </div>
            <div className="mt-1 text-muted-fg">
              files changed: {result.diffStat.filesChanged} · +{result.diffStat.insertions} / -{result.diffStat.deletions}
            </div>
            <div className="mt-1 text-muted-fg">merged files: {result.mergedFiles.length}</div>
          </div>
          <ConflictFileDiff
            result={result}
            selectedPath={selectedConflictPath}
            onSelectPath={setSelectedConflictPath}
          />
        </div>
      ) : null}
    </div>
  );
}
