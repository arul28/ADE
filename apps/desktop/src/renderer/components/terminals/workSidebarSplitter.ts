/**
 * How wide the Work tools pane is allowed to be, in one place.
 *
 * The percentage clamp (26–55%) is a *taste* rule: it stops the pane from
 * becoming a slit or from eating the chat. It is not a safety rule, because a
 * percentage says nothing about pixels — 26% of a 1080px window is 280px, but
 * 26% of a 900px window is 234px, and at 234px the pane's own chrome (a 36px
 * header carrying "Tools", the tool name, the activity dots and the ✕) has
 * nowhere to go. That is how a drag ended with the close button off-window.
 *
 * So the drag is clamped in BOTH units: never below `MIN_WORK_SIDEBAR_PANE_PX`
 * of real pane, and never leaving the chat column narrower than
 * `MIN_WORK_CONTENT_PANE_PX`. Pure, so the arithmetic can be tested without a
 * layout engine — the pane itself only supplies its container's width.
 */

/** Taste floor/ceiling, mirrored by `normalizeWorkSidebarWidthPct` in the store. */
export const MIN_WORK_SIDEBAR_WIDTH_PCT = 26;
export const MAX_WORK_SIDEBAR_WIDTH_PCT = 55;

/**
 * The narrowest pane whose header still fits: 36px back button + tool name +
 * dots + a 36px close button, with room for a truncated status between them.
 */
export const MIN_WORK_SIDEBAR_PANE_PX = 280;

/** The chat column keeps at least this much, so the pane can never bury it. */
export const MIN_WORK_CONTENT_PANE_PX = 360;

/** The drag handle sits between the two panes and is not part of either. */
export const WORK_SIDEBAR_SPLITTER_PX = 5;

/** How much one arrow key moves the separator. */
export const WORK_SIDEBAR_KEYBOARD_STEP_PCT = 2;

function clampPct(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a requested pane width.
 *
 * `containerWidthPx` is the width of the row that holds BOTH panes and the
 * splitter. Omit it (or pass a non-positive number) and only the percentage
 * rule applies — which is what the store does when it has no layout to consult.
 *
 * When the window is too narrow to honour both pixel floors at once the pane's
 * floor wins: a clipped ✕ is unusable, a squeezed chat column is merely tight.
 */
export function clampWorkSidebarWidthPct(
  widthPct: number,
  containerWidthPx?: number | null,
): number {
  const requested = Number.isFinite(widthPct) ? widthPct : MIN_WORK_SIDEBAR_WIDTH_PCT;
  const byTaste = clampPct(requested, MIN_WORK_SIDEBAR_WIDTH_PCT, MAX_WORK_SIDEBAR_WIDTH_PCT);
  if (containerWidthPx == null || !Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return byTaste;
  }
  const usable = Math.max(containerWidthPx - WORK_SIDEBAR_SPLITTER_PX, 1);
  const pixelFloorPct = (MIN_WORK_SIDEBAR_PANE_PX / usable) * 100;
  const pixelCeilingPct = ((usable - MIN_WORK_CONTENT_PANE_PX) / usable) * 100;
  const lower = Math.max(MIN_WORK_SIDEBAR_WIDTH_PCT, pixelFloorPct);
  const upper = Math.min(MAX_WORK_SIDEBAR_WIDTH_PCT, pixelCeilingPct);
  if (lower > upper) return Math.min(lower, 100);
  return clampPct(requested, lower, upper);
}

/** Pane width in pixels for a given percentage — what the clamp is defending. */
export function workSidebarPaneWidthPx(widthPct: number, containerWidthPx: number): number {
  const usable = Math.max(containerWidthPx - WORK_SIDEBAR_SPLITTER_PX, 0);
  return (usable * widthPct) / 100;
}

/**
 * The next width for one keypress on the separator.
 *
 * ArrowLeft grows the pane because the pane is on the right: the key moves the
 * SEPARATOR, which is the thing under the caret. Home/End snap to the two ends
 * of the range that is currently legal, floors included — so End at a narrow
 * window lands on the widest pane that still leaves a usable chat column.
 */
export function nextWorkSidebarWidthPctForKey(
  key: string,
  widthPct: number,
  containerWidthPx?: number | null,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampWorkSidebarWidthPct(widthPct + WORK_SIDEBAR_KEYBOARD_STEP_PCT, containerWidthPx);
    case "ArrowRight":
      return clampWorkSidebarWidthPct(widthPct - WORK_SIDEBAR_KEYBOARD_STEP_PCT, containerWidthPx);
    case "Home":
      return clampWorkSidebarWidthPct(MIN_WORK_SIDEBAR_WIDTH_PCT, containerWidthPx);
    case "End":
      return clampWorkSidebarWidthPct(MAX_WORK_SIDEBAR_WIDTH_PCT, containerWidthPx);
    default:
      return null;
  }
}
