/**
 * Jev's model and effort hint for the composer.
 *
 * Jev reads the prompt (how hard, what kind, does it need eyes, a long
 * context, a fast reply); a deterministic picker then chooses, from the
 * models this machine can run, the cheapest model and effort that clears the
 * quality bar for that read. Jev is good at reading a task and poor at
 * arithmetic over benchmark numbers, so the numbers stay here.
 *
 * Every gap (Jev null or unsure, no catalogue, the current pick unrated, no
 * candidate) is "no hint": the composer stays exactly as it was.
 */
import type { JevAnswers, JevDecideRequest } from "../../../shared/types/jev";
import type { UserCatalogModel, UserModelCatalog } from "../../../main/services/router/modelCatalog";

/** A prompt worth reading: this many words, or this many characters (one long word, a path). */
const MIN_PROMPT_WORDS = 3;
const MIN_PROMPT_CHARS = 12;
const STATE_PROMPT_CHARS = 2_000;
/** Below this, a score or choice answer reads as no answer. */
const MIN_CONFIDENCE = 0.5;
/** A yes/no answer counts as yes at or above this. */
const NOUL_YES = 0.7;
const LONG_CONTEXT_TOKENS = 400_000;

const DIFFICULTIES = ["trivial", "routine", "substantial", "hard"] as const;
export type HintDifficulty = (typeof DIFFICULTIES)[number];

const KINDS = {
  question: "answer or explain something, no code change",
  research: "read and investigate code or docs without changing them",
  review: "review a diff, PR or code for problems",
  small_edit: "a small, specific edit: rename, tweak, typo, one function",
  feature: "build a new feature or a substantial addition",
  debugging: "find and fix a bug, failure, crash or flaky test",
  refactor: "restructure or redesign existing code or architecture",
  writing: "write prose: docs, README, release notes, an email",
  media: "work with audio, speech, images or video",
} as const;
export type HintKind = keyof typeof KINDS;

// Wording calibrated on 2026-10-20 against 15 realistic prompts (trivial
// questions and typo fixes through a flaky websocket race and a CRDT redesign).
export const MODEL_HINT_QUESTIONS = {
  difficulty: {
    type: "score",
    instructions:
      "How much skill and care does this request need from an AI coding agent? trivial: a quick fact or a single obvious edit. routine: a clear, small change, a short explanation, or an error whose cause is likely in one place. substantial: a feature touching several files, a review, or an investigation. hard: an intermittent or flaky bug, a race or concurrency problem, a redesign, or open-ended work across a large codebase.",
    criteria: [...DIFFICULTIES],
  },
  kind: {
    type: "choice",
    instructions: "What kind of work does the request ask the agent to do?",
    criteria: { ...KINDS },
  },
  needs_vision: {
    type: "noul",
    instructions: "Does the task require looking at images, screenshots, or visual design (attached images count)?",
  },
  long_context: {
    type: "noul",
    instructions:
      "Does the task require reading a very large amount of material at once, such as a whole large codebase, long logs or many long documents?",
  },
  speed_matters: {
    type: "noul",
    instructions:
      "Is this a quick back-and-forth request where a fast reply matters more than depth, rather than a long autonomous job?",
  },
} satisfies JevDecideRequest["questions"];

/** Long enough to say what it asks: "say hi back" is, "fix it" is not. */
export function isModelHintPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_PROMPT_CHARS || trimmed.split(/\s+/).filter(Boolean).length >= MIN_PROMPT_WORDS;
}

export type ModelHintAnswers = JevAnswers<typeof MODEL_HINT_QUESTIONS>;

export type ModelHintContext = {
  prompt: string;
  laneName: string | null;
  chatHasHistory: boolean;
  fileCount: number;
  imageCount: number;
};

export function buildModelHintRequest(context: ModelHintContext): JevDecideRequest<typeof MODEL_HINT_QUESTIONS> {
  const lines = [
    `Request: ${context.prompt.trim().slice(0, STATE_PROMPT_CHARS)}`,
    context.laneName ? `Lane: ${context.laneName}` : null,
    context.chatHasHistory ? "This continues an existing chat." : "This starts a new chat.",
    context.imageCount ? `Attached images: ${context.imageCount}` : null,
    context.fileCount ? `Attached files: ${context.fileCount}` : null,
  ];
  return {
    feature: "model_hint",
    state: lines.filter(Boolean).join("\n"),
    questions: MODEL_HINT_QUESTIONS,
    priority: "interactive",
  };
}

export type ModelHintRead = {
  difficulty: HintDifficulty;
  kind: HintKind;
  needsVision: boolean;
  needsAudio: boolean;
  longContext: boolean;
  speedMatters: boolean;
};

/** Jev's answers as a task read, or null when it is unsure about what matters. */
export function readModelHintAnswers(answers: ModelHintAnswers | null, imageCount: number): ModelHintRead | null {
  if (!answers) return null;
  const { difficulty, kind } = answers;
  if (difficulty.confidence < MIN_CONFIDENCE || kind.confidence < MIN_CONFIDENCE) return null;
  const level = DIFFICULTIES[difficulty.score];
  if (!level || !(kind.choice in KINDS)) return null;
  const media = kind.choice === "media";
  const needsVision = imageCount > 0 || answers.needs_vision.noul >= NOUL_YES;
  return {
    difficulty: level,
    kind: kind.choice as HintKind,
    needsVision,
    // A media task that is not about images is about audio.
    needsAudio: media && !needsVision,
    longContext: answers.long_context.noul >= NOUL_YES,
    speedMatters: answers.speed_matters.noul >= NOUL_YES,
  };
}

/**
 * The quality bar, on the catalogue's Coding Agent Index scale (0 to 1; the
 * best models score about 0.69 in October 2026). `base` by difficulty, then
 * `kind` moves it: reading and writing need less than finding a bug.
 */
const QUALITY_BAR = {
  base: { trivial: 0.25, routine: 0.4, substantial: 0.52, hard: 0.6 },
  kind: {
    question: -0.05,
    research: -0.02,
    review: 0,
    small_edit: -0.03,
    feature: 0,
    debugging: 0.02,
    refactor: 0.02,
    writing: -0.08,
    media: -0.05,
  },
} as const satisfies { base: Record<HintDifficulty, number>; kind: Record<HintKind, number> };

export function qualityBarFor(read: Pick<ModelHintRead, "difficulty" | "kind">): number {
  return QUALITY_BAR.base[read.difficulty] + QUALITY_BAR.kind[read.kind];
}

/** Free and plan-included before metered. */
function billingTier(model: UserCatalogModel): number {
  return model.billing.kind === "metered" ? 1 : 0;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
function effortRank(effort: string | null): number {
  const index = effort ? EFFORT_ORDER.indexOf(effort) : -1;
  return index < 0 ? EFFORT_ORDER.indexOf("medium") : index;
}

type Option = {
  model: UserCatalogModel;
  effort: string | null;
  quality: number;
  cost: number;
  seconds: number;
};

function optionsOf(model: UserCatalogModel): Option[] {
  return model.efforts.flatMap((level) => level.quality.score == null ? [] : [{
    model,
    effort: level.effort,
    quality: level.quality.score,
    // Free costs the user nothing; an unknown cost sorts after every known one.
    cost: model.billing.kind === "free" ? 0 : level.costPerIndexTaskUsd ?? Number.POSITIVE_INFINITY,
    seconds: level.secondsPerIndexTask ?? model.profile?.secondsPerIndexTask ?? Number.POSITIVE_INFINITY,
  }]);
}

function meetsNeeds(model: UserCatalogModel, read: ModelHintRead): boolean {
  const input = model.profile?.modalities?.input;
  if (read.needsVision && !input?.includes("image")) return false;
  if (read.needsAudio && !input?.includes("speech") && !model.media.length) return false;
  if (read.longContext && (model.profile?.contextWindow ?? 0) < LONG_CONTEXT_TOKENS) return false;
  return true;
}

/**
 * Free and plan-included first, then the harness the chat already uses (a
 * hint should not move a Claude chat to another harness when Claude has a
 * model that does the job), then cheapest; when a fast reply matters,
 * quickest, with times within `SPEED_TIE_RATIO` of each other left to cost.
 */
/**
 * Two task times this close are the same reply to a person waiting: 81 s
 * against 90 s should not keep a pricier model over a cheaper one.
 */
const SPEED_TIE_RATIO = 1.25;
function secondsTie(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.max(a, b) <= Math.min(a, b) * SPEED_TIE_RATIO;
}

function compareOptions(a: Option, b: Option, speedMatters: boolean, harness: string): number {
  const tier = billingTier(a.model) - billingTier(b.model);
  if (tier) return tier;
  const home = Number(a.model.harness !== harness) - Number(b.model.harness !== harness);
  if (home) return home;
  if (speedMatters && !secondsTie(a.seconds, b.seconds)) return a.seconds - b.seconds;
  return a.cost - b.cost || effortRank(a.effort) - effortRank(b.effort) || b.quality - a.quality;
}

export type ModelHint = {
  modelId: string;
  displayName: string;
  effort: string | null;
  /** True when only the effort differs from the current selection. */
  effortOnly: boolean;
  direction: "up" | "down";
  read: ModelHintRead;
  reason: string;
};

const DIFFICULTY_LABEL: Record<HintDifficulty, string> = {
  trivial: "Trivial",
  routine: "Routine",
  substantial: "Substantial",
  hard: "Hard",
};
const KIND_LABEL: Record<HintKind, string> = {
  question: "question",
  research: "research",
  review: "review",
  small_edit: "edit",
  feature: "feature",
  debugging: "debugging",
  refactor: "refactor",
  writing: "writing",
  media: "media task",
};
const BILLING_PHRASE = { plan: "is on your plan", free: "is free", metered: "is metered" } as const;

/**
 * Whether a task of this difficulty may be told to go UP (more effort or a
 * stronger model). A trivial task never is: a small model can clear the
 * benchmark bar only at its top level ("Haiku at max" for a typo fix), and
 * nobody wants that advice. It can still be told to go down.
 */
const RAISES_ALLOWED: Record<HintDifficulty, boolean> = {
  trivial: false,
  routine: true,
  substantial: true,
  hard: true,
};

/** Keep the current pick when it clears the bar at no more than this times the cheapest cost. */
const KEEP_CURRENT_COST_RATIO = 1.5;

/**
 * The effort an unrated model should run at, by difficulty: with no scores to
 * hold against a bar, the level follows how hard the task reads. The nearest
 * level the model offers stands in for a missing one.
 */
const UNRATED_EFFORT: Record<HintDifficulty, string> = {
  trivial: "low",
  routine: "medium",
  substantial: "high",
  hard: "xhigh",
};

function unratedEffortHint(model: UserCatalogModel, currentEffort: string | null, read: ModelHintRead): ModelHint | null {
  const levels = model.efforts.map((level) => level.effort).filter((effort): effort is string => effort != null);
  if (levels.length < 2 || currentEffort == null) return null;
  const wanted = effortRank(UNRATED_EFFORT[read.difficulty]);
  const effort = [...levels].sort((a, b) => Math.abs(effortRank(a) - wanted) - Math.abs(effortRank(b) - wanted)
    || effortRank(a) - effortRank(b))[0]!;
  if (effort === currentEffort) return null;
  const direction = effortRank(effort) > effortRank(currentEffort) ? "up" : "down";
  if (direction === "up" && !RAISES_ALLOWED[read.difficulty]) return null;
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    effort,
    effortOnly: true,
    direction,
    read,
    reason: `${DIFFICULTY_LABEL[read.difficulty]} ${KIND_LABEL[read.kind]} · ${effort} effort fits a ${read.difficulty} task (no benchmark data for this model)`,
  };
}

/**
 * The model and effort to suggest, or null to suggest nothing. `allowedModelIds`
 * is the picker's own list when it narrows what this chat can switch to.
 * `modelPinned`: the user chose this model, so only its effort may change.
 * A model the registry does not rate is never suggested; it can still get an
 * effort hint on its own levels.
 */
export function pickModelHint(args: {
  catalog: UserModelCatalog;
  read: ModelHintRead;
  currentModelId: string;
  currentEffort: string | null;
  allowedModelIds?: readonly string[] | null;
  modelPinned: boolean;
}): ModelHint | null {
  const { catalog, read, currentModelId, currentEffort, modelPinned } = args;
  const allowed = args.allowedModelIds?.length ? new Set(args.allowedModelIds) : null;
  const currentModel = catalog.models.find((model) => model.modelId === currentModelId);
  if (!currentModel) return null;
  const currentLevel = currentModel.efforts.find((level) => level.effort === currentEffort)
    ?? currentModel.efforts.find((level) => level.isDefault)
    ?? currentModel.efforts[0];
  const current = currentLevel ? optionsOf(currentModel).find((option) => option.effort === currentLevel.effort) : undefined;
  // No score for the current pick: no footing to call another model better or cheaper.
  if (!current) return unratedEffortHint(currentModel, currentEffort, read);

  const bar = qualityBarFor(read);
  const candidates = catalog.models
    .filter((model) => modelPinned
      ? model === currentModel
      : (!allowed || allowed.has(model.modelId)) && meetsNeeds(model, read))
    .flatMap(optionsOf)
    .filter((option) => option.quality >= bar)
    .sort((a, b) => compareOptions(a, b, read.speedMatters, currentModel.harness));
  const best = candidates[0];
  if (!best) return null;
  if (best.model.modelId === current.model.modelId && best.effort === current.effort) return null;

  const currentClears = current.quality >= bar && meetsNeeds(currentModel, read);
  // Close enough: a hint that saves pennies is noise.
  if (currentClears && billingTier(currentModel) <= billingTier(best.model)
    && current.cost <= best.cost * KEEP_CURRENT_COST_RATIO
    && (!read.speedMatters || current.seconds <= best.seconds * KEEP_CURRENT_COST_RATIO)) {
    return null;
  }

  const effortOnly = best.model.modelId === current.model.modelId;
  const direction = best.quality > current.quality ? "up" : "down";
  if (direction === "up" && !RAISES_ALLOWED[read.difficulty]) return null;
  const task = `${DIFFICULTY_LABEL[read.difficulty]} ${KIND_LABEL[read.kind]}`;
  const billing = BILLING_PHRASE[best.model.billing.kind];
  let why: string;
  if (!currentClears) why = `your pick is below the bar; the cheapest that clears it ${billing}`;
  else if (read.speedMatters) why = `quick model that clears the bar ${billing}`;
  else if (effortOnly) why = `a ${direction === "down" ? "lower" : "higher"} effort clears the bar for less`;
  else why = `cheapest model that clears the bar ${billing}`;
  return {
    modelId: best.model.modelId,
    displayName: best.model.displayName,
    effort: best.effort,
    effortOnly,
    direction,
    read,
    reason: `${task} · ${why}`,
  };
}
