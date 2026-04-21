import { create } from "zustand";
import type { OnboardingTourProgress } from "../../shared/types";

export type { OnboardingTourProgress as TourProgress };

const EMPTY_PROGRESS: OnboardingTourProgress = {
  wizardCompletedAt: null,
  wizardDismissedAt: null,
  tours: {},
  glossaryTermsSeen: [],
};

type OnboardingState = {
  activeTourId: string | null;
  activeStepIndex: number;
  wizardOpen: boolean;
  hydrated: boolean;
  progress: OnboardingTourProgress | null;

  hydrate: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => Promise<void>;
  startTour: (tourId: string) => Promise<void>;
  nextStep: () => Promise<void>;
  prevStep: () => Promise<void>;
  completeCurrentTour: () => Promise<void>;
  dismissCurrentTour: () => Promise<void>;
};

function api() {
  const maybe = (typeof window !== "undefined" ? (window as any).ade : undefined) as
    | { onboarding?: Window["ade"]["onboarding"] }
    | undefined;
  return maybe?.onboarding ?? null;
}

async function refreshProgress(): Promise<OnboardingTourProgress> {
  const onboarding = api();
  if (!onboarding) return { ...EMPTY_PROGRESS };
  return (await onboarding.getTourProgress()) ?? { ...EMPTY_PROGRESS };
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  activeTourId: null,
  activeStepIndex: 0,
  wizardOpen: false,
  hydrated: false,
  progress: null,

  hydrate: async () => {
    const progress = await refreshProgress();
    set({ progress, hydrated: true });
  },

  openWizard: () => {
    set({ wizardOpen: true });
  },

  closeWizard: async () => {
    set({ wizardOpen: false });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.markWizardDismissed();
    set({ progress });
  },

  startTour: async (tourId: string) => {
    const id = tourId.trim();
    if (!id) return;
    set({ activeTourId: id, activeStepIndex: 0 });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.updateTourStep(id, 0);
    set({ progress });
  },

  nextStep: async () => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const nextIndex = activeStepIndex + 1;
    set({ activeStepIndex: nextIndex });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.updateTourStep(activeTourId, nextIndex);
    set({ progress });
  },

  prevStep: async () => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const nextIndex = Math.max(0, activeStepIndex - 1);
    set({ activeStepIndex: nextIndex });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.updateTourStep(activeTourId, nextIndex);
    set({ progress });
  },

  completeCurrentTour: async () => {
    const { activeTourId } = get();
    if (!activeTourId) return;
    set({ activeTourId: null, activeStepIndex: 0 });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.markTourCompleted(activeTourId);
    set({ progress });
  },

  dismissCurrentTour: async () => {
    const { activeTourId } = get();
    if (!activeTourId) return;
    set({ activeTourId: null, activeStepIndex: 0 });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.markTourDismissed(activeTourId);
    set({ progress });
  },
}));
