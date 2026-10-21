/**
 * What this user actually runs, per kind of task: the memory behind Jev's
 * model and effort hint.
 *
 * Kept in this window's localStorage, because it describes the person typing,
 * not a machine. It holds no prompt text: per sample, only Jev's read of the
 * task (kind, difficulty), the harness, the model, the effort, how much it
 * counts, and when. Three sources feed it:
 *
 * - every prompt sent with a Jev read (`recordModelHintSend`, full weight);
 * - accepted and dismissed hints (`recordModelHintOutcome`), which also teach
 *   it which suggestions this user does not want for a kind of task;
 * - a one-time backfill from recent chats (`backfillModelHintProfile`): Jev
 *   reads each chat's title, and the model and effort the chat settled on
 *   count at less than full weight.
 */
import type { JevDecideRequest } from "../../../shared/types/jev";
import type { OpenProjectBinding } from "../../../shared/types";
import type { HintDifficulty, HintKind } from "./modelHint";

const STORAGE_KEY = "ade.modelHint.profile.v1";
const MAX_SAMPLES = 400;
const MAX_SEEN_SESSIONS = 2_000;
/** A sample counts half as much after this long: habits move. */
const HALF_LIFE_MS = 60 * 24 * 60 * 60_000;
/** A chat read from its title counts this much; a prompt sent counts 1. */
const BACKFILL_WEIGHT = 0.6;
/** Chats read per backfill pass, newest first, and how often a pass may run. */
const BACKFILL_CHATS = 30;
const BACKFILL_INTERVAL_MS = 24 * 60 * 60_000;
const BACKFILL_MIN_CONFIDENCE = 0.5;

export type HintSample = {
  kind: HintKind;
  difficulty: HintDifficulty;
  harness: string;
  modelId: string;
  effort: string | null;
  weight: number;
  at: number;
};

export type HintSuggestionType = "model" | "effort";
export type HintDirection = "up" | "down";
type OutcomeCounts = { accept: number; dismiss: number };

export type ModelHintProfile = {
  samples: HintSample[];
  /** Keyed `kind|type|direction`. */
  outcomes: Record<string, OutcomeCounts>;
  /** Chats already read by the backfill. */
  seenSessionIds: string[];
  backfilledAt: number;
};

const DIFFICULTIES: readonly HintDifficulty[] = ["trivial", "routine", "substantial", "hard"];
const KINDS: readonly HintKind[] = [
  "question", "research", "review", "small_edit", "feature", "debugging", "refactor", "writing", "media",
];

function emptyProfile(): ModelHintProfile {
  return { samples: [], outcomes: {}, seenSessionIds: [], backfilledAt: 0 };
}

function isSample(value: unknown): value is HintSample {
  const sample = value as HintSample;
  return Boolean(sample)
    && KINDS.includes(sample.kind)
    && DIFFICULTIES.includes(sample.difficulty)
    && typeof sample.harness === "string"
    && typeof sample.modelId === "string"
    && (sample.effort === null || typeof sample.effort === "string")
    && typeof sample.weight === "number" && Number.isFinite(sample.weight)
    && typeof sample.at === "number" && Number.isFinite(sample.at);
}

export function readModelHintProfile(): ModelHintProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Partial<ModelHintProfile>;
    const outcomes: Record<string, OutcomeCounts> = {};
    for (const [key, value] of Object.entries(parsed.outcomes ?? {})) {
      const accept = Number(value?.accept);
      const dismiss = Number(value?.dismiss);
      if (Number.isFinite(accept) && Number.isFinite(dismiss)) outcomes[key] = { accept, dismiss };
    }
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples.filter(isSample).slice(-MAX_SAMPLES) : [],
      outcomes,
      seenSessionIds: Array.isArray(parsed.seenSessionIds)
        ? parsed.seenSessionIds.filter((id): id is string => typeof id === "string").slice(-MAX_SEEN_SESSIONS)
        : [],
      backfilledAt: Number.isFinite(parsed.backfilledAt) ? Number(parsed.backfilledAt) : 0,
    };
  } catch {
    return emptyProfile();
  }
}

function writeProfile(profile: ModelHintProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...profile,
      samples: profile.samples.slice(-MAX_SAMPLES),
      seenSessionIds: profile.seenSessionIds.slice(-MAX_SEEN_SESSIONS),
    }));
  } catch {
    // Best effort: without storage the hint falls back to benchmarks.
  }
}

function update(change: (profile: ModelHintProfile) => void): void {
  const profile = readModelHintProfile();
  change(profile);
  writeProfile(profile);
}

export function recordModelHintSend(sample: Omit<HintSample, "weight" | "at">): void {
  update((profile) => profile.samples.push({ ...sample, weight: 1, at: Date.now() }));
}

export function recordModelHintOutcome(args: {
  kind: HintKind;
  type: HintSuggestionType;
  direction: HintDirection;
  outcome: "accept" | "dismiss";
}): void {
  update((profile) => {
    const key = `${args.kind}|${args.type}|${args.direction}`;
    const counts = profile.outcomes[key] ?? { accept: 0, dismiss: 0 };
    counts[args.outcome] += 1;
    profile.outcomes[key] = counts;
  });
}

/**
 * True when this user keeps turning down this kind of suggestion for this kind
 * of task: two more dismissals than takes.
 */
export function suggestionUnwanted(
  profile: ModelHintProfile,
  kind: HintKind,
  type: HintSuggestionType,
  direction: HintDirection,
): boolean {
  const counts = profile.outcomes[`${kind}|${type}|${direction}`];
  return Boolean(counts && counts.dismiss >= counts.accept + 2);
}

function decayed(sample: HintSample, nowMs: number): number {
  return sample.weight * 0.5 ** (Math.max(0, nowMs - sample.at) / HALF_LIFE_MS);
}

/**
 * How much a sample speaks for this task: the same kind counts fully (more at
 * the same difficulty), another kind only as a faint "what you usually run".
 */
function relevance(sample: HintSample, kind: HintKind, difficulty: HintDifficulty): number {
  if (sample.kind !== kind) return 0.15;
  return sample.difficulty === difficulty ? 1.5 : 1;
}

export type HintHabit = {
  /** The model this user runs for this kind of task in this harness, when one clearly leads. */
  modelId: string | null;
  /** Its share of the weight, 0 to 1. */
  modelShare: number;
  /** Weight behind the read; under 2 is too little to act on. */
  weight: number;
  /** Weighted samples per model and effort, for `habitEffort`. */
  efforts: Map<string, Array<{ effort: string | null; weight: number }>>;
};

export function habitFor(
  profile: ModelHintProfile,
  read: { kind: HintKind; difficulty: HintDifficulty },
  harness: string,
  nowMs = Date.now(),
): HintHabit {
  const byModel = new Map<string, number>();
  const efforts = new Map<string, Array<{ effort: string | null; weight: number }>>();
  let total = 0;
  for (const sample of profile.samples) {
    if (sample.harness !== harness) continue;
    const weight = decayed(sample, nowMs) * relevance(sample, read.kind, read.difficulty);
    if (weight <= 0) continue;
    total += weight;
    byModel.set(sample.modelId, (byModel.get(sample.modelId) ?? 0) + weight);
    const list = efforts.get(sample.modelId) ?? [];
    list.push({ effort: sample.effort, weight });
    efforts.set(sample.modelId, list);
  }
  let modelId: string | null = null;
  let best = 0;
  for (const [id, weight] of byModel) {
    if (weight > best) {
      best = weight;
      modelId = id;
    }
  }
  const modelShare = total > 0 ? best / total : 0;
  return { modelId: modelShare >= 0.55 ? modelId : null, modelShare, weight: total, efforts };
}

/** The weighted median effort this user runs this model at, with the weight behind it. */
export function habitEffort(
  habit: HintHabit,
  modelId: string,
  rank: (effort: string | null) => number,
): { effort: string | null; weight: number } | null {
  const list = habit.efforts.get(modelId);
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => rank(a.effort) - rank(b.effort));
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= total / 2) return { effort: entry.effort, weight: total };
  }
  return null;
}

// ── Backfill from recent chats ─────────────────────────────────────────────

const TITLE_QUESTIONS = {
  difficulty: {
    type: "score",
    instructions:
      "This is the title of a chat with an AI coding agent. How much skill and care did the task need? trivial: a quick fact or a single obvious edit. routine: a clear, small change or a short explanation. substantial: a feature touching several files, a review, or an investigation. hard: an intermittent bug, a race, a redesign, or open-ended work across a large codebase.",
    criteria: [...DIFFICULTIES],
  },
  kind: {
    type: "choice",
    instructions: "What kind of work was the chat about?",
    criteria: {
      question: "answer or explain something, no code change",
      research: "read and investigate code or docs without changing them",
      review: "review a diff, PR or code for problems",
      small_edit: "a small, specific edit: rename, tweak, typo, one function",
      feature: "build a new feature or a substantial addition",
      debugging: "find and fix a bug, failure, crash or flaky test",
      refactor: "restructure or redesign existing code or architecture",
      writing: "write prose: docs, README, release notes, an email",
      media: "work with audio, speech, images or video",
    },
  },
} satisfies JevDecideRequest["questions"];

let backfillRunning = false;

/**
 * Reads up to `BACKFILL_CHATS` recent chats this profile has not seen, one Jev
 * call at a time at background priority, at most once a day. Any Jev failure
 * ends the pass; the chats left are read next time.
 */
export async function backfillModelHintProfile(args: {
  pin: OpenProjectBinding | null;
  harnessOf: (modelId: string) => string | null;
}): Promise<void> {
  if (backfillRunning) return;
  const start = readModelHintProfile();
  if (Date.now() - start.backfilledAt < BACKFILL_INTERVAL_MS) return;
  backfillRunning = true;
  try {
    update((profile) => {
      profile.backfilledAt = Date.now();
    });
    const sessions = await window.ade.agentChat.list({ includeArchived: true }, args.pin).catch(() => []);
    const seen = new Set(start.seenSessionIds);
    const todo = sessions
      .filter((session) => !seen.has(session.sessionId) && session.title?.trim() && (session.modelId ?? session.model))
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .slice(0, BACKFILL_CHATS);
    for (const session of todo) {
      const modelId = String(session.modelId ?? session.model);
      const harness = args.harnessOf(modelId);
      const answers = harness
        ? await window.ade.ai.jevDecide({
          feature: "model_hint",
          state: `Chat title: ${session.title!.trim().slice(0, 200)}`,
          questions: TITLE_QUESTIONS,
          priority: "background",
        }, args.pin).catch(() => null)
        : null;
      if (harness && !answers) return;
      update((profile) => {
        profile.seenSessionIds.push(session.sessionId);
        if (!harness || !answers) return;
        const difficulty = DIFFICULTIES[answers.difficulty.score];
        const kind = answers.kind.choice as HintKind;
        if (!difficulty || !KINDS.includes(kind)) return;
        if (answers.difficulty.confidence < BACKFILL_MIN_CONFIDENCE || answers.kind.confidence < BACKFILL_MIN_CONFIDENCE) return;
        const at = Date.parse(session.lastActivityAt);
        profile.samples.push({
          kind,
          difficulty,
          harness,
          modelId,
          effort: session.reasoningEffort ?? null,
          weight: BACKFILL_WEIGHT,
          at: Number.isFinite(at) ? at : Date.now(),
        });
      });
    }
  } finally {
    backfillRunning = false;
  }
}
