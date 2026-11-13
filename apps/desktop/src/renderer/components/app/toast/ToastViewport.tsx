import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";

import { Z_LAYERS } from "../../ui/zLayers";
import { AppSuggestionCard, useVisibleAppSuggestion } from "../../ui/notice/AppSuggestionStack";
import { TOAST_MOTION_PROPS, ToastStack } from "./ToastStack";
import { pickNoticeCorner, setNoticeCornerHeld, useBrowserPageRects, type NoticeCorner } from "./cornerNoticeDock";

/** Distance from the content area's bottom and side edges. */
export const TOAST_VIEWPORT_INSET_PX = 12;
/** Space between stacked cards. */
export const TOAST_VIEWPORT_GAP_PX = 8;
const MAX_WIDTH_PX = 380;
const NO_SLOTS: ReadonlyArray<{ key: string; node: ReactNode }> = [];

/**
 * Which corner the stack uses, re-checked when a page moves, the window
 * resizes, or the stack grows. The parent is `main`, so the left corner sits
 * over the sidebar whenever the sidebar is open and the browser does not
 * reach it.
 */
function useNoticeCorner(viewportRef: React.RefObject<HTMLDivElement | null>, stackHeight: number): NoticeCorner {
  const pages = useBrowserPageRects();
  const [windowSize, setWindowSize] = useState(0);
  useEffect(() => {
    const onResize = () => setWindowSize((value) => value + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [corner, setCorner] = useState<NoticeCorner>("right");
  useLayoutEffect(() => {
    const parent = viewportRef.current?.parentElement;
    if (!parent) {
      setCorner("right");
      return;
    }
    const box = parent.getBoundingClientRect();
    setCorner(pickNoticeCorner(pages, {
      left: box.left,
      right: box.right,
      bottom: box.bottom,
      inset: TOAST_VIEWPORT_INSET_PX,
      width: Math.min(MAX_WIDTH_PX, Math.max(0, box.width - TOAST_VIEWPORT_INSET_PX * 2)),
      height: stackHeight,
    }));
  }, [pages, stackHeight, viewportRef, windowSize]);
  return corner;
}

/**
 * The one notice corner. It owns placement for everything that floats there —
 * position, width, gap, stacking layer, pointer handling and order — so no
 * toast-like surface positions itself.
 *
 * Always mounted (so exit animations can play) and `pointer-events: none`, so
 * the empty corner never swallows clicks; every card re-enables its own.
 *
 * Order, top to bottom: store toasts (oldest first), then the one situational
 * suggestion (`useAppBanner(..., { placement: "suggestion" })`), which stays
 * put while toasts come and go above it, then the live panels in `slots`
 * order (the ADE Cloud lane changes, then the Launches panel, which sits
 * closest to the corner).
 *
 * A browser page is a native view drawn above the whole window, so a card can
 * never paint over it, and anything that overlaps it freezes it. So the stack
 * uses the first bottom corner of `main` that no live page covers: the right,
 * as always, else the left (over the sidebar, when it is open and the browser
 * is not expanded). When both are covered the stack is held: nothing is
 * drawn (so nothing counts as shown or delivered), every countdown waits, and
 * the stack returns once a corner is free.
 */
export function ToastViewport({
  slots = NO_SLOTS,
}: {
  /** Live panels, top to bottom; a null node is not drawn. */
  slots?: ReadonlyArray<{ key: string; node: ReactNode }>;
}) {
  const suggestion = useVisibleAppSuggestion();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [stackHeight, setStackHeight] = useState(0);
  const corner = useNoticeCorner(viewportRef, stackHeight);
  const held = corner === "held";
  const liveSlots = useMemo(() => slots.filter((panel) => panel.node != null), [slots]);
  // One signal for everything with a clock or a "shown" record
  // (`cornerNoticeDock`): toast countdowns, suggestion claims, panel periods.
  useEffect(() => {
    setNoticeCornerHeld(held);
  }, [held]);
  useEffect(() => () => setNoticeCornerHeld(false), []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      // A held stack draws nothing and measures 0; keep the last real height
      // so the corner decision does not flap between "fits" and "covered".
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) setStackHeight(height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The side to draw on: a held stack keeps the last side it showed on, so a
  // left → held → left round trip slides in from the left again.
  const lastShownSideRef = useRef<"left" | "right">("right");
  if (corner === "left" || corner === "right") lastShownSideRef.current = corner;
  const side = lastShownSideRef.current;
  // A move between corners slides the stack in from the side it now sits on,
  // without remounting it (a remount would reset each card's own state).
  // Coming back from a hold mounts it fresh, which is the point: nothing on
  // it was shown while held.
  const slide = useAnimationControls();
  const lastSideRef = useRef(side);
  useEffect(() => {
    if (lastSideRef.current === side) return;
    lastSideRef.current = side;
    slide.set({ opacity: 0, x: side === "left" ? -24 : 24 });
    void slide.start({ opacity: 1, x: 0, transition: { duration: 0.2, ease: [0.2, 0, 0, 1] } });
  }, [side, slide]);
  return (
    <div
      ref={viewportRef}
      data-testid="toast-viewport"
      data-ade-toast-viewport=""
      data-notice-corner={corner}
      style={{
        position: "absolute",
        [side]: TOAST_VIEWPORT_INSET_PX,
        bottom: TOAST_VIEWPORT_INSET_PX,
        zIndex: Z_LAYERS.toast,
        width: `min(${MAX_WIDTH_PX}px, calc(100% - ${TOAST_VIEWPORT_INSET_PX * 2}px))`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: TOAST_VIEWPORT_GAP_PX,
        pointerEvents: "none",
      }}
    >
      {held ? null : (
      <motion.div
        animate={slide}
        style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: TOAST_VIEWPORT_GAP_PX }}
      >
        <ToastStack />
        <AnimatePresence initial={false}>
          {suggestion ? (
            <motion.div key={`suggestion:${suggestion.id}`} {...TOAST_MOTION_PROPS}>
              <AppSuggestionCard entry={suggestion} />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {liveSlots.map((panel) => (
            <motion.div key={panel.key} {...TOAST_MOTION_PROPS}>
              {panel.node}
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
      )}
    </div>
  );
}
