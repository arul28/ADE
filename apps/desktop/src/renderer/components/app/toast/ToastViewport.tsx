import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Z_LAYERS } from "../../ui/zLayers";
import { TOAST_MOTION_PROPS, ToastStack } from "./ToastStack";
import { useCornerObstacle, type CornerObstacleRect } from "./toastViewportInsets";

/** Distance from the content area's bottom and right edges. */
export const TOAST_VIEWPORT_INSET_PX = 12;
/** Space between stacked cards, and between the stack and a HUD below it. */
export const TOAST_VIEWPORT_GAP_PX = 8;
const MAX_WIDTH_PX = 380;

/**
 * How far the stack must rise to clear the obstacle (the CTO call HUD), given
 * the box the viewport is positioned in and the column the stack occupies.
 * Zero when the obstacle is elsewhere (dragged away, or not in the column).
 * Pure for tests.
 */
export function toastViewportLift(
  container: { right: number; bottom: number },
  columnWidth: number,
  obstacle: CornerObstacleRect | null,
): number {
  if (!obstacle) return 0;
  const columnRight = container.right - TOAST_VIEWPORT_INSET_PX;
  const columnLeft = columnRight - columnWidth;
  const overlapsColumn = obstacle.right > columnLeft && obstacle.left < columnRight;
  const reachesCorner = obstacle.bottom > container.bottom - TOAST_VIEWPORT_INSET_PX - TOAST_VIEWPORT_GAP_PX * 4;
  if (!overlapsColumn || !reachesCorner) return 0;
  return Math.max(0, Math.round(container.bottom - obstacle.top + TOAST_VIEWPORT_GAP_PX - TOAST_VIEWPORT_INSET_PX));
}

/**
 * The one bottom-right notice corner. It owns placement for everything that
 * floats there — position, width, gap, stacking layer, pointer handling and
 * order — so no toast-like surface positions itself.
 *
 * Always mounted (so exit animations can play) and `pointer-events: none`, so
 * the empty corner never swallows clicks; every card re-enables its own.
 *
 * Order, top to bottom: store toasts (oldest first), then the `slot` (the live
 * Launches panel), which sits closest to the corner.
 */
export function ToastViewport({ slot, slotKey }: { slot?: ReactNode; slotKey?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const obstacle = useCornerObstacle();
  const [lift, setLift] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const recompute = () => {
      const container = (element.offsetParent ?? element.parentElement)?.getBoundingClientRect();
      if (!container) {
        setLift(0);
        return;
      }
      setLift(toastViewportLift(container, element.offsetWidth || MAX_WIDTH_PX, obstacle));
    };
    recompute();
    if (!obstacle) return undefined;
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [obstacle]);

  return (
    <div
      ref={ref}
      data-testid="toast-viewport"
      data-ade-toast-viewport=""
      className="ade-toast-viewport"
      style={{
        position: "absolute",
        right: TOAST_VIEWPORT_INSET_PX,
        bottom: TOAST_VIEWPORT_INSET_PX + lift,
        zIndex: Z_LAYERS.toast,
        width: `min(${MAX_WIDTH_PX}px, calc(100% - ${TOAST_VIEWPORT_INSET_PX * 2}px))`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: TOAST_VIEWPORT_GAP_PX,
        pointerEvents: "none",
      }}
    >
      <ToastStack />
      <AnimatePresence initial={false}>
        {slot ? (
          <motion.div key={slotKey ?? "slot"} {...TOAST_MOTION_PROPS}>
            {slot}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
