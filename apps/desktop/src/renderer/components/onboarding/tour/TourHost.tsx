import React from "react";
import { useAppStore } from "../../../state/appStore";
import { useOnboardingStore } from "../../../state/onboardingStore";
import { getTour } from "../../../onboarding/registry";
import { TourOverlay } from "./TourOverlay";

// Side-effect registration for every tour file.
import "../../../onboarding/tours";

export function TourHost() {
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const activeTourId = useOnboardingStore((s) => s.activeTourId);
  const activeTourVariant = useOnboardingStore((s) => s.activeTourVariant);
  const activeStepIndex = useOnboardingStore((s) => s.activeStepIndex);
  const activeTourCtx = useOnboardingStore((s) => s.activeTourCtx);

  if (!onboardingEnabled) return null;
  if (!activeTourId) return null;

  const tour = getTour(activeTourId, activeTourVariant ?? undefined);
  if (!tour) return null;
  if (tour.steps.length === 0) return null;

  const clampedIndex = Math.max(0, Math.min(activeStepIndex, tour.steps.length - 1));
  const step = tour.steps[clampedIndex];
  if (!step) return null;

  return (
    <TourOverlay
      step={step}
      stepIndex={clampedIndex}
      totalSteps={tour.steps.length}
      ctx={activeTourCtx}
    />
  );
}
