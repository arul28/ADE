import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Z_LAYERS } from "../../ui/zLayers";
import { TOAST_MOTION_PROPS, ToastStack } from "./ToastStack";

/** Distance from the content area's bottom and right edges. */
export const TOAST_VIEWPORT_INSET_PX = 12;
/** Space between stacked cards. */
export const TOAST_VIEWPORT_GAP_PX = 8;
const MAX_WIDTH_PX = 380;

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
  return (
    <div
      data-testid="toast-viewport"
      data-ade-toast-viewport=""
      style={{
        position: "absolute",
        right: TOAST_VIEWPORT_INSET_PX,
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
