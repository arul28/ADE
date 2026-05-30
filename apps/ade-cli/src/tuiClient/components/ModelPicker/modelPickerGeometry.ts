import type { ModelPickerState } from "./types";

/**
 * Screen rectangle in 1-based terminal cells. Structurally identical to
 * hitTestRegistry's HitRect; declared locally so this pure geometry module
 * stays free of any React/ink import (keeps it trivially unit-testable).
 */
export type HitRect = { x: number; y: number; w: number; h: number };

// ── Single source of truth for model-picker layout geometry ─────────────────
//
// Both the RENDER (ModelPickerPane.tsx) and the CLICK hit-test (app.tsx) must
// agree on exactly where each row lands on screen. Previously the hit-test
// hand-rolled its own offsets that drifted from the render, so clicks selected
// the wrong row (and worse once the list scrolled). This module is the ONE
// place those numbers live: ModelPickerPane imports the constants + rowWindow,
// and the app.tsx hit-test useEffect calls `modelPickerGeometry()` to derive
// rects from the same math.

/** Width (cols) of the vertical icon rail on the left of the model region. */
export const RAIL_WIDTH = 4;

/** Fixed number of visible model rows; the list windows/scrolls inside this. */
export const MODEL_LIST_ROWS = 9;

/**
 * Columns between the rail and the model name, inside the bordered list box:
 * left border (1) + paddingLeft (1). The name column therefore starts at
 * RAIL_WIDTH + RAIL_TO_LIST_GAP into the pane body.
 */
export const RAIL_TO_LIST_GAP = 2;

/**
 * Window the fixed-height model list around the focused row. Mirrors the
 * desktop picker's centering behaviour: the focused row stays roughly centered
 * until the list start/end is reached.
 *
 * Shared verbatim with the render so the visible slice and the clickable rects
 * are computed identically.
 */
export function rowWindow(
  rowCount: number,
  selected: number,
  capacity: number,
): { start: number; end: number } {
  if (rowCount <= capacity) return { start: 0, end: rowCount };
  const half = Math.floor(capacity / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(rowCount, start + capacity);
  start = Math.max(0, end - capacity);
  return { start, end };
}

/** Number of fixed header lines above the search row (variable by state). */
export function headerLineCount(state: ModelPickerState): number {
  let lines = 1; // "N models …" is always present.
  if (state.activeModelId && state.entries.some((e) => e.modelId === state.activeModelId)) {
    lines += 1; // "● now …" line.
  }
  if (state.activeProviderAuthStatus === "unavailable" && state.activeProviderSignInHint) {
    lines += 1; // "Sign in: …" line.
  }
  return lines;
}

/** True when the picker is in cross-provider search mode (query non-empty). */
export function isSearching(state: ModelPickerState): boolean {
  return state.query.trim().length > 0;
}

/** Whether the sub-provider selector row is rendered (only with >1 tab). */
export function hasSubProviderSelector(state: ModelPickerState): boolean {
  return !isSearching(state) && state.providerTabs.length > 1;
}

export type GeometryRect = { id: string; rect: HitRect };

export type ModelPickerGeometry = {
  /** Window applied to state.entries (start inclusive, end exclusive). */
  window: { start: number; end: number };
  /** Search input row. */
  search: HitRect;
  /** Show-all toggle row (kept for parity with existing target). */
  showAll: HitRect;
  /** One rect per rail entry (empty while searching — rail is hidden). */
  rail: GeometryRect[];
  /** One rect per visible (windowed) model entry. */
  entries: Array<{ id: string; index: number; modelId: string; rect: HitRect }>;
  /** Star toggle hotspot per visible model entry (left edge of the row). */
  favorites: Array<{ modelId: string; rect: HitRect }>;
  /** One rect per visible setting chip (kind keyed). */
  settings: GeometryRect[];
  /** Apply button rect, when an apply row is present. */
  apply: HitRect | null;
  /** Top screen row of the settings footer (divider sits here). */
  footerTop: number;
};

export type GeometryInput = {
  /** 1-based screen column of the pane body left edge (rightStartColumn). */
  paneLeft: number;
  /** 1-based screen row of the pane body first line (rightBodyTop). */
  paneTop: number;
  /** Pane body width in columns (rightPaneWidth). */
  paneWidth: number;
  /** Resolved picker state (from buildModelPickerLayout). */
  state: ModelPickerState;
  /** Terminal row count, to clamp the footer into view. */
  rows: number;
};

/**
 * Compute exact screen rects for every clickable region of the model picker,
 * derived from the SAME constants + windowing the render uses. All rects are
 * 1-based terminal cells, matching hitTestRegistry's contains() convention
 * ([x, x+w) × [y, y+h)).
 */
export function modelPickerGeometry(input: GeometryInput): ModelPickerGeometry {
  const { paneLeft, paneTop, paneWidth, state, rows } = input;
  const searching = isSearching(state);

  // Vertical layout (each value is a screen row offset from paneTop):
  //   header (headerLines)        marginBottom 1
  //   search (1)                  marginBottom 1
  //   [model region]
  const headerLines = headerLineCount(state);
  const searchY = paneTop + headerLines + 1; // +1 for header marginBottom.
  const modelRegionTop = searchY + 1 + 1; // search row (1) + its marginBottom (1).

  // Selector occupies 1 row + marginBottom (1) when present, before the list.
  const selectorLines = hasSubProviderSelector(state) ? 2 : 0;
  const listTop = modelRegionTop + selectorLines;

  // List x-origin: full body while searching (no rail); else rail + gap.
  const listLeft = searching ? paneLeft : paneLeft + RAIL_WIDTH + RAIL_TO_LIST_GAP;
  const listWidth = searching
    ? paneWidth
    : Math.max(8, paneWidth - RAIL_WIDTH - RAIL_TO_LIST_GAP);

  const window = rowWindow(state.entries.length, state.focusedIndex, MODEL_LIST_ROWS);

  // Search row spans the full body width.
  const search: HitRect = { x: paneLeft, y: searchY, w: paneWidth, h: 1 };

  // Show-all toggle. Render does not draw a dedicated row for this anymore, but
  // the keyboard/legacy target is harmless; pin it to the search row so it can
  // never overlap a model row (zIndex keeps search on top where they coincide).
  const showAll: HitRect = { x: paneLeft, y: searchY, w: paneWidth, h: 1 };

  // Rail: leftmost RAIL_WIDTH cols, one 1-line row per rail entry, starting at
  // the model region top. Hidden entirely while searching.
  const rail: GeometryRect[] = [];
  if (!searching) {
    state.railEntries.forEach((_, index) => {
      rail.push({
        id: `right:model-picker:rail:${index}`,
        rect: { x: paneLeft, y: modelRegionTop + index, w: RAIL_WIDTH, h: 1 },
      });
    });
  }

  // Model entries: each is EXACTLY 1 line (matches ModelListRow), windowed.
  const entries: ModelPickerGeometry["entries"] = [];
  const favorites: ModelPickerGeometry["favorites"] = [];
  state.entries.slice(window.start, window.end).forEach((entry, sliceIndex) => {
    const index = window.start + sliceIndex;
    const y = listTop + sliceIndex;
    entries.push({
      id: `right:model-picker:entry:${entry.modelId}`,
      index,
      modelId: entry.modelId,
      rect: { x: listLeft, y, w: listWidth, h: 1 },
    });
    // Star hotspot is the first glyph cell(s) of the row.
    favorites.push({
      modelId: entry.modelId,
      rect: { x: listLeft, y, w: 2, h: 1 },
    });
  });

  // Footer: after the fixed list block (always MODEL_LIST_ROWS tall) plus the
  // optional "↑ n / ↓ n more" line, a marginTop (1) precedes the divider.
  const hiddenBefore = window.start;
  const hiddenAfter = state.entries.length - window.end;
  const moreLine = hiddenBefore > 0 || hiddenAfter > 0 ? 1 : 0;
  // footerTop is the divider row; the marginTop pushes it down by 1.
  let footerTop = listTop + MODEL_LIST_ROWS + moreLine + 1;
  // Keep the footer on-screen if the pane is short.
  footerTop = Math.min(Math.max(footerTop, listTop + 1), Math.max(1, rows - 1));

  const visibleRows = state.settingsRows.filter(
    (row) => row.kind !== "provider" && row.kind !== "model",
  );
  const settingRows = visibleRows.filter((row) => row.kind !== "apply");
  const applyRow = visibleRows.find((row) => row.kind === "apply") ?? null;

  // The chip row sits one marginTop (1) below the divider.
  const chipsY = footerTop + 1;
  // Chips are a flexWrap row of natural-width pills; their precise x cannot be
  // derived from a formula without measuring rendered glyph widths. We register
  // each chip as a coarse equal slice across the body — good enough to route a
  // click to the right chip in the common (single-row) case. Hover precision is
  // handled by the render via id match, not by these rects.
  const settings: GeometryRect[] = [];
  if (settingRows.length) {
    const slice = Math.max(8, Math.floor(paneWidth / Math.max(1, settingRows.length)));
    settingRows.forEach((row, index) => {
      settings.push({
        id: `right:model-picker:setting:${row.kind}`,
        rect: { x: paneLeft + index * slice, y: chipsY, w: slice, h: 1 },
      });
    });
  }

  // Apply button: its own marginTop (1) below the chip row (or below the
  // divider when there are no chips), rendered as "[ Apply ]".
  let apply: HitRect | null = null;
  if (applyRow) {
    const applyY = settingRows.length ? chipsY + 2 : footerTop + 2;
    apply = { x: paneLeft, y: applyY, w: Math.max(8, Math.min(paneWidth, 24)), h: 1 };
  }

  return {
    window,
    search,
    showAll,
    rail,
    entries,
    favorites,
    settings,
    apply,
    footerTop,
  };
}
