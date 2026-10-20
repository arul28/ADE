import { useSyncExternalStore } from "react";
import { Stack, type Icon } from "@phosphor-icons/react";

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
 */

export type AdeSuggestionId = "lane-template";

export type AdeSuggestionDefinition = {
  id: AdeSuggestionId;
  /** What the feature is. */
  title: string;
  /** Why now, in one line. */
  why: string;
  icon: Icon;
  /** The primary action's label. */
  actionLabel: string;
};

export const ADE_SUGGESTIONS: Record<AdeSuggestionId, AdeSuggestionDefinition> = {
  "lane-template": {
    id: "lane-template",
    title: "Lane templates make new lanes ready to work",
    why: "This repo has packages, and new lanes start without them. A template installs or copies them each time.",
    icon: Stack,
    actionLabel: "Set one up with an agent",
  },
};

export type PostponedSuggestion = {
  id: AdeSuggestionId;
  scopeKey: string;
  /** Where it applies, for the Tips row ("ade · Mac Studio"). */
  context: string | null;
  postponedAt: number;
};

const STORAGE_KEY = "ade.tips.suggestions.v1";
const CHANGE_EVENT = "ade:tips-suggestions";
const MAX_ENTRIES = 20;

function isSuggestionId(value: unknown): value is AdeSuggestionId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ADE_SUGGESTIONS, value);
}

function readStored(): PostponedSuggestion[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PostponedSuggestion[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (!isSuggestionId(record.id) || typeof record.scopeKey !== "string" || !record.scopeKey) continue;
      const postponedAt = typeof record.postponedAt === "number" && Number.isFinite(record.postponedAt) ? record.postponedAt : 0;
      out.push({
        id: record.id,
        scopeKey: record.scopeKey,
        context: typeof record.context === "string" && record.context ? record.context : null,
        postponedAt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

let snapshot: readonly PostponedSuggestion[] | null = null;

function getSnapshot(): readonly PostponedSuggestion[] {
  snapshot ??= readStored();
  return snapshot;
}

function write(next: PostponedSuggestion[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable: the suggestion is only postponed for this session.
  }
  snapshot = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const sameEntry = (entry: PostponedSuggestion, id: AdeSuggestionId, scopeKey: string) =>
  entry.id === id && entry.scopeKey === scopeKey;

/** "Not now": file the suggestion into ADE Tips (newest first). */
export function postponeSuggestion(input: { id: AdeSuggestionId; scopeKey: string; context?: string | null }): void {
  const rest = getSnapshot().filter((entry) => !sameEntry(entry, input.id, input.scopeKey));
  write([{ id: input.id, scopeKey: input.scopeKey, context: input.context ?? null, postponedAt: Date.now() }, ...rest]);
}

/** The suggestion was started, refused for good, or no longer applies. */
export function forgetPostponedSuggestion(id: AdeSuggestionId, scopeKey: string): void {
  const current = getSnapshot();
  if (!current.some((entry) => sameEntry(entry, id, scopeKey))) return;
  write(current.filter((entry) => !sameEntry(entry, id, scopeKey)));
}

export function isSuggestionPostponed(id: AdeSuggestionId, scopeKey: string): boolean {
  return getSnapshot().some((entry) => sameEntry(entry, id, scopeKey));
}

function subscribeStored(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = null;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePostponedSuggestions(): readonly PostponedSuggestion[] {
  return useSyncExternalStore(subscribeStored, getSnapshot, getSnapshot);
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
