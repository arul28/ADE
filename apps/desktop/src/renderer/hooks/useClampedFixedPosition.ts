import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import { fixedFrameOf, fixedPoint, fixedRect, fixedViewport } from "../lib/webZoom";

export type FixedAnchor = { x: number; y: number };

export type ClampedFixedPosition = {
  left: number;
  top: number;
};

/**
 * Keeps a fixed child inside the viewport. `anchor`, `size` and `viewport` are in
 * one space, the `left`/`top` a fixed child is written in (see `fixedRect`). A
 * viewport with a `left`/`top` other than 0 is the window seen from a transformed
 * container, whose origin is not the window's.
 */
export function clampFixedPosition(
  anchor: FixedAnchor,
  size: { width: number; height: number },
  padding = 8,
  viewport?: { left?: number; top?: number; width: number; height: number },
): ClampedFixedPosition {
  const viewportLeft = viewport?.left ?? 0;
  const viewportTop = viewport?.top ?? 0;
  const viewportWidth = viewport?.width ?? (typeof window !== "undefined" ? window.innerWidth : size.width + padding * 2);
  const viewportHeight = viewport?.height ?? (typeof window !== "undefined" ? window.innerHeight : size.height + padding * 2);
  const minLeft = viewportLeft + padding;
  const minTop = viewportTop + padding;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - size.width - padding);
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - size.height - padding);
  return {
    left: Math.min(Math.max(minLeft, anchor.x), maxLeft),
    top: Math.min(Math.max(minTop, anchor.y), maxTop),
  };
}

/**
 * Keeps a fixed-position popover inside the viewport after layout, using the
 * element's measured size (handles menus that open near window edges).
 *
 * `anchor` is a pointer position (`clientX`/`clientY`). It is a viewport point,
 * the same space as the element's rect, so both go through the element's
 * `fixedFrameOf` before they are clamped and written as `left`/`top`.
 */
export function useClampedFixedPosition(
  anchor: FixedAnchor | null,
  remeasureKey: unknown = null,
): {
  ref: MutableRefObject<HTMLDivElement | null>;
  position: ClampedFixedPosition | null;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<ClampedFixedPosition | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPosition(null);
      return;
    }
    const el = ref.current;
    const frame = fixedFrameOf(el.parentElement);
    const point = fixedPoint(frame, anchor.x, anchor.y);
    const size = fixedRect(frame, el.getBoundingClientRect());
    setPosition(clampFixedPosition(
      { x: point.left, y: point.top },
      { width: size.width, height: size.height },
      8,
      fixedViewport(frame),
    ));
  }, [anchor?.x, anchor?.y, remeasureKey]);

  return { ref, position };
}
