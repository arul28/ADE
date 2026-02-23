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
            <Chip className={cn("text-[11px] px-1.5", tone.className)}>{tone.label}</Chip>
          ) : (
            <Chip className="text-[11px] px-1.5">{loading ? "loading…" : "unknown"}</Chip>
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
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-border/10 bg-card/40 backdrop-blur-sm p-2.5 shadow-card transition-all duration-150 hover:shadow-card-hover hover:bg-card/50">
            <div className="text-[11px] uppercase tracking-wider text-muted-fg">Overlaps</div>
            <div className={cn("font-semibold text-fg", status.overlappingFileCount > 0 && "text-amber-400")}>{status.overlappingFileCount}</div>
          </div>
          <div className="rounded-lg border border-border/10 bg-card/40 backdrop-blur-sm p-2.5 shadow-card transition-all duration-150 hover:shadow-card-hover hover:bg-card/50">
            <div className="text-[11px] uppercase tracking-wider text-muted-fg">Peers</div>
            <div className={cn("font-semibold text-fg", status.peerConflictCount > 0 && "text-red-400")}>{status.peerConflictCount}</div>
          </div>
          <div className="rounded-lg border border-border/10 bg-card/40 backdrop-blur-sm p-2.5 shadow-card transition-all duration-150 hover:shadow-card-hover hover:bg-card/50">
            <div className="text-[11px] uppercase tracking-wider text-muted-fg">Predicted</div>
            <div className="font-semibold text-fg">{status.lastPredictedAt ? new Date(status.lastPredictedAt).toLocaleString() : "---"}</div>
          </div>
        </div>
      ) : null}

      {error ? <div className="mt-2 rounded-lg border border-red-500/20 bg-red-950/20 p-2.5 text-xs text-red-300 shadow-[0_0_8px_-2px_rgba(239,68,68,0.15)]">{error}</div> : null}

      <div className="mt-2 flex-1 min-h-0 overflow-auto rounded-lg border border-border/10 bg-card/30 backdrop-blur-sm shadow-card">
        <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-fg bg-card/30">Overlaps</div>
        <div className="flex flex-col gap-1.5 p-1.5">
          {overlaps.map((overlap) => (
            <div key={overlap.peerId ?? "base"} className={cn(
              "rounded-lg border border-border/10 bg-card/40 backdrop-blur-sm px-3 py-2.5 text-xs transition-all duration-150 hover:bg-card/60 hover:shadow-card-hover hover:-translate-y-[0.5px]",
              overlap.riskLevel === "high" && "border-red-500/15 shadow-[0_0_8px_-2px_rgba(239,68,68,0.1)]",
              overlap.riskLevel === "medium" && "border-amber-500/15 shadow-[0_0_8px_-2px_rgba(245,158,11,0.1)]",
              overlap.riskLevel === "low" && "border-emerald-500/15"
            )}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-fg">{overlap.peerName}</div>
                  <div className="truncate text-[11px] text-muted-fg">
                    risk: <span className={cn(
                      overlap.riskLevel === "high" && "text-red-400",
                      overlap.riskLevel === "medium" && "text-amber-400",
                      overlap.riskLevel === "low" && "text-emerald-400"
                    )}>{overlap.riskLevel}</span> · files: {overlap.files.length}
                  </div>
                </div>
              </div>
              {overlap.files.length ? (
                <div className="mt-1.5 max-h-[120px] overflow-auto rounded-md bg-bg/30 p-1.5">
                  {overlap.files.slice(0, 12).map((file) => (
                    <div key={file.path} className="truncate font-mono text-[11px] text-muted-fg py-0.5" title={file.path}>
                      {file.path}
                    </div>
                  ))}
                  {overlap.files.length > 12 ? (
                    <div className="px-1 py-0.5 text-[11px] text-muted-fg">+{overlap.files.length - 12} more...</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {!overlaps.length && !loading ? <div className="px-3 py-3 text-xs text-muted-fg">No overlaps detected.</div> : null}
        </div>
      </div>
    </div>
  );
}

