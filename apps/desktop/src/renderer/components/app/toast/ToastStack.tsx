import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";

import { ToastCard, type ToastCardAction, type ToastCardModel } from "../../ui/notice/ToastCard";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type Toast,
} from "./toastStore";

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
        <motion.div
          key={toast.id}
          layout="position"
          initial={{ opacity: 0, y: 8, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, x: 18, transition: { duration: 0.14 } }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        >
          <ToastStackCard toast={toast} />
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

function toCardActions(toast: Toast): ToastCardAction[] | undefined {
  if (toast.actions) return toast.actions;
  const list: ToastCardAction[] = [];
  if (toast.action) list.push({ label: toast.action.label, onClick: toast.action.onClick, variant: "primary" });
  if (toast.secondaryAction) {
    list.push({ label: toast.secondaryAction.label, onClick: toast.secondaryAction.onClick, variant: "secondary" });
  }
  return list.length > 0 ? list : undefined;
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

  const model: ToastCardModel = {
    tone: toast.tone,
    title: toast.title,
    message: toast.message,
    icon: toast.icon,
    badge: toast.badge,
    eyebrow: toast.eyebrow,
    colorDot: toast.colorDot,
    chips: toast.chips,
    content: toast.content,
    error: toast.error,
    busy: toast.busy,
    actions: toCardActions(toast),
    dismissible: toast.dismissible,
    closeTitle: toast.closeTitle,
  };

  return (
    <ToastCard
      model={model}
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
