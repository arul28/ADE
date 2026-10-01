import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** Movement before a press becomes a drag, so a plain click still clicks. */
const DRAG_START_PX = 5;
/**
 * How far past the tab strip, up or down, the pointer must go to pull the tab
 * into its own window. Chrome uses a similar small band: far enough that a
 * sloppy horizontal drag does not tear, near enough that no one has to leave
 * the window to do it.
 */
const TEAR_OFF_PX = 32;
/** The flex gap between tabs (`gap-1`). */
const TAB_GAP_PX = 4;

export const PROJECT_TAB_KEY_ATTR = "data-project-tab-key";

/** Screen points per CSS pixel: the page zoom. */
export function cssToScreenScale(): number {
  const scale = window.ade?.zoom?.getFactor?.() ?? 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

type DragSession = {
  key: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  startY: number;
  order: string[];
  tabRect: DOMRect;
  centers: Map<string, number>;
  started: boolean;
  torn: boolean;
  targetIndex: number;
};

export type TearOffGrab = { x: number; y: number };
/** A pointer position in screen coordinates (DIP), as main places windows. */
export type ScreenPoint = { x: number; y: number };

export type TearOffStart = {
  key: string;
  /** The pointer's offset from the top-left of the window that will follow it. */
  grab: TearOffGrab;
  /** The tab was the window's only tab, so the window itself follows. */
  moveSource: boolean;
  point: ScreenPoint;
};

/**
 * Where a tab dropped at `clientX` lands in the strip: the index of the first
 * tab whose midpoint is to the right of it. `excludeKey` is the tab being
 * placed, which must not count against itself.
 */
export function insertIndexAtClientX(
  strip: HTMLElement,
  clientX: number,
  excludeKey: string,
): number {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(`[${PROJECT_TAB_KEY_ATTR}]`))
    .filter((tab) => tab.getAttribute(PROJECT_TAB_KEY_ATTR) !== excludeKey);
  const index = tabs.findIndex((tab) => {
    const rect = tab.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return index === -1 ? tabs.length : index;
}

/**
 * Chrome-style dragging for the project tab strip.
 *
 * - Drag sideways: the other tabs slide out of the way, and release commits
 *   the new order.
 * - Pull the tab a little above or below the strip: it leaves the strip at
 *   once. Main opens a window for it under the cursor (or moves this window,
 *   when it held only that tab) and keeps it under the cursor until release.
 * - Release over another window's tab strip: that window adopts the tab.
 *
 * Pointer events, not HTML5 drag-and-drop: HTML5 drag cannot move a real
 * window while dragging, which is why the old tear-off only fired after the
 * tab was dropped outside every ADE window.
 */
export function useProjectTabDrag(args: {
  stripRef: RefObject<HTMLElement | null>;
  canTearOff: boolean;
  onReorder: (orderedKeys: string[]) => void;
  onTearOff: (tearOff: TearOffStart) => void;
  onTearOffMove: (point: ScreenPoint) => void;
  /** `point` is null when the drag was cancelled; nothing may merge then. */
  onTearOffEnd: (point: ScreenPoint | null) => void;
}) {
  const { stripRef } = args;
  const latest = useRef(args);
  latest.current = args;
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<{
    key: string;
    dx: number;
    targetIndex: number;
    order: string[];
    width: number;
    torn: boolean;
  } | null>(null);

  const finish = useCallback((commit: boolean, point: ScreenPoint | null = null) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setDrag(null);
    if (!session) return;
    if (session.element.hasPointerCapture?.(session.pointerId)) {
      session.element.releasePointerCapture(session.pointerId);
    }
    if (!session.started) return;
    // The click that follows a drag's pointer-up must not also switch tabs.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (session.torn) {
      latest.current.onTearOffEnd(point);
      return;
    }
    if (!commit) return;
    const from = session.order.indexOf(session.key);
    if (from === -1 || from === session.targetIndex) return;
    const next = session.order.filter((key) => key !== session.key);
    next.splice(session.targetIndex, 0, session.key);
    latest.current.onReorder(next);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (session.torn) {
        latest.current.onTearOffMove({ x: event.screenX, y: event.screenY });
        return;
      }
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (!session.started) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        session.started = true;
        session.element.setPointerCapture?.(session.pointerId);
      }

      const strip = stripRef.current?.getBoundingClientRect() ?? null;
      const outside =
        strip != null
        && (event.clientY < strip.top - TEAR_OFF_PX
          || event.clientY > strip.bottom + TEAR_OFF_PX
          || event.clientX < 0
          || event.clientX > window.innerWidth);
      if (outside && latest.current.canTearOff && strip) {
        session.torn = true;
        const moveSource = session.order.length === 1;
        // Where the pointer sits inside the new window: the tab becomes that
        // window's first tab, so keep the grab point within the tab and move
        // the tab to the start of the strip. A lone tab drags its own window,
        // so the grab point is simply where the pointer is in this window.
        // Main places windows in screen points; the page may be zoomed, so
        // CSS pixels convert by the window's zoom factor.
        const zoom = cssToScreenScale();
        const grab = moveSource
          ? { x: session.startX * zoom, y: session.startY * zoom }
          : {
              x: (strip.left + (session.startX - session.tabRect.left)) * zoom,
              y: session.startY * zoom,
            };
        setDrag((prev) => (prev ? { ...prev, torn: true } : prev));
        latest.current.onTearOff({
          key: session.key,
          grab,
          moveSource,
          point: { x: event.screenX, y: event.screenY },
        });
        return;
      }

      const draggedCenter = session.tabRect.left + session.tabRect.width / 2 + dx;
      let targetIndex = 0;
      for (const key of session.order) {
        if (key === session.key) continue;
        if ((session.centers.get(key) ?? 0) < draggedCenter) targetIndex += 1;
      }
      session.targetIndex = targetIndex;
      setDrag({
        key: session.key,
        dx,
        targetIndex,
        order: session.order,
        width: session.tabRect.width,
        torn: false,
      });
    };
    const onUp = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      finish(true, { x: event.screenX, y: event.screenY });
    };
    // A cancelled pointer, or capture lost before pointer-up, ends the drag
    // without committing an order or a drop.
    const onCancel = (event: PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("lostpointercapture", onCancel, true);
    return () => {
      // Unmounting mid-drag cancels it, so main stops moving a torn window.
      finish(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("lostpointercapture", onCancel, true);
    };
  }, [finish, stripRef]);

  const onTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, key: string) => {
      if (event.button !== 0 || sessionRef.current) return;
      if ((event.target as HTMLElement).closest("button")) return;
      const strip = stripRef.current;
      if (!strip) return;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>(`[${PROJECT_TAB_KEY_ATTR}]`));
      const order: string[] = [];
      const centers = new Map<string, number>();
      for (const tab of tabs) {
        const tabKey = tab.getAttribute(PROJECT_TAB_KEY_ATTR);
        if (!tabKey) continue;
        const rect = tab.getBoundingClientRect();
        order.push(tabKey);
        centers.set(tabKey, rect.left + rect.width / 2);
      }
      const index = order.indexOf(key);
      if (index === -1) return;
      sessionRef.current = {
        key,
        pointerId: event.pointerId,
        element: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        order,
        tabRect: event.currentTarget.getBoundingClientRect(),
        centers,
        started: false,
        torn: false,
        targetIndex: index,
      };
    },
    [stripRef],
  );

  const tabDragStyle = useCallback(
    (key: string): CSSProperties | undefined => {
      if (!drag) return undefined;
      if (key === drag.key) {
        return drag.torn
          ? { opacity: 0 }
          : {
              transform: `translateX(${drag.dx}px)`,
              transition: "none",
              zIndex: 10,
              position: "relative",
            };
      }
      if (drag.torn) return undefined;
      const from = drag.order.indexOf(drag.key);
      const index = drag.order.indexOf(key);
      const shift = drag.width + TAB_GAP_PX;
      let offset = 0;
      if (from < drag.targetIndex && index > from && index <= drag.targetIndex) offset = -shift;
      if (from > drag.targetIndex && index >= drag.targetIndex && index < from) offset = shift;
      return {
        transform: offset ? `translateX(${offset}px)` : undefined,
        transition: "transform 150ms ease",
      };
    },
    [drag],
  );

  /**
   * True for the click that a drag's pointer-up produces. The flag clears on
   * the next task, after that click has been dispatched.
   */
  const isDragClick = useCallback(() => suppressClickRef.current, []);

  return {
    onTabPointerDown,
    tabDragStyle,
    isDragClick,
  };
}
