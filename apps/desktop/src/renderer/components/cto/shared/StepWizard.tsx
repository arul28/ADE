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
  const progressPercent = steps.length > 1 ? ((Math.max(activeIndex, 0) + 1) / steps.length) * 100 : 100;

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
    <div className="flex h-full min-h-0">
      {/* Left rail — step indicators */}
      <div
        className="shrink-0 flex flex-col border-r border-border/20 py-6 px-4"
        style={{ width: 236, background: "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)" }}
      >
        <div className="mb-6">
          <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/40">
            Setup
          </div>
          <div className="mt-2 text-sm font-semibold text-fg">
            Step {Math.max(activeIndex, 0) + 1} of {steps.length}
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full bg-[color:color-mix(in_srgb,var(--color-accent)_75%,white_25%)] transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
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
                  "group flex items-start gap-3 rounded-2xl border px-3 py-3 text-left transition-all",
                  isActive
                    ? "border-accent/30 bg-accent/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                    : isDone
                      ? "border-white/[0.08] bg-white/[0.03]"
                      : "border-transparent bg-transparent hover:border-white/[0.06] hover:bg-white/[0.02]",
                )}
              >
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full border transition-all",
                      isDone
                        ? "border-accent/40 bg-accent/18 text-accent"
                        : isActive
                          ? "border-accent/30 bg-accent/10 text-accent"
                          : "border-border/20 bg-white/[0.02] text-muted-fg/35",
                    )}
                  >
                    {isDone ? (
                      <Check size={10} weight="bold" />
                    ) : (
                      <Icon size={11} weight={isActive ? "bold" : "regular"} />
                    )}
                  </div>
                  {i < steps.length - 1 ? (
                    <div className={cn("mt-2 h-6 w-px", isDone ? "bg-accent/30" : "bg-border/20")} />
                  ) : null}
                </div>

                <div className="min-w-0">
                  <div
                    className={cn(
                      "font-mono text-[10px] uppercase tracking-[0.18em] transition-colors",
                      isActive
                        ? "font-bold text-fg"
                        : isDone
                          ? "text-fg/78"
                          : "text-muted-fg/48",
                    )}
                  >
                    {step.label}
                  </div>
                  {step.description ? (
                    <div
                      className={cn(
                        "mt-1 text-xs leading-5 transition-colors",
                        isActive
                          ? "text-fg/70"
                          : isDone
                            ? "text-muted-fg/62"
                            : "text-muted-fg/40",
                      )}
                    >
                      {step.description}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-auto rounded-2xl border border-white/[0.05] bg-black/15 p-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-fg/45">
            Workflow
          </div>
          <div className="mt-2 text-xs leading-5 text-fg/68">
            Move step by step, go back when needed, and use the rail to revisit any section before you finish.
          </div>
        </div>
      </div>

      {/* Right — content area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>

        {/* Bottom bar */}
        <div className="shrink-0 flex items-center justify-between border-t border-border/20 bg-bg/95 px-5 py-3 backdrop-blur">
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
