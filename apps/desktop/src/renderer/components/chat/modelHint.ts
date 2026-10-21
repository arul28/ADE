/**
 * Jev's model and effort hint for a new chat.
 *
 * Jev gets the prompt and this user's recent new chats with the same provider
 * and the same model maker (what each was about, and the model and effort it
 * started on), and answers two small questions: which of that provider's
 * models for that maker, and which effort, this user would want. Matching a
 * request to how a person already works is reading, which Jev does well.
 *
 * Asked only that, Jev copies the user: five "say hello" chats on Opus give
 * Opus for the sixth. So a third question asks for the cheapest model that
 * does the request well, with each model's intelligence and price. Alone it
 * sends real work to the smallest model too, so it speaks only when Jev is
 * near certain and puts the request at the lowest effort: on 160 real chats
 * it fired twice, both times on a model the user then picked.
 *
 * Every gap (Jev null or unsure, no catalogue, no choices) is "no hint": the
 * composer stays exactly as it was.
 */
import type { JevChoiceAnswer, JevChoiceQuestion, JevDecideRequest } from "../../../shared/types/jev";
import type { UserCatalogModel, UserModelCatalog } from "../../../main/services/router/modelCatalog";
import type { ModelHintHistoryEntry } from "./modelHintHistory";

/** A prompt worth reading: this many words, or this many characters (one long word, a path). */
const MIN_PROMPT_WORDS = 3;
const MIN_PROMPT_CHARS = 12;
const STATE_PROMPT_CHARS = 2_000;
/**
 * Below this the pick reads as no answer: for another model, Jev's confidence
 * in that model; for an effort alone, its probability that the effort is
 * `EFFORT_LEVELS_TO_SPEAK` or more levels off. On 160 of the author's real
 * new chats about 70% of the chips shown matched what the user then picked.
 */
const MIN_CONFIDENCE = 0.7;
/**
 * History lines sent to Jev, newest first. In the same test, 5 to 15 lines
 * picked equally well and 30 drifted to older habits; with no history Jev
 * stays unsure and silent. Free Jev has a daily allowance shared by every Jev
 * feature on the network, so the short end wins.
 */
const HISTORY_LINES = 5;
/** Models offered besides the current one and the ones in the history: the strongest few. */
const EXTRA_MODELS = 4;
/** Effort levels apart before an effort-only hint shows. */
const EFFORT_LEVELS_TO_SPEAK = 2;
/** The cheapest-model answer needs this, on a request Jev puts at the lowest effort. */
const CHEAPER_CONFIDENCE = 0.9;

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
function effortRank(effort: string | null): number {
  const index = effort ? EFFORT_ORDER.indexOf(effort) : -1;
  return index < 0 ? EFFORT_ORDER.indexOf("medium") : index;
}

/** Long enough to say what it asks: "say hi back" is, "fix it" is not. */
export function isModelHintPrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_PROMPT_CHARS || trimmed.split(/\s+/).filter(Boolean).length >= MIN_PROMPT_WORDS;
}

/** "OpenAI", "Anthropic": who makes the model, from the registry, else from its name. */
export function makerOf(model: Pick<UserCatalogModel, "modelId" | "displayName" | "profile">): string {
  const creator = model.profile?.creator?.trim();
  if (creator) return creator;
  const name = `${model.modelId} ${model.displayName}`.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(name)) return "Anthropic";
  if (/\bgpt|\bo[1-9]\b|codex|luna|terra|sol\b|astra/.test(name)) return "OpenAI";
  if (/gemini|gemma/.test(name)) return "Google";
  if (/grok/.test(name)) return "xAI";
  if (/deepseek/.test(name)) return "DeepSeek";
  if (/qwen/.test(name)) return "Alibaba";
  if (/kimi/.test(name)) return "Moonshot";
  return model.modelId.split("/").slice(-1)[0] ?? model.modelId;
}

function shortName(name: string): string {
  return name.replace(/^Claude\s+/, "").replace(/\s*\(latest\)$/i, "");
}

/** `opencode/anthropic/claude-haiku-4-5` → `anthropic/claude-haiku-4-5`: the model behind the harness. */
function modelTail(modelId: string): string {
  return modelId.split("/").slice(-2).join("/");
}

function harnessOfModelId(modelId: string): UserCatalogModel["harness"] | null {
  if (modelId.startsWith("opencode/")) return "opencode";
  if (modelId.startsWith("cursor/")) return "cursor";
  if (modelId.startsWith("anthropic/")) return "claude";
  if (modelId.startsWith("openai/")) return "codex";
  return null;
}

/**
 * The current model's catalogue entry. A model this harness lists but the
 * catalogue does not (Claude Code's Haiku 4.5) borrows the entry of the same
 * model in another harness, keeping its own harness and id.
 */
export function resolveCurrentModel(catalog: UserModelCatalog, modelId: string): UserCatalogModel | null {
  const exact = catalog.models.find((model) => model.modelId === modelId);
  if (exact) return exact;
  const harness = harnessOfModelId(modelId);
  const twin = harness ? catalog.models.find((model) => modelTail(model.modelId) === modelTail(modelId)) : null;
  return twin && harness ? { ...twin, harness, modelId } : null;
}

function levelsOf(model: UserCatalogModel): Array<string | null> {
  return [...new Set(model.efforts.map((level) => level.effort))].sort((a, b) => effortRank(a) - effortRank(b));
}

export type HintChoice = {
  modelId: string;
  displayName: string;
  effort: string | null;
  /** "intelligence 38/100, $0.1/$0.5 per million tokens": what the cheapest-model question weighs. */
  facts: string;
};

function modelFacts(model: UserCatalogModel): string {
  const intelligence = model.profile?.intelligenceIndex;
  const price = model.price;
  return [
    intelligence != null ? `intelligence ${Math.round(intelligence)}/100` : null,
    price?.input != null && price.output != null ? `$${price.input}/$${price.output} per million tokens` : null,
  ].filter(Boolean).join(", ") || "no published numbers";
}

/**
 * The model × effort choices Jev picks from: models of the current one's
 * harness and maker only, as many as the picker allows. The current model,
 * every model in the history, and the strongest few others; with
 * `effortOnly`, the current model alone.
 */
export function hintChoices(args: {
  catalog: UserModelCatalog;
  current: UserCatalogModel;
  history: readonly ModelHintHistoryEntry[];
  allowedModelIds: readonly string[] | null;
  effortOnly: boolean;
  needsImages: boolean;
}): HintChoice[] {
  const { catalog, current, history, effortOnly } = args;
  const maker = makerOf(current);
  const allowed = args.allowedModelIds?.length ? new Set(args.allowedModelIds) : null;
  const inHistory = new Set(history.map((entry) => entry.modelId));
  const sameMaker = effortOnly ? [] : catalog.models.filter((model) => model.harness === current.harness
    && model.modelId !== current.modelId
    && makerOf(model) === maker
    && (!allowed || allowed.has(model.modelId))
    && (!args.needsImages || model.profile?.modalities?.input?.includes("image")));
  const strongest = [...sameMaker]
    .filter((model) => !inHistory.has(model.modelId))
    .sort((a, b) => (b.profile?.intelligenceIndex ?? -1) - (a.profile?.intelligenceIndex ?? -1))
    .slice(0, EXTRA_MODELS);
  const models = [current, ...sameMaker.filter((model) => inHistory.has(model.modelId)), ...strongest];
  const seenNames = new Set<string>();
  const choices: HintChoice[] = [];
  for (const model of models) {
    const name = shortName(model.displayName);
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const facts = modelFacts(model);
    for (const effort of levelsOf(model)) {
      choices.push({ modelId: model.modelId, displayName: model.displayName, effort, facts });
    }
  }
  return choices;
}

export type ModelHintContext = {
  prompt: string;
  laneName: string | null;
  fileCount: number;
  imageCount: number;
  provider: string;
  maker: string;
  history: readonly ModelHintHistoryEntry[];
  choices: readonly HintChoice[];
};

function historyLine(entry: ModelHintHistoryEntry): string {
  const pick = entry.effort ? `${shortName(entry.displayName)} · ${entry.effort}` : shortName(entry.displayName);
  return `- ${pick}: ${entry.gist}`;
}

export function buildModelHintRequest(context: ModelHintContext) {
  // Only chats on a model still offered: older ones are a past era of habits.
  const offered = new Set(context.choices.map((choice) => choice.modelId));
  const history = context.history.filter((entry) => offered.has(entry.modelId)).slice(0, HISTORY_LINES);
  const lines = [
    `New chat request: ${context.prompt.trim().slice(0, STATE_PROMPT_CHARS)}`,
    context.laneName ? `Lane: ${context.laneName}` : null,
    context.imageCount ? `Attached images: ${context.imageCount}` : null,
    context.fileCount ? `Attached files: ${context.fileCount}` : null,
    "",
    history.length
      ? `This user's recent new chats with ${context.maker} models in ${context.provider}, newest first (model · effort: what it was about):\n${history.map(historyLine).join("\n")}`
      : `This user has no recent new chats with ${context.maker} models in ${context.provider}.`,
  ];
  // Two small questions instead of one over every model × effort pair: half
  // the input tokens, as accurate, and harder to talk into a pick.
  const questions: Record<string, JevChoiceQuestion> = {};
  const models = new Map(context.choices.map((choice) => [shortName(choice.displayName), choice.displayName]));
  if (models.size >= 2) {
    questions.model = {
      type: "choice",
      instructions: "Pick the model this user would want for the new request, judging from how they chose for similar past requests.",
      criteria: Object.fromEntries(models),
    };
    questions.cheapest = {
      type: "choice",
      instructions: "Pick the cheapest model that will do this request well. The user's past requests show how demanding they are; a request that any of these models can do needs no stronger one.",
      criteria: Object.fromEntries(context.choices.map((choice) => [shortName(choice.displayName), `${choice.displayName}: ${choice.facts}`])),
    };
  }
  const efforts = effortsOf(context.choices);
  if (efforts.length >= 2) {
    questions.effort = {
      type: "choice",
      instructions:
        "Pick the effort this user would want for the new request, judging from how they chose for similar past requests: keep their usual effort for real work, lower only for a request as small as their past small ones, higher only for one clearly harder.",
      criteria: Object.fromEntries(efforts.map((effort) => [effort, `${effort} effort`])),
    };
  }
  return {
    feature: "model_hint",
    state: lines.filter((line) => line != null).join("\n"),
    questions,
    priority: "interactive",
  } satisfies JevDecideRequest;
}

function effortsOf(choices: readonly HintChoice[]): string[] {
  return [...new Set(choices.flatMap((choice) => (choice.effort ? [choice.effort] : [])))]
    .sort((a, b) => effortRank(a) - effortRank(b));
}

export type ModelHintAnswers = Partial<Record<"model" | "effort" | "cheapest", JevChoiceAnswer>>;

type Picked = { choice: HintChoice; modelConfidence: number; effortProbabilities: Record<string, number> | null };

/** The choice the two answers name; null when either is missing. */
function pickedChoice(answers: ModelHintAnswers, choices: readonly HintChoice[]): Picked | null {
  const modelAsked = new Set(choices.map((choice) => choice.modelId)).size >= 2;
  const effortAsked = effortsOf(choices).length >= 2;
  if ((modelAsked && !answers.model) || (effortAsked && !answers.effort)) return null;
  // Without a model question the only model is the current one, first in `choices`.
  const modelId = answers.model
    ? choices.find((choice) => shortName(choice.displayName) === answers.model!.choice)?.modelId
    : choices[0]?.modelId;
  const options = choices.filter((choice) => choice.modelId === modelId);
  if (!options.length) return null;
  const want = answers.effort?.choice ?? null;
  // The nearest level the model has: Jev answers over every model's levels.
  const choice = options.find((option) => option.effort === want)
    ?? [...options].sort((a, b) => Math.abs(effortRank(a.effort) - effortRank(want)) - Math.abs(effortRank(b.effort) - effortRank(want)))[0]!;
  return { choice, modelConfidence: answers.model?.confidence ?? 1, effortProbabilities: answers.effort?.probabilities ?? null };
}

export type ModelHint = {
  modelId: string;
  displayName: string;
  effort: string | null;
  /** True when only the effort differs from the current selection. */
  effortOnly: boolean;
  direction: "up" | "down";
  reason: string;
};

function strength(model: UserCatalogModel | null | undefined): number {
  return model?.profile?.intelligenceIndex ?? -1;
}

/** The cheapest-model answer as a choice at Jev's effort, when it is near certain, the effort lowest, and the model weaker than the current one. */
function cheaperChoice(
  answers: ModelHintAnswers | null,
  choices: readonly HintChoice[],
  picked: HintChoice,
  catalog: UserModelCatalog,
  current: UserCatalogModel,
): HintChoice | null {
  const cheapest = answers?.cheapest;
  if (!cheapest || cheapest.confidence < CHEAPER_CONFIDENCE || effortRank(picked.effort) > effortRank("low")) return null;
  const options = choices.filter((choice) => shortName(choice.displayName) === cheapest.choice);
  const target = catalog.models.find((model) => model.modelId === options[0]?.modelId);
  if (!target || target.modelId === current.modelId || strength(target) < 0 || strength(target) >= strength(current)) return null;
  return options.find((option) => option.effort === picked.effort)
    ?? [...options].sort((a, b) => effortRank(a.effort) - effortRank(b.effort))[0]
    ?? null;
}

/**
 * Jev's pick as a hint, or null. Shown only when the pick is clearly off from
 * the current one: another model, or an effort `EFFORT_LEVELS_TO_SPEAK` or
 * more levels away. A model the user picked by hand is never moved to a
 * weaker one, except to a cheaper model for a clearly small request
 * (`cheaperChoice`); it can still be moved up, but not for a request Jev
 * puts at the lowest effort.
 */
export function hintFromAnswer(args: {
  answers: ModelHintAnswers | null;
  choices: readonly HintChoice[];
  catalog: UserModelCatalog;
  current: UserCatalogModel;
  currentEffort: string | null;
  modelChosen: boolean;
  fromHistory: boolean;
}): ModelHint | null {
  const picked = args.answers ? pickedChoice(args.answers, args.choices) : null;
  if (!picked) return null;
  const { choice } = picked;
  const { current, currentEffort } = args;
  const reason = args.fromHistory
    ? "From how you picked for similar new chats"
    : "Jev's read of this prompt (no similar chats yet)";

  // A clearly small request: a cheaper model does it as well, even over a model picked by hand.
  const cheaper = cheaperChoice(args.answers, args.choices, choice, args.catalog, current);
  if (cheaper) {
    return {
      modelId: cheaper.modelId,
      displayName: cheaper.displayName,
      effort: cheaper.effort,
      effortOnly: false,
      direction: "down",
      reason: "A small request: a cheaper model does it as well",
    };
  }

  if (choice.modelId === current.modelId) {
    const levels = levelsOf(current);
    if (currentEffort == null || choice.effort == null || choice.effort === currentEffort) return null;
    const from = levels.indexOf(currentEffort);
    const to = levels.indexOf(choice.effort);
    if (from < 0 || Math.abs(to - from) < EFFORT_LEVELS_TO_SPEAK) return null;
    // Sure the effort is that far off on that side, not merely sure of one level.
    const farOff = levels.reduce((sum, level, index) => {
      const apart = (index - from) * Math.sign(to - from);
      return apart >= EFFORT_LEVELS_TO_SPEAK && level ? sum + (picked.effortProbabilities?.[level] ?? 0) : sum;
    }, 0);
    if (farOff < MIN_CONFIDENCE) return null;
    return {
      modelId: current.modelId,
      displayName: current.displayName,
      effort: choice.effort,
      effortOnly: true,
      direction: effortRank(choice.effort) > effortRank(currentEffort) ? "up" : "down",
      reason,
    };
  }

  // Another model needs Jev sure of the model; the effort shown is its best level.
  if (picked.modelConfidence < MIN_CONFIDENCE) return null;
  const target = args.catalog.models.find((model) => model.modelId === choice.modelId);
  const direction = strength(target) >= strength(current) ? "up" : "down";
  if (direction === "down" && args.modelChosen) return null;
  // A stronger model at the lowest effort is habit, not need: the request is
  // small enough for the model already picked.
  if (direction === "up" && effortRank(choice.effort) <= effortRank("low")) return null;
  return {
    modelId: choice.modelId,
    displayName: choice.displayName,
    effort: choice.effort,
    effortOnly: false,
    direction,
    reason,
  };
}
