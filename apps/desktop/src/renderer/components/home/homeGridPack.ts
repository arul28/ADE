import type { HomeLayoutCell, HomeLayoutItem, HomeWidgetSize, HomeWidgetType } from "./homeLayout";

/**
 * Lays out the home page's widgets so they fill the page with no gaps and
 * never scroll.
 *
 * The page's size decides the grid: as many columns as fit at a comfortable
 * width (wider windows get more columns) and up to as many rows as fit at a
 * usable height. The user picks the widgets, a size class for each (Compact,
 * Regular, Large; each widget says what shape a class is, and how tall its
 * content needs to be), and their order, which is their priority.
 *
 * For each row count that fits, widgets go in, in order, at the first free
 * spot that holds their shape. A widget whose shape has no room tries its
 * smaller classes before it is hidden. Then every empty cell is handed to a
 * neighbour: widgets that use more room well (lists, charts) grow first, one
 * cell edge at a time and in turn, then any widget may. The result with the
 * fewest hidden widgets, then the fewest shrunk ones, then no empty cells,
 * then the fewest rows wins. Every cell of a row shares the row's height, so
 * rows are always even. Packing depends only on its inputs: the same layout
 * and window always give the same page.
 */

export const GRID_GAP = 12;
/** Narrowest a column gets before the grid drops to fewer columns. */
export const COL_MIN = 360;
/**
 * Widest a column gets. Three columns keep the shipped page's width (the
 * default layout looks as it always did); from four up a column may stretch
 * further, so a wide window is filled instead of framed by empty margins.
 */
export const COL_MAX = 372;
export const COL_MAX_WIDE = 470;
/** Shortest a row gets before the grid stops offering another row. */
export const ROW_MIN = 180;
export const MAX_COLUMNS = 6;

export type HomeSizeClass = "compact" | "regular" | "large";
export const HOME_SIZE_CLASSES: readonly HomeSizeClass[] = ["compact", "regular", "large"];

export type Span = { w: number; h: number };

/** How a widget takes space: its shape per size class, and how tall its content needs to be. */
export type WidgetShape = {
  /** The classes the widget offers, as columns × rows. */
  classes: Partial<Record<HomeSizeClass, Span>>;
  /** Smallest card height (px, header included) that shows every control, per class. */
  minHeight: Partial<Record<HomeSizeClass, number>>;
  /** Uses extra room well (lists show more rows, charts get bigger): first in line for leftover cells. */
  grow: boolean;
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
  const width = Math.min(availableWidth, columns * (columns >= 4 ? COL_MAX_WIDE : COL_MAX) + (columns - 1) * GRID_GAP);
  const maxRows = Math.max(1, Math.floor((availableHeight + GRID_GAP) / (ROW_MIN + GRID_GAP)));
  return { columns, maxRows, width, height: availableHeight };
}

/** The class a stored size reads as: S is Compact, M and Wide are Regular, L is Large. */
export function sizeClassOfSize(size: HomeWidgetSize): HomeSizeClass {
  return size === "s" ? "compact" : size === "l" ? "large" : "regular";
}

/** The classes a shape offers, smallest first. */
export function shapeClasses(shape: WidgetShape): HomeSizeClass[] {
  return HOME_SIZE_CLASSES.filter((cls) => shape.classes[cls] != null);
}

/** A widget's class: its stored size, or the nearest class it offers. */
export function itemSizeClass(item: Pick<HomeLayoutItem, "size">, shape: WidgetShape): HomeSizeClass {
  const wanted = sizeClassOfSize(item.size);
  if (shape.classes[wanted]) return wanted;
  const offered = shapeClasses(shape);
  const rank = HOME_SIZE_CLASSES.indexOf(wanted);
  return offered.reduce((best, cls) => (Math.abs(HOME_SIZE_CLASSES.indexOf(cls) - rank) < Math.abs(HOME_SIZE_CLASSES.indexOf(best) - rank) ? cls : best), offered[0] ?? "compact");
}

/** The size older builds read for a class: Regular is stored as tall (M) or wide (W) by its shape. */
export function storedSizeFor(cls: HomeSizeClass, shape: WidgetShape): HomeWidgetSize {
  if (cls === "compact") return "s";
  if (cls === "large") return "l";
  const span = shape.classes.regular ?? { w: 1, h: 2 };
  return span.w >= 2 && span.h < 2 ? "w" : "m";
}

export type Placement = {
  cell: HomeLayoutCell;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The class the widget is shown at (smaller than asked when its own had no room). */
  cls: HomeSizeClass;
};

export type PackResult = {
  placed: Placement[];
  hidden: HomeLayoutCell[];
  /** Cells nothing could grow into (rare: a pinwheel of mismatched spans). */
  holes: number;
  /** Widgets shown at a smaller class than asked. */
  shrunk: number;
  rows: number;
};

type ShapeOf = (type: HomeWidgetType) => WidgetShape;

function rowPx(rows: number, height: number): number {
  return (height - (rows - 1) * GRID_GAP) / rows;
}

/** Height a cell needs, px: the host's minimum plus a share for each stacked widget. */
function cellNeedPx(cell: HomeLayoutCell, cls: HomeSizeClass, shapeOf: ShapeOf): number {
  const shape = shapeOf(cell.host.type);
  const host = shape.minHeight[cls] ?? 180;
  return host + cell.stacked.reduce((sum, item) => {
    const stackedShape = shapeOf(item.type);
    return sum + GRID_GAP + Math.round((stackedShape.minHeight.compact ?? 160) * 0.75);
  }, 0);
}

type Dir = "down" | "right" | "up" | "left";
const GROW_ORDER: readonly Dir[] = ["down", "right", "up", "left"];

function packInto(cells: readonly HomeLayoutCell[], columns: number, rows: number, height: number, shapeOf: ShapeOf): PackResult {
  const owner: number[][] = Array.from({ length: rows }, () => Array<number>(columns).fill(-1));
  const px = rowPx(rows, height);
  const placed: Placement[] = [];
  const hidden: HomeLayoutCell[] = [];
  let shrunk = 0;
  const spanPx = (h: number) => h * px + (h - 1) * GRID_GAP;
  const findSpot = (w: number, h: number) => {
    for (let y = 0; y + h <= rows; y += 1) {
      for (let x = 0; x + w <= columns; x += 1) {
        let free = true;
        for (let dy = 0; dy < h && free; dy += 1) for (let dx = 0; dx < w && free; dx += 1) if (owner[y + dy]![x + dx]! >= 0) free = false;
        if (free) return { x, y };
      }
    }
    return null;
  };

  for (const cell of cells) {
    const shape = shapeOf(cell.host.type);
    const asked = itemSizeClass(cell.host, shape);
    // The asked class first, then the smaller ones the widget offers.
    const candidates = shapeClasses(shape).filter((cls) => HOME_SIZE_CLASSES.indexOf(cls) <= HOME_SIZE_CLASSES.indexOf(asked)).reverse();
    let done = false;
    for (const cls of candidates) {
      const span = shape.classes[cls]!;
      const w = Math.min(span.w, columns);
      let h = Math.min(span.h, rows);
      const need = cellNeedPx(cell, cls, shapeOf);
      // Taller than its shape when the content would not fit this row height.
      while (h < rows && spanPx(h) < need) h += 1;
      if (spanPx(h) < need - 0.5) continue;
      const spot = findSpot(w, h);
      if (!spot) continue;
      const index = placed.length;
      for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) owner[spot.y + dy]![spot.x + dx] = index;
      placed.push({ cell, x: spot.x, y: spot.y, w, h, cls });
      if (cls !== asked) shrunk += 1;
      done = true;
      break;
    }
    if (!done) hidden.push(cell);
  }

  // Hand every empty cell to a neighbour. One edge per widget per pass, in
  // turn, so leftover room is shared rather than swallowed by the first card.
  const edgeFree = (p: Placement, dir: Dir): boolean => {
    if (dir === "down" || dir === "up") {
      const y = dir === "down" ? p.y + p.h : p.y - 1;
      if (y < 0 || y >= rows) return false;
      for (let x = p.x; x < p.x + p.w; x += 1) if (owner[y]![x]! >= 0) return false;
      return true;
    }
    const x = dir === "right" ? p.x + p.w : p.x - 1;
    if (x < 0 || x >= columns) return false;
    for (let y = p.y; y < p.y + p.h; y += 1) if (owner[y]![x]! >= 0) return false;
    return true;
  };
  const grow = (index: number, dir: Dir) => {
    const p = placed[index]!;
    if (dir === "down") p.h += 1;
    else if (dir === "up") { p.y -= 1; p.h += 1; }
    else if (dir === "right") p.w += 1;
    else { p.x -= 1; p.w += 1; }
    for (let dy = 0; dy < p.h; dy += 1) for (let dx = 0; dx < p.w; dx += 1) owner[p.y + dy]![p.x + dx] = index;
  };
  for (const growersOnly of [true, false]) {
    for (let changed = true; changed;) {
      changed = false;
      placed.forEach((p, index) => {
        if (growersOnly && !shapeOf(p.cell.host.type).grow) return;
        const dir = GROW_ORDER.find((candidate) => edgeFree(p, candidate));
        if (dir) {
          grow(index, dir);
          changed = true;
        }
      });
    }
  }
  let holes = 0;
  const used = placed.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  for (let y = 0; y < used; y += 1) for (let x = 0; x < columns; x += 1) if (owner[y]![x]! < 0) holes += 1;
  return { placed, hidden, holes, shrunk, rows: Math.max(1, used) };
}

/**
 * The best packing over every row count that fits: fewest hidden, then fewest
 * shrunk, then fewest empty cells, then fewest rows (taller cards). At least
 * two rows when they fit, so one small widget is not stretched page-tall.
 */
export function packLayout(cells: readonly HomeLayoutCell[], metrics: Pick<GridMetrics, "columns" | "maxRows" | "height">, shapeOf: ShapeOf): PackResult {
  if (cells.length === 0) return { placed: [], hidden: [], holes: 0, shrunk: 0, rows: 1 };
  let best: PackResult | null = null;
  const score = (r: PackResult) => [r.hidden.length, r.shrunk, r.holes > 0 ? 1 : 0, r.rows];
  const better = (a: PackResult, b: PackResult) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sa[i]! < sb[i]!;
    return false;
  };
  for (let rows = Math.min(2, metrics.maxRows); rows <= metrics.maxRows; rows += 1) {
    const result = packInto(cells, metrics.columns, rows, metrics.height, shapeOf);
    // A result only ever uses the rows it fills; pack the page to that many.
    const settled = result.rows === rows ? result : packInto(cells, metrics.columns, Math.max(result.rows, Math.min(2, metrics.maxRows)), metrics.height, shapeOf);
    if (!best || better(settled, best)) best = settled;
    if (settled.hidden.length === 0 && settled.shrunk === 0 && settled.holes === 0) break;
  }
  return best!;
}

/** A shape's span for a class, clamped to the grid. */
export function classSpan(shape: WidgetShape, cls: HomeSizeClass, columns = MAX_COLUMNS): Span {
  const span = shape.classes[cls] ?? shape.classes.regular ?? { w: 1, h: 1 };
  return { w: Math.min(span.w, columns), h: span.h };
}
