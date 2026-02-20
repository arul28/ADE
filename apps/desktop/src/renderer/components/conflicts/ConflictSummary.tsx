import React from "react";
import type { ConflictOverlap, ConflictStatus, LaneSummary } from "../../../shared/types";

function riskClass(risk: ConflictOverlap["riskLevel"]): string {
  if (risk === "high") return "text-red-300";
  if (risk === "medium") return "text-amber-300";
  if (risk === "low") return "text-emerald-300";
  return "text-muted-fg";
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
    return <div className="rounded shadow-card bg-card/40 p-3 text-xs text-muted-fg">Select a lane to inspect conflicts.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded shadow-card bg-card/40 p-3">
        <div className="text-sm font-semibold text-fg">{lane.name}</div>
        <div className="mt-1 text-xs text-muted-fg">
          Status: <span className="text-fg">{status?.status ?? "unknown"}</span>
          {" · "}
          overlaps: <span className="text-fg">{status?.overlappingFileCount ?? 0}</span>
          {" · "}
          peer conflicts: <span className="text-fg">{status?.peerConflictCount ?? 0}</span>
        </div>
        <div className="mt-1 text-xs text-muted-fg">Last predicted: {status?.lastPredictedAt ?? "never"}</div>
      </div>

      {overlaps.length === 0 ? (
        <div className="rounded shadow-card bg-card/40 p-3 text-xs text-muted-fg">
          No overlaps recorded yet for this lane.
        </div>
      ) : (
        <div className="space-y-2">
          {overlaps.map((overlap) => (
            <div key={`${overlap.peerId ?? "base"}:${overlap.peerName}`} className="rounded shadow-card bg-card/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs font-semibold text-fg">{overlap.peerName}</div>
                <div className={`text-[11px] uppercase tracking-wide ${riskClass(overlap.riskLevel)}`}>{overlap.riskLevel}</div>
              </div>
              <div className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted/20 p-2 text-xs">
                {overlap.files.length === 0 ? (
                  <div className="text-muted-fg">No file overlap details.</div>
                ) : (
                  overlap.files.map((file) => (
                    <div key={file.path} className="flex items-center justify-between gap-2 border-b border-border/10 py-1 last:border-none">
                      <span className="truncate text-fg" title={file.path}>
                        {file.path}
                      </span>
                      <span className="text-[10px] uppercase text-muted-fg">{file.conflictType}</span>
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
