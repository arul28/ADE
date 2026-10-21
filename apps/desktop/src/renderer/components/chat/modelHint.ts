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
import { habitEffort, habitFor, suggestionUnwanted, type ModelHintProfile } from "./modelHintProfile";

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
 * Two task times this close are the same reply to a person waiting: 81 s
 * against 90 s should not keep a pricier model over a cheaper one.
 */
const SPEED_TIE_RATIO = 1.25;
function secondsTie(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.max(a, b) <= Math.min(a, b) * SPEED_TIE_RATIO;
}

/**
 * Free and plan-included first, then cheapest; when a fast reply matters,
 * quickest, with times within `SPEED_TIE_RATIO` of each other left to cost.
 */
function compareOptions(a: Option, b: Option, speedMatters: boolean): number {
  const tier = billingTier(a.model) - billingTier(b.model);
  if (tier) return tier;
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

/** What the hint knows for this prompt: the effort to mark in the picker, and the chip, if any. */
export type ModelHintAdvice = {
  /** The effort that fits this prompt on the current model; marked in the effort picker. */
  suggestedEffort: string | null;
  /** The chip: only when the current pick is clearly off. */
  hint: ModelHint | null;
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
/** "for debugging", "for edits": how a reason names the kind of task. */
const KIND_PLURAL: Record<HintKind, string> = {
  question: "questions",
  research: "research",
  review: "reviews",
  small_edit: "small edits",
  feature: "features",
  debugging: "debugging",
  refactor: "refactors",
  writing: "writing",
  media: "media tasks",
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
/** Effort levels apart before the chip speaks up; one level off is left to the picker's mark. */
const EFFORT_LEVELS_TO_SPEAK = 2;
/** At its best level a model this far under the bar is too weak for the task. */
const TOO_WEAK_MARGIN = 0.03;
/** Weight of the user's own samples before their habit counts at all, and before it counts most. */
const HABIT_MIN_WEIGHT = 2;
const HABIT_FULL_WEIGHT = 10;
/** The most a habit can outweigh the benchmarks. */
const HABIT_MAX_SHARE = 0.75;

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

/** The harness a model id runs in when the catalogue does not list it. */
function harnessOfModelId(modelId: string): string | null {
  if (modelId.startsWith("opencode/")) return "opencode";
  if (modelId.startsWith("cursor/")) return "cursor";
  if (modelId.startsWith("anthropic/")) return "claude";
  if (modelId.startsWith("openai/")) return "codex";
  return null;
}

/** `opencode/anthropic/claude-haiku-4-5` → `anthropic/claude-haiku-4-5`: the model behind the harness. */
function modelTail(modelId: string): string {
  const parts = modelId.split("/");
  return parts.slice(-2).join("/");
}

/**
 * The current model's catalogue entry. A model this harness lists but the
 * catalogue does not rate borrows the scores of the same model in another
 * harness (Claude's Haiku 4.5 from OpenCode's), keeping its own harness.
 */
function resolveCurrent(catalog: UserModelCatalog, modelId: string): UserCatalogModel | null {
  const exact = catalog.models.find((model) => model.modelId === modelId);
  if (exact) return exact;
  const harness = harnessOfModelId(modelId);
  if (!harness) return null;
  const tail = modelTail(modelId);
  const twins = catalog.models.filter((model) => modelTail(model.modelId) === tail);
  const rated = twins.find((model) => model.efforts.some((level) => level.quality.score != null)) ?? twins[0];
  return rated ? { ...rated, harness: harness as UserCatalogModel["harness"], modelId } : null;
}

export function harnessOfCatalogModel(catalog: UserModelCatalog, modelId: string): string | null {
  return catalog.models.find((model) => model.modelId === modelId)?.harness ?? harnessOfModelId(modelId);
}

/** A model's levels in effort order. */
function levelsOf(model: UserCatalogModel): Array<string | null> {
  return [...new Set(model.efforts.map((level) => level.effort))].sort((a, b) => effortRank(a) - effortRank(b));
}

/** The model's level nearest a rank, the lower one on a tie. */
function nearestLevel(levels: ReadonlyArray<string | null>, rank: number): string | null {
  return [...levels].sort((a, b) => Math.abs(effortRank(a) - rank) - Math.abs(effortRank(b) - rank)
    || effortRank(a) - effortRank(b))[0] ?? null;
}

type EffortRead = {
  /** The effort that fits, after the user's habit. */
  effort: string | null;
  /** What the benchmarks alone say. */
  benchEffort: string | null;
  /** No level of this model clears the bar. */
  tooWeak: boolean;
  /** The user's habit moved the pick. */
  personal: boolean;
  quality: number | null;
};

/**
 * The effort that fits this task on one model: the cheapest level that clears
 * the bar (or, unrated, the level the difficulty calls for), pulled toward the
 * level this user runs the model at for this kind of task as their samples
 * grow. A habit never pulls a trivial task up, nor a model past its best level.
 */
function effortFor(model: UserCatalogModel, read: ModelHintRead, bar: number, profile: ModelHintProfile | null): EffortRead {
  const levels = levelsOf(model);
  const options = optionsOf(model);
  let benchEffort: string | null;
  let tooWeak = false;
  let quality: number | null = null;
  if (options.length) {
    const clearing = options.filter((option) => option.quality >= bar)
      .sort((a, b) => a.cost - b.cost || effortRank(a.effort) - effortRank(b.effort));
    const best = [...options].sort((a, b) => b.quality - a.quality)[0]!;
    const pick = clearing[0] ?? best;
    benchEffort = pick.effort;
    quality = pick.quality;
    tooWeak = !clearing.length && best.quality < bar - TOO_WEAK_MARGIN;
  } else {
    benchEffort = nearestLevel(levels, effortRank(UNRATED_EFFORT[read.difficulty]));
  }
  let effort = benchEffort;
  let personal = false;
  if (profile && levels.length > 1) {
    const habit = habitEffort(habitFor(profile, read, model.harness), model.modelId, effortRank);
    if (habit && habit.weight >= HABIT_MIN_WEIGHT) {
      const share = Math.min(HABIT_MAX_SHARE, habit.weight / HABIT_FULL_WEIGHT);
      let rank = Math.round(share * effortRank(habit.effort) + (1 - share) * effortRank(benchEffort));
      if (read.difficulty === "trivial") rank = Math.min(rank, effortRank(benchEffort));
      const blended = nearestLevel(levels, rank);
      personal = blended !== benchEffort;
      effort = blended;
    }
  }
  return { effort, benchEffort, tooWeak, personal, quality };
}

function levelGap(model: UserCatalogModel, a: string | null, b: string | null): number {
  const levels = levelsOf(model);
  const index = (effort: string | null) => {
    const found = levels.indexOf(effort);
    return found >= 0 ? found : levels.indexOf(nearestLevel(levels, effortRank(effort)));
  };
  return Math.abs(index(a) - index(b));
}

/**
 * Jev's read, the catalogue and this user's history, turned into advice.
 *
 * - The effort that fits is always worked out, for the picker to mark.
 * - Models are suggested only within the chat's own harness (its provider and
 *   what that provider offers).
 * - Up: when the current model is too weak for the task even at its best
 *   level, a stronger one is suggested, even on a model the user picked.
 * - Down or sideways: only for a model the user did not pick (`modelPinned`
 *   false): the model this user runs for this kind of task, else the cheapest
 *   one that clears the bar.
 * - Effort: the chip shows only when the current effort is at least
 *   `EFFORT_LEVELS_TO_SPEAK` levels from the one that fits.
 * - A kind of suggestion this user keeps dismissing for this kind of task is
 *   not shown again.
 *
 * `allowedModelIds` is the picker's own list when it narrows what this chat
 * can switch to; `modelsAllowed` false (the effort-only setting) keeps every
 * hint to effort.
 */
export function adviseModelHint(args: {
  catalog: UserModelCatalog;
  read: ModelHintRead;
  currentModelId: string;
  currentEffort: string | null;
  allowedModelIds?: readonly string[] | null;
  modelPinned: boolean;
  modelsAllowed: boolean;
  profile: ModelHintProfile | null;
}): ModelHintAdvice {
  const { catalog, read, currentModelId, currentEffort, modelPinned, modelsAllowed, profile } = args;
  const none: ModelHintAdvice = { suggestedEffort: null, hint: null };
  const current = resolveCurrent(catalog, currentModelId);
  if (!current) return none;
  const bar = qualityBarFor(read);
  const fit = effortFor(current, read, bar, profile);
  const levels = levelsOf(current);
  const suggestedEffort = levels.length > 1 ? fit.effort : null;
  const task = `${DIFFICULTY_LABEL[read.difficulty]} ${KIND_LABEL[read.kind]}`;
  const unwanted = (type: "model" | "effort", direction: "up" | "down") =>
    Boolean(profile && suggestionUnwanted(profile, read.kind, type, direction));

  const modelHint = modelsAllowed ? pickModel() : null;
  if (modelHint) return { suggestedEffort, hint: modelHint };

  // Effort on the current model.
  if (suggestedEffort == null || currentEffort == null || suggestedEffort === currentEffort) {
    return { suggestedEffort, hint: null };
  }
  if (levelGap(current, currentEffort, suggestedEffort) < EFFORT_LEVELS_TO_SPEAK) return { suggestedEffort, hint: null };
  const direction = effortRank(suggestedEffort) > effortRank(currentEffort) ? "up" : "down";
  if (direction === "up" && !RAISES_ALLOWED[read.difficulty]) return { suggestedEffort, hint: null };
  if (unwanted("effort", direction)) return { suggestedEffort, hint: null };
  let why: string;
  if (fit.personal) why = `you usually run ${KIND_PLURAL[read.kind]} at about this level`;
  else if (!optionsOf(current).length) why = `${effortLabel(suggestedEffort)} effort fits a ${read.difficulty} task (no benchmark data for this model)`;
  else if (direction === "down") why = "a lower effort clears the bar for less";
  else why = "your current effort is below the bar for this task";
  return {
    suggestedEffort,
    hint: {
      modelId: current.modelId,
      displayName: current.displayName,
      effort: suggestedEffort,
      effortOnly: true,
      direction,
      read,
      reason: `${task} · ${why}`,
    },
  };

  function pickModel(): ModelHint | null {
    const allowed = args.allowedModelIds?.length ? new Set(args.allowedModelIds) : null;
    const pool = catalog.models.filter((model) => model.harness === current!.harness
      && model.modelId !== current!.modelId
      && (!allowed || allowed.has(model.modelId))
      && meetsNeeds(model, read));
    const clearing = pool
      .flatMap(optionsOf)
      .filter((option) => option.quality >= bar)
      .sort((a, b) => compareOptions(a, b, read.speedMatters));
    const habit = profile ? habitFor(profile, read, current!.harness) : null;
    const habitModel = habit && habit.weight >= HABIT_MIN_WEIGHT * 1.5 && habit.modelId !== current!.modelId
      ? pool.find((model) => model.modelId === habit.modelId) ?? null
      : null;
    const habitFits = habitModel != null && optionsOf(habitModel).some((option) => option.quality >= bar);
    const needsUp = fit.tooWeak || !meetsNeeds(current!, read);
    const currentClears = !needsUp && (fit.quality == null || fit.quality >= bar);

    // Up: the current model cannot do this task well at any level.
    if (needsUp && RAISES_ALLOWED[read.difficulty] && !unwanted("model", "up")) {
      const target = habitFits ? habitModel! : clearing[0]?.model ?? null;
      if (!target) return null;
      const reason = habitFits
        ? `${shortName(current!.displayName)} is below the bar here; you usually use ${shortName(target.displayName)} for ${KIND_PLURAL[read.kind]}`
        : `${shortName(current!.displayName)} is below the bar here; the cheapest that clears it ${BILLING_PHRASE[target.billing.kind]}`;
      return modelSuggestion(target, "up", reason);
    }
    if (modelPinned) return null;

    // The model this user runs for this kind of task.
    if (habitFits) {
      const direction = modelStrength(habitModel!) >= modelStrength(current!) ? "up" : "down";
      if (!unwanted("model", direction) && (direction === "down" || RAISES_ALLOWED[read.difficulty])) {
        return modelSuggestion(habitModel!, direction, `you usually use ${shortName(habitModel!.displayName)} for ${KIND_PLURAL[read.kind]}`);
      }
    }

    // This user runs the current model for this kind of task: leave it.
    if (habit && habit.modelId === current!.modelId && habit.weight >= HABIT_MIN_WEIGHT * 1.5) return null;

    // Otherwise the cheapest model that clears the bar, when it saves enough to matter.
    const best = clearing[0];
    if (!best) return null;
    const currentOption = optionsOf(current!).find((option) => option.effort === fit.effort);
    if (currentClears) {
      if (!currentOption) return null;
      if (billingTier(current!) <= billingTier(best.model)
        && currentOption.cost <= best.cost * KEEP_CURRENT_COST_RATIO
        && (!read.speedMatters || currentOption.seconds <= best.seconds * KEEP_CURRENT_COST_RATIO)) return null;
    }
    const direction = modelStrength(best.model) >= modelStrength(current!) ? "up" : "down";
    if (direction === "up" && !RAISES_ALLOWED[read.difficulty]) return null;
    if (unwanted("model", direction)) return null;
    let why: string;
    if (!currentClears) why = `your pick is just under the bar; the cheapest that clears it ${BILLING_PHRASE[best.model.billing.kind]}`;
    else if (read.speedMatters) why = `a quicker model that clears the bar ${BILLING_PHRASE[best.model.billing.kind]}`;
    else why = `the cheapest model that clears the bar ${BILLING_PHRASE[best.model.billing.kind]}`;
    return modelSuggestion(best.model, direction, why, best.effort);
  }

  function modelSuggestion(target: UserCatalogModel, direction: "up" | "down", why: string, effort?: string | null): ModelHint {
    return {
      modelId: target.modelId,
      displayName: target.displayName,
      effort: effort !== undefined ? effort : effortFor(target, read, bar, profile).effort,
      effortOnly: false,
      direction,
      read,
      reason: `${task} · ${why}`,
    };
  }
}

/**
 * How "up" and "down" compare two models: the Intelligence Index of the
 * release, else its best score at any level. Not the best score alone: a
 * mid-size model at max effort can edge past a larger one at high.
 */
function modelStrength(model: UserCatalogModel): number {
  const index = model.profile?.intelligenceIndex;
  if (typeof index === "number") return index / 100;
  return Math.max(-1, ...optionsOf(model).map((option) => option.quality));
}

function shortName(name: string): string {
  return name.replace(/^Claude\s+/, "").replace(/\s*\(latest\)$/i, "");
}

function effortLabel(effort: string | null): string {
  return effort ?? "default";
}
