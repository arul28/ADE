// Portions adapted from T3 Code (https://github.com/pingdotgg/t3code),
// MIT License, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Adapted: the fit rule, the normalise-against-the-drawn-frame pointer
// mapping, keyboard forwarding from a focused `role="application"` surface,
// and (round 5 §V1) the `rotation`/`sideways` handling that draws the raw
// PORTRAIT framebuffer inside a transposed landscape box.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";
import { cn } from "../ui/cn";

/**
 * The flat presenter: the decoded canvas, centred and `object-contain`, plus
 * the pointer mapping from screen pixels to device points. The iOS simulator
 * and the Android emulator both draw through it.
 *
 * There is no bezel and no window chrome to compensate for — the frames ARE
 * the device screen — so the mapping is the `object-contain` box and nothing
 * else. The old window-capture path needed a calibrated bezel rect here, and
 * every bug it produced (an unscaled tap, a tap landing on the Simulator's own
 * title bar) came from that compensation being wrong.
 */

export type DeviceGeometry = {
  /**
   * Rendered screen box in container-local CSS pixels.
   *
   * This is the box the user SEES, so on a landscape device it is landscape —
   * wider than it is tall — even though the frames inside it are still the
   * portrait framebuffer turned on its side (§V1).
   */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Device POINTS per CSS pixel, in the ORIENTED (drawn) space. */
  scale: number;
  /** How far the raw frame is turned to stand the picture upright. */
  rotation: ScreenRotation;
};

export type DeviceInput = {
  phase: "begin" | "move" | "end";
  /** Device POINTS, origin top-left. */
  x: number;
  y: number;
};

export type DeviceFlatViewProps = {
  /** Decoded frame size in PIXELS. Null before the first frame. */
  screenPixelSize: { width: number; height: number } | null;
  /**
   * Device size in POINTS, as the helper reports it — which is the device's
   * NATIVE (portrait) size whatever way up the device is. Falls back to pixels
   * when the host did not say.
   */
  devicePointSize: { width: number; height: number } | null;
  /**
   * Which way up the device is (§V1).
   *
   * Round 4 never passed this here at all — the word `orientation` did not
   * appear in this file — so a rotated device drew its landscape picture
   * inside a portrait box, lying on its side.
   */
  orientation: DeviceOrientation;
  /** False while watching, or while inspect owns the pointer. */
  interactive: boolean;
  onDeviceInput: (input: DeviceInput) => void;
  /** Wheel over the device is forwarded as a scroll, in device points. */
  onDeviceScroll?: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  /**
   * A key pressed while the screen has focus. Return true when it was
   * forwarded, which is what suppresses the browser's own handling of it.
   */
  onDeviceKey?: (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }) => boolean;
  /**
   * Publishes the device→view mapping the inspect overlay draws with. Null
   * whenever there is nothing to map against yet.
   */
  onGeometryChange?: (geometry: DeviceGeometry | null) => void;
  /**
   * Drawn above the screen box, inside its bounds — the inspect overlay.
   *
   * The decoded canvas is deliberately NOT a child of this view. The stage
   * keeps it in one stable DOM position for the life of the stream and moves
   * only its box, because re-parenting it on a flat/3D switch would remount the
   * reader and black-frame the device — which the spec calls a bug by name.
   */
  screenOverlay?: ReactNode;
  /** What a screen reader calls the screen: each tool names its own. */
  ariaLabel: string;
  /** CSS pixels at the right edge the screen must stay out of: the rail, while it shows. */
  railInset?: number;
  className?: string;
};

/**
 * What the screen box is measured in.
 *
 * POINTS when the host actually knows them, decoded PIXELS otherwise. A
 * present-but-degenerate point size — `{width: 0, height: 0}`, which is what
 * the stream reports before its transport has answered — used to win the `??`
 * and leave the pane with no screen box at all: a live device, 500 decoded
 * frames in, and nothing on screen. Nullish coalescing cannot see that; this
 * can.
 */
export function screenContentSize(
  pointSize: { width: number; height: number } | null | undefined,
  pixelSize: { width: number; height: number } | null | undefined,
): { width: number; height: number } | null {
  if (pointSize && pointSize.width > 0 && pointSize.height > 0) return pointSize;
  if (pixelSize && pixelSize.width > 0 && pixelSize.height > 0) return pixelSize;
  return null;
}

/**
 * How far the screen may grow past its point size (round 4 §A6).
 *
 * Round 3 clamped the fit with `Math.min(fit, 1)`, so a 393pt phone sat at
 * 393 CSS pixels in the middle of a 900px pane and the pane read as empty.
 * The real limit is not the point size, it is the stream's own resolution: a
 * 3× phone decodes at 1179 pixels wide, so on a 2× display it can be drawn up
 * to 589 CSS pixels — 1.5× its point size — before one source pixel has to
 * cover more than one physical pixel. Past that the picture is genuinely
 * being upscaled, which is the mush the old cap was protecting against.
 *
 * Never returns less than 1: a stream whose pixel size is unknown, or already
 * below its point size, keeps the round-3 behaviour rather than shrinking.
 */
export function screenMaxScale(
  content: { width: number; height: number },
  nativePixelSize: { width: number; height: number } | null | undefined,
  pixelRatio: number,
): number {
  if (!nativePixelSize || nativePixelSize.width <= 0 || content.width <= 0) return 1;
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return Math.max(1, nativePixelSize.width / ratio / content.width);
}

/**
 * The `object-contain` box for `content` inside `container`.
 *
 * Grows to fill the pane, capped by `screenMaxScale` so the picture is
 * never blown up past the resolution the stream actually carries.
 *
 * `clearRight` is a strip on the right the box must stay out of (the floating
 * rail). The box is centred in the whole width when it already clears the
 * strip, so a wide pane looks the same; only a box that would run under it is
 * fitted and centred in the width left of it.
 */
export function measureScreenBox(
  container: { width: number; height: number },
  content: { width: number; height: number },
  options?: {
    /** Decoded frame size in PIXELS — the ceiling on growth. */
    nativePixelSize?: { width: number; height: number } | null;
    /** CSS pixels per physical pixel. Defaults to 1. */
    pixelRatio?: number;
    /** CSS pixels at the right edge the box must not cover. Defaults to 0. */
    clearRight?: number;
  },
): { left: number; top: number; width: number; height: number } | null {
  if (container.width <= 0 || container.height <= 0) return null;
  if (content.width <= 0 || content.height <= 0) return null;
  const maxScale = screenMaxScale(content, options?.nativePixelSize, options?.pixelRatio ?? 1);
  const place = (room: number) => {
    const scale = Math.min(room / content.width, container.height / content.height, maxScale);
    const width = content.width * scale;
    const height = content.height * scale;
    return { left: (room - width) / 2, top: (container.height - height) / 2, width, height };
  };
  const box = place(container.width);
  const clear = Math.min(Math.max(0, options?.clearRight ?? 0), container.width / 2);
  return clear > 0 && box.left + box.width > container.width - clear ? place(container.width - clear) : box;
}

/* ── Rotation (round 5 §V1) ───────────────────────────────────────────────── */

/**
 * Degrees the RAW frame is turned by to stand the picture upright. CSS's
 * sign convention: positive is clockwise.
 */
export type ScreenRotation = 0 | 90 | 180 | -90;

/**
 * How far to turn the frame for a device in `orientation`.
 *
 * Adapted (see the file header). The helper
 * encodes the simulator's raw framebuffer, and a rotated iOS device keeps the
 * SAME portrait framebuffer and draws its landscape UI sideways inside it — so
 * the picture is turned here, in the viewer.
 *
 * A frame that already arrives landscape is not turned: that is a helper that
 * has rotated for us, and turning it again would put the picture back on its
 * side. This is the `screen.width > screen.height` guard in the port.
 */
export function screenRotationFor(
  orientation: DeviceOrientation,
  framePixelSize?: { width: number; height: number } | null,
): ScreenRotation {
  if (framePixelSize && framePixelSize.width > 0 && framePixelSize.width > framePixelSize.height) {
    return 0;
  }
  switch (orientation) {
    case "landscape-left":
      return 90;
    case "landscape-right":
      return -90;
    case "portrait-upside-down":
      return 180;
    case "portrait":
      return 0;
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

/** A quarter turn, which is what makes the drawn box a different shape. */
export function rotationIsSideways(rotation: ScreenRotation): boolean {
  return rotation === 90 || rotation === -90;
}

/**
 * A size as the viewer DRAWS it: transposed by a quarter turn, unchanged
 * otherwise. Used for both the point size (which sets the box's shape) and the
 * pixel size (which sets the ceiling on how far it may grow).
 */
export function rotatedSize<T extends { width: number; height: number }>(
  size: T,
  rotation: ScreenRotation,
): { width: number; height: number } {
  return rotationIsSideways(rotation)
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * Where to put the raw frame so it fills `box` once it is turned.
 *
 * Adapted (see the file header): a sideways rotation draws the raw
 * portrait frame into a landscape box by giving the media element the
 * TRANSPOSED size and rotating it about the box's centre. Scaling a portrait
 * frame into a landscape box instead — which is what "just set the width" does
 * — squashes the picture, and rotating without transposing crops it.
 */
export function screenMediaRect(
  box: { left: number; top: number; width: number; height: number },
  rotation: ScreenRotation,
): { left: number; top: number; width: number; height: number; transform: string | undefined } {
  if (!rotationIsSideways(rotation)) {
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`,
    };
  }
  return {
    left: box.left + (box.width - box.height) / 2,
    top: box.top + (box.height - box.width) / 2,
    width: box.height,
    height: box.width,
    transform: `rotate(${rotation}deg)`,
  };
}

/**
 * A point inside the DRAWN box, back to the same point inside the RAW frame.
 *
 * Both are 0..1 fractions. This is the inverse of the CSS rotation above, and
 * it is what a tap needs: the helper's HID layer normalises against the
 * device's NATIVE portrait metrics and the simulator maps that through the
 * interface orientation itself, so the device point a tap carries is a point
 * on the framebuffer, not on the picture the user is looking at.
 */
export function viewToFrameFraction(
  point: { x: number; y: number },
  rotation: ScreenRotation,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: point.y, y: 1 - point.x };
    case -90:
      return { x: 1 - point.y, y: point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 0:
      return { x: point.x, y: point.y };
    default: {
      const _exhaustive: never = rotation;
      return _exhaustive;
    }
  }
}

export function DeviceFlatView({
  screenPixelSize,
  devicePointSize,
  orientation,
  interactive,
  onDeviceInput,
  onDeviceScroll,
  onDeviceKey,
  onGeometryChange,
  screenOverlay,
  ariaLabel,
  railInset = 0,
  className,
}: DeviceFlatViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const draggingRef = useRef(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setContainerSize((current) => (
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      ));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * The screen is laid out in DEVICE POINTS, not decoded pixels.
   *
   * A 3× phone decodes at 1179×2556 and is 393×852 points. Sizing the box from
   * pixels and mapping through a separate scale factor is the same arithmetic
   * twice; sizing it from points means the one number the mapping needs — points
   * per CSS pixel — falls out of the box directly.
   */
  const frameSize = useMemo(
    () => screenContentSize(devicePointSize, screenPixelSize),
    [devicePointSize, screenPixelSize],
  );

  /**
   * §V1: the box is measured in the orientation the user SEES.
   *
   * `frameSize` is the raw frame's own shape — portrait, because that is what
   * the helper encodes whatever way up the device is. `contentSize` is that
   * shape turned, which is what makes a landscape device draw a landscape box
   * instead of a portrait one with the picture lying inside it. The pixel
   * ceiling is transposed with it so the fit rule keeps comparing a long edge
   * to a long edge.
   */
  const rotation = screenRotationFor(orientation, screenPixelSize);
  // Memoized on purpose: these feed `box`, which feeds `geometry`, which the
  // host stores in state. A fresh object per render would make that a loop.
  const contentSize = useMemo(
    () => (frameSize ? rotatedSize(frameSize, rotation) : null),
    [frameSize, rotation],
  );
  const rotatedPixelSize = useMemo(
    () => (screenPixelSize ? rotatedSize(screenPixelSize, rotation) : null),
    [rotation, screenPixelSize],
  );

  const box = useMemo(() => (
    contentSize
      ? measureScreenBox(containerSize, contentSize, {
        nativePixelSize: rotatedPixelSize,
        pixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
        clearRight: railInset,
      })
      : null
  ), [containerSize, contentSize, railInset, rotatedPixelSize]);

  const geometry = useMemo<DeviceGeometry | null>(() => {
    if (!box || !contentSize || box.width <= 0) return null;
    return { ...box, scale: contentSize.width / box.width, rotation };
  }, [box, contentSize, rotation]);

  useEffect(() => {
    onGeometryChange?.(geometry);
  }, [geometry, onGeometryChange]);

  /**
   * Pointer → device point, through the drawn frame's own 0..1 coordinates.
   *
   * The intermediate normalisation is not ceremony: it is the one number that
   * is true no matter how the frame is scaled, letterboxed or (later) rotated,
   * and it is the shape the device's own input protocol takes. Deriving points
   * straight from CSS pixels worked only while the box happened to be
   * unrotated and unscaled past 1×, which is why this is ported rather than
   * re-derived.
   */
  const toDevicePoint = useCallback((event: PointerEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>) => {
    const node = containerRef.current;
    if (!node || !geometry || !frameSize) return null;
    if (geometry.width <= 0 || geometry.height <= 0) return null;
    const rect = node.getBoundingClientRect();
    // The box is laid out in the ResizeObserver's size, which CSS zoom on an
    // ancestor does not scale; the client rect and the pointer are zoomed. The
    // hosted web client zooms <body>, so without this a tap there lands off by
    // the zoom factor (10% at the default 1.1). The ratio is 1 without zoom.
    const zoomX = containerSize.width > 0 && rect.width > 0 ? rect.width / containerSize.width : 1;
    const zoomY = containerSize.height > 0 && rect.height > 0 ? rect.height / containerSize.height : 1;
    const normalizedX = (event.clientX - rect.left - geometry.left * zoomX) / (geometry.width * zoomX);
    const normalizedY = (event.clientY - rect.top - geometry.top * zoomY) / (geometry.height * zoomY);
    // Clamped rather than refused: a drag that leaves the screen edge should
    // end at the edge, not vanish and leave the device holding a touch.
    const clampedX = Math.max(0, Math.min(1, normalizedX));
    const clampedY = Math.max(0, Math.min(1, normalizedY));
    // §V1: back out the rotation before the fraction becomes a device point.
    // The fraction above is of the picture on screen; the device answers in
    // its own framebuffer, which the picture is a turned copy of.
    const onFrame = viewToFrameFraction({ x: clampedX, y: clampedY }, geometry.rotation);
    return {
      x: onFrame.x * frameSize.width,
      y: onFrame.y * frameSize.height,
    };
  }, [containerSize, frameSize, geometry]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const point = toDevicePoint(event);
    if (!point) return;
    // The touch is sent first and the browser's bookkeeping second. Pointer
    // capture is an optimisation — it keeps a drag alive past the frame edge —
    // and `setPointerCapture` throws for a pointer the document no longer
    // owns, which used to take the whole gesture with it and leave the device
    // looking dead to anything that did not hold a real mouse.
    draggingRef.current = true;
    onDeviceInput({ phase: "begin", ...point });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture: a drag that leaves the frame ends at the edge instead.
    }
    // Focus follows the finger, so the keys that follow the tap reach the
    // device instead of whatever the pane focused last.
    event.currentTarget.focus({ preventScroll: true });
  }, [interactive, onDeviceInput, toDevicePoint]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || !draggingRef.current) return;
    const point = toDevicePoint(event);
    if (!point) return;
    onDeviceInput({ phase: "move", ...point });
  }, [interactive, onDeviceInput, toDevicePoint]);

  const endPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Same reason as the capture above: never lose the `end` over it.
    }
    const point = toDevicePoint(event);
    if (!point) return;
    onDeviceInput({ phase: "end", ...point });
  }, [onDeviceInput, toDevicePoint]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !onDeviceKey) return;
    if (event.target !== event.currentTarget) return;
    // Cmd-R and friends stay the app's. Everything else the device can type is
    // the device's while the screen holds focus.
    if (event.metaKey || event.ctrlKey) return;
    const sent = onDeviceKey({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
    });
    if (sent) event.preventDefault();
  }, [interactive, onDeviceKey]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!interactive || !onDeviceScroll) return;
    const point = toDevicePoint(event);
    if (!point) return;
    onDeviceScroll({ ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  }, [interactive, onDeviceScroll, toDevicePoint]);

  return (
    <div
      ref={containerRef}
      data-device-flat-view=""
      className={cn(
        "relative h-full w-full min-h-0 min-w-0 overflow-hidden outline-none",
        interactive && "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
        className,
      )}
      role="application"
      aria-label={ariaLabel}
      tabIndex={interactive ? 0 : -1}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={handleWheel}
      style={{ cursor: interactive ? "default" : undefined }}
    >
      {box ? (
        <div
          data-device-screen-box=""
          className="absolute"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          {screenOverlay}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The device→view mapping for the flat presenter, in the shape the inspect
 * overlay takes. Null in 3D, where the presenter cannot answer mid-orbit.
 *
 * The points it takes are ORIENTED points (an element tree describes the
 * app's own interface, which turns with the device), and `geometry` is the
 * drawn box, which turns with it too. So a rotated device needs no extra
 * term here: both sides rotated together, and the one scale still holds.
 */
export function flatDeviceToView(
  geometry: DeviceGeometry | null,
): ((point: { x: number; y: number }) => { x: number; y: number }) | null {
  if (!geometry || geometry.scale <= 0) return null;
  return (point) => ({ x: point.x / geometry.scale, y: point.y / geometry.scale });
}
