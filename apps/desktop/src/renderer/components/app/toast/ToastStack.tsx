import { useEffect } from "react";
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";

import { ToastCard } from "../../ui/notice/ToastCard";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type Toast,
} from "./toastStore";

/**
 * Enter/exit motion for every card in the bottom-right corner — store toasts
 * and the viewport's slot — so they all move the same way.
 */
export const TOAST_MOTION_PROPS = {
  layout: "position",
  initial: { opacity: 0, y: 8, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, x: 18, transition: { duration: 0.14 } },
  transition: { duration: 0.18, ease: [0.2, 0, 0, 1] },
} as const satisfies HTMLMotionProps<"div">;

/**
 * Renders the shared toast store through the one `ToastCard`. Mounted inside
 * AppShell's bottom-right viewport; the viewport is `pointer-events-none`, so
 * each card re-enables pointer events itself. Oldest first, so the newest toast
 * sits closest to the corner.
 */
export function ToastStack() {
  const toasts = useToasts();
  return (
    <AnimatePresence initial={false}>
      {toasts.map((toast) => (
        <motion.div key={toast.id} {...TOAST_MOTION_PROPS}>
          <ToastStackCard toast={toast} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/**
 * One card, and the only place that can say a toast is really on screen.
 *
 * Split out of the map purely so `onRendered` can be an effect: it has to run
 * after React commits this card, which is the difference between "queued" and
 * "shown" for the callers that report delivery upstream.
 */
function ToastStackCard({ toast }: { toast: Toast }) {
  const onRendered = toast.onRendered;
  useEffect(() => {
    onRendered?.();
  }, [onRendered]);

  return (
    <ToastCard
      model={toast}
      onMouseEnter={() => pauseToast(toast.id)}
      onMouseLeave={() => resumeToast(toast.id)}
      onClose={() => {
        toast.onClose?.();
        dismissToast(toast.id);
      }}
      onAction={(action) => {
        if (!action.keepOpen) dismissToast(toast.id);
      }}
    />
  );
}
