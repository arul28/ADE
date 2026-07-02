import { X } from "@phosphor-icons/react";

import { cn } from "../../ui/cn";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type ToastTone,
} from "./toastStore";

/**
 * Renders the shared toast store as compact cards, matching the bespoke
 * bottom-right notices in `AppShell`. Mounted inside AppShell's existing
 * bottom-right container so all toasts share one visual stack; the container is
 * `pointer-events-none`, so each card re-enables `pointer-events-auto`.
 */

function toneClasses(tone: ToastTone): { panel: string; action: string } {
  if (tone === "success") {
    return {
      panel: "border-emerald-500/25 bg-card/95",
      action: "text-emerald-300 hover:text-emerald-200",
    };
  }
  if (tone === "error") {
    return {
      panel: "border-red-500/25 bg-card/95",
      action: "text-red-300 hover:text-red-200",
    };
  }
  return {
    panel: "border-border/60 bg-card/95",
    action: "text-[#A78BFA] hover:text-[#C4B5FD]",
  };
}

export function ToastStack() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <>
      {toasts.map((toast) => {
        const tone = toneClasses(toast.tone);
        return (
          <div
            key={toast.id}
            className={cn(
              "ade-toast-enter pointer-events-auto overflow-hidden rounded-xl border px-3 py-3 shadow-float backdrop-blur",
              tone.panel,
            )}
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {toast.colorDot ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: toast.colorDot }}
                    />
                  ) : null}
                  <div className="min-w-0 truncate text-[13px] font-medium leading-tight text-fg">
                    {toast.title}
                  </div>
                </div>
                {toast.message ? (
                  <div className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-muted-fg">
                    {toast.message}
                  </div>
                ) : null}
                {toast.action ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex items-center text-[11px] font-medium transition-colors",
                        tone.action,
                      )}
                      onClick={() => {
                        toast.action?.onClick();
                        dismissToast(toast.id);
                      }}
                    >
                      {toast.action.label} -&gt;
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-muted-fg transition-colors hover:bg-fg/[0.05] hover:text-fg"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
                title="Dismiss"
              >
                <X size={12} weight="bold" aria-hidden />
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
