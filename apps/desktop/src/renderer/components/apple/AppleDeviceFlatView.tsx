import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { cn } from "../ui/cn";

/**
 * The flat presenter: the decoded canvas, centred and `object-contain`, plus
 * the pointer mapping from screen pixels to device points.
 *
 * There is no bezel and no window chrome to compensate for — the frames ARE
 * the device screen — so the mapping is the `object-contain` box and nothing
 * else. The old window-capture path needed a calibrated bezel rect here, and
 * every bug it produced (an unscaled tap, a tap landing on the Simulator's own
 * title bar) came from that compensation being wrong.
 */

export type AppleDeviceGeometry = {
  /** Rendered screen box in container-local CSS pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Device POINTS per CSS pixel. */
  scale: number;
};

export type AppleDeviceInput = {
  phase: "begin" | "move" | "end";
  /** Device POINTS, origin top-left. */
  x: number;
  y: number;
};

export type AppleDeviceFlatViewProps = {
  /** Decoded frame size in PIXELS. Null before the first frame. */
  screenPixelSize: { width: number; height: number } | null;
  /** Device size in POINTS. Falls back to pixels when the host did not say. */
  devicePointSize: { width: number; height: number } | null;
  /** False while watching, or while inspect owns the pointer. */
  interactive: boolean;
  onDeviceInput: (input: AppleDeviceInput) => void;
  /** Wheel over the device is forwarded as a scroll, in device points. */
  onDeviceScroll?: (delta: { x: number; y: number; deltaX: number; deltaY: number }) => void;
  /**
   * Publishes the device→view mapping the inspect overlay draws with. Null
   * whenever there is nothing to map against yet.
   */
  onGeometryChange?: (geometry: AppleDeviceGeometry | null) => void;
  /**
   * Drawn above the screen box, inside its bounds — the inspect overlay.
   *
   * The decoded canvas is deliberately NOT a child of this view. The stage
   * keeps it in one stable DOM position for the life of the stream and moves
   * only its box, because re-parenting it on a flat/3D switch would remount the
   * reader and black-frame the device — which the spec calls a bug by name.
   */
  screenOverlay?: ReactNode;
  className?: string;
};

/**
 * The `object-contain` box for `content` inside `container`.
 *
 * Never upscaled past 1× device pixels, per the spec: a 393pt phone on a
 * 1400px column is centred at its own size rather than blown up into mush.
 */
export function measureAppleScreenBox(
  container: { width: number; height: number },
  content: { width: number; height: number },
): { left: number; top: number; width: number; height: number } | null {
  if (container.width <= 0 || container.height <= 0) return null;
  if (content.width <= 0 || content.height <= 0) return null;
  const fit = Math.min(container.width / content.width, container.height / content.height);
  const scale = Math.min(fit, 1);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

export function AppleDeviceFlatView({
  screenPixelSize,
  devicePointSize,
  interactive,
  onDeviceInput,
  onDeviceScroll,
  onGeometryChange,
  screenOverlay,
  className,
}: AppleDeviceFlatViewProps) {
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
  const contentSize = devicePointSize ?? screenPixelSize;

  const box = useMemo(() => (
    contentSize ? measureAppleScreenBox(containerSize, contentSize) : null
  ), [containerSize, contentSize]);

  const geometry = useMemo<AppleDeviceGeometry | null>(() => {
    if (!box || !contentSize || box.width <= 0) return null;
    return { ...box, scale: contentSize.width / box.width };
  }, [box, contentSize]);

  useEffect(() => {
    onGeometryChange?.(geometry);
  }, [geometry, onGeometryChange]);

  const toDevicePoint = useCallback((event: PointerEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>) => {
    const node = containerRef.current;
    if (!node || !geometry) return null;
    const rect = node.getBoundingClientRect();
    const x = (event.clientX - rect.left - geometry.left) * geometry.scale;
    const y = (event.clientY - rect.top - geometry.top) * geometry.scale;
    if (!contentSize) return null;
    // Clamped rather than refused: a drag that leaves the screen edge should
    // end at the edge, not vanish and leave the device holding a touch.
    return {
      x: Math.max(0, Math.min(contentSize.width, x)),
      y: Math.max(0, Math.min(contentSize.height, y)),
    };
  }, [contentSize, geometry]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const point = toDevicePoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    onDeviceInput({ phase: "begin", ...point });
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = toDevicePoint(event);
    if (!point) return;
    onDeviceInput({ phase: "end", ...point });
  }, [onDeviceInput, toDevicePoint]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!interactive || !onDeviceScroll) return;
    const point = toDevicePoint(event);
    if (!point) return;
    onDeviceScroll({ ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  }, [interactive, onDeviceScroll, toDevicePoint]);

  return (
    <div
      ref={containerRef}
      data-apple-flat-view=""
      className={cn("relative h-full w-full min-h-0 min-w-0 overflow-hidden", className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={handleWheel}
      style={{ cursor: interactive ? "default" : undefined }}
    >
      {box ? (
        <div
          data-apple-screen-box=""
          className="absolute"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          {screenOverlay}
        </div>
      ) : null}
    </div>
  );
}
