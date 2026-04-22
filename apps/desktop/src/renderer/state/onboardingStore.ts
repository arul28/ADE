import { create } from "zustand";
import type { OnboardingTourProgress } from "../../shared/types";
import { dialogBus } from "../lib/dialogBus";
import {
  getTour,
  type StepAction,
  type TourCtx,
  type TourStep,
} from "../onboarding/registry";
import { waitForSelector } from "../onboarding/waitForTarget";

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
  activeTourCtx: TourCtx | null;
  wizardOpen: boolean;
  hydrated: boolean;
  progress: OnboardingTourProgress | null;

  hydrate: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => Promise<void>;
  startTour: (tourId: string) => Promise<void>;
  nextStep: () => Promise<void>;
  prevStep: () => Promise<void>;
  completeCurrentTour: (skipAfterLeave?: boolean) => Promise<void>;
  dismissCurrentTour: () => Promise<void>;
};

function api() {
  const maybe = (typeof window !== "undefined" ? (window as any).ade : undefined) as
    | { onboarding?: Window["ade"]["onboarding"] }
    | undefined;
  return maybe?.onboarding ?? null;
}

function createTourCtx(initial: Record<string, unknown> = {}): TourCtx {
  const values: Record<string, unknown> = { ...initial };
  return {
    values,
    set(k, v) {
      values[k] = v;
    },
    get<T = unknown>(k: string): T | undefined {
      return values[k] as T | undefined;
    },
  };
}

function navigateToRoute(route: string): void {
  if (typeof window === "undefined") return;
  const target = route.trim();
  if (!target) return;
  if ((window as any).__adeBrowserMock) {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  window.location.hash = target.startsWith("#") ? target : `#${target}`;
}

async function runActions(actions: StepAction[]): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "navigate":
        navigateToRoute(action.to);
        break;
      case "openDialog":
        dialogBus.open(action.id, action.props);
        break;
      case "closeDialog":
        dialogBus.close(action.id);
        break;
      case "ipc":
        try {
          await action.call();
        } catch (error) {
          console.error("[onboarding] IPC action failed", error);
        }
        break;
      case "focus": {
        if (typeof document === "undefined") break;
        const el = document.querySelector(action.selector) as HTMLElement | null;
        if (!el) break;
        try {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch {
          el.scrollIntoView();
        }
        el.setAttribute("data-tour-focus", "true");
        break;
      }
    }
  }
}

async function runBeforeEnter(step: TourStep | undefined, ctx: TourCtx): Promise<void> {
  if (!step) return;
  const result = await step.beforeEnter?.(ctx);
  if (Array.isArray(result)) {
    await runActions(result);
  }
  if (step.waitForSelector) {
    await waitForSelector(step.waitForSelector, {
      timeoutMs: step.fallbackAfterMs,
    });
  }
}

async function runAfterLeave(step: TourStep | undefined, ctx: TourCtx): Promise<void> {
  await step?.afterLeave?.(ctx);
}

async function refreshProgress(): Promise<OnboardingTourProgress> {
  const onboarding = api();
  if (!onboarding) return { ...EMPTY_PROGRESS };
  return (await onboarding.getTourProgress()) ?? { ...EMPTY_PROGRESS };
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  activeTourId: null,
  activeStepIndex: 0,
  activeTourCtx: null,
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
    const tour = getTour(id);
    const ctx = createTourCtx(tour?.ctxInit?.() ?? {});
    set({ activeTourId: id, activeStepIndex: 0, activeTourCtx: ctx });
    const onboarding = api();
    if (onboarding) {
      const progress = await onboarding.updateTourStep(id, 0);
      set({ progress });
    }
    await runBeforeEnter(tour?.steps[0], ctx);
  },

  nextStep: async () => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const tour = getTour(activeTourId);
    const ctx = get().activeTourCtx ?? createTourCtx(tour?.ctxInit?.() ?? {});
    const currentStep = tour?.steps[activeStepIndex];
    await runAfterLeave(currentStep, ctx);
    const branchTarget = currentStep?.branches?.(ctx) ?? null;
    const branchedIndex =
      branchTarget && tour
        ? tour.steps.findIndex((step) => step.id === branchTarget)
        : -1;
    const nextIndex = branchedIndex >= 0 ? branchedIndex : activeStepIndex + 1;
    if (tour && nextIndex >= tour.steps.length) {
      await get().completeCurrentTour(true);
      return;
    }
    set({ activeStepIndex: nextIndex, activeTourCtx: ctx });
    const onboarding = api();
    if (onboarding) {
      const progress = await onboarding.updateTourStep(activeTourId, nextIndex);
      set({ progress });
    }
    await runBeforeEnter(tour?.steps[nextIndex], ctx);
  },

  prevStep: async () => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const tour = getTour(activeTourId);
    const ctx = get().activeTourCtx ?? createTourCtx(tour?.ctxInit?.() ?? {});
    await runAfterLeave(tour?.steps[activeStepIndex], ctx);
    const nextIndex = Math.max(0, activeStepIndex - 1);
    set({ activeStepIndex: nextIndex, activeTourCtx: ctx });
    const onboarding = api();
    if (onboarding) {
      const progress = await onboarding.updateTourStep(activeTourId, nextIndex);
      set({ progress });
    }
    await runBeforeEnter(tour?.steps[nextIndex], ctx);
  },

  completeCurrentTour: async (skipAfterLeave = false) => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const tour = getTour(activeTourId);
    const ctx = get().activeTourCtx ?? createTourCtx(tour?.ctxInit?.() ?? {});
    if (!skipAfterLeave) {
      await runAfterLeave(tour?.steps[activeStepIndex], ctx);
    }
    set({ activeTourId: null, activeStepIndex: 0, activeTourCtx: null });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.markTourCompleted(activeTourId);
    set({ progress });
  },

  dismissCurrentTour: async () => {
    const { activeTourId, activeStepIndex } = get();
    if (!activeTourId) return;
    const tour = getTour(activeTourId);
    const ctx = get().activeTourCtx ?? createTourCtx(tour?.ctxInit?.() ?? {});
    await runAfterLeave(tour?.steps[activeStepIndex], ctx);
    set({ activeTourId: null, activeStepIndex: 0, activeTourCtx: null });
    const onboarding = api();
    if (!onboarding) return;
    const progress = await onboarding.markTourDismissed(activeTourId);
    set({ progress });
  },
}));
