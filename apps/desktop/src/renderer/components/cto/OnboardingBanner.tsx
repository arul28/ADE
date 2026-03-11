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
        "flex items-center gap-3 border-b border-accent/20 px-4 py-2",
        className,
      )}
      style={{ background: "linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 16%, transparent) 0%, transparent 75%)" }}
    >
      <div className="flex-1 min-w-0">
        <span className="font-mono text-[10px] text-fg/80">
          Your CTO setup is incomplete.
        </span>
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[1px] text-accent hover:text-accent/80 transition-colors"
      >
        Continue Setup
        <ArrowRight size={10} weight="bold" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-fg/40 hover:text-fg transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}
