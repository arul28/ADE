import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

export type FixedAnchor = { x: number; y: number };

export type ClampedFixedPosition = {
  left: number;
  top: number;
};

export function clampFixedPosition(
  anchor: FixedAnchor,
  size: { width: number; height: number },
  padding = 8,
  viewport?: { width: number; height: number },
): ClampedFixedPosition {
  const viewportWidth = viewport?.width ?? (typeof window !== "undefined" ? window.innerWidth : size.width + padding * 2);
  const viewportHeight = viewport?.height ?? (typeof window !== "undefined" ? window.innerHeight : size.height + padding * 2);
  const maxLeft = Math.max(padding, viewportWidth - size.width - padding);
  const maxTop = Math.max(padding, viewportHeight - size.height - padding);
  return {
    left: Math.min(Math.max(padding, anchor.x), maxLeft),
    top: Math.min(Math.max(padding, anchor.y), maxTop),
  };
}

/**
 * Keeps a fixed-position popover inside the viewport after layout, using the
 * element's measured size (handles menus that open near window edges).
 */
export function useClampedFixedPosition(
  anchor: FixedAnchor | null,
  deps: unknown[] = [],
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
    const rect = ref.current.getBoundingClientRect();
    setPosition(clampFixedPosition(anchor, { width: rect.width, height: rect.height }));
  }, [anchor?.x, anchor?.y, ...deps]);

  return { ref, position };
}
