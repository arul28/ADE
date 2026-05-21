export type MultiViewTile = { sessionId: string; laneId: string };
export type MultiViewState = { tiles: MultiViewTile[]; focusedIndex: number };
export type TileRect = { x: number; y: number; w: number; h: number };

type TilePattern = {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  rows: number;
  cols: number;
};

export const MIN_MULTI_CHAT_TILE_WIDTH = 30;
export const MIN_MULTI_CHAT_TILE_HEIGHT = 8;

const PATTERNS: Record<1 | 2 | 3 | 4 | 5 | 6, ReadonlyArray<TilePattern>> = {
  1: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 1 }],
  2: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 2 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 1, cols: 2 },
  ],
  3: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
    { row: 0, col: 2, rowSpan: 1, colSpan: 1, rows: 1, cols: 3 },
  ],
  4: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 2 },
  ],
  5: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 3, rows: 2, cols: 6 },
    { row: 0, col: 3, rowSpan: 1, colSpan: 3, rows: 2, cols: 6 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
    { row: 1, col: 2, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
    { row: 1, col: 4, rowSpan: 1, colSpan: 2, rows: 2, cols: 6 },
  ],
  6: [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 0, col: 2, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 0, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
    { row: 1, col: 2, rowSpan: 1, colSpan: 1, rows: 2, cols: 3 },
  ],
};

export function asTileCount(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const normalized = Math.floor(Number.isFinite(value) ? value : 1);
  if (normalized <= 1) return 1;
  if (normalized >= 6) return 6;
  return normalized as 1 | 2 | 3 | 4 | 5 | 6;
}

export function computeTileRects(n: 1 | 2 | 3 | 4 | 5 | 6, width: number, height: number): TileRect[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const pattern = PATTERNS[n];
  const cols = pattern[0]?.cols ?? 1;
  const rows = pattern[0]?.rows ?? 1;
  const colW = Math.max(1, Math.floor(safeWidth / cols));
  const rowH = Math.max(1, Math.floor(safeHeight / rows));
  return pattern.map((tile) => ({
    x: tile.col * colW,
    y: tile.row * rowH,
    w: tile.colSpan * colW,
    h: tile.rowSpan * rowH,
  }));
}

export function canRenderMultiChatGrid(count: number, width: number, height: number): boolean {
  const tileCount = asTileCount(count);
  const rects = computeTileRects(tileCount, width, height);
  return rects.every((rect) => rect.w >= MIN_MULTI_CHAT_TILE_WIDTH && rect.h >= MIN_MULTI_CHAT_TILE_HEIGHT);
}

export function focusedSessionIdForMultiView(multiView: MultiViewState | null): string | null {
  if (!multiView) return null;
  return multiView.tiles[multiView.focusedIndex]?.sessionId ?? null;
}
