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
import type { AgentChatSessionMetadataField } from "../../../shared/types/chat";
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

const SESSION_METADATA_JSON_INSTRUCTION =
  `Return strict JSON only with exactly these string fields: {"chatTitle":"...","laneName":"...","statusLine":"..."}.`;

const SESSION_METADATA_TITLE_RULES = `chatTitle — this thread only:
- Name the work done in THIS chat thread. The full conversation transcript is the source of truth.
- A meaningful 2 to ${MAX_NAMING_WORDS} word title for the task, feature, bug, or deliverable.
- Do not start with Completed, Complete, Done, Finished, Resolved, or Success.
- Do not use generic words such as Chat, Session, Status, or Untitled by themselves.
- No quotes, emoji, or trailing punctuation.`;

const SESSION_METADATA_LANE_RULES = `laneName — the durable workstream for the whole lane:
- Combine every thread in this lane with the git work that differs from the remote/base.
- Describe the feature, bug, UI surface, or outcome rather than the act of asking.
- A readable 2 to ${MAX_NAMING_WORDS} word name. No branch prefixes, slash characters, quotes, emoji, or trailing punctuation.`;

const SESSION_METADATA_STATUS_RULES = `statusLine — what is currently being done:
- Derive this only from the latest assistant output (the last two or three paragraphs of what the agent just said or did).
- A concise current progress or outcome line, at most 72 characters and ideally ${MAX_NAMING_WORDS} words or fewer.
- State only what that latest output supports. Never invent a completion, blocker, test result, or decision.
- No quotes, emoji, or trailing punctuation.`;

export const SESSION_METADATA_SYSTEM_PROMPT = `You name the visible metadata for a software development chat in ADE.
${SESSION_METADATA_JSON_INSTRUCTION}
Always fill all three fields. Current metadata is context only; the user's explicit regenerate choice permits replacing it.

${SESSION_METADATA_TITLE_RULES}

${SESSION_METADATA_LANE_RULES}

${SESSION_METADATA_STATUS_RULES}`;

export type SessionMetadataPromptNeeds = {
  title: boolean;
  laneName: boolean;
  statusLine: boolean;
};

/** Which prompt sources to gather and send for this regenerate request. */
export function sessionMetadataPromptNeeds(
  fields?: readonly AgentChatSessionMetadataField[] | null,
): SessionMetadataPromptNeeds {
  const requested = fields ?? [];
  if (!requested.length) {
    return { title: true, laneName: true, statusLine: true };
  }
  return {
    title: requested.includes("title"),
    laneName: requested.includes("laneName"),
    statusLine: requested.includes("statusLine"),
  };
}

export function buildSessionMetadataSystemPrompt(
  fields?: readonly AgentChatSessionMetadataField[] | null,
): string {
  const needs = sessionMetadataPromptNeeds(fields);
  if (needs.title && needs.laneName && needs.statusLine) {
    return SESSION_METADATA_SYSTEM_PROMPT;
  }

  const write: string[] = [];
  const copy: string[] = [];
  if (needs.title) write.push("chatTitle");
  else copy.push("chatTitle");
  if (needs.laneName) write.push("laneName");
  else copy.push("laneName");
  if (needs.statusLine) write.push("statusLine");
  else copy.push("statusLine");

  const intro = needs.statusLine && !needs.title && !needs.laneName
    ? [
      "You write a short status line for a software development chat in ADE.",
      "Users scan many threads at once and need to see what this agent just did.",
    ].join("\n")
    : "You name the visible metadata for a software development chat in ADE.";

  return [
    intro,
    SESSION_METADATA_JSON_INSTRUCTION,
    [
      write.length ? `Write new values for: ${write.join(", ")}.` : null,
      copy.length ? `Copy these current values unchanged: ${copy.join(", ")}.` : null,
    ].filter(Boolean).join(" "),
    needs.title ? SESSION_METADATA_TITLE_RULES : null,
    needs.laneName ? SESSION_METADATA_LANE_RULES : null,
    needs.statusLine ? SESSION_METADATA_STATUS_RULES : null,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

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

export const SESSION_METADATA_TRANSCRIPT_CHAR_LIMIT = 64_000;
export const SESSION_METADATA_ASSISTANT_TAIL_CHAR_LIMIT = 6_000;
export const SESSION_METADATA_LANE_WORK_CHAR_LIMIT = 8_000;

export type SessionMetadataConversationEntry = {
  role: "user" | "assistant";
  text: string;
};

export type SessionMetadataLaneThread = {
  title: string;
  statusNote?: string | null;
  summary?: string | null;
  isCurrent?: boolean;
};

/** Keep the newest tail of a large blob so latest work survives the prompt cap. */
export function clipFromEnd(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `…(earlier omitted)\n${trimmed.slice(trimmed.length - maxChars)}`;
}

export function formatConversationTranscript(
  entries: SessionMetadataConversationEntry[],
): string {
  return entries
    .filter((entry) => entry.text.trim())
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text.trim()}`)
    .join("\n");
}

/**
 * Status lines should come from the last two or three paragraphs of the
 * agent's most recent output — what is currently being done — not from the
 * kickoff prompt or a sibling thread.
 */
export function takeLastParagraphs(text: string, count = 3): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const paragraphs = trimmed.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    return clipFromEnd(paragraphs.slice(-count).join("\n\n"), SESSION_METADATA_ASSISTANT_TAIL_CHAR_LIMIT);
  }
  const lines = trimmed.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2) {
    return clipFromEnd(lines.slice(-Math.max(count, 3)).join("\n"), SESSION_METADATA_ASSISTANT_TAIL_CHAR_LIMIT);
  }
  return clipFromEnd(trimmed, SESSION_METADATA_ASSISTANT_TAIL_CHAR_LIMIT);
}

export function extractLatestAssistantParagraphs(
  entries: SessionMetadataConversationEntry[],
  paragraphCount = 3,
): string {
  const lastAssistant = [...entries].reverse().find((entry) => entry.role === "assistant" && entry.text.trim());
  return lastAssistant ? takeLastParagraphs(lastAssistant.text, paragraphCount) : "";
}

export function formatLaneThreadsForPrompt(threads: SessionMetadataLaneThread[]): string {
  if (!threads.length) return "";
  return threads.map((thread) => {
    const tag = thread.isCurrent ? " (this thread)" : "";
    const lines = [`- ${thread.title.trim() || "Untitled"}${tag}`];
    const status = thread.statusNote?.trim();
    const summary = thread.summary?.trim();
    if (status) lines.push(`  status: ${status}`);
    if (summary) lines.push(`  summary: ${clipFromEnd(summary, 240)}`);
    return lines.join("\n");
  }).join("\n");
}

export function formatLaneWorkVersusRemote(args: {
  baseRef: string;
  commits?: string | null;
  changedFiles?: string | null;
  uncommitted?: string | null;
}): string {
  const commits = args.commits?.trim() || "";
  const changedFiles = args.changedFiles?.trim() || "";
  const uncommitted = args.uncommitted?.trim() || "";
  if (!commits && !changedFiles && !uncommitted) return "";
  return clipFromEnd(
    [
      `Compared to ${args.baseRef}:`,
      commits ? `Commits:\n${commits}` : null,
      changedFiles ? `Changed files:\n${changedFiles}` : null,
      uncommitted ? `Uncommitted:\n${uncommitted}` : null,
    ].filter((line): line is string => Boolean(line)).join("\n\n"),
    SESSION_METADATA_LANE_WORK_CHAR_LIMIT,
  );
}

export function buildSessionMetadataPrompt(args: {
  provider: string;
  chatModel?: string | null;
  currentLaneName?: string | null;
  currentChatTitle?: string | null;
  currentStatusLine?: string | null;
  worktreeName?: string | null;
  requestedFields?: readonly AgentChatSessionMetadataField[] | null;
  goal?: string | null;
  summary?: string | null;
  latestOutputPreview?: string | null;
  originalRequest?: string | null;
  threadTranscript?: string | null;
  latestAssistantParagraphs?: string | null;
  laneThreads?: string | null;
  laneWorkVersusRemote?: string | null;
}): string {
  const needs = sessionMetadataPromptNeeds(args.requestedFields);
  const requested = args.requestedFields ?? [];
  const statusSource = args.latestAssistantParagraphs?.trim() || args.latestOutputPreview?.trim() || "";

  if (needs.statusLine && !needs.title && !needs.laneName) {
    const recent = statusSource;
    return [
      "This is a long-running coding thread in ADE.",
      "Users manage many threads at once and need a short status line for what this agent has just done.",
      args.currentLaneName?.trim() ? `Lane name: ${args.currentLaneName.trim()}` : null,
      args.worktreeName?.trim() ? `Worktree: ${args.worktreeName.trim()}` : null,
      args.currentChatTitle?.trim() ? `Chat title: ${args.currentChatTitle.trim()}` : null,
      args.currentStatusLine?.trim() ? `Current status line: ${args.currentStatusLine.trim()}` : null,
      recent
        ? `Latest assistant output (what the agent has done in the last couple of minutes):\n${recent}`
        : null,
      "Write a short statusLine from that recent output only. Repeat the current chatTitle and laneName unchanged.",
    ].filter((line): line is string => Boolean(line && line.trim().length)).join("\n\n");
  }

  const copyFields: string[] = [];
  if (!needs.title) copyFields.push("chatTitle");
  if (!needs.laneName) copyFields.push("laneName");
  if (!needs.statusLine) copyFields.push("statusLine");

  return [
    "The user explicitly asked ADE to refresh the selected session metadata.",
    "Produce all three JSON fields in one response, even when only some fields will be applied.",
    requested.length ? `Fields the user asked to apply: ${requested.join(", ")}` : null,
    copyFields.length
      ? `Repeat these current values unchanged: ${copyFields.join(", ")}.`
      : null,
    `Provider: ${args.provider}`,
    `Chat model: ${args.chatModel ?? ""}`,
    `Current lane name: ${args.currentLaneName ?? ""}`,
    `Current chat title: ${args.currentChatTitle ?? ""}`,
    args.currentStatusLine ? `Current status line: ${args.currentStatusLine}` : null,
    needs.title && args.goal ? `Chat goal: ${args.goal}` : null,
    needs.title && args.summary ? `Existing summary: ${args.summary}` : null,
    needs.title && args.originalRequest ? `Original request: ${args.originalRequest}` : null,
    needs.title && args.threadTranscript
      ? `This thread's full conversation (source for chatTitle):\n${args.threadTranscript}`
      : null,
    needs.statusLine && statusSource
      ? `Latest assistant output (source for statusLine — last 2-3 paragraphs of what is currently being done):\n${statusSource}`
      : null,
    needs.laneName && args.laneThreads
      ? `Other threads in this lane (source for laneName, together with git work):\n${args.laneThreads}`
      : null,
    needs.laneName && args.laneWorkVersusRemote
      ? `Work on this lane that differs from remote (source for laneName):\n${args.laneWorkVersusRemote}`
      : null,
  ].filter((line): line is string => Boolean(line && line.trim().length)).join("\n\n");
}

export async function runSessionMetadataGeneration(args: {
  candidateModelIds: string[];
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  runPrompt: SessionMetadataPromptRunner;
  normalizeTitle: (value: string) => string | null;
  normalizeStatusLine: (value: string) => string | null;
  shouldStop?: () => boolean;
  onFailure: (failure: NamingAttemptFailure) => void;
}): Promise<{ result: GeneratedSessionMetadata | null; attemptCount: number; selectedModelId: string | null }> {
  // Walk the caller's setting-then-session candidates only. Cursor Grok (and
  // other non-schema models) often return unusable JSON; the next candidate
  // still gets a turn. ADE already holds the transcript excerpt.
  const systemPrompt = args.systemPrompt ?? SESSION_METADATA_SYSTEM_PROMPT;
  return runNamingAcrossProviders<GeneratedSessionMetadata>(args.candidateModelIds, {
    shouldStop: args.shouldStop,
    run: async (descriptor) => {
      const result = await args.runPrompt({
        cwd: args.cwd,
        modelId: descriptor.id,
        prompt: args.prompt,
        systemPrompt,
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
    if (!modelId) return acc;
    // Aliases like Claude's stored `sonnet` must match the canonical registry
    // id that withSessionModelDescriptors already added to the pool.
    const canonicalId = resolveModelDescriptor(modelId)?.id ?? modelId;
    if (acc.includes(canonicalId) || !availableIds.has(canonicalId)) return acc;
    return [...acc, canonicalId];
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
