import React from "react";
import { Check } from "@phosphor-icons/react";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

export type WizardStep = {
  id: string;
  label: string;
  icon: React.ElementType;
  completed?: boolean;
};

export function StepWizard({
  steps,
  activeStep,
  onStepChange,
  children,
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

  const handleNext = () => {
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
    <div className="flex h-full min-h-0">
      {/* Left rail — step indicators */}
      <div
        className="shrink-0 flex flex-col border-r border-border/20 py-6 px-4"
        style={{ width: 200, background: "var(--color-surface-recessed)" }}
      >
        <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/40 mb-6">
          Setup
        </div>

        <div className="flex flex-col gap-0.5">
          {steps.map((step, i) => {
            const isActive = step.id === activeStep;
            const isDone = step.completed || i < activeIndex;
            const Icon = step.icon;

            return (
              <div key={step.id} className="flex items-start gap-3">
                {/* Vertical line + circle */}
                <div className="flex flex-col items-center">
                  <button
                    type="button"
                    disabled={!onStepChange}
                    onClick={() => onStepChange?.(step.id)}
                    className={cn(
                      "flex items-center justify-center w-6 h-6 shrink-0 border transition-all",
                      isDone
                        ? "bg-accent/20 border-accent/40 text-accent"
                        : isActive
                          ? "bg-accent/10 border-accent/30 text-accent"
                          : "bg-surface-recessed border-border/20 text-muted-fg/30",
                    )}
                  >
                    {isDone ? (
                      <Check size={10} weight="bold" />
                    ) : (
                      <Icon size={10} weight={isActive ? "bold" : "regular"} />
                    )}
                  </button>
                  {i < steps.length - 1 && (
                    <div
                      className={cn(
                        "w-px h-6",
                        isDone ? "bg-accent/30" : "bg-border/20",
                      )}
                    />
                  )}
                </div>

                {/* Label */}
                <span
                  className={cn(
                    "font-mono text-[10px] mt-1.5 transition-colors",
                    isActive
                      ? "text-fg font-bold"
                      : isDone
                        ? "text-muted-fg"
                        : "text-muted-fg/40",
                  )}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right — content area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>

        {/* Bottom bar */}
        <div className="shrink-0 flex items-center justify-between border-t border-border/20 px-6 py-3">
          <div>
            {showSkip && onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="font-mono text-[10px] text-muted-fg/50 hover:text-fg transition-colors"
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
                ? "Working..."
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
