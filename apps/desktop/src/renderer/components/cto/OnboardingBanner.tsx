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
        "border-b border-white/[0.06] px-4 py-3",
        className,
      )}
      style={{
        background: "linear-gradient(90deg, rgba(167,139,250,0.08), rgba(251,191,36,0.04) 35%, rgba(255,255,255,0) 100%)",
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border"
            style={{
              background: "rgba(167, 139, 250, 0.12)",
              borderColor: "rgba(167, 139, 250, 0.22)",
              boxShadow: "0 0 20px rgba(167, 139, 250, 0.12)",
            }}
          >
            <div className="h-1.5 w-1.5 rounded-full" style={{ background: "#A78BFA" }} />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-fg/82">CTO setup is still in progress</div>
            <div className="mt-0.5 text-[11px] leading-5 text-muted-fg/40">
              Pick a personality overlay for the persistent CTO. ADE handles project context and memory automatically.
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-all duration-200"
            style={{ color: "#A78BFA", background: "rgba(167, 139, 250, 0.1)", border: "1px solid rgba(167, 139, 250, 0.18)" }}
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
