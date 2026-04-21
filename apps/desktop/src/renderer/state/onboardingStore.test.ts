/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingTourProgress } from "../../shared/types";

function emptyProgress(): OnboardingTourProgress {
  return {
    wizardCompletedAt: null,
    wizardDismissedAt: null,
    tours: {},
    glossaryTermsSeen: [],
  };
}

let progress: OnboardingTourProgress = emptyProgress();

const mockOnboarding = {
  getTourProgress: vi.fn(async () => progress),
  markWizardCompleted: vi.fn(async () => {
    progress = { ...progress, wizardCompletedAt: new Date().toISOString() };
    return progress;
  }),
  markWizardDismissed: vi.fn(async () => {
    progress = { ...progress, wizardDismissedAt: new Date().toISOString() };
    return progress;
  }),
  markTourCompleted: vi.fn(async (tourId: string) => {
    const entry = progress.tours[tourId] ?? { completedAt: null, dismissedAt: null, lastStepIndex: 0 };
    progress = {
      ...progress,
      tours: { ...progress.tours, [tourId]: { ...entry, completedAt: new Date().toISOString() } },
    };
    return progress;
  }),
  markTourDismissed: vi.fn(async (tourId: string) => {
    const entry = progress.tours[tourId] ?? { completedAt: null, dismissedAt: null, lastStepIndex: 0 };
    progress = {
      ...progress,
      tours: { ...progress.tours, [tourId]: { ...entry, dismissedAt: new Date().toISOString() } },
    };
    return progress;
  }),
  updateTourStep: vi.fn(async (tourId: string, index: number) => {
    const entry = progress.tours[tourId] ?? { completedAt: null, dismissedAt: null, lastStepIndex: 0 };
    progress = {
      ...progress,
      tours: { ...progress.tours, [tourId]: { ...entry, lastStepIndex: index } },
    };
    return progress;
  }),
};

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis.window as any).ade = { onboarding: mockOnboarding };

import { useOnboardingStore } from "./onboardingStore";

function resetStore() {
  progress = emptyProgress();
  useOnboardingStore.setState({
    activeTourId: null,
    activeStepIndex: 0,
    wizardOpen: false,
    hydrated: false,
    progress: null,
  });
}

describe("onboardingStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("hydrate pulls the latest progress from IPC", async () => {
    progress = {
      ...emptyProgress(),
      wizardCompletedAt: "2026-03-20T00:00:00Z",
    };

    await useOnboardingStore.getState().hydrate();

    expect(mockOnboarding.getTourProgress).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().hydrated).toBe(true);
    expect(useOnboardingStore.getState().progress?.wizardCompletedAt).toBe("2026-03-20T00:00:00Z");
  });

  it("openWizard toggles local state only; closeWizard persists a dismissal", async () => {
    useOnboardingStore.getState().openWizard();
    expect(useOnboardingStore.getState().wizardOpen).toBe(true);

    await useOnboardingStore.getState().closeWizard();
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(mockOnboarding.markWizardDismissed).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().progress?.wizardDismissedAt).toBeTruthy();
  });

  it("startTour sets the active id, resets step, and persists step 0", async () => {
    await useOnboardingStore.getState().startTour("lanes");
    expect(useOnboardingStore.getState().activeTourId).toBe("lanes");
    expect(useOnboardingStore.getState().activeStepIndex).toBe(0);
    expect(mockOnboarding.updateTourStep).toHaveBeenCalledWith("lanes", 0);
  });

  it("nextStep / prevStep advance and persist the index, never below 0", async () => {
    await useOnboardingStore.getState().startTour("lanes");

    await useOnboardingStore.getState().nextStep();
    expect(useOnboardingStore.getState().activeStepIndex).toBe(1);
    await useOnboardingStore.getState().nextStep();
    expect(useOnboardingStore.getState().activeStepIndex).toBe(2);
    await useOnboardingStore.getState().prevStep();
    expect(useOnboardingStore.getState().activeStepIndex).toBe(1);

    // Can't go negative.
    await useOnboardingStore.getState().prevStep();
    await useOnboardingStore.getState().prevStep();
    expect(useOnboardingStore.getState().activeStepIndex).toBe(0);
    // Persisted the clamped index.
    const calls = mockOnboarding.updateTourStep.mock.calls;
    expect(calls[calls.length - 1]).toEqual(["lanes", 0]);
  });

  it("completeCurrentTour clears active state and persists completion", async () => {
    await useOnboardingStore.getState().startTour("lanes");
    await useOnboardingStore.getState().completeCurrentTour();

    expect(useOnboardingStore.getState().activeTourId).toBeNull();
    expect(useOnboardingStore.getState().activeStepIndex).toBe(0);
    expect(mockOnboarding.markTourCompleted).toHaveBeenCalledWith("lanes");
    expect(useOnboardingStore.getState().progress?.tours.lanes?.completedAt).toBeTruthy();
  });

  it("dismissCurrentTour clears active state and persists dismissal", async () => {
    await useOnboardingStore.getState().startTour("lanes");
    await useOnboardingStore.getState().dismissCurrentTour();

    expect(useOnboardingStore.getState().activeTourId).toBeNull();
    expect(mockOnboarding.markTourDismissed).toHaveBeenCalledWith("lanes");
    expect(useOnboardingStore.getState().progress?.tours.lanes?.dismissedAt).toBeTruthy();
  });
});
