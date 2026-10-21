import { useSyncExternalStore } from "react";
import { ADE_SUGGESTIONS, isSuggestionId, type AdeSuggestionId } from "./adeTipsSuggestions";
import { createLocalStore, finiteNumber, storedRecord } from "./localStore";
import { isTourOpen, onboardingSettledBeforeThisLaunch, subscribeOnboardingProgress } from "./onboardingProgress";

/**
 * The rules every situational suggestion (tier 3 of onboarding) shares, and
 * the one place their state lives. `useSituationalSuggestion` reads them; a
 * suggestion's own hook only says whether its signal is there.
 *
 * - **Once per signal.** A suggestion shows once for each `signalKey` (a
 *   provider's reset window, a lane, a tracker), or again after its
 *   definition's `repeatAfterMs`. Ignoring a card counts as having seen it.
 * - **One at a time, and rarely.** At most one new suggestion per launch, and
 *   none for four hours after the last one showed, so a busy day never turns
 *   into a stream of cards.
 * - **Never during onboarding.** Nothing while the tour runs, and nothing
 *   until onboarding finished (or was skipped) on an earlier launch: the
 *   first session belongs to the tour.
 * - **The user's answer.** "Not now" snoozes the kind for two weeks (the card
 *   is filed into ADE Tips); "Don't suggest again" turns the kind off, or only
 *   one project's (the lane template); doing the thing (`markSuggestionDone`)
 *   ends it too.
 *
 * Feature tips (tier 2 coming to the user): now and then, one of ADE Tips'
 * tips the user has not tried shows as the same corner card. They take the
 * corner, one card at a time and never during onboarding, but keep their own
 * pace: up to three a day, two hours apart, never within half an hour of a
 * suggestion, each tip once, and off from ADE Tips. They do not use up the
 * suggestions' once-per-launch slot.
 *
 * Per computer, like the rest of onboarding: this renderer's localStorage,
 * never synced. Only ids, signal keys and times are stored.
 */

export const SUGGESTIONS_STORAGE_KEY = "ade.suggestions.v1";
/** Before suggestions shared their rules, the lane template kept its own answers here (scope → snoozed-until or "never"). */
export const LEGACY_LANE_TEMPLATE_KEY = "ade.laneTemplateSuggestion.v1";
/** The old lane template snooze: two weeks from "Not now". */
const LEGACY_LANE_TEMPLATE_SNOOZE_MS = 14 * 24 * 3_600_000;
const COOLDOWN_MS = 4 * 3_600_000;
const NOT_NOW_SNOOZE_MS = 14 * 24 * 3_600_000;
const MAX_SHOWN = 60;
/** Up to three feature tip cards a day, at least two hours apart. */
const TIP_CARDS_PER_DAY = 3;
const TIP_DAY_MS = 24 * 3_600_000;
const TIP_CARD_GAP_MS = 2 * 3_600_000;
/** No tip card within half an hour of a suggestion. */
const TIP_AFTER_SUGGESTION_MS = 30 * 60_000;

type KindState = {
  off?: "never" | "done";
  snoozedUntil?: number;
};

type TipCardState = {
  /** When the recent tip cards showed (the last day's, newest last). */
  shownAt: number[];
  /** Tip ids that showed as a card or were tried from ADE Tips: never offered again. */
  done: string[];
  /** "Turn off" in ADE Tips. */
  off: boolean;
};

export type SuggestionsState = {
  lastShownAt: number;
  kinds: Partial<Record<AdeSuggestionId, KindState>>;
  /** `${id}\u0000${signalKey}` → when it showed. */
  shown: Record<string, number>;
  /** `${id}\u0000${scopeKey}`: "Don't suggest again" for one scope (a project), for kinds that turn off per scope. */
  neverScopes: string[];
  tips: TipCardState;
};

export const EMPTY_SUGGESTIONS_STATE: SuggestionsState = {
  lastShownAt: 0,
  kinds: {},
  shown: {},
  neverScopes: [],
  tips: { shownAt: [], done: [], off: false },
};

const shownKey = (id: AdeSuggestionId, signalKey: string) => `${id}\u0000${signalKey}`;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function parseState(stored: unknown): SuggestionsState {
  const record = storedRecord(stored);
  if (!record) return EMPTY_SUGGESTIONS_STATE;
  const kinds: SuggestionsState["kinds"] = {};
  for (const [id, value] of Object.entries(storedRecord(record.kinds) ?? {})) {
    const entry = storedRecord(value);
    if (!isSuggestionId(id) || !entry) continue;
    kinds[id] = {
      off: entry.off === "never" || entry.off === "done" ? entry.off : undefined,
      snoozedUntil: finiteNumber(entry.snoozedUntil),
    };
  }
  const shown: SuggestionsState["shown"] = {};
  for (const [key, value] of Object.entries(storedRecord(record.shown) ?? {})) {
    const at = finiteNumber(value);
    if (at !== undefined) shown[key] = at;
  }
  const rawTips = storedRecord(record.tips) ?? {};
  const tips: TipCardState = {
    shownAt: Array.isArray(rawTips.shownAt)
      ? rawTips.shownAt.filter((at): at is number => finiteNumber(at) !== undefined).slice(-TIP_CARDS_PER_DAY)
      : [],
    done: strings(rawTips.done),
    off: rawTips.off === true,
  };
  return {
    lastShownAt: finiteNumber(record.lastShownAt) ?? 0,
    kinds,
    shown,
    neverScopes: strings(record.neverScopes),
    tips,
  };
}

/** The lane template's old answers folded into `current`. Idempotent. */
function foldLegacyLaneTemplate(current: SuggestionsState, legacy: Record<string, unknown>): SuggestionsState {
  const shown = { ...current.shown };
  const neverScopes = [...current.neverScopes];
  for (const [scopeKey, value] of Object.entries(legacy)) {
    const key = shownKey("lane-template", scopeKey);
    const snoozedUntil = finiteNumber(value);
    if (value === "never") {
      if (!neverScopes.includes(key)) neverScopes.push(key);
    } else if (snoozedUntil !== undefined) {
      shown[key] = Math.max(shown[key] ?? 0, snoozedUntil - LEGACY_LANE_TEMPLATE_SNOOZE_MS);
    }
  }
  return { ...current, shown, neverScopes };
}

const store = createLocalStore({ key: SUGGESTIONS_STORAGE_KEY, event: "ade:suggestions", parse: parseState });

function parseJson(text: string | null): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Carries the lane template's old answers (`LEGACY_LANE_TEMPLATE_KEY`) into
 * the shared state, once, before the store's first read: a project that said
 * "Don't suggest again" keeps saying it, and a snooze runs out when it would
 * have. Writes storage directly rather than through `store.set`: nothing has
 * read the store yet, so nobody needs telling, and the first read can happen
 * during a render, where an announcement would update other components. When
 * a write fails, the next launch folds the old answers in again, to the same
 * result.
 */
function migrateLegacyLaneTemplate(): void {
  try {
    const text = window.localStorage.getItem(LEGACY_LANE_TEMPLATE_KEY);
    if (text == null) return;
    const legacy = storedRecord(parseJson(text));
    if (legacy) {
      const current = parseState(parseJson(window.localStorage.getItem(SUGGESTIONS_STORAGE_KEY)));
      window.localStorage.setItem(SUGGESTIONS_STORAGE_KEY, JSON.stringify(foldLegacyLaneTemplate(current, legacy)));
    }
    window.localStorage.removeItem(LEGACY_LANE_TEMPLATE_KEY);
  } catch {
    // Storage unavailable: left for the next launch.
  }
}

let legacyMigrated = false;

function state(): SuggestionsState {
  if (!legacyMigrated) {
    legacyMigrated = true;
    migrateLegacyLaneTemplate();
  }
  return store.get();
}

/** Tells subscribers a rule's input changed that is not stored (a claim, an answer, test mode). */
function emit(): void {
  store.notify();
}

function write(next: SuggestionsState): void {
  // Keep the newest showings; older signal keys (past reset windows) drop off.
  const shown = Object.entries(next.shown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SHOWN);
  store.set({ ...next, shown: Object.fromEntries(shown) });
}

function updateKind(id: AdeSuggestionId, patch: KindState): void {
  const current = state();
  write({ ...current, kinds: { ...current.kinds, [id]: { ...current.kinds[id], ...patch } } });
}

// ── this launch ─────────────────────────────────────────────────────────

/**
 * The card in the corner (a suggestion or a feature tip), and whether the user
 * answered it. One at a time: neither kind claims the corner while it is up.
 */
let corner: { key: string; kind: "suggestion" | "tip"; answered: boolean } | null = null;
/** This launch's one suggestion showed (tips do not use it). */
let launchSlotUsed = false;

const cornerUp = () => corner != null && !corner.answered;

function claimCorner(key: string, kind: "suggestion" | "tip"): void {
  corner = { key, kind, answered: false };
  if (kind === "suggestion") launchSlotUsed = true;
}

/** Whether the card for `key` is up: claimed, not answered, and no tour running. */
function isCornerShowing(key: string): boolean {
  if (corner?.key !== key || corner.answered) return false;
  return !isTourOpen();
}

function answerCorner(key: string): void {
  if (corner?.key === key) corner = { ...corner, answered: true };
}

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
  // An answered suggestion frees this launch's slot, so the next one can show.
  if (!(corner?.kind === "suggestion" && !corner.answered)) launchSlotUsed = false;
  emit();
}

/** Whether this signal may show now, as a new suggestion. */
function canClaim(id: AdeSuggestionId, signalKey: string, scopeKey: string | null, now: number): boolean {
  const current = state();
  if (current.kinds[id]?.off) return false;
  if (scopeKey !== null && current.neverScopes.includes(shownKey(id, scopeKey))) return false;
  if (suggestionsTestMode()) {
    // One card at a time still; the next may come once this one is answered.
    if (cornerUp() || isTourOpen()) return false;
    return !testModeAnswered.has(shownKey(id, signalKey));
  }
  if (launchSlotUsed || cornerUp() || !onboardingSettledBeforeThisLaunch()) return false;
  const kind = current.kinds[id];
  if (kind?.snoozedUntil && now < kind.snoozedUntil) return false;
  if (now - current.lastShownAt < COOLDOWN_MS) return false;
  const shownAt = current.shown[shownKey(id, signalKey)];
  if (shownAt === undefined) return true;
  const { repeatAfterMs } = ADE_SUGGESTIONS[id];
  return repeatAfterMs !== undefined && now - shownAt >= repeatAfterMs;
}

/**
 * Claims this launch's one suggestion for the signal when the rules allow it.
 * `scopeKey` is the scope "Don't suggest again" may have turned off on its own
 * (`neverSuggestScope`). True when the suggestion is (now) the one showing.
 */
export function claimSuggestion(id: AdeSuggestionId, signalKey: string, scopeKey: string | null = null): boolean {
  const key = shownKey(id, signalKey);
  if (corner?.key === key) return !corner.answered;
  const now = Date.now();
  if (!canClaim(id, signalKey, scopeKey, now)) return false;
  claimCorner(key, "suggestion");
  const current = state();
  write({ ...current, lastShownAt: now, shown: { ...current.shown, [key]: now } });
  return true;
}

/** Whether this signal's card is up: claimed, not answered, and no tour running. */
export function isSuggestionShowing(id: AdeSuggestionId, signalKey: string): boolean {
  return isCornerShowing(shownKey(id, signalKey));
}

/** The user answered the card ("Not now" also snoozes the kind). */
export function answerSuggestion(id: AdeSuggestionId, signalKey: string, answer: "started" | "not-now"): void {
  const key = shownKey(id, signalKey);
  answerCorner(key);
  if (suggestionsTestMode()) {
    // Test mode: the answer frees the slot (no snooze), so the next signal can show.
    testModeAnswered.add(key);
    if (corner?.kind === "suggestion") corner = null;
    launchSlotUsed = false;
    emit();
    return;
  }
  // A kind answered per scope (the lane template, per project) waits out its
  // own `repeatAfterMs` from the showing in that scope; the rest snooze the kind.
  if (answer === "not-now" && ADE_SUGGESTIONS[id].neverPer !== "scope") {
    updateKind(id, { snoozedUntil: Date.now() + NOT_NOW_SNOOZE_MS });
  } else emit();
}

/**
 * The signal behind a showing card went away (or changed) before the user
 * answered: the card counts as seen, and the corner is free for the next one.
 */
export function releaseSuggestion(id: AdeSuggestionId, signalKey: string): void {
  const key = shownKey(id, signalKey);
  if (corner?.key !== key || corner.answered) return;
  answerCorner(key);
  emit();
}

/** "Don't suggest again", from ADE Tips. */
export function neverSuggestKind(id: AdeSuggestionId): void {
  updateKind(id, { off: "never" });
}

/** "Don't suggest again" for one scope only (the lane template, per project). */
export function neverSuggestScope(id: AdeSuggestionId, scopeKey: string): void {
  const current = state();
  const key = shownKey(id, scopeKey);
  if (!current.neverScopes.includes(key)) write({ ...current, neverScopes: [...current.neverScopes, key] });
}

/** The user already does the thing (sent an @machine message, paired a phone). */
export function markSuggestionDone(id: AdeSuggestionId): void {
  if (state().kinds[id]?.off) return;
  updateKind(id, { off: "done" });
}

export function isSuggestionOff(id: AdeSuggestionId): boolean {
  return Boolean(state().kinds[id]?.off);
}

// ── feature tip cards ───────────────────────────────────────────────────

const TIP_CLAIM_PREFIX = "tip\u0000";

function updateTips(patch: Partial<TipCardState>): void {
  const current = state();
  write({ ...current, tips: { ...current.tips, ...patch } });
}

/** Tips already shown as a card or tried, to leave out of the next pick. */
export function doneTipIds(): ReadonlySet<string> {
  return new Set(state().tips.done);
}

export function tipCardsOff(): boolean {
  return state().tips.off;
}

export function setTipCardsOff(off: boolean): void {
  updateTips({ off });
}

/** The user tried this tip (from a card, ADE Tips or the Home widget): never offer it as a card. */
export function markTipTried(tipId: string): void {
  const { done } = state().tips;
  if (!done.includes(tipId)) updateTips({ done: [...done, tipId] });
}

/**
 * When the next tip card may show (0: now), or null when none may today. Up
 * to three in any 24 hours, two hours apart; never over a suggestion that
 * showed in the last half hour. The caller waits that long before asking.
 */
export function nextTipCardAt(now = Date.now()): number | null {
  if (suggestionsTestMode()) return 0;
  const { tips, lastShownAt } = state();
  if (tips.off) return null;
  const today = tips.shownAt.filter((at) => now - at < TIP_DAY_MS);
  const afterGap = today.length ? Math.max(...today) + TIP_CARD_GAP_MS : 0;
  const afterDay = today.length >= TIP_CARDS_PER_DAY ? Math.min(...today) + TIP_DAY_MS : 0;
  const afterSuggestion = lastShownAt ? lastShownAt + TIP_AFTER_SUGGESTION_MS : 0;
  return Math.max(0, afterGap, afterDay, afterSuggestion);
}

/**
 * Claims the corner for a feature tip when the rules allow it: onboarding
 * finished on an earlier launch, no suggestion or tip card up, tip cards not
 * turned off, this tip not shown or tried before, and `nextTipCardAt` passed.
 * A tip does not use up the suggestions' once-per-launch slot or cooldown.
 * True when it is (now) the one showing.
 */
export function claimTipCard(tipId: string): boolean {
  const key = `${TIP_CLAIM_PREFIX}${tipId}`;
  if (corner?.key === key) return !corner.answered;
  const current = state();
  if (current.tips.off || current.tips.done.includes(tipId)) return false;
  if (cornerUp() || isTourOpen()) return false;
  const now = Date.now();
  if (suggestionsTestMode()) {
    if (testModeAnswered.has(key)) return false;
  } else {
    if (!onboardingSettledBeforeThisLaunch()) return false;
    const at = nextTipCardAt(now);
    if (at == null || at > now) return false;
  }
  claimCorner(key, "tip");
  const shownAt = [...current.tips.shownAt.filter((time) => now - time < TIP_DAY_MS), now].slice(-TIP_CARDS_PER_DAY);
  write({ ...current, tips: { ...current.tips, shownAt, done: [...current.tips.done, tipId] } });
  return true;
}

export function isTipCardShowing(tipId: string): boolean {
  return isCornerShowing(`${TIP_CLAIM_PREFIX}${tipId}`);
}

export function answerTipCard(tipId: string): void {
  const key = `${TIP_CLAIM_PREFIX}${tipId}`;
  answerCorner(key);
  if (suggestionsTestMode()) testModeAnswered.add(key);
  emit();
}

/**
 * Bumped once per change to the rules' inputs: a store write or notice (in
 * this window or another) or an onboarding change. Counted by one listener,
 * installed with the first read, not one per subscriber.
 */
let version = 0;
let countingChanges = false;

function getVersion(): number {
  if (!countingChanges) {
    countingChanges = true;
    const bump = () => {
      version += 1;
    };
    store.subscribe(bump);
    subscribeOnboardingProgress(bump);
  }
  return version;
}

function subscribe(listener: () => void): () => void {
  getVersion();
  const offStore = store.subscribe(listener);
  const offOnboarding = subscribeOnboardingProgress(listener);
  return () => {
    offStore();
    offOnboarding();
  };
}

/** Changes whenever the rules' inputs do (answers, claims, onboarding), to re-read them. */
export function useSuggestionRulesVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
