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
