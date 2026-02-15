import React from "react";
import { Clock3 } from "lucide-react";
import type { BatchOverlapEntry, LaneSummary, RiskMatrixEntry } from "../../../shared/types";
import { cn } from "../ui/cn";
import { RiskTooltip } from "./RiskTooltip";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function cellClasses(risk: RiskMatrixEntry["riskLevel"], selected: boolean, stale: boolean): string {
  const base = selected ? "ring-2 ring-accent" : "ring-1 ring-border/70";
  const staleClass = stale ? "opacity-65" : "";
  if (risk === "high") return cn("bg-red-500/30 text-red-100", base, staleClass);
  if (risk === "medium") return cn("bg-amber-500/25 text-amber-100", base, staleClass);
  if (risk === "low") return cn("bg-emerald-500/20 text-emerald-100", base, staleClass);
  return cn("bg-card text-muted-fg", base, staleClass);
}

function hasSamePair(a: { laneAId: string; laneBId: string }, b: { laneAId: string; laneBId: string }): boolean {
  return pairKey(a.laneAId, a.laneBId) === pairKey(b.laneAId, b.laneBId);
}

type ChangeEffect = "increased" | "decreased";

function formatStaleLabel(computedAt: string | null): string {
  if (!computedAt) return "Stale result. Click to refresh.";
  const ts = Date.parse(computedAt);
  if (Number.isNaN(ts)) return "Stale result. Click to refresh.";
  const deltaMs = Math.max(0, Date.now() - ts);
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  return `Last computed ${minutes} minute${minutes === 1 ? "" : "s"} ago. Click to refresh.`;
}

export function RiskMatrix({
  lanes,
  entries,
  overlaps,
  selectedPair,
  loading,
  progress,
  onSelectPair
}: {
  lanes: LaneSummary[];
  entries: RiskMatrixEntry[];
  overlaps: BatchOverlapEntry[];
  selectedPair: { laneAId: string; laneBId: string } | null;
  loading: boolean;
  progress?: { completedPairs: number; totalPairs: number } | null;
  onSelectPair: (pair: { laneAId: string; laneBId: string }) => void;
}) {
  const matrix = React.useMemo(() => {
    const map = new Map<string, RiskMatrixEntry>();
    for (const entry of entries) {
      map.set(pairKey(entry.laneAId, entry.laneBId), entry);
    }
    return map;
  }, [entries]);

  const overlapsByPair = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const overlap of overlaps) {
      map.set(pairKey(overlap.laneAId, overlap.laneBId), overlap.files);
    }
    return map;
  }, [overlaps]);

  const [hoveredPair, setHoveredPair] = React.useState<{ laneAId: string; laneBId: string } | null>(null);
  const [hoveredRect, setHoveredRect] = React.useState<DOMRect | null>(null);
  const hoverTimerRef = React.useRef<number | null>(null);
  const progressStartedAtRef = React.useRef<number | null>(null);

  const [changeEffects, setChangeEffects] = React.useState<Record<string, ChangeEffect>>({});
  const previousLevelsRef = React.useRef<Map<string, RiskMatrixEntry["riskLevel"]>>(new Map());
  const seenEntryKeysRef = React.useRef<Set<string>>(new Set());
  const [enteredKeys, setEnteredKeys] = React.useState<Record<string, true>>({});

  React.useEffect(() => {
    const rank = (value: RiskMatrixEntry["riskLevel"]): number => {
      if (value === "high") return 4;
      if (value === "medium") return 3;
      if (value === "low") return 2;
      return 1;
    };

    const nextPrev = new Map<string, RiskMatrixEntry["riskLevel"]>();
    const nextEffects: Record<string, ChangeEffect> = {};
    for (const entry of entries) {
      const key = pairKey(entry.laneAId, entry.laneBId);
      const previous = previousLevelsRef.current.get(key);
      if (previous && previous !== entry.riskLevel) {
        nextEffects[key] = rank(entry.riskLevel) > rank(previous) ? "increased" : "decreased";
      }
      nextPrev.set(key, entry.riskLevel);
    }
    previousLevelsRef.current = nextPrev;
    if (Object.keys(nextEffects).length === 0) return;

    setChangeEffects((prev) => ({ ...prev, ...nextEffects }));
    const timer = window.setTimeout(() => {
      setChangeEffects((prev) => {
        const merged = { ...prev };
        for (const key of Object.keys(nextEffects)) delete merged[key];
        return merged;
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [entries]);

  React.useEffect(() => {
    const newlySeen: string[] = [];
    for (const entry of entries) {
      const key = pairKey(entry.laneAId, entry.laneBId);
      if (seenEntryKeysRef.current.has(key)) continue;
      seenEntryKeysRef.current.add(key);
      newlySeen.push(key);
    }
    if (newlySeen.length === 0) return;
    setEnteredKeys((prev) => {
      const next = { ...prev };
      for (const key of newlySeen) next[key] = true;
      return next;
    });
    const timer = window.setTimeout(() => {
      setEnteredKeys((prev) => {
        const next = { ...prev };
        for (const key of newlySeen) delete next[key];
        return next;
      });
    }, 420);
    return () => window.clearTimeout(timer);
  }, [entries]);

  React.useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!loading || !progress) {
      progressStartedAtRef.current = null;
      return;
    }
    if (progress.completedPairs === 0 || progressStartedAtRef.current == null) {
      progressStartedAtRef.current = Date.now();
      return;
    }
    if (progress.totalPairs > 0 && progress.completedPairs >= progress.totalPairs) {
      progressStartedAtRef.current = null;
    }
  }, [loading, progress]);

  if (lanes.length === 0) {
    return <div className="rounded-xl shadow-card bg-card/40 p-3 text-xs text-muted-fg">No lanes to compare.</div>;
  }

  const startHover = (
    pair: { laneAId: string; laneBId: string },
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const anchorRect = event.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredPair(pair);
      setHoveredRect(anchorRect);
    }, 200);
  };

  const stopHover = () => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredPair(null);
    setHoveredRect(null);
  };

  const hoveredKey = hoveredPair ? pairKey(hoveredPair.laneAId, hoveredPair.laneBId) : null;
  const hoveredFiles = hoveredKey ? overlapsByPair.get(hoveredKey) ?? [] : [];
  const hoveredTitle = hoveredPair
    ? `${lanes.find((lane) => lane.id === hoveredPair.laneAId)?.name ?? hoveredPair.laneAId} vs ${
        lanes.find((lane) => lane.id === hoveredPair.laneBId)?.name ?? hoveredPair.laneBId
      }`
    : "";
  const totalCells = lanes.length * lanes.length;
  const completedCells = progress?.totalPairs && progress.totalPairs > 0
    ? Math.floor((progress.completedPairs / progress.totalPairs) * totalCells)
    : 0;
  const etaLabel = React.useMemo(() => {
    if (!progress || !progressStartedAtRef.current) return null;
    if (progress.completedPairs <= 0 || progress.totalPairs <= progress.completedPairs) return null;
    const elapsedMs = Date.now() - progressStartedAtRef.current;
    if (elapsedMs <= 0) return null;
    const perPairMs = elapsedMs / progress.completedPairs;
    const remaining = progress.totalPairs - progress.completedPairs;
    const remainingSec = Math.max(1, Math.round((perPairMs * remaining) / 1000));
    if (remainingSec < 60) return `~${remainingSec}s left`;
    return `~${Math.ceil(remainingSec / 60)}m left`;
  }, [progress, entries.length]);

  return (
    <div className="relative overflow-auto rounded-xl shadow-card bg-card/30">
      {loading && progress ? (
        <div className="sticky left-0 top-0 z-30 bg-bg/90 px-2 py-1 text-[11px] text-muted-fg">
          Computing {progress.completedPairs}/{progress.totalPairs} pairs…{etaLabel ? ` ${etaLabel}` : ""}
        </div>
      ) : null}
      <table className="w-full min-w-[580px] border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 bg-bg px-2 py-2 text-left text-muted-fg">
              Lane
            </th>
            {lanes.map((lane) => (
              <th key={lane.id} className="bg-bg px-2 py-2 text-left text-muted-fg">
                <span className="block max-w-[120px] truncate">{lane.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lanes.map((rowLane, rowIndex) => (
            <tr key={rowLane.id}>
              <td className="sticky left-0 z-10 bg-bg px-2 py-2 font-medium text-fg">
                <span className="block max-w-[140px] truncate">{rowLane.name}</span>
              </td>
              {lanes.map((colLane, colIndex) => {
                const key = pairKey(rowLane.id, colLane.id);
                const entry = matrix.get(key);
                const isSelected = selectedPair != null && hasSamePair(selectedPair, { laneAId: rowLane.id, laneBId: colLane.id });
                const riskLevel = entry?.riskLevel ?? "none";
                const isLoadingCell = loading && !entry;
                const changeEffect = changeEffects[key];
                const stale = entry?.stale ?? false;
                const shouldAnimateIn = Boolean(enteredKeys[key]);
                const skeletonIndex = rowIndex * lanes.length + colIndex;
                const staleTitle = stale ? formatStaleLabel(entry?.computedAt ?? null) : `${rowLane.name} vs ${colLane.name}`;
                const skeletonResolved = loading && !entry && progress ? skeletonIndex < completedCells : false;

                return (
                  <td key={colLane.id} className="p-1">
                    <button
                      type="button"
                      className={cn(
                        "relative flex h-12 w-full flex-col items-center justify-center rounded-lg px-1 text-[10px] font-semibold transition-all duration-300",
                        isLoadingCell
                          ? cn("ade-risk-skeleton text-muted-fg ring-1 ring-border/50", skeletonResolved && "opacity-60")
                          : cellClasses(riskLevel, isSelected, stale),
                        shouldAnimateIn && "ade-risk-cell-enter",
                        changeEffect === "increased" && "ade-risk-cell-increase",
                        changeEffect === "decreased" && "ade-risk-cell-decrease"
                      )}
                      style={isLoadingCell ? { animationDelay: `${(skeletonIndex % 8) * 45}ms` } : undefined}
                      onClick={() => onSelectPair({ laneAId: rowLane.id, laneBId: colLane.id })}
                      onMouseEnter={(event) => startHover({ laneAId: rowLane.id, laneBId: colLane.id }, event)}
                      onMouseLeave={stopHover}
                      title={staleTitle}
                    >
                      {isLoadingCell ? (
                        <span className="text-[10px] text-muted-fg/80">…</span>
                      ) : (
                        <>
                          <span>{riskLevel}</span>
                          <span className="opacity-80">{entry?.overlapCount ?? 0} files</span>
                          {stale ? <Clock3 className="absolute right-1 top-1 h-3 w-3 text-muted-fg" /> : null}
                        </>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <RiskTooltip open={Boolean(hoveredPair)} anchorRect={hoveredRect} files={hoveredFiles} title={hoveredTitle} />
    </div>
  );
}
