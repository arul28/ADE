/**
 * Where this computer is in ADE's onboarding: whether the first-run flow ran,
 * whether the user skipped it, and how far each first-chat hint got.
 *
 * Onboarding is per computer (it is the first open of ADE here, not of a
 * project), so it lives in this renderer's localStorage and never syncs.
 *
 * - `startedAt`: set when the welcome flow runs (first run, or "Show me around
 *   again" from the help menu). Hints only ever show after it; a computer that
 *   was set up before the flow existed never sees them.
 * - `skippedAt`: "Skip onboarding" anywhere. Every hint stops for good.
 * - `hints[id]`: how many times a hint showed, and whether the user did the
 *   thing (`doneAt`) or closed it (`dismissedAt`). Either one ends the hint.
 */

export const ONBOARDING_HINT_IDS = ["new-chat", "composer-at", "needs-you"] as const;
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

export type OnboardingProgress = {
  startedAt?: number;
  skippedAt?: number;
  hints: Partial<Record<OnboardingHintId, OnboardingHintProgress>>;
};

const STORAGE_KEY = "ade.onboarding.v1";
const CHANGE_EVENT = "ade:onboarding-progress";

function isHintId(value: string): value is OnboardingHintId {
  return (ONBOARDING_HINT_IDS as readonly string[]).includes(value);
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readOnboardingProgress(): OnboardingProgress {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { hints: {} };
    const record = parsed as Record<string, unknown>;
    const hints: OnboardingProgress["hints"] = {};
    const rawHints = record.hints;
    if (rawHints && typeof rawHints === "object" && !Array.isArray(rawHints)) {
      for (const [id, value] of Object.entries(rawHints as Record<string, unknown>)) {
        if (!isHintId(id) || !value || typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        hints[id] = {
          shown: finiteOrUndefined(entry.shown) ?? 0,
          doneAt: finiteOrUndefined(entry.doneAt),
          dismissedAt: finiteOrUndefined(entry.dismissedAt),
        };
      }
    }
    return {
      startedAt: finiteOrUndefined(record.startedAt),
      skippedAt: finiteOrUndefined(record.skippedAt),
      hints,
    };
  } catch {
    return { hints: {} };
  }
}

function writeOnboardingProgress(next: OnboardingProgress): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: onboarding simply does not remember this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function update(mutate: (draft: OnboardingProgress) => void): void {
  const draft = readOnboardingProgress();
  mutate(draft);
  writeOnboardingProgress(draft);
}

/** Calls `listener` whenever progress changes, in this window or another one. */
export function subscribeOnboardingProgress(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
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

/** "Show me around again": a fresh start, every hint back. */
export function restartOnboarding(): void {
  writeOnboardingProgress({ startedAt: Date.now(), hints: {} });
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
