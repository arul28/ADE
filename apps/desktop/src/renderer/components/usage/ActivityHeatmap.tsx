import { useMemo } from "react";
import type { AdeUsageDailyPoint } from "../../../shared/types";
import {
  type ActivityLevel,
  bucketActivityIntensity,
  dayActivityScore,
  trimLeadingInactiveDays,
} from "./activityIntensity";

const HEATMAP_GAP = 3;
const HEATMAP_MIN_CELL = 6;
const HEATMAP_HUE = "#5B93F5";
const HEATMAP_LEVEL_MIX = [0, 28, 47, 68, 92] as const;

export type HeatmapLayout = {
  rows: number;
  cols: number;
  cell: number;
  width: number;
  visible: number;
};

export function computeHeatmapLayout({
  cellCount,
  maxCell,
  availableWidth,
}: {
  cellCount: number;
  maxCell: number;
  availableWidth: number;
}): HeatmapLayout {
  if (cellCount <= 0) return { rows: 1, cols: 0, cell: maxCell, width: 0, visible: 0 };

  const rows = cellCount <= 7 ? 1 : 7;
  const cols = Math.max(1, Math.ceil(cellCount / rows));
  const spanOf = (columns: number, cell: number) => columns * cell + (columns - 1) * HEATMAP_GAP;

  if (availableWidth <= 0) {
    return { rows, cols, cell: maxCell, width: spanOf(cols, maxCell), visible: cellCount };
  }

  const fitted = Math.floor((availableWidth - (cols - 1) * HEATMAP_GAP) / cols);
  const cell = Math.max(HEATMAP_MIN_CELL, Math.min(maxCell, fitted));
  if (spanOf(cols, cell) <= availableWidth) {
    return { rows, cols, cell, width: spanOf(cols, cell), visible: cellCount };
  }

  const visibleCols = Math.max(1, Math.floor((availableWidth + HEATMAP_GAP) / (cell + HEATMAP_GAP)));
  return {
    rows,
    cols: visibleCols,
    cell,
    width: spanOf(visibleCols, cell),
    visible: Math.min(cellCount, visibleCols * rows),
  };
}

type HeatmapCell = { point: AdeUsageDailyPoint; level: ActivityLevel };

export function useHeatmapCells(points: AdeUsageDailyPoint[]): HeatmapCell[] {
  return useMemo(() => {
    const ordered = trimLeadingInactiveDays(
      [...points].sort((a, b) => a.date.localeCompare(b.date)),
    );
    const levels = bucketActivityIntensity(ordered.map(dayActivityScore));
    return ordered.map((point, index) => ({ point, level: levels[index] ?? 0 }));
  }, [points]);
}

type HeatmapTooltip = {
  show: (point: AdeUsageDailyPoint, target: HTMLElement) => void;
  hide: () => void;
  toggle: (point: AdeUsageDailyPoint, target: HTMLElement) => void;
};

export function ActivityHeatmap({
  cells,
  layout,
  reduced,
  tooltip,
}: {
  cells: HeatmapCell[];
  layout: HeatmapLayout;
  reduced: boolean;
  tooltip: HeatmapTooltip;
}) {
  const { rows, cell } = layout;
  const shown = layout.visible >= cells.length ? cells : cells.slice(cells.length - layout.visible);

  return (
    <div className="flex w-full justify-center">
      <div
        className="grid"
        style={{
          gap: HEATMAP_GAP,
          width: layout.width,
          height: rows * cell + (rows - 1) * HEATMAP_GAP,
          gridAutoFlow: "column",
          gridTemplateRows: `repeat(${rows}, ${cell}px)`,
          gridAutoColumns: `${cell}px`,
        }}
        role="img"
        aria-label="Daily activity heatmap"
        data-heatmap-rows={rows}
        data-heatmap-cell={cell}
      >
        {shown.map(({ point, level }) => (
          <span
            key={point.date}
            className="rounded-[2px]"
            data-level={level}
            style={{
              background:
                level === 0
                  ? "color-mix(in srgb, var(--color-fg) 7%, transparent)"
                  : `color-mix(in srgb, ${HEATMAP_HUE} ${HEATMAP_LEVEL_MIX[level]}%, var(--color-card))`,
              transition: reduced ? undefined : "background 120ms ease",
              cursor: "default",
            }}
            onPointerEnter={(event) => tooltip.show(point, event.currentTarget)}
            onPointerLeave={tooltip.hide}
            onClick={(event) => tooltip.toggle(point, event.currentTarget)}
          />
        ))}
      </div>
    </div>
  );
}
