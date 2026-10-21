/**
 * Jev's model and effort hint for a new chat.
 *
 * Jev gets the prompt, this user's recent new chats with the same provider and
 * the same model maker (what each was about, and the model and effort it
 * started on), and the model × effort choices that provider offers for that
 * maker. It picks the one this user would want. Matching a request to how a
 * person already works is reading, which Jev does well; there are no
 * benchmark numbers to weigh.
 *
 * Every gap (Jev null or unsure, no catalogue, no choices) is "no hint": the
 * composer stays exactly as it was.
 */
import type { JevAnswers, JevDecideRequest } from "../../../shared/types/jev";
import type { UserCatalogModel, UserModelCatalog } from "../../../main/services/router/modelCatalog";
import type { ModelHintHistoryEntry } from "./modelHintHistory";

/** A prompt worth reading: this many words, or this many characters (one long word, a path). */
const MIN_PROMPT_WORDS = 3;
const MIN_PROMPT_CHARS = 12;
const STATE_PROMPT_CHARS = 2_000;
/**
 * Below this the pick reads as no answer. On 160 of the author's real new
 * chats, 0.7 kept 8 of 9 chips right; 0.5 showed 14 with 6 the user ignored.
 */
const MIN_CONFIDENCE = 0.7;
/**
 * History lines sent to Jev, newest first. In the same test, 5 to 15 lines
 * picked equally well, none was far worse, and 30 drifted to older habits.
 * Free Jev has a daily allowance shared by every Jev feature on the network,
 * so the shorter end wins.
 */
const HISTORY_LINES = 10;
/** Models offered besides the current one and the ones in the history: the strongest few. */
const EXTRA_MODELS = 4;
/** Effort levels apart before an effort-only hint shows. */
const EFFORT_LEVELS_TO_SPEAK = 2;

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

export type HintChoice = { key: string; modelId: string; displayName: string; effort: string | null };

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
    for (const effort of levelsOf(model)) {
      choices.push({ key: effort ? `${name} · ${effort}` : name, modelId: model.modelId, displayName: model.displayName, effort });
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
  return {
    feature: "model_hint",
    state: lines.filter((line) => line != null).join("\n"),
    questions: {
      pick: {
        type: "choice",
        instructions:
          "Pick the model and effort this user would want for the new request, judging from how they chose for similar past requests. Follow their habits: if they use a strong model and high effort for real work, keep that; go lower only for a request as small as their past small ones, and higher only for one clearly harder than what they usually pick for. With no similar past request, pick what fits the request.",
        criteria: Object.fromEntries(context.choices.map((choice) => [
          choice.key,
          `${choice.displayName}${choice.effort ? ` at ${choice.effort} effort` : ""}`,
        ])),
      },
    },
    priority: "interactive",
  } satisfies JevDecideRequest;
}

export type ModelHintAnswers = JevAnswers<ReturnType<typeof buildModelHintRequest>["questions"]>;

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

/**
 * Jev's pick as a hint, or null. Shown only when the pick is clearly off from
 * the current one: another model, or an effort `EFFORT_LEVELS_TO_SPEAK` or
 * more levels away. A model the user picked by hand is never moved to a
 * weaker one; it can still be moved up.
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
  const pick = args.answers?.pick;
  if (!pick || pick.confidence < MIN_CONFIDENCE) return null;
  const choice = args.choices.find((entry) => entry.key === pick.choice);
  if (!choice) return null;
  const { current, currentEffort } = args;
  const reason = args.fromHistory
    ? "From how you picked for similar new chats"
    : "Jev's read of this prompt (no similar chats yet)";

  if (choice.modelId === current.modelId) {
    const levels = levelsOf(current);
    if (currentEffort == null || choice.effort == null || choice.effort === currentEffort) return null;
    const gap = Math.abs(levels.indexOf(choice.effort) - levels.indexOf(currentEffort));
    if (levels.indexOf(currentEffort) < 0 || gap < EFFORT_LEVELS_TO_SPEAK) return null;
    return {
      modelId: current.modelId,
      displayName: current.displayName,
      effort: choice.effort,
      effortOnly: true,
      direction: effortRank(choice.effort) > effortRank(currentEffort) ? "up" : "down",
      reason,
    };
  }

  const target = args.catalog.models.find((model) => model.modelId === choice.modelId);
  const direction = strength(target) >= strength(current) ? "up" : "down";
  if (direction === "down" && args.modelChosen) return null;
  return {
    modelId: choice.modelId,
    displayName: choice.displayName,
    effort: choice.effort,
    effortOnly: false,
    direction,
    reason,
  };
}
