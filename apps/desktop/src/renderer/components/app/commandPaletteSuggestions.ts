/**
 * The Jev "Suggested" group's pure layer: which palette commands are worth
 * sending to Jev for a plain-English query, and how each is described to it.
 * `usePaletteSuggestions` owns the debounce, cache and the model call.
 */

/** The slice of a palette command the suggestion scoring reads. */
export type PaletteSuggestionCommand = {
  id: string;
  title: string;
  hint?: string;
  keywords?: string[];
  group?: string;
};

export const PALETTE_SUGGESTION_DEBOUNCE_MS = 500;
export const PALETTE_SUGGESTION_MAX_CANDIDATES = 20;
export const PALETTE_SUGGESTION_PROBABILITY_FLOOR = 0.15;
export const PALETTE_SUGGESTION_TOP_PROBABILITY_FLOOR = 0.35;
export const PALETTE_SUGGESTION_CACHE_LIMIT = 24;

const PALETTE_SUGGESTION_STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "me", "my", "of", "on", "please",
  "the", "this", "to", "with",
]);

const PALETTE_SUGGESTION_SYNONYMS: Record<string, string[]> = {
  archive: ["archived", "cleanup", "clean up"],
  bigger: ["larger", "increase", "font size", "text size"],
  chat: ["conversation", "session"],
  lane: ["lanes", "worktree", "selected lane"],
  lanes: ["lane", "worktree", "selected lane"],
  new: ["start", "create"],
  open: ["show", "view", "go to", "navigate"],
  old: ["archived", "stale", "merged", "idle"],
  pr: ["pull request", "pull requests", "prs"],
  pull: ["pr", "prs"],
  request: ["pr", "prs"],
  start: ["new", "create"],
  text: ["font", "chat", "message"],
};

export type PaletteSuggestionCacheEntry = {
  requestKey: string;
  commandIds: string[];
};

export type PaletteSuggestionResult = {
  query: string;
  context: string;
  commandIds: string[];
};

function containsPaletteWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(text);
}

export function paletteSuggestionCandidates<C extends PaletteSuggestionCommand>(
  commands: C[],
  matchedCommands: C[],
  queryTerms: readonly string[],
): C[] {
  const terms = queryTerms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 1 && !PALETTE_SUGGESTION_STOP_WORDS.has(term));
  if (terms.length === 0) return [];

  const existingMatches = new Set(matchedCommands);
  return commands
    .map((command, order) => {
      const title = command.title.toLowerCase();
      const searchable = [title, command.hint ?? "", ...(command.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      let score = existingMatches.has(command) ? 16 : 0;
      let matchedTerms = 0;
      for (const term of terms) {
        if (containsPaletteWord(title, term)) {
          score += 5;
          matchedTerms += 1;
          continue;
        }
        if (containsPaletteWord(searchable, term)) {
          score += 3;
          matchedTerms += 1;
          continue;
        }
        if ((PALETTE_SUGGESTION_SYNONYMS[term] ?? []).some((synonym) => searchable.includes(synonym))) {
          score += 1;
          matchedTerms += 1;
        }
      }
      if (matchedTerms === terms.length) score += 8;
      return { command, order, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, PALETTE_SUGGESTION_MAX_CANDIDATES)
    .map((candidate) => candidate.command);
}

export function paletteSuggestionDescription(command: PaletteSuggestionCommand): string {
  const fallback = `Open the ${command.group ?? "ADE"} action for this task.`;
  const terms = command.keywords?.slice(0, 7).join(", ");
  return [
    `${command.title}: ${command.hint?.trim() || fallback}`,
    terms ? `Related terms: ${terms}` : "",
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 280);
}
