/**
 * Session naming: the prompts, failure classification, and model-candidate
 * chain shared by automatic lane identity, chat auto-titling, and explicit
 * session-metadata regeneration.
 *
 * Those callers used to carry their own hand-copied chain and retry loop, which
 * had already drifted apart. They live here so "the same chain" is a fact
 * rather than a comment: the user's title setting, then this session's model,
 * then a deterministic name. No hardcoded Haiku/mini namer.
 */
import {
  deriveDeterministicLaneTitleFromPrompt,
  GENERIC_LANE_FALLBACK_TITLE,
} from "../../../shared/laneNameFallback";
import {
  resolveModelDescriptor,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "../../../shared/modelRegistry";
import { parseStructuredOutput } from "../ai/utils";

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

export const SESSION_METADATA_SYSTEM_PROMPT = `You name the visible metadata for a software development chat in ADE.
Return strict JSON only with exactly these string fields: {"chatTitle":"...","laneName":"...","statusLine":"..."}.
chatTitle:
- A meaningful 2 to ${MAX_NAMING_WORDS} word title for the task, feature, bug, or deliverable.
- Do not start with Completed, Complete, Done, Finished, Resolved, or Success.
- Do not use generic words such as Chat, Session, Status, or Untitled by themselves.
- No quotes, emoji, or trailing punctuation.
laneName:
- A readable 2 to ${MAX_NAMING_WORDS} word name for the durable workstream.
- Describe the feature, bug, UI surface, or outcome rather than the act of asking.
- No branch prefixes, slash characters, quotes, emoji, or trailing punctuation.
statusLine:
- A concise current progress or outcome line, at most 72 characters and ideally ${MAX_NAMING_WORDS} words or fewer.
- State only what the supplied context supports. Never invent a completion, blocker, test result, or decision.
- No quotes, emoji, or trailing punctuation.
Use the current metadata only as context; the user's explicit regenerate choice permits replacing it.`;

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
- Describe the SAME new workstream as laneTitle, in 2 to ${MAX_NAMING_WORDS} short specific words.
- Lowercase ASCII and hyphen-separated. Do not include the ade/ prefix.
- No spaces, quotes, refs/heads/, punctuation-heavy text, or leading/trailing separators.
- Keep it concise and safe for GitHub, PR lists, terminals, and Git branch naming.
- Never copy the title or branch of an existing lane, chat, or pull request mentioned in the request. Those are context, not this workspace's identity.
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

export const SESSION_METADATA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    chatTitle: { type: "string" },
    laneName: { type: "string" },
    statusLine: { type: "string" },
  },
  required: ["chatTitle", "laneName", "statusLine"],
} as const;

export type GeneratedSessionMetadata = {
  chatTitle: string | null;
  laneName: string | null;
  statusLine: string | null;
};

export type SessionMetadataPromptRunner = (args: {
  cwd: string;
  modelId: string;
  prompt: string;
  systemPrompt: string;
  jsonSchema: typeof SESSION_METADATA_JSON_SCHEMA;
}) => Promise<{ text: string; structuredOutput?: unknown }>;

function asJsonRecord(raw: unknown): Record<string, unknown> | null {
  const value = typeof raw === "string" ? parseStructuredOutput(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Pull the three naming fields out of a model response. Extra keys, missing
 * fields, fenced JSON, and surrounding prose are ignored: Cursor Grok (and
 * other non-schema models) routinely wrap or annotate the object, and a
 * partial real name beats a slug.
 */
export function parseGeneratedSessionMetadata(args: {
  raw: unknown;
  normalizeTitle: (value: string) => string | null;
  normalizeStatusLine: (value: string) => string | null;
}): GeneratedSessionMetadata | null {
  const record = asJsonRecord(args.raw);
  if (!record) return null;
  const chatTitleRaw = readOptionalString(record, "chatTitle");
  const laneNameRaw = readOptionalString(record, "laneName");
  const statusLineRaw = readOptionalString(record, "statusLine");
  const chatTitle = chatTitleRaw ? args.normalizeTitle(chatTitleRaw) : null;
  const laneName = laneNameRaw ? args.normalizeTitle(laneNameRaw) : null;
  const statusLine = statusLineRaw ? args.normalizeStatusLine(statusLineRaw) : null;
  if (!chatTitle && !laneName && !statusLine) return null;
  return { chatTitle, laneName, statusLine };
}

/**
 * Last-resort names when every model returns unusable JSON. Prefer the
 * conversation summary over the original kickoff prompt so "Generate all
 * three" does not restamp the launch-instruction slug.
 */
export function deriveDeterministicSessionMetadata(args: {
  seeds: Array<string | null | undefined>;
  normalizeTitle: (value: string) => string | null;
  normalizeStatusLine: (value: string) => string | null;
}): GeneratedSessionMetadata | null {
  const seed = args.seeds
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0) ?? "";
  if (!seed) return null;
  const title = args.normalizeTitle(deriveDeterministicLaneTitleFromPrompt(seed));
  const chatTitle = title && title !== GENERIC_LANE_FALLBACK_TITLE ? title : null;
  const statusLine = args.normalizeStatusLine(seed);
  if (!chatTitle && !statusLine) return null;
  return { chatTitle, laneName: chatTitle, statusLine };
}

export function buildSessionMetadataPrompt(args: {
  provider: string;
  chatModel?: string | null;
  currentLaneName?: string | null;
  currentChatTitle?: string | null;
  currentStatusLine?: string | null;
  goal?: string | null;
  summary?: string | null;
  latestOutputPreview?: string | null;
  originalRequest?: string | null;
  recentConversation?: string | null;
}): string {
  return [
    "The user explicitly asked ADE to refresh the selected session metadata.",
    "Use the supplied context to produce all three fields, even when only some fields will be applied.",
    `Provider: ${args.provider}`,
    `Chat model: ${args.chatModel ?? ""}`,
    `Current lane name: ${args.currentLaneName ?? ""}`,
    `Current chat title: ${args.currentChatTitle ?? ""}`,
    args.currentStatusLine ? `Current status line: ${args.currentStatusLine}` : null,
    args.goal ? `Chat goal: ${args.goal}` : null,
    args.summary ? `Existing summary: ${args.summary}` : null,
    args.latestOutputPreview ? `Latest output preview: ${args.latestOutputPreview}` : null,
    args.originalRequest ? `Original request: ${args.originalRequest}` : null,
    args.recentConversation ? `Recent conversation:\n${args.recentConversation}` : null,
  ].filter((line): line is string => Boolean(line && line.trim().length)).join("\n\n");
}

export async function runSessionMetadataGeneration(args: {
  candidateModelIds: string[];
  cwd: string;
  prompt: string;
  runPrompt: SessionMetadataPromptRunner;
  normalizeTitle: (value: string) => string | null;
  normalizeStatusLine: (value: string) => string | null;
  shouldStop?: () => boolean;
  onFailure: (failure: NamingAttemptFailure) => void;
}): Promise<{ result: GeneratedSessionMetadata | null; attemptCount: number; selectedModelId: string | null }> {
  // Walk the caller's setting-then-session candidates only. Cursor Grok (and
  // other non-schema models) often return unusable JSON; the next candidate
  // still gets a turn. ADE already holds the transcript excerpt.
  return runNamingAcrossProviders<GeneratedSessionMetadata>(args.candidateModelIds, {
    shouldStop: args.shouldStop,
    run: async (descriptor) => {
      const result = await args.runPrompt({
        cwd: args.cwd,
        modelId: descriptor.id,
        prompt: args.prompt,
        systemPrompt: SESSION_METADATA_SYSTEM_PROMPT,
        jsonSchema: SESSION_METADATA_JSON_SCHEMA,
      });
      const parserArgs = {
        normalizeTitle: args.normalizeTitle,
        normalizeStatusLine: args.normalizeStatusLine,
      };
      return parseGeneratedSessionMetadata({ raw: result.structuredOutput, ...parserArgs })
        ?? parseGeneratedSessionMetadata({ raw: result.text, ...parserArgs });
    },
    onFailure: args.onFailure,
  });
}

/**
 * Failures that condemn every model behind a provider — a missing or unusable
 * CLI, an account that cannot run the model, auth, or quota. Retrying a sibling
 * model on the same provider just burns another spawn, so naming skips ahead to
 * a different provider instead.
 *
 * "not supported with/when" covers the account-rejects-this-model 400
 * ("The 'x' model is not supported when using Codex with a ChatGPT account").
 * It deliberately excludes "not supported for/on/by", "model not found", and
 * "does not exist", which describe a single unavailable model or a capability
 * it lacks — those must still retry a sibling model on the same provider.
 */
const PROVIDER_LEVEL_NAMING_FAILURE_PATTERN =
  /enoent|eacces|spawn\b|command not found|no such file|unauthor|unauthenticated|not (?:logged in|authenticated)|\b40[13]\b|api[_ -]?key|credential|not supported (?:with|when)|insufficient|quota|rate limit/i;

export function isProviderLevelNamingFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return PROVIDER_LEVEL_NAMING_FAILURE_PATTERN.test(message);
}

/**
 * Keep a session's own model in the naming pool even when it is missing from
 * the current auth snapshot (OpenCode/Cursor chats can outlive inventory).
 */
export function withSessionModelDescriptors(
  availableModels: ModelDescriptor[],
  modelRefs: Array<string | null | undefined>,
): ModelDescriptor[] {
  const seen = new Set(availableModels.map((entry) => entry.id));
  const extra: ModelDescriptor[] = [];
  for (const ref of modelRefs) {
    const modelId = typeof ref === "string" ? ref.trim() : "";
    if (!modelId || seen.has(modelId)) continue;
    const descriptor = resolveModelDescriptor(modelId);
    if (!descriptor || seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    extra.push(descriptor);
  }
  return extra.length ? [...availableModels, ...extra] : availableModels;
}

const MAX_NAMING_ATTEMPTS = 3;

export function buildNamingModelCandidates(args: {
  availableModels: ModelDescriptor[];
  /** Ordered preference list; unavailable and duplicate ids are dropped. */
  preferred: Array<string | null | undefined>;
}): string[] {
  const availableIds = new Set(args.availableModels.map((entry) => entry.id));
  return args.preferred.reduce<string[]>((acc, candidate) => {
    const modelId = typeof candidate === "string" ? candidate.trim() : "";
    if (!modelId || acc.includes(modelId) || !availableIds.has(modelId)) return acc;
    return [...acc, modelId];
  }, []);
}

/**
 * Session intelligence picks a model in this order only: the user's setting,
 * then this session's model. There is no hardcoded Haiku/mini/"first available"
 * namer. Callers fall through to a deterministic title/summary when both miss.
 */
export function buildSessionIntelligenceModelCandidates(args: {
  availableModels: ModelDescriptor[];
  settingModelId?: string | null;
  sessionModelId?: string | null;
  sessionModel?: string | null;
}): string[] {
  const preferred = [args.settingModelId, args.sessionModelId, args.sessionModel];
  return buildNamingModelCandidates({
    availableModels: withSessionModelDescriptors(args.availableModels, preferred),
    preferred,
  });
}

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
    const descriptor = resolveModelDescriptor(candidateModelId);
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
