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
  const progress = steps.length > 1 ? ((activeIndex + 1) / steps.length) * 100 : 100;

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
        className="shrink-0 border-b lg:border-b-0 lg:border-r px-4 py-4 lg:w-[250px] lg:px-5 lg:py-5"
        style={{
          borderColor: "rgba(255, 255, 255, 0.06)",
          background: "linear-gradient(180deg, rgba(9, 14, 21, 0.96), rgba(7, 11, 18, 0.92))",
        }}
      >
        <div className="mb-4 hidden lg:block">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-fg/42">
            Setup flow
          </div>
          <div className="mt-2 text-sm font-semibold text-fg">
            Build a persistent CTO
          </div>
          <div className="mt-1 text-[12px] leading-5 text-muted-fg/44">
            Identity, long-term brief, then optional integrations.
          </div>
          <div className="mt-4">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-muted-fg/38">
              <span>Progress</span>
              <span>{activeIndex + 1}/{steps.length}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${progress}%`,
                  background: "linear-gradient(90deg, rgba(56,189,248,0.95), rgba(251,191,36,0.95))",
                  boxShadow: "0 0 18px rgba(56, 189, 248, 0.25)",
                }}
              />
            </div>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0 lg:gap-2">
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
                  "flex min-w-[170px] items-start gap-3 rounded-2xl px-3.5 py-3 text-left transition-all duration-200 lg:w-full lg:min-w-0",
                  isActive
                    ? "bg-[linear-gradient(180deg,rgba(56,189,248,0.12),rgba(56,189,248,0.07))]"
                    : "hover:bg-white/[0.03]",
                )}
                style={isActive
                  ? {
                      border: "1px solid rgba(56, 189, 248, 0.22)",
                      boxShadow: "0 12px 28px rgba(0, 0, 0, 0.18)",
                    }
                  : { border: "1px solid rgba(255,255,255,0.04)" }}
              >
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all",
                    isDone
                      ? "text-fg"
                      : isActive
                        ? "text-fg"
                        : "text-muted-fg/25",
                  )}
                  style={
                    isDone
                      ? { background: "rgba(52, 211, 153, 0.14)", border: "1px solid rgba(52, 211, 153, 0.24)" }
                      : isActive
                        ? { background: "rgba(56, 189, 248, 0.14)", border: "1px solid rgba(56, 189, 248, 0.24)" }
                        : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }
                  }
                >
                  {isDone ? (
                    <Check size={10} weight="bold" style={{ color: "#34D399" }} />
                  ) : (
                    <Icon size={12} weight={isActive ? "bold" : "regular"} style={isActive ? { color: "#38BDF8" } : undefined} />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-xs font-semibold",
                      isActive ? "text-fg" : isDone ? "text-fg/72" : "text-muted-fg/42",
                    )}
                  >
                    {step.label}
                  </div>
                  {step.description ? (
                    <div className="mt-1 hidden text-[11px] leading-5 text-muted-fg/38 lg:block">
                      {step.description}
                    </div>
                  ) : null}
                </div>
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
          style={{
            borderTop: "1px solid rgba(255, 255, 255, 0.06)",
            background: "linear-gradient(180deg, rgba(10, 14, 21, 0.92), rgba(8, 11, 17, 0.96))",
          }}
        >
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-[11px] text-muted-fg/36">
              Step {activeIndex + 1} of {steps.length}
            </div>
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
