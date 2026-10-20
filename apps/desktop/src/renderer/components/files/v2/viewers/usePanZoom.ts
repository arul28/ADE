import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { cssZoomOf } from "../../../../lib/webZoom";

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
/** Per-notch factor for ctrl/⌘ + wheel (trackpad pinch arrives as ctrl+wheel). */
const WHEEL_ZOOM_STEP = 1.12;
/** Per-click factor for the zoom buttons. */
const BUTTON_ZOOM_STEP = 1.2;

type Offset = { x: number; y: number };

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Pan and zoom state for a previewed image or diagram: ctrl/⌘-wheel and
 * button zoom, drag-to-pan, and a "fit" state in which no transform applies.
 *
 * - `initialFit` starts (and `reset` returns) in fit mode, where the content
 *   sizes itself and dragging does nothing. Pass `false` when the caller sizes
 *   the content with `setView` instead (Mermaid computes its own fit scale).
 * - Drag distance is divided by the web build's CSS zoom so the content
 *   tracks the pointer at any app zoom level.
 * - Pointerdowns on buttons inside the surface (an error banner's actions)
 *   are left alone so they still click.
 * - Wheel zoom is a native listener attached through `wheelRef`, because
 *   React's root wheel listener is passive: its `preventDefault()` could not
 *   stop a pinch from zooming the whole page in the web client.
 */
export function usePanZoom({ initialFit = true }: { initialFit?: boolean } = {}) {
  const [fit, setFit] = useState(initialFit);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; origin: Offset } | null>(null);

  const zoomBy = useCallback((factor: number) => {
    setFit(false);
    setScale((previous) => clampScale(previous * factor));
  }, []);

  /** Jump to an explicit scale, centred. */
  const setView = useCallback((nextScale: number) => {
    setFit(false);
    setScale(clampScale(nextScale));
    setOffset({ x: 0, y: 0 });
  }, []);

  const reset = useCallback(() => {
    setFit(initialFit);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [initialFit]);

  const wheelCleanupRef = useRef<(() => void) | null>(null);
  /** Attach to the pan surface; zooms on ctrl/⌘ + wheel and trackpad pinch. */
  const wheelRef = useCallback((element: HTMLElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => element.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const endDrag = () => {
    dragRef.current = null;
  };

  const panHandlers = {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (fit || event.button !== 0) return;
      if ((event.target as Element | null)?.closest?.("button")) return;
      dragRef.current = { x: event.clientX, y: event.clientY, origin: offset };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const zoom = cssZoomOf();
      setOffset({
        x: drag.origin.x + (event.clientX - drag.x) / zoom,
        y: drag.origin.y + (event.clientY - drag.y) / zoom,
      });
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  const transform = useMemo(
    () => (fit ? undefined : `translate(${offset.x}px, ${offset.y}px) scale(${scale})`),
    [fit, offset.x, offset.y, scale],
  );

  return {
    fit,
    scale,
    offset,
    transform,
    zoomIn: () => zoomBy(BUTTON_ZOOM_STEP),
    zoomOut: () => zoomBy(1 / BUTTON_ZOOM_STEP),
    setView,
    reset,
    panHandlers,
    wheelRef,
  };
}
