import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Room kept clear past the active tab when it is scrolled into view. */
const TAB_STRIP_EDGE_PX = 20;

/**
 * The project tab strip scrolls sideways behind the new-tab buttons pinned
 * after it once its tabs reach their minimum width. This marks which edges
 * are clipped (CSS fades them), brings the active tab into view whenever
 * `layoutKey` changes, and lets a plain mouse wheel scroll it too; trackpads
 * and shift-wheel already scroll it natively. Attributes are written straight
 * to the DOM so scrolling never re-renders the top bar.
 */
export function useProjectTabStripOverflow(
  stripRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
): void {
  const pressedRef = useRef(false);

  const syncEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const hidden = strip.scrollWidth - strip.clientWidth;
    strip.toggleAttribute("data-overflow-start", strip.scrollLeft > 1);
    strip.toggleAttribute("data-overflow-end", strip.scrollLeft < hidden - 1);
  }, [stripRef]);

  const revealActiveTab = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // With a new tab, Settings or a machine tab in front, the bound project
    // tab can read active too; the last active tab is the one in front.
    const actives = strip.querySelectorAll<HTMLElement>(':scope > [data-state="active"]');
    const active = actives[actives.length - 1];
    // Offsets are layout pixels relative to the strip (it is positioned), so
    // page zoom and the strip's own scroll do not skew them.
    if (active) {
      const start = active.offsetLeft - TAB_STRIP_EDGE_PX;
      const end = active.offsetLeft + active.offsetWidth + TAB_STRIP_EDGE_PX;
      if (start < strip.scrollLeft) {
        strip.scrollLeft = Math.max(0, start);
      } else if (end > strip.scrollLeft + strip.clientWidth) {
        strip.scrollLeft = end - strip.clientWidth;
      }
    }
    syncEdges();
  }, [stripRef, syncEdges]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft += event.deltaY;
    };
    // A tab switches on press. Scrolling under a held pointer would pull the
    // tab out from under a drag that is starting, so the reveal waits for
    // the release.
    const onPointerDown = () => {
      pressedRef.current = true;
    };
    const onPointerUp = () => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      revealActiveTab();
    };
    strip.addEventListener("scroll", syncEdges, { passive: true });
    strip.addEventListener("wheel", onWheel, { passive: true });
    strip.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(syncEdges)
      : null;
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", syncEdges);
      strip.removeEventListener("wheel", onWheel);
      strip.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      observer?.disconnect();
    };
  }, [revealActiveTab, stripRef, syncEdges]);

  useLayoutEffect(() => {
    if (pressedRef.current) {
      syncEdges();
      return;
    }
    revealActiveTab();
  }, [layoutKey, revealActiveTab, syncEdges]);
}
