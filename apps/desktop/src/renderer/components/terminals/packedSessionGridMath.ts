import type { DockLayout } from "../../../shared/types";

export const GRID_GAP_PX = 8;
export const GRID_BASE_ROW_PX = 120;
export const GRID_MAX_ROW_SPAN = 8;
export const GRID_COLUMN_SUBDIVISIONS = 12;

export type PackedGridSpan = {
  colSpan: number;
  rowSpan: number;
};

export type PackedGridPlacement = PackedGridSpan & {
  id: string;
  column: number;
  row: number;
};

export type PackedGridItem = {
  id: string;
  minRowSpan: number;
  span: PackedGridSpan;
};

function spanKey(id: string, axis: "col" | "row"): string {
  return `${id}:${axis}`;
}

export function computeMinimumRowSpan(
  minHeightPx: number,
  rowPx = GRID_BASE_ROW_PX,
  gapPx = GRID_GAP_PX,
): number {
  if (!Number.isFinite(minHeightPx) || minHeightPx <= 0) return 1;
  const numerator = minHeightPx + gapPx;
  const denominator = rowPx + gapPx;
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  return Math.max(1, Math.ceil(numerator / denominator));
}

export function computeDefaultRowSpan(minRowSpans: number[]): number {
  if (minRowSpans.length === 0) return 1;
  return Math.max(1, ...minRowSpans);
}

export function computeMinimumColSpan(args: {
  minWidthPx: number;
  trackWidthPx: number;
  gapPx?: number;
}): number {
  const { minWidthPx, trackWidthPx, gapPx = GRID_GAP_PX } = args;
  if (!Number.isFinite(minWidthPx) || minWidthPx <= 0) return 1;
  if (!Number.isFinite(trackWidthPx) || trackWidthPx <= 0) return 1;
  const numerator = minWidthPx + gapPx;
  const denominator = trackWidthPx + gapPx;
  return Math.max(1, Math.ceil(numerator / denominator));
}

export function computeGridColumnCount(args: {
  containerWidth: number;
  tileCount: number;
  minTileWidth: number;
  gapPx?: number;
}): number {
  const {
    containerWidth,
    tileCount,
    minTileWidth,
    gapPx = GRID_GAP_PX,
  } = args;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0 || tileCount <= 0) return 1;
  const safeMinWidth = Math.max(1, Math.floor(minTileWidth));
  const maxColumns = Math.max(1, Math.min(tileCount, Math.floor((containerWidth + gapPx) / (safeMinWidth + gapPx))));
  if (maxColumns <= 1) {
    return maxColumns;
  }
  const minRows = Math.ceil(tileCount / maxColumns);
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    if (Math.ceil(tileCount / columns) === minRows) {
      return columns;
    }
  }
  return maxColumns;
}

export function readPackedGridSpan(
  layout: DockLayout,
  tileId: string,
  defaults: PackedGridSpan,
): PackedGridSpan {
  const rawColSpan = Number(layout[spanKey(tileId, "col")] ?? defaults.colSpan);
  const rawRowSpan = Number(layout[spanKey(tileId, "row")] ?? defaults.rowSpan);
  return {
    colSpan: Number.isFinite(rawColSpan) ? rawColSpan : defaults.colSpan,
    rowSpan: Number.isFinite(rawRowSpan) ? rawRowSpan : defaults.rowSpan,
  };
}

export function clampPackedGridSpan(args: {
  span: PackedGridSpan;
  columnCount: number;
  minColSpan?: number;
  minRowSpan: number;
  maxRowSpan?: number;
}): PackedGridSpan {
  const {
    span,
    columnCount,
    minColSpan = 1,
    minRowSpan,
    maxRowSpan = GRID_MAX_ROW_SPAN,
  } = args;
  return {
    colSpan: Math.max(minColSpan, Math.min(columnCount, Math.round(span.colSpan || minColSpan))),
    rowSpan: Math.max(minRowSpan, Math.min(maxRowSpan, Math.round(span.rowSpan || minRowSpan))),
  };
}

export function reconcilePackedGridLayout(args: {
  layout: DockLayout;
  tileIds: string[];
  defaultSpansById: Record<string, PackedGridSpan>;
}): DockLayout {
  const { layout, tileIds, defaultSpansById } = args;
  const activeTileIds = new Set(tileIds);
  const next: DockLayout = {};

  // Preserve persisted spans for tiles not currently active
  for (const [key, value] of Object.entries(layout)) {
    const match = key.match(/^(.+):(col|row)$/);
    if (match && !activeTileIds.has(match[1])) {
      next[key] = value;
    }
  }

  // Reconcile active tiles with defaults
  for (const tileId of tileIds) {
    const defaults = defaultSpansById[tileId] ?? { colSpan: 1, rowSpan: 1 };
    const persistedColSpan = Number(layout[spanKey(tileId, "col")]);
    const persistedRowSpan = Number(layout[spanKey(tileId, "row")]);
    next[spanKey(tileId, "col")] = Number.isFinite(persistedColSpan) ? persistedColSpan : defaults.colSpan;
    next[spanKey(tileId, "row")] = Number.isFinite(persistedRowSpan) ? persistedRowSpan : defaults.rowSpan;
  }
  return next;
}

function canPlaceAt(
  occupied: Set<string>,
  column: number,
  row: number,
  colSpan: number,
  rowSpan: number,
  columnCount: number,
): boolean {
  if (column + colSpan - 1 > columnCount) return false;
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
      const key = `${row + rowOffset}:${column + colOffset}`;
      if (occupied.has(key)) return false;
    }
  }
  return true;
}

function occupy(
  occupied: Set<string>,
  column: number,
  row: number,
  colSpan: number,
  rowSpan: number,
): void {
  for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
    for (let colOffset = 0; colOffset < colSpan; colOffset += 1) {
      occupied.add(`${row + rowOffset}:${column + colOffset}`);
    }
  }
}

export function packGridItems(items: PackedGridItem[], columnCount: number): {
  placements: PackedGridPlacement[];
  totalRows: number;
} {
  const clampedColumnCount = Math.max(1, Math.floor(Number(columnCount) || 0));
  const placements: PackedGridPlacement[] = [];
  const occupied = new Set<string>();
  let totalRows = 0;

  for (const item of items) {
    const colSpan = Math.max(1, Math.min(clampedColumnCount, item.span.colSpan));
    const rowSpan = Math.max(item.minRowSpan, item.span.rowSpan);
    let placed = false;
    let row = 1;

    while (!placed) {
      for (let column = 1; column <= clampedColumnCount; column += 1) {
        if (!canPlaceAt(occupied, column, row, colSpan, rowSpan, clampedColumnCount)) continue;
        occupy(occupied, column, row, colSpan, rowSpan);
        placements.push({
          id: item.id,
          column,
          row,
          colSpan,
          rowSpan,
        });
        totalRows = Math.max(totalRows, row + rowSpan - 1);
        placed = true;
        break;
      }
      row += 1;
    }
  }

  return {
    placements,
    totalRows,
  };
}

export function computePackedGridRowHeight(args: {
  containerHeight: number;
  totalRows: number;
  gapPx?: number;
  baseRowPx?: number;
}): number {
  const {
    containerHeight,
    totalRows,
    gapPx = GRID_GAP_PX,
    baseRowPx = GRID_BASE_ROW_PX,
  } = args;
  if (!Number.isFinite(containerHeight) || containerHeight <= 0 || totalRows <= 0) return baseRowPx;
  const available = (containerHeight - gapPx * Math.max(0, totalRows - 1)) / totalRows;
  return Math.max(baseRowPx, Math.floor(available));
}

export function computePackedSpanPixels(span: number, unitPx: number, gapPx = GRID_GAP_PX): number {
  return span * unitPx + Math.max(0, span - 1) * gapPx;
}
