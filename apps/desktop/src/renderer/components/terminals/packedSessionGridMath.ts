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
  placement?: {
    column: number;
    row: number;
  };
};

export type PackedGridPlacementMap = Record<string, PackedGridPlacement>;

function layoutKey(id: string, suffix: string): string {
  return `${id}:${suffix}`;
}

function spanKey(id: string, axis: "col" | "row"): string {
  return layoutKey(id, axis);
}

function placementKey(id: string, axis: "colStart" | "rowStart" | "colSpan" | "rowSpan"): string {
  return layoutKey(id, axis);
}

function readLayoutNumber(layout: DockLayout, key: string): number | null {
  const raw = layout[key];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function placementRight(rect: PackedGridPlacement): number {
  return rect.column + rect.colSpan;
}

function placementBottom(rect: PackedGridPlacement): number {
  return rect.row + rect.rowSpan;
}

function overlapsRows(left: PackedGridPlacement, right: PackedGridPlacement): boolean {
  return left.row < placementBottom(right) && right.row < placementBottom(left);
}

function overlapsColumns(left: PackedGridPlacement, right: PackedGridPlacement): boolean {
  return left.column < placementRight(right) && right.column < placementRight(left);
}

function clonePlacementMap(placementsById: PackedGridPlacementMap): PackedGridPlacementMap {
  const next: PackedGridPlacementMap = {};
  for (const [tileId, placement] of Object.entries(placementsById)) {
    next[tileId] = { ...placement };
  }
  return next;
}

function boundaryExpansionLimit(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  axis: "horizontal" | "vertical";
  edge: "start" | "end";
  columnCount: number;
  minColSpans: Record<string, number>;
  minRowSpans: Record<string, number>;
  maxRowSpan: number;
}): number {
  const active = args.placementsById[args.tileId];
  if (!active) return 0;

  if (args.axis === "horizontal") {
    if (args.edge === "end") {
      let allowed = args.columnCount + 1 - placementRight(active);
      for (const [otherId, other] of Object.entries(args.placementsById)) {
        if (otherId === args.tileId || !overlapsRows(active, other) || other.column < placementRight(active)) continue;
        const gap = other.column - placementRight(active);
        if (gap === 0) {
          allowed = Math.min(allowed, Math.max(0, other.colSpan - (args.minColSpans[otherId] ?? 1)));
        } else {
          allowed = Math.min(allowed, gap);
        }
      }
      return Math.max(0, allowed);
    }

    let allowed = active.column - 1;
    for (const [otherId, other] of Object.entries(args.placementsById)) {
      if (otherId === args.tileId || !overlapsRows(active, other) || placementRight(other) > active.column) continue;
      const gap = active.column - placementRight(other);
      if (gap === 0) {
        allowed = Math.min(allowed, Math.max(0, other.colSpan - (args.minColSpans[otherId] ?? 1)));
      } else {
        allowed = Math.min(allowed, gap);
      }
    }
    return Math.max(0, allowed);
  }

  if (args.edge === "end") {
    let allowed = Math.max(0, args.maxRowSpan - active.rowSpan);
    for (const [otherId, other] of Object.entries(args.placementsById)) {
      if (otherId === args.tileId || !overlapsColumns(active, other) || other.row < placementBottom(active)) continue;
      const gap = other.row - placementBottom(active);
      if (gap === 0) {
        allowed = Math.min(allowed, Math.max(0, other.rowSpan - (args.minRowSpans[otherId] ?? 1)));
      } else {
        allowed = Math.min(allowed, gap);
      }
    }
    return Math.max(0, allowed);
  }

  let allowed = Math.min(active.row - 1, Math.max(0, args.maxRowSpan - active.rowSpan));
  for (const [otherId, other] of Object.entries(args.placementsById)) {
    if (otherId === args.tileId || !overlapsColumns(active, other) || placementBottom(other) > active.row) continue;
    const gap = active.row - placementBottom(other);
    if (gap === 0) {
      allowed = Math.min(allowed, Math.max(0, other.rowSpan - (args.minRowSpans[otherId] ?? 1)));
    } else {
      allowed = Math.min(allowed, gap);
    }
  }
  return Math.max(0, allowed);
}

function moveEastEdge(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  delta: number;
  columnCount: number;
  minColSpans: Record<string, number>;
}): void {
  if (args.delta === 0) return;
  const active = args.placementsById[args.tileId];
  if (!active) return;
  const oldRight = placementRight(active);
  const contiguousNeighbors = Object.values(args.placementsById).filter(
    (other) => other.id !== args.tileId && other.column === oldRight && overlapsRows(active, other),
  );

  if (args.delta > 0) {
    const allowed = Math.min(
      args.delta,
      boundaryExpansionLimit({
        placementsById: args.placementsById,
        tileId: args.tileId,
        axis: "horizontal",
        edge: "end",
        columnCount: args.columnCount,
        minColSpans: args.minColSpans,
        minRowSpans: {},
        maxRowSpan: GRID_MAX_ROW_SPAN,
      }),
    );
    if (allowed <= 0) return;
    active.colSpan += allowed;
    for (const neighbor of contiguousNeighbors) {
      neighbor.column += allowed;
      neighbor.colSpan -= allowed;
    }
    return;
  }

  const minActiveColSpan = args.minColSpans[args.tileId] ?? 1;
  const allowed = Math.min(-args.delta, Math.max(0, active.colSpan - minActiveColSpan));
  if (allowed <= 0) return;
  active.colSpan -= allowed;
  for (const neighbor of contiguousNeighbors) {
    neighbor.column -= allowed;
    neighbor.colSpan += allowed;
  }
}

function moveWestEdge(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  delta: number;
  columnCount: number;
  minColSpans: Record<string, number>;
}): void {
  if (args.delta === 0) return;
  const active = args.placementsById[args.tileId];
  if (!active) return;
  const oldLeft = active.column;
  const contiguousNeighbors = Object.values(args.placementsById).filter(
    (other) => other.id !== args.tileId && placementRight(other) === oldLeft && overlapsRows(active, other),
  );

  if (args.delta > 0) {
    const minActiveColSpan = args.minColSpans[args.tileId] ?? 1;
    const allowed = Math.min(args.delta, Math.max(0, active.colSpan - minActiveColSpan));
    if (allowed <= 0) return;
    active.column += allowed;
    active.colSpan -= allowed;
    for (const neighbor of contiguousNeighbors) {
      neighbor.colSpan += allowed;
    }
    return;
  }

  const allowed = Math.min(
    -args.delta,
    boundaryExpansionLimit({
      placementsById: args.placementsById,
      tileId: args.tileId,
      axis: "horizontal",
      edge: "start",
      columnCount: args.columnCount,
      minColSpans: args.minColSpans,
      minRowSpans: {},
      maxRowSpan: GRID_MAX_ROW_SPAN,
    }),
  );
  if (allowed <= 0) return;
  active.column -= allowed;
  active.colSpan += allowed;
  for (const neighbor of contiguousNeighbors) {
    neighbor.colSpan -= allowed;
  }
}

function moveSouthEdge(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  delta: number;
  columnCount: number;
  minRowSpans: Record<string, number>;
  maxRowSpan: number;
}): void {
  if (args.delta === 0) return;
  const active = args.placementsById[args.tileId];
  if (!active) return;
  const oldBottom = placementBottom(active);
  const contiguousNeighbors = Object.values(args.placementsById).filter(
    (other) => other.id !== args.tileId && other.row === oldBottom && overlapsColumns(active, other),
  );

  if (args.delta > 0) {
    const allowed = Math.min(
      args.delta,
      boundaryExpansionLimit({
        placementsById: args.placementsById,
        tileId: args.tileId,
        axis: "vertical",
        edge: "end",
        columnCount: args.columnCount,
        minColSpans: {},
        minRowSpans: args.minRowSpans,
        maxRowSpan: args.maxRowSpan,
      }),
    );
    if (allowed <= 0) return;
    active.rowSpan += allowed;
    for (const neighbor of contiguousNeighbors) {
      neighbor.row += allowed;
      neighbor.rowSpan -= allowed;
    }
    return;
  }

  const minActiveRowSpan = args.minRowSpans[args.tileId] ?? 1;
  const allowed = Math.min(-args.delta, Math.max(0, active.rowSpan - minActiveRowSpan));
  if (allowed <= 0) return;
  active.rowSpan -= allowed;
  for (const neighbor of contiguousNeighbors) {
    neighbor.row -= allowed;
    neighbor.rowSpan += allowed;
  }
}

function moveNorthEdge(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  delta: number;
  columnCount: number;
  minRowSpans: Record<string, number>;
  maxRowSpan: number;
}): void {
  if (args.delta === 0) return;
  const active = args.placementsById[args.tileId];
  if (!active) return;
  const oldTop = active.row;
  const contiguousNeighbors = Object.values(args.placementsById).filter(
    (other) => other.id !== args.tileId && placementBottom(other) === oldTop && overlapsColumns(active, other),
  );

  if (args.delta > 0) {
    const minActiveRowSpan = args.minRowSpans[args.tileId] ?? 1;
    const allowed = Math.min(args.delta, Math.max(0, active.rowSpan - minActiveRowSpan));
    if (allowed <= 0) return;
    active.row += allowed;
    active.rowSpan -= allowed;
    for (const neighbor of contiguousNeighbors) {
      neighbor.rowSpan += allowed;
    }
    return;
  }

  const allowed = Math.min(
    -args.delta,
    boundaryExpansionLimit({
      placementsById: args.placementsById,
      tileId: args.tileId,
      axis: "vertical",
      edge: "start",
      columnCount: args.columnCount,
      minColSpans: {},
      minRowSpans: args.minRowSpans,
      maxRowSpan: args.maxRowSpan,
    }),
  );
  if (allowed <= 0) return;
  active.row -= allowed;
  active.rowSpan += allowed;
  for (const neighbor of contiguousNeighbors) {
    neighbor.rowSpan -= allowed;
  }
}

export function resizePackedGridItem(args: {
  placementsById: PackedGridPlacementMap;
  tileId: string;
  direction: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  deltaCols: number;
  deltaRows: number;
  columnCount: number;
  minColSpans: Record<string, number>;
  minRowSpans: Record<string, number>;
  maxRowSpan?: number;
}): PackedGridPlacementMap {
  const next = clonePlacementMap(args.placementsById);
  const maxRowSpan = args.maxRowSpan ?? GRID_MAX_ROW_SPAN;

  if (args.direction.includes("e")) {
    moveEastEdge({
      placementsById: next,
      tileId: args.tileId,
      delta: args.deltaCols,
      columnCount: args.columnCount,
      minColSpans: args.minColSpans,
    });
  } else if (args.direction.includes("w")) {
    moveWestEdge({
      placementsById: next,
      tileId: args.tileId,
      delta: args.deltaCols,
      columnCount: args.columnCount,
      minColSpans: args.minColSpans,
    });
  }

  if (args.direction.includes("s")) {
    moveSouthEdge({
      placementsById: next,
      tileId: args.tileId,
      delta: args.deltaRows,
      columnCount: args.columnCount,
      minRowSpans: args.minRowSpans,
      maxRowSpan,
    });
  } else if (args.direction.includes("n")) {
    moveNorthEdge({
      placementsById: next,
      tileId: args.tileId,
      delta: args.deltaRows,
      columnCount: args.columnCount,
      minRowSpans: args.minRowSpans,
      maxRowSpan,
    });
  }

  return next;
}

export function readPackedGridPlacement(
  layout: DockLayout,
  tileId: string,
): { column: number; row: number } | null {
  const column = readLayoutNumber(layout, placementKey(tileId, "colStart"));
  const row = readLayoutNumber(layout, placementKey(tileId, "rowStart"));
  if (column == null || row == null) return null;
  return { column, row };
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
  const rawColSpan = readLayoutNumber(layout, placementKey(tileId, "colSpan"))
    ?? readLayoutNumber(layout, spanKey(tileId, "col"))
    ?? defaults.colSpan;
  const rawRowSpan = readLayoutNumber(layout, placementKey(tileId, "rowSpan"))
    ?? readLayoutNumber(layout, spanKey(tileId, "row"))
    ?? defaults.rowSpan;
  return {
    colSpan: rawColSpan,
    rowSpan: rawRowSpan,
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
  columnCount: number;
}): DockLayout {
  const { layout, tileIds, defaultSpansById, columnCount } = args;
  const activeTileIds = new Set(tileIds);
  const next: DockLayout = {};

  for (const [key, value] of Object.entries(layout)) {
    const match = key.match(/^(.+):(col|row|colStart|rowStart|colSpan|rowSpan)$/);
    if (match && !activeTileIds.has(match[1])) {
      next[key] = value;
    }
  }

  const packed = packGridItems(
    tileIds.map((tileId) => ({
      id: tileId,
      minRowSpan: defaultSpansById[tileId]?.rowSpan ?? 1,
      span: readPackedGridSpan(layout, tileId, defaultSpansById[tileId] ?? { colSpan: 1, rowSpan: 1 }),
      placement: readPackedGridPlacement(layout, tileId) ?? undefined,
    })),
    columnCount,
  );

  for (const placement of packed.placements) {
    next[spanKey(placement.id, "col")] = placement.colSpan;
    next[spanKey(placement.id, "row")] = placement.rowSpan;
    next[placementKey(placement.id, "colStart")] = placement.column;
    next[placementKey(placement.id, "rowStart")] = placement.row;
    next[placementKey(placement.id, "colSpan")] = placement.colSpan;
    next[placementKey(placement.id, "rowSpan")] = placement.rowSpan;
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
  if (column < 1 || row < 1 || column + colSpan - 1 > columnCount) return false;
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

  const deferred: PackedGridItem[] = [];

  for (const item of items) {
    const colSpan = Math.max(1, Math.min(clampedColumnCount, item.span.colSpan));
    const rowSpan = Math.max(item.minRowSpan, item.span.rowSpan);
    const placement = item.placement;
    if (
      placement
      && Number.isFinite(placement.column)
      && Number.isFinite(placement.row)
      && canPlaceAt(occupied, Math.floor(placement.column), Math.floor(placement.row), colSpan, rowSpan, clampedColumnCount)
    ) {
      const column = Math.floor(placement.column);
      const row = Math.floor(placement.row);
      occupy(occupied, column, row, colSpan, rowSpan);
      placements.push({
        id: item.id,
        column,
        row,
        colSpan,
        rowSpan,
      });
      totalRows = Math.max(totalRows, row + rowSpan - 1);
      continue;
    }
    deferred.push({
      ...item,
      span: { colSpan, rowSpan },
    });
  }

  for (const item of deferred) {
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
