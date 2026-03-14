import React from "react";
import { ArrowRight, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export function OnboardingBanner({
  onContinue,
  onDismiss,
  className,
}: {
  onContinue: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-b border-white/[0.05] px-4 py-2.5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: "#A78BFA", boxShadow: "0 0 6px rgba(167, 139, 250, 0.5)" }} />
          <span className="text-xs font-medium text-fg/70">Setup incomplete</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200"
            style={{ color: "#A78BFA", background: "rgba(167, 139, 250, 0.08)", border: "1px solid rgba(167, 139, 250, 0.15)" }}
          >
            Continue
            <ArrowRight size={10} weight="bold" />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg p-1.5 text-muted-fg/40 transition-colors hover:text-fg"
            aria-label="Dismiss setup banner"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
