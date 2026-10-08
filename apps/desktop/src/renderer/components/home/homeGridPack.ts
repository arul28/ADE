import type { HomeLayoutCell, HomeLayoutItem, HomeWidgetSize, HomeWidgetType } from "./homeLayout";

/**
 * Places the home page's widgets in a grid that never scrolls.
 *
 * The page's size decides the grid: as many columns as fit at a comfortable
 * width (wider windows get more columns, never more rows than fit) and up to
 * as many rows as fit at a usable height. Widgets go in, in layout order, at
 * the first free spot that holds their span. Rows are chosen as the fewest
 * that hold everything, so a short layout still fills the page the way the
 * original home did; a widget that still has no room is hidden, and the page
 * says how many.
 *
 * A widget also declares the smallest height its content needs per size. A
 * span that would be shorter at the chosen row height grows taller within the
 * widget's limits, or the widget counts as not fitting.
 */

export const GRID_GAP = 12;
/** Narrowest a column gets before the grid drops to fewer columns. */
export const COL_MIN = 360;
/** Widest a column gets; past it, another column is offered instead. */
export const COL_MAX = 372;
/** Shortest a row gets before the grid stops offering another row. */
export const ROW_MIN = 180;
export const MAX_COLUMNS = 6;

export type WidgetLimits = {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
  /** Smallest card height (px, header included) that shows every control, per size class. */
  minHeight: Record<HomeWidgetSize, number>;
};

export type GridMetrics = {
  columns: number;
  /** Rows that fit the page at ROW_MIN. */
  maxRows: number;
  /** The grid's own width and height, px. */
  width: number;
  height: number;
};

export function gridMetrics(availableWidth: number, availableHeight: number): GridMetrics {
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor((availableWidth + GRID_GAP) / (COL_MIN + GRID_GAP))));
  const width = Math.min(availableWidth, columns * COL_MAX + (columns - 1) * GRID_GAP);
  const maxRows = Math.max(1, Math.floor((availableHeight + GRID_GAP) / (ROW_MIN + GRID_GAP)));
  return { columns, maxRows, width, height: availableHeight };
}

/** The size class a span reads as, for the per-size minimum heights. */
export function sizeClass(w: number, h: number): HomeWidgetSize {
  if (w >= 2 && h >= 2) return "l";
  if (w >= 2) return "w";
  if (h >= 2) return "m";
  return "s";
}

export function spanFromSize(size: HomeWidgetSize): { w: number; h: number } {
  return size === "s" ? { w: 1, h: 1 } : size === "m" ? { w: 1, h: 2 } : size === "w" ? { w: 2, h: 1 } : { w: 2, h: 2 };
}

/** A widget's span: its own cells when set, else its size preset. */
export function itemSpan(item: Pick<HomeLayoutItem, "size" | "w" | "h">): { w: number; h: number } {
  const base = spanFromSize(item.size);
  return { w: item.w ?? base.w, h: item.h ?? base.h };
}

export type Placement = {
  cell: HomeLayoutCell;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PackResult = {
  placed: Placement[];
  hidden: HomeLayoutCell[];
  /** Runs of empty cells, row by row (where a new widget would go). */
  free: Array<{ x: number; y: number; w: number }>;
  /** Rows the grid shows (the fewest that hold what fits). */
  rows: number;
};

type LimitsOf = (type: HomeWidgetType) => WidgetLimits;

function rowPx(rows: number, height: number): number {
  return (height - (rows - 1) * GRID_GAP) / rows;
}

/** Height a cell needs, px: the host's minimum plus a share for each stacked widget. */
function cellNeedPx(cell: HomeLayoutCell, w: number, h: number, limitsOf: LimitsOf): number {
  const host = limitsOf(cell.host.type).minHeight[sizeClass(w, h)];
  return host + cell.stacked.reduce((sum, item) => sum + GRID_GAP + Math.round(limitsOf(item.type).minHeight.s * 0.75), 0);
}

function packInto(cells: readonly HomeLayoutCell[], columns: number, rows: number, height: number, limitsOf: LimitsOf): PackResult {
  const taken: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(columns).fill(false));
  const px = rowPx(rows, height);
  const placed: Placement[] = [];
  const hidden: HomeLayoutCell[] = [];
  for (const cell of cells) {
    const limits = limitsOf(cell.host.type);
    const span = itemSpan(cell.host);
    const w = Math.max(limits.minW, Math.min(span.w, limits.maxW, columns));
    let h = Math.max(limits.minH, Math.min(span.h, limits.maxH));
    // Grow taller when the content would not fit this row height.
    while (h < Math.min(limits.maxH, rows) && h * px + (h - 1) * GRID_GAP < cellNeedPx(cell, w, h, limitsOf)) h += 1;
    if (w > columns || h > rows || h * px + (h - 1) * GRID_GAP < cellNeedPx(cell, w, h, limitsOf) - 0.5) {
      hidden.push(cell);
      continue;
    }
    let spot: { x: number; y: number } | null = null;
    for (let y = 0; y + h <= rows && !spot; y += 1) {
      for (let x = 0; x + w <= columns && !spot; x += 1) {
        let free = true;
        for (let dy = 0; dy < h && free; dy += 1) for (let dx = 0; dx < w && free; dx += 1) if (taken[y + dy]![x + dx]) free = false;
        if (free) spot = { x, y };
      }
    }
    if (!spot) {
      hidden.push(cell);
      continue;
    }
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) taken[spot.y + dy]![spot.x + dx] = true;
    placed.push({ cell, x: spot.x, y: spot.y, w, h });
  }
  const used = placed.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  const free: Array<{ x: number; y: number; w: number }> = [];
  for (let y = 0; y < rows; y += 1) {
    let start = -1;
    for (let x = 0; x <= columns; x += 1) {
      const open = x < columns && !taken[y]![x];
      if (open && start < 0) start = x;
      if (!open && start >= 0) {
        free.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  }
  return { placed, hidden, free, rows: Math.max(1, used) };
}

/**
 * The fewest rows (up to what fits) that place every widget; when none do,
 * the most rows that fit, hiding what is left over. Packing never depends on
 * anything but the inputs, so the same layout and window give the same page.
 */
export function packLayout(cells: readonly HomeLayoutCell[], metrics: Pick<GridMetrics, "columns" | "maxRows" | "height">, limitsOf: LimitsOf): PackResult {
  let best: PackResult | null = null;
  // At least two rows when they fit, so one small widget is not stretched page-tall.
  for (let rows = Math.min(2, metrics.maxRows); rows <= metrics.maxRows; rows += 1) {
    const result = packInto(cells, metrics.columns, rows, metrics.height, limitsOf);
    if (result.hidden.length === 0) return { ...result, rows };
    best = { ...result, rows };
  }
  return best ?? { placed: [], hidden: [...cells], free: [], rows: 1 };
}

/** Clamps a span to a widget's limits and the grid. */
export function clampSpan(type: HomeWidgetType, w: number, h: number, metrics: Pick<GridMetrics, "columns" | "maxRows">, limitsOf: LimitsOf): { w: number; h: number } {
  const limits = limitsOf(type);
  return {
    w: Math.max(limits.minW, Math.min(Math.round(w), limits.maxW, metrics.columns)),
    h: Math.max(limits.minH, Math.min(Math.round(h), limits.maxH, metrics.maxRows)),
  };
}
