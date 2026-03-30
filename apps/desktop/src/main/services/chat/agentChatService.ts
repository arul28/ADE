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
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import type { Query as ClaudeSDKQuery, SDKMessage, SDKUserMessage, Options as ClaudeSDKOptions, PermissionResult as ClaudePermissionResult } from "@anthropic-ai/claude-agent-sdk";

type ClaudeV2Session = {
  send: (msg: string | Partial<SDKUserMessage>) => Promise<void>;
  stream: () => AsyncGenerator<SDKMessage, void>;
  close: () => void;
  readonly sessionId: string;
  setPermissionMode?: (mode: AgentChatClaudePermissionMode) => Promise<void>;
};
import { buildClaudeV2Message, inferAttachmentMediaType } from "./buildClaudeV2Message";
import {
  appendBufferedAssistantText,
  canAppendBufferedAssistantText,
  shouldFlushBufferedAssistantTextForEvent,
  type BufferedAssistantText,
} from "./chatTextBatching";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createFileService } from "../files/fileService";
import type { createProcessService } from "../processes/processService";
import { runGit } from "../git/git";
import { CLAUDE_RUNTIME_AUTH_ERROR, isClaudeRuntimeAuthError } from "../ai/claudeRuntimeProbe";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { fileSizeOrZero, isEnoentError, nowIso, readFileWithinRootSecure, resolvePathWithinRoot } from "../shared/utils";
import type { EpisodicSummaryService } from "../memory/episodicSummaryService";
import {
  createDefaultComputerUsePolicy,
  normalizeComputerUsePolicy,
} from "../../../shared/types";
import type {
  AgentChatApprovalDecision,
  AgentChatClaudePermissionMode,
  AgentChatCompletionReport,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
  AgentChatExecutionMode,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatIdentityKey,
  AgentChatInteractionMode,
  AgentChatInterruptArgs,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatRespondToInputArgs,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatSubagentListArgs,
  AgentChatSubagentSnapshot,
  AgentChatSurface,
  AgentChatSteerArgs,
  AgentChatSendArgs,
  AgentChatUnifiedPermissionMode,
  PendingInputQuestion,
  PendingInputRequest,
  AgentChatUpdateSessionArgs,
  ComputerUseBackendStatus,
  ComputerUsePolicy,
  ThinkingLevel,
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
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { canSwitchChatSessionModel } from "../../../shared/chatModelSwitching";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";
import { createUniversalToolSet, type PermissionMode } from "../ai/tools/universalTools";
import { createWorkflowTools } from "../ai/tools/workflowTools";
import { createLinearTools } from "../ai/tools/linearTools";
import { createCtoOperatorTools } from "../ai/tools/ctoOperatorTools";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { resolveClaudeCliModel } from "../ai/claudeModelUtils";
import {
  getProviderRuntimeHealth,
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "../ai/providerRuntimeHealth";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { createMemoryService, Memory } from "../memory/memoryService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import type { IssueTracker } from "../cto/issueTracker";
import type { createFlowPolicyService } from "../cto/flowPolicyService";
import type { createLinearDispatcherService } from "../cto/linearDispatcherService";
import type { LinearClient } from "../cto/linearClient";
import type { LinearCredentialService } from "../cto/linearCredentialService";
import type { createPrService } from "../prs/prService";
import type { ComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { createProofObserver } from "../computerUse/proofObserver";
import { resolveAdeMcpServerLaunch, resolveUnifiedRuntimeRoot } from "../orchestrator/unifiedOrchestratorAdapter";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { MemoryWriteEvent, TurnMemoryPolicyState } from "../ai/tools/memoryTools";

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

type PersistedClaudeMessage = {
  role: "user" | "assistant";
  content: string;
};

type PersistedRecentConversationEntry = {
  role: "user" | "assistant";
  text: string;
  turnId?: string;
};

type PersistedChatState = {
  version: 1 | 2;
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  modelId?: string;
  sessionProfile?: "light" | "workflow";
  reasoningEffort?: string | null;
  executionMode?: AgentChatExecutionMode | null;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  permissionMode?: AgentChatSession["permissionMode"];
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  computerUse?: ComputerUsePolicy;
  completion?: AgentChatCompletionReport | null;
  threadId?: string;
  sdkSessionId?: string;
  messages?: PersistedClaudeMessage[];
  recentConversationEntries?: PersistedRecentConversationEntry[];
  continuitySummary?: string | null;
  continuitySummaryUpdatedAt?: string | null;
  preferredExecutionLaneId?: string | null;
  selectedExecutionLaneId?: string | null;
  updatedAt: string;
};

type PendingRpc = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type PendingCodexApproval = {
  requestId: string | number;
  kind: "command" | "file_change" | "permissions" | "structured_question" | "plan_approval";
  request?: PendingInputRequest;
  permissions?: Record<string, unknown> | null;
};

type PendingClaudeApproval = {
  kind: "approval" | "question";
  questionIds?: string[];
  resolve: (response: { decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null }) => void;
  request?: PendingInputRequest;
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
  itemTurnIdByItemId: Map<string, string>;
  commandOutputByItemId: Map<string, string>;
  fileDeltaByItemId: Map<string, string>;
  fileChangesByItemId: Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>;
  agentMessageScopeByTurn: Map<string, "item" | "turn">;
  agentMessageTextByTurn: Map<string, string>;
  recentNotificationKeys: Set<string>;
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
  activeQuery: ClaudeSDKQuery | null;
  v2Session: ClaudeV2Session | null;
  /** Single stream generator kept alive across turns (never closed by for-await). */
  v2StreamGen: AsyncGenerator<any, void> | null;
  /** Resolves when the subprocess is initialized (system:init received). */
  v2WarmupDone: Promise<void> | null;
  /** Resolves the current warmup race so waiters can stop blocking immediately. */
  v2WarmupCancel: (() => void) | null;
  /** Set to true when teardown runs to cancel an in-flight warmup. */
  v2WarmupCancelled: boolean;
  activeSubagents: Map<string, { taskId: string; description: string }>;
  slashCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  busy: boolean;
  activeTurnId: string | null;
  pendingSteers: string[];
  approvals: Map<string, PendingClaudeApproval>;
  interrupted: boolean;
  /** Set when a reasoning effort change is requested mid-turn; flushed when idle. */
  pendingSessionReset?: boolean;
  turnMemoryPolicyState: TurnMemoryPolicyState | null;
};

type PendingUnifiedApproval = {
  category: "bash" | "write" | "askUser" | "exitPlanMode";
  request?: PendingInputRequest;
  resolve: (response: { decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null }) => void;
};

type UnifiedRuntime = {
  kind: "unified";
  messages: Array<{ role: string; content: string }>;
  busy: boolean;
  abortController: AbortController | null;
  activeTurnId: string | null;
  permissionMode: PermissionMode;
  pendingApprovals: Map<string, PendingUnifiedApproval>;
  approvalOverrides: Set<"bash" | "write" | "exitPlanMode">;
  pendingSteers: string[];
  interrupted: boolean;
  resolvedModel: LanguageModel;
  modelDescriptor: ModelDescriptor;
};

type ChatRuntime = CodexRuntime | ClaudeRuntime | UnifiedRuntime;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickCodexTurnId(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function extractCodexTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nestedTurn = asRecord(record.turn);
  return pickCodexTurnId(record.turnId, record.turn_id, nestedTurn?.id);
}

function readCodexNotificationItemId(params: Record<string, unknown>): string | null {
  const nestedItem = asRecord(params.item);
  return pickCodexTurnId(params.itemId, nestedItem?.id) ?? null;
}

function codexNotificationDedupKey(payload: JsonRpcEnvelope): string | null {
  const method = typeof payload.method === "string" ? payload.method : "";
  const params = asRecord(payload.params) ?? {};

  switch (method) {
    case "item/started":
    case "codex/event/item_started": {
      const itemId = readCodexNotificationItemId(params);
      return itemId ? `item_started:${itemId}` : null;
    }
    case "item/completed":
    case "codex/event/item_completed": {
      const itemId = readCodexNotificationItemId(params);
      return itemId ? `item_completed:${itemId}` : null;
    }
    case "turn/aborted":
    case "codex/event/turn_aborted": {
      const turnId = extractCodexTurnId(params);
      return turnId ? `turn_aborted:${turnId}` : null;
    }
    default:
      return null;
  }
}

function shouldSkipDuplicateCodexNotification(runtime: CodexRuntime, payload: JsonRpcEnvelope): boolean {
  const key = codexNotificationDedupKey(payload);
  if (!key) return false;
  if (runtime.recentNotificationKeys.has(key)) return true;
  runtime.recentNotificationKeys.add(key);
  if (runtime.recentNotificationKeys.size > 2048) {
    runtime.recentNotificationKeys.clear();
    runtime.recentNotificationKeys.add(key);
  }
  return false;
}

function discardBufferedAssistantText(managed: ManagedChatSession): void {
  const buffered = managed.bufferedText;
  if (!buffered) return;
  if (buffered.timer) {
    clearTimeout(buffered.timer);
  }
  managed.bufferedText = null;
  managed.activeAssistantMessageId = null;
}

function resetAssistantMessageStream(managed: ManagedChatSession): void {
  managed.activeAssistantMessageId = null;
}

function ensureAssistantMessageId(
  managed: ManagedChatSession,
  event: Extract<AgentChatEvent, { type: "text" }>,
): Extract<AgentChatEvent, { type: "text" }> {
  const explicitMessageId = event.messageId?.trim() || null;
  if (explicitMessageId) {
    managed.activeAssistantMessageId = explicitMessageId;
    return explicitMessageId === event.messageId ? event : { ...event, messageId: explicitMessageId };
  }

  const activeMessageId = managed.activeAssistantMessageId ?? randomUUID();
  managed.activeAssistantMessageId = activeMessageId;
  return { ...event, messageId: activeMessageId };
}

function ensureLogicalItemId<T extends { itemId: string; logicalItemId?: string }>(event: T): T {
  const explicitLogicalItemId = event.logicalItemId?.trim() || null;
  if (explicitLogicalItemId) {
    return explicitLogicalItemId === event.logicalItemId ? event : { ...event, logicalItemId: explicitLogicalItemId };
  }

  const fallbackLogicalItemId = event.itemId.trim();
  if (!fallbackLogicalItemId.length) return event;
  return { ...event, logicalItemId: fallbackLogicalItemId };
}

function isCurrentCodexLifecycleTurn(
  runtime: CodexRuntime,
  turnId: string | null | undefined,
): boolean {
  const activeTurnId = runtime.activeTurnId ?? runtime.startedTurnId;
  if (!activeTurnId || !turnId) return true;
  return activeTurnId === turnId;
}

function normalizeCodexAssistantDelta(
  runtime: CodexRuntime,
  args: {
    turnId?: string;
    itemId?: string;
    delta: string;
  },
): string | null {
  const turnId = args.turnId?.trim() || null;
  if (!turnId || args.itemId) {
    return args.delta;
  }

  const knownText = runtime.agentMessageTextByTurn.get(turnId) ?? "";
  if (!knownText.length) {
    runtime.agentMessageTextByTurn.set(turnId, args.delta);
    return args.delta;
  }

  if (args.delta.startsWith(knownText)) {
    const suffix = args.delta.slice(knownText.length);
    runtime.agentMessageTextByTurn.set(turnId, args.delta);
    return suffix.length ? suffix : null;
  }

  const nextText = `${knownText}${args.delta}`;
  runtime.agentMessageTextByTurn.set(turnId, nextText);
  return args.delta;
}

function validateSessionReadyForTurn(managed: ManagedChatSession): { ready: true } | { ready: false; reason: string } {
  if (managed.closed) return { ready: false, reason: "Session is disposed" };
  if (!managed.runtime) return { ready: false, reason: "No runtime initialized" };
  const rt = managed.runtime;
  if ((rt.kind === "unified" || rt.kind === "claude") && rt.busy) return { ready: false, reason: "Turn already active" };
  if (rt.kind === "unified" && rt.pendingApprovals.size > 0) return { ready: false, reason: "Pending approvals not resolved" };
  return { ready: true };
}

function trimLine(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>, limit = values.length): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = trimLine(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

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
  summaryInFlight: boolean;
  activeAssistantMessageId: string | null;
  lastActivitySignature: string | null;
  bufferedReasoning: {
    text: string;
    turnId?: string;
    itemId?: string;
    summaryIndex?: number;
  } | null;
  previewTextBuffer: {
    text: string;
    messageId?: string;
    turnId?: string;
    itemId?: string;
  } | null;
  bufferedText: (BufferedAssistantText & { timer: NodeJS.Timeout | null }) | null;
  recentConversationEntries: Array<{
    role: "user" | "assistant";
    text: string;
    turnId?: string;
  }>;
  continuitySummary: string | null;
  continuitySummaryUpdatedAt: string | null;
  continuitySummaryInFlight: boolean;
  preferredExecutionLaneId: string | null;
  selectedExecutionLaneId: string | null;
  localPendingInputs: Map<string, {
    request: PendingInputRequest;
    resolve: (response: {
      decision?: AgentChatApprovalDecision;
      answers?: Record<string, string | string[]>;
      responseText?: string | null;
    }) => void;
  }>;
  eventSequence: number;
};

type AgentChatTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  turnId?: string;
};

type HandoffArtifacts = {
  commands: string[];
  fileChanges: string[];
  errors: string[];
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

type PreparedSendMessage = {
  sessionId: string;
  managed: ManagedChatSession;
  promptText: string;
  visibleText: string;
  attachments: AgentChatFileRef[];
  resolvedAttachments: ResolvedAgentChatFileRef[];
  reasoningEffort?: string | null;
  interactionMode?: AgentChatInteractionMode | null;
  onDispatched?: () => void;
};

type ResolvedAgentChatFileRef = AgentChatFileRef & {
  _resolvedPath: string;
  _rootPath: string;
};

type ResolvedChatConfig = {
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandboxMode: AgentChatCodexSandbox;
  claudePermissionMode: AgentChatClaudePermissionMode;
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
  sessionBudgetUsd: number | null;
  autoTitleEnabled: boolean;
  autoTitleModelId: string | null;
  autoTitleRefreshOnComplete: boolean;
  summaryEnabled: boolean;
  summaryModelId: string | null;
};

const MAX_PENDING_STEERS = 10;

const DEFAULT_CODEX_DESCRIPTOR = getDefaultModelDescriptor("codex");
const DEFAULT_CLAUDE_DESCRIPTOR = getDefaultModelDescriptor("claude");
const DEFAULT_UNIFIED_DESCRIPTOR = getDefaultModelDescriptor("unified");
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_DESCRIPTOR?.sdkModelId ?? "gpt-5.4";
const DEFAULT_CLAUDE_MODEL = DEFAULT_CLAUDE_DESCRIPTOR?.sdkModelId ?? DEFAULT_CLAUDE_DESCRIPTOR?.shortId ?? "sonnet";
const DEFAULT_UNIFIED_MODEL_ID = DEFAULT_UNIFIED_DESCRIPTOR?.id ?? "anthropic/claude-sonnet-4-6-api";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_AUTO_TITLE_MODEL_ID = "anthropic/claude-haiku-4-5-api";
const MAX_CHAT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const BUFFERED_TEXT_FLUSH_MS = 100;
const CHAT_TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n";
const DEFAULT_TRANSCRIPT_READ_LIMIT = 20;
const MAX_TRANSCRIPT_READ_LIMIT = 100;
const DEFAULT_TRANSCRIPT_READ_CHARS = 8_000;
const MAX_TRANSCRIPT_READ_CHARS = 40_000;
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
  { effort: "max", description: "Maximum reasoning depth. Best for Opus on hard problems." },
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
  claude: {},
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

function isBackgroundTask(item: Record<string, unknown>): boolean {
  return !!(item.run_in_background || item.background);
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
    attachments: ResolvedAgentChatFileRef[];
    runtimeKind: "claude" | "unified";
    modelDescriptor?: ModelDescriptor;
    logger?: Logger;
  },
): UserContent {
  if (!args.attachments.length) {
    return args.baseText;
  }

  const parts: Array<{ type: "text"; text: string } | ImagePart | FilePart> = [
    { type: "text", text: args.baseText },
  ];

  for (const attachment of args.attachments) {
    try {
      const data = readFileWithinRootSecure(attachment._rootPath, attachment._resolvedPath);
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
          filename: path.basename(attachment._resolvedPath) || undefined,
          mediaType,
        });
        continue;
      }

      parts.push({
        type: "text",
        text: `\nAttached file: ${attachment.path}`,
      });
    } catch (error) {
      if (isEnoentError(error)) {
        parts.push({ type: "text", text: `\nAttachment missing: ${attachment.path}` });
        continue;
      }
      args.logger?.warn("agent_chat.streaming_attachment_unavailable", {
        attachmentPath: attachment.path,
        resolvedPath: attachment._resolvedPath,
        rootPath: attachment._rootPath,
        error,
      });
      parts.push({
        type: "text",
        text: `\nAttachment unavailable: ${attachment.path}`,
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

function buildClaudeInteractionModeDirective(
  mode: AgentChatInteractionMode | null | undefined,
  provider: AgentChatProvider,
): string | null {
  if (provider !== "claude" || mode !== "plan") return null;
  return [
    "[ADE launch directive]",
    "You are in plan mode for this turn.",
    "Stay inspect-only: analyze the request, outline the implementation, surface risks, and do not make edits or run commands.",
  ].join("\n");
}

function composeLaunchDirectives(baseText: string, directives: Array<string | null | undefined>): string {
  const filtered = directives
    .map((directive) => (typeof directive === "string" ? directive.trim() : ""))
    .filter((directive) => directive.length > 0);
  if (filtered.length === 0) return baseText;
  return `${filtered.join("\n\n")}\n\nUser request:\n${baseText}`;
}

function extractSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [command] = trimmed.split(/\s+/, 1);
  return command?.trim().toLowerCase() || null;
}

function isLiteralSlashCommand(text: string): boolean {
  return extractSlashCommand(text) != null;
}

export function buildComputerUseDirective(
  policy: ComputerUsePolicy | null | undefined,
  backendStatus: ComputerUseBackendStatus | null,
): string | null {
  const effective = createDefaultComputerUsePolicy(policy ?? undefined);

  const hasExternalBackends = backendStatus
    ? backendStatus.backends.some((b) => b.available)
    : false;
  const hasLocalFallback = effective.allowLocalFallback;

  // No backends and no local fallback → skip the directive entirely.
  if (!hasExternalBackends && !hasLocalFallback && backendStatus != null) {
    return null;
  }

  const sections: string[] = [];

  // --- Header (always when we have any capability) ---
  sections.push(
    [
      "## Computer Use",
      "You have computer-use capabilities available. ADE will automatically capture screenshots and other artifacts from your tool calls into the proof drawer — you do not need to manually call ingest_computer_use_artifacts.",
      "",
      "Call `get_computer_use_backend_status` to check available backends before attempting computer use.",
    ].join("\n"),
  );

  // --- Ghost OS section (only if a Ghost OS backend is detected) ---
  const ghostOsBackend = backendStatus?.backends.find(
    (b) => b.available && /ghost/i.test(b.name),
  );
  if (ghostOsBackend) {
    sections.push(
      [
        "### Ghost OS (Desktop Automation)",
        "Ghost OS is available for full desktop and browser automation. You can:",
        "- See any app: ghost_screenshot, ghost_annotate, ghost_context, ghost_find, ghost_read",
        "- Control any app: ghost_click, ghost_type, ghost_press, ghost_hotkey, ghost_scroll, ghost_drag",
        "- Automate workflows: ghost_recipes, ghost_run",
        "",
        "Tips:",
        "- Always call ghost_context before interacting with an app to orient yourself",
        "- For Electron dev apps (like ADE itself), the app may register as \"Electron\" — use ghost_find or text queries rather than app-targeted commands",
        "- Use ghost_annotate for a labeled screenshot with clickable coordinates",
        "- For web apps in Chrome, prefer dom_id for clicking elements",
        "- Use ghost_wait after clicks in web apps to wait for state changes",
      ].join("\n"),
    );
  }

  // --- agent-browser section (only if detected) ---
  const agentBrowserBackend = backendStatus?.backends.find(
    (b) => b.available && /agent-browser/i.test(b.name),
  );
  if (agentBrowserBackend) {
    sections.push(
      [
        "### agent-browser (Browser Automation)",
        "agent-browser is available for browser automation. Use it for web interactions, form filling, screenshots, and trace capture.",
      ].join("\n"),
    );
  }

  // --- Local fallback section ---
  if (hasLocalFallback) {
    sections.push(
      [
        "### ADE Local (Fallback)",
        "ADE local screenshot capture is available as a fallback if external backends are unavailable.",
      ].join("\n"),
    );
  }

  // --- Proof instructions (always) ---
  sections.push(
    [
      "### Proof Capture",
      "ADE automatically captures artifacts from your computer-use tool calls. Screenshots, recordings, and traces are saved to the proof drawer automatically. You can also explicitly call `ingest_computer_use_artifacts` if you need to add additional context or artifacts from non-standard sources.",
    ].join("\n"),
  );

  return sections.join("\n\n");
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
const VALID_INTERACTION_MODES = new Set(["default", "plan"]);
const VALID_CLAUDE_PERMISSION_MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);
const VALID_CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "on-failure", "never"]);
const VALID_CODEX_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const VALID_CODEX_CONFIG_SOURCES = new Set(["flags", "config-toml"]);
const VALID_UNIFIED_PERMISSION_MODES = new Set(["plan", "edit", "full-auto"]);

function normalizePersistedEnum<T extends string>(value: unknown, validSet: Set<string>): T | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return validSet.has(trimmed) ? trimmed as T : undefined;
}

function normalizePersistedPermissionMode(value: unknown): AgentChatSession["permissionMode"] | undefined {
  return normalizePersistedEnum(value, VALID_PERMISSION_MODES);
}

function normalizePersistedClaudePermissionMode(value: unknown): AgentChatClaudePermissionMode | undefined {
  return normalizePersistedEnum(value, VALID_CLAUDE_PERMISSION_MODES);
}

function normalizePersistedCodexApprovalPolicy(value: unknown): AgentChatCodexApprovalPolicy | undefined {
  return normalizePersistedEnum(value, VALID_CODEX_APPROVAL_POLICIES);
}

function normalizePersistedCodexSandbox(value: unknown): AgentChatCodexSandbox | undefined {
  return normalizePersistedEnum(value, VALID_CODEX_SANDBOXES);
}

function normalizePersistedCodexConfigSource(value: unknown): AgentChatCodexConfigSource | undefined {
  return normalizePersistedEnum(value, VALID_CODEX_CONFIG_SOURCES);
}

function normalizePersistedUnifiedPermissionMode(value: unknown): AgentChatUnifiedPermissionMode | undefined {
  return normalizePersistedEnum(value, VALID_UNIFIED_PERMISSION_MODES);
}

function legacyPermissionModeToClaudePermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatClaudePermissionMode | undefined {
  if (!mode) return undefined;
  return mapPermissionToClaude(mode);
}

type AgentChatClaudeAccessMode = Exclude<AgentChatClaudePermissionMode, "plan">;

function normalizeClaudeAccessMode(value: AgentChatClaudePermissionMode | undefined): AgentChatClaudeAccessMode | undefined {
  if (value === "default" || value === "acceptEdits" || value === "bypassPermissions") {
    return value;
  }
  return undefined;
}

function resolveSessionClaudeInteractionMode(
  session: Pick<AgentChatSession, "interactionMode" | "claudePermissionMode" | "permissionMode">,
): AgentChatInteractionMode {
  return session.interactionMode
    ?? (session.claudePermissionMode === "plan" ? "plan" : undefined)
    ?? (session.permissionMode === "plan" ? "plan" : undefined)
    ?? "default";
}

function resolveSessionClaudeAccessMode(
  session: Pick<AgentChatSession, "claudePermissionMode" | "permissionMode">,
  fallback: AgentChatClaudePermissionMode,
): AgentChatClaudeAccessMode {
  return normalizeClaudeAccessMode(session.claudePermissionMode)
    ?? normalizeClaudeAccessMode(legacyPermissionModeToClaudePermissionMode(session.permissionMode))
    ?? normalizeClaudeAccessMode(fallback)
    ?? "default";
}

function legacyPermissionModeToCodexApprovalPolicy(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatCodexApprovalPolicy | undefined {
  if (!mode) return undefined;
  if (mode === "config-toml") return undefined;
  return mapPermissionToCodex(mode)?.approvalPolicy;
}

function legacyPermissionModeToCodexSandbox(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatCodexSandbox | undefined {
  if (!mode) return undefined;
  if (mode === "config-toml") return undefined;
  return mapPermissionToCodex(mode)?.sandbox;
}

function legacyPermissionModeToCodexConfigSource(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatCodexConfigSource | undefined {
  if (!mode) return undefined;
  return mode === "config-toml" ? "config-toml" : "flags";
}

function legacyPermissionModeToUnifiedPermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatUnifiedPermissionMode | undefined {
  if (!mode) return undefined;
  return mode === "default" || mode === "config-toml" ? "edit" : mapToUnifiedPermissionMode(mode);
}

function syncLegacyPermissionMode(session: Pick<
  AgentChatSession,
  "provider" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode"
>): AgentChatSession["permissionMode"] | undefined {
  if (session.provider === "claude") {
    if (session.interactionMode === "plan") {
      return "plan";
    }
    switch (normalizeClaudeAccessMode(session.claudePermissionMode)) {
      case "default":
        return "default";
      case "acceptEdits":
        return "edit";
      case "bypassPermissions":
        return "full-auto";
      default:
        return undefined;
    }
  }

  if (session.provider === "codex") {
    if (session.codexConfigSource === "config-toml") return "config-toml";
    if (session.codexApprovalPolicy === "never" && session.codexSandbox === "danger-full-access") return "full-auto";
    if (session.codexApprovalPolicy === "on-failure" && session.codexSandbox === "workspace-write") return "edit";
    if (session.codexApprovalPolicy === "untrusted" && session.codexSandbox === "read-only") return "plan";
    return undefined;
  }

  switch (session.unifiedPermissionMode) {
    case "plan":
    case "edit":
    case "full-auto":
      return session.unifiedPermissionMode;
    default:
      return undefined;
  }
}

function applyLegacyPermissionModeToNativeControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode"
  >,
  mode: AgentChatSession["permissionMode"] | undefined,
): void {
  session.permissionMode = mode;
  if (!mode) return;

  if (session.provider === "claude") {
    session.interactionMode = mode === "plan" ? "plan" : "default";
    session.claudePermissionMode = normalizeClaudeAccessMode(legacyPermissionModeToClaudePermissionMode(mode)) ?? "default";
    return;
  }

  if (session.provider === "codex") {
    session.codexApprovalPolicy = legacyPermissionModeToCodexApprovalPolicy(mode);
    session.codexSandbox = legacyPermissionModeToCodexSandbox(mode);
    session.codexConfigSource = legacyPermissionModeToCodexConfigSource(mode);
    return;
  }

  session.unifiedPermissionMode = legacyPermissionModeToUnifiedPermissionMode(mode);
}

function hydrateNativePermissionControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode"
  >,
): void {
  if (session.provider === "claude") {
    session.interactionMode = resolveSessionClaudeInteractionMode(session);
    session.claudePermissionMode = resolveSessionClaudeAccessMode(session, "default");
  } else if (session.provider === "codex") {
    session.codexApprovalPolicy = session.codexApprovalPolicy ?? legacyPermissionModeToCodexApprovalPolicy(session.permissionMode);
    session.codexSandbox = session.codexSandbox ?? legacyPermissionModeToCodexSandbox(session.permissionMode);
    session.codexConfigSource = session.codexConfigSource ?? legacyPermissionModeToCodexConfigSource(session.permissionMode);
  } else {
    session.unifiedPermissionMode = session.unifiedPermissionMode ?? legacyPermissionModeToUnifiedPermissionMode(session.permissionMode);
  }

  session.permissionMode = syncLegacyPermissionMode(session);
}

function resolveSessionClaudePermissionMode(
  session: Pick<AgentChatSession, "claudePermissionMode" | "permissionMode">,
  fallback: AgentChatClaudePermissionMode,
): AgentChatClaudeAccessMode {
  return resolveSessionClaudeAccessMode(session, fallback);
}

function resolveSessionCodexApprovalPolicy(
  session: Pick<AgentChatSession, "codexApprovalPolicy" | "permissionMode">,
  fallback: AgentChatCodexApprovalPolicy,
): AgentChatCodexApprovalPolicy {
  return session.codexApprovalPolicy
    ?? legacyPermissionModeToCodexApprovalPolicy(session.permissionMode)
    ?? fallback;
}

function resolveSessionCodexSandbox(
  session: Pick<AgentChatSession, "codexSandbox" | "permissionMode">,
  fallback: AgentChatCodexSandbox,
): AgentChatCodexSandbox {
  return session.codexSandbox
    ?? legacyPermissionModeToCodexSandbox(session.permissionMode)
    ?? fallback;
}

function resolveSessionCodexConfigSource(
  session: Pick<AgentChatSession, "codexConfigSource" | "permissionMode">,
): AgentChatCodexConfigSource {
  return session.codexConfigSource
    ?? legacyPermissionModeToCodexConfigSource(session.permissionMode)
    ?? "flags";
}

function resolveSessionUnifiedPermissionMode(
  session: Pick<AgentChatSession, "unifiedPermissionMode" | "permissionMode">,
  fallback: AgentChatUnifiedPermissionMode,
): AgentChatUnifiedPermissionMode {
  return session.unifiedPermissionMode
    ?? legacyPermissionModeToUnifiedPermissionMode(session.permissionMode)
    ?? fallback;
}

function normalizeSessionNativePermissionControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode"
  >,
  config: ResolvedChatConfig,
): void {
  if (session.provider === "claude") {
    session.interactionMode = resolveSessionClaudeInteractionMode(session);
    session.claudePermissionMode = resolveSessionClaudePermissionMode(session, config.claudePermissionMode);
    delete session.codexApprovalPolicy;
    delete session.codexSandbox;
    delete session.codexConfigSource;
    delete session.unifiedPermissionMode;
  } else if (session.provider === "codex") {
    delete session.interactionMode;
    session.codexConfigSource = resolveSessionCodexConfigSource(session);
    if (session.codexConfigSource === "config-toml") {
      delete session.codexApprovalPolicy;
      delete session.codexSandbox;
    } else {
      session.codexApprovalPolicy = resolveSessionCodexApprovalPolicy(session, config.codexApprovalPolicy);
      session.codexSandbox = resolveSessionCodexSandbox(session, config.codexSandboxMode);
    }
    delete session.claudePermissionMode;
    delete session.unifiedPermissionMode;
  } else {
    delete session.interactionMode;
    session.unifiedPermissionMode = resolveSessionUnifiedPermissionMode(session, config.unifiedPermissionMode);
    delete session.claudePermissionMode;
    delete session.codexApprovalPolicy;
    delete session.codexSandbox;
    delete session.codexConfigSource;
  }

  session.permissionMode = syncLegacyPermissionMode(session);
}

function normalizePersistedExecutionMode(value: unknown): AgentChatExecutionMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VALID_EXECUTION_MODES.has(trimmed) ? trimmed as AgentChatExecutionMode : undefined;
}

function normalizePersistedInteractionMode(value: unknown): AgentChatInteractionMode | undefined {
  return normalizePersistedEnum(value, VALID_INTERACTION_MODES);
}

function normalizePersistedComputerUse(value: unknown): ComputerUsePolicy {
  return normalizeComputerUsePolicy(value, createDefaultComputerUsePolicy());
}

function normalizePersistedCompletion(value: unknown): AgentChatCompletionReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const timestamp = typeof record.timestamp === "string" ? record.timestamp.trim() : "";
  const status = record.status;
  if (!summary.length || !timestamp.length) return undefined;
  if (status !== "completed" && status !== "partial" && status !== "blocked") return undefined;
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
        .filter((entry): entry is { type: string; description: string; reference?: string } => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
          const artifact = entry as Record<string, unknown>;
          return typeof artifact.type === "string" && artifact.type.trim().length > 0
            && typeof artifact.description === "string"
            && artifact.description.trim().length > 0
            && (artifact.reference === undefined || typeof artifact.reference === "string");
        })
        .map((entry) => ({
          type: entry.type.trim(),
          description: entry.description.trim(),
          ...(typeof entry.reference === "string" && entry.reference.trim().length > 0
            ? { reference: entry.reference.trim() }
            : {}),
        }))
    : [];
  return {
    timestamp,
    summary,
    status,
    artifacts,
    ...(typeof record.blockerDescription === "string" && record.blockerDescription.trim().length > 0
      ? { blockerDescription: record.blockerDescription.trim() }
      : {}),
  };
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

function guardedIdentityPermissionModeForProvider(_provider: AgentChatProvider): AgentChatSession["permissionMode"] {
  return "plan";
}

function normalizeIdentityPermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
  provider: AgentChatProvider,
): AgentChatSession["permissionMode"] {
  return mode === "plan" ? "plan" : guardedIdentityPermissionModeForProvider(provider);
}

function isLightweightSession(session: Pick<AgentChatSession, "sessionProfile">): boolean {
  return session.sessionProfile === "light";
}

let _mcpRuntimeRootCache: string | null = null;
function resolveMcpRuntimeRoot(): string {
  _mcpRuntimeRootCache ??= resolveUnifiedRuntimeRoot();
  return _mcpRuntimeRootCache;
}


export function createAgentChatService(args: {
  projectRoot: string;
  adeDir?: string;
  transcriptsDir: string;
  projectId?: string;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  fileService?: ReturnType<typeof createFileService> | null;
  episodicSummaryService?: EpisodicSummaryService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  linearIssueTracker?: IssueTracker | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  getMissionService?: () => ReturnType<typeof createMissionService> | null;
  getAiOrchestratorService?: () => ReturnType<typeof createAiOrchestratorService> | null;
  getLinearDispatcherService?: () => ReturnType<typeof createLinearDispatcherService> | null;
  linearClient?: LinearClient | null;
  linearCredentials?: LinearCredentialService | null;
  prService?: ReturnType<typeof createPrService> | null;
  processService?: ReturnType<typeof createProcessService> | null;
  getTestService?: () => { listSuites: () => any[]; run: (args: any) => Promise<any>; stop: (args: any) => void; listRuns: (args?: any) => any[]; getLogTail: (args: any) => string } | null;
  ptyService?: { create: (args: any) => Promise<{ ptyId: string; sessionId: string }> } | null;
  getAutomationService?: () => { list: () => any[]; triggerManually: (args: any) => Promise<any>; listRuns: (args?: any) => any[] } | null;
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
    fileService,
    episodicSummaryService,
    ctoStateService,
    workerAgentService,
    workerHeartbeatService,
    linearIssueTracker,
    flowPolicyService,
    getMissionService,
    getAiOrchestratorService,
    getLinearDispatcherService,
    linearClient: linearClientRef,
    linearCredentials: linearCredentialsRef,
    prService,
    processService,
    getTestService,
    ptyService,
    getAutomationService,
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

  let proofObserver = computerUseArtifactBrokerRef
    ? createProofObserver({ broker: computerUseArtifactBrokerRef })
    : null;

  const layout = resolveAdeLayout(projectRoot);
  const chatSessionsDir = layout.chatSessionsDir;
  const chatTranscriptsDir = layout.chatTranscriptsDir;
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(chatTranscriptsDir, { recursive: true });

  const stageAttachmentForCodexInput = (attachment: ResolvedAgentChatFileRef): string => {
    const content = readFileWithinRootSecure(attachment._rootPath, attachment._resolvedPath);
    const stagedDir = path.join(layout.tmpDir, "agent-chat-attachments");
    fs.mkdirSync(stagedDir, { recursive: true });
    const baseName = path.basename(attachment.path) || path.basename(attachment._resolvedPath) || "attachment";
    const stagedPath = path.join(stagedDir, `${randomUUID()}-${baseName}`);
    const tempPath = `${stagedPath}.tmp`;
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, stagedPath);
    return stagedPath;
  };

  const managedSessions = new Map<string, ManagedChatSession>();
  const sessionTurnCollectors = new Map<string, SessionTurnCollector>();
  const subagentStates = new Map<string, Map<string, AgentChatSubagentSnapshot>>();
  const AUTO_MEMORY_CATEGORY_ALLOWLIST = new Set([
    "fact",
    "preference",
    "pattern",
    "decision",
    "gotcha",
    "convention",
    "procedure",
  ]);

  type AutoMemoryTurnClassification = "none" | "soft" | "required";

  type AutoMemoryTurnTelemetry = {
    searched: boolean;
    projectHits: number;
    agentHits: number;
    totalHits: number;
    injectedCount: number;
    includedProcedure: boolean;
  };

  type AutoMemoryTurnPlan = {
    classification: AutoMemoryTurnClassification;
    contextText: string;
    telemetry: AutoMemoryTurnTelemetry;
  };

  const EMPTY_MEMORY_TELEMETRY: AutoMemoryTurnTelemetry = {
    searched: false,
    projectHits: 0,
    agentHits: 0,
    totalHits: 0,
    injectedCount: 0,
    includedProcedure: false,
  };

  const ensureSubagentSnapshotMap = (sessionId: string): Map<string, AgentChatSubagentSnapshot> => {
    let collection = subagentStates.get(sessionId);
    if (!collection) {
      collection = new Map();
      subagentStates.set(sessionId, collection);
    }
    return collection;
  };

  const compactMemorySnippet = (value: string, maxChars = 260): string => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  };

  const AUTO_MEMORY_REQUIRED_RE = /\b(?:fix|debug|investigat(?:e|ing|ion)|implement|refactor|patch|edit|write|add|remove|rename|update|change|test(?:s|ing)?|failing|error|exception|stack trace|crash|bug|diff|pull request|regression|build|compile|lint|typecheck)\b/i;
  const AUTO_MEMORY_SOFT_RE = /\b(?:explain|why|how|walk through|summari[sz]e|context|overview|review|plan|brainstorm|design|architecture|tradeoff|decision|pattern|convention|gotcha)\b/i;
  const AUTO_MEMORY_META_RE = /^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|cool|sounds good|nice|what model are you|who are you|are you there|can you help)\b/i;
  const AUTO_MEMORY_FILE_PATH_RE = /(?:^|\s)(?:\/|\.{1,2}\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|go|rs|java|rb|sh)\b/i;
  const CLAUDE_MUTATING_TOOL_RE = /\b(?:bash|write|edit|multiedit|notebookedit)\b/;
  const CHAT_MEMORY_GUARD_MESSAGE = "Search memory before mutating files or running mutating commands for this turn.";
  const CLAUDE_MUTATING_BASH_RE = /\b(?:rm|mv|cp|mkdir|touch|chmod|chown|patch|install|uninstall|add|remove|upgrade|apply|commit|rebase|merge|reset|checkout|switch|restore|sed\s+-i|perl\s+-i)\b|>>?|tee\b/i;

  const classifyAutoMemoryTurn = (
    promptText: string,
    attachmentCount = 0,
  ): AutoMemoryTurnClassification => {
    const trimmed = promptText.trim();
    if (trimmed.length < 12) return "none";
    if (trimmed.startsWith("/")) return "none";
    if (/^before context compaction runs\b/i.test(trimmed)) return "none";
    if (/^review this conversation and persist\b/i.test(trimmed)) return "none";
    if (attachmentCount > 0) return "required";
    if (/```/.test(trimmed) || AUTO_MEMORY_FILE_PATH_RE.test(trimmed)) return "required";
    if (AUTO_MEMORY_REQUIRED_RE.test(trimmed)) return "required";
    if (AUTO_MEMORY_SOFT_RE.test(trimmed)) return "soft";
    if (AUTO_MEMORY_META_RE.test(trimmed) && trimmed.length <= 80) return "none";
    return "none";
  };

  const selectAutoMemoryEntries = (
    memories: Memory[],
    maxEntries = 4,
  ): Memory[] => {
    const seen = new Set<string>();
    return memories
      .filter((memory) => AUTO_MEMORY_CATEGORY_ALLOWLIST.has(String(memory.category ?? "").trim()))
      .filter((memory) => {
        if (seen.has(memory.id)) return false;
        seen.add(memory.id);
        return true;
      })
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        if (left.tier !== right.tier) return left.tier - right.tier;
        return right.compositeScore - left.compositeScore;
      })
      .slice(0, maxEntries);
  };

  const buildAutoMemorySystemNotice = (plan: AutoMemoryTurnPlan): {
    message: string;
    detail: string;
  } | null => {
    if (!plan.telemetry.searched) return null;
    const message = `Checked memory: ${plan.telemetry.totalHits} hit${plan.telemetry.totalHits === 1 ? "" : "s"}, injected ${plan.telemetry.injectedCount} relevant entr${plan.telemetry.injectedCount === 1 ? "y" : "ies"}`;
    const detail = [
      `Policy: ${plan.classification}`,
      `Project hits: ${plan.telemetry.projectHits}`,
      `Agent hits: ${plan.telemetry.agentHits}`,
      ...(plan.telemetry.includedProcedure ? ["Included procedure memory in the injected set."] : []),
    ].join("\n");
    return { message, detail };
  };

  const buildMemoryWriteNotice = (event: MemoryWriteEvent): {
    message: string;
    detail?: string;
  } => {
    if (!event.saved) {
      return {
        message: `Skipped memory write: ${event.reason ?? "write rejected"}`,
      };
    }

    const detail = [
      `Durability: ${event.durability}`,
      ...(typeof event.tier === "number" ? [`Tier: ${event.tier}`] : []),
      ...(event.deduped ? ["Merged with existing memory."] : []),
      ...(event.mergedIntoId ? [`Merged into: ${event.mergedIntoId}`] : []),
      ...(event.reason ? [`Reason: ${event.reason}`] : []),
    ].join("\n");

    const message = event.durability === "candidate"
      ? "Saved to memory as candidate, not promoted"
      : "Saved to memory as promoted knowledge";

    return { message, detail };
  };

  const buildAutoMemoryTurnPlan = async (
    managed: ManagedChatSession,
    promptText: string,
    attachments: AgentChatFileRef[] = [],
  ): Promise<AutoMemoryTurnPlan> => {
    const classification = classifyAutoMemoryTurn(promptText, attachments.length);
    if (!memoryService || !projectId) {
      return { classification: "none", contextText: "", telemetry: EMPTY_MEMORY_TELEMETRY };
    }
    if (isLightweightSession(managed.session) || classification === "none") {
      return { classification, contextText: "", telemetry: EMPTY_MEMORY_TELEMETRY };
    }

    const query = promptText.trim().slice(0, 300);
    const agentScopeOwnerId = managed.session.identityKey ?? managed.session.id;

    const [projectHits, agentHits] = await Promise.all([
      memoryService.search({
        projectId,
        query,
        scope: "project",
        status: "promoted",
        tiers: [1, 2],
        limit: 12,
      }).catch(() => []),
      memoryService.search({
        projectId,
        query,
        scope: "agent",
        scopeOwnerId: agentScopeOwnerId,
        status: "promoted",
        tiers: [1, 2],
        limit: 6,
      }).catch(() => []),
    ]);

    const allQualifying = selectAutoMemoryEntries([...projectHits, ...agentHits], 32);
    const selected = allQualifying.slice(0, 4);
    const contextText = selected.length === 0
      ? ""
      : [
          "Relevant ADE memory for this turn (use it when helpful; current code and files win if they disagree):",
          ...selected.map((memory) => `- [${memory.scope}/${memory.category}] ${compactMemorySnippet(memory.content, 180)}`),
        ].join("\n");

    return {
      classification,
      contextText,
      telemetry: {
        searched: true,
        projectHits: projectHits.length,
        agentHits: agentHits.length,
        totalHits: allQualifying.length,
        injectedCount: selected.length,
        includedProcedure: selected.some((memory) => memory.category === "procedure"),
      },
    };
  };

  const bashInputLikelyMutates = (input: Record<string, unknown>): boolean => {
    let command = "";
    if (typeof input.command === "string") {
      command = input.command;
    } else if (typeof input.cmd === "string") {
      command = input.cmd;
    }
    return CLAUDE_MUTATING_BASH_RE.test(command) || /(?:>|>>|tee|cp\s|mv\s|write|edit)/.test(command);
  };

  const normalizeToolNameForPolicy = (toolName: string): string =>
    toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const isMemorySearchToolName = (toolName: string): boolean => {
    const normalized = normalizeToolNameForPolicy(toolName);
    return normalized.includes("memory_search") || normalized.includes("memorysearch");
  };

  const isClaudeMutatingToolCall = (toolName: string, input: Record<string, unknown>): boolean => {
    const normalized = normalizeToolNameForPolicy(toolName);
    if (!CLAUDE_MUTATING_TOOL_RE.test(normalized)) return false;
    if (normalized.includes("bash")) return bashInputLikelyMutates(input);
    return true;
  };

  const buildClaudeCanUseTool = (
    runtime: ClaudeRuntime,
    managed: ManagedChatSession,
  ): ClaudeSDKOptions["canUseTool"] => async (toolName, input): Promise<ClaudePermissionResult> => {
    // ── ExitPlanMode interception ──
    // Intercept ExitPlanMode to show a plan approval UI instead of letting the
    // SDK handle it natively (which just collapses into the work log).
    if (toolName === "ExitPlanMode") {
      const inputRecord = (input && typeof input === "object" && !Array.isArray(input)) ? input as Record<string, unknown> : {};
      const planContent = typeof inputRecord.planDescription === "string"
        ? inputRecord.planDescription
        : typeof inputRecord.plan === "string"
          ? inputRecord.plan
          : "";
      const planSummary = planContent.length > 0
        ? planContent
        : "The agent has prepared a plan. Review and approve to proceed with implementation.";

      const approvalItemId = randomUUID();
      const turnId = runtime.activeTurnId ?? undefined;
      const request: PendingInputRequest = {
        requestId: approvalItemId,
        itemId: approvalItemId,
        source: "claude",
        kind: "plan_approval",
        title: "Plan Ready for Review",
        description: planSummary,
        questions: [{
          id: "plan_decision",
          header: "Implementation Plan",
          question: planSummary,
          options: [
            { label: "Approve & Implement", value: "approve", recommended: true },
            { label: "Reject & Revise", value: "reject" },
          ],
          allowsFreeform: true,
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: { tool: "ExitPlanMode", planContent },
        turnId: turnId ?? null,
      };

      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: "Plan ready for approval",
        detail: { tool: "ExitPlanMode", planContent },
      });

      // Block until the user responds via the approval UI.
      const response = await new Promise<{ decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null }>((resolve) => {
        runtime.approvals.set(approvalItemId, { kind: "approval", resolve, request });
      });
      runtime.approvals.delete(approvalItemId);

      const approved = response.decision === "accept" || response.decision === "accept_for_session";
      if (approved) {
        // Allow the tool — the SDK will process ExitPlanMode normally and
        // Claude will receive the standard "plan approved" tool result.
        return { behavior: "allow" };
      }

      // Denied — tell Claude the user rejected the plan.
      const feedback = typeof response.responseText === "string" ? response.responseText.trim() : "";
      return {
        behavior: "deny",
        message: feedback.length > 0
          ? `The user rejected your plan with feedback: "${feedback}". Please revise and try again.`
          : "The user rejected your plan. Please revise your approach and try again.",
      };
    }

    const state = runtime.turnMemoryPolicyState;
    if (isMemorySearchToolName(toolName) && state) {
      state.explicitSearchPerformed = true;
      state.orientationSatisfied = true;
      return { behavior: "allow" };
    }
    if (!state || state.classification !== "required" || state.orientationSatisfied || state.explicitSearchPerformed) {
      return { behavior: "allow" };
    }
    if (!isClaudeMutatingToolCall(toolName, input)) {
      return { behavior: "allow" };
    }
    return {
      behavior: "deny",
      message: CHAT_MEMORY_GUARD_MESSAGE,
    };
  };

  const clearSubagentSnapshots = (sessionId: string): void => {
    subagentStates.delete(sessionId);
  };

  const trackSubagentEvent = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    if (event.type !== "subagent_started" && event.type !== "subagent_progress" && event.type !== "subagent_result") return;
    const map = ensureSubagentSnapshotMap(managed.session.id);
    if (event.type === "subagent_started") {
      map.set(event.taskId, {
        taskId: event.taskId,
        description: event.description,
        status: "running",
        turnId: event.turnId ?? undefined,
        startTimestamp: nowIso(),
      });
      return;
    }
    if (event.type === "subagent_progress") {
      const previous = map.get(event.taskId);
      map.set(event.taskId, {
        taskId: event.taskId,
        description: event.description?.trim() || previous?.description || "Subagent task",
        status: "running",
        turnId: event.turnId ?? previous?.turnId,
        startTimestamp: previous?.startTimestamp ?? nowIso(),
        summary: event.summary.trim() || previous?.summary,
        lastToolName: event.lastToolName ?? previous?.lastToolName,
        usage: event.usage ?? previous?.usage,
      });
      return;
    }
    const previous = map.get(event.taskId);
    const status = event.status === "failed"
      ? "failed"
      : event.status === "stopped"
        ? "stopped"
        : "completed";
    map.set(event.taskId, {
      taskId: event.taskId,
      description: previous?.description ?? event.summary ?? "",
      status,
      turnId: event.turnId ?? previous?.turnId,
      startTimestamp: previous?.startTimestamp,
      endTimestamp: nowIso(),
      summary: event.summary ?? previous?.summary,
      lastToolName: previous?.lastToolName,
      usage: event.usage ?? previous?.usage,
    });
  };

  const getTrackedSubagents = (sessionId: string): AgentChatSubagentSnapshot[] => {
    const snapshots = subagentStates.get(sessionId);
    if (!snapshots) return [];
    return Array.from(snapshots.values());
  };

  const deriveSessionCapabilities = (managed: ManagedChatSession | null): AgentChatSessionCapabilities => ({
    supportsSubagentInspection: Boolean(managed && (managed.session.provider === "claude" || managed.session.provider === "codex")),
    supportsSubagentControl: Boolean(managed && managed.runtime?.kind === "claude"),
    supportsReviewMode: Boolean(managed && managed.session.provider === "codex"),
  });

  const buildAdeMcpServers = (
    provider: "claude" | "codex",
    defaultRole: "agent" | "cto",
    ownerId?: string | null,
    chatSessionId?: string | null,
    computerUsePolicy?: ComputerUsePolicy | null,
  ): Record<string, Record<string, unknown>> => {
    const launch = resolveAdeMcpServerLaunch({
      workspaceRoot: projectRoot,
      runtimeRoot: resolveMcpRuntimeRoot(),
      defaultRole,
      ownerId: ownerId ?? undefined,
      chatSessionId: chatSessionId ?? undefined,
      computerUsePolicy: normalizeComputerUsePolicy(computerUsePolicy, createDefaultComputerUsePolicy()),
    });
    return providerResolver.normalizeCliMcpServers(provider, {
      ade: {
        command: launch.command,
        args: launch.cmdArgs,
        env: launch.env
      }
    }) ?? {};
  };

  const summarizeAdeMcpLaunch = (args: {
    defaultRole: "agent" | "cto" | "external";
    ownerId?: string | null;
    computerUsePolicy?: ComputerUsePolicy | null;
  }) => {
    const { mode, command, entryPath, runtimeRoot, socketPath, packaged, resourcesPath } = resolveAdeMcpServerLaunch({
      workspaceRoot: projectRoot,
      runtimeRoot: resolveMcpRuntimeRoot(),
      defaultRole: args.defaultRole,
      ownerId: args.ownerId ?? undefined,
      computerUsePolicy: normalizeComputerUsePolicy(args.computerUsePolicy, createDefaultComputerUsePolicy()),
    });
    return { mode, command, entryPath, runtimeRoot, socketPath, packaged, resourcesPath };
  };

  /** Best-effort diagnostic: resolve the MCP launch config for a session, returning undefined on failure. */
  const tryDiagnosticMcpLaunch = (managed: ManagedChatSession): ReturnType<typeof summarizeAdeMcpLaunch> | undefined => {
    try {
      return summarizeAdeMcpLaunch({
        defaultRole: managed.session.identityKey === "cto" ? "cto" : "agent",
        ownerId: resolveWorkerIdentityAgentId(managed.session.identityKey),
        computerUsePolicy: managed.session.computerUse,
      });
    } catch { return undefined; }
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

  const readTranscriptEntries = (managed: ManagedChatSession): AgentChatTranscriptEntry[] => {
    try {
      const raw = fs.readFileSync(managed.transcriptPath, "utf8");
      const entries: AgentChatTranscriptEntry[] = [];
      for (const entry of parseAgentChatTranscript(raw)) {
        if (entry.sessionId !== managed.session.id) continue;
        if (entry.event.type === "user_message") {
          const text = entry.event.text.trim();
          if (!text.length) continue;
          entries.push({
            role: "user",
            text,
            timestamp: entry.timestamp,
            turnId: entry.event.turnId,
          });
          continue;
        }
        if (entry.event.type === "text") {
          const text = entry.event.text.trim();
          if (!text.length) continue;
          entries.push({
            role: "assistant",
            text,
            timestamp: entry.timestamp,
            turnId: entry.event.turnId,
          });
        }
      }
      return entries;
    } catch {
      return [];
    }
  };

  const getChatTranscript = async ({
    sessionId,
    limit = DEFAULT_TRANSCRIPT_READ_LIMIT,
    maxChars = DEFAULT_TRANSCRIPT_READ_CHARS,
  }: {
    sessionId: string;
    limit?: number;
    maxChars?: number;
  }): Promise<{
    sessionId: string;
    entries: AgentChatTranscriptEntry[];
    truncated: boolean;
    totalEntries: number;
  }> => {
    const managed = ensureManagedSession(sessionId);
    const normalizedLimit = Math.max(1, Math.min(MAX_TRANSCRIPT_READ_LIMIT, Math.floor(limit)));
    const normalizedMaxChars = Math.max(200, Math.min(MAX_TRANSCRIPT_READ_CHARS, Math.floor(maxChars)));
    // Flush any pending buffered text so the transcript includes all content
    flushBufferedText(managed);
    const transcriptEntries = readTranscriptEntries(managed);
    const fallbackEntries = transcriptEntries.length
      ? transcriptEntries
      : managed.recentConversationEntries.map((entry) => ({
          role: entry.role,
          text: entry.text.trim(),
          timestamp: managed.session.lastActivityAt,
          turnId: entry.turnId,
        })).filter((entry) => entry.text.length > 0);

    const byLimit = fallbackEntries.slice(-normalizedLimit);
    let truncated = fallbackEntries.length > byLimit.length;
    let remainingChars = normalizedMaxChars;
    const bounded: AgentChatTranscriptEntry[] = [];

    for (let index = byLimit.length - 1; index >= 0; index -= 1) {
      const entry = byLimit[index]!;
      if (remainingChars <= 0) {
        truncated = true;
        break;
      }
      if (entry.text.length <= remainingChars) {
        bounded.push(entry);
        remainingChars -= entry.text.length;
        continue;
      }
      bounded.push({
        ...entry,
        text: remainingChars > 3 ? `${entry.text.slice(0, remainingChars - 3).trimEnd()}...` : entry.text.slice(0, remainingChars),
      });
      truncated = true;
      remainingChars = 0;
      break;
    }

    bounded.reverse();
    return {
      sessionId: managed.session.id,
      entries: bounded,
      truncated,
      totalEntries: fallbackEntries.length,
    };
  };

  const readTranscriptEnvelopes = (managed: ManagedChatSession): AgentChatEventEnvelope[] => {
    try {
      return parseAgentChatTranscript(fs.readFileSync(managed.transcriptPath, "utf8"))
        .filter((entry) => entry.sessionId === managed.session.id);
    } catch {
      return [];
    }
  };

  const deriveTranscriptTurnActive = (entries: AgentChatEventEnvelope[]): boolean => {
    let turnActive = false;
    for (const entry of entries) {
      if (entry.event.type === "status") {
        turnActive = entry.event.turnStatus === "started";
        continue;
      }
      if (entry.event.type === "done") {
        turnActive = false;
      }
    }
    return turnActive;
  };

  const normalizeEventStatus = (status: string | undefined): string => {
    if (status === "failed") return "failed";
    if (status === "completed") return "completed";
    return "running";
  };

  const formatHandoffCommand = (event: Extract<AgentChatEvent, { type: "command" }>): string | null => {
    const command = trimLine(event.command);
    if (!command) return null;
    const cwd = trimLine(event.cwd);
    const status = normalizeEventStatus(event.status);
    return cwd ? `${command} (${status}) in ${cwd}` : `${command} (${status})`;
  };

  const formatHandoffFileChange = (event: Extract<AgentChatEvent, { type: "file_change" }>): string | null => {
    const filePath = trimLine(event.path);
    if (!filePath) return null;
    return `${event.kind} ${filePath} (${normalizeEventStatus(event.status)})`;
  };

  const collectHandoffArtifacts = (entries: AgentChatEventEnvelope[]): HandoffArtifacts => {
    const commands: string[] = [];
    const fileChanges: string[] = [];
    const errors: string[] = [];

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (!event) continue;
      if (commands.length < 4 && event.type === "command") {
        const formatted = formatHandoffCommand(event);
        if (formatted) commands.push(formatted);
        continue;
      }
      if (fileChanges.length < 6 && event.type === "file_change") {
        const formatted = formatHandoffFileChange(event);
        if (formatted) fileChanges.push(formatted);
        continue;
      }
      if (errors.length < 4 && event.type === "error") {
        const formatted = trimLine(event.message);
        if (formatted) errors.push(formatted);
      }
    }

    return {
      commands: uniqueNonEmpty(commands, 4).reverse(),
      fileChanges: uniqueNonEmpty(fileChanges, 6).reverse(),
      errors: uniqueNonEmpty(errors, 4).reverse(),
    };
  };

  const selectPreferredReasoningTier = (tiers: string[]): string | null => {
    const normalized = uniqueNonEmpty(tiers.map((tier) => normalizeReasoningEffort(tier)));
    if (!normalized.length) return null;
    for (const candidate of ["medium", "high", "low", "xhigh", "max", "none"]) {
      if (normalized.includes(candidate)) return candidate;
    }
    return normalized[0] ?? null;
  };

  const pickHandoffReasoningEffort = (
    descriptor: ModelDescriptor,
    sourceReasoningEffort: string | null | undefined,
  ): string | null => {
    if (!descriptor.capabilities.reasoning) return null;
    const supported = uniqueNonEmpty(
      (descriptor.reasoningTiers ?? []).map((tier) => normalizeReasoningEffort(tier)),
    );
    if (!supported.length) return normalizeReasoningEffort(sourceReasoningEffort);
    const normalizedSource = normalizeReasoningEffort(sourceReasoningEffort);
    if (normalizedSource && supported.includes(normalizedSource)) {
      return normalizedSource;
    }
    return selectPreferredReasoningTier(supported);
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

  const usesIdentityContinuity = (managed: ManagedChatSession): boolean => Boolean(managed.session.identityKey);

  const buildDeterministicContinuitySummary = (managed: ManagedChatSession): string | null => {
    const recentConversation = buildRecentConversationContext(managed, 8).trim();
    if (!recentConversation.length) return null;
    return [
      "Recent continuity snapshot:",
      recentConversation,
    ].join("\n");
  };

  const maybeRefreshIdentityContinuitySummary = async (
    managed: ManagedChatSession,
    reason: "compaction" | "provider_reset",
  ): Promise<void> => {
    if (!usesIdentityContinuity(managed)) return;
    if (managed.continuitySummaryInFlight) return;

    const deterministic = buildDeterministicContinuitySummary(managed);
    if (!deterministic) return;

    managed.continuitySummary = deterministic;
    managed.continuitySummaryUpdatedAt = nowIso();
    persistChatState(managed);

    const auth = await detectAuth().catch(() => []);
    const availableModels = getRegistryModels(auth).filter((descriptor) => !descriptor.deprecated);
    if (!availableModels.length) return;

    const preferredModelId =
      [
        resolveChatConfig().summaryModelId,
        DEFAULT_AUTO_TITLE_MODEL_ID,
        "anthropic/claude-haiku-4-5",
        "openai/gpt-5.4-mini",
        "openai/gpt-5.2",
        availableModels[0]?.id,
      ].find((candidate) => {
        const modelId = typeof candidate === "string" ? candidate.trim() : "";
        return modelId.length > 0 && availableModels.some((descriptor) => descriptor.id === modelId);
      }) ?? null;

    if (!preferredModelId) return;
    const descriptor = getModelById(preferredModelId);
    if (!descriptor) return;

    const prompt = [
      "You are ADE's continuity compaction assistant.",
      "Summarize the persistent identity chat's active continuity for recovery after provider resets or context compaction.",
      "Focus on current objectives, active delegations, decisions already made, and blockers that still matter.",
      "Return 3-6 concise bullet points and do not add Markdown headings.",
      "",
      `Reason: ${reason}`,
      `Identity: ${managed.session.identityKey}`,
      deterministic,
    ].join("\n");

    managed.continuitySummaryInFlight = true;
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
        managed.continuitySummary = text;
        managed.continuitySummaryUpdatedAt = nowIso();
        persistChatState(managed);
      }
    } catch (error) {
      logger.warn("agent_chat.identity_continuity_summary_failed", {
        sessionId: managed.session.id,
        reason,
        modelId: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      managed.continuitySummaryInFlight = false;
    }
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
      sections.push([
        "CTO Runtime Identity",
        ctoStateService.previewSystemPrompt().prompt,
      ].join("\n"));
      sections.push(ctoStateService.buildReconstructionContext(8));
    } else {
      const workerAgentId = resolveWorkerIdentityAgentId(managed.session.identityKey);
      if (workerAgentId && workerAgentService) {
        sections.push(workerAgentService.buildReconstructionContext(workerAgentId, 8));
      }
    }

    if (usesIdentityContinuity(managed) && managed.continuitySummary?.trim()) {
      sections.push([
        "Continuity Summary",
        managed.continuitySummary.trim(),
      ].join("\n"));
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

  const resolveHandoffBlockedReason = (managed: ManagedChatSession): string | null => {
    if (managed.closed) return "This chat is no longer available for handoff.";
    if (managed.session.status === "active") {
      return "Wait for the current response to finish before handing off this chat.";
    }
    if (!managed.runtime) {
      return deriveTranscriptTurnActive(readTranscriptEnvelopes(managed))
        ? "Wait for the current response to finish before handing off this chat."
        : null;
    }

    const runtime = managed.runtime;
    if (runtime.kind === "claude") {
      if (runtime.busy || runtime.activeTurnId) {
        return "Wait for the current response to finish before handing off this chat.";
      }
      if (runtime.approvals.size > 0) {
        return "Resolve the current approval or question before handing off this chat.";
      }
    }
    if (runtime.kind === "unified") {
      if (runtime.busy || runtime.activeTurnId || runtime.abortController) {
        return "Wait for the current response to finish before handing off this chat.";
      }
      if (runtime.pendingApprovals.size > 0) {
        return "Resolve the current approval or question before handing off this chat.";
      }
    }
    if (runtime.kind === "codex") {
      if (runtime.activeTurnId || runtime.startedTurnId) {
        return "Wait for the current response to finish before handing off this chat.";
      }
      if (runtime.approvals.size > 0) {
        return "Resolve the current approval or question before handing off this chat.";
      }
    }

    return deriveTranscriptTurnActive(readTranscriptEnvelopes(managed))
      ? "Wait for the current response to finish before handing off this chat."
      : null;
  };

  const ensureSessionIdleForHandoff = (managed: ManagedChatSession): void => {
    const blockedReason = resolveHandoffBlockedReason(managed);
    if (blockedReason) {
      throw new Error(blockedReason);
    }
  };

  const buildDeterministicHandoffBrief = (args: {
    sourceSession: AgentChatSessionSummary;
    targetDescriptor: ModelDescriptor;
    transcript: Awaited<ReturnType<typeof getChatTranscript>>;
    artifacts: HandoffArtifacts;
  }): string => {
    const { sourceSession, transcript, artifacts } = args;
    const summaryLines = uniqueNonEmpty([
      sourceSession.summary,
      sourceSession.completion?.summary,
      sourceSession.lastOutputPreview,
    ], 3);
    const goal = trimLine(sourceSession.goal)
      ?? summaryLines[0]
      ?? trimLine(sourceSession.title)
      ?? "Continue the same ADE work item from the previous chat.";
    const preservedContext = uniqueNonEmpty([
      trimLine(sourceSession.title) ? `Previous title: ${trimLine(sourceSession.title)}` : null,
      trimLine(sourceSession.summary) ? `Existing session summary: ${trimLine(sourceSession.summary)}` : null,
      trimLine(sourceSession.completion?.summary) ? `Completion summary: ${trimLine(sourceSession.completion?.summary)}` : null,
      sourceSession.completion?.status ? `Completion status: ${sourceSession.completion.status}` : null,
      sourceSession.completion?.blockerDescription ? `Blocker: ${trimLine(sourceSession.completion.blockerDescription)}` : null,
      trimLine(sourceSession.lastOutputPreview) ? `Latest output preview: ${trimLine(sourceSession.lastOutputPreview)}` : null,
    ], 6);
    const fileCommandErrorLines = uniqueNonEmpty([
      ...artifacts.fileChanges.map((entry) => `File change: ${entry}`),
      ...artifacts.commands.map((entry) => `Command: ${entry}`),
      ...artifacts.errors.map((entry) => `Error: ${entry}`),
    ], 10);
    const transcriptLines = transcript.entries.map((entry) => {
      const speaker = entry.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${entry.text}`;
    });
    const nextAction = trimLine(sourceSession.completion?.blockerDescription)
      ?? transcriptLines[transcriptLines.length - 1]
      ?? "Continue from the preserved context and resolve the next open issue without restarting discovery.";

    return [
      "## Current goal",
      `- ${goal}`,
      "",
      "## Important decisions and preserved context",
      ...(preservedContext.length ? preservedContext.map((line) => `- ${line}`) : ["- No explicit summary was available, so rely on the transcript excerpt below."]),
      ...(summaryLines.length && !preservedContext.some((line) => line.includes(summaryLines[0]!))
        ? summaryLines.map((line) => `- Recent summary note: ${line}`)
        : []),
      transcriptLines.length
        ? [
            "",
            "Transcript excerpt:",
            ...transcriptLines.map((line) => `> ${line}`),
          ]
        : [],
      "",
      "## Files, commands, and errors to preserve",
      ...(fileCommandErrorLines.length ? fileCommandErrorLines.map((line) => `- ${line}`) : ["- No concrete file changes, commands, or errors were captured in the transcript tail."]),
      "",
      "## Next action or open issue",
      `- ${nextAction}`,
    ].flat().join("\n");
  };

  const generateHandoffBrief = async (args: {
    managed: ManagedChatSession;
    sourceSession: AgentChatSessionSummary;
    targetDescriptor: ModelDescriptor;
    transcript: Awaited<ReturnType<typeof getChatTranscript>>;
    artifacts: HandoffArtifacts;
  }): Promise<{ brief: string; usedFallbackSummary: boolean }> => {
    const deterministicBrief = buildDeterministicHandoffBrief(args);
    const auth = await detectAuth();
    const availableModels = getRegistryModels(auth).filter((descriptor) => !descriptor.deprecated);
    const preferredModelId = [
      resolveChatConfig().summaryModelId,
      "openai/gpt-5.4-mini",
      "openai/gpt-5.2",
      DEFAULT_AUTO_TITLE_MODEL_ID,
      availableModels[0]?.id,
    ].find((candidate) => {
      const modelId = typeof candidate === "string" ? candidate.trim() : "";
      return modelId.length > 0 && availableModels.some((descriptor) => descriptor.id === modelId);
    }) ?? null;

    if (!preferredModelId) {
      return { brief: deterministicBrief, usedFallbackSummary: true };
    }

    const descriptor = getModelById(preferredModelId);
    if (!descriptor) {
      return { brief: deterministicBrief, usedFallbackSummary: true };
    }

    const transcriptText = args.transcript.entries.map((entry) => {
      const speaker = entry.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${entry.text}`;
    }).join("\n");
    const prompt = [
      "You are ADE's chat handoff assistant.",
      "Rewrite the source context into a compact Markdown handoff brief for another coding model.",
      "Return exactly these headings in this order:",
      "## Current goal",
      "## Important decisions and preserved context",
      "## Files, commands, and errors to preserve",
      "## Next action or open issue",
      "Keep the brief concrete, factual, and concise. Do not invent missing details.",
      "",
      `Previous model: ${resolveSessionModelDescriptor(args.managed.session)?.displayName ?? args.managed.session.model}`,
      `New model: ${args.targetDescriptor.displayName}`,
      trimLine(args.sourceSession.title) ? `Previous title: ${trimLine(args.sourceSession.title)}` : null,
      trimLine(args.sourceSession.goal) ? `Current goal: ${trimLine(args.sourceSession.goal)}` : null,
      trimLine(args.sourceSession.summary) ? `Existing summary: ${trimLine(args.sourceSession.summary)}` : null,
      trimLine(args.sourceSession.completion?.summary) ? `Completion summary: ${trimLine(args.sourceSession.completion?.summary)}` : null,
      args.sourceSession.completion?.blockerDescription ? `Current blocker: ${trimLine(args.sourceSession.completion.blockerDescription)}` : null,
      transcriptText.length ? `Transcript excerpt:\n${transcriptText}` : null,
      args.artifacts.commands.length ? `Recent commands:\n${args.artifacts.commands.map((line) => `- ${line}`).join("\n")}` : null,
      args.artifacts.fileChanges.length ? `Recent file changes:\n${args.artifacts.fileChanges.map((line) => `- ${line}`).join("\n")}` : null,
      args.artifacts.errors.length ? `Recent errors:\n${args.artifacts.errors.map((line) => `- ${line}`).join("\n")}` : null,
      "",
      "Fallback brief:",
      deterministicBrief,
    ].filter(Boolean).join("\n");

    try {
      const resolvedModel = await providerResolver.resolveModel(descriptor.id, auth, {
        cwd: args.managed.laneWorktreePath,
        middleware: false,
      });
      const result = await generateText({
        model: resolvedModel,
        prompt,
      });
      const brief = result.text.trim();
      if (!brief.length) {
        return { brief: deterministicBrief, usedFallbackSummary: true };
      }
      return { brief, usedFallbackSummary: false };
    } catch (error) {
      logger.warn("agent_chat.handoff_summary_failed", {
        sessionId: args.managed.session.id,
        modelId: descriptor.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { brief: deterministicBrief, usedFallbackSummary: true };
    }
  };

  const buildHandoffPrompt = (brief: string): string => {
    return [
      "This message was injected automatically by ADE during a chat handoff.",
      "You are taking over from a previous ADE work chat that the user is handing off to this new model.",
      "Continue the same task in the same lane. Do not restart discovery from scratch unless the brief below is clearly missing a required detail.",
      "The user will keep discussing the same work in this new chat.",
      "",
      brief.trim(),
    ].join("\n");
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
        "openai/gpt-5.4-mini",
        "openai/gpt-5.2",
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
    const permMode: PermissionMode = resolveSessionUnifiedPermissionMode(
      managed.session,
      chatConfig.unifiedPermissionMode,
    );

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
    managed.session.unifiedPermissionMode = permMode;
    managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
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
      return "default" as const;
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

  const resolvePrimaryIdentityLane = async (): Promise<string> => {
    await laneService.ensurePrimaryLane?.().catch(() => {});
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
    if (!primary?.id) {
      throw new Error("No lane is available to host the canonical identity chat session.");
    }
    return primary.id;
  };

  const metadataPathFor = (sessionId: string): string => path.join(chatSessionsDir, `${sessionId}.json`);

  const persistChatState = (managed: ManagedChatSession): void => {
    const payload: PersistedChatState = {
      version: 2,
      sessionId: managed.session.id,
      laneId: managed.session.laneId,
      provider: managed.session.provider,
      model: managed.session.model,
      ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      ...(managed.session.sessionProfile ? { sessionProfile: managed.session.sessionProfile } : {}),
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      ...(managed.session.executionMode ? { executionMode: managed.session.executionMode } : {}),
      ...(managed.session.interactionMode ? { interactionMode: managed.session.interactionMode } : {}),
      ...(managed.session.claudePermissionMode ? { claudePermissionMode: managed.session.claudePermissionMode } : {}),
      ...(managed.session.codexApprovalPolicy ? { codexApprovalPolicy: managed.session.codexApprovalPolicy } : {}),
      ...(managed.session.codexSandbox ? { codexSandbox: managed.session.codexSandbox } : {}),
      ...(managed.session.codexConfigSource ? { codexConfigSource: managed.session.codexConfigSource } : {}),
      ...(managed.session.unifiedPermissionMode ? { unifiedPermissionMode: managed.session.unifiedPermissionMode } : {}),
      ...(managed.session.permissionMode ? { permissionMode: managed.session.permissionMode } : {}),
      ...(managed.session.identityKey ? { identityKey: managed.session.identityKey } : {}),
      ...(managed.session.surface ? { surface: managed.session.surface } : {}),
      ...(managed.session.automationId ? { automationId: managed.session.automationId } : {}),
      ...(managed.session.automationRunId ? { automationRunId: managed.session.automationRunId } : {}),
      ...(managed.session.capabilityMode ? { capabilityMode: managed.session.capabilityMode } : {}),
      ...(managed.session.computerUse ? { computerUse: managed.session.computerUse } : {}),
      ...(managed.session.completion ? { completion: managed.session.completion } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "claude" ? { sdkSessionId: managed.runtime.sdkSessionId ?? undefined } : {}),
      ...(managed.runtime?.kind === "unified"
        ? { messages: managed.runtime.messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })) }
        : {}),
      ...(managed.recentConversationEntries.length
        ? {
            recentConversationEntries: managed.recentConversationEntries.map((entry) => ({
              role: entry.role,
              text: entry.text,
              ...(entry.turnId ? { turnId: entry.turnId } : {}),
            })),
          }
        : {}),
      ...(managed.continuitySummary ? { continuitySummary: managed.continuitySummary } : {}),
      ...(managed.continuitySummaryUpdatedAt ? { continuitySummaryUpdatedAt: managed.continuitySummaryUpdatedAt } : {}),
      ...(managed.preferredExecutionLaneId ? { preferredExecutionLaneId: managed.preferredExecutionLaneId } : {}),
      ...(managed.selectedExecutionLaneId ? { selectedExecutionLaneId: managed.selectedExecutionLaneId } : {}),
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
      if (record.version !== 1 && record.version !== 2) return null;
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
      const claudePermissionMode = normalizePersistedClaudePermissionMode(record.claudePermissionMode);
      const interactionMode = normalizePersistedInteractionMode(record.interactionMode)
        ?? (provider === "claude" && (claudePermissionMode === "plan" || permissionMode === "plan") ? "plan" : undefined);
      const codexApprovalPolicy = normalizePersistedCodexApprovalPolicy(record.codexApprovalPolicy);
      const codexSandbox = normalizePersistedCodexSandbox(record.codexSandbox);
      const codexConfigSource = normalizePersistedCodexConfigSource(record.codexConfigSource);
      const unifiedPermissionMode = normalizePersistedUnifiedPermissionMode(record.unifiedPermissionMode);
      const identityKey = normalizeIdentityKey(record.identityKey);
      const surface = record.surface === "automation" ? "automation" : "work";
      const capabilityMode = normalizeCapabilityMode(record.capabilityMode);
      const computerUse = normalizePersistedComputerUse(record.computerUse);
      const completion = normalizePersistedCompletion(record.completion);
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
      const recentConversationEntries = Array.isArray(record.recentConversationEntries)
        ? record.recentConversationEntries
            .filter((entry): entry is PersistedRecentConversationEntry => {
              if (!entry || typeof entry !== "object") return false;
              const role = (entry as { role?: unknown }).role;
              const text = (entry as { text?: unknown }).text;
              return (role === "user" || role === "assistant") && typeof text === "string" && text.trim().length > 0;
            })
            .slice(-12)
        : undefined;
      const sdkSessionId = typeof record.sdkSessionId === "string" && record.sdkSessionId.trim().length ? record.sdkSessionId.trim() : undefined;
      const hydrated: PersistedChatState = {
        version: 2,
        sessionId,
        laneId,
        provider,
        model,
        ...(modelId ? { modelId } : {}),
        ...(sessionProfile ? { sessionProfile } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(executionMode ? { executionMode } : {}),
        ...(interactionMode ? { interactionMode } : {}),
        ...(claudePermissionMode ? { claudePermissionMode } : {}),
        ...(codexApprovalPolicy ? { codexApprovalPolicy } : {}),
        ...(codexSandbox ? { codexSandbox } : {}),
        ...(codexConfigSource ? { codexConfigSource } : {}),
        ...(unifiedPermissionMode ? { unifiedPermissionMode } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        surface,
        ...(typeof record.automationId === "string" && record.automationId.trim().length
          ? { automationId: record.automationId.trim() }
          : {}),
        ...(typeof record.automationRunId === "string" && record.automationRunId.trim().length
          ? { automationRunId: record.automationRunId.trim() }
          : {}),
        ...(capabilityMode ? { capabilityMode } : {}),
        ...(computerUse ? { computerUse } : {}),
        ...(completion ? { completion } : {}),
        ...(typeof record.threadId === "string" && record.threadId.trim().length
          ? { threadId: record.threadId.trim() }
          : {}),
        ...(sdkSessionId ? { sdkSessionId } : {}),
        ...(messages?.length ? { messages } : {}),
        ...(recentConversationEntries?.length ? { recentConversationEntries } : {}),
        ...(typeof record.continuitySummary === "string" && record.continuitySummary.trim().length
          ? { continuitySummary: record.continuitySummary.trim() }
          : {}),
        ...(typeof record.continuitySummaryUpdatedAt === "string" && record.continuitySummaryUpdatedAt.trim().length
          ? { continuitySummaryUpdatedAt: record.continuitySummaryUpdatedAt.trim() }
          : {}),
        ...(typeof record.preferredExecutionLaneId === "string" && record.preferredExecutionLaneId.trim().length
          ? { preferredExecutionLaneId: record.preferredExecutionLaneId.trim() }
          : {}),
        ...(typeof record.selectedExecutionLaneId === "string" && record.selectedExecutionLaneId.trim().length
          ? { selectedExecutionLaneId: record.selectedExecutionLaneId.trim() }
          : {}),
        updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length ? record.updatedAt : nowIso()
      };
      hydrateNativePermissionControls(hydrated as Parameters<typeof hydrateNativePermissionControls>[0]);
      return hydrated;
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

  const applyCompletionReport = (
    managed: ManagedChatSession,
    report: AgentChatCompletionReport,
  ): void => {
    managed.session.completion = report;
    if (report.summary.trim().length > 0) {
      setSessionPreview(managed, report.summary);
    }
    const summary = report.status === "completed"
      ? report.summary
      : `${report.status}: ${report.summary}`;
    sessionService.setSummary(managed.session.id, clipText(summary, 360));
    persistChatState(managed);
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
      && canAppendBufferedAssistantText(buffered, event);

    if (sameChunk) {
      buffered.text += event.text;
      setSessionPreview(managed, buffered.text);
      return;
    }

    managed.previewTextBuffer = {
      text: event.text,
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
    };
    setSessionPreview(managed, event.text);
  };

  const commitChatEvent = (managed: ManagedChatSession, event: AgentChatEvent): void => {
    managed.session.lastActivityAt = nowIso();
    trackSubagentEvent(managed, event);
    appendRecentConversationEntry(managed, event);

    if (event.type === "text") {
      updatePreviewFromText(managed, event);
    } else if (event.type === "command") {
      setSessionPreview(managed, event.output);
    } else if (event.type === "error") {
      setSessionPreview(managed, event.message);
    } else if (event.type === "completion_report") {
      managed.session.completion = event.report;
      if (event.report.summary.trim().length > 0) {
        setSessionPreview(managed, event.report.summary);
      }
      const summary = event.report.status === "completed"
        ? event.report.summary
        : `${event.report.status}: ${event.report.summary}`;
      sessionService.setSummary(managed.session.id, clipText(summary, 360));
    }

    if (event.type === "done") {
      // Only set a fallback summary if no completion_report already provided one.
      const hasCompletionSummary = managed.session.completion?.summary?.trim().length;
      if (!hasCompletionSummary) {
        const preview = managed.preview?.trim() ?? "";
        const summary = preview.length
          ? (event.status === "completed" ? preview : `${event.status}: ${preview}`)
          : (event.status === "completed" ? "Response ready" : `Turn ${event.status}`);
        sessionService.setSummary(managed.session.id, summary);
      }
      // Fire AI-enhanced summary after each completed turn (not just on session end).
      void maybeGenerateSessionSummary(managed, null);
    }

    const envelope: AgentChatEventEnvelope = {
      sessionId: managed.session.id,
      timestamp: nowIso(),
      event,
      sequence: ++managed.eventSequence,
    };

    writeTranscript(managed, envelope);
    onEvent?.(envelope);

    // Passive proof capture: observe tool results for screenshots/artifacts.
    if (proofObserver && event.type === "tool_result") {
      proofObserver.observe(event, managed.session.id);
    }

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

  const flushBufferedText = (managed: ManagedChatSession): void => {
    const buffered = managed.bufferedText;
    if (!buffered) return;
    if (buffered.timer) {
      clearTimeout(buffered.timer);
    }
    managed.bufferedText = null;
    if (!buffered.text.length) return;
    commitChatEvent(managed, {
      type: "text",
      text: buffered.text,
      ...(buffered.messageId ? { messageId: buffered.messageId } : {}),
      ...(buffered.turnId ? { turnId: buffered.turnId } : {}),
      ...(buffered.itemId ? { itemId: buffered.itemId } : {}),
    });
  };

  const scheduleBufferedTextFlush = (managed: ManagedChatSession): void => {
    const buffered = managed.bufferedText;
    if (!buffered || buffered.timer) return;
    buffered.timer = setTimeout(() => {
      if (managed.bufferedText) {
        managed.bufferedText.timer = null;
      }
      flushBufferedText(managed);
    }, BUFFERED_TEXT_FLUSH_MS);
  };

  const queueBufferedTextEvent = (
    managed: ManagedChatSession,
    event: Extract<AgentChatEvent, { type: "text" }>,
  ): void => {
    if (canAppendBufferedAssistantText(managed.bufferedText, event)) {
      managed.bufferedText = {
        ...appendBufferedAssistantText(managed.bufferedText, event),
        timer: managed.bufferedText?.timer ?? null,
      };
      scheduleBufferedTextFlush(managed);
      return;
    }

    flushBufferedText(managed);
    managed.bufferedText = {
      ...appendBufferedAssistantText(null, event),
      timer: null,
    };
    scheduleBufferedTextFlush(managed);
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
    const normalizedEvent = (() => {
      switch (event.type) {
        case "text":
          return ensureAssistantMessageId(managed, event);
        case "tool_call":
        case "tool_result":
        case "command":
        case "file_change":
        case "approval_request":
        case "web_search":
          return ensureLogicalItemId(event);
        default:
          return event;
      }
    })();

    if (normalizedEvent.type === "text") {
      queueBufferedTextEvent(managed, normalizedEvent);
      return;
    }

    if (normalizedEvent.type === "reasoning") {
      queueReasoningEvent(managed, normalizedEvent);
      return;
    }

    if (normalizedEvent.type === "activity") {
      const signature = `${normalizedEvent.turnId ?? ""}:${normalizedEvent.activity}:${normalizedEvent.detail ?? ""}`;
      if (signature === managed.lastActivitySignature) {
        return;
      }
      flushBufferedReasoning(managed);
      if (shouldFlushBufferedAssistantTextForEvent(normalizedEvent)) {
        flushBufferedText(managed);
      }
      managed.lastActivitySignature = signature;
      commitChatEvent(managed, normalizedEvent);
      return;
    }

    flushBufferedReasoning(managed);
    if (shouldFlushBufferedAssistantTextForEvent(normalizedEvent)) {
      flushBufferedText(managed);
      resetAssistantMessageStream(managed);
    }

    if (
      normalizedEvent.type === "user_message"
      || normalizedEvent.type === "status"
      || normalizedEvent.type === "done"
      || normalizedEvent.type === "step_boundary"
      || normalizedEvent.type === "error"
    ) {
      managed.lastActivitySignature = null;
    }

    commitChatEvent(managed, normalizedEvent);
  };

  const emitPendingInputRequest = (
    managed: ManagedChatSession,
    request: PendingInputRequest,
    args?: {
      kind?: "command" | "file_change" | "tool_call";
      description?: string;
      detail?: Record<string, unknown>;
    },
  ): void => {
    const firstQuestion = request.questions[0] ?? null;
    const description = args?.description
      ?? request.description
      ?? request.title
      ?? firstQuestion?.question
      ?? "Input requested";
    emitChatEvent(managed, {
      type: "approval_request",
      itemId: request.itemId ?? request.requestId,
      kind: args?.kind ?? "tool_call",
      description,
      detail: {
        ...(args?.detail ?? {}),
        request,
      },
      turnId: request.turnId ?? undefined,
    });
  };

  const normalizePendingInputAnswers = (
    request: PendingInputRequest | undefined,
    answers: Record<string, string | string[]> | undefined,
    responseText?: string | null,
  ): Record<string, string[]> => {
    const normalized: Record<string, string[]> = {};
    const trimValues = (values: string[]): string[] => values.map((value) => value.trim()).filter((value) => value.length > 0);

    if (request?.questions.length) {
      for (const question of request.questions) {
        const raw = answers?.[question.id];
        let nextValues: string[];
        if (Array.isArray(raw)) {
          nextValues = trimValues(raw.filter((value): value is string => typeof value === "string"));
        } else if (typeof raw === "string") {
          nextValues = trimValues([raw]);
        } else {
          nextValues = [];
        }
        if (nextValues.length > 0) {
          normalized[question.id] = nextValues;
        }
      }
    }

    const trimmedResponse = typeof responseText === "string" ? responseText.trim() : "";
    if (trimmedResponse.length > 0) {
      const fallbackQuestionId = request?.questions[0]?.id ?? "response";
      normalized[fallbackQuestionId] = [trimmedResponse];
    }

    return normalized;
  };

  const requestExecutionLaneForIdentitySession = async (
    managed: ManagedChatSession,
    args: {
      requestedLaneId?: string | null;
      purpose: string;
      freshLaneName?: string | null;
      freshLaneDescription?: string | null;
    },
  ): Promise<string> => {
    const explicitLaneId = typeof args.requestedLaneId === "string" ? args.requestedLaneId.trim() : "";
    if (!usesIdentityContinuity(managed) || managed.session.surface === "automation") {
      return explicitLaneId || managed.preferredExecutionLaneId || managed.selectedExecutionLaneId || managed.session.laneId;
    }
    if (managed.preferredExecutionLaneId) {
      return managed.preferredExecutionLaneId;
    }

    const primaryLaneId = await resolvePrimaryIdentityLane();
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
    const selectedLaneId = explicitLaneId || managed.selectedExecutionLaneId || primaryLaneId;
    const primaryLane = lanes.find((lane) => lane.id === primaryLaneId) ?? null;
    const selectedLane = lanes.find((lane) => lane.id === selectedLaneId) ?? null;
    const itemId = randomUUID();
    const request: PendingInputRequest = {
      requestId: itemId,
      itemId,
      source: "ade",
      kind: "structured_question",
      title: "Choose execution lane",
      description: `Choose where ADE should launch implementation work for ${args.purpose}.`,
      questions: [{
        id: "lane_choice",
        header: "Execution lane",
        question: "Where should ADE launch the implementation work?",
        options: [
          {
            label: "Primary",
            value: "primary",
            description: primaryLane
              ? `Keep work on the canonical primary lane (${primaryLane.name}).`
              : "Keep work on the canonical primary lane.",
            recommended: true,
          },
          {
            label: "Selected",
            value: "selected",
            description: selectedLane && selectedLane.id !== primaryLaneId
              ? `Use the lane currently selected in the UI (${selectedLane.name}).`
              : "Use the lane currently selected in the UI. If none is selected, ADE will fall back to primary.",
          },
          {
            label: "Fresh lane",
            value: "fresh_lane",
            description: "Create a dedicated implementation lane for this task before launching work.",
          },
        ],
        allowsFreeform: false,
      }],
      allowsFreeform: false,
      blocking: true,
      canProceedWithoutAnswer: false,
      providerMetadata: {
        promptKind: "execution_lane_choice",
        purpose: args.purpose,
        selectedLaneId: selectedLaneId || null,
        primaryLaneId,
      },
    };

    const response = await new Promise<{
      decision?: AgentChatApprovalDecision;
      answers?: Record<string, string | string[]>;
      responseText?: string | null;
    }>((resolve) => {
      managed.localPendingInputs.set(itemId, { request, resolve });
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: request.description ?? "Choose where to launch implementation work.",
        detail: request.providerMetadata as Record<string, unknown>,
      });
      persistChatState(managed);
    });

    const normalizedAnswers = normalizePendingInputAnswers(request, response.answers, response.responseText);
    const selection = normalizedAnswers.lane_choice?.[0] ?? "";
    if (response.decision === "cancel" || response.decision === "decline" || !selection.length) {
      emitChatEvent(managed, {
        type: "tool_result",
        tool: "choose_execution_lane",
        result: { success: false, reason: "cancelled" },
        itemId,
        status: "failed",
      });
      throw new Error("Execution lane selection is required before launching implementation work.");
    }

    let resolvedLaneId = primaryLaneId;
    if (selection === "selected") {
      resolvedLaneId = selectedLaneId || primaryLaneId;
    } else if (selection === "fresh_lane") {
      const createdLane = await laneService.create({
        name: (args.freshLaneName?.trim() || args.purpose).slice(0, 72),
        description: args.freshLaneDescription?.trim()
          || `Implementation lane launched from ${managed.session.identityKey === "cto" ? "CTO" : "employee"} chat.`,
        parentLaneId: primaryLaneId,
      });
      resolvedLaneId = createdLane.id;
    }

    managed.preferredExecutionLaneId = resolvedLaneId;
    managed.selectedExecutionLaneId = selectedLaneId || managed.selectedExecutionLaneId;
    emitChatEvent(managed, {
      type: "tool_result",
      tool: "choose_execution_lane",
      result: { success: true, selection, laneId: resolvedLaneId },
      itemId,
      status: "completed",
    });
    persistChatState(managed);
    return resolvedLaneId;
  };

  /** Tear down the active runtime, releasing all resources and cancelling pending approvals. */
  const teardownRuntime = (managed: ManagedChatSession): void => {
    flushBufferedReasoning(managed);
    flushBufferedText(managed);
    if (managed.runtime?.kind === "codex") {
      managed.runtime.suppressExitError = true;
      try { managed.runtime.reader.close(); } catch { /* ignore */ }
      try { managed.runtime.process.kill(); } catch { /* ignore */ }
      managed.runtime.pending.clear();
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "claude") {
      cancelClaudeWarmup(managed, managed.runtime, "teardown");
      managed.runtime.activeQuery?.close();
      managed.runtime.activeQuery = null;
      try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
      managed.runtime.v2Session = null;
      managed.runtime.v2StreamGen = null;
      managed.runtime.v2WarmupDone = null;
      managed.runtime.activeSubagents.clear();
      for (const pending of managed.runtime.approvals.values()) {
        pending.resolve({ decision: "cancel" });
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
    if (managed.summaryInFlight) return;

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
        "openai/gpt-5.4-mini",
        "openai/gpt-5.2",
        availableModels[0]?.id,
      ].find((candidate) => {
        const modelId = typeof candidate === "string" ? candidate.trim() : "";
        return modelId.length > 0 && availableModels.some((d) => d.id === modelId);
      }) ?? null;

    if (!preferredModelId) return;
    const descriptor = getModelById(preferredModelId);
    if (!descriptor) return;

    const baseSummary = session.summary ?? deterministicText ?? "";
    const userRequest = managed.autoTitleSeed?.trim() ?? "";
    const prompt = [
      "You are ADE's session summary assistant.",
      "Rewrite this chat session into a concise 1-3 sentence summary describing what was accomplished and any outcome.",
      "Do not invent actions or outcomes not mentioned. Return only the summary text.",
      "",
      `Session title: ${session.title}`,
      session.goal ? `Goal: ${session.goal}` : null,
      userRequest ? `User request: ${userRequest}` : null,
      baseSummary ? `Current summary: ${baseSummary}` : null,
      session.lastOutputPreview ? `Latest output: ${session.lastOutputPreview}` : null,
    ].filter(Boolean).join("\n");

    managed.summaryInFlight = true;
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
    } finally {
      managed.summaryInFlight = false;
    }
  };

  const finishSession = async (
    managed: ManagedChatSession,
    status: TerminalSessionStatus,
    options?: { exitCode?: number | null; summary?: string | null }
  ): Promise<void> => {
    if (managed.endedNotified) return;
    managed.endedNotified = true;
    clearSubagentSnapshots(managed.session.id);
    flushBufferedText(managed);
    flushBufferedReasoning(managed);
    for (const pending of managed.localPendingInputs.values()) {
      pending.resolve({ decision: "cancel" });
    }
    managed.localPendingInputs.clear();

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
        interactionMode: persisted?.interactionMode ?? null,
        ...(persisted?.claudePermissionMode ? { claudePermissionMode: persisted.claudePermissionMode } : {}),
        ...(persisted?.codexApprovalPolicy ? { codexApprovalPolicy: persisted.codexApprovalPolicy } : {}),
        ...(persisted?.codexSandbox ? { codexSandbox: persisted.codexSandbox } : {}),
        ...(persisted?.codexConfigSource ? { codexConfigSource: persisted.codexConfigSource } : {}),
        ...(persisted?.unifiedPermissionMode ? { unifiedPermissionMode: persisted.unifiedPermissionMode } : {}),
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        computerUse: normalizePersistedComputerUse(persisted?.computerUse),
        completion: persisted?.completion ?? null,
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
      summaryInFlight: false,
      continuitySummary: persisted?.continuitySummary ?? null,
      continuitySummaryUpdatedAt: persisted?.continuitySummaryUpdatedAt ?? null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: persisted?.preferredExecutionLaneId ?? null,
      selectedExecutionLaneId: persisted?.selectedExecutionLaneId ?? null,
      activeAssistantMessageId: null,
      lastActivitySignature: null,
      bufferedReasoning: null,
      previewTextBuffer: null,
      bufferedText: null,
      recentConversationEntries: persisted?.recentConversationEntries?.map((entry) => ({
        role: entry.role,
        text: entry.text,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      })) ?? [],
      localPendingInputs: new Map(),
      eventSequence: 0,
    };
    normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });

    managedSessions.set(sessionId, managed);
    return managed;
  };

  const emitPreparedUserMessage = (
    managed: ManagedChatSession,
    args: {
      text: string;
      attachments: AgentChatFileRef[];
      turnId?: string;
      onDispatched?: () => void;
    },
  ): void => {
    emitChatEvent(managed, {
      type: "user_message",
      text: args.text,
      attachments: args.attachments,
      ...(args.turnId ? { turnId: args.turnId } : {}),
    });
    args.onDispatched?.();
  };

  const sendCodexMessage = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
      resolvedAttachments?: ResolvedAgentChatFileRef[];
      onDispatched?: () => void;
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
    const resolvedAttachments = args.resolvedAttachments ?? attachments.map((attachment) => ({
      ...attachment,
      _resolvedPath: attachment.path,
      _rootPath: managed.laneWorktreePath,
    }));
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
    const autoMemoryPlan = await buildAutoMemoryTurnPlan(managed, displayText, attachments);
    const autoMemoryNotice = buildAutoMemorySystemNotice(autoMemoryPlan);

    // Intercept /review command — route to review/start RPC instead of turn/start
    if (args.promptText.trim().startsWith("/review")) {
      emitPreparedUserMessage(managed, {
        text: displayText,
        attachments,
        onDispatched: args.onDispatched,
      });
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

    const input: Array<Record<string, unknown>> = [];

    const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
    if (reconstructionContext.length) {
      input.push({
        type: "text",
        text: [
          "System context (CTO reconstruction, do not echo verbatim):",
          reconstructionContext
        ].join("\n"),
        text_elements: []
      });
      managed.pendingReconstructionContext = null;
    }
    if (autoMemoryPlan.contextText.length) {
      input.push({
        type: "text",
        text: autoMemoryPlan.contextText,
        text_elements: [],
      });
    }
    input.push({
      type: "text",
      text: args.promptText,
      text_elements: []
    });

    for (const attachment of resolvedAttachments) {
      const stagedPath = stageAttachmentForCodexInput(attachment);
      if (attachment.type === "image") {
        input.push({ type: "localImage", path: stagedPath });
        continue;
      }
      const name = path.basename(attachment.path) || attachment.path;
      input.push({ type: "mention", name, path: stagedPath });
    }

    managed.session.status = "active";
    emitPreparedUserMessage(managed, {
      text: displayText,
      attachments,
      onDispatched: args.onDispatched,
    });
    if (autoMemoryNotice) {
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "memory",
        message: autoMemoryNotice.message,
        detail: autoMemoryNotice.detail,
      });
    }

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

  const mapReasoningEffortToThinking = (effort: string | null | undefined): ThinkingLevel | null => {
    if (!effort) return null;
    const map: Record<string, ThinkingLevel> = {
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
      resolvedAttachments?: ResolvedAgentChatFileRef[];
      onDispatched?: () => void;
    },
  ): Promise<void> => {
    const runtime = managed.runtime;
    if (runtime?.kind !== "claude") {
      throw new Error(`Claude runtime is not available for session '${managed.session.id}'.`);
    }
    const validation = validateSessionReadyForTurn(managed);
    if (!validation.ready) {
      logger.warn("agent_chat.turn_not_ready", { sessionId: managed.session.id, reason: validation.reason });
      throw new Error(validation.reason);
    }

    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";

    const attachments = args.attachments ?? [];
    const resolvedAttachments = args.resolvedAttachments ?? attachments.map((attachment) => ({
      ...attachment,
      _resolvedPath: attachment.path,
      _rootPath: managed.laneWorktreePath,
    }));
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
    emitPreparedUserMessage(managed, {
      text: displayText,
      attachments,
      turnId,
      onDispatched: args.onDispatched,
    });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null } | undefined;
    let costUsd: number | null = null;
    const turnStartedAt = Date.now();
    let firstStreamEventLogged = false;
    const emittedClaudeToolIds = new Set<string>();
    const markFirstStreamEvent = (kind: string): void => {
      if (firstStreamEventLogged) return;
      firstStreamEventLogged = true;
      logger.info("agent_chat.turn_first_event", {
        sessionId: managed.session.id,
        provider: "claude",
        turnId,
        kind,
        latencyMs: Date.now() - turnStartedAt,
      });
    };
    const buildClaudeContentItemId = (
      kind: "thinking" | "tool",
      contentIndex: number | null | undefined,
      explicitId?: string | null,
    ): string | undefined => {
      const normalizedExplicitId = explicitId?.trim();
      if (normalizedExplicitId) return normalizedExplicitId;
      if (typeof contentIndex !== "number" || !Number.isFinite(contentIndex)) return undefined;
      return `claude-${kind}:${turnId}:${contentIndex}`;
    };

    try {
      const autoMemoryPrompt = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
      const autoMemoryPlan = await buildAutoMemoryTurnPlan(managed, autoMemoryPrompt, attachments);
      const autoMemoryNotice = buildAutoMemorySystemNotice(autoMemoryPlan);
      runtime.turnMemoryPolicyState = {
        classification: autoMemoryPlan.classification,
        orientationSatisfied: autoMemoryPlan.telemetry.searched,
        explicitSearchPerformed: false,
      };
      if (autoMemoryNotice) {
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "memory",
          message: autoMemoryNotice.message,
          detail: autoMemoryNotice.detail,
          turnId,
        });
      }

      const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
      const basePromptText = [
        reconstructionContext.length
          ? [
              "System context (identity reconstruction, do not echo verbatim):",
              reconstructionContext,
            ].join("\n")
          : null,
        autoMemoryPlan.contextText.length ? autoMemoryPlan.contextText : null,
        args.promptText,
      ].filter((section): section is string => Boolean(section)).join("\n\n");
      if (reconstructionContext.length) {
        managed.pendingReconstructionContext = null;
        persistChatState(managed);
      }
      // ── V2 persistent session with background pre-warming ──
      // The pre-warm was kicked off in ensureClaudeSessionRuntime. Wait for it.
      if (runtime.v2WarmupDone) {
        const warmupWaitStartedAt = Date.now();
        logger.info("agent_chat.claude_v2_turn_waiting_for_warmup", {
          sessionId: managed.session.id,
          turnId,
        });
        await runtime.v2WarmupDone;
        logger.info("agent_chat.claude_v2_turn_warmup_wait_done", {
          sessionId: managed.session.id,
          turnId,
          waitedMs: Date.now() - warmupWaitStartedAt,
        });
      }
      if (runtime.interrupted) {
        throw new Error("Claude turn interrupted during warmup.");
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

      // Build the message — plain string for text-only, or SDKUserMessage with
      // image content blocks (streaming input format per SDK docs).
      const messageToSend = buildClaudeV2Message(basePromptText, resolvedAttachments, {
        baseDir: managed.laneWorktreePath,
      });
      const turnPermissionMode = resolveClaudeTurnPermissionMode(managed);

      if (typeof runtime.v2Session.setPermissionMode === "function") {
        await runtime.v2Session.setPermissionMode(turnPermissionMode);
      } else if (turnPermissionMode === "plan") {
        throw new Error("Claude plan mode is not available in this Claude SDK build.");
      }

      // V2 pattern: send() then stream() per turn. Session stays alive between turns.
      await runtime.v2Session.send(messageToSend);

      // Don't emit a pre-emptive "thinking" activity — wait for actual content from the stream.
      // The renderer will show the turn as "started" (from the status event above) which is sufficient.

      for await (const msg of runtime.v2Session.stream()) {
        if (runtime.interrupted) break;
        markFirstStreamEvent(msg.type);

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
            applyClaudeSlashCommands(runtime, initMsg.slash_commands);
          }
          try {
            const sessionImpl = runtime.v2Session as any;
            if (typeof sessionImpl?.supportedCommands === "function") {
              sessionImpl.supportedCommands().then((cmds: any[]) => {
                if (Array.isArray(cmds) && cmds.length > 0) {
                  applyClaudeSlashCommands(runtime, cmds);
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
          // Re-inject identity context after compaction so the CTO doesn't lose
          // its persona, core memory, or memory protocol instructions.
          if (managed.session.identityKey) {
            if (managed.session.identityKey === "cto" && ctoStateService) {
              ctoStateService.appendContinuityCheckpoint({
                reason: "compaction",
                entries: managed.recentConversationEntries.map((entry) => ({
                  role: entry.role,
                  text: entry.text,
                })),
              });
            }
            void maybeRefreshIdentityContinuitySummary(managed, "compaction");
            refreshReconstructionContext(managed, { includeConversationTail: true });
          }
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
            reportProviderRuntimeAuthFailure("claude", CLAUDE_RUNTIME_AUTH_ERROR);
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "auth",
              message: CLAUDE_RUNTIME_AUTH_ERROR,
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

        // system:task_progress — running subagent summary/usage
        if (msg.type === "system" && (msg as any).subtype === "task_progress") {
          const taskMsg = msg as any;
          const taskId = String(taskMsg.task_id ?? "");
          if (!taskId) continue;
          const existing = runtime.activeSubagents.get(taskId);
          const description = String(taskMsg.description ?? existing?.description ?? "");
          runtime.activeSubagents.set(taskId, { taskId, description });
          emitChatEvent(managed, {
            type: "subagent_progress",
            taskId,
            description,
            summary: String(taskMsg.summary ?? ""),
            usage: taskMsg.usage ? {
              totalTokens: typeof taskMsg.usage.total_tokens === "number" ? taskMsg.usage.total_tokens : undefined,
              toolUses: typeof taskMsg.usage.tool_uses === "number" ? taskMsg.usage.tool_uses : undefined,
              durationMs: typeof taskMsg.usage.duration_ms === "number" ? taskMsg.usage.duration_ms : undefined,
            } : undefined,
            lastToolName: typeof taskMsg.last_tool_name === "string" ? taskMsg.last_tool_name : undefined,
            turnId,
          });
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
            background: isBackgroundTask(taskMsg as Record<string, unknown>),
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
            for (const [blockIndex, block] of betaMessage.content.entries()) {
              if (block.type === "text") {
                assistantText += block.text ?? "";
                emitChatEvent(managed, {
                  type: "text",
                  text: block.text ?? "",
                  turnId,
                });
              } else if (block.type === "thinking") {
                const thinkingText = block.thinking ?? block.text ?? "";
                const reasoningItemId = buildClaudeContentItemId("thinking", blockIndex);
                emitChatEvent(managed, {
                  type: "activity",
                  activity: "thinking",
                  detail: REASONING_ACTIVITY_DETAIL,
                  turnId,
                });
                emitChatEvent(managed, {
                  type: "reasoning",
                  text: thinkingText,
                  ...(reasoningItemId ? { itemId: reasoningItemId } : {}),
                  turnId,
                });
              } else if (block.type === "tool_use") {
                const toolName = String(block.name ?? "tool");
                const itemId = buildClaudeContentItemId(
                  "tool",
                  blockIndex,
                  typeof block.id === "string" ? block.id : null,
                ) ?? randomUUID();
                const nextActivity = activityForToolName(toolName);
                if (!emittedClaudeToolIds.has(itemId)) {
                  emittedClaudeToolIds.add(itemId);
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
                    itemId,
                    turnId,
                  });
                }
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
          const contentIndex = typeof event.index === "number" ? event.index : null;

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
                const reasoningItemId = buildClaudeContentItemId("thinking", contentIndex);
                emitChatEvent(managed, {
                  type: "activity",
                  activity: "thinking",
                  detail: REASONING_ACTIVITY_DETAIL,
                  turnId,
                });
                emitChatEvent(managed, {
                  type: "reasoning",
                  text,
                  ...(reasoningItemId ? { itemId: reasoningItemId } : {}),
                  turnId,
                });
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
              const reasoningItemId = buildClaudeContentItemId("thinking", contentIndex);
              emitChatEvent(managed, {
                type: "activity",
                activity: "thinking",
                detail: REASONING_ACTIVITY_DETAIL,
                turnId,
              });
              // Some SDK versions include initial thinking text on block start
              const startText = block.thinking ?? block.text ?? "";
              if (startText.length) {
                emitChatEvent(managed, {
                  type: "reasoning",
                  text: startText,
                  ...(reasoningItemId ? { itemId: reasoningItemId } : {}),
                  turnId,
                });
              }
            } else if (block?.type === "tool_use") {
              const toolName = String(block.name ?? "tool");
              const itemId = buildClaudeContentItemId(
                "tool",
                contentIndex,
                typeof block.id === "string" ? block.id : null,
              ) ?? randomUUID();
              const nextActivity = activityForToolName(toolName);
              if (!emittedClaudeToolIds.has(itemId)) {
                emittedClaudeToolIds.add(itemId);
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
                  itemId,
                  turnId,
                });
              }
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

        // prompt_suggestion — follow-up suggestions forwarded to the UI
        if ((msg as any).type === "prompt_suggestion") {
          const suggestionMsg = msg as Record<string, unknown>;
          const suggestionText =
            [suggestionMsg.suggestion, suggestionMsg.prompt, suggestionMsg.text]
              .find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim() ?? null;
          if (suggestionText) {
            emitChatEvent(managed, {
              type: "prompt_suggestion",
              suggestion: suggestionText,
              turnId,
            });
          }
          continue;
        }
      }

      // ── Turn completion ──
      // Note: v2Session is NOT closed here — it stays alive for the next turn
      runtime.activeQuery = null;
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.turnMemoryPolicyState = null;
      managed.session.status = "idle";
      reportProviderRuntimeReady("claude");

      // Flush deferred session reset from mid-turn reasoning effort change
      if (runtime.pendingSessionReset) {
        runtime.pendingSessionReset = false;
        cancelClaudeWarmup(managed, runtime, "session_reset");
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
        runtime.v2WarmupDone = null;
      }

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

      // Process queued steers (skip if session was disposed during execution)
      if (!managed.closed && runtime.pendingSteers.length) {
        const steerText = runtime.pendingSteers.shift() ?? "";
        if (steerText.trim().length) {
          await runClaudeTurn(managed, { promptText: steerText, displayText: steerText, attachments: [] });
        }
      }
    } catch (error) {
      runtime.activeQuery = null;
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.turnMemoryPolicyState = null;

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
        const isAuthFailure = isClaudeRuntimeAuthError(error);
        const errorMessage = isAuthFailure
          ? CLAUDE_RUNTIME_AUTH_ERROR
          : (error instanceof Error ? error.message : String(error));
        if (isAuthFailure) {
          reportProviderRuntimeAuthFailure("claude", CLAUDE_RUNTIME_AUTH_ERROR);
        } else {
          reportProviderRuntimeFailure("claude", errorMessage);
        }
        emitChatEvent(managed, {
          type: "error",
          message: errorMessage,
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
          summary: `Turn failed: ${errorMessage}`,
        });

        // If resume failed, clear sessionId and the caller can retry fresh
        if (runtime.sdkSessionId && String(error).includes("session")) {
          logger.warn("agent_chat.claude_sdk_session_error", {
            sessionId: managed.session.id,
            sdkSessionId: runtime.sdkSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          runtime.sdkSessionId = null;
          void maybeRefreshIdentityContinuitySummary(managed, "provider_reset");
          refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });
          prewarmClaudeV2Session(managed);
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
      resolvedAttachments?: ResolvedAgentChatFileRef[];
      onDispatched?: () => void;
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
    const validation = validateSessionReadyForTurn(managed);
    if (!validation.ready) {
      logger.warn("agent_chat.turn_not_ready", { sessionId: managed.session.id, reason: validation.reason });
      throw new Error(validation.reason);
    }
    const turnId = randomUUID();
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    managed.session.status = "active";
    const attachments = args.attachments ?? [];
    const resolvedAttachments = args.resolvedAttachments ?? attachments.map((attachment) => ({
      ...attachment,
      _resolvedPath: attachment.path,
      _rootPath: managed.laneWorktreePath,
    }));
    const displayText = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
    emitPreparedUserMessage(managed, {
      text: displayText,
      attachments,
      turnId,
      onDispatched: args.onDispatched,
    });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null } | undefined;
    let streamedStepCount = 0;
    const turnStartedAt = Date.now();
    let firstStreamEventLogged = false;
    const markFirstStreamEvent = (kind: string): void => {
      if (firstStreamEventLogged) return;
      firstStreamEventLogged = true;
      logger.info("agent_chat.turn_first_event", {
        sessionId: managed.session.id,
        provider: managed.session.provider,
        turnId,
        kind,
        latencyMs: Date.now() - turnStartedAt,
      });
    };

    let turnTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const autoMemoryPrompt = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
      const autoMemoryPlan = await buildAutoMemoryTurnPlan(managed, autoMemoryPrompt, attachments);
      const autoMemoryNotice = buildAutoMemorySystemNotice(autoMemoryPlan);
      const turnMemoryPolicyState: TurnMemoryPolicyState | undefined = memoryService && projectId
        ? {
            classification: autoMemoryPlan.classification,
            orientationSatisfied: autoMemoryPlan.telemetry.searched,
            explicitSearchPerformed: false,
          }
        : undefined;
      if (autoMemoryNotice) {
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "memory",
          message: autoMemoryNotice.message,
          detail: autoMemoryNotice.detail,
          turnId,
        });
      }

      const attachmentHint = attachments.length
        ? `\n\nAttached context:\n${attachments.map((file) => `- ${file.type}: ${file.path}`).join("\n")}`
        : "";
      const userContent = [
        autoMemoryPlan.contextText.length ? autoMemoryPlan.contextText : null,
        `${args.promptText}${attachmentHint}`,
      ].filter((section): section is string => Boolean(section)).join("\n\n");
      const streamingBaseText = autoMemoryPlan.contextText.length
        ? `${autoMemoryPlan.contextText}\n\n${args.promptText}`
        : args.promptText;

      applyReconstructionContextToStreamingRuntime(managed, runtime);

      runtime.messages.push({ role: "user", content: userContent });

      const abortController = new AbortController();
      runtime.abortController = abortController;

      // Turn-level timeout: abort if the entire turn exceeds the limit
      turnTimeout = setTimeout(() => {
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
            baseText: streamingBaseText,
            attachments: resolvedAttachments,
            runtimeKind: "unified",
            modelDescriptor: runtime.modelDescriptor,
            logger,
          }),
        };
      });
      const lightweight = isLightweightSession(managed.session);
      const tools = lightweight
        ? {}
        : createUniversalToolSet(managed.laneWorktreePath, {
            permissionMode: runtime.permissionMode,
            ...(memoryService && projectId ? { memoryService, projectId } : {}),
            agentScopeOwnerId: managed.session.identityKey ?? managed.session.id,
            ...(turnMemoryPolicyState ? { turnMemoryPolicyState } : {}),
            onMemoryWriteEvent: (event) => {
              const notice = buildMemoryWriteNotice(event);
              emitChatEvent(managed, {
                type: "system_notice",
                noticeKind: "memory",
                message: notice.message,
                ...(notice.detail ? { detail: notice.detail } : {}),
                turnId,
              });
            },
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

              const isPlanApproval = category === "exitPlanMode";
              const planContent = isPlanApproval && detail && typeof detail === "object" && !Array.isArray(detail)
                ? (detail as Record<string, unknown>).planContent as string | undefined
                : undefined;

              const approvalItemId = randomUUID();
              const request: PendingInputRequest = {
                requestId: approvalItemId,
                itemId: approvalItemId,
                source: "unified",
                kind: isPlanApproval ? "plan_approval" : "approval",
                ...(isPlanApproval ? { title: "Plan Ready for Review" } : {}),
                description,
                questions: isPlanApproval ? [{
                  id: "plan_decision",
                  header: "Implementation Plan",
                  question: planContent ?? description,
                  options: [
                    { label: "Approve & Implement", value: "approve", recommended: true },
                    { label: "Reject & Revise", value: "reject" },
                  ],
                  allowsFreeform: true,
                }] : [],
                allowsFreeform: isPlanApproval,
                blocking: true,
                canProceedWithoutAnswer: false,
                providerMetadata: {
                  category,
                  detail,
                },
                turnId,
              };
              emitPendingInputRequest(managed, request, {
                kind: isPlanApproval ? "tool_call" : category === "bash" ? "command" : "file_change",
                description: isPlanApproval ? "Plan ready for approval" : description,
                detail: detail && typeof detail === "object" && !Array.isArray(detail)
                  ? { ...(detail as Record<string, unknown>) }
                  : {},
              });

              const response = await new Promise<{ decision?: AgentChatApprovalDecision; responseText?: string | null; answers?: Record<string, string | string[]> }>((resolve) => {
                runtime.pendingApprovals.set(approvalItemId, { category, request, resolve });
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
              const request: PendingInputRequest = {
                requestId: askItemId,
                itemId: askItemId,
                source: "unified",
                kind: "question",
                description: question,
                questions: [
                  {
                    id: "response",
                    header: "Question",
                    question,
                    allowsFreeform: true,
                  },
                ],
                allowsFreeform: true,
                blocking: true,
                canProceedWithoutAnswer: false,
                providerMetadata: {
                  tool: "askUser",
                  inputType: "text",
                },
                turnId,
              };
              emitPendingInputRequest(managed, request, {
                kind: "tool_call",
                description: question,
                detail: { tool: "askUser", question, inputType: "text" },
              });

              const response = await new Promise<{ decision?: AgentChatApprovalDecision; responseText?: string | null; answers?: Record<string, string | string[]> }>((resolve) => {
                runtime.pendingApprovals.set(askItemId, { category: "askUser", request, resolve });
              });
              runtime.pendingApprovals.delete(askItemId);
              const normalizedAnswers = normalizePendingInputAnswers(request, response.answers, response.responseText);
              const answer = normalizedAnswers.response?.[0] ?? "";
              if (answer.length) return answer;
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
          computerUsePolicy: managed.session.computerUse,
          onReportCompletion: async (report) => {
            applyCompletionReport(managed, report);
            emitChatEvent(managed, {
              type: "completion_report",
              report,
            });
          },
          sessionId: managed.session.id,
          laneId: managed.session.laneId,
        });
        Object.assign(tools, workflowTools);

        // Merge Linear tools (issue read/write, comments, state transitions)
        const linearTools = createLinearTools({
          linearClient: linearClientRef ?? null,
          credentials: linearCredentialsRef ?? null,
        });
        Object.assign(tools, linearTools);

        if (managed.session.identityKey === "cto") {
          Object.assign(tools, createCtoOperatorTools({
            currentSessionId: managed.session.id,
            defaultLaneId: managed.session.laneId,
            defaultModelId: managed.session.modelId ?? null,
            defaultReasoningEffort: managed.session.reasoningEffort ?? null,
            resolveExecutionLane: async ({ requestedLaneId, purpose, freshLaneName, freshLaneDescription }) =>
              requestExecutionLaneForIdentitySession(managed, {
                requestedLaneId,
                purpose,
                freshLaneName,
                freshLaneDescription,
              }),
            laneService,
            missionService: getMissionService?.() ?? null,
            aiOrchestratorService: getAiOrchestratorService?.() ?? null,
            workerAgentService: workerAgentService ?? null,
            workerHeartbeatService: workerHeartbeatService ?? null,
            linearDispatcherService: getLinearDispatcherService?.() ?? null,
            flowPolicyService: flowPolicyService ?? null,
            prService: prService ?? null,
            fileService: fileService ?? null,
            processService: processService ?? null,
            testService: getTestService?.() ?? null,
            ptyService: ptyService ?? null,
            automationService: getAutomationService?.() ?? null,
            issueTracker: linearIssueTracker ?? null,
            listChats: listSessions,
            getChatStatus: getSessionSummary,
            getChatTranscript,
            createChat: createSession,
            updateChatSession: updateSession,
            sendChatMessage: sendMessage,
            interruptChat: interrupt,
            resumeChat: resumeSession,
            disposeChat: dispose,
            ensureCtoSession: async ({ laneId, modelId, reasoningEffort, reuseExisting }) =>
              ensureIdentitySession({
                identityKey: "cto",
                laneId,
                modelId,
                reasoningEffort,
                reuseExisting,
                permissionMode: "full-auto",
              }),
          }));
        }
      }

      const thinkingLevel = mapReasoningEffortToThinking(managed.session.reasoningEffort);
      const providerOptions = providerResolver.buildProviderOptions(runtime.modelDescriptor, thinkingLevel);
      const baseHarnessPrompt = lightweight
        ? undefined
        : buildCodingAgentSystemPrompt({
            cwd: managed.laneWorktreePath,
            mode: "chat",
            permissionMode: runtime.permissionMode,
            toolNames: Object.keys(tools),
          });
      // For CTO sessions, compose the CTO's identity prompt into the system
      // prompt so it survives compaction (system prompt is never compacted).
      const harnessPrompt = (() => {
        if (!baseHarnessPrompt) return undefined;
        if (managed.session.identityKey === "cto" && ctoStateService) {
          const ctoPrompt = ctoStateService.previewSystemPrompt().prompt;
          return `${baseHarnessPrompt}\n\n## CTO Identity\n${ctoPrompt}`;
        }
        return baseHarnessPrompt;
      })();

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
        markFirstStreamEvent(String(part.type ?? "unknown"));

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

      // Process queued steers (skip if session was disposed during execution)
      if (!managed.closed && runtime.pendingSteers.length) {
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
      const description = params.reason?.trim() || `Run command: ${params.command ?? "command"}`;
      const request: PendingInputRequest = {
        requestId: String(id),
        itemId,
        source: "codex",
        kind: "approval",
        description,
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null,
        },
        turnId: runtime.activeTurnId ?? null,
      };
      runtime.approvals.set(itemId, { requestId: id, kind: "command", request });
      emitPendingInputRequest(managed, request, {
        kind: "command",
        description,
        detail: {
          command: params.command ?? null,
          cwd: params.cwd ?? null,
          reason: params.reason ?? null,
        },
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
      const description = params.reason?.trim() || "Approve file changes";
      const request: PendingInputRequest = {
        requestId: String(id),
        itemId,
        source: "codex",
        kind: "approval",
        description,
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          grantRoot: params.grantRoot ?? null,
          reason: params.reason ?? null,
        },
        turnId: runtime.activeTurnId ?? null,
      };
      runtime.approvals.set(itemId, { requestId: id, kind: "file_change", request });
      emitPendingInputRequest(managed, request, {
        kind: "file_change",
        description,
        detail: {
          grantRoot: params.grantRoot ?? null,
          reason: params.reason ?? null,
        },
      });
      return;
    }

    if (method === "item/permissions/requestApproval") {
      const params = (payload.params as {
        itemId?: string;
        permissions?: Record<string, unknown> | null;
        reason?: string | null;
        threadId?: string;
        turnId?: string;
      } | null) ?? {};
      const itemId = String(params.itemId ?? randomUUID());
      const description = typeof params.reason === "string" && params.reason.trim().length
        ? params.reason.trim()
        : "Codex requested additional permissions";
      const request: PendingInputRequest = {
        requestId: String(id),
        itemId,
        source: "codex",
        kind: "permissions",
        title: "Additional permissions requested",
        description,
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          permissions: params.permissions ?? null,
          threadId: params.threadId ?? null,
          turnId: params.turnId ?? null,
        },
        turnId: typeof params.turnId === "string" ? params.turnId : runtime.activeTurnId ?? null,
      };
      runtime.approvals.set(itemId, {
        requestId: id,
        kind: "permissions",
        permissions: params.permissions ?? null,
        request,
      });
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description,
        detail: {
          permissions: params.permissions ?? null,
          reason: params.reason ?? null,
        },
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      const params = (payload.params as {
        itemId?: string;
        threadId?: string;
        turnId?: string;
        questions?: Array<{
          id?: string;
          header?: string;
          question?: string;
          isOther?: boolean;
          isSecret?: boolean;
          options?: Array<{ label?: string; description?: string }> | null;
        }>;
      } | null) ?? {};
      const itemId = String(params.itemId ?? randomUUID());
      const questions: PendingInputQuestion[] = Array.isArray(params.questions)
        ? params.questions.flatMap((question, index) => {
            const questionId = typeof question?.id === "string" && question.id.trim().length ? question.id.trim() : `question_${index + 1}`;
            const questionText = typeof question?.question === "string" ? question.question.trim() : "";
            if (!questionText.length) return [];
            const options = Array.isArray(question?.options)
              ? question.options.flatMap((option) => {
                  const label = typeof option?.label === "string" ? option.label.trim() : "";
                  if (!label.length) return [];
                  const description = typeof option?.description === "string" ? option.description.trim() : "";
                  return [{
                    label,
                    value: label,
                    ...(description ? { description } : {}),
                  }];
                })
              : [];
            return [{
              id: questionId,
              header: typeof question?.header === "string" && question.header.trim().length ? question.header.trim() : `Question ${index + 1}`,
              question: questionText,
              allowsFreeform: question?.isOther === true || options.length === 0,
              isSecret: question?.isSecret === true,
              ...(options.length ? { options } : {}),
            }];
          })
        : [];
      const request: PendingInputRequest = {
        requestId: String(id),
        itemId,
        source: "codex",
        kind: "structured_question",
        title: "Input requested",
        description: questions[0]?.question ?? "Codex requested input",
        questions,
        allowsFreeform: questions.some((question) => question.allowsFreeform !== false),
        blocking: true,
        canProceedWithoutAnswer: false,
        turnId: typeof params.turnId === "string" ? params.turnId : runtime.activeTurnId ?? null,
        providerMetadata: {
          threadId: params.threadId ?? null,
        },
      };
      runtime.approvals.set(itemId, { requestId: id, kind: "structured_question", request });
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: request.description ?? "Codex requested input",
      });
      return;
    }

    runtime.sendError(id, `Unsupported server request: ${method || "unknown"}`);
  };

  const handleCodexItemEvent = (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    item: Record<string, unknown>,
    eventKind: "started" | "completed",
    turnIdHint?: string,
  ): void => {
    const itemId = String(item.id ?? randomUUID());
    const itemType = String(item.type ?? "");
    const turnId = (() => {
      const explicitTurnId = turnIdHint ?? extractCodexTurnId(item);
      if (eventKind === "started") {
        const startedTurnId = explicitTurnId ?? runtime.activeTurnId ?? undefined;
        if (startedTurnId) {
          runtime.itemTurnIdByItemId.set(itemId, startedTurnId);
        }
        return startedTurnId;
      }
      const completedTurnId = explicitTurnId ?? runtime.itemTurnIdByItemId.get(itemId) ?? runtime.activeTurnId ?? undefined;
      runtime.itemTurnIdByItemId.delete(itemId);
      return completedTurnId;
    })();

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
          background: isBackgroundTask(item as Record<string, unknown>),
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

    // collabToolCall items → subagent events (Codex parallel agents)
    if (itemType === "collabToolCall") {
      const tool = String(item.tool ?? "");
      const prompt = typeof item.prompt === "string" ? item.prompt : "";
      const agentsStates = Array.isArray(item.agentsStates) ? item.agentsStates : [];
      const newThreadId = typeof item.newThreadId === "string" ? item.newThreadId : null;

      if (tool === "spawn_agent" && eventKind === "started") {
        emitChatEvent(managed, {
          type: "activity",
          activity: "spawning_agent",
          detail: prompt.slice(0, 80) || "Spawning parallel agent",
          turnId,
        });
        emitChatEvent(managed, {
          type: "subagent_started",
          taskId: newThreadId ?? itemId,
          description: prompt.slice(0, 120) || "Parallel agent",
          background: isBackgroundTask(item as Record<string, unknown>),
          turnId,
        });
      }

      if ((tool === "send_input" || tool === "resume_agent") && eventKind === "completed") {
        const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
        const targetId = typeof receiverIds[0] === "string" ? receiverIds[0] : itemId;
        emitChatEvent(managed, {
          type: "subagent_progress",
          taskId: targetId,
          summary: prompt || "Agent received input",
          turnId,
        });
      }

      if (tool === "wait" && eventKind === "completed") {
        for (const agentState of agentsStates) {
          if (!agentState || typeof agentState !== "object") continue;
          const state = agentState as Record<string, unknown>;
          const agentThreadId = typeof state.threadId === "string" ? state.threadId : itemId;
          const summary = typeof state.summary === "string" ? state.summary
            : typeof state.result === "string" ? state.result
            : "";
          const rawStatus = String(state.status ?? "completed");
          const subagentStatus: "completed" | "failed" | "stopped" =
            rawStatus === "failed" ? "failed"
            : rawStatus === "stopped" ? "stopped"
            : "completed";
          emitChatEvent(managed, {
            type: "subagent_result",
            taskId: agentThreadId,
            status: subagentStatus,
            summary,
            turnId,
          });
        }
      }

      if (tool === "close_agent" && eventKind === "completed") {
        const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
        const targetId = typeof receiverIds[0] === "string" ? receiverIds[0] : itemId;
        emitChatEvent(managed, {
          type: "subagent_result",
          taskId: targetId,
          status: "stopped",
          summary: "Agent closed",
          turnId,
        });
      }

      return;
    }

    // dynamicToolCall items → tool_call/tool_result events
    if (itemType === "dynamicToolCall") {
      const toolName = String(item.tool ?? "dynamic_tool");
      if (eventKind === "started") {
        emitChatEvent(managed, {
          type: "activity",
          activity: "tool_calling",
          detail: toolName,
          turnId,
        });
        emitChatEvent(managed, {
          type: "tool_call",
          tool: toolName,
          args: item.arguments,
          itemId,
          turnId,
        });
      }
      if (eventKind === "completed") {
        const success = item.success !== false;
        const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
        const resultText = contentItems
          .map((ci: unknown) => {
            if (typeof ci === "string") return ci;
            if (ci && typeof ci === "object" && typeof (ci as Record<string, unknown>).text === "string") {
              return (ci as Record<string, unknown>).text as string;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        emitChatEvent(managed, {
          type: "tool_result",
          tool: toolName,
          result: resultText || (success ? "Completed" : "Failed"),
          itemId,
          turnId,
          status: success ? "completed" : "failed",
        });
      }
      return;
    }

    // webSearch items → web_search events
    if (itemType === "webSearch") {
      emitChatEvent(managed, {
        type: "activity",
        activity: "web_searching",
        detail: String(item.query ?? "Searching the web"),
        turnId,
      });
      let status: "running" | "completed" | "failed" = "running";
      if (eventKind === "completed") {
        status = String(item.status ?? "completed") === "failed" ? "failed" : "completed";
      }
      emitChatEvent(managed, {
        type: "web_search",
        query: String(item.query ?? ""),
        action: typeof item.action === "string" ? item.action : undefined,
        itemId,
        turnId,
        status,
      });
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
    const turnIdFromParams = extractCodexTurnId(params);

    if (shouldSkipDuplicateCodexNotification(runtime, payload)) {
      return;
    }

    if (method === "turn/started") {
      const turn = (params.turn as { id?: unknown } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : null;
      runtime.activeTurnId = turnId;
      resetAssistantMessageStream(managed);
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
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
      const resolvedTurnId = typeof turn?.id === "string" ? turn.id : runtime.activeTurnId ?? undefined;
      if (!resolvedTurnId) {
        logger.warn(`[codex] turn/completed missing turnId for session ${managed.session.id}`);
      } else if (!isCurrentCodexLifecycleTurn(runtime, resolvedTurnId)) {
        logger.warn(`[codex] ignoring turn/completed for inactive turn ${resolvedTurnId} in session ${managed.session.id}`);
        return;
      }
      const turnId = resolvedTurnId ?? randomUUID();
      runtime.activeTurnId = null;
      runtime.startedTurnId = null;
      resetAssistantMessageStream(managed);
      runtime.itemTurnIdByItemId.clear();
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
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
      const turnId = typeof params.turnId === "string"
        ? params.turnId
        : runtime.activeTurnId ?? undefined;
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const turnScopeKey = turnId ?? (itemId ? `item:${itemId}` : null);
      if (turnScopeKey) {
        const nextScope: "item" | "turn" = itemId ? "item" : "turn";
        const existingScope = runtime.agentMessageScopeByTurn.get(turnScopeKey) ?? null;
        if (nextScope === "turn") {
          if (existingScope !== "turn") {
            runtime.agentMessageScopeByTurn.set(turnScopeKey, "turn");
            if (turnId && managed.bufferedText?.turnId === turnId && managed.bufferedText.itemId) {
              discardBufferedAssistantText(managed);
            }
          }
        } else if (existingScope === "turn") {
          return;
        } else {
          runtime.agentMessageScopeByTurn.set(turnScopeKey, "item");
        }
      }
      // Always emit with turnId when available — the Codex CLI may stop
      // providing itemId mid-stream, but turnId from runtime.activeTurnId
      // ensures the renderer can still merge consecutive text deltas into
      // one bubble.  Without this, the collapse logic sees mismatched
      // identity attributes and creates separate rows per delta.
      const emitTurnId = turnId ?? runtime.activeTurnId ?? undefined;
      const normalizedDelta = normalizeCodexAssistantDelta(runtime, {
        delta,
        ...(emitTurnId ? { turnId: emitTurnId } : {}),
        ...(itemId ? { itemId } : {}),
      });
      if (!normalizedDelta?.length) {
        return;
      }
      emitChatEvent(managed, {
        type: "text",
        text: normalizedDelta,
        ...(emitTurnId ? { turnId: emitTurnId } : {}),
        ...(itemId ? { itemId } : {}),
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
      const turnId = turnIdFromParams ?? runtime.itemTurnIdByItemId.get(itemId) ?? runtime.activeTurnId ?? undefined;
      const next = `${runtime.commandOutputByItemId.get(itemId) ?? ""}${delta}`;
      runtime.commandOutputByItemId.set(itemId, next);
      emitChatEvent(managed, {
        type: "activity",
        activity: "running_command",
        detail: "Shell command running",
        turnId,
      });
      emitChatEvent(managed, {
        type: "command",
        command: "command",
        cwd: managed.laneWorktreePath,
        output: delta,
        itemId,
        turnId,
        status: "running"
      });
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      const itemId = String((params.itemId as string | undefined) ?? randomUUID());
      const delta = String((params.delta as string | undefined) ?? "");
      const turnId = turnIdFromParams ?? runtime.itemTurnIdByItemId.get(itemId) ?? runtime.activeTurnId ?? undefined;
      const next = `${runtime.fileDeltaByItemId.get(itemId) ?? ""}${delta}`;
      runtime.fileDeltaByItemId.set(itemId, next);
      emitChatEvent(managed, {
        type: "activity",
        activity: "editing_file",
        detail: "Applying file change",
        turnId,
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
            turnId,
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
          turnId,
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

      // Emit plan approval request when the session is in plan mode and a
      // complete plan has been proposed (all steps still pending = freshly created).
      if (managed.session.permissionMode === "plan" && steps.length > 0) {
        const allPending = steps.every((s) => s.status === "pending");
        if (allPending) {
          const planSummary = steps.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
          const planApprovalItemId = randomUUID();
          const planTurnId = typeof params.turnId === "string" ? params.turnId : runtime.activeTurnId ?? undefined;
          const request: PendingInputRequest = {
            requestId: planApprovalItemId,
            itemId: planApprovalItemId,
            source: "codex",
            kind: "plan_approval",
            title: "Plan Ready for Review",
            description: planSummary,
            questions: [{
              id: "plan_decision",
              header: "Implementation Plan",
              question: planSummary,
              options: [
                { label: "Approve & Implement", value: "approve", recommended: true },
                { label: "Reject & Revise", value: "reject" },
              ],
              allowsFreeform: true,
            }],
            allowsFreeform: true,
            blocking: true,
            canProceedWithoutAnswer: false,
            providerMetadata: { tool: "codexPlanApproval" },
            turnId: planTurnId ?? null,
          };
          runtime.approvals.set(planApprovalItemId, {
            requestId: planApprovalItemId,
            kind: "plan_approval",
            request,
          });
          emitPendingInputRequest(managed, request, {
            kind: "tool_call",
            description: "Plan ready for approval",
            detail: { planContent: planSummary },
          });
        }
      }

      return;
    }

    if (method === "item/started") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "started", turnIdFromParams);
      return;
    }

    if (method === "item/completed") {
      const item = (params.item as Record<string, unknown> | null) ?? null;
      if (!item) return;
      handleCodexItemEvent(managed, runtime, item, "completed", turnIdFromParams);
      return;
    }

    if (method === "codex/event/item_started") {
      const item = asRecord(params.item) ?? params;
      handleCodexItemEvent(managed, runtime, item, "started", turnIdFromParams);
      return;
    }

    if (method === "codex/event/item_completed") {
      const item = asRecord(params.item) ?? params;
      handleCodexItemEvent(managed, runtime, item, "completed", turnIdFromParams);
      return;
    }

    if (method === "turn/aborted" || method === "codex/event/turn_aborted") {
      const resolvedAbortTurnId = turnIdFromParams ?? runtime.activeTurnId ?? undefined;
      if (!resolvedAbortTurnId) {
        logger.warn(`[codex] turn/aborted missing turnId for session ${managed.session.id}`);
      } else if (!isCurrentCodexLifecycleTurn(runtime, resolvedAbortTurnId)) {
        logger.warn(`[codex] ignoring turn/aborted for inactive turn ${resolvedAbortTurnId} in session ${managed.session.id}`);
        return;
      }
      const turnId = resolvedAbortTurnId ?? randomUUID();
      runtime.activeTurnId = null;
      runtime.startedTurnId = null;
      resetAssistantMessageStream(managed);
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
      managed.session.status = "idle";
      emitChatEvent(managed, {
        type: "status",
        turnStatus: "interrupted",
        turnId,
      });
      emitChatEvent(managed, {
        type: "done",
        turnId,
        status: "interrupted",
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      });
      persistChatState(managed);
      return;
    }

    if (method === "codex/event/web_search_begin") {
      const query = pickCodexTurnId(params.query, params.searchQuery, params.input) ?? "";
      emitChatEvent(managed, {
        type: "activity",
        activity: "web_searching",
        detail: query || "Searching the web",
        turnId: turnIdFromParams ?? runtime.activeTurnId ?? undefined,
      });
      emitChatEvent(managed, {
        type: "web_search",
        query,
        itemId: typeof params.itemId === "string" ? params.itemId : randomUUID(),
        turnId: turnIdFromParams ?? runtime.activeTurnId ?? undefined,
        status: "running",
      });
      return;
    }

    if (
      method === "thread/status/changed"
      || method === "codex/event/task_started"
      || method === "codex/event/mcp_startup_update"
    ) {
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

    if (method === "item/plan/delta") {
      const delta = String((params.delta as string | undefined) ?? "");
      if (!delta.length) return;
      emitChatEvent(managed, {
        type: "plan_text",
        text: delta,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params.itemId === "string" ? params.itemId : undefined,
      });
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      // Summary part boundary — no additional handling needed since we already
      // merge reasoning deltas by turnId/itemId/summaryIndex.
      return;
    }

    if (method === "item/autoApprovalReview/started") {
      const targetItemId = String((params.targetItemId as string | undefined) ?? "");
      if (targetItemId) {
        emitChatEvent(managed, {
          type: "auto_approval_review",
          targetItemId,
          reviewStatus: "started",
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        });
      }
      return;
    }

    if (method === "item/autoApprovalReview/completed") {
      const targetItemId = String((params.targetItemId as string | undefined) ?? "");
      const action = typeof params.action === "string" ? params.action : undefined;
      const review = typeof params.review === "string" ? params.review : undefined;
      if (targetItemId) {
        emitChatEvent(managed, {
          type: "auto_approval_review",
          targetItemId,
          reviewStatus: "completed",
          action,
          review,
          turnId: typeof params.turnId === "string" ? params.turnId : undefined,
        });
      }
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
    const adeMcpLaunch = tryDiagnosticMcpLaunch(managed);

    logger.info("agent_chat.codex_runtime_start", {
      sessionId: managed.session.id,
      cwd: managed.laneWorktreePath,
      shellPath: process.env.SHELL ?? "",
      path: process.env.PATH ?? "",
      ...(adeMcpLaunch ? { adeMcpLaunch } : {}),
    });
    const codexExecutable = resolveCodexExecutable().path;
    const proc = spawn(codexExecutable, ["app-server"], {
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
      itemTurnIdByItemId: new Map<string, string>(),
      commandOutputByItemId: new Map<string, string>(),
      fileDeltaByItemId: new Map<string, string>(),
      fileChangesByItemId: new Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>(),
      agentMessageScopeByTurn: new Map<string, "item" | "turn">(),
      agentMessageTextByTurn: new Map<string, string>(),
      recentNotificationKeys: new Set<string>(),
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
        line: text,
        cwd: managed.laneWorktreePath,
      });
    });

    proc.on("error", (error) => {
      const message = `Codex app-server failed to start: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn("agent_chat.codex_spawn_failed", {
        sessionId: managed.session.id,
        cwd: managed.laneWorktreePath,
        path: process.env.PATH ?? "",
        shellPath: process.env.SHELL ?? "",
        error: error instanceof Error ? error.message : String(error),
      });

      for (const request of pending.values()) {
        request.reject(new Error(message));
      }
      pending.clear();
      runtime.approvals.clear();
      runtime.suppressExitError = true;

      if (managed.closed || managed.session.status === "ended") return;

      emitChatEvent(managed, {
        type: "error",
        message,
      });

      void finishSession(managed, "failed", {
        exitCode: null,
        summary: message,
      }).catch(() => {});
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
    approvalPolicy: AgentChatCodexApprovalPolicy;
    sandbox: AgentChatCodexSandbox;
  } | null;

  const resolveCodexThreadParams = (managed: ManagedChatSession): {
    codexPolicy: CodexPolicy;
    mcpServers: Record<string, Record<string, unknown>>;
  } => {
    const config = resolveChatConfig();
    const codexConfigSource = resolveSessionCodexConfigSource(managed.session);
    managed.session.codexConfigSource = codexConfigSource;
    const codexPolicy = codexConfigSource === "config-toml"
      ? null
      : {
          approvalPolicy: resolveSessionCodexApprovalPolicy(managed.session, config.codexApprovalPolicy),
          sandbox: resolveSessionCodexSandbox(managed.session, config.codexSandboxMode),
        };
    if (codexPolicy) {
      managed.session.codexApprovalPolicy = codexPolicy.approvalPolicy;
      managed.session.codexSandbox = codexPolicy.sandbox;
    } else {
      delete managed.session.codexApprovalPolicy;
      delete managed.session.codexSandbox;
    }
    managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    const mcpServers = isLightweightSession(managed.session)
      ? {}
      : buildAdeMcpServers(
          "codex",
          managed.session.identityKey === "cto" ? "cto" : "agent",
          resolveWorkerIdentityAgentId(managed.session.identityKey),
          managed.session.id,
          managed.session.computerUse,
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
  ): { model: string } & ClaudeSDKOptions => {
    const chatConfig = resolveChatConfig();
    const claudePermissionMode = resolveSessionClaudePermissionMode(
      managed.session,
      chatConfig.claudePermissionMode,
    );
    managed.session.claudePermissionMode = claudePermissionMode;
    managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    const lightweight = isLightweightSession(managed.session);
    const claudeExecutable = resolveClaudeCodeExecutable();
    const opts: ClaudeSDKOptions = {
      cwd: managed.laneWorktreePath,
      permissionMode: claudePermissionMode as any,
      includePartialMessages: true,
      agentProgressSummaries: true,
      promptSuggestions: true,
      maxBudgetUsd: chatConfig.sessionBudgetUsd ?? undefined,
      model: resolveClaudeCliModel(managed.session.model),
      pathToClaudeCodeExecutable: claudeExecutable.path,
    };
    if (!lightweight) {
      opts.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: [
          "## ADE Memory",
          "You have access to ADE's persistent project memory via MCP tools (memory_search, memory_add, memory_pin).",
          "**Search first:** Before starting non-trivial work, search memory for relevant conventions, past decisions, or known pitfalls.",
          "**Write sparingly and well:** Only save knowledge a developer joining this project would find useful on their first day. Each memory should be a single actionable insight.",
          "GOOD memories: \"Convention: always use snake_case for DB columns\", \"Decision: chose Postgres over Mongo for ACID transactions\", \"Pitfall: CI silently skips tests if file doesn't match *.test.ts\"",
          "DO NOT save: file paths, raw error messages without lessons, task progress updates, information derivable from git log or the code itself, obvious patterns already visible in the codebase.",
        ].join("\n"),
      };
      opts.settingSources = ["user", "project", "local"];
      opts.mcpServers = buildAdeMcpServers(
        "claude",
        managed.session.identityKey === "cto" ? "cto" : "agent",
        resolveWorkerIdentityAgentId(managed.session.identityKey),
        managed.session.id,
        managed.session.computerUse,
      ) as any;
      opts.canUseTool = buildClaudeCanUseTool(runtime, managed) as any;

      // Enable MCP tool search for sessions with many MCP tools.
      // When enabled, the SDK defers tool definitions and loads them on-demand
      // via the ToolSearch tool, keeping the context window lean.
      opts.env = {
        ...process.env as Record<string, string>,
        ...opts.env as Record<string, string> | undefined,
        ENABLE_TOOL_SEARCH: "auto",
      };
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

  const resolveClaudeTurnPermissionMode = (
    managed: ManagedChatSession,
  ): AgentChatClaudePermissionMode => {
    const chatConfig = resolveChatConfig();
    const interactionMode = resolveSessionClaudeInteractionMode(managed.session);
    const accessMode = resolveSessionClaudePermissionMode(managed.session, chatConfig.claudePermissionMode);
    managed.session.interactionMode = interactionMode;
    managed.session.claudePermissionMode = accessMode;
    managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    return interactionMode === "plan" ? "plan" : accessMode;
  };

  const cancelClaudeWarmup = (
    managed: ManagedChatSession,
    runtime: ClaudeRuntime,
    reason: "interrupt" | "teardown" | "session_reset",
  ): void => {
    if (!runtime.v2WarmupDone) return;
    runtime.v2WarmupCancelled = true;
    runtime.v2WarmupCancel?.();
    logger.info("agent_chat.claude_v2_prewarm_cancel", {
      sessionId: managed.session.id,
      reason,
    });
  };

  const applyClaudeSlashCommands = (
    runtime: ClaudeRuntime,
    commands: Array<string | { name?: string; description?: string; argumentHint?: string }>,
  ): void => {
    runtime.slashCommands = commands
      .map((command) => {
        if (typeof command === "string") {
          const normalized = command.trim();
          if (!normalized.length) return null;
          return {
            name: normalized.startsWith("/") ? normalized : `/${normalized}`,
            description: "",
          };
        }
        const normalized = typeof command.name === "string" ? command.name.trim() : "";
        if (!normalized.length) return null;
        return {
          name: normalized.startsWith("/") ? normalized : `/${normalized}`,
          description: typeof command.description === "string" ? command.description : "",
          argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : undefined,
        };
      })
      .filter((command): command is { name: string; description: string; argumentHint?: string } => Boolean(command));
  };

  /**
   * Pre-warm the Claude V2 session in the background.
   * Creates the persistent session and runs a silent warmup turn because the
   * public V2 session API does not expose an init-only readiness handshake.
   */
  const prewarmClaudeV2Session = (managed: ManagedChatSession): void => {
    const runtime = managed.runtime;
    if (!runtime || runtime.kind !== "claude") return;
    if (runtime.v2Session || runtime.v2WarmupDone) return;

    runtime.v2WarmupCancelled = false;
    const warmupStartedAt = Date.now();
    let settleWarmupWaiters: (() => void) | null = null;
    const waitForCancel = new Promise<void>((resolve) => {
      settleWarmupWaiters = resolve;
    });
    const cancelWarmup = () => {
      settleWarmupWaiters?.();
      settleWarmupWaiters = null;
    };
    runtime.v2WarmupCancel = cancelWarmup;

    const warmupTask = (async () => {
      try {
        const v2Opts = buildClaudeV2SessionOpts(managed, runtime);
        logger.info("agent_chat.claude_v2_prewarm_start", {
          sessionId: managed.session.id,
          resume: !!runtime.sdkSessionId,
          model: v2Opts.model,
          claudeExecutablePath: v2Opts.pathToClaudeCodeExecutable,
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
              applyClaudeSlashCommands(runtime, initMsg.slash_commands);
            }
            try {
              const sessionImpl = runtime.v2Session as any;
              if (typeof sessionImpl?.supportedCommands === "function") {
                sessionImpl.supportedCommands().then((cmds: any[]) => {
                  if (Array.isArray(cmds) && cmds.length > 0) {
                    applyClaudeSlashCommands(runtime, cmds);
                  }
                }).catch(() => { /* not available */ });
              }
            } catch { /* ignore */ }
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
        reportProviderRuntimeReady("claude");
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Session ready",
        });
      } catch (error) {
        if (runtime.v2WarmupCancelled) return; // expected — teardown killed the session
        if (isClaudeRuntimeAuthError(error)) {
          reportProviderRuntimeAuthFailure("claude", CLAUDE_RUNTIME_AUTH_ERROR);
          emitChatEvent(managed, {
            type: "system_notice",
            noticeKind: "auth",
            message: CLAUDE_RUNTIME_AUTH_ERROR,
          });
        } else {
          reportProviderRuntimeFailure(
            "claude",
            error instanceof Error ? error.message : String(error),
          );
        }
        let diagClaudePath: string | undefined;
        try {
          diagClaudePath = runtime.v2Session ? undefined : buildClaudeV2SessionOpts(managed, runtime).pathToClaudeCodeExecutable;
        } catch { /* best-effort diagnostic */ }
        const diagMcpLaunch = tryDiagnosticMcpLaunch(managed);
        logger.warn("agent_chat.claude_v2_prewarm_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
          claudeExecutablePath: diagClaudePath,
          ...(diagMcpLaunch ? { adeMcpLaunch: diagMcpLaunch } : {}),
        });
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
      }
    })();

    const warmupPromise = Promise.race([warmupTask, waitForCancel]);
    runtime.v2WarmupDone = warmupPromise;

    void warmupPromise.finally(() => {
      if (runtime.v2WarmupDone === warmupPromise) {
        runtime.v2WarmupDone = null;
      }
      if (runtime.v2WarmupCancel === cancelWarmup) {
        runtime.v2WarmupCancel = null;
      }
      logger.info("agent_chat.claude_v2_prewarm_settled", {
        sessionId: managed.session.id,
        cancelled: runtime.v2WarmupCancelled,
        durationMs: Date.now() - warmupStartedAt,
      });
    });
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
      v2WarmupCancel: null,
      v2WarmupCancelled: false,
      activeSubagents: new Map(),
      slashCommands: [],
      busy: false,
      activeTurnId: null,
      pendingSteers: [],
      approvals: new Map<string, PendingClaudeApproval>(),
      interrupted: false,
      turnMemoryPolicyState: null,
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
      summaryInFlight: false,
      continuitySummary: null,
      continuitySummaryUpdatedAt: null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: null,
      selectedExecutionLaneId: null,
      activeAssistantMessageId: null,
      previewTextBuffer: null,
      bufferedText: null,
      recentConversationEntries: [],
      localPendingInputs: new Map(),
      eventSequence: 0,
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
    const health = getProviderRuntimeHealth("claude");
    if (health?.state === "auth-failed") {
      return [];
    }
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
    interactionMode: requestedInteractionMode,
    claudePermissionMode: requestedClaudePermissionMode,
    codexApprovalPolicy: requestedCodexApprovalPolicy,
    codexSandbox: requestedCodexSandbox,
    codexConfigSource: requestedCodexConfigSource,
    unifiedPermissionMode: requestedUnifiedPermissionMode,
    permissionMode: requestedPermMode,
    identityKey,
    surface,
    automationId,
    automationRunId,
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
      const resolved = resolveProviderGroupForModel(resolvedDescriptor);
      if (resolvedDescriptor.isCliWrapped && resolved === "unified") {
        throw new Error(
          `Model '${resolvedDescriptor.id}' is CLI-only but does not map to a supported chat runtime.`,
        );
      }
      effectiveProvider = resolved;
      normalizedModel = resolvedDescriptor.isCliWrapped ? resolvedDescriptor.shortId : resolvedDescriptor.id;
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
    const chatConfig = resolveChatConfig();

    const nativePermissionFields = (() => {
      if (effectiveProvider === "claude") {
        const interactionMode = requestedInteractionMode
          ?? (requestedClaudePermissionMode === "plan" ? "plan" : undefined)
          ?? (effectivePermissionMode === "plan" ? "plan" : undefined)
          ?? (chatConfig.claudePermissionMode === "plan" ? "plan" : undefined)
          ?? "default";
        const claudePermissionMode = requestedClaudePermissionMode
          ? resolveSessionClaudeAccessMode(
              { claudePermissionMode: requestedClaudePermissionMode, permissionMode: undefined },
              chatConfig.claudePermissionMode,
            )
          : resolveSessionClaudeAccessMode(
              { claudePermissionMode: undefined, permissionMode: effectivePermissionMode },
              chatConfig.claudePermissionMode,
            );
        return { interactionMode, claudePermissionMode };
      }
      if (effectiveProvider === "codex") {
        const codexConfigSource = requestedCodexConfigSource
          ?? legacyPermissionModeToCodexConfigSource(effectivePermissionMode)
          ?? "flags";
        if (codexConfigSource === "config-toml") {
          return { codexConfigSource };
        }
        return {
          codexApprovalPolicy: requestedCodexApprovalPolicy
            ?? legacyPermissionModeToCodexApprovalPolicy(effectivePermissionMode)
            ?? chatConfig.codexApprovalPolicy,
          codexSandbox: requestedCodexSandbox
            ?? legacyPermissionModeToCodexSandbox(effectivePermissionMode)
            ?? chatConfig.codexSandboxMode,
          codexConfigSource,
        };
      }
      return {
        unifiedPermissionMode: requestedUnifiedPermissionMode
          ?? legacyPermissionModeToUnifiedPermissionMode(effectivePermissionMode)
          ?? chatConfig.unifiedPermissionMode,
      };
    })();

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
        ...nativePermissionFields,
        ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),
        ...(identityKey ? { identityKey } : {}),
        surface: surface ?? "work",
        automationId: automationId?.trim() ? automationId.trim() : null,
        automationRunId: automationRunId?.trim() ? automationRunId.trim() : null,
        capabilityMode,
        computerUse: computerUsePolicy,
        completion: null,
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
      summaryInFlight: false,
      continuitySummary: null,
      continuitySummaryUpdatedAt: null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: null,
      selectedExecutionLaneId: null,
      activeAssistantMessageId: null,
      lastActivitySignature: null,
      bufferedReasoning: null,
      previewTextBuffer: null,
      bufferedText: null,
      recentConversationEntries: [],
      localPendingInputs: new Map(),
      eventSequence: 0,
    };
    normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });

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

    if (effectiveProvider === "claude") {
      ensureClaudeSessionRuntime(managed);
      prewarmClaudeV2Session(managed);
    }

    // Eager pre-warm: spawn the Claude runtime so it's ready by the time the
    // user sends their first message (the ~30s cold-start runs in background).
    persistChatState(managed);
    return managed.session;
  };

  const handoffSession = async ({
    sourceSessionId,
    targetModelId,
  }: AgentChatHandoffArgs): Promise<AgentChatHandoffResult> => {
    const sourceId = sourceSessionId.trim();
    const targetId = targetModelId.trim();
    if (!sourceId.length) {
      throw new Error("A source session is required to hand off a chat.");
    }
    if (!targetId.length) {
      throw new Error("Select a target model before handing off this chat.");
    }

    const managed = ensureManagedSession(sourceId);
    const sourceSession = await getSessionSummary(sourceId);
    if (!sourceSession) {
      throw new Error(`Unable to load chat session '${sourceId}' for handoff.`);
    }
    if ((sourceSession.surface ?? managed.session.surface ?? "work") !== "work") {
      throw new Error("Chat handoff is only available for work chats.");
    }

    ensureSessionIdleForHandoff(managed);

    const targetDescriptor = getModelById(targetId) ?? resolveModelAlias(targetId);
    if (!targetDescriptor || targetDescriptor.deprecated) {
      throw new Error(`Unknown model '${targetId}'.`);
    }

    const targetProvider = resolveProviderGroupForModel(targetDescriptor);
    const targetModel = targetDescriptor.isCliWrapped ? targetDescriptor.shortId : targetDescriptor.id;
    const targetReasoningEffort = pickHandoffReasoningEffort(
      targetDescriptor,
      managed.session.reasoningEffort ?? sourceSession.reasoningEffort,
    );
    const transcript = await getChatTranscript({
      sessionId: sourceId,
      limit: 12,
      maxChars: 12_000,
    });
    const artifacts = collectHandoffArtifacts(readTranscriptEnvelopes(managed));
    const { brief, usedFallbackSummary } = await generateHandoffBrief({
      managed,
      sourceSession,
      targetDescriptor,
      transcript,
      artifacts,
    });

    const created = await createSession({
      laneId: managed.session.laneId,
      provider: targetProvider,
      model: targetModel,
      modelId: targetDescriptor.id,
      sessionProfile: managed.session.sessionProfile,
      reasoningEffort: targetReasoningEffort,
      interactionMode: managed.session.interactionMode,
      claudePermissionMode: managed.session.claudePermissionMode,
      codexApprovalPolicy: managed.session.codexApprovalPolicy,
      codexSandbox: managed.session.codexSandbox,
      codexConfigSource: managed.session.codexConfigSource,
      unifiedPermissionMode: managed.session.unifiedPermissionMode,
      permissionMode: managed.session.permissionMode,
      surface: managed.session.surface,
      computerUse: managed.session.computerUse,
    });

    const createdManaged = ensureManagedSession(created.id);
    createdManaged.session.executionMode = managed.session.executionMode ?? sourceSession.executionMode ?? null;
    createdManaged.session.interactionMode = managed.session.interactionMode ?? sourceSession.interactionMode ?? null;
    const inheritedGoal = trimLine(sourceSession.goal)
      ?? trimLine(sourceSession.summary)
      ?? trimLine(sourceSession.title);
    if (inheritedGoal) {
      sessionService.updateMeta({
        sessionId: created.id,
        goal: inheritedGoal,
      });
    }
    persistChatState(createdManaged);

    await sendMessage({
      sessionId: created.id,
      text: buildHandoffPrompt(brief),
      displayText: "Chat handoff from previous session",
      reasoningEffort: targetReasoningEffort,
      executionMode: createdManaged.session.executionMode ?? null,
      interactionMode: createdManaged.session.interactionMode ?? null,
    }, {
      awaitDispatch: true,
    });

    return {
      session: createdManaged.session,
      usedFallbackSummary,
    };
  };

  const prepareSendMessage = ({
    sessionId,
    text,
    displayText,
    attachments = [],
    reasoningEffort,
    executionMode,
    interactionMode,
  }: AgentChatSendArgs): PreparedSendMessage | null => {
    const trimmed = text.trim();
    if (!trimmed.length) return null;
    const slashCommand = extractSlashCommand(trimmed);
    const visibleText = displayText?.trim().length ? displayText.trim() : trimmed;

    const managed = ensureManagedSession(sessionId);
    const publicAttachments = attachments.map((attachment) => ({
      ...attachment,
      path: attachment.path.trim(),
    }));
    const resolvedAttachments = publicAttachments.map((attachment): ResolvedAgentChatFileRef => {
      const rawPath = attachment.path;
      if (!rawPath.length) {
        throw new Error("Attachment path is required.");
      }
      const isAbsolute = path.isAbsolute(rawPath);
      const root = isAbsolute ? projectRoot : managed.laneWorktreePath;
      try {
        const safePath = resolvePathWithinRoot(root, rawPath, { allowMissing: true });
        return {
          ...attachment,
          path: rawPath,
          _resolvedPath: safePath,
          _rootPath: root,
        };
      } catch {
        throw new Error(
          isAbsolute
            ? `Attachment path must stay within the project root: ${rawPath}`
            : `Attachment path must stay within the active lane: ${rawPath}`,
        );
      }
    });
    const allowClaudeLoginCommand = managed.session.provider === "claude" && slashCommand === "/login";
    const claudeRuntimeHealth = managed.session.provider === "claude"
      ? getProviderRuntimeHealth("claude")
      : null;
    if (
      managed.session.provider === "claude"
      && claudeRuntimeHealth?.state === "auth-failed"
      && !allowClaudeLoginCommand
    ) {
      throw new Error(claudeRuntimeHealth.message ?? CLAUDE_RUNTIME_AUTH_ERROR);
    }

    if (managed.session.status === "ended") {
      sessionService.reopen(sessionId);
      managed.session.status = "idle";
      managed.closed = false;
      managed.endedNotified = false;
      managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? nowIso() : null;
      refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });
    }

    if (!managed.autoTitleSeed) {
      managed.autoTitleSeed = visibleText;
      void maybeAutoTitleSession(managed, {
        stage: "initial",
        latestUserText: visibleText,
      });
    }
    if (managed.session.provider === "claude") {
      managed.session.interactionMode = interactionMode ?? managed.session.interactionMode ?? "default";
      managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    }
    const promptText = isLiteralSlashCommand(trimmed)
      ? trimmed
      : composeLaunchDirectives(trimmed, [
          buildExecutionModeDirective(executionMode, managed.session.provider),
          buildClaudeInteractionModeDirective(managed.session.interactionMode, managed.session.provider),
          buildComputerUseDirective(
            managed.session.computerUse,
            computerUseArtifactBrokerRef?.getBackendStatus() ?? null,
          ),
        ]);
    if (executionMode) {
      managed.session.executionMode = executionMode;
    } else if (managed.session.executionMode == null) {
      managed.session.executionMode = "focused";
    }

    return {
      sessionId,
      managed,
      promptText,
      visibleText,
      attachments: publicAttachments,
      resolvedAttachments,
      reasoningEffort,
      interactionMode: managed.session.provider === "claude" ? managed.session.interactionMode ?? "default" : null,
    };
  };

  const emitDispatchedSendFailure = (prepared: PreparedSendMessage, error: unknown): void => {
    const { managed } = prepared;
    if (managed.closed) return;

    const message = error instanceof Error ? error.message : String(error);
    const turnId = randomUUID();

    // If the failure is "turn already active", the original turn is still running.
    // Do NOT clear activeTurnId or runtime state — that would corrupt the in-flight
    // turn's streaming (text deltas lose their turnId and each word becomes a
    // separate chat bubble).
    const normalizedMsg = message.toLowerCase();
    const isBusyError = normalizedMsg.includes("turn is already active")
      || normalizedMsg.includes("already active")
      || normalizedMsg.includes("busy");

    if (!isBusyError) {
      managed.session.status = "idle";
    }

    if (managed.runtime?.kind === "codex" && !isBusyError) {
      managed.runtime.activeTurnId = null;
      managed.runtime.startedTurnId = null;
      managed.runtime.itemTurnIdByItemId.clear();
    }
    if (managed.runtime?.kind === "unified" && !isBusyError) {
      managed.runtime.busy = false;
      managed.runtime.activeTurnId = null;
      managed.runtime.abortController = null;
    }
    if (managed.runtime?.kind === "claude" && !isBusyError) {
      managed.runtime.busy = false;
      managed.runtime.activeTurnId = null;
      managed.runtime.activeQuery = null;
    }

    emitChatEvent(managed, {
      type: "error",
      message,
      turnId,
    });
    emitChatEvent(managed, {
      type: "status",
      turnStatus: "failed",
      message,
      turnId,
    });
    emitChatEvent(managed, {
      type: "done",
      turnId,
      status: "failed",
      model: managed.session.model,
      ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
    });

    appendWorkerActivityToCto(managed, {
      activityType: "chat_turn",
      summary: `Turn failed before execution: ${message}`,
    });
    persistChatState(managed);
  };

  const executePreparedSendMessage = async (prepared: PreparedSendMessage): Promise<void> => {
    const {
      sessionId,
      managed,
      promptText,
      visibleText,
      attachments,
      resolvedAttachments,
      reasoningEffort,
      onDispatched,
    } = prepared;

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
      await runTurn(managed, { promptText, displayText: visibleText, attachments, resolvedAttachments, onDispatched });
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

      await sendCodexMessage(managed, { promptText, displayText: visibleText, attachments, resolvedAttachments, onDispatched });
      return;
    }

    const nextClaudeEffort = validateReasoningEffort("claude", normalizeReasoningEffort(reasoningEffort));
    if (nextClaudeEffort) {
      managed.session.reasoningEffort = nextClaudeEffort;
    }

    ensureClaudeSessionRuntime(managed);
    await runClaudeTurn(managed, { promptText, displayText: visibleText, attachments, resolvedAttachments, onDispatched });
  };

  const sendMessage = async (
    args: AgentChatSendArgs,
    options?: { awaitDispatch?: boolean },
  ): Promise<void> => {
    const dispatchStartedAt = Date.now();
    const prepared = prepareSendMessage(args);
    if (!prepared) return;
    let rejectDispatch: ((error: Error) => void) | null = null;
    const dispatchPromise = options?.awaitDispatch
      ? new Promise<void>((resolve, reject) => {
          let settled = false;
          prepared.onDispatched = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          rejectDispatch = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
        })
      : null;

    logger.info("agent_chat.turn_dispatch_ack", {
      sessionId: prepared.sessionId,
      provider: prepared.managed.session.provider,
      model: prepared.managed.session.model,
      durationMs: Date.now() - dispatchStartedAt,
    });

    void executePreparedSendMessage(prepared).catch((error) => {
      logger.warn("agent_chat.turn_dispatch_failed", {
        sessionId: prepared.sessionId,
        provider: prepared.managed.session.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      rejectDispatch?.(error instanceof Error ? error : new Error(String(error)));
      emitDispatchedSendFailure(prepared, error);
    });

    if (dispatchPromise) {
      await dispatchPromise;
    }
  };

  const steer = async ({ sessionId, text }: AgentChatSteerArgs): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed.length) return;

    const managed = ensureManagedSession(sessionId);

    // Unified runtime steer
    if (managed.runtime?.kind === "unified") {
      const runtime = managed.runtime;
      if (runtime.busy) {
        if (runtime.pendingSteers.length >= MAX_PENDING_STEERS) {
          logger.warn("agent_chat.steer_queue_full", { sessionId, queueSize: runtime.pendingSteers.length });
          emitChatEvent(managed, {
            type: "system_notice",
            noticeKind: "info",
            message: "Steer dropped — the queue is full. Wait for the current turn to finish.",
            turnId: runtime.activeTurnId ?? undefined,
          });
          return;
        }
        runtime.pendingSteers.push(trimmed);
        emitChatEvent(managed, {
          type: "user_message",
          text: trimmed,
          turnId: runtime.activeTurnId ?? undefined,
        });
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Message queued — will be sent when the current turn completes.",
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
      if (runtime.pendingSteers.length >= MAX_PENDING_STEERS) {
        logger.warn("agent_chat.steer_queue_full", { sessionId, queueSize: runtime.pendingSteers.length });
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Steer dropped — the queue is full. Wait for the current turn to finish.",
          turnId: runtime.activeTurnId ?? undefined,
        });
        return;
      }
      runtime.pendingSteers.push(trimmed);
      emitChatEvent(managed, {
        type: "user_message",
        text: trimmed,
        turnId: runtime.activeTurnId ?? undefined,
      });
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "info",
        message: "Message queued — will be sent when the current turn completes.",
        turnId: runtime.activeTurnId ?? undefined,
      });
      persistChatState(managed);
      return;
    }

    await runClaudeTurn(managed, { promptText: trimmed, displayText: trimmed, attachments: [] });
  };

  const interrupt = async ({ sessionId }: AgentChatInterruptArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Unified runtime interrupt — auto-decline pending approvals to prevent orphans
    if (managed.runtime?.kind === "unified") {
      managed.runtime.interrupted = true;
      managed.runtime.abortController?.abort();
      for (const [itemId, approval] of managed.runtime.pendingApprovals) {
        approval.resolve({ decision: "decline" });
        managed.runtime.pendingApprovals.delete(itemId);
      }
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
    logger.info("agent_chat.turn_interrupt_requested", {
      sessionId,
      provider: "claude",
      turnId: runtime.activeTurnId,
      busy: runtime.busy,
      warmupInFlight: Boolean(runtime.v2WarmupDone),
    });
    runtime.interrupted = true;
    cancelClaudeWarmup(managed, runtime, "interrupt");
    runtime.activeQuery?.interrupt().catch(() => {});
    // Close the V2 session on interrupt — it will be recreated on the next turn
    try { runtime.v2Session?.close(); } catch { /* ignore */ }
    runtime.v2Session = null;
    runtime.v2StreamGen = null;
    runtime.activeSubagents.clear();
    logger.info("agent_chat.turn_interrupt_completed", {
      sessionId,
      provider: "claude",
      turnId: runtime.activeTurnId,
      busy: runtime.busy,
    });
  };

  const resumeSession = async ({ sessionId }: { sessionId: string }): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const persisted = readPersistedState(sessionId);
    managed.session.capabilityMode = managed.session.capabilityMode ?? inferCapabilityMode(managed.session.provider);
    refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });

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
        managed.session.unifiedPermissionMode = persisted?.unifiedPermissionMode ?? managed.session.unifiedPermissionMode;
        managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
        managed.runtime.permissionMode = resolveSessionUnifiedPermissionMode(
          managed.session,
          resolveChatConfig().unifiedPermissionMode,
        );
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

  const summarizeSessionRow = (
    row: ReturnType<ReturnType<typeof createSessionService>["list"]>[number],
  ): AgentChatSessionSummary => {
    const persisted = readPersistedState(row.id);
    const liveSession = managedSessions.get(row.id)?.session ?? null;
    const provider = liveSession?.provider ?? persisted?.provider ?? providerFromToolType(row.toolType);
    const fallbackModel = liveSession?.model ?? persisted?.model ?? fallbackModelForProvider(provider);
    const hydratedModelId = liveSession?.modelId
      ?? persisted?.modelId
      ?? resolveModelIdFromStoredValue(fallbackModel, provider)
      ?? (provider === "unified" ? DEFAULT_UNIFIED_MODEL_ID : undefined);
    const model = provider === "unified" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
    return {
      sessionId: row.id,
      laneId: row.laneId,
      provider,
      model,
      ...(hydratedModelId ? { modelId: hydratedModelId } : {}),
      sessionProfile: liveSession?.sessionProfile ?? persisted?.sessionProfile,
      title: row.title ?? null,
      goal: row.goal ?? null,
      reasoningEffort: liveSession?.reasoningEffort ?? persisted?.reasoningEffort ?? null,
      executionMode: liveSession?.executionMode ?? persisted?.executionMode ?? null,
      interactionMode: liveSession?.interactionMode ?? persisted?.interactionMode ?? null,
      ...(liveSession?.claudePermissionMode || persisted?.claudePermissionMode
        ? { claudePermissionMode: liveSession?.claudePermissionMode ?? persisted?.claudePermissionMode }
        : {}),
      ...(liveSession?.codexApprovalPolicy || persisted?.codexApprovalPolicy
        ? { codexApprovalPolicy: liveSession?.codexApprovalPolicy ?? persisted?.codexApprovalPolicy }
        : {}),
      ...(liveSession?.codexSandbox || persisted?.codexSandbox
        ? { codexSandbox: liveSession?.codexSandbox ?? persisted?.codexSandbox }
        : {}),
      ...(liveSession?.codexConfigSource || persisted?.codexConfigSource
        ? { codexConfigSource: liveSession?.codexConfigSource ?? persisted?.codexConfigSource }
        : {}),
      ...(liveSession?.unifiedPermissionMode || persisted?.unifiedPermissionMode
        ? { unifiedPermissionMode: liveSession?.unifiedPermissionMode ?? persisted?.unifiedPermissionMode }
        : {}),
      ...(liveSession?.permissionMode || persisted?.permissionMode
        ? { permissionMode: liveSession?.permissionMode ?? persisted?.permissionMode }
        : {}),
      ...(liveSession?.identityKey || persisted?.identityKey
        ? { identityKey: liveSession?.identityKey ?? persisted?.identityKey }
        : {}),
      surface: liveSession?.surface ?? persisted?.surface ?? "work",
      automationId: liveSession?.automationId ?? persisted?.automationId ?? null,
      automationRunId: liveSession?.automationRunId ?? persisted?.automationRunId ?? null,
      capabilityMode: liveSession?.capabilityMode ?? persisted?.capabilityMode ?? inferCapabilityMode(provider),
      computerUse: liveSession?.computerUse ?? normalizePersistedComputerUse(persisted?.computerUse),
      completion: liveSession?.completion ?? persisted?.completion ?? null,
      status: liveSession?.status ?? (row.status === "running" ? "idle" : "ended"),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastActivityAt: liveSession?.lastActivityAt ?? persisted?.updatedAt ?? row.endedAt ?? row.startedAt,
      lastOutputPreview: row.lastOutputPreview,
      summary: row.summary ?? liveSession?.completion?.summary ?? persisted?.completion?.summary ?? null,
      ...(liveSession?.threadId || persisted?.threadId
        ? { threadId: liveSession?.threadId ?? persisted?.threadId }
        : {})
    } satisfies AgentChatSessionSummary;
  };

  const listSessions = async (
    laneId?: string,
    options?: { includeIdentity?: boolean; includeAutomation?: boolean },
  ): Promise<AgentChatSessionSummary[]> => {
    const rows = sessionService.list({ ...(laneId ? { laneId } : {}), limit: 500 });
    const chatRows = rows.filter((row) => isChatToolType(row.toolType));
    const includeIdentity = options?.includeIdentity === true;
    const includeAutomation = options?.includeAutomation === true;

    return chatRows
      .map((row) => summarizeSessionRow(row))
      .filter((summary) => includeIdentity || !summary.identityKey)
      .filter((summary) => includeAutomation || summary.surface !== "automation");
  };

  const getSessionSummary = async (sessionId: string): Promise<AgentChatSessionSummary | null> => {
    const trimmed = sessionId.trim();
    if (!trimmed.length) return null;
    const row = sessionService.get(trimmed);
    if (!row || !isChatToolType(row.toolType)) return null;
    return summarizeSessionRow(row);
  };

  const ensureIdentitySession = async (args: {
    identityKey: AgentChatIdentityKey;
    laneId: string;
    modelId?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: AgentChatSession["permissionMode"];
    reuseExisting?: boolean;
  }): Promise<AgentChatSession> => {
    const requestedLaneId = args.laneId.trim();
    if (!requestedLaneId.length) {
      throw new Error("laneId is required to ensure an identity-bound chat session.");
    }

    const canonicalLaneId = await resolvePrimaryIdentityLane();
    const selectedExecutionLaneId = requestedLaneId || null;
    const existing = await listSessions(undefined, { includeIdentity: true });
    const identitySessions = existing
      .filter((entry) => entry.identityKey === args.identityKey)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

    const canonicalExisting = args.reuseExisting === false
      ? null
      : identitySessions.find((entry) => entry.laneId === canonicalLaneId) ?? null;
    const legacySessions = identitySessions.filter((entry) => entry.laneId !== canonicalLaneId && entry.status !== "ended");

    const retireLegacySessions = async (): Promise<void> => {
      for (const legacy of legacySessions) {
        const legacyManaged = ensureManagedSession(legacy.sessionId);
        await finishSession(legacyManaged, "disposed", {
          summary: "Superseded by the canonical primary-hosted identity session.",
        });
      }
    };

    const preferred = canonicalExisting;
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
      applyLegacyPermissionModeToNativeControls(managed.session, managed.session.permissionMode);
      normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
      managed.selectedExecutionLaneId = selectedExecutionLaneId ?? managed.selectedExecutionLaneId;
      refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });
      persistChatState(managed);
      await retireLegacySessions();

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
      laneId: canonicalLaneId,
      provider,
      model: preferredModel,
      ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
      reasoningEffort: args.reasoningEffort ?? pref?.reasoningEffort ?? null,
      permissionMode: args.permissionMode ?? "plan",
      identityKey: args.identityKey
    });

    const managed = ensureManagedSession(created.id);
    managed.selectedExecutionLaneId = selectedExecutionLaneId;
    refreshReconstructionContext(managed, { includeConversationTail: usesIdentityContinuity(managed) });
    persistChatState(managed);
    await retireLegacySessions();
    return managed.session;
  };

  const respondToInput = async ({
    sessionId,
    itemId,
    decision,
    answers,
    responseText,
  }: AgentChatRespondToInputArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);
    const localPending = managed.localPendingInputs.get(itemId);
    if (localPending) {
      managed.localPendingInputs.delete(itemId);
      localPending.resolve({ decision, answers, responseText });
      return;
    }

    if (managed.runtime?.kind === "codex") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.approvals.delete(itemId);

      // Plan approval is created locally (not a JSON-RPC server request).
      // On approve, send a follow-up turn telling Codex to implement.
      // On reject, send feedback for revision.
      if (pending.kind === "plan_approval") {
        const approved = decision === "accept" || decision === "accept_for_session";
        const feedback = typeof responseText === "string" ? responseText.trim() : "";
        if (approved) {
          // Switch out of plan mode and send implementation steer
          managed.session.permissionMode = "edit";
          applyLegacyPermissionModeToNativeControls(managed.session, "edit");
          await sendMessage({
            sessionId,
            text: "The user approved the plan. Please proceed with implementation.",
          });
        } else {
          await sendMessage({
            sessionId,
            text: feedback.length > 0
              ? `The user rejected the plan with feedback: "${feedback}". Please revise.`
              : "The user rejected the plan. Please revise your approach.",
          });
        }
        return;
      }

      if (pending.kind === "permissions") {
        const approved = decision === "accept" || decision === "accept_for_session";
        managed.runtime.sendResponse(pending.requestId, {
          permissions: approved ? (pending.permissions ?? {}) : {},
          scope: decision === "accept_for_session" ? "session" : "turn",
        });
        return;
      }
      if (pending.kind === "structured_question") {
        const normalizedAnswers = normalizePendingInputAnswers(pending.request, answers, responseText);
        managed.runtime.sendResponse(pending.requestId, {
          answers: Object.fromEntries(
            Object.entries(normalizedAnswers).map(([questionId, values]) => [questionId, { answers: values }]),
          ),
        });
        return;
      }

      const mapped = mapApprovalDecisionForCodex(decision ?? "decline");
      managed.runtime.sendResponse(pending.requestId, { decision: mapped });
      return;
    }

    if (managed.runtime?.kind === "claude") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.approvals.delete(itemId);
      pending.resolve({ decision, answers, responseText });
      return;
    }

    if (managed.runtime?.kind === "unified") {
      const pending = managed.runtime.pendingApprovals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      const approved = decision === "accept" || decision === "accept_for_session";
      if (decision === "accept_for_session" && pending.category !== "askUser") {
        managed.runtime.approvalOverrides.add(pending.category);
        if (pending.category === "bash") {
          managed.runtime.permissionMode = "full-auto";
          managed.session.unifiedPermissionMode = "full-auto";
        } else if (managed.runtime.permissionMode === "plan") {
          managed.runtime.permissionMode = "edit";
          managed.session.unifiedPermissionMode = "edit";
        }
      }
      if (approved && pending.category === "exitPlanMode") {
        managed.runtime.permissionMode = "edit";
        managed.session.unifiedPermissionMode = "edit";
      }
      managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
      managed.runtime.pendingApprovals.delete(itemId);
      pending.resolve({ decision, answers, responseText });
      return;
    }

    throw new Error(`Session '${sessionId}' does not have a live runtime for approvals.`);
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
    await respondToInput({
      sessionId,
      itemId,
      decision,
      responseText,
    });
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
    title,
    modelId,
    reasoningEffort,
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    unifiedPermissionMode,
    permissionMode,
    computerUse,
  }: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const chatConfig = resolveChatConfig();
    const isIdentitySession = Boolean(managed.session.identityKey);
    const hasConversation = managed.recentConversationEntries.length > 0 || readTranscriptConversationEntries(managed).length > 0;
    let resetRuntimeForComputerUse = false;

    if (modelId !== undefined) {
      const nextModelId = String(modelId ?? "").trim();
      if (!nextModelId.length) {
        throw new Error("A modelId is required when updating a chat session model.");
      }

      const descriptor = getModelById(nextModelId) ?? resolveModelAlias(nextModelId);
      if (!descriptor) {
        throw new Error(`Unknown model '${nextModelId}'.`);
      }

      const nextProvider: AgentChatProvider = resolveProviderGroupForModel(descriptor);
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
        applyLegacyPermissionModeToNativeControls(managed.session, managed.session.permissionMode);
      }
      normalizeSessionNativePermissionControls(managed.session, chatConfig);

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

      // If V2 session is alive and model changed, notify SDK
      if (managed.runtime?.kind === "claude" && managed.runtime.v2Session && modelId) {
        const newCliModel = resolveClaudeCliModel(managed.session.model);
        if (newCliModel && typeof (managed.runtime.v2Session as any).setModel === "function") {
          try {
            (managed.runtime.v2Session as any).setModel(newCliModel);
          } catch (err) {
            logger.warn("agent_chat.v2_set_model_failed", { sessionId: managed.session.id, error: String(err) });
          }
        }
      }
    } else if (reasoningEffort !== undefined) {
      const prev = managed.session.reasoningEffort ?? null;
      managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      const next = managed.session.reasoningEffort ?? null;
      // When reasoning effort changes on a Claude session with an active V2
      // session, invalidate the V2 session so it is recreated on the next turn
      // with the updated thinking configuration.
      if (prev !== next && managed.runtime?.kind === "claude" && (managed.runtime.v2Session || managed.runtime.v2WarmupDone)) {
        if (managed.runtime.busy) {
          // Defer session reset until the current turn completes — tearing down
          // a live session mid-turn would force the stream down the failure path.
          managed.runtime.pendingSessionReset = true;
        } else {
          cancelClaudeWarmup(managed, managed.runtime, "session_reset");
          try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
          managed.runtime.v2Session = null;
          managed.runtime.v2WarmupDone = null;
        }
      }
    }

    if (permissionMode !== undefined) {
      managed.session.permissionMode = isIdentitySession
        ? normalizeIdentityPermissionMode(permissionMode, managed.session.provider)
        : permissionMode;
      applyLegacyPermissionModeToNativeControls(managed.session, managed.session.permissionMode);
    }

    if (interactionMode !== undefined) {
      managed.session.interactionMode = interactionMode;
    }

    if (claudePermissionMode !== undefined) {
      if (claudePermissionMode === "plan") {
        managed.session.interactionMode = "plan";
      } else {
        managed.session.claudePermissionMode = claudePermissionMode;
      }
    }

    if (codexApprovalPolicy !== undefined) {
      managed.session.codexApprovalPolicy = codexApprovalPolicy;
    }

    if (codexSandbox !== undefined) {
      managed.session.codexSandbox = codexSandbox;
    }

    if (codexConfigSource !== undefined) {
      managed.session.codexConfigSource = codexConfigSource;
    }

    if (unifiedPermissionMode !== undefined) {
      managed.session.unifiedPermissionMode = unifiedPermissionMode;
    }

    if (
      permissionMode !== undefined
      || interactionMode !== undefined
      || claudePermissionMode !== undefined
      || codexApprovalPolicy !== undefined
      || codexSandbox !== undefined
      || codexConfigSource !== undefined
      || unifiedPermissionMode !== undefined
    ) {
      normalizeSessionNativePermissionControls(managed.session, chatConfig);
      if (managed.runtime?.kind === "unified") {
        managed.runtime.permissionMode = resolveSessionUnifiedPermissionMode(
          managed.session,
          chatConfig.unifiedPermissionMode,
        );
      }
      if (managed.runtime?.kind === "claude" && managed.runtime.v2Session && !managed.runtime.busy) {
        const turnPermissionMode = resolveClaudeTurnPermissionMode(managed);
        if (typeof managed.runtime.v2Session.setPermissionMode === "function") {
          await managed.runtime.v2Session.setPermissionMode(turnPermissionMode);
        }
      }
    }

    if (computerUse !== undefined) {
      const nextComputerUse = normalizeComputerUsePolicy(computerUse, createDefaultComputerUsePolicy());
      const prevComputerUse = managed.session.computerUse;
      managed.session.computerUse = nextComputerUse;
      const nextSessionProfile = "workflow" as const;
      if (managed.session.sessionProfile !== nextSessionProfile) {
        managed.session.sessionProfile = nextSessionProfile;
        resetRuntimeForComputerUse = true;
      }
      if (JSON.stringify(prevComputerUse) !== JSON.stringify(nextComputerUse)) {
        resetRuntimeForComputerUse = true;
      }
    }

    if (resetRuntimeForComputerUse && managed.runtime) {
      teardownRuntime(managed);
      refreshReconstructionContext(managed, { includeConversationTail: true });
    }

    if (title !== undefined) {
      const normalizedTitle = String(title ?? "").trim();
      sessionService.updateMeta({
        sessionId,
        title: normalizedTitle.length ? normalizedTitle : defaultChatSessionTitle(managed.session.provider),
      });
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
    if (managed.runtime?.kind === "claude" && (managed.runtime.v2Session || managed.runtime.v2WarmupDone)) return;

    // Apply the selected model to the session so buildClaudeV2SessionOpts
    // picks up the correct model for warmup.
    managed.session.provider = "claude";
    managed.session.modelId = descriptor.id;
    managed.session.model = descriptor.shortId;

    // Ensure a Claude runtime exists and kick off pre-warming
    ensureClaudeSessionRuntime(managed);
    prewarmClaudeV2Session(managed);
  };

  const listSubagents = ({ sessionId }: AgentChatSubagentListArgs): AgentChatSubagentSnapshot[] => {
    return getTrackedSubagents(sessionId);
  };

  const getSessionCapabilities = ({ sessionId }: AgentChatSessionCapabilitiesArgs): AgentChatSessionCapabilities => {
    const managed = managedSessions.get(sessionId) ?? null;
    return deriveSessionCapabilities(managed);
  };

  const getSlashCommands = ({ sessionId }: AgentChatSlashCommandsArgs): AgentChatSlashCommand[] => {
    const managed = managedSessions.get(sessionId);
    if (!managed) return [];
    const provider = managed.session.provider;

    // Local commands available to all providers
    const localCommands: AgentChatSlashCommand[] = [
      { name: "/clear", description: "Clear chat history", source: "local" },
    ];
    if (provider === "claude") {
      localCommands.push({
        name: "/login",
        description: "Sign in to Claude Code for this chat runtime",
        source: "local",
      });
    }

    // Claude SDK commands
    if (provider === "claude" && managed.runtime?.kind === "claude") {
      const rt = managed.runtime;
      const sdkCmds: AgentChatSlashCommand[] = rt.slashCommands.map((cmd: { name: string; description: string; argumentHint?: string }) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        source: "sdk" as const,
      }));
      // Merge: SDK commands first, then local commands that don't conflict
      const sdkNames = new Set(sdkCmds.map((c: AgentChatSlashCommand) => c.name));
      return [...sdkCmds, ...localCommands.filter((c) => !sdkNames.has(c.name))];
    }

    // Codex SDK commands
    if (provider === "codex" && managed.runtime?.kind === "codex") {
      const rt = managed.runtime;
      const sdkCmds: AgentChatSlashCommand[] = rt.slashCommands.map((cmd: { name: string; description: string; argumentHint?: string }) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        source: "sdk" as const,
      }));
      // Add /review as a built-in Codex command if not already in skills
      if (!sdkCmds.some((c) => c.name === "/review")) {
        sdkCmds.push({ name: "/review", description: "Review uncommitted changes", source: "sdk" as const });
      }
      const sdkNames = new Set(sdkCmds.map((c: AgentChatSlashCommand) => c.name));
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
    const managed = ensureManagedSession(sessionId);
    const trimmed = text.trim();
    if (!trimmed.length) {
      return {
        sessionId,
        provider: managed.session.provider,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        outputText: "",
        ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
        ...(managed.runtime?.kind === "claude" ? { sdkSessionId: managed.runtime.sdkSessionId ?? null } : {}),
      };
    }
    if (sessionTurnCollectors.has(sessionId)) {
      throw new Error(`Session '${sessionId}' already has an active background turn.`);
    }
    const prepared = prepareSendMessage({
      sessionId,
      text,
      displayText,
      attachments,
      reasoningEffort,
      executionMode,
    });
    if (!prepared) {
      return {
        sessionId,
        provider: managed.session.provider,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        outputText: "",
        ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
        ...(managed.runtime?.kind === "claude" ? { sdkSessionId: managed.runtime.sdkSessionId ?? null } : {}),
      };
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

      void executePreparedSendMessage(prepared).catch((error) => {
        clearTimeout(timeout);
        sessionTurnCollectors.delete(sessionId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  return {
    createSession,
    handoffSession,
    sendMessage,
    runSessionTurn,
    steer,
    interrupt,
    resumeSession,
    listSessions,
    getSessionSummary,
    getChatTranscript,
    ensureIdentitySession,
    approveToolUse,
    respondToInput,
    getAvailableModels,
    getSlashCommands,
    codexFuzzyFileSearch,
    dispose,
    disposeAll,
    updateSession,
    warmupModel,
    listSubagents,
    getSessionCapabilities,
    /** Clean up temp attachment files older than 7 days. Call on app startup. */
    cleanupStaleAttachments() {
      try {
        const projectRoot = args.projectRoot;
        if (!projectRoot) return;
        const attachDir = path.join(projectRoot, ".ade", "attachments");
        if (!fs.existsSync(attachDir)) return;
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
        for (const entry of fs.readdirSync(attachDir)) {
          try {
            const filePath = path.join(attachDir, entry);
            const stat = fs.statSync(filePath);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              fs.unlinkSync(filePath);
            }
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
    },
    setComputerUseArtifactBrokerService(svc: ComputerUseArtifactBrokerService) {
      computerUseArtifactBrokerRef = svc;
      proofObserver = createProofObserver({ broker: svc });
    },
  };
}
