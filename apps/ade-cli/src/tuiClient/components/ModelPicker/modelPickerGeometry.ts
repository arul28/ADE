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

/** Width (cols) of the vertical rail on the left of the model region. */
export const RAIL_WIDTH = 16;

/** Fixed number of visible model entries; the list windows/scrolls inside this. */
export const MODEL_LIST_ROWS = 5;
export const PROVIDER_MODEL_LIST_ROWS = 8;

/** Each model entry paints a title line plus a provider subtitle line. */
export const MODEL_ENTRY_HEIGHT = 2;
export const PROVIDER_MODEL_ENTRY_HEIGHT = 1;

/** Total terminal lines occupied by the fixed-height model list. */
export const MODEL_LIST_BODY_LINES = MODEL_LIST_ROWS * MODEL_ENTRY_HEIGHT;

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
  // (The "● now" line was removed — the cursor arrow is the source of truth.)
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

export function usesCompactProviderRows(state: ModelPickerState): boolean {
  if (isSearching(state)) return false;
  return state.railEntries[state.railIndex]?.kind === "provider";
}

export function modelEntryHeightForState(state: ModelPickerState): number {
  return usesCompactProviderRows(state) ? PROVIDER_MODEL_ENTRY_HEIGHT : MODEL_ENTRY_HEIGHT;
}

export function modelListRowsForState(state: ModelPickerState): number {
  return usesCompactProviderRows(state) ? PROVIDER_MODEL_LIST_ROWS : MODEL_LIST_ROWS;
}

export function modelListBodyLinesForState(state: ModelPickerState): number {
  return modelEntryHeightForState(state) * modelListRowsForState(state);
}

// Settings chip cell width — mirrors SettingsFooter's render EXACTLY so the
// hit-rects and the painted chips share one source of truth:
//   focus/rail indicator (1) + "icon " (icon 1 + space 1 = 2)
//   + lowercased label (≤12) + trailing space (1) + value (≤14) + marginRight (2)
const SETTING_LABEL_MAX = 12;
const SETTING_VALUE_MAX = 14;
export function settingsChipWidth(label: string, value: string): number {
  const labelLen = Math.min(label.toLowerCase().length, SETTING_LABEL_MAX);
  const valueLen = Math.min(value.length, SETTING_VALUE_MAX);
  return 1 + 2 + labelLen + 1 + valueLen + 2;
}

export type GeometryRect = { id: string; rect: HitRect };

export type ModelPickerGeometry = {
  /** Window applied to state.entries (start inclusive, end exclusive). */
  window: { start: number; end: number };
  /** Search input row. */
  search: HitRect;
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

  const entryHeight = modelEntryHeightForState(state);
  const visibleRowCount = modelListRowsForState(state);
  const listBodyLines = modelListBodyLinesForState(state);
  const window = rowWindow(state.entries.length, state.focusedIndex, visibleRowCount);

  // Search row spans the full body width.
  const search: HitRect = { x: paneLeft, y: searchY, w: paneWidth, h: 1 };

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

  // Model entries: each is EXACTLY entryHeight lines (matches ModelListRow),
  // windowed.
  const entries: ModelPickerGeometry["entries"] = [];
  const favorites: ModelPickerGeometry["favorites"] = [];
  state.entries.slice(window.start, window.end).forEach((entry, sliceIndex) => {
    const index = window.start + sliceIndex;
    const y = listTop + (sliceIndex * entryHeight);
    entries.push({
      id: `right:model-picker:entry:${entry.modelId}`,
      index,
      modelId: entry.modelId,
      rect: { x: listLeft, y, w: listWidth, h: entryHeight },
    });
    // Star hotspot is the first glyph cell(s) on the title line.
    favorites.push({
      modelId: entry.modelId,
      rect: { x: listLeft, y, w: 2, h: 1 },
    });
  });

  // Footer: after the fixed list block. The old "↑ n / ↓ n more" bookkeeping
  // row was intentionally removed from the render because it read like another
  // provider/status row; scrolling is still available through the cursor.
  // footerTop is the divider row; the marginTop pushes it down by 1.
  const modelRegionLines = searching
    ? selectorLines + listBodyLines
    : Math.max(state.railEntries.length, selectorLines + listBodyLines);
  let footerTop = modelRegionTop + modelRegionLines + 1;
  // Keep the footer on-screen if the pane is short.
  footerTop = Math.min(Math.max(footerTop, listTop + 1), Math.max(1, rows - 1));

  const visibleRows = state.settingsRows.filter(
    (row) => row.kind !== "provider" && row.kind !== "model",
  );
  const settingRows = visibleRows.filter((row) => row.kind !== "apply");
  const applyRow = visibleRows.find((row) => row.kind === "apply") ?? null;

  // The settings list has its OWN marginTop (1) below the divider (the divider
  // sits at footerTop), so rows paint at footerTop+2. The render is vertical,
  // one setting per line.
  const chipsY = footerTop + 2;
  const settings: GeometryRect[] = [];
  settingRows.forEach((row, index) => {
    const w = settingsChipWidth(row.label, row.value);
    settings.push({
      id: `right:model-picker:setting:${row.kind}`,
      rect: { x: paneLeft, y: chipsY + index, w: Math.min(paneWidth, Math.max(8, w)), h: 1 },
    });
  });

  // Apply button: its own marginTop (1) below the last setting row, or directly
  // below the divider when there are no settings. Rendered as "[ Apply ]".
  let apply: HitRect | null = null;
  if (applyRow) {
    const applyY = settingRows.length ? chipsY + settingRows.length + 1 : footerTop + 2;
    apply = { x: paneLeft, y: applyY, w: Math.max(8, Math.min(paneWidth, 24)), h: 1 };
  }

  return {
    window,
    search,
    rail,
    entries,
    favorites,
    settings,
    apply,
    footerTop,
  };
}
