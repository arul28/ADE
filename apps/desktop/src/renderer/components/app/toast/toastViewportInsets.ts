import { useEffect, useSyncExternalStore, type RefObject } from "react";

/**
 * Floating chrome that shares the bottom-right corner with the toast stack.
 *
 * The CTO call HUD is fixed to the window's bottom-right corner, sits above the
 * toast layer, and can be dragged anywhere. Rather than guessing its size, it
 * publishes its live on-screen rect here and `ToastViewport` lifts the stack
 * above it only while the two would actually overlap — so a toast never lands
 * under a call, and a HUD dragged out of the way hands the corner back.
 */

export type CornerObstacleRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

let hudRect: CornerObstacleRect | null = null;
const listeners = new Set<() => void>();

function sameRect(a: CornerObstacleRect | null, b: CornerObstacleRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom;
}

export function publishCornerObstacle(rect: CornerObstacleRect | null): void {
  if (sameRect(hudRect, rect)) return;
  hudRect = rect;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CornerObstacleRect | null {
  return hudRect;
}

export function useCornerObstacle(): CornerObstacleRect | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Report an element's on-screen rect as the corner obstacle while it is
 * mounted. Re-measures on resize (of the element and the window) and whenever
 * `revision` changes (e.g. after a drag ends); clears on unmount.
 */
export function useReportCornerObstacle(
  ref: RefObject<HTMLElement | null>,
  revision: unknown = null,
): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        publishCornerObstacle(null);
        return;
      }
      publishCornerObstacle({
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      });
    };
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      publishCornerObstacle(null);
    };
  }, [ref, revision]);
}

/** Test seam. */
export function resetCornerObstacleForTests(): void {
  publishCornerObstacle(null);
}
