import { ADE_WELCOME_VIDEO_REPLAY_EVENT } from "../../shared/welcomeVideo";
import { createLocalStore, finiteNumber, storedRecord } from "./localStore";

/**
 * Where this computer is in ADE's onboarding: whether the first-run flow ran,
 * whether the user skipped it, how far the guided tour got, and how far each
 * contextual hint got.
 *
 * Onboarding is per computer (it is the first open of ADE here, not of a
 * project), so it lives in this renderer's localStorage and never syncs.
 *
 * - `startedAt`: set when the welcome flow runs (first run, or "Show me around
 *   again" from the help menu). Hints only ever show after it; a computer that
 *   was set up before the flow existed never sees them.
 * - `skippedAt`: "Skip onboarding" anywhere. The tour and every hint stop for
 *   good (until "Show me around again").
 * - `tour`: the guided tour's current step, and when it finished. It waits on
 *   a step for as long as it takes; leaving the screen pauses it, coming back
 *   resumes it, across reloads.
 * - `hints[id]`: how many times a contextual hint showed, and whether the user
 *   did the thing (`doneAt`) or closed it (`dismissedAt`). Either one ends it.
 */

export const ONBOARDING_HINT_IDS = ["needs-you"] as const;
export type OnboardingHintId = (typeof ONBOARDING_HINT_IDS)[number];

/** A hint that showed this many times without being done stops for good. */
export const ONBOARDING_HINT_MAX_SHOWS = 3;

/** The attribute a surface puts on the control a hint points at. */
export const ONBOARDING_ANCHOR_ATTR = "data-onboarding-anchor";

export type OnboardingHintProgress = {
  shown: number;
  doneAt?: number;
  dismissedAt?: number;
};

export type OnboardingTourProgress = {
  /** The step the tour is on (a `TourStepId`); unknown ids restart at the first step. */
  step?: string;
  completedAt?: number;
};

export type OnboardingProgress = {
  startedAt?: number;
  skippedAt?: number;
  tour: OnboardingTourProgress;
  hints: Partial<Record<OnboardingHintId, OnboardingHintProgress>>;
};

export const ONBOARDING_PROGRESS_STORAGE_KEY = "ade.onboarding.v1";

/** This app launch; onboarding that finished during it counts from the next launch. */
const LAUNCHED_AT = Date.now();

function isHintId(value: string): value is OnboardingHintId {
  return (ONBOARDING_HINT_IDS as readonly string[]).includes(value);
}

function parseProgress(stored: unknown): OnboardingProgress {
  const record = storedRecord(stored);
  if (!record) return { tour: {}, hints: {} };
  const hints: OnboardingProgress["hints"] = {};
  for (const [id, value] of Object.entries(storedRecord(record.hints) ?? {})) {
    const entry = storedRecord(value);
    if (!isHintId(id) || !entry) continue;
    hints[id] = {
      shown: finiteNumber(entry.shown) ?? 0,
      doneAt: finiteNumber(entry.doneAt),
      dismissedAt: finiteNumber(entry.dismissedAt),
    };
  }
  const rawTour = storedRecord(record.tour) ?? {};
  return {
    startedAt: finiteNumber(record.startedAt),
    skippedAt: finiteNumber(record.skippedAt),
    tour: {
      step: typeof rawTour.step === "string" && rawTour.step ? rawTour.step : undefined,
      completedAt: finiteNumber(rawTour.completedAt),
    },
    hints,
  };
}

const store = createLocalStore({ key: ONBOARDING_PROGRESS_STORAGE_KEY, event: "ade:onboarding-progress", parse: parseProgress });

export function readOnboardingProgress(): OnboardingProgress {
  return store.get();
}

function writeOnboardingProgress(next: OnboardingProgress): void {
  store.set(next);
}

function update(mutate: (draft: OnboardingProgress) => void): void {
  const current = store.get();
  const draft: OnboardingProgress = { ...current, tour: { ...current.tour }, hints: { ...current.hints } };
  mutate(draft);
  writeOnboardingProgress(draft);
}

/** Calls `listener` whenever progress changes, in this window or another one. */
export function subscribeOnboardingProgress(listener: () => void): () => void {
  return store.subscribe(listener);
}

/** The welcome flow ran: hints may show from now on. */
export function markOnboardingStarted(): void {
  update((draft) => {
    draft.startedAt ??= Date.now();
  });
}

/** "Skip onboarding": no hint shows again on this computer. */
export function skipOnboarding(): void {
  update((draft) => {
    draft.startedAt ??= Date.now();
    draft.skippedAt = Date.now();
  });
}

/**
 * "Show me around again" (help menu, command palette): a fresh start (the tour
 * from its first step and every hint back), and the welcome video again.
 */
export function showMeAroundAgain(): void {
  writeOnboardingProgress({ startedAt: Date.now(), tour: {}, hints: {} });
  window.dispatchEvent(new Event(ADE_WELCOME_VIDEO_REPLAY_EVENT));
}

/** The tour moved to `step`. */
export function setTourStep(step: string): void {
  update((draft) => {
    draft.tour = { ...draft.tour, step };
  });
}

/** The tour's last step is done. Contextual hints carry on. */
export function completeTour(): void {
  update((draft) => {
    draft.tour = { ...draft.tour, completedAt: Date.now() };
  });
}

/** Whether the tour should show: onboarding is on and the tour is not finished. */
export function isTourOpen(progress: OnboardingProgress = readOnboardingProgress()): boolean {
  return isOnboardingActive(progress) && !progress.tour.completedAt;
}

/**
 * Onboarding is done with this computer (finished, skipped, or never ran),
 * and was done before this app launch: the first session belongs to
 * onboarding, so later tiers (suggestions, tips, "What's new") wait for the
 * next launch.
 */
export function onboardingSettledBeforeThisLaunch(progress: OnboardingProgress = readOnboardingProgress()): boolean {
  if (!progress.startedAt) return true;
  if (isTourOpen(progress)) return false;
  const finishedAt = progress.skippedAt ?? progress.tour.completedAt ?? progress.startedAt;
  return finishedAt < LAUNCHED_AT;
}

export function isOnboardingActive(progress: OnboardingProgress = readOnboardingProgress()): boolean {
  return Boolean(progress.startedAt) && !progress.skippedAt;
}

/** Whether a hint may still show: onboarding is on and the hint is not finished. */
export function isHintOpen(id: OnboardingHintId, progress: OnboardingProgress = readOnboardingProgress()): boolean {
  if (!isOnboardingActive(progress)) return false;
  const hint = progress.hints[id];
  if (!hint) return true;
  return !hint.doneAt && !hint.dismissedAt && hint.shown < ONBOARDING_HINT_MAX_SHOWS;
}

export function markHintShown(id: OnboardingHintId): void {
  update((draft) => {
    const hint = draft.hints[id] ?? { shown: 0 };
    draft.hints[id] = { ...hint, shown: hint.shown + 1 };
  });
}

/** The user did the thing the hint pointed at. */
export function markHintDone(id: OnboardingHintId): void {
  const progress = readOnboardingProgress();
  if (progress.hints[id]?.doneAt) return;
  update((draft) => {
    const hint = draft.hints[id] ?? { shown: 0 };
    draft.hints[id] = { ...hint, doneAt: Date.now() };
  });
}

export function dismissHint(id: OnboardingHintId): void {
  update((draft) => {
    const hint = draft.hints[id] ?? { shown: 0 };
    draft.hints[id] = { ...hint, dismissedAt: Date.now() };
  });
}
