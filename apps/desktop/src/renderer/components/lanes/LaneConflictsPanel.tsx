import React from "react";
import { useNavigate } from "react-router-dom";
import type { ConflictOverlap, ConflictStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

function statusTone(status: ConflictStatus["status"]): { label: string; className: string } {
  if (status === "conflict-active") return { label: "conflict-active", className: "text-red-200 border-red-700/60 bg-red-900/20" };
  if (status === "conflict-predicted") return { label: "conflict-predicted", className: "text-orange-200 border-orange-700/60 bg-orange-900/20" };
  if (status === "behind-base") return { label: "behind-base", className: "text-amber-200 border-amber-700/60 bg-amber-900/20" };
  if (status === "merge-ready") return { label: "merge-ready", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  return { label: "unknown", className: "text-muted-fg border-border bg-card/30" };
}

export function LaneConflictsPanel({ laneId }: { laneId: string | null }) {
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<ConflictStatus | null>(null);
  const [overlaps, setOverlaps] = React.useState<ConflictOverlap[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, o] = await Promise.all([
        window.ade.conflicts.getLaneStatus({ laneId }),
        window.ade.conflicts.listOverlaps({ laneId })
      ]);
      setStatus(s);
      setOverlaps(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
      setOverlaps([]);
    } finally {
      setLoading(false);
    }
  }, [laneId]);

  React.useEffect(() => {
    setStatus(null);
    setOverlaps([]);
    setError(null);
    if (!laneId) return;
    void refresh();
  }, [laneId, refresh]);

  if (!laneId) {
    return <EmptyState title="No lane selected" description="Select a lane to view its conflict status." />;
  }

  const tone = status ? statusTone(status.status) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">Lane Conflicts</span>
          {tone ? (
            <Chip className={cn("text-[10px] px-1.5", tone.className)}>{tone.label}</Chip>
          ) : (
            <Chip className="text-[10px] px-1.5">{loading ? "loading…" : "unknown"}</Chip>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" className="h-7" onClick={() => navigate("/conflicts")}>
            Open Conflicts Tab
          </Button>
        </div>
      </div>

      {status ? (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded border border-border bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Overlaps</div>
            <div className="font-semibold text-fg">{status.overlappingFileCount}</div>
          </div>
          <div className="rounded border border-border bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Peers</div>
            <div className="font-semibold text-fg">{status.peerConflictCount}</div>
          </div>
          <div className="rounded border border-border bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Predicted</div>
            <div className="font-semibold text-fg">{status.lastPredictedAt ? new Date(status.lastPredictedAt).toLocaleString() : "—"}</div>
          </div>
        </div>
      ) : null}

      {error ? <div className="mt-2 rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{error}</div> : null}

      <div className="mt-2 flex-1 min-h-0 overflow-auto rounded border border-border bg-card/30">
        <div className="border-b border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-fg">Overlaps</div>
        <div className="divide-y divide-border">
          {overlaps.map((overlap) => (
            <div key={overlap.peerId ?? "base"} className="px-2 py-2 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-fg">{overlap.peerName}</div>
                  <div className="truncate text-[10px] text-muted-fg">
                    risk: {overlap.riskLevel} · files: {overlap.files.length}
                  </div>
                </div>
              </div>
              {overlap.files.length ? (
                <div className="mt-1 max-h-[120px] overflow-auto rounded border border-border bg-bg/40 p-1">
                  {overlap.files.slice(0, 12).map((file) => (
                    <div key={file.path} className="truncate font-mono text-[10px] text-muted-fg" title={file.path}>
                      {file.path}
                    </div>
                  ))}
                  {overlap.files.length > 12 ? (
                    <div className="px-1 py-0.5 text-[10px] text-muted-fg">+{overlap.files.length - 12} more…</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {!overlaps.length && !loading ? <div className="px-2 py-3 text-xs text-muted-fg">No overlaps detected.</div> : null}
        </div>
      </div>
    </div>
  );
}

