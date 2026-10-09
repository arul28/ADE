import type { HomeLayoutCell, HomeLayoutItem, HomeWidgetSize, HomeWidgetType } from "./homeLayout";

/**
 * Lays out the home page's widgets so they never scroll, leave no gaps
 * between cards, and keep the card sizes each widget was tuned for.
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
 *
 * Rows do not stretch to the window. A row is as tall as the tallest ideal
 * height its cards ask for, never taller than the smallest maximum any card
 * allows, never taller than the page, and never shorter than what a card
 * needs to show its controls. A card only grows into the cells below it while
 * it stays within its maximum. Height the rows do not use is left to the
 * wallpaper under the grid: more room means room for more widgets, not
 * bigger cards.
 *
 * Widths go in half columns. Every column is two tracks; a class spans whole
 * columns, so a page with no narrow widget packs exactly as whole columns
 * would. A widget the user marks narrow is at most a column and a half wide:
 * a two-column class shows at one and a half, a one-column class grows by
 * half a column at most. It sits so the room it leaves is beside the widget
 * placed before it, which grows into it. It only goes wider when nothing else
 * can fill the room (no holes, ever). Leftover room is handed out half a
 * column at a time, so two neighbours share a free column.
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
  /** The card height (px, at the class's own span) it looks best at, per class. */
  idealHeight: Partial<Record<HomeSizeClass, number>>;
  /** Tallest the card gets (px, at the class's own span) before it reads as empty, per class. */
  maxHeight: Partial<Record<HomeSizeClass, number>>;
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
  /** Column and width in columns; a narrow widget (or a neighbour that took its room) can sit on a half column. */
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
  /** Cells widgets grew into past their own span (stretched cards). */
  grown: number;
  rows: number;
  /** Height of every row, px. Rows may total less than the page; the rest stays empty. */
  rowPx: number;
  /** Columns used: no more than the widgets need, so a wide window never stretches a card to fill one. */
  columns: number;
  /** The grid's width at that many columns, px. */
  width: number;
};

type ShapeOf = (type: HomeWidgetType) => WidgetShape;

function rowPx(rows: number, height: number): number {
  return (height - (rows - 1) * GRID_GAP) / rows;
}

/** The room each widget stacked under a host takes, px. */
function stackedPx(cell: HomeLayoutCell, shapeOf: ShapeOf): number {
  return cell.stacked.reduce((sum, item) => {
    const stackedShape = shapeOf(item.type);
    return sum + GRID_GAP + Math.round((stackedShape.minHeight.compact ?? 160) * 0.75);
  }, 0);
}

/** Height a cell needs, px: the host's minimum plus a share for each stacked widget. */
function cellNeedPx(cell: HomeLayoutCell, cls: HomeSizeClass, shapeOf: ShapeOf): number {
  return (shapeOf(cell.host.type).minHeight[cls] ?? 180) + stackedPx(cell, shapeOf);
}

/**
 * The row height a set of placements settles at: the tallest per-row ideal,
 * held under the smallest per-row maximum and the page's own row height, and
 * never under any card's minimum.
 */
function settleRowPx(placed: readonly Placement[], fillPx: number, shapeOf: ShapeOf): number {
  if (placed.length === 0) return fillPx;
  let floor = 0;
  let target = 0;
  let cap = Number.POSITIVE_INFINITY;
  for (const p of placed) {
    const shape = shapeOf(p.cell.host.type);
    const stack = stackedPx(p.cell, shapeOf);
    const perRow = (cardPx: number) => (cardPx + stack - (p.h - 1) * GRID_GAP) / p.h;
    floor = Math.max(floor, perRow(shape.minHeight[p.cls] ?? 180));
    target = Math.max(target, perRow(shape.idealHeight[p.cls] ?? shape.minHeight[p.cls] ?? 180));
    const max = shape.maxHeight[p.cls];
    if (max != null) cap = Math.min(cap, perRow(max));
  }
  return Math.min(fillPx, Math.max(floor, Math.min(target, cap)));
}

/** A narrow widget's widest, in tracks (half columns): a column and a half. */
const NARROW_TRACKS = 3;

type Dir = "down" | "right" | "up" | "left";
const GROW_ORDER: readonly Dir[] = ["down", "right", "up", "left"];

function packInto(cells: readonly HomeLayoutCell[], columns: number, rows: number, height: number, shapeOf: ShapeOf): PackResult {
  // Two tracks per column (see the header): x and w are in tracks until the end.
  const tracks = columns * 2;
  const owner: number[][] = Array.from({ length: rows }, () => Array<number>(tracks).fill(-1));
  const px = rowPx(rows, height);
  const placed: Placement[] = [];
  const hidden: HomeLayoutCell[] = [];
  let shrunk = 0;
  const spanPx = (h: number) => h * px + (h - 1) * GRID_GAP;
  const freeAt = (x: number, y: number, w: number, h: number) => {
    if (x < 0 || x + w > tracks || y + h > rows) return false;
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) if (owner[y + dy]![x + dx]! >= 0) return false;
    return true;
  };
  const findSpot = (w: number, h: number, narrow: boolean) => {
    for (let y = 0; y + h <= rows; y += 1) {
      for (let x = 0; x + w <= tracks; x += 1) {
        if (!freeAt(x, y, w, h)) continue;
        // A narrow widget leaves the half column it gives up on its left,
        // beside the widget placed before it, which grows into it; not at the
        // page's left edge, where nothing could.
        if (narrow && x > 0 && freeAt(x + w, y, 1, h)) return { x: x + 1, y };
        return { x, y };
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
      const cols = Math.min(span.w, columns);
      const w = cell.host.narrow ? Math.min(cols * 2, NARROW_TRACKS) : cols * 2;
      let h = Math.min(span.h, rows);
      const need = cellNeedPx(cell, cls, shapeOf);
      // Taller than its shape when the content would not fit this row height.
      while (h < rows && spanPx(h) < need) h += 1;
      if (spanPx(h) < need - 0.5) continue;
      const spot = findSpot(w, h, cell.host.narrow === true);
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
  // A card takes a row below or above only while it stays within its own
  // maximum at the height the rows are settling at.
  const settlingPx = settleRowPx(placed, px, shapeOf);
  const edgeFree = (p: Placement, dir: Dir): boolean => {
    if (dir === "down" || dir === "up") {
      const y = dir === "down" ? p.y + p.h : p.y - 1;
      if (y < 0 || y >= rows) return false;
      const max = shapeOf(p.cell.host.type).maxHeight[p.cls];
      if (max != null && (p.h + 1) * settlingPx + p.h * GRID_GAP > max + stackedPx(p.cell, shapeOf) + 0.5) return false;
      for (let x = p.x; x < p.x + p.w; x += 1) if (owner[y]![x]! >= 0) return false;
      return true;
    }
    const x = dir === "right" ? p.x + p.w : p.x - 1;
    if (x < 0 || x >= tracks) return false;
    for (let y = p.y; y < p.y + p.h; y += 1) if (owner[y]![x]! >= 0) return false;
    return true;
  };
  let grown = 0;
  const grow = (index: number, dir: Dir) => {
    const p = placed[index]!;
    grown += dir === "down" || dir === "up" ? p.w : p.h;
    if (dir === "down") p.h += 1;
    else if (dir === "up") { p.y -= 1; p.h += 1; }
    else if (dir === "right") p.w += 1;
    else { p.x -= 1; p.w += 1; }
    for (let dy = 0; dy < p.h; dy += 1) for (let dx = 0; dx < p.w; dx += 1) owner[p.y + dy]![p.x + dx] = index;
  };
  // Widgets that use room well first, then any; a narrow widget grows
  // sideways past a column and a half only in the last pass, when nothing
  // else could fill the room.
  const passes = [{ growersOnly: true, narrowSideways: false }, { growersOnly: false, narrowSideways: false }, { growersOnly: false, narrowSideways: true }];
  for (const { growersOnly, narrowSideways } of passes) {
    for (let changed = true; changed;) {
      changed = false;
      placed.forEach((p, index) => {
        if (growersOnly && !shapeOf(p.cell.host.type).grow) return;
        const sideways = narrowSideways || !p.cell.host.narrow || p.w < NARROW_TRACKS;
        const dir = GROW_ORDER.find((candidate) => (sideways || candidate === "down" || candidate === "up") && edgeFree(p, candidate));
        if (dir) {
          grow(index, dir);
          changed = true;
        }
      });
    }
  }
  let holes = 0;
  const used = placed.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  for (let y = 0; y < used; y += 1) for (let x = 0; x < tracks; x += 1) if (owner[y]![x]! < 0) holes += 1;
  for (const p of placed) {
    p.x /= 2;
    p.w /= 2;
  }
  return { placed, hidden, holes, shrunk, rows: Math.max(1, used), rowPx: settleRowPx(placed, px, shapeOf), columns, width: 0, grown };
}

/** The grid's width at a column count, held to the room the page has. */
function widthFor(columns: number, available: number): number {
  return Math.min(available, columns * (columns >= 4 ? COL_MAX_WIDE : COL_MAX) + (columns - 1) * GRID_GAP);
}

/**
 * The best packing over every column and row count that fits: fewest hidden,
 * then fewest shrunk, then no empty cells, then the least stretching, then
 * fewest rows, then the most columns. Columns step down from what the page offers to the shipped
 * page's three, so a few widgets on a wide window keep their size in a
 * narrower, centred grid instead of stretching or leaving holes. At least two
 * rows when they fit, so one small widget is not stretched page-tall.
 */
export function packLayout(cells: readonly HomeLayoutCell[], metrics: Pick<GridMetrics, "columns" | "maxRows" | "height" | "width">, shapeOf: ShapeOf): PackResult {
  if (cells.length === 0) {
    return { placed: [], hidden: [], holes: 0, shrunk: 0, grown: 0, rows: 1, rowPx: rowPx(1, metrics.height), columns: metrics.columns, width: metrics.width };
  }
  let best: PackResult | null = null;
  const score = (r: PackResult) => [r.hidden.length, r.shrunk, r.holes > 0 ? 1 : 0, r.grown, r.rows, -r.columns];
  const better = (a: PackResult, b: PackResult) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sa[i]! < sb[i]!;
    return false;
  };
  const perfect = (r: PackResult) => r.hidden.length === 0 && r.shrunk === 0 && r.holes === 0 && r.grown === 0;
  const minRows = Math.min(2, metrics.maxRows);
  for (let columns = metrics.columns; columns >= Math.min(3, metrics.columns); columns -= 1) {
    for (let rows = minRows; rows <= metrics.maxRows; rows += 1) {
      const result = packInto(cells, columns, rows, metrics.height, shapeOf);
      // A result only ever uses the rows it fills; pack the page to that many.
      const settled = result.rows === rows ? result : packInto(cells, columns, Math.max(result.rows, minRows), metrics.height, shapeOf);
      settled.width = columns === metrics.columns ? metrics.width : widthFor(columns, metrics.width);
      if (!best || better(settled, best)) best = settled;
      if (perfect(settled)) break;
    }
    if (best && perfect(best)) break;
  }
  return best!;
}

/** A shape's span for a class, clamped to the grid. */
export function classSpan(shape: WidgetShape, cls: HomeSizeClass, columns = MAX_COLUMNS): Span {
  const span = shape.classes[cls] ?? shape.classes.regular ?? { w: 1, h: 1 };
  return { w: Math.min(span.w, columns), h: span.h };
}
