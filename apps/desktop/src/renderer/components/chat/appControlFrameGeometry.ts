import type { AppControlSnapshot } from "../../../shared/types";

/**
 * The arithmetic that turns "where the pointer is on an `<img>`" into "where
 * that is inside the controlled app".
 *
 * Pure and DOM-free — every input is passed in, including the image's bounding
 * rect — because it was previously three `useCallback`s buried in an 1,850-line
 * component, closing over a ref and a piece of state, which meant the one part
 * of the panel that is plain maths was also the one part that could not be
 * tested without mounting a live CDP session.
 *
 * Two coordinate systems are in play and the difference is the whole point:
 * `viewport*` is CSS pixels inside the app (what CDP input events take), and
 * `width`/`height` are the screenshot's device pixels (what the image is).
 */
export type LiveFrameDims = {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  scaleX: number;
  scaleY: number;
};

export type MappedPoint = {
  viewportX: number;
  viewportY: number;
  imageX: number;
  imageY: number;
  leftPct: number;
  topPct: number;
};

type FrameRect = { left: number; top: number; width: number; height: number };

/**
 * The dimensions the panel is actually painting, live frame first.
 *
 * A live screencast frame carries its own metrics and is always the truth while
 * it is running; the snapshot's are the fallback, with the viewport derived
 * from the device-pixel size and the scale when the snapshot did not report one.
 */
export function appControlDisplayedMetrics(args: {
  liveFrameActive: boolean;
  liveFrameDims: LiveFrameDims | null;
  snapshot: AppControlSnapshot | null;
}): LiveFrameDims | null {
  const { liveFrameActive, liveFrameDims, snapshot } = args;
  if (liveFrameActive) {
    const live = liveFrameDims;
    if (live && live.width > 0 && live.height > 0 && live.viewportWidth > 0 && live.viewportHeight > 0) {
      return live;
    }
  }
  const sw = snapshot?.screenshot?.width ?? 0;
  const sh = snapshot?.screenshot?.height ?? 0;
  if (sw <= 0 || sh <= 0) return null;
  const scaleX = snapshot?.screen.scaleX ?? snapshot?.screen.scale ?? 1;
  const scaleY = snapshot?.screen.scaleY ?? snapshot?.screen.scale ?? scaleX;
  return {
    width: sw,
    height: sh,
    viewportWidth: snapshot?.screen.viewportWidth && snapshot.screen.viewportWidth > 0
      ? snapshot.screen.viewportWidth
      : sw / scaleX,
    viewportHeight: snapshot?.screen.viewportHeight && snapshot.screen.viewportHeight > 0
      ? snapshot.screen.viewportHeight
      : sh / scaleY,
    scale: snapshot?.screen.scale ?? scaleX,
    scaleX,
    scaleY,
  };
}

/** A client point on the painted image → app viewport, image and percent coords. */
export function mapClientPointToFrame(args: {
  clientX: number;
  clientY: number;
  rect: FrameRect;
  metrics: LiveFrameDims | null;
}): MappedPoint | null {
  const { clientX, clientY, rect, metrics } = args;
  if (!metrics || rect.width <= 0 || rect.height <= 0) return null;
  // Clamped: a pointer that leaves the image mid-drag must not send the app a
  // negative coordinate or one past its own viewport.
  const xRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const yRatio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  return {
    viewportX: Math.round(xRatio * metrics.viewportWidth),
    viewportY: Math.round(yRatio * metrics.viewportHeight),
    imageX: Math.round(xRatio * metrics.width),
    imageY: Math.round(yRatio * metrics.height),
    leftPct: xRatio * 100,
    topPct: yRatio * 100,
  };
}

/** An element's viewport frame → percentage box over the painted image. */
export function appControlOverlayBox(
  frame: { x: number; y: number; width: number; height: number },
  metrics: LiveFrameDims | null,
): { left: string; top: string; width: string; height: string } | null {
  if (!metrics || metrics.viewportWidth <= 0 || metrics.viewportHeight <= 0) return null;
  return {
    left: `${(frame.x / metrics.viewportWidth) * 100}%`,
    top: `${(frame.y / metrics.viewportHeight) * 100}%`,
    width: `${(frame.width / metrics.viewportWidth) * 100}%`,
    height: `${(frame.height / metrics.viewportHeight) * 100}%`,
  };
}
