import { useSyncExternalStore } from "react";
import type { AdeSuggestionId } from "./adeTipsSuggestions";
import { isTourOpen, readOnboardingProgress, subscribeOnboardingProgress } from "./onboardingProgress";

/**
 * The rules every situational suggestion (tier 3 of onboarding) shares, and
 * the one place their state lives. `useSituationalSuggestion` reads them; a
 * suggestion's own hook only says whether its signal is there.
 *
 * - **Once per signal.** A suggestion shows once for each `signalKey` (a
 *   provider's reset window, a lane, a tracker), or again after its
 *   `repeatAfterMs`. Ignoring a card counts as having seen it.
 * - **One at a time, and rarely.** At most one new suggestion per launch, and
 *   none for four hours after the last one showed, so a busy day never turns
 *   into a stream of cards.
 * - **Never during onboarding.** Nothing while the tour runs, and nothing
 *   until onboarding finished (or was skipped) on an earlier launch: the
 *   first session belongs to the tour.
 * - **The user's answer.** "Not now" snoozes the kind for two weeks (the card
 *   is filed into ADE Tips); "Don't suggest again" turns the kind off; doing
 *   the thing (`markSuggestionDone`) ends it too.
 *
 * Per computer, like the rest of onboarding: this renderer's localStorage,
 * never synced. Only ids, signal keys and times are stored.
 */

const STORAGE_KEY = "ade.suggestions.v1";
const CHANGE_EVENT = "ade:suggestions";
const COOLDOWN_MS = 4 * 3_600_000;
const NOT_NOW_SNOOZE_MS = 14 * 24 * 3_600_000;
const MAX_SHOWN = 60;
/** This app launch; onboarding that finished during it waits for the next launch. */
const LAUNCHED_AT = Date.now();

type KindState = {
  off?: "never" | "done";
  snoozedUntil?: number;
};

type StoredState = {
  lastShownAt: number;
  kinds: Partial<Record<AdeSuggestionId, KindState>>;
  /** `${id}\u0000${signalKey}` → when it showed. */
  shown: Record<string, number>;
};

const shownKey = (id: AdeSuggestionId, signalKey: string) => `${id}\u0000${signalKey}`;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readState(): StoredState {
  const empty: StoredState = { lastShownAt: 0, kinds: {}, shown: {} };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const record = parsed as Record<string, unknown>;
    const kinds: StoredState["kinds"] = {};
    if (record.kinds && typeof record.kinds === "object" && !Array.isArray(record.kinds)) {
      for (const [id, value] of Object.entries(record.kinds as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        kinds[id as AdeSuggestionId] = {
          off: entry.off === "never" || entry.off === "done" ? entry.off : undefined,
          snoozedUntil: finite(entry.snoozedUntil),
        };
      }
    }
    const shown: StoredState["shown"] = {};
    if (record.shown && typeof record.shown === "object" && !Array.isArray(record.shown)) {
      for (const [key, value] of Object.entries(record.shown as Record<string, unknown>)) {
        const at = finite(value);
        if (at !== undefined) shown[key] = at;
      }
    }
    return { lastShownAt: finite(record.lastShownAt) ?? 0, kinds, shown };
  } catch {
    return empty;
  }
}

let snapshot: StoredState | null = null;
let version = 0;

function state(): StoredState {
  snapshot ??= readState();
  return snapshot;
}

function emit(): void {
  version += 1;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function write(next: StoredState): void {
  // Keep the newest showings; older signal keys (past reset windows) drop off.
  const shown = Object.entries(next.shown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SHOWN);
  const trimmed = { ...next, shown: Object.fromEntries(shown) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage unavailable: the rules hold for this session only.
  }
  snapshot = trimmed;
  emit();
}

function updateKind(id: AdeSuggestionId, patch: KindState): void {
  const current = state();
  write({ ...current, kinds: { ...current.kinds, [id]: { ...current.kinds[id], ...patch } } });
}

/** Onboarding is done with this computer, and was done before this launch. */
function onboardingSettled(): boolean {
  const progress = readOnboardingProgress();
  if (!progress.startedAt) return true;
  if (isTourOpen(progress)) return false;
  const finishedAt = progress.skippedAt ?? progress.tour.completedAt ?? progress.startedAt;
  return finishedAt < LAUNCHED_AT;
}

// ── this launch ─────────────────────────────────────────────────────────

/** The one suggestion this launch showed, and whether the user answered it. */
let launchClaim: { key: string; answered: boolean } | null = null;

// ── dev test mode ───────────────────────────────────────────────────────

const TEST_MODE_KEY = "ade.dev.suggestionsTestMode";
/** Test mode: cards answered this launch, so an answered card does not come straight back. */
const testModeAnswered = new Set<string>();

/**
 * Dev builds only: suggestions show as soon as their signal is there, one
 * after another, with no wait for a later launch, no cooldown, no snooze and
 * no once-per-signal. "Don't suggest again" and the tour still hold them.
 * Toggled from the command palette ("Dev: Suggestions test mode").
 */
export function suggestionsTestMode(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return window.localStorage.getItem(TEST_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSuggestionsTestMode(on: boolean): void {
  if (!import.meta.env.DEV) return;
  try {
    if (on) window.localStorage.setItem(TEST_MODE_KEY, "1");
    else window.localStorage.removeItem(TEST_MODE_KEY);
  } catch {
    return;
  }
  if (launchClaim?.answered) launchClaim = null;
  emit();
}

/** Whether this signal may show now, as a new suggestion. */
function canClaim(id: AdeSuggestionId, signalKey: string, repeatAfterMs: number | undefined, now: number): boolean {
  if (suggestionsTestMode()) {
    // One card at a time still; the next may come once this one is answered.
    if ((launchClaim && !launchClaim.answered) || isTourOpen()) return false;
    return !testModeAnswered.has(shownKey(id, signalKey)) && !state().kinds[id]?.off;
  }
  if (launchClaim || !onboardingSettled()) return false;
  const current = state();
  const kind = current.kinds[id];
  if (kind?.off) return false;
  if (kind?.snoozedUntil && now < kind.snoozedUntil) return false;
  if (now - current.lastShownAt < COOLDOWN_MS) return false;
  const shownAt = current.shown[shownKey(id, signalKey)];
  if (shownAt === undefined) return true;
  return repeatAfterMs !== undefined && now - shownAt >= repeatAfterMs;
}

/**
 * Claims this launch's one suggestion for the signal when the rules allow it.
 * True when the suggestion is (now) the one showing.
 */
export function claimSuggestion(id: AdeSuggestionId, signalKey: string, repeatAfterMs?: number): boolean {
  const key = shownKey(id, signalKey);
  if (launchClaim?.key === key) return !launchClaim.answered;
  const now = Date.now();
  if (!canClaim(id, signalKey, repeatAfterMs, now)) return false;
  launchClaim = { key, answered: false };
  const current = state();
  write({ ...current, lastShownAt: now, shown: { ...current.shown, [key]: now } });
  return true;
}

/** Whether this signal's card is up: claimed, not answered, and no tour running. */
export function isSuggestionShowing(id: AdeSuggestionId, signalKey: string): boolean {
  if (launchClaim?.key !== shownKey(id, signalKey) || launchClaim.answered) return false;
  return !isTourOpen();
}

/** The user answered the card ("Not now" also snoozes the kind). */
export function answerSuggestion(id: AdeSuggestionId, signalKey: string, answer: "started" | "not-now"): void {
  if (launchClaim?.key === shownKey(id, signalKey)) launchClaim = { ...launchClaim, answered: true };
  if (suggestionsTestMode()) {
    // Test mode: the answer frees the slot (no snooze), so the next signal can show.
    testModeAnswered.add(shownKey(id, signalKey));
    launchClaim = null;
    emit();
    return;
  }
  if (answer === "not-now") updateKind(id, { snoozedUntil: Date.now() + NOT_NOW_SNOOZE_MS });
  else emit();
}

/** "Don't suggest again", from ADE Tips. */
export function neverSuggestKind(id: AdeSuggestionId): void {
  updateKind(id, { off: "never" });
}

/** The user already does the thing (sent an @machine message, paired a phone). */
export function markSuggestionDone(id: AdeSuggestionId): void {
  if (state().kinds[id]?.off) return;
  updateKind(id, { off: "done" });
}

export function isSuggestionOff(id: AdeSuggestionId): boolean {
  return Boolean(state().kinds[id]?.off);
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = null;
    version += 1;
    listener();
  };
  const offOnboarding = subscribeOnboardingProgress(() => {
    version += 1;
    listener();
  });
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    offOnboarding();
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

const getVersion = () => version;

/** Changes whenever the rules' inputs do (answers, claims, onboarding), to re-read them. */
export function useSuggestionRulesVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
