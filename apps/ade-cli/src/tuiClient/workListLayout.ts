/**
 * Row geometry for the sessions pane — the single source of truth shared by the
 * renderer (`WorkSessionsPane.tsx`) and the terminal mouse handler (`app.tsx`).
 *
 * This is the same contract `drawerLayout.ts` held for the lane drawer, and it
 * exists for the same reason: the pane's rows are variable height (a session
 * card is always three lines, matching the desktop SessionCard),
 * so a click can only be resolved by replaying the exact placement the renderer
 * used. Render from `layout.placements`, hit-test against `layout.placements`,
 * and the two cannot drift.
 *
 * Row model, pane-local and 1-based:
 *
 *   row 1                 pane top border
 *   row 2 ..              placed rows, in `WorkListModel.rows` order:
 *                           lane-header  1 line (+1 blank above, except first)
 *                           session      3 lines + 1 blank above (except first)
 *                           shelf        1 line (+1 blank above)
 *
 * Pure: no React, no terminal, no clock.
 */

import type { WorkListRow } from "./workListModel";

/** Pane chrome above the first placed row: top border. Picker mode adds a title. */
export const WORK_LIST_HEADER_ROWS = 1;
/** Pane chrome below the last placed row: hint line + bottom border. */
const WORK_LIST_FOOTER_ROWS = 2;

export type WorkListPlacement = {
  /** Index into the model's flat `rows`. */
  index: number;
  key: string;
  /** Pane-local 1-based row of this entry's FIRST line (the blank margin is not part of it). */
  y: number;
  /** Lines the entry occupies, margin excluded. */
  height: number;
  /** Blank separator line rendered immediately above `y`. */
  marginTop: number;
  /**
   * First-line count that opens lane details on a singleton card. 0 for every
   * other entry — a grouped session's title line is still just the chat.
   */
  identityLines: number;
};

export type WorkListLayout = {
  /** Index of the first placed row (the scroll window's start). */
  start: number;
  placements: WorkListPlacement[];
  /** Rows scrolled off the top / bottom, for the "N more" affordances. */
  hiddenBefore: number;
  hiddenAfter: number;
  /** Usable lines for placed rows after chrome. */
  bodyRows: number;
};

/**
 * Lines one entry costs.
 *
 * A session card is always three lines — the desktop SessionCard is a fixed
 * 4.875rem block (where/status, title, preview+provider) and the TUI matches
 * that anatomy even when a field is empty, so hit-testing cannot drift.
 */
export function workListRowHeight(row: WorkListRow): number {
  return row.kind === "session" ? 3 : 1;
}

/** Blank line above an entry so cards in a lane are not glued together. */
export function workListRowMarginTop(_row: WorkListRow, isFirst: boolean): number {
  return isFirst ? 0 : 1;
}

/**
 * Place as many rows as fit, keeping `selectedIndex` inside the window.
 *
 * `scrollOffsetRows` is the caller's requested start; it is clamped so the
 * window never runs past the end, and then widened toward the selection so an
 * arrow key can never move the cursor onto a row that is not drawn.
 */
export function computeWorkListLayout({
  panelHeight,
  rows,
  scrollOffsetRows = 0,
  selectedIndex = -1,
  headerRows = WORK_LIST_HEADER_ROWS,
}: {
  panelHeight: number;
  rows: readonly WorkListRow[];
  scrollOffsetRows?: number;
  selectedIndex?: number;
  headerRows?: number;
}): WorkListLayout {
  const chromeHeader = Math.max(1, Math.floor(headerRows));
  const bodyRows = Math.max(1, Math.floor(panelHeight) - chromeHeader - WORK_LIST_FOOTER_ROWS);
  if (rows.length === 0) {
    return { start: 0, placements: [], hiddenBefore: 0, hiddenAfter: 0, bodyRows };
  }

  const place = (start: number): WorkListPlacement[] => {
    const placements: WorkListPlacement[] = [];
    // The renderer paints "↑ N above" on the first body line whenever the
    // window does not start at row 0. Placement y must include that line or
    // mouse hit-rects sit one row above the cards after you scroll.
    const topHint = start > 0 ? 1 : 0;
    let line = chromeHeader + 1 + topHint;
    for (let index = start; index < rows.length; index += 1) {
      const row = rows[index]!;
      const marginTop = workListRowMarginTop(row, placements.length === 0);
      const height = workListRowHeight(row);
      const bottomHint = index < rows.length - 1 ? 1 : 0;
      if (line + marginTop + height - 1 > chromeHeader + bodyRows - bottomHint) break;
      line += marginTop;
      placements.push({
        index,
        key: row.key,
        y: line,
        height,
        marginTop,
        identityLines: row.kind === "session" && row.showLaneIdentity ? 1 : 0,
      });
      line += height;
    }
    return placements;
  };

  let start = Math.max(0, Math.min(Math.floor(scrollOffsetRows), rows.length - 1));
  let placements = place(start);
  // Selection above the window: scroll straight to it. Below: walk the start
  // forward until it fits, which keeps the cursor on the last visible row
  // rather than jumping it to the top.
  if (selectedIndex >= 0) {
    if (selectedIndex < start) {
      start = selectedIndex;
      placements = place(start);
    } else {
      while (
        placements.length > 0
        && !placements.some((entry) => entry.index === selectedIndex)
        && selectedIndex > placements[placements.length - 1]!.index
        && start < rows.length - 1
      ) {
        start += 1;
        placements = place(start);
      }
    }
  }
  // A row taller than the whole body still has to render something, or the pane
  // goes blank at small terminal heights.
  if (placements.length === 0) {
    const row = rows[start]!;
    const topHint = start > 0 ? 1 : 0;
    placements = [{
      index: start,
      key: row.key,
      y: chromeHeader + 1 + topHint,
      height: Math.min(Math.max(1, bodyRows - topHint), workListRowHeight(row)),
      marginTop: 0,
      identityLines: row.kind === "session" && row.showLaneIdentity ? 1 : 0,
    }];
  }

  const last = placements[placements.length - 1]!;
  return {
    start,
    placements,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, rows.length - 1 - last.index),
    bodyRows,
  };
}

export type WorkListHitRegion = "lane-identity" | "body";

export type WorkListMouseHit =
  | { kind: "row"; index: number; key: string; region: WorkListHitRegion }
  | null;

export type WorkListHitRect = {
  index: number;
  key: string;
  region: WorkListHitRegion;
  rect: { x: number; y: number; w: number; h: number };
};

function hitRegionForOffset(placement: WorkListPlacement, offset: number): WorkListHitRegion {
  return placement.identityLines > 0 && offset < placement.identityLines
    ? "lane-identity"
    : "body";
}

/**
 * Map a pane-local 1-based row onto the entry it renders.
 *
 * `layout` must come from `computeWorkListLayout` with the inputs the pane
 * rendered from. A click on a singleton card's first line is the lane identity
 * (same as a lane-header row); the title and preview still activate the chat.
 */
export function workListMouseHitForLayout({
  y,
  layout,
}: {
  y: number | null;
  layout: WorkListLayout;
}): WorkListMouseHit {
  if (y == null) return null;
  for (const placement of layout.placements) {
    if (y >= placement.y && y < placement.y + placement.height) {
      return {
        kind: "row",
        index: placement.index,
        key: placement.key,
        region: hitRegionForOffset(placement, y - placement.y),
      };
    }
  }
  return null;
}

/**
 * Screen rects for the placed rows, for `hitTestRegistry` registration.
 *
 * Most entries emit one rect. A singleton card splits its first line so a
 * click on the lane name can open lane details without treating the whole
 * card as Chat Info.
 */
export function workListHitRects({
  layout,
  paneTopRow,
  paneLeft,
  paneWidth,
}: {
  layout: WorkListLayout;
  /** Screen row of the pane's first line (its top border). */
  paneTopRow: number;
  paneLeft: number;
  paneWidth: number;
}): WorkListHitRect[] {
  const rects: WorkListHitRect[] = [];
  for (const placement of layout.placements) {
    const identity = Math.min(placement.identityLines, placement.height);
    if (identity > 0) {
      rects.push({
        index: placement.index,
        key: placement.key,
        region: "lane-identity",
        rect: {
          x: paneLeft,
          y: paneTopRow + placement.y - 1,
          w: Math.max(1, paneWidth),
          h: identity,
        },
      });
    }
    const bodyHeight = placement.height - identity;
    if (bodyHeight > 0) {
      rects.push({
        index: placement.index,
        key: placement.key,
        region: "body",
        rect: {
          x: paneLeft,
          y: paneTopRow + placement.y - 1 + identity,
          w: Math.max(1, paneWidth),
          h: bodyHeight,
        },
      });
    }
  }
  return rects;
}
