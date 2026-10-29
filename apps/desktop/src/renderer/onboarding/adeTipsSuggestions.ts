import { useSyncExternalStore } from "react";
import { createLocalStore, finiteNumber, storedRecord } from "./localStore";
import {
  At,
  DeviceMobile,
  Gauge,
  Key,
  LinkSimple,
  Repeat,
  SquaresFour,
  Stack,
  type Icon,
} from "@phosphor-icons/react";

/**
 * Situational suggestions (tier 3 of onboarding) that the user postponed with
 * "Not now". A suggestion shows only when ADE sees a signal for it; "Not now"
 * files it here, and ADE Tips lists it under "Suggested for you" so it can be
 * started later instead of disappearing.
 *
 * Per computer, like the rest of onboarding: this renderer's localStorage,
 * never synced. Each entry is scoped (`scopeKey`, usually machine + project
 * root), because a suggestion is about one project.
 *
 * The owner of a suggestion (the hook that raises it) registers:
 * - `never(scopeKey)` for the kind, so "Don't suggest again" works from Tips
 *   for any project, and
 * - `start` for the scope it can start right now (the open project), so Tips
 *   can start it with the same pin and data the suggestion card would use.
 *
 * Every suggestion goes through
 * `components/app/suggestions/useSituationalSuggestion.tsx`, which does this
 * registering and keeps the shared rules (one at a time, a cooldown, never
 * during onboarding) in `situationalSuggestions.ts`.
 */

export type AdeSuggestionId =
  | "lane-template"
  | "usage-low"
  | "machine-mention"
  | "chat-secret"
  | "issue-tracker"
  | "parallel-chats"
  | "repeat-prompt"
  | "pair-phone";

export type AdeSuggestionDefinition = {
  id: AdeSuggestionId;
  /** What the feature is. */
  title: string;
  /** Why now, in one line. */
  why: string;
  icon: Icon;
  /** The primary action's label. */
  actionLabel: string;
  /** Show the same signal again after this long (default: once). */
  repeatAfterMs?: number;
  /** "Don't suggest again" turns it off for one scope (a project) only, not the whole kind. */
  neverPer?: "scope";
};

const DAY_MS = 24 * 3_600_000;

export const ADE_SUGGESTIONS: Record<AdeSuggestionId, AdeSuggestionDefinition> = {
  "lane-template": {
    id: "lane-template",
    title: "Lane templates make new lanes ready to work",
    why: "This repo has packages, and new lanes start without them. A template installs or copies them each time.",
    icon: Stack,
    actionLabel: "Set one up with an agent",
    // Back for a project after two weeks while its signal holds.
    repeatAfterMs: 14 * DAY_MS,
    neverPer: "scope",
  },
  "usage-low": {
    id: "usage-low",
    title: "A second account keeps your chats going",
    why: "A plan here was nearly used up. With another account signed in, "
      + "new chats can start on the one with room left.",
    icon: Gauge,
    actionLabel: "Add an account",
  },
  "machine-mention": {
    id: "machine-mention",
    title: "@ in a chat sends work to another machine",
    why: "Another machine is connected. Type @ in any chat and pick it to start the work there.",
    icon: At,
    actionLabel: "Try it in a new chat",
  },
  "chat-secret": {
    id: "chat-secret",
    title: "ADE secrets keep keys out of your chats",
    why: "A message you sent looked like it had a key or password in it. "
      + "Saved as a secret, agents can use it without it sitting in a transcript.",
    icon: Key,
    actionLabel: "Open Secrets",
    repeatAfterMs: 30 * DAY_MS,
  },
  "issue-tracker": {
    id: "issue-tracker",
    title: "A connected tracker turns issue links into issues",
    why: "You sent a link to an issue in a tracker ADE is not connected to. "
      + "Connected, agents can read the issue and lanes can link to it.",
    icon: LinkSimple,
    actionLabel: "Connect it",
  },
  "parallel-chats": {
    id: "parallel-chats",
    title: "The grid shows every running chat side by side",
    why: "Three or more chats are running at once. "
      + "The grid lets you watch and answer each one without switching.",
    icon: SquaresFour,
    actionLabel: "Open the grid",
  },
  "repeat-prompt": {
    id: "repeat-prompt",
    title: "Automations send a prompt for you",
    why: "You sent the same prompt three times this week. "
      + "An automation can send it on a schedule or when something happens.",
    icon: Repeat,
    actionLabel: "Open Automations",
  },
  "pair-phone": {
    id: "pair-phone",
    title: "ADE on your iPhone keeps up with your chats",
    why: "It has been a week and only this computer is connected. "
      + "On your phone you can follow chats, answer them and hear when one needs you.",
    icon: DeviceMobile,
    actionLabel: "Pair your phone",
  },
};

export type PostponedSuggestion = {
  id: AdeSuggestionId;
  scopeKey: string;
  /** Where it applies, for the Tips row ("ade · Mac Studio"). */
  context: string | null;
  postponedAt: number;
};

export const POSTPONED_SUGGESTIONS_STORAGE_KEY = "ade.tips.suggestions.v1";
const MAX_ENTRIES = 20;

export function isSuggestionId(value: unknown): value is AdeSuggestionId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ADE_SUGGESTIONS, value);
}

function parsePostponed(stored: unknown): readonly PostponedSuggestion[] {
  if (!Array.isArray(stored)) return [];
  const out: PostponedSuggestion[] = [];
  for (const entry of stored) {
    const record = storedRecord(entry);
    if (!record || !isSuggestionId(record.id) || typeof record.scopeKey !== "string" || !record.scopeKey) continue;
    out.push({
      id: record.id,
      scopeKey: record.scopeKey,
      context: typeof record.context === "string" && record.context ? record.context : null,
      postponedAt: finiteNumber(record.postponedAt) ?? 0,
    });
  }
  return out;
}

const store = createLocalStore({ key: POSTPONED_SUGGESTIONS_STORAGE_KEY, event: "ade:tips-suggestions", parse: parsePostponed });

const write = (next: readonly PostponedSuggestion[]) => store.set(next.slice(0, MAX_ENTRIES));

const sameEntry = (entry: PostponedSuggestion, id: AdeSuggestionId, scopeKey: string) =>
  entry.id === id && entry.scopeKey === scopeKey;

/** "Not now": file the suggestion into ADE Tips (newest first). */
export function postponeSuggestion(input: { id: AdeSuggestionId; scopeKey: string; context?: string | null }): void {
  const rest = store.get().filter((entry) => !sameEntry(entry, input.id, input.scopeKey));
  write([{ id: input.id, scopeKey: input.scopeKey, context: input.context ?? null, postponedAt: Date.now() }, ...rest]);
}

/** The suggestion was started, refused for good, or no longer applies. */
export function forgetPostponedSuggestion(id: AdeSuggestionId, scopeKey: string): void {
  const current = store.get();
  if (!current.some((entry) => sameEntry(entry, id, scopeKey))) return;
  write(current.filter((entry) => !sameEntry(entry, id, scopeKey)));
}

export function usePostponedSuggestions(): readonly PostponedSuggestion[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ── live handlers from the suggestion's owner ──────────────────────────

type KindHandlers = { never: (scopeKey: string) => void };

const kindHandlers = new Map<AdeSuggestionId, KindHandlers>();
const starters = new Map<string, () => void>();
const handlerListeners = new Set<() => void>();
let handlerVersion = 0;

const starterKey = (id: AdeSuggestionId, scopeKey: string) => `${id}\u0000${scopeKey}`;

function emitHandlers(): void {
  handlerVersion += 1;
  for (const listener of handlerListeners) listener();
}

/** The owner's "never" for every scope of this kind. Returns the unregister. */
export function registerSuggestionKind(id: AdeSuggestionId, handlers: KindHandlers): () => void {
  kindHandlers.set(id, handlers);
  return () => {
    if (kindHandlers.get(id) === handlers) kindHandlers.delete(id);
  };
}

/**
 * The owner can start this suggestion for `scopeKey` right now (the project
 * is open and its data is loaded). Returns the unregister.
 */
export function registerSuggestionStarter(id: AdeSuggestionId, scopeKey: string, start: () => void): () => void {
  const key = starterKey(id, scopeKey);
  starters.set(key, start);
  emitHandlers();
  return () => {
    if (starters.get(key) !== start) return;
    starters.delete(key);
    emitHandlers();
  };
}

/** Starts a postponed suggestion through its owner; false when the owner cannot here. */
export function startPostponedSuggestion(id: AdeSuggestionId, scopeKey: string): boolean {
  const start = starters.get(starterKey(id, scopeKey));
  if (!start) return false;
  start();
  return true;
}

/** "Don't suggest again", from Tips: the owner records it, and the entry goes. */
export function neverSuggest(id: AdeSuggestionId, scopeKey: string): void {
  kindHandlers.get(id)?.never(scopeKey);
  forgetPostponedSuggestion(id, scopeKey);
}

function subscribeHandlers(listener: () => void): () => void {
  handlerListeners.add(listener);
  return () => {
    handlerListeners.delete(listener);
  };
}

/** Whether the owner can start this suggestion here and now. */
export function useSuggestionStartable(id: AdeSuggestionId, scopeKey: string): boolean {
  useSyncExternalStore(subscribeHandlers, () => handlerVersion, () => handlerVersion);
  return starters.has(starterKey(id, scopeKey));
}
