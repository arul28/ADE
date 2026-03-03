import type { ConflictOverlap, ConflictStatus, LaneSummary } from "../../../shared/types";
import { cn } from "../ui/cn";

function riskGlow(risk: ConflictOverlap["riskLevel"]): string {
  if (risk === "high") return "shadow-[0_0_10px_-3px_rgba(239,68,68,0.2)] border-red-500/15";
  if (risk === "medium") return "shadow-[0_0_8px_-3px_rgba(245,158,11,0.15)] border-amber-500/15";
  if (risk === "low") return "shadow-[0_0_6px_-3px_rgba(16,185,129,0.12)] border-emerald-500/15";
  return "border-border/10";
}

function statusGlow(status: ConflictStatus["status"] | undefined): string {
  if (status === "conflict-active") return "shadow-[0_0_12px_-3px_rgba(239,68,68,0.2)] border-red-500/20";
  if (status === "conflict-predicted") return "shadow-[0_0_10px_-3px_rgba(249,115,22,0.15)] border-orange-500/15";
  if (status === "merge-ready") return "shadow-[0_0_8px_-3px_rgba(16,185,129,0.15)] border-emerald-500/15";
  return "border-border/10";
}

export function ConflictSummary({
  lane,
  status,
  overlaps
}: {
  lane: LaneSummary | null;
  status: ConflictStatus | null;
  overlaps: ConflictOverlap[];
}) {
  if (!lane) {
    return <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm p-4 text-xs text-muted-fg shadow-card">Select a lane to inspect conflicts.</div>;
  }

  return (
    <div className="space-y-3">
      <div className={cn(
        "rounded-lg border bg-card/50 backdrop-blur-sm p-4 shadow-card transition-all duration-200 hover:shadow-card-hover",
        statusGlow(status?.status)
      )}>
        <div className="text-sm font-semibold text-fg">{lane.name}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-fg">
          <span className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 border",
            status?.status === "conflict-active" && "bg-red-500/10 text-red-300 border-red-500/20",
            status?.status === "conflict-predicted" && "bg-orange-500/10 text-orange-300 border-orange-500/20",
            status?.status === "merge-ready" && "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
            (!status?.status || status?.status === "unknown") && "bg-muted/20 border-border/10"
          )}>
            <span className={cn(
              "h-1.5 w-1.5 rounded-full",
              status?.status === "conflict-active" && "bg-red-400",
              status?.status === "conflict-predicted" && "bg-orange-400",
              status?.status === "merge-ready" && "bg-emerald-400",
              (!status?.status || status?.status === "unknown") && "bg-muted-fg"
            )} />
            {status?.status ?? "unknown"}
          </span>
          <span>overlaps: <span className="text-fg font-medium">{status?.overlappingFileCount ?? 0}</span></span>
          <span>peers: <span className="text-fg font-medium">{status?.peerConflictCount ?? 0}</span></span>
        </div>
        <div className="mt-1 text-xs text-muted-fg/70">Last predicted: {status?.lastPredictedAt ?? "never"}</div>
      </div>

      {overlaps.length === 0 ? (
        <div className="rounded-lg border border-border/10 bg-card/50 backdrop-blur-sm p-4 text-xs text-muted-fg shadow-card">
          No overlaps recorded yet for this lane.
        </div>
      ) : (
        <div className="space-y-2">
          {overlaps.map((overlap) => (
            <div key={`${overlap.peerId ?? "base"}:${overlap.peerName}`} className={cn(
              "rounded-lg border bg-card/50 backdrop-blur-sm p-3 shadow-card transition-all duration-200 hover:shadow-card-hover hover:-translate-y-[0.5px] hover:bg-card/60",
              riskGlow(overlap.riskLevel)
            )}>
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs font-semibold text-fg">{overlap.peerName}</div>
                <div className={cn(
                  "text-xs uppercase tracking-wide rounded-md px-1.5 py-0.5 border",
                  overlap.riskLevel === "high" && "bg-red-500/10 border-red-500/20 text-red-300",
                  overlap.riskLevel === "medium" && "bg-amber-500/10 border-amber-500/20 text-amber-300",
                  overlap.riskLevel === "low" && "bg-emerald-500/10 border-emerald-500/20 text-emerald-300",
                  !overlap.riskLevel && "bg-muted/20 border-border/10 text-muted-fg"
                )}>{overlap.riskLevel}</div>
              </div>
              <div className="mt-2 max-h-40 overflow-auto rounded-md bg-bg/30 p-2 text-xs">
                {overlap.files.length === 0 ? (
                  <div className="text-muted-fg">No file overlap details.</div>
                ) : (
                  overlap.files.map((file) => (
                    <div key={file.path} className="flex items-center justify-between gap-2 py-1 border-b border-border/5 last:border-0">
                      <span className="truncate text-fg font-mono text-[11px]" title={file.path}>
                        {file.path}
                      </span>
                      <span className="text-[11px] uppercase text-muted-fg shrink-0">{file.conflictType}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
