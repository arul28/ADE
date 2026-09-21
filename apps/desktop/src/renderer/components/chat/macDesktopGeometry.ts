import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";

/**
 * View coordinates to display coordinates, and back.
 *
 * The live view draws the display into a canvas with `object-contain`, so the
 * picture is letterboxed inside whatever box the pane gives it: the mapping is
 * never "multiply by a ratio". Both directions live here, as pure functions
 * over a rectangle and a display, because a click landing 40px off is the kind
 * of bug that is invisible in a screenshot and obvious in a test.
 *
 * The output is a point on macOS's GLOBAL coordinate plane — the same plane
 * `MacDesktopElement.frame` and `MacDesktopDisplay.origin` use — because that is
 * what `mode: "real"` input takes. `display.scale` is deliberately NOT applied:
 * the display's `width`/`height` are already points, and the driver posts
 * `CGEvent`s in points. Scale only describes how many pixels the encoder sends
 * per point, which is the decoder's business and not this mapping's.
 */

export type ViewRect = { left: number; top: number; width: number; height: number };

export type MacDesktopGeometryDisplay = Pick<MacDesktopDisplay, "width" | "height" | "origin">;

export type ContentBox = {
  /** Points-per-view-pixel for the drawn picture. */
  scale: number;
  /** Letterbox offset of the picture inside the view rect, in view pixels. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

/** Where the letterboxed picture actually sits inside the view rect. */
export function macDesktopContentBox(
  rect: ViewRect,
  display: MacDesktopGeometryDisplay,
): ContentBox | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (display.width <= 0 || display.height <= 0) return null;
  const scale = Math.min(rect.width / display.width, rect.height / display.height);
  const width = display.width * scale;
  const height = display.height * scale;
  return {
    scale,
    offsetX: (rect.width - width) / 2,
    offsetY: (rect.height - height) / 2,
    width,
    height,
  };
}

/**
 * A pointer event on the view to a global screen point.
 *
 * Returns null for a point in the letterbox bars rather than clamping it to the
 * edge: a click on black is not a click on the screen, and silently moving it to
 * the nearest pixel of a real window is worse than doing nothing.
 */
export function viewPointToDisplayPoint(args: {
  clientX: number;
  clientY: number;
  rect: ViewRect;
  display: MacDesktopGeometryDisplay;
}): { x: number; y: number } | null {
  const box = macDesktopContentBox(args.rect, args.display);
  if (!box) return null;
  const localX = args.clientX - args.rect.left - box.offsetX;
  const localY = args.clientY - args.rect.top - box.offsetY;
  if (localX < 0 || localY < 0 || localX > box.width || localY > box.height) return null;
  return {
    x: args.display.origin.x + localX / box.scale,
    y: args.display.origin.y + localY / box.scale,
  };
}

/**
 * A global screen point back to a position inside the view, for the agent
 * cursor glyph. Points off the display are dropped for the same reason.
 */
export function displayPointToViewPoint(args: {
  x: number;
  y: number;
  rect: ViewRect;
  display: MacDesktopGeometryDisplay;
}): { x: number; y: number } | null {
  const box = macDesktopContentBox(args.rect, args.display);
  if (!box) return null;
  const localX = (args.x - args.display.origin.x) * box.scale;
  const localY = (args.y - args.display.origin.y) * box.scale;
  if (localX < 0 || localY < 0 || localX > box.width || localY > box.height) return null;
  return { x: box.offsetX + localX, y: box.offsetY + localY };
}

/** How long the agent's cursor glyph stays on screen after an action. */
export const MAC_DESKTOP_CURSOR_FADE_MS = 3_000;

/**
 * A window's frame on the global plane to a rectangle inside the view.
 *
 * Used to draw a thin accent outline over one parked window while its card is
 * selected in the rail. Clipped to the picture rather than dropped, because a
 * window that hangs off the display's edge still has a visible part and an
 * outline around the visible part is the truthful drawing. Returns null only
 * when the frame does not intersect the picture at all.
 */
export function displayFrameToViewRect(args: {
  frame: { x: number; y: number; width: number; height: number };
  rect: ViewRect;
  display: MacDesktopGeometryDisplay;
}): { left: number; top: number; width: number; height: number } | null {
  const box = macDesktopContentBox(args.rect, args.display);
  if (!box) return null;
  const left = (args.frame.x - args.display.origin.x) * box.scale;
  const top = (args.frame.y - args.display.origin.y) * box.scale;
  const right = left + args.frame.width * box.scale;
  const bottom = top + args.frame.height * box.scale;
  const clippedLeft = Math.max(0, Math.min(left, box.width));
  const clippedTop = Math.max(0, Math.min(top, box.height));
  const clippedRight = Math.max(0, Math.min(right, box.width));
  const clippedBottom = Math.max(0, Math.min(bottom, box.height));
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return null;
  return {
    left: box.offsetX + clippedLeft,
    top: box.offsetY + clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
}

/**
 * The next point of a pointer the viewer has LOCKED.
 *
 * A locked pointer reports movement, not position: the browser hides the
 * cursor and pins it, so `clientX`/`clientY` stop meaning anything and the
 * only truth is a delta per event. That is what a takeover needs. macOS has
 * one system cursor for every display, so driving a lane's display with real
 * events and leaving the person's own pointer free means the two fight over
 * it — which is what stranded the cursor on the lane's display with the local
 * glyph frozen where it was abandoned.
 *
 * Deltas arrive in view pixels, so they are divided by the content box's scale
 * to become display points: a hand movement covers the same distance on the
 * lane's screen as it appears to cover in the picture.
 *
 * Clamped to the display rather than refused. A locked pointer has no edge to
 * stop at — the person can push in one direction forever — so the position has
 * to be held at the boundary or it wanders off into coordinates no window
 * occupies and the picture stops responding.
 */
export function macDesktopAdvanceLockedPoint(args: {
  from: { x: number; y: number };
  movementX: number;
  movementY: number;
  display: MacDesktopGeometryDisplay;
  /** View pixels per display point. `ContentBox.scale`. */
  scale: number;
}): { x: number; y: number } {
  const scale = args.scale > 0 ? args.scale : 1;
  const maxX = args.display.origin.x + args.display.width;
  const maxY = args.display.origin.y + args.display.height;
  return {
    x: Math.min(maxX, Math.max(args.display.origin.x, args.from.x + args.movementX / scale)),
    y: Math.min(maxY, Math.max(args.display.origin.y, args.from.y + args.movementY / scale)),
  };
}

/**
 * Where an input event lands on the lane's display.
 *
 * The whole point is that a locked pointer has NO usable event coordinate.
 * Under pointer lock the browser freezes `clientX/clientY` at the point the
 * lock began (that is the spec), so a caller that keeps resolving points from
 * the event resolves the same stale point for the rest of the takeover: the
 * glyph sticks where the lock started, every click lands there, and a drag
 * runs from that point to itself. While the lock is held the advanced point
 * (`macDesktopAdvanceLockedPoint`, fed by `movementX/movementY`) is the only
 * truth; unlocked, the event coordinate is.
 */
export function macDesktopInputPoint(args: {
  locked: boolean;
  lockedPoint: { x: number; y: number } | null;
  /** Read only when unlocked, so a frozen coordinate is never even computed. */
  fromEvent: () => { x: number; y: number } | null;
}): { x: number; y: number } | null {
  return args.locked ? args.lockedPoint : args.fromEvent();
}

/** The middle of the display, where a takeover starts before the first move. */
export function macDesktopDisplayCentre(
  display: MacDesktopGeometryDisplay,
): { x: number; y: number } {
  return {
    x: display.origin.x + display.width / 2,
    y: display.origin.y + display.height / 2,
  };
}
