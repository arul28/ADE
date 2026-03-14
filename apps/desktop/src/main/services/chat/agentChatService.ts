import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  generateText,
  streamText,
  stepCountIs,
  type FilePart,
  type ImagePart,
  type LanguageModel,
  type ModelMessage,
  type UserContent,
} from "ai";
import { query as claudeQuery, unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import type { Query as ClaudeSDKQuery, SDKMessage, Options as ClaudeSDKOptions, PermissionResult as ClaudePermissionResult } from "@anthropic-ai/claude-agent-sdk";

type ClaudeV2Session = {
  send: (msg: string) => Promise<void>;
  stream: () => AsyncGenerator<SDKMessage, void>;
  close: () => void;
  readonly sessionId: string;
};
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createPackService } from "../packs/packService";
import { runGit } from "../git/git";
import { nowIso, fileSizeOrZero } from "../shared/utils";
import type { EpisodicSummaryService } from "../memory/episodicSummaryService";
import {
  createDefaultComputerUsePolicy,
  normalizeComputerUsePolicy,
} from "../../../shared/types";
import type {
  AgentChatApprovalDecision,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
  AgentChatExecutionMode,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatIdentityKey,
  AgentChatInterruptArgs,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatSendArgs,
  AgentChatUpdateSessionArgs,
  ComputerUsePolicy,
  TerminalSessionStatus,
  TerminalToolType,
  CtoCapabilityMode,
} from "../../../shared/types";
import {
  getDefaultModelDescriptor,
  getModelById,
  getAvailableModels as getRegistryModels,
  listModelDescriptorsForProvider,
  MODEL_REGISTRY,
  resolveModelAlias,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { canSwitchChatSessionModel } from "../../../shared/chatModelSwitching";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";
import { createUniversalToolSet, type PermissionMode } from "../ai/tools/universalTools";
import { createWorkflowTools } from "../ai/tools/workflowTools";
import { buildCodingAgentSystemPrompt, composeSystemPrompt } from "../ai/tools/systemPrompt";
import { resolveClaudeCliModel } from "../ai/claudeModelUtils";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { createMemoryService } from "../memory/memoryService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createPrService } from "../prs/prService";
import type { ComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { resolveAdeMcpServerLaunch } from "../orchestrator/unifiedOrchestratorAdapter";

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type ClaudeToolPermissionResult = {
  behavior: "allow" | "deny";
  message?: string;
  interrupt?: boolean;
};

type PersistedClaudeMessage = {
  role: "user" | "assistant";
  content: string;
};

type PersistedChatState = {
  version: 1;
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: string;
  sessionProfile?: "light" | "workflow";
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  permissionMode?: AgentChatSession["permissionMode"];
  identityKey?: AgentChatIdentityKey;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  threadId?: string;
  sdkSessionId?: string;
  messages?: PersistedClaudeMessage[];
  updatedAt: string;
};

type PendingRpc = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type PendingCodexApproval = {
  requestId: string | number;
  kind: "command" | "file_change";
};

type PendingClaudeApproval = {
  resolve: (decision: AgentChatApprovalDecision) => void;
};

type CodexRuntime = {
  kind: "codex";
  process: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  suppressExitError: boolean;
  nextRequestId: number;
  pending: Map<string, PendingRpc>;
  approvals: Map<string, PendingCodexApproval>;
  activeTurnId: string | null;
  startedTurnId: string | null;
  threadResumed: boolean;
  commandOutputByItemId: Map<string, string>;
  fileDeltaByItemId: Map<string, string>;
  fileChangesByItemId: Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  sendResponse: (id: string | number, result: unknown) => void;
  sendError: (id: string | number, message: string) => void;
  slashCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  rateLimits: { remaining: number | null; limit: number | null; resetAt: string | null } | null;
};

type ClaudeRuntime = {
  kind: "claude";
  sdkSessionId: string | null;
  activeQuery: import("@anthropic-ai/claude-agent-sdk").Query | null;
  v2Session: ClaudeV2Session | null;
  /** Single stream generator kept alive across turns (never closed by for-await). */
  v2StreamGen: AsyncGenerator<any, void> | null;
  /** Resolves when the subprocess is initialized (system:init received). */
  v2WarmupDone: Promise<void> | null;
  /** Set to true when teardown runs to cancel an in-flight warmup. */
  v2WarmupCancelled: boolean;
  activeSubagents: Map<string, { taskId: string; description: string }>;
  slashCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  busy: boolean;
  activeTurnId: string | null;
  pendingSteers: string[];
  approvals: Map<string, PendingClaudeApproval>;
  interrupted: boolean;
};

type PendingUnifiedApproval = {
  category: "bash" | "write" | "askUser";
  resolve: (response: { decision: AgentChatApprovalDecision; responseText?: string | null }) => void;
};

type UnifiedRuntime = {
  kind: "unified";
  messages: Array<{ role: string; content: string }>;
  busy: boolean;
  abortController: AbortController | null;
  activeTurnId: string | null;
  permissionMode: PermissionMode;
  pendingApprovals: Map<string, PendingUnifiedApproval>;
  approvalOverrides: Set<"bash" | "write">;
  pendingSteers: string[];
  interrupted: boolean;
  resolvedModel: LanguageModel;
  modelDescriptor: ModelDescriptor;
};

type ChatRuntime = CodexRuntime | ClaudeRuntime | UnifiedRuntime;

type ManagedChatSession = {
  session: AgentChatSession;
  transcriptPath: string;
  transcriptBytesWritten: number;
  transcriptLimitReached: boolean;
  metadataPath: string;
  laneWorktreePath: string;
  runtime: ChatRuntime | null;
  preview: string | null;
  closed: boolean;
  endedNotified: boolean;
  ctoSessionStartedAt: string | null;
  pendingReconstructionContext: string | null;
  autoTitleSeed: string | null;
  autoTitleStage: "none" | "initial" | "final";
  autoTitleInFlight: boolean;
  lastActivitySignature: string | null;
  bufferedReasoning: {
    text: string;
    turnId?: string;
    itemId?: string;
    summaryIndex?: number;
  } | null;
  previewTextBuffer: {
    text: string;
    turnId?: string;
    itemId?: string;
  } | null;
  recentConversationEntries: Array<{
    role: "user" | "assistant";
    text: string;
    turnId?: string;
  }>;
};

type SessionTurnCollector = {
  resolve: (value: {
    sessionId: string;
    provider: AgentChatProvider;
    model: string;
    modelId?: string;
    outputText: string;
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheCreationTokens?: number | null;
    };
    turnId?: string;
    threadId?: string;
    sdkSessionId?: string | null;
  }) => void;
  reject: (error: Error) => void;
  outputText: string;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  };
  lastError: string | null;
  timeout: NodeJS.Timeout;
};

const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
  ".c": "text/x-c",
  ".cc": "text/x-c++src",
  ".cpp": "text/x-c++src",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".go": "text/x-go",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/jsx",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rustsrc",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

type ResolvedChatConfig = {
  codexApprovalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  codexSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode: "plan" | "acceptEdits" | "bypassPermissions";
  unifiedPermissionMode: PermissionMode;
  sessionBudgetUsd: number | null;
  autoTitleEnabled: boolean;
  autoTitleModelId: string | null;
  autoTitleRefreshOnComplete: boolean;
  summaryEnabled: boolean;
  summaryModelId: string | null;
};

const DEFAULT_CODEX_DESCRIPTOR = getDefaultModelDescriptor("codex");
const DEFAULT_CLAUDE_DESCRIPTOR = getDefaultModelDescriptor("claude");
const DEFAULT_UNIFIED_DESCRIPTOR = getDefaultModelDescriptor("unified");
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_DESCRIPTOR?.sdkModelId ?? "gpt-5.4";
const DEFAULT_CLAUDE_MODEL = DEFAULT_CLAUDE_DESCRIPTOR?.sdkModelId ?? DEFAULT_CLAUDE_DESCRIPTOR?.shortId ?? "sonnet";
const DEFAULT_UNIFIED_MODEL_ID = DEFAULT_UNIFIED_DESCRIPTOR?.id ?? "anthropic/claude-sonnet-4-6-api";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_AUTO_TITLE_MODEL_ID = "anthropic/claude-haiku-4-5-api";
const MAX_CHAT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const CHAT_TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n";
const AUTO_TITLE_MAX_CHARS = 48;
const REASONING_ACTIVITY_DETAIL = "Thinking through the answer";
const WORKING_ACTIVITY_DETAIL = "Preparing response";
const TURN_TIMEOUT_MS = 300_000; // 5 minutes – overall turn-level timeout
const AUTO_TITLE_SYSTEM_PROMPT = `You title software development chat sessions.
Return only the title text.
- Use 2 to 6 words.
- Focus on the task, feature, bug, or deliverable.
- Never start with Completed, Complete, Done, Finished, Resolved, or Success.
- No quotes.
- No emoji.
- No trailing punctuation.`;
const CODEX_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Fastest turn-around with shallow reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and speed." },
  { effort: "high", description: "Deeper reasoning for multi-step implementation." },
  { effort: "xhigh", description: "Extra-high reasoning depth for complex tasks." }
];

const CLAUDE_REASONING_EFFORTS: Array<{ effort: string; description: string }> = [
  { effort: "low", description: "Quick responses with minimal reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and speed." },
  { effort: "high", description: "Deep reasoning for complex tasks." },
];

const CLAUDE_EFFORT_TO_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

const KNOWN_CLAUDE_EFFORTS = new Set(CLAUDE_REASONING_EFFORTS.map((e) => e.effort));

const CODEX_FALLBACK_MODELS: AgentChatModelInfo[] = listModelDescriptorsForProvider("codex").map((descriptor) => ({
  id: descriptor.sdkModelId,
  displayName: descriptor.displayName,
  description: describeCodexModel(descriptor.displayName),
  isDefault: descriptor.id === DEFAULT_CODEX_DESCRIPTOR?.id,
  reasoningEfforts: descriptor.reasoningTiers?.length
    ? CODEX_REASONING_EFFORTS.filter((effort) => descriptor.reasoningTiers?.includes(effort.effort))
    : CODEX_REASONING_EFFORTS,
}));

const CLAUDE_FALLBACK_MODELS: AgentChatModelInfo[] = listModelDescriptorsForProvider("claude").map((descriptor) => ({
  id: descriptor.sdkModelId,
  displayName: descriptor.displayName,
  description: describeClaudeModel(descriptor.displayName),
  isDefault: descriptor.id === DEFAULT_CLAUDE_DESCRIPTOR?.id,
  reasoningEfforts: descriptor.capabilities.reasoning && descriptor.reasoningTiers?.length
    ? CLAUDE_REASONING_EFFORTS.filter((effort) => descriptor.reasoningTiers?.includes(effort.effort))
    : [],
  maxThinkingTokens: descriptor.capabilities.reasoning ? CLAUDE_EFFORT_TO_TOKENS.high : null,
}));

function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function resolveSessionModelDescriptor(session: AgentChatSession): ModelDescriptor | null {
  if (session.modelId) {
    return getModelById(session.modelId) ?? resolveModelAlias(session.modelId) ?? null;
  }

  if (session.provider === "claude") {
    const resolvedClaudeModel = resolveClaudeCliModel(session.model);
    return listModelDescriptorsForProvider("claude").find((descriptor) =>
      descriptor.sdkModelId === resolvedClaudeModel
      || descriptor.shortId === session.model
      || descriptor.id === session.model,
    ) ?? null;
  }

  if (session.provider === "codex") {
    return listModelDescriptorsForProvider("codex").find((descriptor) =>
      descriptor.sdkModelId === session.model
      || descriptor.shortId === session.model
      || descriptor.id === session.model,
    ) ?? null;
  }

  return getModelById(session.model) ?? resolveModelAlias(session.model) ?? null;
}

function sessionSupportsReasoning(session: AgentChatSession): boolean {
  return resolveSessionModelDescriptor(session)?.capabilities.reasoning ?? true;
}

function normalizeUsagePayload(
  value: unknown
): { inputTokens?: number | null; outputTokens?: number | null } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    promptTokens?: unknown;
    completionTokens?: unknown;
  };
  const inputTokens = typeof payload.inputTokens === "number"
    ? payload.inputTokens
    : typeof payload.promptTokens === "number"
      ? payload.promptTokens
      : null;
  const outputTokens = typeof payload.outputTokens === "number"
    ? payload.outputTokens
    : typeof payload.completionTokens === "number"
      ? payload.completionTokens
      : null;

  if (inputTokens == null && outputTokens == null) return undefined;
  return { inputTokens, outputTokens };
}

const KNOWN_CODEX_EFFORTS = new Set(CODEX_REASONING_EFFORTS.map((e) => e.effort));

const EFFORT_ALIASES: Record<string, Record<string, string>> = {
  codex: { minimal: "low", max: "xhigh", none: "low" },
  claude: { max: "high" },
};

function validateReasoningEffort(provider: "codex" | "claude", effort: string | null | undefined): string | null {
  if (!effort) return null;
  const aliased = EFFORT_ALIASES[provider]?.[effort] ?? effort;
  const known = provider === "codex" ? KNOWN_CODEX_EFFORTS : KNOWN_CLAUDE_EFFORTS;
  const fallback = provider === "codex" ? DEFAULT_REASONING_EFFORT : "medium";
  return known.has(aliased) ? aliased : fallback;
}

function describeClaudeModel(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (lower.includes("opus")) return "Highest capability for complex strategy and review.";
  if (lower.includes("sonnet")) return "Balanced quality and speed for everyday work.";
  if (lower.includes("haiku")) return "Fastest Claude variant for lightweight tasks.";
  return null;
}

function describeCodexModel(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (lower.includes("spark")) return "Low-latency Codex variant tuned for fast iteration.";
  if (lower.includes("mini")) return "Lightweight Codex model for quick edits and checks.";
  if (lower.includes("max")) return "High-context Codex variant for large refactors.";
  if (lower.includes("codex")) return "Default Codex coding model for implementation-heavy work.";
  return null;
}

function isChatToolType(toolType: TerminalToolType | null | undefined): toolType is "codex-chat" | "claude-chat" | "ai-chat" {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function providerFromToolType(toolType: TerminalToolType | null | undefined): AgentChatProvider {
  if (toolType === "ai-chat") return "unified";
  return toolType === "claude-chat" ? "claude" : "codex";
}

function toolTypeFromProvider(provider: AgentChatProvider): "codex-chat" | "claude-chat" | "ai-chat" {
  if (provider === "unified") return "ai-chat";
  return provider === "claude" ? "claude-chat" : "codex-chat";
}

function mapTerminalStatusToChatStatus(status: TerminalSessionStatus): AgentChatSession["status"] {
  if (status === "running") return "idle";
  return "ended";
}

function mapCommandStatus(raw: string | null | undefined): "running" | "completed" | "failed" {
  if (raw === "completed") return "completed";
  if (raw === "failed" || raw === "declined") return "failed";
  return "running";
}

function mapFileChangeKind(raw: unknown): "create" | "modify" | "delete" {
  const type = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
      ? String((raw as { type?: unknown }).type)
      : "update";
  if (type === "add") return "create";
  if (type === "delete") return "delete";
  return "modify";
}

function mapCodexTurnStatus(raw: unknown): "completed" | "interrupted" | "failed" {
  const value = typeof raw === "string" ? raw : "";
  if (value === "interrupted") return "interrupted";
  if (value === "failed") return "failed";
  return "completed";
}

function formatCodexErrorInfo(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapApprovalDecisionForCodex(decision: AgentChatApprovalDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "accept_for_session") return "acceptForSession";
  if (decision === "accept") return "accept";
  if (decision === "cancel") return "cancel";
  return "decline";
}

function isPlanningApprovalGuarded(managed: ManagedChatSession): boolean {
  return managed.session.permissionMode === "plan";
}

function buildPlanningApprovalViolation(toolName: string): string {
  return `PLANNER CONTRACT VIOLATION: '${toolName}' requested a provider-native approval flow during a planning step. Planning workers must stay inspect-only and return the plan via report_result instead.`;
}

function normalizePreview(text: string, maxChars = 220): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const preview = lines[lines.length - 1] ?? "";
  return preview.length > maxChars ? preview.slice(0, maxChars) : preview;
}

const REJECTED_TITLES = new Set([
  "completed", "complete", "done", "finished", "resolved",
  "success", "session closed", "chat completed"
]);

const GENERIC_REMAINDER_TOKENS = new Set([
  "ok", "okay", "yes", "no", "true", "false",
  "ready", "response", "reply", "result", "output", "pass", "passed"
]);

function sanitizeAutoTitle(raw: string, maxChars = AUTO_TITLE_MAX_CHARS): string | null {
  const normalized = raw
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N})\]]+$/gu, "")
    .trim();
  if (!normalized.length) return null;

  const collapsed = normalized.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (REJECTED_TITLES.has(collapsed)) return null;

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const allGeneric = remainderTokens.every((token) => GENERIC_REMAINDER_TOKENS.has(token));
    if (!remainderTokens.length || remainderTokens.length <= 2 || allGeneric) {
      return null;
    }
  }

  if (/^(session closed|chat completed)\b/u.test(collapsed)) return null;

  return normalized.length > maxChars ? normalized.slice(0, maxChars).trimEnd() : normalized;
}

function defaultChatSessionTitle(provider: AgentChatProvider): string {
  if (provider === "codex") return "Codex Chat";
  if (provider === "claude") return "Claude Chat";
  return "AI Chat";
}

function hasCustomChatSessionTitle(title: string | null | undefined, provider: AgentChatProvider): boolean {
  const normalized = String(title ?? "").trim();
  return normalized.length > 0 && normalized !== defaultChatSessionTitle(provider);
}

function resumeCommandForProvider(provider: AgentChatProvider, sessionId: string): string {
  if (provider === "codex") return "chat:codex";
  if (provider === "unified") return `chat:unified:${sessionId}`;
  return `chat:claude:${sessionId}`;
}

function parseJsonLine(raw: string): JsonRpcEnvelope | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

function resolveModelIdFromStoredValue(
  model: string,
  providerHint?: AgentChatProvider,
): string | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized.length) return undefined;

  const aliasMatch = resolveModelAlias(normalized);
  if (aliasMatch) {
    if (providerHint === "codex" && !(aliasMatch.family === "openai" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "claude" && !(aliasMatch.family === "anthropic" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "unified" && aliasMatch.isCliWrapped) return undefined;
    return aliasMatch.id;
  }

  const matches = MODEL_REGISTRY.filter(
    (entry) =>
      entry.id.toLowerCase() === normalized
      || entry.shortId.toLowerCase() === normalized
      || entry.sdkModelId.toLowerCase() === normalized
  );
  if (!matches.length) return undefined;

  let preferred: ModelDescriptor | undefined;
  if (providerHint === "codex") {
    preferred = matches.find((entry) => entry.isCliWrapped && entry.family === "openai");
  } else if (providerHint === "claude") {
    preferred = matches.find((entry) => entry.isCliWrapped && entry.family === "anthropic");
  } else if (providerHint === "unified") {
    preferred = matches.find((entry) => !entry.isCliWrapped);
  }

  return preferred?.id ?? matches[0]?.id;
}

function fallbackModelForProvider(provider: AgentChatProvider): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "claude") return DEFAULT_CLAUDE_MODEL;
  return DEFAULT_UNIFIED_MODEL_ID;
}

function inferAttachmentMediaType(attachment: AgentChatFileRef): string {
  const ext = path.extname(attachment.path).toLowerCase();
  return ATTACHMENT_MEDIA_TYPES[ext]
    ?? (attachment.type === "image" ? "image/png" : "application/octet-stream");
}

function readProviderParentItemId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const claudeMeta = record["claude-code"];
  if (claudeMeta && typeof claudeMeta === "object") {
    const parentToolCallId = (claudeMeta as Record<string, unknown>).parentToolCallId;
    if (typeof parentToolCallId === "string" && parentToolCallId.trim().length) {
      return parentToolCallId.trim();
    }
  }
  return undefined;
}

function buildStreamingUserContent(
  args: {
    baseText: string;
    attachments: AgentChatFileRef[];
    runtimeKind: "claude" | "unified";
    modelDescriptor?: ModelDescriptor;
  },
): UserContent {
  if (!args.attachments.length) {
    return args.baseText;
  }

  const parts: Array<{ type: "text"; text: string } | ImagePart | FilePart> = [
    { type: "text", text: args.baseText },
  ];

  for (const attachment of args.attachments) {
    const resolvedPath = path.resolve(attachment.path);
    if (!fs.existsSync(resolvedPath)) {
      parts.push({ type: "text", text: `\nAttachment missing: ${attachment.path}` });
      continue;
    }

    try {
      const data = fs.readFileSync(resolvedPath);
      const mediaType = inferAttachmentMediaType(attachment);

      if (attachment.type === "image") {
        if (args.runtimeKind === "claude" || args.modelDescriptor?.capabilities.vision) {
          parts.push({
            type: "image",
            image: data,
            mediaType,
          });
        } else {
          parts.push({
            type: "text",
            text: `\nImage attached but the selected model does not advertise vision support: ${attachment.path}`,
          });
        }
        continue;
      }

      if (args.runtimeKind === "unified") {
        parts.push({
          type: "file",
          data,
          filename: path.basename(resolvedPath) || undefined,
          mediaType,
        });
        continue;
      }

      parts.push({
        type: "text",
        text: `\nAttached file: ${attachment.path}`,
      });
    } catch (error) {
      parts.push({
        type: "text",
        text: `\nAttachment unavailable: ${attachment.path}${error instanceof Error ? ` (${error.message})` : ""}`,
      });
    }
  }

  return parts;
}

function buildExecutionModeDirective(
  mode: AgentChatExecutionMode | null | undefined,
  provider: AgentChatProvider,
): string | null {
  if (!mode || mode === "focused") return null;

  if (provider === "codex" && mode === "parallel") {
    return [
      "[ADE launch directive]",
      "Use Codex parallel delegation for independent subtasks when it improves latency or coverage.",
      "Split bounded work into parallel subagents, keep each delegate narrowly scoped, then reconcile results before the final answer.",
      "If the task is tightly coupled, stay focused instead of forcing delegation.",
    ].join("\n");
  }

  return null;
}

function composeLaunchDirectives(baseText: string, directives: Array<string | null | undefined>): string {
  const filtered = directives
    .map((directive) => (typeof directive === "string" ? directive.trim() : ""))
    .filter((directive) => directive.length > 0);
  if (filtered.length === 0) return baseText;
  return `${filtered.join("\n\n")}\n\nUser request:\n${baseText}`;
}

function buildComputerUseDirective(policy: ComputerUsePolicy | null | undefined): string | null {
  const effective = createDefaultComputerUsePolicy(policy ?? undefined);
  if (effective.mode === "off") {
    return [
      "[ADE computer-use policy]",
      "Computer use is OFF for this chat session.",
      "Do not call ADE or external computer-use tools, do not request screenshots/videos/traces, and do not capture new computer-use proof in this session.",
    ].join("\n");
  }

  const lines = [
    "[ADE computer-use policy]",
    effective.mode === "enabled"
      ? "Computer use is explicitly ENABLED for this chat session."
      : "Computer use is available in AUTO mode for this chat session.",
    "External tools perform computer use. ADE should ingest and manage the resulting proof artifacts.",
    "Prefer approved external backends first and use ADE-local computer-use only as fallback compatibility support when explicitly allowed.",
    effective.retainArtifacts
      ? "If computer use produces screenshots, videos, traces, verification output, or logs, ingest and retain those artifacts in ADE."
      : "If computer use is used, keep retained proof to the minimum necessary for the task.",
  ];
  if (!effective.allowLocalFallback) {
    lines.push("Do not use ADE-local fallback computer-use tools in this chat.");
  }
  if (effective.preferredBackend) {
    lines.push(`Preferred backend: ${effective.preferredBackend}.`);
  }
  return lines.join("\n");
}

function activityForToolName(
  toolName: string,
): { activity: Extract<AgentChatEvent, { type: "activity" }>["activity"]; detail: string } {
  const normalized = toolName.trim();
  const lower = normalized.toLowerCase();
  if (!normalized.length) return { activity: "tool_calling", detail: "Running tool" };
  if (lower === "bash" || lower === "exec_command" || lower === "bashoutput") {
    return { activity: "running_command", detail: normalized };
  }
  if (lower.includes("edit") || lower.includes("write") || lower === "apply_patch") {
    return { activity: "editing_file", detail: normalized };
  }
  if (lower.includes("search") || lower === "grep" || lower === "glob") {
    return { activity: "searching", detail: normalized };
  }
  if (
    lower.includes("read")
    || lower === "listdir"
    || lower === "gitstatus"
    || lower === "gitdiff"
    || lower === "gitlog"
  ) {
    return { activity: "reading", detail: normalized };
  }
  return { activity: "tool_calling", detail: normalized };
}

// Permission mapping functions are shared with the orchestrator/mission system.
// Delegate to the single source of truth in permissionMapping.ts.
import {
  mapPermissionToClaude,
  mapPermissionToCodex
} from "../orchestrator/permissionMapping";

/** Spread-ready codex policy args (approvalPolicy + sandbox) or empty object if null. */
function codexPolicyArgs(policy: ReturnType<typeof mapPermissionToCodex>): Record<string, string> {
  return policy ? { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox } : {};
}

function mapToUnifiedPermissionMode(mode: string | undefined): PermissionMode | undefined {
  if (mode === "default" || mode === "config-toml") return "edit";
  if (mode === "plan" || mode === "edit" || mode === "full-auto") return mode;
  return undefined;
}

const PLAN_STEP_STATUS_MAP: Record<string, "pending" | "in_progress" | "completed" | "failed"> = {
  completed: "completed",
  inProgress: "in_progress",
  failed: "failed",
};

const VALID_PERMISSION_MODES = new Set(["default", "plan", "edit", "full-auto", "config-toml"]);
const VALID_EXECUTION_MODES = new Set(["focused", "parallel", "subagents", "teams"]);

function normalizePersistedPermissionMode(value: unknown): AgentChatSession["permissionMode"] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VALID_PERMISSION_MODES.has(trimmed) ? trimmed as AgentChatSession["permissionMode"] : undefined;
}

function normalizePersistedExecutionMode(value: unknown): AgentChatExecutionMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VALID_EXECUTION_MODES.has(trimmed) ? trimmed as AgentChatExecutionMode : undefined;
}

function normalizePersistedComputerUse(value: unknown): ComputerUsePolicy {
  return normalizeComputerUsePolicy(value, createDefaultComputerUsePolicy());
}

function normalizeIdentityKey(value: unknown): AgentChatIdentityKey | undefined {
  if (value === "cto") return "cto";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("agent:")) return undefined;
  const agentId = trimmed.slice("agent:".length).trim();
  return agentId.length > 0 ? `agent:${agentId}` : undefined;
}

function resolveWorkerIdentityAgentId(identityKey: AgentChatIdentityKey | undefined): string | null {
  if (!identityKey || identityKey === "cto") return null;
  const match = /^agent:(.+)$/.exec(identityKey);
  const agentId = match?.[1]?.trim() ?? "";
  return agentId.length > 0 ? agentId : null;
}

function normalizeCapabilityMode(value: unknown): CtoCapabilityMode | undefined {
  if (value === "full_mcp" || value === "fallback") {
    return value;
  }
  return undefined;
}

function normalizeSessionProfile(value: unknown): "light" | "workflow" | undefined {
  if (value === "light" || value === "workflow") return value;
  if (value === "agent") return "workflow";
  return undefined;
}

function inferCapabilityMode(provider: AgentChatProvider): CtoCapabilityMode {
  return provider === "codex" || provider === "claude" ? "full_mcp" : "fallback";
}

function guardedIdentityPermissionModeForProvider(provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return provider === "claude" ? "default" : "edit";
}

function normalizeIdentityPermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
): AgentChatSession["permissionMode"] {
  return mode === "full-auto" ? "full-auto" : guardedIdentityPermissionModeForProvider(provider);
}

function isLightweightSession(session: Pick<AgentChatSession, "sessionProfile">): boolean {
  return session.sessionProfile === "light";
}

let _mcpRuntimeRootCache: string | null = null;
function resolveMcpRuntimeRoot(): string {
  if (_mcpRuntimeRootCache !== null) return _mcpRuntimeRootCache;
  const startPoints = [process.cwd(), __dirname];
  for (const start of startPoints) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i += 1) {
      if (fs.existsSync(path.join(dir, "apps", "mcp-server", "package.json"))) {
        _mcpRuntimeRootCache = dir;
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  _mcpRuntimeRootCache = process.cwd();
  return _mcpRuntimeRootCache;
}


export function createAgentChatService(args: {
  projectRoot: string;
  adeDir?: string;
  transcriptsDir: string;
  projectId?: string;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  packService?: ReturnType<typeof createPackService> | null;
  episodicSummaryService?: EpisodicSummaryService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  prService?: ReturnType<typeof createPrService> | null;
  computerUseArtifactBrokerService?: ComputerUseArtifactBrokerService | null;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  logger: Logger;
  appVersion: string;
  onEvent?: (event: AgentChatEventEnvelope) => void;
  onSessionEnded?: (args: { laneId: string; sessionId: string; exitCode: number | null }) => void;
}) {
  const {
    projectRoot,
    transcriptsDir,
    projectId,
    memoryService,
    packService,
    episodicSummaryService,
    ctoStateService,
    workerAgentService,
    prService,
    computerUseArtifactBrokerService,
    laneService,
    sessionService,
    projectConfigService,
    logger,
    appVersion,
    onEvent,
    onSessionEnded
  } = args;

  let computerUseArtifactBrokerRef = computerUseArtifactBrokerService ?? null;

  const layout = resolveAdeLayout(projectRoot);
  const chatSessionsDir = layout.chatSessionsDir;
  const chatTranscriptsDir = layout.chatTranscriptsDir;
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(chatTranscriptsDir, { recursive: true });

  const managedSessions = new Map<string, ManagedChatSession>();
  const sessionTurnCollectors = new Map<string, SessionTurnCollector>();

  const buildAdeMcpServers = (
    provider: "claude" | "codex",
    defaultRole: "agent" | "cto",
    ownerId?: string | null,
  ): Record<string, Record<string, unknown>> => {
    const launch = resolveAdeMcpServerLaunch({
      workspaceRoot: projectRoot,
      runtimeRoot: resolveMcpRuntimeRoot(),
      defaultRole,
      ownerId: ownerId ?? undefined,
    });
    return providerResolver.normalizeCliMcpServers(provider, {
      ade: {
        command: launch.command,
        args: launch.cmdArgs,
        env: launch.env
      }
    }) ?? {};
  };

  const readTranscriptConversationEntries = (managed: ManagedChatSession): string[] => {
    try {
      const raw = fs.readFileSync(managed.transcriptPath, "utf8");
      return parseAgentChatTranscript(raw)
        .filter((entry) => entry.sessionId === managed.session.id)
        .flatMap((entry) => {
          if (entry.event.type === "user_message") {
            const text = entry.event.text.trim();
            return text.length ? [`User: ${text}`] : [];
          }
          if (entry.event.type === "text") {
            const text = entry.event.text.trim();
            return text.length ? [`Assistant: ${text}`] : [];
          }
          return [];
        });
    } catch {
      return [];
    }
  };

  const buildRecentConversationContext = (managed: ManagedChatSession, limit = 6): string => {
    const liveEntries = managed.recentConversationEntries.map((entry) =>
      `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`,
    );
    const combined: string[] = [];
    for (const entry of [...readTranscriptConversationEntries(managed), ...liveEntries]) {
      if (!entry.trim().length) continue;
      if (combined[combined.length - 1] === entry) continue;
      combined.push(entry);
    }
    return combined.slice(-limit).join("\n");
  };

  const appendRecentConversationEntry = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    if (event.type !== "user_message" && event.type !== "text") return;
    const text = event.text.trim();
    if (!text.length) return;

    const role = event.type === "user_message" ? "user" : "assistant";
    const turnId = "turnId" in event ? event.turnId : undefined;
    const lastEntry = managed.recentConversationEntries[managed.recentConversationEntries.length - 1];
    if (role === "assistant" && lastEntry?.role === "assistant" && lastEntry.turnId === turnId) {
      lastEntry.text = `${lastEntry.text}${text}`.trim();
      return;
    }

    managed.recentConversationEntries.push({ role, text, turnId });
    if (managed.recentConversationEntries.length > 12) {
      managed.recentConversationEntries.splice(0, managed.recentConversationEntries.length - 12);
    }
  };

  const refreshReconstructionContext = (
    managed: ManagedChatSession,
    options?: { includeConversationTail?: boolean },
  ): void => {
    const sections: string[] = [];

    if (managed.session.identityKey === "cto" && ctoStateService) {
      sections.push(ctoStateService.buildReconstructionContext(8));
    } else {
      const workerAgentId = resolveWorkerIdentityAgentId(managed.session.identityKey);
      if (workerAgentId && workerAgentService) {
        sections.push(workerAgentService.buildReconstructionContext(workerAgentId, 8));
      }
    }

    if (options?.includeConversationTail) {
      const recentConversation = buildRecentConversationContext(managed);
      if (recentConversation.length) {
        sections.push(["Recent Conversation Tail", recentConversation].join("\n"));
      }
    }

    const nextContext = sections.map((section) => section.trim()).filter((section) => section.length > 0).join("\n\n");
    managed.pendingReconstructionContext = nextContext.length ? nextContext : null;
  };

  const applyReconstructionContextToStreamingRuntime = (
    managed: ManagedChatSession,
    runtime: UnifiedRuntime
  ): void => {
    const context = managed.pendingReconstructionContext?.trim() ?? "";
    if (!context.length) return;
    runtime.messages.push({
      role: "user",
      content: [
        "System context (identity reconstruction, do not echo verbatim):",
        context
      ].join("\n")
    });
    managed.pendingReconstructionContext = null;
    persistChatState(managed);
  };

  const detectAuth = async () => {
    const snapshot = projectConfigService.get();
    const configured = snapshot.effective.ai?.apiKeys;
    const configApiKeys: Record<string, string> = {};
    if (configured && typeof configured === "object") {
      for (const [provider, value] of Object.entries(configured as Record<string, unknown>)) {
        const key = typeof value === "string" ? value.trim() : "";
        if (!key.length) continue;
        configApiKeys[String(provider).trim().toLowerCase()] = key;
      }
    }
    return detectAllAuth(configApiKeys);
  };

  const setManagedSessionTitle = (managed: ManagedChatSession, rawTitle: string): string | null => {
    const title = sanitizeAutoTitle(rawTitle);
    if (!title) return null;

    const currentTitle = sessionService.get(managed.session.id)?.title ?? null;
    if (currentTitle?.trim() === title) return title;

    sessionService.updateMeta({ sessionId: managed.session.id, title });

    // Sync title to Codex thread if applicable
    if (managed.session.provider === "codex" && managed.session.threadId && managed.runtime?.kind === "codex") {
      managed.runtime.request("thread/name/set", {
        threadId: managed.session.threadId,
        name: title,
      }).catch(() => { /* thread/name/set not supported — ignore */ });
    }

    return title;
  };

  const maybeAutoTitleSession = async (
    managed: ManagedChatSession,
    args: { stage: "initial" | "final"; latestUserText?: string | null; summary?: string | null }
  ): Promise<void> => {
    const config = resolveChatConfig();
    if (!config.autoTitleEnabled) return;
    if (managed.autoTitleInFlight) return;
    if (args.stage === "initial" && managed.autoTitleStage !== "none") return;
    if (args.stage === "final") {
      if (!config.autoTitleRefreshOnComplete) return;
      if (managed.autoTitleStage === "final") return;
    }

    const seed = sanitizeAutoTitle(args.latestUserText ?? managed.autoTitleSeed ?? "", 180);
    if (!seed) return;

    const auth = await detectAuth();
    const availableModels = getRegistryModels(auth).filter((descriptor) => !descriptor.deprecated);
    if (!availableModels.length) return;

    const preferredModelId =
      [
        config.autoTitleModelId,
        DEFAULT_AUTO_TITLE_MODEL_ID,
        "anthropic/claude-haiku-4-5",
        "openai/codex-mini-latest",
        "openai/gpt-4.1-mini",
        "openai/gpt-5.4",
        availableModels[0]?.id,
      ].find((candidate) => {
        const modelId = typeof candidate === "string" ? candidate.trim() : "";
        return modelId.length > 0 && availableModels.some((descriptor) => descriptor.id === modelId);
      }) ?? null;

    if (!preferredModelId) return;

    const descriptor = getModelById(preferredModelId);
    if (!descriptor) return;

    const laneName = sessionService.get(managed.session.id)?.laneName ?? "Current lane";
    const currentTitle = sessionService.get(managed.session.id)?.title ?? null;
    const titleContext = [
      `Lane: ${laneName}`,
      `Model: ${getModelById(managed.session.modelId ?? "")?.displayName ?? managed.session.model}`,
      `Primary request: ${seed}`,
      args.summary?.trim().length
        ? `Latest outcome: ${args.summary.trim()}`
        : managed.preview?.trim().length
          ? `Latest output: ${managed.preview.trim()}`
          : null,
      hasCustomChatSessionTitle(currentTitle, managed.session.provider)
        ? `Current title: ${String(currentTitle).trim()}`
        : null,
    ].filter((line): line is string => Boolean(line && line.trim().length));

    managed.autoTitleInFlight = true;
    try {
      const resolvedModel = await providerResolver.resolveModel(descriptor.id, auth, {
        cwd: managed.laneWorktreePath,
        middleware: false,
      });
      const result = await generateText({
        model: resolvedModel,
        system: AUTO_TITLE_SYSTEM_PROMPT,
        prompt: [
          args.stage === "final"
            ? "Write a final concise title for this completed coding chat."
            : "Write a concise title for this new coding chat.",
          titleContext.join("\n"),
        ].join("\n\n"),
      });
      const nextTitle = setManagedSessionTitle(managed, result.text);
      if (!nextTitle) return;
      managed.autoTitleStage = args.stage;
    } catch (error) {
      logger.warn("agent_chat.auto_title_failed", {
        sessionId: managed.session.id,
        stage: args.stage,
        modelId: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      managed.autoTitleInFlight = false;
    }
  };

  // Unified session support — for API-key / local models using streamText + universal tools.
  // CLI-wrapped models fall through to the existing Claude/Codex runtimes.
  const startUnifiedSession = async (managed: ManagedChatSession): Promise<"handled" | "fallthrough"> => {
    const modelId = managed.session.modelId;
    if (!modelId) return "fallthrough";

    const descriptor = getModelById(modelId);
    if (!descriptor) return "fallthrough";

    // CLI-wrapped models -> defer to CLI session runtimes.
    if (descriptor.isCliWrapped) return "fallthrough";

    logger.info("agent_chat.unified_session_starting", {
      sessionId: managed.session.id,
      modelId,
      family: descriptor.family,
    });

    const auth = await detectAuth();
    const resolvedModel = await providerResolver.resolveModel(modelId, auth, {
      cwd: managed.laneWorktreePath,
    });

    const chatConfig = resolveChatConfig();
    const permMode: PermissionMode = mapToUnifiedPermissionMode(managed.session.permissionMode)
      ?? chatConfig.unifiedPermissionMode;

    const runtime: UnifiedRuntime = {
      kind: "unified",
      messages: [],
      busy: false,
      abortController: null,
      activeTurnId: null,
      permissionMode: permMode,
      pendingApprovals: new Map(),
      approvalOverrides: new Set(),
      pendingSteers: [],
      interrupted: false,
      resolvedModel,
      modelDescriptor: descriptor,
    };

    managed.runtime = runtime;
    managed.session.provider = "unified";
    managed.session.capabilityMode = "fallback";
    return "handled";
  };

  const resolveChatConfig = (): ResolvedChatConfig => {
    const snapshot = projectConfigService.get();
    const ai = snapshot.effective.ai ?? {};
    const permissions = ai.permissions ?? {};
    const chat = ai.chat ?? {};
    const si = ai.sessionIntelligence;
    const cliMode = permissions.cli?.mode ?? "edit";
    const inProcessMode = permissions.inProcess?.mode ?? "edit";

    const approvalPolicy = (() => {
      if (chat.defaultApprovalPolicy === "auto") return "never" as const;
      if (chat.defaultApprovalPolicy === "approve_all") return "untrusted" as const;
      if (chat.defaultApprovalPolicy === "approve_mutations") return "on-request" as const;
      if (cliMode === "full-auto") return "never" as const;
      if (cliMode === "read-only") return "untrusted" as const;
      return "on-request" as const;
    })();

    const sandboxMode = (() => {
      if (chat.codexSandbox) return chat.codexSandbox;
      if (permissions.cli?.sandboxPermissions) return permissions.cli.sandboxPermissions;
      return "workspace-write" as const;
    })();

    const claudePermissionMode = (() => {
      if (chat.claudePermissionMode) return chat.claudePermissionMode;
      if (cliMode === "read-only") return "plan" as const;
      if (cliMode === "full-auto") return "bypassPermissions" as const;
      return "acceptEdits" as const;
    })();

    const unifiedPermissionMode = (() => {
      if (chat.unifiedPermissionMode === "plan" || chat.unifiedPermissionMode === "edit" || chat.unifiedPermissionMode === "full-auto") {
        return chat.unifiedPermissionMode;
      }
      if (inProcessMode === "plan" || inProcessMode === "edit" || inProcessMode === "full-auto") {
        return inProcessMode;
      }
      if (claudePermissionMode === "bypassPermissions") return "full-auto" as const;
      if (claudePermissionMode === "plan") return "plan" as const;
      return "edit" as const;
    })();

    const budget = Number(chat.sessionBudgetUsd ?? permissions.cli?.maxBudgetUsd ?? NaN);
    const sessionBudgetUsd = Number.isFinite(budget) && budget > 0 ? budget : null;

    // Unified sessionIntelligence.titles.* with legacy chat.autoTitle* fallback
    const autoTitleEnabled = si?.titles?.enabled ?? chat.autoTitleEnabled ?? true;
    const autoTitleModelIdRaw = si?.titles?.modelId ?? chat.autoTitleModelId;
    const autoTitleModelId = typeof autoTitleModelIdRaw === "string" && autoTitleModelIdRaw.trim().length
      ? autoTitleModelIdRaw.trim()
      : null;
    const autoTitleRefreshOnComplete = si?.titles?.refreshOnComplete ?? chat.autoTitleRefreshOnComplete ?? true;

    // Unified sessionIntelligence.summaries.*
    const summaryEnabled = si?.summaries?.enabled ?? true;
    const summaryModelIdRaw = si?.summaries?.modelId;
    const summaryModelId = typeof summaryModelIdRaw === "string" && summaryModelIdRaw.trim().length
      ? summaryModelIdRaw.trim()
      : null;

    return {
      codexApprovalPolicy: approvalPolicy,
      codexSandboxMode: sandboxMode,
      claudePermissionMode,
      unifiedPermissionMode,
      sessionBudgetUsd,
      autoTitleEnabled,
      autoTitleModelId,
      autoTitleRefreshOnComplete,
      summaryEnabled,
      summaryModelId,
    };
  };

  const computeHeadShaBestEffort = async (laneId: string): Promise<string | null> => {
    const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const cwd = fs.existsSync(worktreePath) ? worktreePath : projectRoot;
    const res = await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

  const metadataPathFor = (sessionId: string): string => path.join(chatSessionsDir, `${sessionId}.json`);

  const persistChatState = (managed: ManagedChatSession): void => {
    const payload: PersistedChatState = {
      version: 1,
      sessionId: managed.session.id,
      laneId: managed.session.laneId,
      provider: managed.session.provider,
      model: managed.session.model,
      ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      ...(managed.session.sessionProfile ? { sessionProfile: managed.session.sessionProfile } : {}),
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      ...(managed.session.executionMode ? { executionMode: managed.session.executionMode } : {}),
      ...(managed.session.permissionMode ? { permissionMode: managed.session.permissionMode } : {}),
      ...(managed.session.identityKey ? { identityKey: managed.session.identityKey } : {}),
      ...(managed.session.capabilityMode ? { capabilityMode: managed.session.capabilityMode } : {}),
      ...(managed.session.computerUse ? { computerUse: managed.session.computerUse } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "claude" ? { sdkSessionId: managed.runtime.sdkSessionId ?? undefined } : {}),
      ...(managed.runtime?.kind === "unified"
        ? { messages: managed.runtime.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })) }
        : {}),
      updatedAt: nowIso()
    };

    try {
      fs.mkdirSync(path.dirname(managed.metadataPath), { recursive: true });
      fs.writeFileSync(managed.metadataPath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      logger.warn("agent_chat.persist_failed", {
        sessionId: managed.session.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const readPersistedState = (sessionId: string): PersistedChatState | null => {
    const filePath = metadataPathFor(sessionId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Partial<PersistedChatState>;
      if (record.version !== 1) return null;
      const provider = record.provider;
      if (provider !== "codex" && provider !== "claude" && provider !== "unified") return null;
      const laneId = String(record.laneId ?? "").trim();
      const model = String(record.model ?? "").trim();
      const modelId = typeof record.modelId === "string" && record.modelId.trim().length
        ? (getModelById(record.modelId.trim()) ? record.modelId.trim() : undefined)
        : resolveModelIdFromStoredValue(model, provider);
      const sessionProfile = normalizeSessionProfile(record.sessionProfile);
      const reasoningEffort = normalizeReasoningEffort(record.reasoningEffort);
      const executionMode = normalizePersistedExecutionMode(record.executionMode);
      const permissionMode = normalizePersistedPermissionMode(record.permissionMode);
      const identityKey = normalizeIdentityKey(record.identityKey);
      const capabilityMode = normalizeCapabilityMode(record.capabilityMode);
      const computerUse = normalizePersistedComputerUse(record.computerUse);
      if (!laneId || !model) return null;
      const messages = Array.isArray(record.messages)
        ? record.messages
            .filter((entry): entry is PersistedClaudeMessage => {
              if (!entry || typeof entry !== "object") return false;
              const role = (entry as { role?: unknown }).role;
              const content = (entry as { content?: unknown }).content;
              return (role === "user" || role === "assistant") && typeof content === "string";
            })
        : undefined;
      const sdkSessionId = typeof record.sdkSessionId === "string" && record.sdkSessionId.trim().length ? record.sdkSessionId.trim() : undefined;
      return {
        version: 1,
        sessionId,
        laneId,
        provider,
        model,
        ...(modelId ? { modelId } : {}),
        ...(sessionProfile ? { sessionProfile } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        ...(capabilityMode ? { capabilityMode } : {}),
        ...(computerUse ? { computerUse } : {}),
        ...(typeof record.threadId === "string" && record.threadId.trim().length
          ? { threadId: record.threadId.trim() }
          : {}),
        ...(sdkSessionId ? { sdkSessionId } : {}),
        ...(messages?.length ? { messages } : {}),
        updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length ? record.updatedAt : nowIso()
      };
    } catch {
      return null;
    }
  };

  const writeTranscript = (managed: ManagedChatSession, envelope: AgentChatEventEnvelope): void => {
    if (managed.transcriptLimitReached) return;
    try {
      fs.mkdirSync(path.dirname(managed.transcriptPath), { recursive: true });
      const rawLine = `${JSON.stringify(envelope)}\n`;
      const chunk = Buffer.from(rawLine, "utf8");
      const remaining = MAX_CHAT_TRANSCRIPT_BYTES - managed.transcriptBytesWritten;
      if (remaining <= 0) {
        managed.transcriptLimitReached = true;
        void fs.promises.appendFile(managed.transcriptPath, CHAT_TRANSCRIPT_LIMIT_NOTICE, "utf8").catch(() => {});
        return;
      }
      let toWrite = chunk;
      if (chunk.length > remaining) {
        toWrite = chunk.subarray(0, remaining);
        managed.transcriptLimitReached = true;
      }
      managed.transcriptBytesWritten += toWrite.length;
      void fs.promises.appendFile(managed.transcriptPath, toWrite).then(async () => {
        if (!managed.transcriptLimitReached) return;
        await fs.promises.appendFile(managed.transcriptPath, CHAT_TRANSCRIPT_LIMIT_NOTICE, "utf8");
      }).catch(() => {
        // ignore transcript write failures
      });
    } catch {
      // ignore transcript write failures
    }

    // Also write to the dedicated transcript cache directory for persistence
    writeChatTranscriptLine(managed.session.id, envelope);
  };

  const writeChatTranscriptLine = (sessionId: string, envelope: AgentChatEventEnvelope): void => {
    try {
      const transcriptFile = path.join(chatTranscriptsDir, `${sessionId}.jsonl`);
      const line = `${JSON.stringify(envelope)}\n`;
      void fs.promises.appendFile(transcriptFile, line, "utf8").catch(() => {});
    } catch {
      // ignore chat transcript write failures
    }
  };

  const setSessionPreview = (managed: ManagedChatSession, candidate: string): void => {
    const next = normalizePreview(candidate);
    if (!next) return;
    if (next === managed.preview) return;
    managed.preview = next;
    sessionService.setLastOutputPreview(managed.session.id, next);
  };

  const clipText = (value: string, maxChars: number): string => {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  };

  const appendWorkerActivityToCto = (managed: ManagedChatSession, input: {
    activityType: "chat_turn" | "worker_run";
    summary: string;
    taskKey?: string | null;
    issueKey?: string | null;
  }): void => {
    const workerAgentId = resolveWorkerIdentityAgentId(managed.session.identityKey);
    if (!workerAgentId || !workerAgentService || !ctoStateService) return;
    try {
      const worker = workerAgentService.getAgent(workerAgentId, { includeDeleted: true });
      ctoStateService.appendSubordinateActivity({
        agentId: workerAgentId,
        agentName: worker?.name?.trim() || workerAgentId,
        activityType: input.activityType,
        summary: clipText(input.summary, 360),
        sessionId: managed.session.id,
        taskKey: input.taskKey ?? null,
        issueKey: input.issueKey ?? null,
      });
    } catch (error) {
      logger.warn("agent_chat.worker_activity_append_failed", {
        sessionId: managed.session.id,
        workerAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const updatePreviewFromText = (
    managed: ManagedChatSession,
    event: Extract<AgentChatEvent, { type: "text" }>,
  ): void => {
    const buffered = managed.previewTextBuffer;
    const sameChunk = buffered
      && (buffered.turnId ?? null) === (event.turnId ?? null)
      && (buffered.itemId ?? null) === (event.itemId ?? null);

    if (sameChunk) {
      buffered.text += event.text;
      setSessionPreview(managed, buffered.text);
      return;
    }

    managed.previewTextBuffer = {
      text: event.text,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
    };
    setSessionPreview(managed, event.text);
  };

  const commitChatEvent = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    managed.session.lastActivityAt = nowIso();
    appendRecentConversationEntry(managed, event);

    if (event.type === "text") {
      updatePreviewFromText(managed, event);
    } else if (event.type === "command") {
      setSessionPreview(managed, event.output);
    } else if (event.type === "error") {
      setSessionPreview(managed, event.message);
    }

    if (event.type === "done") {
      const preview = managed.preview?.trim() ?? "";
      const summary = preview.length
        ? (event.status === "completed" ? preview : `${event.status}: ${preview}`)
        : (event.status === "completed" ? "Response ready" : `Turn ${event.status}`);
      sessionService.setSummary(managed.session.id, summary);
    }

    const envelope: AgentChatEventEnvelope = {
      sessionId: managed.session.id,
      timestamp: nowIso(),
      event
    };

    writeTranscript(managed, envelope);
    onEvent?.(envelope);

    const collector = sessionTurnCollectors.get(managed.session.id);
    if (!collector) return;

    if (event.type === "text") {
      collector.outputText += event.text;
      return;
    }

    if (event.type === "error") {
      collector.lastError = event.message;
      return;
    }

    if (event.type === "status" && event.turnStatus === "failed" && event.message) {
      collector.lastError = event.message;
      return;
    }

    if (event.type !== "done") return;

    collector.usage = event.usage;
    clearTimeout(collector.timeout);
    sessionTurnCollectors.delete(managed.session.id);
    collector.resolve({
      sessionId: managed.session.id,
      provider: managed.session.provider,
      model: managed.session.model,
      ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      outputText: collector.outputText.trim() || managed.preview?.trim() || "",
      ...(collector.usage ? { usage: collector.usage } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "claude" ? { sdkSessionId: managed.runtime.sdkSessionId ?? null } : {}),
    });
  };

  const flushBufferedReasoning = (managed: ManagedChatSession): void => {
    const buffered = managed.bufferedReasoning;
    if (!buffered) return;
    managed.bufferedReasoning = null;
    commitChatEvent(managed, {
      type: "reasoning",
      text: buffered.text,
      ...(buffered.turnId ? { turnId: buffered.turnId } : {}),
      ...(buffered.itemId ? { itemId: buffered.itemId } : {}),
      ...(typeof buffered.summaryIndex === "number" ? { summaryIndex: buffered.summaryIndex } : {}),
    });
  };

  const queueReasoningEvent = (
    managed: ManagedChatSession,
    event: Extract<AgentChatEvent, { type: "reasoning" }>,
  ): void => {
    // Stream reasoning deltas immediately so the renderer can surface live
    // progress instead of waiting for a later non-reasoning event to flush.
    // The renderer already collapses adjacent reasoning fragments by turn.
    commitChatEvent(managed, event);
  };

  const emitChatEvent = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    if (event.type === "reasoning") {
      queueReasoningEvent(managed, event);
      return;
    }

    if (event.type === "activity") {
      const signature = `${event.turnId ?? ""}:${event.activity}:${event.detail ?? ""}`;
      if (signature === managed.lastActivitySignature) {
        return;
      }
      flushBufferedReasoning(managed);
      managed.lastActivitySignature = signature;
      commitChatEvent(managed, event);
      return;
    }

    flushBufferedReasoning(managed);

    if (
      event.type === "user_message"
      || event.type === "status"
      || event.type === "done"
      || event.type === "step_boundary"
      || event.type === "error"
    ) {
      managed.lastActivitySignature = null;
    }

    commitChatEvent(managed, event);
  };

  /** Tear down the active runtime, releasing all resources and cancelling pending approvals. */
  const teardownRuntime = (managed: ManagedChatSession): void => {
    flushBufferedReasoning(managed);
    if (managed.runtime?.kind === "codex") {
      managed.runtime.suppressExitError = true;
      try { managed.runtime.reader.close(); } catch { /* ignore */ }
      try { managed.runtime.process.kill(); } catch { /* ignore */ }
      managed.runtime.pending.clear();
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "claude") {
      managed.runtime.v2WarmupCancelled = true;
      managed.runtime.activeQuery?.close();
      managed.runtime.activeQuery = null;
      try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
      managed.runtime.v2Session = null;
      managed.runtime.v2StreamGen = null;
      managed.runtime.v2WarmupDone = null;
      managed.runtime.activeSubagents.clear();
      for (const pending of managed.runtime.approvals.values()) {
        pending.resolve("cancel");
      }
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "unified") {
      managed.runtime.abortController?.abort();
      for (const pending of managed.runtime.pendingApprovals.values()) {
        pending.resolve({ decision: "cancel" });
      }
      managed.runtime.pendingApprovals.clear();
      managed.runtime = null;
    }
  };

  const maybeGenerateSessionSummary = async (
    managed: ManagedChatSession,
    deterministicSummary: string | null
  ): Promise<void> => {
    const config = resolveChatConfig();
    if (!config.summaryEnabled) return;

    // Set the deterministic summary first (always available immediately)
    const session = sessionService.get(managed.session.id);
    if (!session) return;

    const deterministicText = deterministicSummary?.trim() || managed.preview?.trim() || null;
    if (deterministicText && !session.summary) {
      sessionService.setSummary(managed.session.id, deterministicText);
    }

    // Fire-and-forget AI summary enhancement
    const auth = await detectAuth();
    const availableModels = getRegistryModels(auth).filter((d) => !d.deprecated);
    if (!availableModels.length) return;

    const preferredModelId =
      [
        config.summaryModelId,
        DEFAULT_AUTO_TITLE_MODEL_ID,
        "anthropic/claude-haiku-4-5",
        "openai/codex-mini-latest",
        availableModels[0]?.id,
      ].find((candidate) => {
        const modelId = typeof candidate === "string" ? candidate.trim() : "";
        return modelId.length > 0 && availableModels.some((d) => d.id === modelId);
      }) ?? null;

    if (!preferredModelId) return;
    const descriptor = getModelById(preferredModelId);
    if (!descriptor) return;

    const baseSummary = session.summary ?? deterministicText ?? "";
    const prompt = [
      "You are ADE's session summary assistant.",
      "Rewrite this chat session into a concise 1-3 sentence summary describing what was accomplished and any outcome.",
      "Do not invent actions or outcomes not mentioned. Return only the summary text.",
      "",
      `Session title: ${session.title}`,
      session.goal ? `Goal: ${session.goal}` : null,
      baseSummary ? `Current summary: ${baseSummary}` : null,
      session.lastOutputPreview ? `Latest output: ${session.lastOutputPreview}` : null,
    ].filter(Boolean).join("\n");

    try {
      const resolvedModel = await providerResolver.resolveModel(descriptor.id, auth, {
        cwd: managed.laneWorktreePath,
        middleware: false,
      });
      const result = await generateText({
        model: resolvedModel,
        prompt,
      });
      const text = result.text.trim();
      if (text.length) {
        sessionService.setSummary(managed.session.id, text);
      }
    } catch (error) {
      logger.warn("agent_chat.session_summary_failed", {
        sessionId: managed.session.id,
        modelId: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const finishSession = async (
    managed: ManagedChatSession,
    status: TerminalSessionStatus,
    options?: { exitCode?: number | null; summary?: string | null }
  ): Promise<void> => {
    if (managed.endedNotified) return;
    managed.endedNotified = true;

    if (options?.summary !== undefined) {
      sessionService.setSummary(managed.session.id, options.summary);
    }

    void maybeAutoTitleSession(managed, {
      stage: "final",
      summary: options?.summary ?? managed.preview,
    });

    void maybeGenerateSessionSummary(managed, options?.summary ?? null);

    const endedAt = nowIso();
    sessionService.end({
      sessionId: managed.session.id,
      endedAt,
      exitCode: options?.exitCode ?? null,
      status
    });

    const explicitSummary = typeof options?.summary === "string" ? options.summary.trim() : "";
    const fallbackSummary = managed.preview?.trim() ?? "";
    const sessionLogArgs = {
      sessionId: managed.session.id,
      endedAt,
      provider: managed.session.provider,
      modelId: managed.session.modelId ?? managed.session.model,
      capabilityMode: managed.session.capabilityMode ?? inferCapabilityMode(managed.session.provider),
    };

    if (managed.session.identityKey === "cto" && ctoStateService) {
      try {
        ctoStateService.appendSessionLog({
          ...sessionLogArgs,
          summary: explicitSummary || fallbackSummary || "CTO session ended.",
          startedAt: managed.ctoSessionStartedAt ?? managed.session.createdAt,
        });
      } catch (error) {
        logger.warn("agent_chat.cto_log_append_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      episodicSummaryService?.enqueueSessionSummary({
        sessionId: managed.session.id,
        role: "cto",
        summary: explicitSummary || fallbackSummary || "CTO session ended.",
        startedAt: managed.ctoSessionStartedAt ?? managed.session.createdAt,
        endedAt,
      });
    }
    const workerAgentId = resolveWorkerIdentityAgentId(managed.session.identityKey);
    if (workerAgentId && workerAgentService) {
      try {
        workerAgentService.appendSessionLog(workerAgentId, {
          ...sessionLogArgs,
          summary: explicitSummary || fallbackSummary || "Worker session ended.",
          startedAt: managed.session.createdAt,
        });
      } catch (error) {
        logger.warn("agent_chat.worker_log_append_failed", {
          sessionId: managed.session.id,
          workerAgentId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      episodicSummaryService?.enqueueSessionSummary({
        sessionId: managed.session.id,
        role: "worker",
        summary: explicitSummary || fallbackSummary || "Worker session ended.",
        startedAt: managed.session.createdAt,
        endedAt,
      });
    }

    const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
    if (endSha) {
      sessionService.setHeadShaEnd(managed.session.id, endSha);
    }

    managed.session.status = "ended";
    managed.closed = true;
    managed.ctoSessionStartedAt = null;
    persistChatState(managed);

    teardownRuntime(managed);

    try {
      onSessionEnded?.({ laneId: managed.session.laneId, sessionId: managed.session.id, exitCode: options?.exitCode ?? null });
    } catch {
      // ignore callback failures
    }
  };

  const ensureManagedSession = (sessionId: string): ManagedChatSession => {
    const existing = managedSessions.get(sessionId);
    if (existing) return existing;

    const row = sessionService.get(sessionId);
    if (!row) {
      throw new Error(`Chat session '${sessionId}' was not found.`);
    }
    if (!isChatToolType(row.toolType)) {
      throw new Error(`Session '${sessionId}' is not an agent chat session.`);
    }

    const persisted = readPersistedState(sessionId);
    const provider = persisted?.provider ?? providerFromToolType(row.toolType);
    const fallbackModel = persisted?.model ?? fallbackModelForProvider(provider);
    const hydratedModelId = persisted?.modelId
      ?? resolveModelIdFromStoredValue(fallbackModel, provider)
      ?? (provider === "unified" ? DEFAULT_UNIFIED_MODEL_ID : undefined);
    const model = provider === "unified" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
    const lane = laneService.getLaneBaseAndBranch(row.laneId);

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId: row.laneId,
        provider,
        model,
        ...(hydratedModelId ? { modelId: hydratedModelId } : {}),
        ...(persisted?.sessionProfile ? { sessionProfile: persisted.sessionProfile } : {}),
        reasoningEffort: persisted?.reasoningEffort ?? null,
        executionMode: persisted?.executionMode ?? null,
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        computerUse: normalizePersistedComputerUse(persisted?.computerUse),
        status: mapTerminalStatusToChatStatus(row.status),
        ...(persisted?.threadId ? { threadId: persisted.threadId } : {}),
        createdAt: row.startedAt,
        lastActivityAt: persisted?.updatedAt ?? row.endedAt ?? row.startedAt
      },
      transcriptPath: row.transcriptPath || path.join(transcriptsDir, `${sessionId}.chat.jsonl`),
      transcriptBytesWritten: fileSizeOrZero(row.transcriptPath || path.join(transcriptsDir, `${sessionId}.chat.jsonl`)),
      transcriptLimitReached: false,
      metadataPath: metadataPathFor(sessionId),
      laneWorktreePath: lane.worktreePath,
      runtime: null,
      preview: row.lastOutputPreview ?? null,
      closed: row.status !== "running",
      endedNotified: row.status !== "running",
      ctoSessionStartedAt: row.status === "running" ? row.startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: hasCustomChatSessionTitle(row.title, provider) ? "initial" : "none",
      autoTitleInFlight: false,
      lastActivitySignature: null,
      bufferedReasoning: null,
      previewTextBuffer: null,
      recentConversationEntries: [],
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed);

    managedSessions.set(sessionId, managed);
    return managed;
  };

  const sendCodexMessage = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
    },
  ): Promise<void> => {
    if (!managed.session.threadId) {
      throw new Error(`Codex session '${managed.session.id}' is missing thread id.`);
    }
    if (!managed.runtime || managed.runtime.kind !== "codex") {
      throw new Error(`Codex runtime is not available for session '${managed.session.id}'.`);
    }
    if (managed.runtime.activeTurnId) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }
    const runtime = managed.runtime;
    const attachments = args.attachments ?? [];
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;

    // Intercept /review command — route to review/start RPC instead of turn/start
    if (args.promptText.trim().startsWith("/review")) {
      emitChatEvent(managed, { type: "user_message", text: displayText, attachments });
      const reviewResult = await runtime.request<{ turn?: { id?: string } }>("review/start", {
        threadId: managed.session.threadId,
        target: "uncommittedChanges",
      });
      const reviewTurnId = typeof reviewResult.turn?.id === "string" ? reviewResult.turn.id : null;
      if (reviewTurnId) {
        runtime.activeTurnId = reviewTurnId;
      }
      return;
    }

    const input: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: args.promptText,
        text_elements: []
      }
    ];

    const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
    if (reconstructionContext.length) {
      input.unshift({
        type: "text",
        text: [
          "System context (CTO reconstruction, do not echo verbatim):",
          reconstructionContext
        ].join("\n"),
        text_elements: []
      });
      managed.pendingReconstructionContext = null;
    }

    for (const attachment of attachments) {
      if (attachment.type === "image") {
        input.push({ type: "localImage", path: attachment.path });
        continue;
      }
      const name = path.basename(attachment.path) || attachment.path;
      input.push({ type: "mention", name, path: attachment.path });
    }

    managed.session.status = "active";
    emitChatEvent(managed, { type: "user_message", text: displayText, attachments });

    const result = await managed.runtime.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: managed.session.threadId,
      input,
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {})
    });

    const turnId = typeof result?.turn?.id === "string" ? result.turn.id : null;
    if (turnId) {
      managed.runtime.activeTurnId = turnId;
      if (managed.runtime.startedTurnId !== turnId) {
        const reasoningActivity = sessionSupportsReasoning(managed.session)
          ? { activity: "thinking" as const, detail: REASONING_ACTIVITY_DETAIL }
          : { activity: "working" as const, detail: WORKING_ACTIVITY_DETAIL };
        managed.runtime.startedTurnId = turnId;
        emitChatEvent(managed, {
          type: "status",
          turnStatus: "started",
          turnId,
        });
        emitChatEvent(managed, {
          type: "activity",
          ...reasoningActivity,
          turnId,
        });
      }
    }
    persistChatState(managed);
  };

  // ── Helpers for unified turn logic ──

  const mapReasoningEffortToThinking = (effort: string | null | undefined): import("../../../shared/types").ThinkingLevel | null => {
    if (!effort) return null;
    const map: Record<string, import("../../../shared/types").ThinkingLevel> = {
      none: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
      xhigh: "xhigh",
      extra_high: "max",
    };
    return map[effort] ?? null;
  };

  const classifyUnifiedError = (
    error: unknown,
    providerFamily: string,
    modelDisplayName: string,
  ): {
    message: string;
    errorInfo: { category: "auth" | "rate_limit" | "budget" | "network" | "unknown"; provider?: string; model?: string };
  } => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const lower = rawMessage.toLowerCase();

    const statusCode = (error as { status?: number; statusCode?: number })?.status
      ?? (error as { status?: number; statusCode?: number })?.statusCode
      ?? null;

    if (statusCode === 429 || lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
      return {
        message: `Rate limited by ${providerFamily}. The middleware will retry automatically. If this persists, try a different model.`,
        errorInfo: { category: "rate_limit", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (
      statusCode === 401 || statusCode === 403
      || lower.includes("unauthorized") || lower.includes("forbidden")
      || lower.includes("authentication failed") || lower.includes("invalid api key")
      || lower.includes("api key") || lower.includes("invalid_api_key")
    ) {
      return {
        message: `Authentication failed for ${modelDisplayName}. Check your API key in Settings.`,
        errorInfo: { category: "auth", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (lower.includes("budget") || lower.includes("cost limit") || lower.includes("spending limit")) {
      return {
        message: "Session budget limit reached. Increase budget in Settings or start a new session.",
        errorInfo: { category: "budget", provider: providerFamily, model: modelDisplayName },
      };
    }

    if (
      lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnrefused")
      || lower.includes("enotfound") || lower.includes("network") || lower.includes("fetch failed")
      || lower.includes("econnreset") || lower.includes("socket hang up")
    ) {
      return {
        message: `Connection to ${providerFamily} timed out. Check your network or try again.`,
        errorInfo: { category: "network", provider: providerFamily, model: modelDisplayName },
      };
    }

    return {
      message: rawMessage,
      errorInfo: { category: "unknown", provider: providerFamily, model: modelDisplayName },
    };
  };

  // ── Claude SDK streaming turn ──

  const runClaudeTurn = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
    },
  ): Promise<void> => {
    const runtime = managed.runtime;
    if (runtime?.kind !== "claude") {
      throw new Error(`Claude runtime is not available for session '${managed.session.id}'.`);
    }
    if (runtime.busy) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }

    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";

    const attachments = args.attachments ?? [];
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;

    const attachmentHint = attachments.length
      ? `\n\nAttached context:\n${attachments.map((file) => `- ${file.type}: ${file.path}`).join("\n")}`
      : "";
    const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
    const promptText = [
      reconstructionContext.length
        ? [
            "System context (identity reconstruction, do not echo verbatim):",
            reconstructionContext,
          ].join("\n")
        : null,
      `${args.promptText}${attachmentHint}`,
    ].filter((section): section is string => Boolean(section)).join("\n\n");
    if (reconstructionContext.length) {
      managed.pendingReconstructionContext = null;
      persistChatState(managed);
    }

    emitChatEvent(managed, { type: "user_message", text: displayText, attachments, turnId });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null } | undefined;
    let costUsd: number | null = null;

    try {
      const claudeDescriptor = resolveSessionModelDescriptor(managed.session);
      const claudeSupportsReasoning = claudeDescriptor?.capabilities.reasoning ?? true;

      // ── V2 persistent session with background pre-warming ──
      // The pre-warm was kicked off in ensureClaudeSessionRuntime. Wait for it.
      if (runtime.v2WarmupDone) {
        await runtime.v2WarmupDone;
      }
      // Fallback: if pre-warm failed or didn't run, create session on the fly
      if (!runtime.v2Session) {
        const v2Opts = buildClaudeV2SessionOpts(managed, runtime);
        logger.info("agent_chat.claude_v2_session_create_fallback", {
          sessionId: managed.session.id, model: v2Opts.model,
        });
        if (runtime.sdkSessionId) {
          runtime.v2Session = unstable_v2_resumeSession(runtime.sdkSessionId, v2Opts as any) as unknown as ClaudeV2Session;
        } else {
          runtime.v2Session = unstable_v2_createSession(v2Opts as any) as unknown as ClaudeV2Session;
        }
      }

      // V2 pattern: send() then stream() per turn. Session stays alive between turns.
      await runtime.v2Session.send(promptText);

      // Don't emit a pre-emptive "thinking" activity — wait for actual content from the stream.
      // The renderer will show the turn as "started" (from the status event above) which is sufficient.

      for await (const msg of runtime.v2Session.stream()) {
        if (runtime.interrupted) break;

        // Capture session_id from any message
        if (!runtime.sdkSessionId && (msg as any).session_id) {
          runtime.sdkSessionId = (msg as any).session_id;
          persistChatState(managed);
        }

        // system:init — capture data silently (no UI emission)
        if (msg.type === "system" && (msg as any).subtype === "init") {
          const initMsg = msg as any;
          runtime.sdkSessionId = initMsg.session_id ?? runtime.sdkSessionId;
          if (Array.isArray(initMsg.slash_commands)) {
            runtime.slashCommands = initMsg.slash_commands
              .filter((cmd: unknown) => typeof cmd === "string" && cmd.length > 0)
              .map((cmd: string) => ({ name: cmd.startsWith("/") ? cmd : `/${cmd}`, description: "" }));
          }
          try {
            const sessionImpl = runtime.v2Session as any;
            if (typeof sessionImpl?.supportedCommands === "function") {
              sessionImpl.supportedCommands().then((cmds: any[]) => {
                if (Array.isArray(cmds) && cmds.length > 0) {
                  runtime.slashCommands = cmds.map((c: any) => ({
                    name: typeof c.name === "string" ? (c.name.startsWith("/") ? c.name : `/${c.name}`) : String(c),
                    description: typeof c.description === "string" ? c.description : "",
                    argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : undefined,
                  }));
                }
              }).catch(() => { /* not available */ });
            }
          } catch { /* ignore */ }
          persistChatState(managed);
          continue;
        }

        // system:status — permission mode changes
        if (msg.type === "system" && (msg as any).subtype === "status") {
          const statusMsg = msg as any;
          if (statusMsg.status === "compacting") {
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "info",
              message: "Compacting conversation context...",
              turnId,
            });
          }
          continue;
        }

        // system:compact_boundary — context window compaction
        if (msg.type === "system" && (msg as any).subtype === "compact_boundary") {
          const compactMsg = msg as any;
          emitChatEvent(managed, {
            type: "context_compact",
            trigger: compactMsg.compact_metadata?.trigger === "manual" ? "manual" : "auto",
            preTokens: typeof compactMsg.compact_metadata?.pre_tokens === "number" ? compactMsg.compact_metadata.pre_tokens : undefined,
            turnId,
          });
          continue;
        }

        // system:hook_started / hook_progress / hook_response — hook execution lifecycle
        if (msg.type === "system" && ((msg as any).subtype === "hook_started" || (msg as any).subtype === "hook_progress" || (msg as any).subtype === "hook_response")) {
          const hookMsg = msg as any;
          if (hookMsg.subtype === "hook_started") {
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "hook",
              message: `Hook: ${hookMsg.hook_name ?? hookMsg.hook_event ?? "hook"} started`,
              turnId,
            });
          } else if (hookMsg.subtype === "hook_response") {
            const outcome = hookMsg.outcome ?? (hookMsg.exit_code === 0 ? "passed" : "failed");
            if (outcome !== "passed" && outcome !== "success") {
              emitChatEvent(managed, {
                type: "system_notice",
                noticeKind: "hook",
                message: `Hook: ${hookMsg.hook_name ?? "hook"} ${outcome}`,
                detail: hookMsg.stderr || hookMsg.stdout || undefined,
                turnId,
              });
            }
          }
          // hook_progress is too noisy — skip
          continue;
        }

        // system:files_persisted
        if (msg.type === "system" && (msg as any).subtype === "files_persisted") {
          const fpMsg = msg as any;
          const fileCount = Array.isArray(fpMsg.files) ? fpMsg.files.length : 0;
          const failCount = Array.isArray(fpMsg.failed) ? fpMsg.failed.length : 0;
          if (failCount > 0) {
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "file_persist",
              message: `File persistence: ${fileCount} saved, ${failCount} failed`,
              detail: fpMsg.failed.map((f: any) => `${f.filename}: ${f.error}`).join("; "),
              turnId,
            });
          }
          continue;
        }

        // auth_status — authentication events
        if (msg.type === "auth_status") {
          const authMsg = msg as any;
          if (authMsg.error) {
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "auth",
              message: `Authentication error: ${authMsg.error}`,
              turnId,
            });
          } else if (authMsg.isAuthenticating) {
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "auth",
              message: "Authenticating...",
              turnId,
            });
          }
          continue;
        }

        // system:task_started — subagent spawn
        if (msg.type === "system" && (msg as any).subtype === "task_started") {
          const taskMsg = msg as any;
          const taskId = String(taskMsg.task_id ?? randomUUID());
          runtime.activeSubagents.set(taskId, { taskId, description: String(taskMsg.description ?? "") });
          emitChatEvent(managed, {
            type: "subagent_started",
            taskId,
            description: String(taskMsg.description ?? ""),
            turnId,
          });
          continue;
        }

        // system:task_notification — subagent completed
        if (msg.type === "system" && (msg as any).subtype === "task_notification") {
          const taskMsg = msg as any;
          const taskId = String(taskMsg.task_id ?? "");
          runtime.activeSubagents.delete(taskId);
          emitChatEvent(managed, {
            type: "subagent_result",
            taskId,
            status: taskMsg.status === "completed" ? "completed" : taskMsg.status === "stopped" ? "stopped" : "failed",
            summary: String(taskMsg.summary ?? ""),
            usage: taskMsg.usage ? {
              totalTokens: typeof taskMsg.usage.total_tokens === "number" ? taskMsg.usage.total_tokens : undefined,
              toolUses: typeof taskMsg.usage.tool_uses === "number" ? taskMsg.usage.tool_uses : undefined,
              durationMs: typeof taskMsg.usage.duration_ms === "number" ? taskMsg.usage.duration_ms : undefined,
            } : undefined,
            turnId,
          });
          continue;
        }

        // assistant message — process content blocks
        if (msg.type === "assistant") {
          const assistantMsg = msg as any;
          const betaMessage = assistantMsg.message;
          if (betaMessage?.content && Array.isArray(betaMessage.content)) {
            for (const block of betaMessage.content) {
              if (block.type === "text") {
                assistantText += block.text ?? "";
                emitChatEvent(managed, {
                  type: "text",
                  text: block.text ?? "",
                  turnId,
                });
              } else if (block.type === "thinking") {
                const thinkingText = block.thinking ?? block.text ?? "";
                emitChatEvent(managed, {
                  type: "activity",
                  activity: "thinking",
                  detail: REASONING_ACTIVITY_DETAIL,
                  turnId,
                });
                emitChatEvent(managed, {
                  type: "reasoning",
                  text: thinkingText,
                  turnId,
                });
              } else if (block.type === "tool_use") {
                const toolName = String(block.name ?? "tool");
                const nextActivity = activityForToolName(toolName);
                emitChatEvent(managed, {
                  type: "activity",
                  activity: nextActivity.activity,
                  detail: nextActivity.detail,
                  turnId,
                });
                emitChatEvent(managed, {
                  type: "tool_call",
                  tool: toolName,
                  args: block.input ?? {},
                  itemId: String(block.id ?? randomUUID()),
                  turnId,
                });
              }
            }
          }
          // Extract usage from assistant message stop
          if (betaMessage?.usage) {
            usage = {
              inputTokens: betaMessage.usage.input_tokens ?? null,
              outputTokens: betaMessage.usage.output_tokens ?? null,
            };
          }
          continue;
        }

        // stream_event — partial streaming deltas
        if (msg.type === "stream_event") {
          const streamMsg = msg as any;
          const event = streamMsg.event;
          if (!event) continue;

          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
              const text = delta.text ?? "";
              if (text.length) {
                assistantText += text;
                emitChatEvent(managed, { type: "text", text, turnId });
              }
            } else if (delta?.type === "thinking_delta") {
              const text = delta.thinking ?? delta.text ?? "";
              if (text.length) {
                emitChatEvent(managed, {
                  type: "activity",
                  activity: "thinking",
                  detail: REASONING_ACTIVITY_DETAIL,
                  turnId,
                });
                emitChatEvent(managed, { type: "reasoning", text, turnId });
              }
            } else if (delta?.type === "input_json_delta") {
              // Tool input streaming — just emit activity
              emitChatEvent(managed, {
                type: "activity",
                activity: "tool_calling",
                detail: "Processing tool input",
                turnId,
              });
            }
          } else if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "thinking") {
              emitChatEvent(managed, {
                type: "activity",
                activity: "thinking",
                detail: REASONING_ACTIVITY_DETAIL,
                turnId,
              });
              // Some SDK versions include initial thinking text on block start
              const startText = block.thinking ?? block.text ?? "";
              if (startText.length) {
                emitChatEvent(managed, { type: "reasoning", text: startText, turnId });
              }
            } else if (block?.type === "tool_use") {
              const toolName = String(block.name ?? "tool");
              const nextActivity = activityForToolName(toolName);
              emitChatEvent(managed, {
                type: "activity",
                activity: nextActivity.activity,
                detail: nextActivity.detail,
                turnId,
              });
            }
          } else if (event.type === "message_start") {
            const msgUsage = event.message?.usage;
            if (msgUsage) {
              usage = {
                inputTokens: msgUsage.input_tokens ?? null,
                outputTokens: msgUsage.output_tokens ?? null,
              };
            }
          } else if (event.type === "message_delta") {
            const deltaUsage = event.usage;
            if (deltaUsage) {
              usage = {
                inputTokens: usage?.inputTokens ?? null,
                outputTokens: deltaUsage.output_tokens ?? usage?.outputTokens ?? null,
              };
            }
          }
          continue;
        }

        // tool_progress
        if (msg.type === "tool_progress") {
          const progressMsg = msg as any;
          emitChatEvent(managed, {
            type: "activity",
            activity: "tool_calling",
            detail: `Tool '${progressMsg.tool_name ?? "tool"}' running (${Math.round(progressMsg.elapsed_time_seconds ?? 0)}s)`,
            turnId,
          });
          continue;
        }

        // result — turn complete
        if (msg.type === "result") {
          const resultMsg = msg as any;
          if (resultMsg.usage) {
            usage = {
              inputTokens: resultMsg.usage.input_tokens ?? null,
              outputTokens: resultMsg.usage.output_tokens ?? null,
              cacheReadTokens: resultMsg.usage.cache_read_input_tokens ?? null,
              cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens ?? null,
            };
          }
          if (typeof resultMsg.total_cost_usd === "number") {
            costUsd = resultMsg.total_cost_usd;
          }
          if (resultMsg.is_error && resultMsg.errors?.length) {
            for (const err of resultMsg.errors) {
              emitChatEvent(managed, {
                type: "error",
                message: String(err),
                turnId,
              });
            }
          }
          continue;
        }

        // tool_use_summary — summarizes groups of tool calls
        if ((msg as any).type === "tool_use_summary") {
          const summaryMsg = msg as any;
          emitChatEvent(managed, {
            type: "tool_use_summary",
            summary: String(summaryMsg.summary ?? ""),
            toolUseIds: Array.isArray(summaryMsg.preceding_tool_use_ids) ? summaryMsg.preceding_tool_use_ids.map(String) : [],
            turnId,
          });
          continue;
        }

        // rate_limit — API rate limiting
        if ((msg as any).type === "rate_limit" || (msg as any).subtype === "rate_limit") {
          const rlMsg = msg as any;
          emitChatEvent(managed, {
            type: "system_notice",
            noticeKind: "rate_limit",
            message: `Rate limited${rlMsg.retry_after ? `. Retrying in ${rlMsg.retry_after}s...` : ". Retrying..."}`,
            turnId,
          });
          continue;
        }

        // prompt_suggestion — follow-up suggestions (consume silently for now)
        if ((msg as any).type === "prompt_suggestion") {
          continue;
        }
      }

      // ── Turn completion ──
      // Note: v2Session is NOT closed here — it stays alive for the next turn
      runtime.activeQuery = null;
      runtime.busy = false;
      runtime.activeTurnId = null;
      managed.session.status = "idle";

      const finalStatus = runtime.interrupted ? "interrupted" : "completed";
      emitChatEvent(managed, { type: "status", turnStatus: finalStatus, turnId });
      emitChatEvent(managed, {
        type: "done",
        turnId,
        status: finalStatus,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        ...(usage ? { usage } : {}),
        ...(costUsd != null ? { costUsd } : {}),
      });

      if (assistantText.trim().length > 0) {
        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: assistantText,
        });
      }

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);

      // Process queued steers
      if (runtime.pendingSteers.length) {
        const steerText = runtime.pendingSteers.shift() ?? "";
        if (steerText.trim().length) {
          await runClaudeTurn(managed, { promptText: steerText, displayText: steerText, attachments: [] });
        }
      }
    } catch (error) {
      runtime.activeQuery = null;
      runtime.busy = false;
      runtime.activeTurnId = null;

      // Close V2 session on error so the next turn starts fresh
      try { runtime.v2Session?.close(); } catch { /* ignore */ }
      runtime.v2Session = null;
      runtime.v2StreamGen = null;
      runtime.v2WarmupDone = null;

      if (runtime.interrupted) {
        managed.session.status = "idle";
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      } else {
        managed.session.status = "idle";
        emitChatEvent(managed, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          turnId,
        });
        emitChatEvent(managed, { type: "status", turnStatus: "failed", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "failed",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });

        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: error instanceof Error
            ? `Turn failed: ${error.message}`
            : `Turn failed: ${String(error)}`,
        });

        // If resume failed, clear sessionId and the caller can retry fresh
        if (runtime.sdkSessionId && String(error).includes("session")) {
          logger.warn("agent_chat.claude_sdk_session_error", {
            sessionId: managed.session.id,
            sdkSessionId: runtime.sdkSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          runtime.sdkSessionId = null;
        }
      }

      persistChatState(managed);
    }
  };

  // ── Streaming turn for Unified runtime ──

  const runTurn = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
    },
  ): Promise<void> => {
    const runtimeKind = managed.runtime?.kind;
    if (runtimeKind === "claude") {
      return runClaudeTurn(managed, args);
    }
    if (runtimeKind !== "unified") {
      throw new Error(`Streaming runtime is not available for session '${managed.session.id}'.`);
    }

    const runtime = managed.runtime as UnifiedRuntime;
    if (runtime.busy) {
      throw new Error("A turn is already active. Use steer or interrupt.");
    }
    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";
    const attachments = args.attachments ?? [];
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;

    const attachmentHint = attachments.length
      ? `\n\nAttached context:\n${attachments.map((file) => `- ${file.type}: ${file.path}`).join("\n")}`
      : "";
    const userContent = `${args.promptText}${attachmentHint}`;

    applyReconstructionContextToStreamingRuntime(managed, runtime);

    runtime.messages.push({ role: "user", content: userContent });
    emitChatEvent(managed, { type: "user_message", text: displayText, attachments, turnId });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    const abortController = new AbortController();
    runtime.abortController = abortController;

    // Turn-level timeout: abort if the entire turn exceeds the limit
    const turnTimeout = setTimeout(() => {
      logger.warn("agent_chat.turn_timeout", {
        sessionId: managed.session.id,
        turnId,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      emitChatEvent(managed, {
        type: "error",
        message: `Turn timed out after ${TURN_TIMEOUT_MS / 1000}s. The agent loop was aborted.`,
        turnId,
      });
      runtime.interrupted = true;
      abortController.abort();
    }, TURN_TIMEOUT_MS);

    const streamMessages = runtime.messages.map((message, index): ModelMessage => {
      const isCurrentUserMessage = index === runtime.messages.length - 1 && message.role === "user";
      if (!isCurrentUserMessage) {
        return {
          role: message.role as "user" | "assistant",
          content: message.content,
        };
      }

      return {
        role: "user",
        content: buildStreamingUserContent({
          baseText: args.promptText,
          attachments,
          runtimeKind: "unified",
          modelDescriptor: runtime.modelDescriptor,
        }),
      };
    });

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null } | undefined;
    let streamedStepCount = 0;

    try {
      const lightweight = isLightweightSession(managed.session);
      const tools = lightweight
        ? {}
        : createUniversalToolSet(managed.laneWorktreePath, {
            permissionMode: runtime.permissionMode,
            ...(memoryService && projectId ? { memoryService, projectId } : {}),
            agentScopeOwnerId: managed.session.identityKey ?? managed.session.id,
            ...(() => {
              if (managed.session.identityKey === "cto" && ctoStateService) {
                return {
                  onMemoryUpdateCore: (patch: any) => {
                    const snapshot = ctoStateService.updateCoreMemory(patch);
                    return {
                      version: snapshot.coreMemory.version,
                      updatedAt: snapshot.coreMemory.updatedAt
                    };
                  }
                };
              }
              const workerAgentId = resolveWorkerIdentityAgentId(managed.session.identityKey);
              if (workerAgentId && workerAgentService) {
                return {
                  onMemoryUpdateCore: (patch: any) => {
                    const snapshot = workerAgentService.updateCoreMemory(workerAgentId, patch);
                    return {
                      version: snapshot.version,
                      updatedAt: snapshot.updatedAt
                    };
                  }
                };
              }
              return {};
            })(),
            onApprovalRequest: async ({ category, description, detail }) => {
              if (runtime.approvalOverrides.has(category)) {
                return {
                  approved: true,
                  decision: "accept_for_session",
                  reason: "Already approved for this session.",
                };
              }

              const approvalItemId = randomUUID();
              emitChatEvent(managed, {
                type: "approval_request",
                itemId: approvalItemId,
                kind: category === "bash" ? "command" : "file_change",
                description,
                detail,
                turnId,
              });

              const response = await new Promise<{ decision: AgentChatApprovalDecision; responseText?: string | null }>((resolve) => {
                runtime.pendingApprovals.set(approvalItemId, { category, resolve });
              });
              runtime.pendingApprovals.delete(approvalItemId);

              if (response.decision === "accept_for_session") {
                runtime.approvalOverrides.add(category);
              }

              const approved = response.decision === "accept" || response.decision === "accept_for_session";
              const trimmedReason = typeof response.responseText === "string" ? response.responseText.trim() : "";
              return {
                approved,
                decision: response.decision,
                reason: trimmedReason.length
                  ? trimmedReason
                  : approved
                    ? "User approved the action."
                    : "User denied the action.",
              };
            },
            onAskUser: async (question) => {
              const askItemId = randomUUID();
              emitChatEvent(managed, {
                type: "approval_request",
                itemId: askItemId,
                kind: "tool_call",
                description: question,
                detail: { tool: "askUser", question, inputType: "text" },
                turnId,
              });

              const response = await new Promise<{ decision: AgentChatApprovalDecision; responseText?: string | null }>((resolve) => {
                runtime.pendingApprovals.set(askItemId, { category: "askUser", resolve });
              });
              runtime.pendingApprovals.delete(askItemId);
              const trimmedResponse = typeof response.responseText === "string" ? response.responseText.trim() : "";
              if (trimmedResponse.length) return trimmedResponse;
              if (response.decision === "accept") return "yes";
              if (response.decision === "decline") return "no";
              return String(response.decision);
            },
          });

      // Merge workflow tools (lane, PR, screenshot, completion) into the tool set
      if (!lightweight) {
        const workflowTools = createWorkflowTools({
          laneService,
          prService: prService ?? undefined,
          computerUseArtifactBrokerService: computerUseArtifactBrokerRef ?? undefined,
          sessionId: managed.session.id,
          laneId: managed.session.laneId,
        });
        Object.assign(tools, workflowTools);
      }

      const thinkingLevel = mapReasoningEffortToThinking(managed.session.reasoningEffort);
      const providerOptions = providerResolver.buildProviderOptions(runtime.modelDescriptor, thinkingLevel);
      const harnessPrompt = lightweight
        ? undefined
        : buildCodingAgentSystemPrompt({
            cwd: managed.laneWorktreePath,
            mode: "chat",
            permissionMode: runtime.permissionMode,
            toolNames: Object.keys(tools),
          });

      const stream = streamText({
        model: runtime.resolvedModel,
        ...(harnessPrompt ? { system: harnessPrompt } : {}),
        messages: streamMessages,
        ...(Object.keys(tools).length ? { tools } : {}),
        providerOptions: providerOptions as any,
        ...(!lightweight ? { stopWhen: stepCountIs(20) } : {}),
        abortSignal: abortController.signal,
        onError({ error }) {
          logger.warn("agent_chat.unified_stream_error", {
            sessionId: managed.session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });

      // ── Stream processing loop ──
      const streamSupportsReasoning = runtime.modelDescriptor.capabilities.reasoning;
      for await (const part of stream.fullStream as AsyncIterable<any>) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "start-step") {
          streamedStepCount += 1;
          emitChatEvent(managed, {
            type: "step_boundary",
            stepNumber: typeof part.stepNumber === "number" ? part.stepNumber + 1 : streamedStepCount,
            turnId,
          });
          if (!streamSupportsReasoning && streamedStepCount === 1) {
            emitChatEvent(managed, {
              type: "activity",
              activity: "working",
              detail: WORKING_ACTIVITY_DETAIL,
              turnId,
            });
          }
          continue;
        }

        if (part.type === "source") {
          emitChatEvent(managed, {
            type: "activity",
            activity: "searching",
            detail:
              typeof part.title === "string" && part.title.trim().length
                ? part.title
                : typeof part.url === "string" && part.url.trim().length
                  ? part.url
                  : "Gathering sources",
            turnId,
          });
          continue;
        }

        if (part.type === "text-delta") {
          const delta = String(part.text ?? part.textDelta ?? "");
          if (!delta.length) continue;
          assistantText += delta;
          emitChatEvent(managed, {
            type: "text",
            text: delta,
            turnId,
            itemId: typeof part.id === "string" ? part.id : undefined
          });
          continue;
        }

        if (part.type === "reasoning-start") {
          emitChatEvent(managed, {
            type: "activity",
            activity: streamSupportsReasoning ? "thinking" : "working",
            detail: streamSupportsReasoning ? REASONING_ACTIVITY_DETAIL : WORKING_ACTIVITY_DETAIL,
            turnId,
          });
          continue;
        }

        if (part.type === "reasoning" || part.type === "reasoning-delta") {
          const delta = String(part.text ?? part.textDelta ?? part.delta ?? "");
          if (!delta.length) continue;
          if (!streamSupportsReasoning) {
            emitChatEvent(managed, {
              type: "activity",
              activity: "working",
              detail: WORKING_ACTIVITY_DETAIL,
              turnId,
            });
            continue;
          }
          emitChatEvent(managed, {
            type: "activity",
            activity: "thinking",
            detail: REASONING_ACTIVITY_DETAIL,
            turnId,
          });
          emitChatEvent(managed, {
            type: "reasoning",
            text: delta,
            turnId,
            itemId: typeof part.id === "string" ? part.id : undefined
          });
          continue;
        }

        if (part.type === "reasoning-end") {
          flushBufferedReasoning(managed);
          continue;
        }

        if (part.type === "tool-call") {
          const nextActivity = activityForToolName(String(part.toolName ?? "tool"));
          const parentItemId = readProviderParentItemId((part as { providerMetadata?: unknown }).providerMetadata);
          emitChatEvent(managed, {
            type: "activity",
            activity: nextActivity.activity,
            detail: nextActivity.detail,
            turnId,
          });
          emitChatEvent(managed, {
            type: "tool_call",
            tool: String(part.toolName ?? "tool"),
            args: part.input ?? part.args ?? part.arguments,
            itemId: String(part.toolCallId ?? randomUUID()),
            ...(parentItemId ? { parentItemId } : {}),
            turnId
          });
          continue;
        }

        if (part.type === "tool-result") {
          const parentItemId = readProviderParentItemId((part as { providerMetadata?: unknown }).providerMetadata);
          emitChatEvent(managed, {
            type: "tool_result",
            tool: String(part.toolName ?? "tool"),
            result: part.output ?? part.result,
            itemId: String(part.toolCallId ?? randomUUID()),
            ...(parentItemId ? { parentItemId } : {}),
            turnId,
            status: part.preliminary ? "running" : "completed"
          });
          continue;
        }

        if (part.type === "tool-error") {
          emitChatEvent(managed, {
            type: "error",
            message: `Tool '${String(part.toolName ?? "tool")}' failed: ${String(part.error ?? "unknown error")}`,
            turnId,
            itemId: String(part.toolCallId ?? randomUUID())
          });
          continue;
        }

        if (part.type === "tool-approval-request") {
          const toolName = String(part.toolCall?.toolName ?? "tool");
          emitChatEvent(managed, {
            type: "error",
            message: isPlanningApprovalGuarded(managed)
              ? buildPlanningApprovalViolation(toolName)
              : `Unexpected SDK approval request for '${toolName}'. This tool should use ADE-managed approvals instead.`,
            turnId
          });
          continue;
        }

        if (part.type === "finish") {
          usage = normalizeUsagePayload(part.totalUsage ?? part.usage);
          continue;
        }

        if (part.type === "error") {
          emitChatEvent(managed, {
            type: "error",
            message: String(part.error ?? "Stream error."),
            turnId
          });
        }
      }

      // ── Shared turn completion ──
      clearTimeout(turnTimeout);
      if (assistantText.trim().length) {
        runtime.messages.push({ role: "assistant", content: assistantText });
      }

      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.abortController = null;
      managed.session.status = "idle";

      emitChatEvent(managed, { type: "status", turnStatus: "completed", turnId });
      emitChatEvent(managed, {
        type: "done",
        turnId,
        status: "completed",
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        ...(usage ? { usage } : {})
      });

      if (assistantText.trim().length > 0) {
        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: assistantText,
        });
      }

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);

      // Process queued steers
      if (runtime.pendingSteers.length) {
        const steerText = runtime.pendingSteers.shift() ?? "";
        if (steerText.trim().length) {
          await runTurn(managed, { promptText: steerText, displayText: steerText, attachments: [] });
        }
      }
    } catch (error) {
      clearTimeout(turnTimeout);
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.abortController = null;

      if (runtime.interrupted) {
        managed.session.status = "idle";
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      } else {
        managed.session.status = "idle";

        const { message: errorMessage, errorInfo } = classifyUnifiedError(
          error,
          runtime.modelDescriptor.family,
          runtime.modelDescriptor.displayName,
        );

        emitChatEvent(managed, {
          type: "error",
          message: errorMessage,
          turnId,
          errorInfo,
        });

        emitChatEvent(managed, { type: "status", turnStatus: "failed", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "failed",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });

        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: error instanceof Error
            ? `Turn failed: ${error.message}`
            : `Turn failed: ${String(error)}`,
        });
      }

      persistChatState(managed);
    }
  };

  const handleCodexServerRequest = (managed: ManagedChatSession, runtime: CodexRuntime, payload: JsonRpcEnvelope): void => {
    const method = typeof payload.method === "string" ? payload.method : "";
    const id = payload.id;
    if (id == null) return;

    if (method === "item/commandExecution/requestApproval") {
      const params = (payload.params as { itemId?: string; command?: string; cwd?: string; reason?: string } | null) ?? {};
      if (isPlanningApprovalGuarded(managed)) {
        emitChatEvent(managed, {
          type: "error",
          message: buildPlanningApprovalViolation(params.command?.trim() || "command"),
          turnId: runtime.activeTurnId ?? undefined,
        });
        runtime.sendResponse(id, { decision: "decline" });
        return;
      }
      const itemId = String(params.itemId ?? randomUUID());
      runtime.approvals.set(itemId, { requestId: id, kind: "command" });
      emitChatEvent(managed, {
        type: "approval_request",
        itemId,
        kind: "command",
        description: params.reason?.trim() || `Run command: ${params.command ?? "command"}`,
        detail: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null
        },
        turnId: runtime.activeTurnId ?? undefined
      });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const params = (payload.params as { itemId?: string; reason?: string; grantRoot?: string } | null) ?? {};
      if (isPlanningApprovalGuarded(managed)) {
        emitChatEvent(managed, {
          type: "error",
          message: buildPlanningApprovalViolation(params.reason?.trim() || "file change"),
          turnId: runtime.activeTurnId ?? undefined,
        });
        runtime.sendResponse(id, { decision: "decline" });
        return;
      }
      const itemId = String(params.itemId ?? randomUUID());
      runtime.approvals.set(itemId, { requestId: id, kind: "file_change" });
      emitChatEvent(managed, {
        type: "approval_request",
        itemId,
        kind: "file_change",
        description: params.reason?.trim() || "Approve file changes",
        detail: {
          grantRoot: params.grantRoot ?? null,
          reason: params.reason ?? null
        },
        turnId: runtime.activeTurnId ?? undefined
      });
      return;
    }

    runtime.sendError(id, `Unsupported server request: ${method || "unknown"}`);
  };

  const handleCodexItemEvent = (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    item: Record<string, unknown>,
    eventKind: "started" | "completed"
  ): void => {
    const itemId = String(item.id ?? randomUUID());
    const itemType = String(item.type ?? "");
    const turnId = runtime.activeTurnId ?? undefined;

    if (itemType === "commandExecution") {
      emitChatEvent(managed, {
        type: "activity",
        activity: "running_command",
        detail: String(item.command ?? "command"),
        turnId,
      });
      const status = mapCommandStatus(
        String(item.status ?? (eventKind === "completed" ? "completed" : "inProgress"))
      );
      const output = String(item.aggregatedOutput ?? runtime.commandOutputByItemId.get(itemId) ?? "");
      runtime.commandOutputByItemId.set(itemId, output);
      emitChatEvent(managed, {
        type: "command",
        command: String(item.command ?? "command"),
        cwd: String(item.cwd ?? managed.laneWorktreePath),
        output,
        itemId,
        turnId,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        status
      });
      return;
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes)
        ? item.changes
            .map((change) => {
              if (!change || typeof change !== "object") return null;
              const record = change as { path?: unknown; kind?: unknown; diff?: unknown };
              const filePath = typeof record.path === "string" ? record.path : "";
              if (!filePath) return null;
              return {
                path: filePath,
                kind: mapFileChangeKind(record.kind),
                diff: typeof record.diff === "string" ? record.diff : ""
              };
            })
            .filter((entry): entry is { path: string; kind: "create" | "modify" | "delete"; diff: string } => entry != null)
        : [];

      runtime.fileChangesByItemId.set(itemId, changes.map((change) => ({ path: change.path, kind: change.kind })));
      emitChatEvent(managed, {
        type: "activity",
        activity: "editing_file",
        detail: changes[0]?.path ?? "Applying file change",
        turnId,
      });

      const status = mapCommandStatus(
        String(item.status ?? (eventKind === "completed" ? "completed" : "inProgress"))
      );
      for (const change of changes) {
        emitChatEvent(managed, {
          type: "file_change",
          path: change.path,
          diff: change.diff || runtime.fileDeltaByItemId.get(itemId) || "",
          kind: change.kind,
          itemId,
          turnId,
          status
        });
      }
      return;
    }

    if (itemType === "mcpToolCall") {
      const nextActivity = activityForToolName(String(item.tool ?? "tool"));
      emitChatEvent(managed, {
        type: "activity",
        activity: nextActivity.activity,
        detail: nextActivity.detail,
        turnId,
      });
      if (eventKind === "started") {
        emitChatEvent(managed, {
          type: "tool_call",
          tool: String(item.tool ?? "tool"),
          args: item.arguments,
          itemId,
          turnId
        });
      }
      if (eventKind === "completed") {
        const status = String(item.status ?? "completed");
        emitChatEvent(managed, {
          type: "tool_result",
          tool: String(item.tool ?? "tool"),
          result: status === "failed" ? item.error : item.result,
          itemId,
          turnId,
          status: status === "failed" ? "failed" : "completed"
        });
      }
      return;
    }

    // Delegation items → subagent events
    if (itemType === "delegation") {
      if (eventKind === "started") {
        emitChatEvent(managed, {
          type: "subagent_started",
          taskId: itemId,
          description: String(item.description ?? item.title ?? "Delegated task"),
          turnId,
        });
      }
      if (eventKind === "completed") {
        emitChatEvent(managed, {
          type: "subagent_result",
          taskId: itemId,
          status: String(item.status ?? "completed") === "failed" ? "failed" : "completed",
          summary: String(item.summary ?? item.result ?? ""),
          turnId,
        });
      }
      return;
    }

    // Planning items → todo_update
    if (itemType === "planningItem" || itemType === "planning") {
      const steps = Array.isArray(item.steps) ? item.steps : Array.isArray(item.plan) ? item.plan : [];
      if (steps.length) {
        emitChatEvent(managed, {
          type: "todo_update",
          items: steps.map((s: any, idx: number) => ({
            id: String(s.id ?? `step-${idx}`),
            description: String(s.step ?? s.text ?? s.description ?? ""),
            status: s.status === "completed" ? "completed" : s.status === "in_progress" || s.status === "inProgress" ? "in_progress" : "pending",
          })),
          turnId,
        });
      }
      return;
    }

    logger.debug("agent_chat.codex_unhandled_item", { sessionId: managed.session.id, itemType, itemId });
  };

  const handleCodexNotification = async (managed: ManagedChatSession, runtime: CodexRuntime, payload: JsonRpcEnvelope): Promise<void> => {
    const method = typeof payload.method === "string" ? payload.method : "";
    const params = (payload.params as Record<string, unknown> | null) ?? {};

    if (method === "turn/started") {
      const turn = (params.turn as { id?: unknown } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : null;
      runtime.activeTurnId = turnId;
      managed.session.status = "active";
      if (!turnId || runtime.startedTurnId !== turnId) {
        const reasoningActivity = sessionSupportsReasoning(managed.session)
          ? { activity: "thinking" as const, detail: REASONING_ACTIVITY_DETAIL }
          : { activity: "working" as const, detail: WORKING_ACTIVITY_DETAIL };
        runtime.startedTurnId = turnId;
        emitChatEvent(managed, {
          type: "status",
          turnStatus: "started",
          ...(turnId ? { turnId } : {})
        });
        emitChatEvent(managed, {
          type: "activity",
          ...reasoningActivity,
          ...(turnId ? { turnId } : {})
        });
      }
      persistChatState(managed);
      return;
    }

    if (method === "turn/completed") {
      const turn = (params.turn as {
        id?: unknown;
        status?: unknown;
        usage?: unknown;
        totalUsage?: unknown;
        error?: { message?: unknown; codexErrorInfo?: unknown } | null;
      } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : runtime.activeTurnId ?? randomUUID();
      runtime.activeTurnId = null;
      runtime.startedTurnId = null;
      const status = mapCodexTurnStatus(turn?.status);
      const usage = normalizeUsagePayload(turn?.usage ?? turn?.totalUsage);
      managed.session.status = "idle";

      if (status === "failed" && turn?.error?.message) {
        emitChatEvent(managed, {
          type: "error",
          message: String(turn.error.message),
          turnId,
          errorInfo: formatCodexErrorInfo(turn.error.codexErrorInfo)
        });
      }

      emitChatEvent(managed, {
        type: "status",
        turnStatus: status,
        turnId,
        ...(status === "failed" && turn?.error?.message
          ? { message: String(turn.error.message) }
          : {})
      });

      emitChatEvent(managed, {
        type: "done",
        turnId,
        status,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        ...(usage ? { usage } : {}),
      });

      const endSha = await computeHeadShaBestEffort(managed.session.laneId).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = String((params.delta as string | undefined) ?? "");
      if (!delta.length) return;
      emitChatEvent(managed, {
        type: "text",
        text: delta,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params.itemId === "string" ? params.itemId : undefined
      });
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = String((params.delta as string | undefined) ?? "");
      if (!delta.length) return;
      emitChatEvent(managed, {
        type: "reasoning",
        text: delta,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params.itemId === "string" ? params.itemId : undefined,
        summaryIndex: typeof params.summaryIndex === "number" ? params.summaryIndex : undefined
      });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const itemId = String((params.itemId as string | undefined) ?? randomUUID());
      const delta = String((params.delta as string | undefined) ?? "");
      const next = `${runtime.commandOutputByItemId.get(itemId) ?? ""}${delta}`;
      runtime.commandOutputByItemId.set(itemId, next);
      emitChatEvent(managed, {
        type: "activity",
        activity: "running_command",
        detail: "Shell command running",
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      });
      emitChatEvent(managed, {
        type: "command",
        command: "command",
        cwd: managed.laneWorktreePath,
        output: delta,
        itemId,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        status: "running"
      });
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      const itemId = String((params.itemId as string | undefined) ?? randomUUID());
      const delta = String((params.delta as string | undefined) ?? "");
      const next = `${runtime.fileDeltaByItemId.get(itemId) ?? ""}${delta}`;
      runtime.fileDeltaByItemId.set(itemId, next);
      emitChatEvent(managed, {
        type: "activity",
        activity: "editing_file",
        detail: "Applying file change",
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      });

      const knownChanges = runtime.fileChangesByItemId.get(itemId) ?? [];
      if (knownChanges.length) {
        for (const change of knownChanges) {
          emitChatEvent(managed, {
            type: "file_change",
            path: change.path,
            kind: change.kind,
            diff: delta,
            itemId,
            turnId: typeof params.turnId === "string" ? params.turnId : undefined,
            status: "running"
          });
        }
      } else {
        emitChatEvent(managed, {
          type: "file_change",
          path: "(pending file)",
          kind: "modify",
          diff: delta,
          itemId,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          status: "running"
        });
      }
      return;
    }

    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      const steps = plan
        .map((step) => {
          if (!step || typeof step !== "object") return null;
          const record = step as { step?: unknown; status?: unknown };
          const text = typeof record.step === "string" ? record.step : "";
          if (!text) return null;
          const rawStatus = typeof record.status === "string" ? record.status : "pending";
          const mappedStatus = PLAN_STEP_STATUS_MAP[rawStatus] ?? "pending";
          return {
            text,
            status: mappedStatus
          };
        })
        .filter((entry): entry is { text: string; status: "pending" | "in_progress" | "completed" | "failed" } => entry != null);

      emitChatEvent(managed, {
        type: "plan",
        steps,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        explanation: typeof params.explanation === "string" ? params.explanation : null
      });
      return;
    }

    if (method === "item/started") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "started");
      return;
    }

    if (method === "item/completed") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "completed");
      return;
    }

    if (method === "error") {
      const error = (params.error as { message?: unknown; codexErrorInfo?: unknown } | null) ?? null;
      emitChatEvent(managed, {
        type: "error",
        message: String(error?.message ?? "Codex app-server error."),
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        errorInfo: formatCodexErrorInfo(error?.codexErrorInfo)
      });
      return;
    }

    if (method === "account/rateLimits/updated") {
      const rateLimits = params.rateLimits as { remaining?: number; limit?: number; resetAt?: string } | undefined;
      if (rateLimits) {
        runtime.rateLimits = {
          remaining: typeof rateLimits.remaining === "number" ? rateLimits.remaining : null,
          limit: typeof rateLimits.limit === "number" ? rateLimits.limit : null,
          resetAt: typeof rateLimits.resetAt === "string" ? rateLimits.resetAt : null,
        };
        const pct = rateLimits.limit && rateLimits.remaining != null
          ? Math.round((rateLimits.remaining / rateLimits.limit) * 100)
          : null;
        if (pct !== null && pct <= 15) {
          emitChatEvent(managed, {
            type: "system_notice",
            noticeKind: "rate_limit",
            message: `Codex rate limit: ${rateLimits.remaining}/${rateLimits.limit} remaining${rateLimits.resetAt ? ` (resets ${rateLimits.resetAt})` : ""}`,
            turnId: typeof params.turnId === "string" ? params.turnId : undefined,
          });
        }
      }
      return;
    }

    if (method === "account/updated") {
      // Account info changed — log but no UI action needed
      logger.info("agent_chat.codex_account_updated", { sessionId: managed.session.id });
      return;
    }

    if (method === "account/login/completed") {
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "auth",
        message: "Codex authentication completed.",
      });
      return;
    }

    // Log unhandled notification methods for debugging
    if (method) {
      logger.warn("agent_chat.codex_unhandled_notification", {
        sessionId: managed.session.id,
        method,
        paramKeys: Object.keys(params),
      });
    }
  };

  const startCodexRuntime = async (managed: ManagedChatSession): Promise<CodexRuntime> => {
    const proc = spawn("codex", ["app-server"], {
      cwd: managed.laneWorktreePath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const reader = readline.createInterface({ input: proc.stdout });
    const pending = new Map<string, PendingRpc>();

    const runtime: CodexRuntime = {
      kind: "codex",
      process: proc,
      reader,
      suppressExitError: false,
      nextRequestId: 1,
      pending,
      approvals: new Map<string, PendingCodexApproval>(),
      activeTurnId: null,
      startedTurnId: null,
      threadResumed: false,
      commandOutputByItemId: new Map<string, string>(),
      fileDeltaByItemId: new Map<string, string>(),
      fileChangesByItemId: new Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>(),
      slashCommands: [],
      rateLimits: null,
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        const id = runtime.nextRequestId;
        runtime.nextRequestId += 1;

        const payload: JsonRpcEnvelope = {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {})
        };

        if (!proc.stdin.writable) {
          throw new Error("Codex app-server stdin is not writable.");
        }

        return new Promise<T>((resolve, reject) => {
          pending.set(String(id), { resolve, reject });
          proc.stdin.write(`${JSON.stringify(payload)}\n`);
        });
      },
      notify: (method: string, params?: unknown) => {
        if (!proc.stdin.writable) return;
        const payload: JsonRpcEnvelope = {
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {})
        };
        proc.stdin.write(`${JSON.stringify(payload)}\n`);
      },
      sendResponse: (id: string | number, result: unknown) => {
        if (!proc.stdin.writable) return;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      },
      sendError: (id: string | number, message: string) => {
        if (!proc.stdin.writable) return;
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message } })}\n`
        );
      }
    };

    reader.on("line", (line) => {
      const payload = parseJsonLine(line);
      if (!payload) return;

      if (payload.method && payload.id != null) {
        handleCodexServerRequest(managed, runtime, payload);
        return;
      }

      if (payload.method) {
        void handleCodexNotification(managed, runtime, payload).catch((error) => {
          logger.warn("agent_chat.codex_notification_failed", {
            sessionId: managed.session.id,
            method: payload.method,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        return;
      }

      if (payload.id != null) {
        const key = String(payload.id);
        const request = pending.get(key);
        if (!request) return;
        pending.delete(key);

        if (payload.error) {
          request.reject(new Error(payload.error.message || "Codex request failed."));
          return;
        }

        request.resolve(payload.result);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text.length) return;
      logger.warn("agent_chat.codex_stderr", {
        sessionId: managed.session.id,
        line: text
      });
    });

    proc.on("exit", (code, signal) => {
      const message = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;

      for (const request of pending.values()) {
        request.reject(new Error(message));
      }
      pending.clear();

      runtime.approvals.clear();

      if (runtime.suppressExitError) return;
      if (managed.closed || managed.session.status === "ended") return;

      emitChatEvent(managed, {
        type: "error",
        message
      });

      void finishSession(managed, "failed", {
        summary: message,
        exitCode: code ?? null
      }).catch(() => {});
    });

    await runtime.request("initialize", {
      clientInfo: {
        name: "ade",
        title: "ADE",
        version: appVersion
      },
      capabilities: {
        experimentalApi: true
      }
    });

    runtime.notify("initialized");
    return runtime;
  };

  const ensureCodexSessionRuntime = async (managed: ManagedChatSession): Promise<CodexRuntime> => {
    if (managed.runtime?.kind === "codex") return managed.runtime;
    const runtime = await startCodexRuntime(managed);
    managed.runtime = runtime;
    return runtime;
  };

  type CodexPolicy = {
    approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
  } | null;

    const resolveCodexThreadParams = (managed: ManagedChatSession): {
      codexPolicy: CodexPolicy;
      mcpServers: Record<string, Record<string, unknown>>;
    } => {
      const config = resolveChatConfig();
      const codexPolicy = managed.session.permissionMode
        ? mapPermissionToCodex(managed.session.permissionMode)
        : { approvalPolicy: config.codexApprovalPolicy, sandbox: config.codexSandboxMode };
    const mcpServers = isLightweightSession(managed.session)
      ? {}
      : buildAdeMcpServers(
          "codex",
          managed.session.identityKey === "cto" ? "cto" : "agent",
          resolveWorkerIdentityAgentId(managed.session.identityKey)
        );
    return { codexPolicy, mcpServers };
  };

  const startFreshCodexThread = async (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    codexPolicy: CodexPolicy,
    mcpServers: Record<string, Record<string, unknown>>,
  ): Promise<void> => {
    const startResponse = await runtime.request<{ thread?: { id?: string } }>("thread/start", {
      model: managed.session.model,
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      cwd: managed.laneWorktreePath,
      mcpServers,
      mcp_servers: mcpServers,
      ...codexPolicyArgs(codexPolicy),
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const newThreadId = typeof startResponse.thread?.id === "string" ? startResponse.thread.id : undefined;
    if (newThreadId) {
      managed.session.threadId = newThreadId;
      sessionService.setResumeCommand(managed.session.id, `chat:codex:${newThreadId}`);
    }
    runtime.threadResumed = true;
    persistChatState(managed);

    // Fetch available skills and populate slash commands
    runtime.request<{ skills?: Array<{ name?: string; description?: string }> }>("skills/list", {})
      .then((res) => {
        if (Array.isArray(res?.skills)) {
          runtime.slashCommands = res.skills
            .filter((s): s is { name: string; description?: string } => typeof s?.name === "string" && s.name.length > 0)
            .map((s) => ({ name: s.name.startsWith("/") ? s.name : `/${s.name}`, description: s.description ?? "" }));
        }
      })
      .catch(() => { /* skills/list not supported — ignore */ });

    // Fetch initial rate limits
    runtime.request<{ rateLimits?: { remaining?: number; limit?: number; resetAt?: string } }>("account/rateLimits/read", {})
      .then((res) => {
        if (res?.rateLimits) {
          runtime.rateLimits = {
            remaining: typeof res.rateLimits.remaining === "number" ? res.rateLimits.remaining : null,
            limit: typeof res.rateLimits.limit === "number" ? res.rateLimits.limit : null,
            resetAt: typeof res.rateLimits.resetAt === "string" ? res.rateLimits.resetAt : null,
          };
        }
      })
      .catch(() => { /* account/rateLimits/read not supported — ignore */ });
  };

  /**
   * Build V2 SDK options from the managed session state. Shared between warmup and runClaudeTurn.
   */
  const buildClaudeV2SessionOpts = (
    managed: ManagedChatSession,
    runtime: ClaudeRuntime,
    canUseTool?: ClaudeSDKOptions["canUseTool"],
  ): { model: string } & ClaudeSDKOptions => {
    const chatConfig = resolveChatConfig();
    const claudePermissionMode = managed.session.permissionMode
      ? mapPermissionToClaude(managed.session.permissionMode)
      : chatConfig.claudePermissionMode;
    const lightweight = isLightweightSession(managed.session);
    const opts: ClaudeSDKOptions = {
      cwd: managed.laneWorktreePath,
      permissionMode: claudePermissionMode as any,
      includePartialMessages: true,
      maxBudgetUsd: chatConfig.sessionBudgetUsd ?? undefined,
      model: resolveClaudeCliModel(managed.session.model),
    };
    if (!lightweight) {
      opts.systemPrompt = { type: "preset", preset: "claude_code" };
      opts.settingSources = ["user", "project", "local"];
      opts.mcpServers = buildAdeMcpServers(
        "claude",
        managed.session.identityKey === "cto" ? "cto" : "agent",
        resolveWorkerIdentityAgentId(managed.session.identityKey),
      ) as any;
      if (canUseTool) opts.canUseTool = canUseTool as any;
    }
    const claudeDescriptor = resolveSessionModelDescriptor(managed.session);
    const claudeSupportsReasoning = claudeDescriptor?.capabilities.reasoning ?? true;
    if (claudeSupportsReasoning) {
      const effort = managed.session.reasoningEffort;
      if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
        opts.effort = effort as any;
      }
      const tokens = effort ? CLAUDE_EFFORT_TO_TOKENS[effort] : undefined;
      if (tokens) {
        opts.thinking = { type: "enabled", budgetTokens: tokens };
      } else {
        // Use adaptive thinking when no specific budget applies (e.g. "max",
        // "xhigh", or no effort set). The SDK defaults to adaptive for models
        // that support it, but being explicit ensures thinking is always active
        // for reasoning-capable models.
        opts.thinking = { type: "adaptive" };
      }
    }
    const model = opts.model ?? resolveClaudeCliModel(managed.session.model) ?? "claude-sonnet-4-6";
    return { ...opts, model };
  };

  /**
   * Pre-warm the Claude V2 session in the background.
   * Creates the session and sends a warmup turn so the subprocess + MCP servers
   * are fully initialized by the time the user sends their first real message.
   * The warmup turn (~30s cold start) runs while the user is composing their message.
   */
  const prewarmClaudeV2Session = (managed: ManagedChatSession): void => {
    const runtime = managed.runtime;
    if (!runtime || runtime.kind !== "claude") return;
    if (runtime.v2Session || runtime.v2WarmupDone) return;

    runtime.v2WarmupCancelled = false;

    runtime.v2WarmupDone = (async () => {
      try {
        const v2Opts = buildClaudeV2SessionOpts(managed, runtime);
        logger.info("agent_chat.claude_v2_prewarm_start", {
          sessionId: managed.session.id,
          resume: !!runtime.sdkSessionId,
          model: v2Opts.model,
        });

        if (runtime.v2WarmupCancelled) return;

        if (runtime.sdkSessionId) {
          runtime.v2Session = unstable_v2_resumeSession(runtime.sdkSessionId, v2Opts as any) as unknown as ClaudeV2Session;
        } else {
          runtime.v2Session = unstable_v2_createSession(v2Opts as any) as unknown as ClaudeV2Session;
        }

        if (runtime.v2WarmupCancelled) {
          try { runtime.v2Session?.close(); } catch { /* ignore */ }
          runtime.v2Session = null;
          return;
        }

        // Send a warmup turn — this triggers the ~30s subprocess cold start.
        // The response is consumed silently. By the time the user types and sends
        // their first real message, the subprocess is already running.
        await runtime.v2Session.send("System initialization check. Respond with only the word READY.");
        for await (const msg of runtime.v2Session.stream()) {
          if (runtime.v2WarmupCancelled) break;
          if (!runtime.sdkSessionId && (msg as any).session_id) {
            runtime.sdkSessionId = (msg as any).session_id;
          }
          if (msg.type === "system" && (msg as any).subtype === "init") {
            const initMsg = msg as any;
            runtime.sdkSessionId = initMsg.session_id ?? runtime.sdkSessionId;
            if (Array.isArray(initMsg.slash_commands)) {
              runtime.slashCommands = initMsg.slash_commands
                .filter((cmd: unknown) => typeof cmd === "string" && cmd.length > 0)
                .map((cmd: string) => ({ name: cmd.startsWith("/") ? cmd : `/${cmd}`, description: "" }));
            }
          }
          if (msg.type === "result") break;
        }

        if (runtime.v2WarmupCancelled) {
          try { runtime.v2Session?.close(); } catch { /* ignore */ }
          runtime.v2Session = null;
          return;
        }

        persistChatState(managed);
        logger.info("agent_chat.claude_v2_prewarm_done", {
          sessionId: managed.session.id,
          sdkSessionId: runtime.sdkSessionId,
        });
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Session ready",
        });
      } catch (error) {
        if (runtime.v2WarmupCancelled) return; // expected — teardown killed the session
        logger.warn("agent_chat.claude_v2_prewarm_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
      }
    })();
  };

  const ensureClaudeSessionRuntime = (managed: ManagedChatSession): ClaudeRuntime => {
    if (managed.runtime?.kind === "claude") return managed.runtime;
    const persisted = readPersistedState(managed.session.id);
    // Old persisted state may have `messages` but no `sdkSessionId` — start fresh
    const sdkSessionId = persisted?.sdkSessionId ?? null;
    const runtime: ClaudeRuntime = {
      kind: "claude",
      sdkSessionId,
      activeQuery: null,
      v2Session: null,
      v2StreamGen: null,
      v2WarmupDone: null,
      v2WarmupCancelled: false,
      activeSubagents: new Map(),
      slashCommands: [],
      busy: false,
      activeTurnId: null,
      pendingSteers: [],
      approvals: new Map<string, PendingClaudeApproval>(),
      interrupted: false,
    };
    managed.runtime = runtime;

    return runtime;
  };

  const listCodexModelsFromAppServer = async (): Promise<AgentChatModelInfo[]> => {
    const tempSession: ManagedChatSession = {
      session: {
        id: randomUUID(),
        laneId: "temporary",
        provider: "codex",
        model: DEFAULT_CODEX_MODEL,
        capabilityMode: "full_mcp",
        status: "idle",
        createdAt: nowIso(),
        lastActivityAt: nowIso()
      },
      transcriptPath: path.join(transcriptsDir, `${randomUUID()}.chat.jsonl`),
      transcriptBytesWritten: 0,
      transcriptLimitReached: false,
      metadataPath: metadataPathFor(randomUUID()),
      laneWorktreePath: projectRoot,
      runtime: null,
      preview: null,
      closed: false,
      endedNotified: false,
      lastActivitySignature: null,
      bufferedReasoning: null,
      ctoSessionStartedAt: null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
      previewTextBuffer: null,
      recentConversationEntries: [],
    };

    let runtime: CodexRuntime | null = null;

    try {
      runtime = await startCodexRuntime(tempSession);
      const response = await runtime.request<{ data?: Array<Record<string, unknown>> }>("model/list", {});
      const rows = Array.isArray(response?.data) ? response.data : [];
      const models = rows
        .map((row): AgentChatModelInfo | null => {
          const id = typeof row.id === "string" ? row.id.trim() : "";
          if (!id) return null;

          const displayName = typeof row.displayName === "string" && row.displayName.trim().length
            ? row.displayName.trim()
            : id;
          const description = typeof row.description === "string" && row.description.trim().length
            ? row.description.trim()
            : null;
          const isDefault = Boolean(row.isDefault);

          const reasoningEfforts = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts
                .map((entry) => {
                  if (typeof entry === "string") {
                    const effort = normalizeReasoningEffort(entry);
                    return effort
                      ? {
                          effort,
                          description:
                            CODEX_REASONING_EFFORTS.find((option) => option.effort === effort)?.description ?? ""
                        }
                      : null;
                  }
                  if (!entry || typeof entry !== "object") return null;
                  const effort = normalizeReasoningEffort((entry as { reasoningEffort?: unknown }).reasoningEffort);
                  const detail = typeof (entry as { description?: unknown }).description === "string"
                    ? String((entry as { description?: unknown }).description)
                    : "";
                  if (!effort) return null;
                  return { effort, description: detail };
                })
                .filter((entry): entry is { effort: string; description: string } => entry != null)
            : undefined;

          const normalizedEfforts = reasoningEfforts?.length ? reasoningEfforts : CODEX_REASONING_EFFORTS;

          return {
            id,
            displayName,
            ...(description ? { description } : {}),
            isDefault,
            reasoningEfforts: normalizedEfforts
          } satisfies AgentChatModelInfo;
        })
        .filter((entry): entry is AgentChatModelInfo => entry != null);

      if (models.length) {
        if (!models.some((entry) => entry.isDefault)) {
          const preferredIdx = models.findIndex((entry) => entry.id === DEFAULT_CODEX_MODEL);
          if (preferredIdx >= 0) {
            models[preferredIdx] = { ...models[preferredIdx]!, isDefault: true };
          } else {
            models[0] = { ...models[0]!, isDefault: true };
          }
        }
        return models;
      }
      return CODEX_FALLBACK_MODELS;
    } catch {
      return CODEX_FALLBACK_MODELS;
    } finally {
      // This throwaway runtime is not a tracked session; suppress exit-side lifecycle hooks.
      tempSession.closed = true;
      tempSession.endedNotified = true;
      tempSession.session.status = "ended";
      try {
        runtime?.reader.close();
      } catch {
        // ignore
      }
      try {
        runtime?.process.kill();
      } catch {
        // ignore
      }
    }
  };

  const listClaudeModelsFromSdk = async (): Promise<AgentChatModelInfo[]> => {
    const mapped = listModelDescriptorsForProvider("claude")
      .map((descriptor): AgentChatModelInfo => {
        const id = descriptor.sdkModelId;
        const displayName = descriptor.displayName;
        const description = describeClaudeModel(`${descriptor.shortId} ${displayName}`);
        return {
          id,
          displayName,
          ...(description ? { description } : {}),
          isDefault: descriptor.id === DEFAULT_CLAUDE_DESCRIPTOR?.id,
          reasoningEfforts: descriptor.capabilities.reasoning && descriptor.reasoningTiers?.length
            ? CLAUDE_REASONING_EFFORTS.filter((effort) => descriptor.reasoningTiers?.includes(effort.effort))
            : [],
          maxThinkingTokens: descriptor.capabilities.reasoning ? CLAUDE_EFFORT_TO_TOKENS.high : null
        };
      });

    if (!mapped.length) return CLAUDE_FALLBACK_MODELS;
    if (!mapped.some((entry) => entry.isDefault)) {
      const preferredIdx = mapped.findIndex((entry) => /sonnet/i.test(entry.id) || /sonnet/i.test(entry.displayName));
      if (preferredIdx >= 0) {
        mapped[preferredIdx] = { ...mapped[preferredIdx]!, isDefault: true };
      } else {
        mapped[0] = { ...mapped[0]!, isDefault: true };
      }
    }
    return mapped;
  };

  const createSession = async ({
    laneId,
    provider,
    model,
    modelId,
    sessionProfile,
    reasoningEffort,
    permissionMode: requestedPermMode,
    identityKey,
    computerUse,
  }: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const sessionId = randomUUID();
    const startedAt = nowIso();
    const transcriptPath = path.join(transcriptsDir, `${sessionId}.chat.jsonl`);
    const metadataPath = metadataPathFor(sessionId);

    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

    const normalizedInputModel = model.trim()
      || (provider === "codex"
        ? DEFAULT_CODEX_MODEL
        : provider === "claude"
          ? DEFAULT_CLAUDE_MODEL
          : "");
    // Resolve modelId from registry if provided
    const resolvedModelId = modelId && getModelById(modelId)
      ? modelId
      : resolveModelIdFromStoredValue(normalizedInputModel, provider);

    if (provider === "unified" && !resolvedModelId) {
      throw new Error("Unified chat requires a known model ID. Select a model from the registry.");
    }

    const resolvedDescriptor = resolvedModelId ? getModelById(resolvedModelId) : undefined;
    if (resolvedModelId && !resolvedDescriptor) {
      throw new Error(`Unknown model '${resolvedModelId}'.`);
    }

    let effectiveProvider: AgentChatProvider = provider;
    let normalizedModel = normalizedInputModel;

    if (resolvedDescriptor) {
      if (resolvedDescriptor.isCliWrapped) {
        if (resolvedDescriptor.family === "openai") {
          effectiveProvider = "codex";
          normalizedModel = resolvedDescriptor.shortId;
        } else if (resolvedDescriptor.family === "anthropic") {
          effectiveProvider = "claude";
          normalizedModel = resolvedDescriptor.shortId;
        } else if (provider === "unified") {
          throw new Error(
            `Model '${resolvedDescriptor.id}' is CLI-only but does not map to a supported chat runtime.`,
          );
        }
      } else {
        effectiveProvider = "unified";
        normalizedModel = resolvedDescriptor.id;
      }
    }

    const rawEffort = effectiveProvider === "codex"
      ? normalizeReasoningEffort(reasoningEffort) ?? DEFAULT_REASONING_EFFORT
      : normalizeReasoningEffort(reasoningEffort);
    const normalizedReasoningEffort = effectiveProvider === "unified"
      ? rawEffort
      : validateReasoningEffort(effectiveProvider === "claude" ? "claude" : "codex", rawEffort);
    const capabilityMode = inferCapabilityMode(effectiveProvider);
    const computerUsePolicy = normalizeComputerUsePolicy(computerUse, createDefaultComputerUsePolicy());
    const effectivePermissionMode = identityKey
      ? normalizeIdentityPermissionMode(requestedPermMode, effectiveProvider)
      : requestedPermMode;

    sessionService.create({
      sessionId,
      laneId,
      ptyId: null,
      tracked: true,
      title: defaultChatSessionTitle(effectiveProvider),
      startedAt,
      transcriptPath,
      toolType: toolTypeFromProvider(effectiveProvider),
      resumeCommand: resumeCommandForProvider(effectiveProvider, sessionId)
    });

    const managed: ManagedChatSession = {
      session: {
        id: sessionId,
        laneId,
        provider: effectiveProvider,
        model: normalizedModel,
        ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        sessionProfile: sessionProfile ?? "workflow",
        ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        capabilityMode,
        computerUse: computerUsePolicy,
        status: "idle",
        createdAt: startedAt,
        lastActivityAt: startedAt
      },
      transcriptPath,
      transcriptBytesWritten: fileSizeOrZero(transcriptPath),
      transcriptLimitReached: false,
      metadataPath,
      laneWorktreePath: lane.worktreePath,
      runtime: null,
      preview: null,
      closed: false,
      endedNotified: false,
      ctoSessionStartedAt: identityKey === "cto" ? startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
      lastActivitySignature: null,
      bufferedReasoning: null,
      previewTextBuffer: null,
      recentConversationEntries: [],
    };
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed);

    // Init dedicated chat transcript file for persistence
    try {
      const chatTranscriptFile = path.join(chatTranscriptsDir, `${sessionId}.jsonl`);
      const header = JSON.stringify({
        type: "session_init",
        sessionId,
        laneId,
        provider: effectiveProvider,
        model: managed.session.model,
        createdAt: startedAt,
      });
      fs.writeFileSync(chatTranscriptFile, `${header}\n`, "utf8");
    } catch {
      // Non-fatal — chat transcript init failure should not block session creation
    }

    managedSessions.set(sessionId, managed);

    const headStart = await computeHeadShaBestEffort(laneId).catch(() => null);
    if (headStart) {
      sessionService.setHeadShaStart(sessionId, headStart);
    }

    // Lazy runtime boot: keep new-chat creation fast and start runtime/thread
    // on first send/resume instead of blocking UI during session creation.
    persistChatState(managed);
    return managed.session;
  };

  const sendMessage = async ({
    sessionId,
    text,
    displayText,
    attachments = [],
    reasoningEffort,
    executionMode,
  }: AgentChatSendArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;
    const visibleText = displayText?.trim().length ? displayText.trim() : trimmed;

    const managed = ensureManagedSession(sessionId);

    if (managed.session.status === "ended") {
      sessionService.reopen(sessionId);
      managed.session.status = "idle";
      managed.closed = false;
      managed.endedNotified = false;
      managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? nowIso() : null;
      refreshReconstructionContext(managed);
    }

    if (!managed.autoTitleSeed) {
      managed.autoTitleSeed = visibleText;
      void maybeAutoTitleSession(managed, {
        stage: "initial",
        latestUserText: visibleText,
      });
    }
    const promptText = composeLaunchDirectives(trimmed, [
      buildExecutionModeDirective(executionMode, managed.session.provider),
      buildComputerUseDirective(managed.session.computerUse),
    ]);
    if (executionMode) {
      managed.session.executionMode = executionMode;
    } else if (managed.session.executionMode == null) {
      managed.session.executionMode = "focused";
    }

    // Unified runtime dispatch
    if (managed.session.provider === "unified") {
      if (!managed.runtime || managed.runtime.kind !== "unified") {
        const restarted = await startUnifiedSession(managed);
        if (restarted !== "handled" || !managed.runtime) {
          throw new Error(`Unified runtime is not available for session '${managed.session.id}'.`);
        }
      }
      if (reasoningEffort) {
        managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      }
      await runTurn(managed, { promptText, displayText: visibleText, attachments });
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      const nextReasoningEffort = validateReasoningEffort("codex", normalizeReasoningEffort(reasoningEffort));
      if (nextReasoningEffort) {
        managed.session.reasoningEffort = nextReasoningEffort;
      } else if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = DEFAULT_REASONING_EFFORT;
      }

      if (!runtime.threadResumed) {
        const threadIdToResume = managed.session.threadId || readPersistedState(sessionId)?.threadId;
        const { codexPolicy, mcpServers } = resolveCodexThreadParams(managed);

        if (threadIdToResume) {
          try {
            await runtime.request("thread/resume", {
              threadId: threadIdToResume,
              model: managed.session.model,
              ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
              cwd: managed.laneWorktreePath,
              mcpServers,
              mcp_servers: mcpServers,
              ...codexPolicyArgs(codexPolicy),
              persistExtendedHistory: true
            });
            managed.session.threadId = threadIdToResume;
            runtime.threadResumed = true;
            // Fetch skills after resume if not already fetched
            if (runtime.slashCommands.length === 0) {
              runtime.request<{ skills?: Array<{ name?: string; description?: string }> }>("skills/list", {})
                .then((res) => {
                  if (Array.isArray(res?.skills)) {
                    runtime.slashCommands = res.skills
                      .filter((s): s is { name: string; description?: string } => typeof s?.name === "string" && s.name.length > 0)
                      .map((s) => ({ name: s.name.startsWith("/") ? s.name : `/${s.name}`, description: s.description ?? "" }));
                  }
                })
                .catch(() => { /* skills/list not supported — ignore */ });
              runtime.request<{ rateLimits?: { remaining?: number; limit?: number; resetAt?: string } }>("account/rateLimits/read", {})
                .then((res) => {
                  if (res?.rateLimits) {
                    runtime.rateLimits = {
                      remaining: typeof res.rateLimits.remaining === "number" ? res.rateLimits.remaining : null,
                      limit: typeof res.rateLimits.limit === "number" ? res.rateLimits.limit : null,
                      resetAt: typeof res.rateLimits.resetAt === "string" ? res.rateLimits.resetAt : null,
                    };
                  }
                })
                .catch(() => { /* account/rateLimits/read not supported — ignore */ });
            }
          } catch (resumeError) {
            logger.warn("agent_chat.thread_resume_failed", {
              sessionId,
              threadId: threadIdToResume,
              error: resumeError instanceof Error ? resumeError.message : String(resumeError)
            });
            await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
          }
        } else {
          await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
        }
      }

      await sendCodexMessage(managed, { promptText, displayText: visibleText, attachments });
      return;
    }

    const nextClaudeEffort = validateReasoningEffort("claude", normalizeReasoningEffort(reasoningEffort));
    if (nextClaudeEffort) {
      managed.session.reasoningEffort = nextClaudeEffort;
    }

    ensureClaudeSessionRuntime(managed);
    await runClaudeTurn(managed, { promptText, displayText: visibleText, attachments });
  };

  const steer = async ({ sessionId, text }: AgentChatSteerArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;

    const managed = ensureManagedSession(sessionId);

    // Unified runtime steer
    if (managed.runtime?.kind === "unified") {
      const runtime = managed.runtime;
      if (runtime.busy) {
        runtime.pendingSteers.push(trimmed);
        emitChatEvent(managed, {
          type: "user_message",
          text: trimmed,
          turnId: runtime.activeTurnId ?? undefined,
        });
        persistChatState(managed);
        return;
      }
      await runTurn(managed, { promptText: trimmed, displayText: trimmed, attachments: [] });
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.threadId || !runtime.activeTurnId) {
        throw new Error("No active turn to steer.");
      }

      emitChatEvent(managed, {
        type: "user_message",
        text: trimmed,
        turnId: runtime.activeTurnId
      });

      await runtime.request("turn/steer", {
        threadId: managed.session.threadId,
        expectedTurnId: runtime.activeTurnId,
        input: [
          {
            type: "text",
            text: trimmed,
            text_elements: []
          }
        ]
      });
      return;
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    if (runtime.busy) {
      runtime.pendingSteers.push(trimmed);
      emitChatEvent(managed, {
        type: "user_message",
        text: trimmed,
        turnId: runtime.activeTurnId ?? undefined
      });
      persistChatState(managed);
      return;
    }

    await runClaudeTurn(managed, { promptText: trimmed, displayText: trimmed, attachments: [] });
  };

  const interrupt = async ({ sessionId }: AgentChatInterruptArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Unified runtime interrupt
    if (managed.runtime?.kind === "unified") {
      managed.runtime.interrupted = true;
      managed.runtime.abortController?.abort();
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.threadId || !runtime.activeTurnId) return;
      await runtime.request("turn/interrupt", {
        threadId: managed.session.threadId,
        turnId: runtime.activeTurnId
      });
      return;
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    runtime.interrupted = true;
    runtime.activeQuery?.interrupt().catch(() => {});
    // Close the V2 session on interrupt — it will be recreated on the next turn
    try { runtime.v2Session?.close(); } catch { /* ignore */ }
    runtime.v2Session = null;
    runtime.v2StreamGen = null;
    runtime.v2WarmupDone = null;
  };

  const resumeSession = async ({ sessionId }: { sessionId: string }): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const persisted = readPersistedState(sessionId);
    managed.session.capabilityMode = managed.session.capabilityMode ?? inferCapabilityMode(managed.session.provider);
    refreshReconstructionContext(managed);

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      if (!managed.session.reasoningEffort) {
        managed.session.reasoningEffort = persisted?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
      }
      const threadId = persisted?.threadId ?? managed.session.threadId;
      if (threadId) {
        const { codexPolicy, mcpServers } = resolveCodexThreadParams(managed);
        try {
          await runtime.request("thread/resume", {
            threadId,
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
            mcpServers,
            mcp_servers: mcpServers,
            ...codexPolicyArgs(codexPolicy),
            persistExtendedHistory: true
          });
          managed.session.threadId = threadId;
          runtime.threadResumed = true;
          sessionService.setResumeCommand(sessionId, `chat:codex:${threadId}`);
          // Fetch skills after resume if not already fetched
          if (runtime.slashCommands.length === 0) {
            runtime.request<{ skills?: Array<{ name?: string; description?: string }> }>("skills/list", {})
              .then((res) => {
                if (Array.isArray(res?.skills)) {
                  runtime.slashCommands = res.skills
                    .filter((s): s is { name: string; description?: string } => typeof s?.name === "string" && s.name.length > 0)
                    .map((s) => ({ name: s.name.startsWith("/") ? s.name : `/${s.name}`, description: s.description ?? "" }));
                }
              })
              .catch(() => { /* skills/list not supported — ignore */ });
            runtime.request<{ rateLimits?: { remaining?: number; limit?: number; resetAt?: string } }>("account/rateLimits/read", {})
              .then((res) => {
                if (res?.rateLimits) {
                  runtime.rateLimits = {
                    remaining: typeof res.rateLimits.remaining === "number" ? res.rateLimits.remaining : null,
                    limit: typeof res.rateLimits.limit === "number" ? res.rateLimits.limit : null,
                    resetAt: typeof res.rateLimits.resetAt === "string" ? res.rateLimits.resetAt : null,
                  };
                }
              })
              .catch(() => { /* account/rateLimits/read not supported — ignore */ });
          }
        } catch (resumeError) {
          logger.warn("agent_chat.resume_session_thread_failed", {
            sessionId,
            threadId,
            error: resumeError instanceof Error ? resumeError.message : String(resumeError)
          });
          await startFreshCodexThread(managed, runtime, codexPolicy, mcpServers);
        }
      }
    } else if (managed.runtime?.kind === "unified" || (managed.session.modelId && !providerResolver.isModelCliWrapped(managed.session.modelId))) {
      // Unified runtime resume — re-resolve the model
      const result = await startUnifiedSession(managed);
      if (result === "handled" && managed.runtime?.kind === "unified") {
        // Restore message history from persisted state
        const persistedMessages = persisted?.messages;
        if (persistedMessages?.length) {
          managed.runtime.messages = persistedMessages.map((m) => ({ role: m.role, content: m.content }));
        }
        // Restore permission mode
        if (persisted?.permissionMode) {
          managed.runtime.permissionMode = persisted.permissionMode as any;
          managed.session.permissionMode = persisted.permissionMode as any;
        }
        sessionService.setResumeCommand(sessionId, `chat:unified:${sessionId}`);
      } else {
        if (managed.session.provider === "unified") {
          throw new Error(`Unable to resume unified runtime for model '${managed.session.model}'.`);
        }
        // Fallthrough to Claude — SDK manages history via sdkSessionId
        ensureClaudeSessionRuntime(managed);
        sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
      }
    } else {
      // Claude — SDK manages history via sdkSessionId
      ensureClaudeSessionRuntime(managed);
      sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
    }

    sessionService.reopen(sessionId);
    managed.session.status = "idle";
    managed.closed = false;
    managed.endedNotified = false;
    managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? nowIso() : null;

    persistChatState(managed);
    return managed.session;
  };

  const listSessions = async (laneId?: string): Promise<AgentChatSessionSummary[]> => {
    const rows = sessionService.list({ ...(laneId ? { laneId } : {}), limit: 500 });
    const chatRows = rows.filter((row) => isChatToolType(row.toolType));

    return chatRows.map((row) => {
      const persisted = readPersistedState(row.id);
      const provider = persisted?.provider ?? providerFromToolType(row.toolType);
      const fallbackModel = persisted?.model ?? fallbackModelForProvider(provider);
      const hydratedModelId = persisted?.modelId
        ?? resolveModelIdFromStoredValue(fallbackModel, provider)
        ?? (provider === "unified" ? DEFAULT_UNIFIED_MODEL_ID : undefined);
      const model = provider === "unified" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
      return {
        sessionId: row.id,
        laneId: row.laneId,
        provider,
        model,
        ...(hydratedModelId ? { modelId: hydratedModelId } : {}),
        title: row.title ?? null,
        goal: row.goal ?? null,
        reasoningEffort: persisted?.reasoningEffort ?? null,
        executionMode: persisted?.executionMode ?? null,
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        computerUse: normalizePersistedComputerUse(persisted?.computerUse),
        status: row.status === "running" ? "idle" : "ended",
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        lastActivityAt: persisted?.updatedAt ?? row.endedAt ?? row.startedAt,
        lastOutputPreview: row.lastOutputPreview,
        summary: row.summary,
        ...(persisted?.threadId ? { threadId: persisted.threadId } : {})
      } satisfies AgentChatSessionSummary;
    });
  };

  const ensureIdentitySession = async (args: {
    identityKey: AgentChatIdentityKey;
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: AgentChatSession["permissionMode"];
    reuseExisting?: boolean;
  }): Promise<AgentChatSession> => {
    const laneId = args.laneId.trim();
    if (!laneId.length) {
      throw new Error("laneId is required to ensure an identity-bound chat session.");
    }

    const existing = args.reuseExisting === false
      ? []
      : (await listSessions())
          .filter((entry) => entry.identityKey === args.identityKey)
          .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

    const preferred = existing.find((entry) => entry.laneId === laneId) ?? existing[0] ?? null;
    if (preferred) {
      const managed = ensureManagedSession(preferred.sessionId);
      managed.session.identityKey = args.identityKey;
      managed.session.capabilityMode = inferCapabilityMode(managed.session.provider);
      if (args.reasoningEffort) {
        managed.session.reasoningEffort = normalizeReasoningEffort(args.reasoningEffort);
      }
      managed.session.permissionMode = normalizeIdentityPermissionMode(
        args.permissionMode ?? managed.session.permissionMode,
        managed.session.provider,
      );
      refreshReconstructionContext(managed);
      persistChatState(managed);

      if (managed.session.status === "ended") {
        await resumeSession({ sessionId: managed.session.id });
      }
      return ensureManagedSession(managed.session.id).session;
    }

    const ctoIdentity = ctoStateService?.getIdentity();
    const workerAgentId = resolveWorkerIdentityAgentId(args.identityKey);
    const workerIdentity = workerAgentId && workerAgentService
      ? workerAgentService.getAgent(workerAgentId, { includeDeleted: true })
      : null;
    const workerAdapterConfig = workerIdentity?.adapterConfig && typeof workerIdentity.adapterConfig === "object"
      ? workerIdentity.adapterConfig as Record<string, unknown>
      : null;
    const pref = args.identityKey === "cto" ? ctoIdentity?.modelPreferences : null;
    const preferredProviderRaw = (pref?.provider ?? "").trim().toLowerCase();
    const providerFromPreference: AgentChatProvider = (() => {
      if (workerIdentity?.adapterType === "claude-local") return "claude";
      if (workerIdentity?.adapterType === "codex-local") return "codex";
      if (workerIdentity?.adapterType === "openclaw-webhook" || workerIdentity?.adapterType === "process") return "unified";
      if (preferredProviderRaw.includes("codex") || preferredProviderRaw.includes("openai")) return "codex";
      if (preferredProviderRaw.includes("claude") || preferredProviderRaw.includes("anthropic")) return "claude";
      return "unified";
    })();

    const explicitModelId = typeof args.modelId === "string" && args.modelId.trim().length
      ? args.modelId.trim()
      : null;
    const preferredModelId = typeof pref?.modelId === "string" && pref.modelId.trim().length
      ? pref.modelId.trim()
      : typeof workerAdapterConfig?.modelId === "string" && workerAdapterConfig.modelId.trim().length
        ? workerAdapterConfig.modelId.trim()
        : null;
    const resolvedModelId = explicitModelId ?? preferredModelId;
    const resolvedDescriptor = resolvedModelId ? getModelById(resolvedModelId) : undefined;

    const provider: AgentChatProvider = (() => {
      if (!resolvedDescriptor) return providerFromPreference;
      if (!resolvedDescriptor.isCliWrapped) return "unified";
      if (resolvedDescriptor.family === "openai") return "codex";
      if (resolvedDescriptor.family === "anthropic") return "claude";
      return providerFromPreference;
    })();

    const preferredModel = typeof pref?.model === "string" && pref.model.trim().length
      ? pref.model.trim()
      : typeof workerAdapterConfig?.model === "string" && workerAdapterConfig.model.trim().length
        ? workerAdapterConfig.model.trim()
        : fallbackModelForProvider(provider);

    const created = await createSession({
      laneId,
      provider,
      model: preferredModel,
      ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
      reasoningEffort: args.reasoningEffort ?? pref?.reasoningEffort ?? null,
      permissionMode: args.permissionMode ?? "full-auto",
      identityKey: args.identityKey
    });

    const managed = ensureManagedSession(created.id);
    refreshReconstructionContext(managed);
    persistChatState(managed);
    return managed.session;
  };

  const approveToolUse = async ({
    sessionId,
    itemId,
    decision,
    responseText,
  }: {
    sessionId: string;
    itemId: string;
    decision: AgentChatApprovalDecision;
    responseText?: string | null;
  }): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    if (managed.runtime?.kind === "codex") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }

      const mapped = mapApprovalDecisionForCodex(decision);
      managed.runtime.sendResponse(pending.requestId, { decision: mapped });
      managed.runtime.approvals.delete(itemId);
      return;
    }

    if (managed.runtime?.kind === "claude") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.approvals.delete(itemId);
      pending.resolve(decision);
      return;
    }

    if (managed.runtime?.kind === "unified") {
      const pending = managed.runtime.pendingApprovals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      if (decision === "accept_for_session" && pending.category !== "askUser") {
        managed.runtime.approvalOverrides.add(pending.category);
        if (pending.category === "bash") {
          managed.runtime.permissionMode = "full-auto";
          managed.session.permissionMode = "full-auto";
        } else if (managed.runtime.permissionMode === "plan") {
          managed.runtime.permissionMode = "edit";
          managed.session.permissionMode = "edit";
        }
      }
      managed.runtime.pendingApprovals.delete(itemId);
      pending.resolve({ decision, responseText });
      return;
    }

    throw new Error(`Session '${sessionId}' does not have a live runtime for approvals.`);
  };

  const getAvailableModels = async ({ provider }: { provider: AgentChatProvider }): Promise<AgentChatModelInfo[]> => {
    if (provider === "codex") {
      return listCodexModelsFromAppServer();
    }
    if (provider === "claude") {
      return listClaudeModelsFromSdk();
    }

    // For unified/non-CLI providers: return all models with valid auth.
    try {
      const auth = await detectAuth();
      const available = getRegistryModels(auth);
      const targetModels = provider === "unified"
        ? available
        : available.filter(m => m.family === provider);
      if (targetModels.length > 0) {
        return targetModels.map((m, i) => ({
          id: m.id,
          displayName: m.displayName,
          description: `${m.displayName} (${m.family})`,
          isDefault: i === 0,
          reasoningEfforts: m.reasoningTiers?.map(tier => ({
            effort: tier,
            description: `${tier} reasoning`
          })) ?? [],
        }));
      }
    } catch {
      // fallback to empty
    }
    return [];
  };

  const dispose = async ({ sessionId }: AgentChatDisposeArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Interrupt active codex turn before teardown
    if (managed.runtime?.kind === "codex") {
      try {
        if (managed.session.threadId && managed.runtime.activeTurnId) {
          await managed.runtime.request("turn/interrupt", {
            threadId: managed.session.threadId,
            turnId: managed.runtime.activeTurnId
          });
        }
      } catch {
        // ignore interrupt failures while disposing
      }

      // Archive the Codex thread on the server
      if (managed.session.threadId) {
        try {
          await managed.runtime.request("thread/archive", {
            threadId: managed.session.threadId,
          });
        } catch {
          // thread/archive not supported or already archived — ignore
        }
      }
    }

    // Mark streaming runtimes as interrupted so the catch block handles gracefully
    if (managed.runtime?.kind === "claude" || managed.runtime?.kind === "unified") {
      managed.runtime.interrupted = true;
    }

    await finishSession(managed, "disposed", {
      summary: managed.preview ? `Session closed: ${managed.preview}` : "Session closed."
    });
  };

  const disposeAll = async (): Promise<void> => {
    for (const sessionId of [...managedSessions.keys()]) {
      try {
        await dispose({ sessionId });
      } catch {
        // ignore shutdown errors
      }
    }
  };

  const updateSession = async ({
    sessionId,
    modelId,
    reasoningEffort,
    permissionMode,
    computerUse,
  }: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const isIdentitySession = Boolean(managed.session.identityKey);
    const hasConversation = managed.recentConversationEntries.length > 0 || readTranscriptConversationEntries(managed).length > 0;

    if (modelId !== undefined) {
      const nextModelId = String(modelId ?? "").trim();
      if (!nextModelId.length) {
        throw new Error("A modelId is required when updating a chat session model.");
      }

      const descriptor = getModelById(nextModelId) ?? resolveModelAlias(nextModelId);
      if (!descriptor) {
        throw new Error(`Unknown model '${nextModelId}'.`);
      }

      const nextProvider: AgentChatProvider = (() => {
        if (!descriptor.isCliWrapped) return "unified";
        if (descriptor.family === "openai") return "codex";
        if (descriptor.family === "anthropic") return "claude";
        return managed.session.provider;
      })();
      const nextModel = descriptor.isCliWrapped ? descriptor.shortId : descriptor.id;
      const previousModelId = managed.session.modelId
        ?? resolveModelIdFromStoredValue(managed.session.model, managed.session.provider)
        ?? managed.session.model;
      const previousProvider = managed.session.provider;
      const modelSwitchPolicy = managed.session.identityKey === "cto"
        ? "any-after-launch"
        : "same-family-after-launch";

      if (!canSwitchChatSessionModel({
        currentModelId: previousModelId,
        nextModelId: descriptor.id,
        hasConversation,
        policy: modelSwitchPolicy,
      })) {
        throw new Error("This chat can only switch within the same model family after the conversation has started.");
      }

      const modelChanged =
        previousProvider !== nextProvider
        || managed.session.modelId !== descriptor.id
        || managed.session.model !== nextModel;

      if (managed.runtime && modelChanged) {
        teardownRuntime(managed);
        refreshReconstructionContext(managed, { includeConversationTail: true });
      }

      const currentTitle = sessionService.get(sessionId)?.title ?? null;
      managed.session.provider = nextProvider;
      managed.session.modelId = descriptor.id;
      managed.session.model = nextModel;
      managed.session.capabilityMode = inferCapabilityMode(nextProvider);
      if (previousProvider !== nextProvider || previousProvider === "codex") {
        delete managed.session.threadId;
      }
      sessionService.updateMeta({
        sessionId,
        ...(hasCustomChatSessionTitle(currentTitle, previousProvider)
          ? {}
          : { title: defaultChatSessionTitle(nextProvider) }),
        toolType: toolTypeFromProvider(nextProvider),
        resumeCommand: resumeCommandForProvider(nextProvider, sessionId)
      });

      if (isIdentitySession) {
        managed.session.permissionMode = normalizeIdentityPermissionMode(
          managed.session.permissionMode,
          nextProvider,
        );
      }

      // Apply reasoningEffort BEFORE pre-warming so the V2 session is created
      // with the correct thinking configuration.
      if (reasoningEffort !== undefined) {
        managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      }

      // Pre-warm the Claude V2 session when the user selects an Anthropic model.
      // This gives natural warmup time while the user types their message.
      if (modelChanged && nextProvider === "claude") {
        ensureClaudeSessionRuntime(managed);
        prewarmClaudeV2Session(managed);
      }
    } else if (reasoningEffort !== undefined) {
      const prev = managed.session.reasoningEffort ?? null;
      managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      const next = managed.session.reasoningEffort ?? null;
      // When reasoning effort changes on a Claude session with an active V2
      // session, invalidate the V2 session so it is recreated on the next turn
      // with the updated thinking configuration.
      if (prev !== next && managed.runtime?.kind === "claude" && managed.runtime.v2Session) {
        managed.runtime.v2Session.close();
        managed.runtime.v2Session = null;
        managed.runtime.v2WarmupDone = null;
      }
    }

    if (permissionMode !== undefined) {
      managed.session.permissionMode = isIdentitySession
        ? normalizeIdentityPermissionMode(permissionMode, managed.session.provider)
        : permissionMode;
      if (managed.runtime?.kind === "unified") {
        managed.runtime.permissionMode = mapToUnifiedPermissionMode(managed.session.permissionMode) ?? "edit";
      }
    }

    if (computerUse !== undefined) {
      managed.session.computerUse = normalizeComputerUsePolicy(computerUse, createDefaultComputerUsePolicy());
    }

    persistChatState(managed);
    return managed.session;
  };

  /**
   * Trigger early warmup of the Claude V2 session for an existing chat session.
   * Called from the renderer when the user selects a Claude/Anthropic model in the
   * model picker — before they've submitted a message — so the ~30s subprocess
   * cold-start happens while they're still composing.
   */
  const warmupModel = async ({
    sessionId,
    modelId,
  }: {
    sessionId: string;
    modelId: string;
  }): Promise<void> => {
    const managed = managedSessions.get(sessionId);
    if (!managed) return;

    const descriptor = getModelById(modelId) ?? resolveModelAlias(modelId);
    if (!descriptor) return;

    const isAnthropicCli = descriptor.family === "anthropic" && descriptor.isCliWrapped;
    if (!isAnthropicCli) return;

    // Only prewarm if the session is idle (not mid-turn) and not already warmed
    if (managed.runtime?.kind === "claude" && managed.runtime.v2WarmupDone) return;

    // Apply the selected model to the session so buildClaudeV2SessionOpts
    // picks up the correct model for warmup.
    managed.session.provider = "claude";
    managed.session.modelId = descriptor.id;
    managed.session.model = descriptor.shortId;

    // Ensure a Claude runtime exists and kick off pre-warming
    ensureClaudeSessionRuntime(managed);
    prewarmClaudeV2Session(managed);
  };

  const listContextPacks = async (args: { laneId?: string } = {}): Promise<import("../../../shared/types").ContextPackOption[]> => {
    const packs: import("../../../shared/types").ContextPackOption[] = [
      { scope: "project", label: "Project", description: "Live project context export", available: Boolean(packService) },
    ];

    if (args.laneId) {
      packs.push(
        { scope: "lane", label: "Lane", description: "Live lane context export", available: Boolean(packService), laneId: args.laneId },
        { scope: "conflict", label: "Conflicts", description: "Live conflict context export", available: Boolean(packService), laneId: args.laneId },
        { scope: "plan", label: "Plan", description: "Live plan context export", available: Boolean(packService), laneId: args.laneId }
      );
    }

    packs.push(
      {
        scope: "mission",
        label: "Mission",
        description: "Mission-scoped export requires an explicit mission selection and is not wired into this picker yet",
        available: false
      }
    );

    return packs;
  };

  const fetchContextPack = async (args: import("../../../shared/types").ContextPackFetchArgs): Promise<import("../../../shared/types").ContextPackFetchResult> => {
    const MAX_CHARS = 50_000;
    let content = "";
    let truncated = false;
    const level = args.level === "brief" ? "lite" : args.level === "detailed" ? "deep" : "standard";

    try {
      if (!packService) {
        throw new Error("Live context export service is unavailable.");
      }

      const exportResult = await (async () => {
        if (args.scope === "project") return await packService.getProjectExport({ level });
        if (args.scope === "lane") {
          if (!args.laneId?.trim()) throw new Error("Lane context requires laneId.");
          return await packService.getLaneExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "conflict") {
          if (!args.laneId?.trim()) throw new Error("Conflict context requires laneId.");
          return await packService.getConflictExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "plan") {
          if (!args.laneId?.trim()) throw new Error("Plan context requires laneId.");
          return await packService.getPlanExport({ laneId: args.laneId.trim(), level });
        }
        if (args.scope === "feature") {
          if (!args.featureKey?.trim()) throw new Error("Feature context requires featureKey.");
          return await packService.getFeatureExport({ featureKey: args.featureKey.trim(), level });
        }
        if (!args.missionId?.trim()) throw new Error("Mission context requires missionId.");
        return await packService.getMissionExport({ missionId: args.missionId.trim(), level });
      })();

      content = exportResult.content;
      truncated = exportResult.truncated;

      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS);
        truncated = true;
      }
    } catch (error) {
      content = `Failed to fetch ${args.scope} context: ${error instanceof Error ? error.message : String(error)}`;
    }

    return { scope: args.scope, content, truncated };
  };

  const changePermissionMode = ({ sessionId, permissionMode }: import("../../../shared/types").AgentChatChangePermissionModeArgs): void => {
    const managed = ensureManagedSession(sessionId);
    const nextMode = managed.session.identityKey
      ? normalizeIdentityPermissionMode(permissionMode, managed.session.provider)
      : permissionMode;

    if (managed.runtime?.kind === "unified") {
      managed.runtime.permissionMode = mapToUnifiedPermissionMode(nextMode) ?? "edit";
    }

    managed.session.permissionMode = nextMode;
    persistChatState(managed);

    logger.info("agent_chat.permission_mode_changed", {
      sessionId,
      permissionMode: nextMode,
    });
  };

  const getSlashCommands = ({ sessionId }: import("../../../shared/types").AgentChatSlashCommandsArgs): import("../../../shared/types").AgentChatSlashCommand[] => {
    const managed = managedSessions.get(sessionId);
    if (!managed) return [];
    const provider = managed.session.provider;

    // Local commands available to all providers
    const localCommands: import("../../../shared/types").AgentChatSlashCommand[] = [
      { name: "/clear", description: "Clear chat history", source: "local" },
    ];

    // Claude SDK commands
    if (provider === "claude" && managed.runtime?.kind === "claude") {
      const rt = managed.runtime;
      const sdkCmds: import("../../../shared/types").AgentChatSlashCommand[] = rt.slashCommands.map((cmd: { name: string; description: string; argumentHint?: string }) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        source: "sdk" as const,
      }));
      // Merge: SDK commands first, then local commands that don't conflict
      const sdkNames = new Set(sdkCmds.map((c: import("../../../shared/types").AgentChatSlashCommand) => c.name));
      return [...sdkCmds, ...localCommands.filter((c) => !sdkNames.has(c.name))];
    }

    // Codex SDK commands
    if (provider === "codex" && managed.runtime?.kind === "codex") {
      const rt = managed.runtime;
      const sdkCmds: import("../../../shared/types").AgentChatSlashCommand[] = rt.slashCommands.map((cmd: { name: string; description: string; argumentHint?: string }) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        source: "sdk" as const,
      }));
      // Add /review as a built-in Codex command if not already in skills
      if (!sdkCmds.some((c) => c.name === "/review")) {
        sdkCmds.push({ name: "/review", description: "Review uncommitted changes", source: "sdk" as const });
      }
      const sdkNames = new Set(sdkCmds.map((c: import("../../../shared/types").AgentChatSlashCommand) => c.name));
      return [...sdkCmds, ...localCommands.filter((c) => !sdkNames.has(c.name))];
    }

    // Unified — only local commands
    return localCommands;
  };

  const codexFuzzyFileSearch = async ({ sessionId, query }: { sessionId: string; query: string }): Promise<Array<{ path: string; score?: number }>> => {
    const managed = managedSessions.get(sessionId);
    if (!managed || managed.runtime?.kind !== "codex") return [];
    try {
      const result = await managed.runtime.request<{ files?: Array<{ path?: string; score?: number }> }>("fuzzyFileSearch", {
        query,
        rootDirs: [managed.laneWorktreePath],
        limit: 60,
      });
      if (!Array.isArray(result?.files)) return [];
      return result.files
        .filter((f): f is { path: string; score?: number } => typeof f?.path === "string")
        .map((f) => ({ path: f.path, score: f.score }));
    } catch {
      return []; // fuzzyFileSearch not supported
    }
  };

  const runSessionTurn = async ({
    sessionId,
    text,
    displayText,
    attachments = [],
    reasoningEffort,
    executionMode,
    timeoutMs = 300_000,
  }: AgentChatSendArgs & { timeoutMs?: number }): Promise<{
    sessionId: string;
    provider: AgentChatProvider;
    model: string;
    modelId?: string;
    outputText: string;
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheCreationTokens?: number | null;
    };
    turnId?: string;
    threadId?: string;
    sdkSessionId?: string | null;
  }> => {
    if (sessionTurnCollectors.has(sessionId)) {
      throw new Error(`Session '${sessionId}' already has an active background turn.`);
    }

    const safeTimeoutMs = Math.max(15_000, Math.floor(timeoutMs));
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sessionTurnCollectors.delete(sessionId);
        reject(new Error(`Timed out waiting for session '${sessionId}' to finish the current turn.`));
      }, safeTimeoutMs);

      sessionTurnCollectors.set(sessionId, {
        resolve,
        reject,
        outputText: "",
        lastError: null,
        timeout,
      });

      void sendMessage({
        sessionId,
        text,
        displayText,
        attachments,
        reasoningEffort,
        executionMode,
      }).catch((error) => {
        clearTimeout(timeout);
        sessionTurnCollectors.delete(sessionId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  return {
    createSession,
    sendMessage,
    runSessionTurn,
    steer,
    interrupt,
    resumeSession,
    listSessions,
    ensureIdentitySession,
    approveToolUse,
    getAvailableModels,
    getSlashCommands,
    codexFuzzyFileSearch,
    dispose,
    disposeAll,
    updateSession,
    warmupModel,
    listContextPacks,
    fetchContextPack,
    changePermissionMode,
    setComputerUseArtifactBrokerService(svc: ComputerUseArtifactBrokerService) {
      computerUseArtifactBrokerRef = svc;
    },
  };
}
