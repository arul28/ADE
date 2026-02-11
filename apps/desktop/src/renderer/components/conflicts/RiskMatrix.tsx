import React from "react";
import type { LaneSummary, RiskMatrixEntry } from "../../../shared/types";
import { cn } from "../ui/cn";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function cellClasses(risk: RiskMatrixEntry["riskLevel"], selected: boolean): string {
  const base = selected ? "ring-2 ring-accent" : "ring-1 ring-border/70";
  if (risk === "high") return cn("bg-red-500/30 text-red-100", base);
  if (risk === "medium") return cn("bg-amber-500/25 text-amber-100", base);
  if (risk === "low") return cn("bg-emerald-500/20 text-emerald-100", base);
  return cn("bg-card text-muted-fg", base);
}

export function RiskMatrix({
  lanes,
  entries,
  selectedPair,
  onSelectPair
}: {
  lanes: LaneSummary[];
  entries: RiskMatrixEntry[];
  selectedPair: { laneAId: string; laneBId: string } | null;
  onSelectPair: (pair: { laneAId: string; laneBId: string }) => void;
}) {
  const matrix = React.useMemo(() => {
    const map = new Map<string, RiskMatrixEntry>();
    for (const entry of entries) {
      map.set(pairKey(entry.laneAId, entry.laneBId), entry);
    }
    return map;
  }, [entries]);

  if (lanes.length === 0) {
    return <div className="rounded border border-border bg-card/60 p-3 text-xs text-muted-fg">No lanes to compare.</div>;
  }

  return (
    <div className="overflow-auto rounded border border-border bg-card/40">
      <table className="w-full min-w-[580px] border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border-b border-r border-border bg-bg px-2 py-2 text-left text-muted-fg">
              Lane
            </th>
            {lanes.map((lane) => (
              <th key={lane.id} className="border-b border-border bg-bg px-2 py-2 text-left text-muted-fg">
                <span className="block max-w-[120px] truncate">{lane.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lanes.map((rowLane) => (
            <tr key={rowLane.id}>
              <td className="sticky left-0 z-10 border-r border-border bg-bg px-2 py-2 font-medium text-fg">
                <span className="block max-w-[140px] truncate">{rowLane.name}</span>
              </td>
              {lanes.map((colLane) => {
                const key = pairKey(rowLane.id, colLane.id);
                const entry = matrix.get(key);
                const isSelected =
                  selectedPair != null &&
                  pairKey(selectedPair.laneAId, selectedPair.laneBId) === key;
                const riskLevel = entry?.riskLevel ?? "none";
                return (
                  <td key={colLane.id} className="border border-border/60 p-1">
                    <button
                      type="button"
                      className={cn(
                        "flex h-12 w-full flex-col items-center justify-center rounded px-1 text-[10px] font-semibold",
                        cellClasses(riskLevel, isSelected)
                      )}
                      onClick={() => onSelectPair({ laneAId: rowLane.id, laneBId: colLane.id })}
                      title={`${rowLane.name} vs ${colLane.name}`}
                    >
                      <span>{riskLevel}</span>
                      <span className="opacity-80">{entry?.overlapCount ?? 0} files</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
