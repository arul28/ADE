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

/**
 * Put the document into "the splitter is being dragged" mode, and hand back the
 * one call that undoes it.
 *
 * `user-select: none` on `<body>` is not enough on its own. It is an INHERITED
 * property, and inheritance loses to any value a descendant declares for
 * itself — every `select-text` surface in the chat column keeps selecting while
 * you drag across it, which is exactly the smear this fixes. Suppressing hit
 * testing for the duration is what actually stops it: with `pointer-events:
 * none` on the body no element can become a selection anchor, while the
 * document-level `mousemove`/`mouseup` listeners the drag runs on still fire.
 *
 * The cursor goes on `<html>` as well as on `<body>`: the body is no longer a
 * hit target, so on its own it can be skipped when the cursor is resolved, and
 * `<html>` is the ancestor that is always consulted.
 *
 * Every property is restored to the exact inline value it had, so a drag that
 * starts while something else has parked a cursor there leaves it as it found
 * it.
 *
 * The disposer is IDEMPOTENT. A dead `pointer-events: none` on `<body>` kills
 * every click, hover and focus in the renderer with no in-app way back, so the
 * drag calls it from every exit it can name — mouseup, unmount, window blur,
 * `pointercancel`, Escape — and several of those can fire for the same drag.
 * A second call must not restore stale values over a later drag's isolation.
 */
export function beginWorkSidebarSplitterDrag(handle: HTMLElement | null): () => void {
  const doc = handle?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  const body = doc?.body ?? null;
  const root = doc?.documentElement ?? null;
  if (!body || !root) return () => {};
  const previous = {
    rootCursor: root.style.cursor,
    bodyCursor: body.style.cursor,
    bodyUserSelect: body.style.userSelect,
    bodyPointerEvents: body.style.pointerEvents,
    handleUserSelect: handle?.style.userSelect ?? "",
  };
  root.style.cursor = "col-resize";
  body.style.cursor = "col-resize";
  body.style.userSelect = "none";
  body.style.pointerEvents = "none";
  // The handle is the one element still under the pointer conceptually; a
  // double-click on it must not select the pane's chrome either.
  if (handle) handle.style.userSelect = "none";
  // The gutter's own drag state. `:active` is not it — the pointer leaves the
  // 8px handle on the first frame of any real drag, and the hairline would
  // vanish exactly while you are using it.
  handle?.setAttribute("data-resize-handle-active", "");
  let done = false;
  return () => {
    if (done) return;
    done = true;
    root.style.cursor = previous.rootCursor;
    body.style.cursor = previous.bodyCursor;
    body.style.userSelect = previous.bodyUserSelect;
    body.style.pointerEvents = previous.bodyPointerEvents;
    if (handle) handle.style.userSelect = previous.handleUserSelect;
    handle?.removeAttribute("data-resize-handle-active");
  };
}
