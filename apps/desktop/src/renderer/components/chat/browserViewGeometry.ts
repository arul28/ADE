/**
 * Where the native browser view goes, in pure arithmetic.
 *
 * A `WebContentsView` is a rectangle the compositor puts on top of the
 * renderer, so the panel has to hand the main process exact pixels — and the
 * three things that can go wrong (a device larger than the pane, a rect that
 * lags a splitter drag, a caption that lies about the fit) are all decided
 * here rather than inside a component that also owns twenty other concerns.
 */

export type BrowserViewFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * 1 when the device fits the stage, else how much of it the frame shows.
   *
   * A landscape phone in a 578px pane cannot be honoured at 1:1, and the old
   * behaviour — clamp width, keep height — cropped the page at the pane's right
   * edge with nothing on screen admitting it. The frame is shrunk on both axes
   * instead, so the whole device is visible and the caption can say `fit 82%`.
   */
  scale: number;
};

export type BrowserViewBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Where the native view sits inside its stage.
 *
 * With no emulation it fills the stage inset by the host's hairline, so the
 * rounded frame masks the (rectangular) native view. With a CSS size it is that
 * size exactly, centred — until the device is bigger than the stage, when the
 * whole frame is scaled down uniformly rather than cropped on one axis.
 */
export function browserLetterboxFrame(
  stage: { width: number; height: number },
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  inset = 1,
): BrowserViewFrame {
  const availableWidth = Math.max(0, Math.round(stage.width) - inset * 2);
  const availableHeight = Math.max(0, Math.round(stage.height) - inset * 2);
  const cssWidth = emulation?.width && emulation.width > 0 ? Math.round(emulation.width) : null;
  const cssHeight = emulation?.height && emulation.height > 0 ? Math.round(emulation.height) : null;
  if (cssWidth == null || cssHeight == null) {
    return { left: inset, top: inset, width: availableWidth, height: availableHeight, scale: 1 };
  }
  const scale = Math.min(1, availableWidth / cssWidth, availableHeight / cssHeight);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0;
  const width = Math.min(availableWidth, Math.round(cssWidth * safeScale));
  const height = Math.min(availableHeight, Math.round(cssHeight * safeScale));
  return {
    left: inset + Math.floor((availableWidth - width) / 2),
    top: inset + Math.floor((availableHeight - height) / 2),
    width,
    height,
    scale: safeScale,
  };
}

/**
 * Trim a measured rect to the box that actually clips it.
 *
 * The renderer measures the frame's own rect, which stays at its laid-out size
 * for a frame or two after a drag; without this the main process is handed a
 * width the pane no longer has and the page paints over the window edge.
 */
export function clampBrowserViewBounds(
  frame: { x: number; y: number; width: number; height: number },
  box: BrowserViewBox,
): { x: number; y: number; width: number; height: number } {
  const left = Math.max(Math.round(frame.x), Math.round(box.left));
  const top = Math.max(Math.round(frame.y), Math.round(box.top));
  const right = Math.min(Math.round(frame.x + frame.width), Math.round(box.right));
  const bottom = Math.min(Math.round(frame.y + frame.height), Math.round(box.bottom));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * The mono caption under a letterboxed view: `393 × 852`, and `393 × 852 · fit
 * 82%` when the pane was too small to show the device at 1:1.
 *
 * The numbers are always the CSS pixels the page is laid out at — the fit is
 * about this pane, not about the device, so it is an aside rather than a
 * different size.
 */
export function emulationCaption(
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  scale?: number | null,
): string | null {
  if (!emulation?.width || !emulation.height) return null;
  const size = `${Math.round(emulation.width)} × ${Math.round(emulation.height)}`;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale >= 0.995) return size;
  return `${size} · fit ${Math.round(scale * 100)}%`;
}
