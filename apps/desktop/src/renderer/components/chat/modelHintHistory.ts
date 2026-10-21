/**
 * The model and effort this user started their recent new chats on, and what
 * each was about: what Jev's model hint reads to suggest the way this user
 * already works.
 *
 * In the window's localStorage, because it describes the person typing, not a
 * machine or a project. Only new chats the user sends from the composer count:
 * chats agents start never pass through here. Each entry keeps the start of
 * the prompt (`gist`), which is sent to Jev with later prompts.
 */

const GIST_CHARS = 100;

/**
 * A capped list in localStorage, oldest first. Anything unreadable reads as
 * empty, and a failed write is dropped: without storage the hint reads the
 * prompt alone.
 */
function localRing<T>(key: string, max: number, isValid: (value: unknown) => value is T) {
  const read = (): T[] => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter(isValid).slice(-max) : [];
    } catch {
      return [];
    }
  };
  const push = (entry: T): void => {
    try {
      window.localStorage.setItem(key, JSON.stringify([...read(), entry].slice(-max)));
    } catch {
      // Best effort, as above.
    }
  };
  return { read, push };
}

function gistOf(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, GIST_CHARS);
}

export type ModelHintHistoryEntry = {
  at: number;
  /** The chat provider (claude, codex, cursor, opencode). */
  harness: string;
  /** Who makes the model: "Anthropic", "OpenAI". */
  maker: string;
  modelId: string;
  displayName: string;
  effort: string | null;
  /** The prompt's start, on one line. */
  gist: string;
};

function isEntry(value: unknown): value is ModelHintHistoryEntry {
  const entry = value as ModelHintHistoryEntry;
  return Boolean(entry)
    && typeof entry.at === "number" && Number.isFinite(entry.at)
    && typeof entry.harness === "string"
    && typeof entry.maker === "string"
    && typeof entry.modelId === "string"
    && typeof entry.displayName === "string"
    && (entry.effort === null || typeof entry.effort === "string")
    && typeof entry.gist === "string";
}

const history = localRing("ade.modelHint.history.v1", 100, isEntry);

/** This user's new chats with this provider and maker, newest first. */
export function readModelHintHistory(harness: string, maker: string): ModelHintHistoryEntry[] {
  return history.read().filter((entry) => entry.harness === harness && entry.maker === maker).reverse();
}

export function recordModelHintHistory(entry: Omit<ModelHintHistoryEntry, "at" | "gist"> & { prompt: string }): void {
  const gist = gistOf(entry.prompt);
  if (!gist) return;
  const { prompt: _prompt, ...rest } = entry;
  history.push({ ...rest, gist, at: Date.now() });
}

/**
 * What the user did with a "cheaper model" chip: taken or dismissed (a chip
 * left alone says nothing). Jev reads these to judge whether this user takes
 * a cheaper model for a request like the next one, so it stops offering one
 * the user keeps turning down, and keeps offering one they take.
 */
export type CheaperHintOutcome = {
  at: number;
  harness: string;
  maker: string;
  /** "Haiku 5.5 · low". */
  suggested: string;
  outcome: "accepted" | "dismissed";
  /** The prompt's start, on one line. */
  gist: string;
};

function isOutcome(value: unknown): value is CheaperHintOutcome {
  const entry = value as CheaperHintOutcome;
  return Boolean(entry)
    && typeof entry.at === "number" && Number.isFinite(entry.at)
    && typeof entry.harness === "string"
    && typeof entry.maker === "string"
    && typeof entry.suggested === "string"
    && (entry.outcome === "accepted" || entry.outcome === "dismissed")
    && typeof entry.gist === "string";
}

const outcomes = localRing("ade.modelHint.cheaperOutcomes.v1", 20, isOutcome);

/** This user's answers to cheaper-model chips with this provider and maker, newest first. */
export function readCheaperHintOutcomes(harness: string, maker: string): CheaperHintOutcome[] {
  return outcomes.read().filter((entry) => entry.harness === harness && entry.maker === maker).reverse();
}

export function recordCheaperHintOutcome(entry: Omit<CheaperHintOutcome, "at" | "gist"> & { prompt: string }): void {
  const gist = gistOf(entry.prompt);
  if (!gist) return;
  const { prompt: _prompt, ...rest } = entry;
  outcomes.push({ ...rest, gist, at: Date.now() });
}
