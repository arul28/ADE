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
        "border-b border-white/[0.08] px-4 py-3",
        className,
      )}
      style={{
        background:
          "radial-gradient(circle at left center, rgba(34, 211, 238, 0.14), transparent 28%), linear-gradient(90deg, rgba(255,255,255,0.03) 0%, transparent 100%)",
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300/80">
            Setup remaining
          </div>
          <div className="mt-1 text-sm font-medium text-fg">
            Finish your persistent CTO setup
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-fg/65">
            Three quick steps: define the operator, seed its memory, and decide whether Linear belongs in first-run setup.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden rounded-full border border-white/10 bg-black/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg/70 md:inline-flex">
            Always-on identity
          </div>
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-100 transition-colors hover:bg-cyan-500/16"
          >
            Continue setup
            <ArrowRight size={10} weight="bold" />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full border border-white/10 bg-black/10 p-2 text-muted-fg/55 transition-colors hover:text-fg"
            aria-label="Dismiss setup banner"
          >
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
