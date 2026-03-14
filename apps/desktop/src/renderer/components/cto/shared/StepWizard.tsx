import React from "react";
import { Check } from "@phosphor-icons/react";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

export type WizardStep = {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  completed?: boolean;
};

export function StepWizard({
  steps,
  activeStep,
  onStepChange,
  children,
  onNext,
  onComplete,
  onSkip,
  onBack,
  completeLabel = "Complete",
  nextLabel = "Next",
  skipLabel = "Skip for now",
  showSkip = true,
  completing = false,
}: {
  steps: WizardStep[];
  activeStep: string;
  onStepChange?: (stepId: string) => void;
  children: React.ReactNode;
  onNext?: (stepId: string, isLastStep: boolean) => boolean | void | Promise<boolean | void>;
  onComplete?: () => void;
  onSkip?: () => void;
  onBack?: () => void;
  completeLabel?: string;
  nextLabel?: string;
  skipLabel?: string;
  showSkip?: boolean;
  completing?: boolean;
}) {
  const activeIndex = steps.findIndex((s) => s.id === activeStep);
  const isLast = activeIndex === steps.length - 1;
  const isFirst = activeIndex === 0;

  const handleNext = async () => {
    if (onNext) {
      const result = await onNext(activeStep, isLast);
      if (result === false) return;
    }
    if (isLast) {
      onComplete?.();
    } else {
      onStepChange?.(steps[activeIndex + 1].id);
    }
  };

  const handleBack = () => {
    if (isFirst) {
      onBack?.();
    } else {
      onStepChange?.(steps[activeIndex - 1].id);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Left rail */}
      <div
        className="shrink-0 border-b lg:border-b-0 lg:border-r px-4 py-4 lg:w-[200px] lg:px-4 lg:py-5"
        style={{ borderColor: "rgba(167, 139, 250, 0.06)", background: "rgba(12, 10, 20, 0.5)" }}
      >
        <div className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0 lg:gap-1">
          {steps.map((step, i) => {
            const isActive = step.id === activeStep;
            const isDone = step.completed || i < activeIndex;
            const Icon = step.icon;

            return (
              <button
                key={step.id}
                type="button"
                disabled={!onStepChange}
                onClick={() => onStepChange?.(step.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all duration-200 lg:w-full",
                  isActive
                    ? "bg-[rgba(167,139,250,0.08)]"
                    : "hover:bg-white/[0.02]",
                )}
                style={isActive ? { border: "1px solid rgba(167, 139, 250, 0.15)" } : { border: "1px solid transparent" }}
              >
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all",
                    isDone
                      ? "text-fg"
                      : isActive
                        ? "text-fg"
                        : "text-muted-fg/25",
                  )}
                  style={
                    isDone
                      ? { background: "rgba(52, 211, 153, 0.12)", border: "1px solid rgba(52, 211, 153, 0.2)" }
                      : isActive
                        ? { background: "rgba(167, 139, 250, 0.12)", border: "1px solid rgba(167, 139, 250, 0.2)" }
                        : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }
                  }
                >
                  {isDone ? (
                    <Check size={10} weight="bold" style={{ color: "#34D399" }} />
                  ) : (
                    <Icon size={10} weight={isActive ? "bold" : "regular"} style={isActive ? { color: "#A78BFA" } : undefined} />
                  )}
                </div>

                <span
                  className={cn(
                    "text-xs font-medium whitespace-nowrap",
                    isActive ? "text-fg" : isDone ? "text-fg/60" : "text-muted-fg/35",
                  )}
                >
                  {step.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-4 lg:p-5">
          {children}
        </div>

        {/* Bottom bar */}
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 lg:px-5"
          style={{ borderTop: "1px solid rgba(167, 139, 250, 0.06)", background: "rgba(12, 10, 20, 0.5)" }}
        >
          <div>
            {showSkip && onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="text-[11px] text-muted-fg/40 transition-colors hover:text-fg/60"
              >
                {skipLabel}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <Button variant="ghost" onClick={handleBack}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleNext}
              disabled={completing}
            >
              {completing
                ? "Saving..."
                : isLast
                  ? completeLabel
                  : nextLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
