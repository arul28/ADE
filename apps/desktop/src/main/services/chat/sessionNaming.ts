/**
 * Session naming: the prompts, failure classification, and model-candidate
 * chain shared by automatic lane identity and chat auto-titling.
 *
 * All three callers — lane identity, chat auto-title, and the legacy lane-name
 * suggestion — used to carry their own hand-copied chain and retry loop, which
 * had already drifted apart. They live here so "the same chain" is a fact
 * rather than a comment.
 */
import {
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "../../../shared/modelRegistry";

/**
 * The word count every naming surface aims for. It is a guideline handed to the
 * model, never a rejection rule: an over-long answer is clamped, because a
 * clamped real name beats falling back to a deterministic slug.
 */
export const MAX_NAMING_WORDS = 6;

export const AUTO_TITLE_SYSTEM_PROMPT = `You title software development chat sessions.
Return only the title text.
- Aim for 2 to ${MAX_NAMING_WORDS} words. This is a guideline, not a hard limit: a slightly longer title is far better than no title.
- Focus on the task, feature, bug, or deliverable.
- Never start with Completed, Complete, Done, Finished, Resolved, or Success.
- No quotes.
- No emoji.
- No trailing punctuation.`;

export const LANE_NAME_FROM_PROMPT_SYSTEM_PROMPT = `Generate the stable identity for an automatically created software workspace.
Return strict JSON only: {"laneTitle":"...","branchFragment":"..."}.
Aim for ${MAX_NAMING_WORDS} words or fewer in both fields. That is a guideline, not a hard limit: a slightly longer answer is far better than an empty or refused one.
laneTitle:
- Natural readable user-facing title, 2 to ${MAX_NAMING_WORDS} words, with spaces and natural title capitalization.
- Preserve meaningful capitalization such as ADE, GitHub, iOS, macOS, Codex, OpenAI, and OAuth.
- Describe the durable workstream, outcome, feature, bug, UI surface, or command.
- Prefer meaningful nouns and product concepts over procedural wording.
- Avoid prompt, question, request, conversation, chat, task, discuss, investigate, or look into unless genuinely part of a feature name.
- Avoid generic leading verbs such as Fix, Update, Improve, Handle, or Work On when a specific noun phrase is available.
- Do not repeat the user's sentence verbatim. No quotes, emoji, or trailing punctuation.
branchFragment:
- Describe the same workstream in 2 to ${MAX_NAMING_WORDS} short specific words.
- Lowercase ASCII and hyphen-separated. Do not include the ade/ prefix.
- No spaces, quotes, refs/heads/, punctuation-heavy text, or leading/trailing separators.
- Keep it concise and safe for GitHub, PR lists, terminals, and Git branch naming.
Attached images are primary context for visual and UI requests.`;

export const LEGACY_LANE_NAME_SYSTEM_PROMPT = `Name a git worktree lane.
Return only a short slug-friendly name with no slash, quotes, emoji, or trailing punctuation.
Aim for ${MAX_NAMING_WORDS} words or fewer — a guideline, not a hard limit. A slightly longer name is far better than no name.`;

export const AUTO_LANE_IDENTITY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    laneTitle: { type: "string" },
    branchFragment: { type: "string" },
  },
  required: ["laneTitle", "branchFragment"],
} as const;

/**
 * Failures that condemn every model behind a provider — a missing or unusable
 * CLI, an account that cannot run the model, auth, or quota. Retrying a sibling
 * model on the same provider just burns another spawn, so naming skips ahead to
 * a different provider instead.
 *
 * "not supported with/when" covers the account-rejects-this-model 400
 * ("The 'x' model is not supported when using Codex with a ChatGPT account").
 * It deliberately excludes "not supported for/on/by", which describe a single
 * model lacking a capability — those must still retry a sibling model.
 */
const PROVIDER_LEVEL_NAMING_FAILURE_PATTERN =
  /enoent|eacces|spawn\b|not found|no such file|unauthor|unauthenticated|not (?:logged in|authenticated)|\b40[13]\b|api[_ -]?key|credential|not supported (?:with|when)|unsupported model|model[_ -]?not[_ -]?found|does not exist|insufficient|quota|rate limit/i;

export function isProviderLevelNamingFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return PROVIDER_LEVEL_NAMING_FAILURE_PATTERN.test(message);
}

/**
 * Build the ordered model chain naming walks: the caller's preferred models
 * first, then a model from a provider none of them belong to, then a sibling on
 * the leading provider. A cross-provider candidate is always reachable, so an
 * outage confined to one provider cannot end naming outright.
 */
export function buildNamingModelCandidates(args: {
  availableModels: ModelDescriptor[];
  /** Ordered preference list; unavailable and duplicate ids are dropped. */
  preferred: Array<string | null | undefined>;
}): string[] {
  const availableIds = new Set(args.availableModels.map((entry) => entry.id));
  const availableInOrder = (candidates: Array<string | null | undefined>): string[] =>
    candidates.reduce<string[]>((acc, candidate) => {
      const modelId = typeof candidate === "string" ? candidate.trim() : "";
      if (!modelId || acc.includes(modelId) || !availableIds.has(modelId)) return acc;
      return [...acc, modelId];
    }, []);

  const preferred = availableInOrder(args.preferred);
  const [primary] = preferred;
  if (!primary) return [];

  const providerOf = (modelId: string): ModelProviderGroup | null => {
    const descriptor = getModelById(modelId);
    return descriptor ? resolveProviderGroupForModel(descriptor) : null;
  };
  const leadingProviders = new Set(
    preferred.map(providerOf).filter((group): group is ModelProviderGroup => group !== null),
  );
  const primaryProvider = providerOf(primary);
  const crossProviderFallback = args.availableModels.find(
    (entry) => !leadingProviders.has(resolveProviderGroupForModel(entry)),
  )?.id;
  const sameProviderFallback = args.availableModels.find(
    (entry) => !preferred.includes(entry.id)
      && primaryProvider !== null
      && resolveProviderGroupForModel(entry) === primaryProvider,
  )?.id;

  return availableInOrder([
    ...preferred,
    crossProviderFallback,
    sameProviderFallback,
    args.availableModels.find((entry) => !preferred.includes(entry.id))?.id,
  ]);
}

const MAX_NAMING_ATTEMPTS = 3;

export type NamingAttemptFailure = {
  descriptor: ModelDescriptor;
  provider: ModelProviderGroup;
  providerLevelFailure: boolean;
  attemptCount: number;
  error: unknown;
};

/**
 * Walk the candidate chain until one model returns a usable result. A
 * provider-level failure condemns every remaining model behind that provider.
 * `run` returning null means "this model answered, but unusably" — the next
 * candidate still gets a turn, because a working model beats a slug.
 */
export async function runNamingAcrossProviders<T>(
  candidateModelIds: string[],
  options: {
    /** Abandon the chain without adopting anything — e.g. the user renamed mid-flight. */
    shouldStop?: () => boolean;
    run: (descriptor: ModelDescriptor) => Promise<T | null>;
    onFailure: (failure: NamingAttemptFailure) => void;
  },
): Promise<{ result: T | null; attemptCount: number; selectedModelId: string | null }> {
  const exhaustedProviders = new Set<ModelProviderGroup>();
  let attemptCount = 0;
  let selectedModelId: string | null = null;

  for (const candidateModelId of candidateModelIds) {
    if (attemptCount >= MAX_NAMING_ATTEMPTS) break;
    if (options.shouldStop?.()) break;
    const descriptor = getModelById(candidateModelId);
    if (!descriptor) continue;
    const provider = resolveProviderGroupForModel(descriptor);
    if (exhaustedProviders.has(provider)) continue;
    attemptCount += 1;
    selectedModelId = descriptor.id;
    try {
      const result = await options.run(descriptor);
      if (options.shouldStop?.()) break;
      if (result !== null) {
        return { result, attemptCount, selectedModelId };
      }
    } catch (error) {
      const providerLevelFailure = isProviderLevelNamingFailure(error);
      if (providerLevelFailure) exhaustedProviders.add(provider);
      options.onFailure({ descriptor, provider, providerLevelFailure, attemptCount, error });
    }
  }

  return { result: null, attemptCount, selectedModelId };
}
