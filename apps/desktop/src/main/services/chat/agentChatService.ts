import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage, Options as ClaudeSDKOptions, PermissionResult as ClaudePermissionResult } from "@anthropic-ai/claude-agent-sdk";

type ClaudeV2Session = {
  send: (msg: string | Partial<SDKUserMessage>) => Promise<void>;
  stream: () => AsyncGenerator<SDKMessage, void>;
  close: () => void;
  readonly sessionId: string;
  query?: {
    setMcpServers?: (servers: Record<string, Record<string, unknown>>) => Promise<{
      added?: string[];
      removed?: string[];
      errors?: Record<string, string>;
    }>;
    setPermissionMode?: (mode: AgentChatClaudePermissionMode) => Promise<void>;
    supportedCommands?: () => Promise<Array<{ name?: string; description?: string }>>;
  };
  setPermissionMode?: (mode: AgentChatClaudePermissionMode) => Promise<void>;
  supportedCommands?: () => Promise<Array<{ name?: string; description?: string }>>;
};
import { buildClaudeV2Message, inferAttachmentMediaType } from "./buildClaudeV2Message";
import { discoverClaudeSlashCommands } from "./claudeSlashCommandDiscovery";
import type {
  RuntimeFilePart as FilePart,
  RuntimeImagePart as ImagePart,
  RuntimeModelMessage as ModelMessage,
  RuntimeUserContent as UserContent,
} from "./runtimeMessageTypes";
import {
  appendBufferedAssistantText,
  canAppendBufferedAssistantText,
  shouldFlushBufferedAssistantTextForEvent,
  type BufferedAssistantText,
} from "./chatTextBatching";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import { resolveLaneLaunchContext, type LaneLaunchContext } from "../lanes/laneLaunchContext";
import type { createSessionService } from "../sessions/sessionService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createFileService } from "../files/fileService";
import type { createProcessService } from "../processes/processService";
import { runGit } from "../git/git";
import { CLAUDE_RUNTIME_AUTH_ERROR, isClaudeRuntimeAuthError } from "../ai/claudeRuntimeProbe";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import {
  fileSizeOrZero,
  hasNullByte,
  isEnoentError,
  nowIso,
  readFileWithinRootSecure,
  resolvePathWithinRoot,
} from "../shared/utils";
import {
  resolveCliSpawnInvocation,
  terminateProcessTree,
} from "../shared/processExecution";
import type { EpisodicSummaryService } from "../memory/episodicSummaryService";
import { DEFAULT_FLUSH_PROMPT } from "../memory/compactionFlushPrompt";
import type {
  AgentChatApprovalDecision,
  AgentChatCancelSteerArgs,
  AgentChatClaudePermissionMode,
  AgentChatCompletionReport,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCreateArgs,
  AgentChatDeleteArgs,
  AgentChatDisposeArgs,
  AgentChatEditSteerArgs,
  AgentChatExecutionMode,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatIdentityKey,
  AgentChatNoticeDetail,
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
  AgentChatSteerResult,
  AgentChatSendArgs,
  AgentChatCursorConfigOption,
  AgentChatCursorConfigValue,
  AgentChatCursorModeSnapshot,
  AgentChatOpenCodePermissionMode,
  PendingInputQuestion,
  PendingInputRequest,
  PendingInputSource,
  AgentChatUpdateSessionArgs,
  ComputerUseBackendStatus,
  ThinkingLevel,
  TerminalSessionStatus,
  TerminalToolType,
  CtoCapabilityMode,
} from "../../../shared/types";
import {
  getDefaultModelDescriptor,
  getDynamicOpenCodeModelDescriptors,
  getModelById,
  getAvailableModels as getRegistryModels,
  getLocalProviderDefaultEndpoint,
  listModelDescriptorsForProvider,
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  pickDefaultCursorDescriptorFromCliList,
  resolveModelAlias,
  resolveModelDescriptorForProvider,
  resolveProviderGroupForModel,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { canSwitchChatSessionModel } from "../../../shared/chatModelSwitching";
import { detectAllAuth } from "../ai/authDetector";
import type { PermissionMode } from "../ai/tools/universalTools";
import { createWorkflowTools } from "../ai/tools/workflowTools";
import { createLinearTools } from "../ai/tools/linearTools";
import { createCtoOperatorTools, type CtoOperatorToolDeps } from "../ai/tools/ctoOperatorTools";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { resolveClaudeCliModel } from "../ai/claudeModelUtils";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import {
  getProviderRuntimeHealth,
  reportProviderRuntimeAuthFailure,
  reportProviderRuntimeFailure,
  reportProviderRuntimeReady,
} from "../ai/providerRuntimeHealth";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { extractLeadingSlashCommand, isProviderSlashCommandInput } from "../../../shared/chatSlashCommands";
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
import type { createIssueInventoryService } from "../prs/issueInventoryService";
import type { ComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { maybeSyntheticToolResult } from "../computerUse/syntheticToolResult";
import {
  buildOpenCodePromptParts,
  mapPermissionModeToOpenCodeAgent,
  openCodeEventStream,
  refreshOpenCodeSessionToolSelection,
  resolveOpenCodeModelSelection,
  startOpenCodeSession,
  type DiscoveredLocalModelEntry,
  type OpenCodeSessionHandle,
} from "../opencode/openCodeRuntime";
import { peekOpenCodeInventoryCache, probeOpenCodeProviderInventory } from "../opencode/openCodeInventory";
import { inspectLocalProvider } from "../ai/localModelDiscovery";
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { resolveCursorAgentExecutable } from "../ai/cursorAgentExecutable";
import {
  acquireCursorAcpConnection,
  releaseCursorAcpConnection,
  type CursorAcpLaunchSettings,
  type CursorAcpPooled,
} from "./cursorAcpPool";
import { discoverCursorCliModelDescriptors } from "./cursorModelsDiscovery";
import {
  mapAcpSessionNotificationToChatEvents,
  mapStopReasonToTerminalEvents,
  parseAcpTerminalIdFromCommandItemId,
} from "./cursorAcpEventMapper";
import { readCursorAcpConfigSnapshot } from "./cursorAcpConfigState";
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
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
  permissionMode?: AgentChatSession["permissionMode"];
  identityKey?: AgentChatIdentityKey;
  surface?: AgentChatSurface;
  automationId?: string | null;
  automationRunId?: string | null;
  capabilityMode?: CtoCapabilityMode;
  completion?: AgentChatCompletionReport | null;
  threadId?: string;
  /** Cursor ACP session id for resume across app restarts (best-effort). */
  acpSessionId?: string;
  sdkSessionId?: string;
  providerSessionId?: string;
  recentConversationEntries?: PersistedRecentConversationEntry[];
  continuitySummary?: string | null;
  continuitySummaryUpdatedAt?: string | null;
  preferredExecutionLaneId?: string | null;
  selectedExecutionLaneId?: string | null;
  lastLaneDirectiveKey?: string | null;
  manuallyNamed?: boolean;
  awaitingInput?: boolean;
  requestedCwd?: string | null;
  idleSinceAt?: string | null;
  /** Persisted "Allow for Session" tool approval overrides (Claude runtime). */
  approvalOverrides?: string[];
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
  questionResponseKind?: "native_request_user_input";
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
  killTimer: NodeJS.Timeout | null;
  suppressExitError: boolean;
  nextRequestId: number;
  pending: Map<string, PendingRpc>;
  approvals: Map<string, PendingCodexApproval>;
  activeTurnId: string | null;
  startedTurnId: string | null;
  awaitingTurnStart: boolean;
  threadResumed: boolean;
  itemTurnIdByItemId: Map<string, string>;
  commandOutputByItemId: Map<string, string>;
  fileDeltaByItemId: Map<string, string>;
  fileChangesByItemId: Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>;
  activeSubagents: Map<string, { taskId: string; description: string; background: boolean }>;
  interruptedTurnIds: Set<string>;
  ignoredTurnIds: Set<string>;
  agentMessageScopeByTurn: Map<string, "item" | "turn">;
  agentMessageTextByTurn: Map<string, string>;
  recentNotificationKeys: Set<string>;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  sendResponse: (id: string | number, result: unknown) => void;
  sendError: (id: string | number, message: string) => void;
  slashCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  rateLimits: { remaining: number | null; limit: number | null; resetAt: string | null } | null;
  collaborationModes: Set<string> | null;
  collaborationModesReady: Promise<void> | null;
  planModeFallbackNotified: boolean;
};

type QueuedSteer = {
  steerId: string;
  text: string;
  attachments: AgentChatFileRef[];
  resolvedAttachments: ResolvedAgentChatFileRef[];
};

type ClaudeRuntime = {
  kind: "claude";
  sdkSessionId: string | null;
  v2Session: ClaudeV2Session | null;
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
  pendingSteers: QueuedSteer[];
  approvals: Map<string, PendingClaudeApproval>;
  interrupted: boolean;
  /** Set when early interrupt events have been emitted to avoid duplicate emission later. */
  interruptEventsEmitted: boolean;
  /** Set when a reasoning effort change is requested mid-turn; flushed when idle. */
  pendingSessionReset?: boolean;
  turnMemoryPolicyState: TurnMemoryPolicyState | null;
  /** Tool names the user has approved for the session via "Allow for Session". */
  approvalOverrides: Set<string>;
  /** SDK tool_use IDs resolved by canUseTool (e.g. answered AskUserQuestion). */
  resolvedToolUseIds: Set<string>;
  /** Suspend the active-turn idle watchdog while ADE is waiting on human input. */
  pauseIdleWatchdog?: (() => void) | null;
  /** Resume the active-turn idle watchdog after the blocking wait finishes. */
  resumeIdleWatchdog?: (() => void) | null;
};

type PendingOpenCodeApproval = {
  category: "bash" | "write";
  permissionId: string;
  request?: PendingInputRequest;
};

type OpenCodeRuntime = {
  kind: "opencode";
  handle: OpenCodeSessionHandle;
  busy: boolean;
  eventAbortController: AbortController | null;
  activeTurnId: string | null;
  permissionMode: PermissionMode;
  pendingApprovals: Map<string, PendingOpenCodeApproval>;
  pendingSteers: QueuedSteer[];
  interrupted: boolean;
  modelDescriptor: ModelDescriptor;
  textByPartId: Map<string, string>;
  reasoningByPartId: Map<string, string>;
  toolStateByPartId: Map<string, string>;
};

type CursorPermissionWaiter = {
  options: PermissionOption[];
  resolve: (value: RequestPermissionResponse) => void;
};

type CursorRuntime = {
  kind: "cursor";
  poolKey: string;
  pooled: CursorAcpPooled | null;
  acpSessionId: string | null;
  activeTurnId: string | null;
  busy: boolean;
  interrupted: boolean;
  modelSdkId: string;
  modelConfigId: string | null;
  currentModelId: string | null;
  availableModelIds: string[];
  pendingSteers: QueuedSteer[];
  permissionWaiters: Map<string, CursorPermissionWaiter>;
  modeConfigId: string | null;
  currentModeId: string | null;
  availableModeIds: string[];
  defaultModeId: string | null;
  configOptions: AgentChatCursorConfigOption[];
};

type ChatRuntime = CodexRuntime | ClaudeRuntime | OpenCodeRuntime | CursorRuntime;

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

function extractCodexThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nestedThread = asRecord(record.thread);
  return pickCodexTurnId(record.threadId, record.thread_id, nestedThread?.id);
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
  if (runtime.awaitingTurnStart && turnId) {
    return activeTurnId ? activeTurnId === turnId : false;
  }
  if (!activeTurnId || !turnId) return true;
  return activeTurnId === turnId;
}

function rememberInterruptedCodexTurn(runtime: CodexRuntime, turnId: string | null | undefined): void {
  const normalizedTurnId = turnId?.trim() || null;
  if (!normalizedTurnId) return;
  runtime.interruptedTurnIds.add(normalizedTurnId);
  if (runtime.interruptedTurnIds.size > 64) {
    const [first] = runtime.interruptedTurnIds;
    if (first) runtime.interruptedTurnIds.delete(first);
  }
}

function isInterruptedCodexTurn(runtime: CodexRuntime, turnId: string | null | undefined): boolean {
  const normalizedTurnId = turnId?.trim() || null;
  return normalizedTurnId ? runtime.interruptedTurnIds.has(normalizedTurnId) : false;
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
    evictOldestEntries(runtime.agentMessageTextByTurn, MAX_SESSION_MAP_ENTRIES);
    return args.delta;
  }

  if (args.delta.startsWith(knownText)) {
    const suffix = args.delta.slice(knownText.length);
    runtime.agentMessageTextByTurn.set(turnId, args.delta);
    evictOldestEntries(runtime.agentMessageTextByTurn, MAX_SESSION_MAP_ENTRIES);
    return suffix.length ? suffix : null;
  }

  const nextText = `${knownText}${args.delta}`;
  runtime.agentMessageTextByTurn.set(turnId, nextText);
  evictOldestEntries(runtime.agentMessageTextByTurn, MAX_SESSION_MAP_ENTRIES);
  return args.delta;
}

function validateSessionReadyForTurn(managed: ManagedChatSession): { ready: true } | { ready: false; reason: string } {
  if (managed.closed) return { ready: false, reason: "Session is disposed" };
  if (!managed.runtime) return { ready: false, reason: "No runtime initialized" };
  const rt = managed.runtime;
  if ((rt.kind === "opencode" || rt.kind === "claude" || rt.kind === "cursor") && rt.busy) {
    return { ready: false, reason: "Turn already active" };
  }
  if (rt.kind === "opencode" && rt.pendingApprovals.size > 0) return { ready: false, reason: "Pending approvals not resolved" };
  if (rt.kind === "cursor" && rt.permissionWaiters.size > 0) {
    return { ready: false, reason: "Pending permissions not resolved" };
  }
  return { ready: true };
}

function hasLivePendingInput(managed: ManagedChatSession | null | undefined): boolean {
  if (!managed) return false;
  if (managed.localPendingInputs.size > 0) return true;
  const runtime = managed.runtime;
  if (!runtime) return false;
  if (runtime.kind === "codex") return runtime.approvals.size > 0;
  if (runtime.kind === "claude") return runtime.approvals.size > 0;
  if (runtime.kind === "opencode") return runtime.pendingApprovals.size > 0;
  if (runtime.kind === "cursor") return runtime.permissionWaiters.size > 0;
  return false;
}

function isSignalPermissionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM");
}

function isAbortRelatedError(error: unknown): boolean {
  if (typeof globalThis.DOMException === "function" && error instanceof globalThis.DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("aborterror") || message.includes("aborted by user");
}

function isProcessAlive(pid: number | null): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isSignalPermissionError(error);
  }
}

function isProcessGroupAlive(pid: number | null): boolean {
  if (process.platform === "win32") return false;
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isSignalPermissionError(error);
  }
}

function signalChildProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform === "win32") {
    return terminateProcessTree(child, signal);
  }

  const pid = child.pid ?? null;
  if (pid != null && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall through to direct child signaling if the process group is gone.
    }
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    // Fall through to direct PID signaling if the child wrapper rejects the signal.
  }

  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function terminateChildProcessTree(
  child: ChildProcessWithoutNullStreams,
  previousKillTimer: NodeJS.Timeout | null,
  killAfterMs = 1500,
): NodeJS.Timeout | null {
  if (previousKillTimer) {
    clearTimeout(previousKillTimer);
  }

  try {
    child.stdin.end();
  } catch {
    // ignore
  }

  const pid = child.pid ?? null;
  const signaled = signalChildProcessTree(child, "SIGTERM");
  if (!signaled || pid == null || !Number.isInteger(pid) || pid <= 0 || killAfterMs <= 0) {
    return null;
  }

  const timer = setTimeout(() => {
    if (process.platform === "win32") {
      if (!isProcessAlive(pid)) return;
      signalChildProcessTree(child, "SIGKILL");
      return;
    }
    if (!isProcessGroupAlive(pid)) return;
    signalChildProcessTree(child, "SIGKILL");
  }, killAfterMs);
  timer.unref?.();
  return timer;
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
  /** Set when deleteSession begins — persistence paths bail to avoid re-creating deleted files. */
  deleted: boolean;
  ctoSessionStartedAt: string | null;
  pendingReconstructionContext: string | null;
  autoTitleSeed: string | null;
  autoTitleStage: "none" | "initial" | "final";
  autoTitleInFlight: boolean;
  manuallyNamed: boolean;
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
  lastLaneDirectiveKey: string | null;
  runtimeInvalidated: boolean;
  todoItems: Extract<AgentChatEvent, { type: "todo_update" }>["items"];
  localPendingInputs: Map<string, {
    request: PendingInputRequest;
    resolve: (response: {
      decision?: AgentChatApprovalDecision;
      answers?: Record<string, string | string[]>;
      responseText?: string | null;
    }) => void;
  }>;
  eventSequence: number;
  lastActivityTimestamp: number;
  turnBeforeSha: string | null;
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
  timeout: NodeJS.Timeout | null;
};

const CORE_NATIVE_SESSION_TOOL_NAMES = [
  "commit_changes",
  "rebase_lane",
  "stash_push",
  "list_stashes",
  "stash_apply",
  "stash_pop",
  "stash_drop",
  "stash_clear",
  "ask_user",
] as const;

type PreparedSendMessage = {
  sessionId: string;
  managed: ManagedChatSession;
  promptText: string;
  visibleText: string;
  attachments: AgentChatFileRef[];
  resolvedAttachments: ResolvedAgentChatFileRef[];
  reasoningEffort?: string | null;
  interactionMode?: AgentChatInteractionMode | null;
  laneDirectiveKey?: string | null;
  providerSlashCommand?: boolean;
  forceClaudeUserMessage?: boolean;
  onDispatched?: () => void;
  turnId?: string;
  optimisticCursorTurnStart?: boolean;
};

type ResolvedAgentChatFileRef = AgentChatFileRef & {
  _resolvedPath: string;
  _rootPath: string;
};

type ResolvedChatConfig = {
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandboxMode: AgentChatCodexSandbox;
  claudePermissionMode: AgentChatClaudePermissionMode;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  sessionBudgetUsd: number | null;
  titleGenerationEnabled: boolean;
  titleModelId: string | null;
  titleRefreshOnComplete: boolean;
  summaryEnabled: boolean;
  summaryModelId: string | null;
};

const MAX_PENDING_STEERS = 10;
const CLAUDE_WARMUP_WAIT_TIMEOUT_MS = 20_000;

const DEFAULT_CODEX_DESCRIPTOR = getDefaultModelDescriptor("codex");
const DEFAULT_CLAUDE_DESCRIPTOR = getDefaultModelDescriptor("claude");
const DEFAULT_OPENCODE_DESCRIPTOR = getDefaultModelDescriptor("opencode");
const DEFAULT_CURSOR_DESCRIPTOR = getDefaultModelDescriptor("cursor");
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_DESCRIPTOR?.providerModelId ?? "gpt-5.4";
const DEFAULT_CLAUDE_MODEL = DEFAULT_CLAUDE_DESCRIPTOR?.providerModelId ?? DEFAULT_CLAUDE_DESCRIPTOR?.shortId ?? "sonnet";
const DEFAULT_OPENCODE_MODEL_ID = DEFAULT_OPENCODE_DESCRIPTOR?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CURSOR_MODEL = DEFAULT_CURSOR_DESCRIPTOR?.providerModelId ?? "auto";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_AUTO_TITLE_MODEL_ID = "anthropic/claude-haiku-4-5";
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
const DEFAULT_RUN_SESSION_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_COLLABORATION_MODES_LIST_TIMEOUT_MS = 1_500;
// Idle stream watchdog removed — time-based idle detection produced false
// positives during long-running tool calls (Agent, Bash, etc.) where no
// stream events are emitted while the SDK waits for tool results. The user
// can always interrupt manually if something is genuinely stuck.
const SESSION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const OPENCODE_SESSION_INACTIVITY_TIMEOUT_MS = 60 * 1000; // 1 minute
const SESSION_CLEANUP_INTERVAL_MS = 15 * 1000; // check every 15 seconds
const MAX_CONCURRENT_ACTIVE_RUNTIMES = 5;
const MAX_RECENT_CONVERSATION_ENTRIES = 50;
const MAX_SESSION_MAP_ENTRIES = 200;

function evictOldestEntries<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const toDelete = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < toDelete; i++) {
    const next = iter.next();
    if (next.done) break;
    map.delete(next.value);
  }
}
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

const CLAUDE_THINKING_SETTINGS = {
  showThinkingSummaries: true,
  alwaysThinkingEnabled: true,
};

const KNOWN_CLAUDE_EFFORTS = new Set(CLAUDE_REASONING_EFFORTS.map((e) => e.effort));

const CODEX_FALLBACK_MODELS: AgentChatModelInfo[] = listModelDescriptorsForProvider("codex").map((descriptor) => ({
  id: descriptor.providerModelId,
  displayName: descriptor.displayName,
  description: describeCodexModel(descriptor.displayName),
  isDefault: descriptor.id === DEFAULT_CODEX_DESCRIPTOR?.id,
  reasoningEfforts: descriptor.reasoningTiers?.length
    ? CODEX_REASONING_EFFORTS.filter((effort) => descriptor.reasoningTiers?.includes(effort.effort))
    : CODEX_REASONING_EFFORTS,
}));

const CLAUDE_FALLBACK_MODELS: AgentChatModelInfo[] = listModelDescriptorsForProvider("claude").map((descriptor) => ({
  id: descriptor.providerModelId,
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
      descriptor.providerModelId === resolvedClaudeModel
      || descriptor.shortId === session.model
      || descriptor.id === session.model,
    ) ?? null;
  }

  if (session.provider === "codex") {
    return listModelDescriptorsForProvider("codex").find((descriptor) =>
      descriptor.providerModelId === session.model
      || descriptor.shortId === session.model
      || descriptor.id === session.model,
    ) ?? null;
  }

  if (session.provider === "cursor") {
    if (session.modelId) {
      const byStoredId = getModelById(session.modelId) ?? resolveModelAlias(session.modelId);
      if (byStoredId) return byStoredId;
    }
    if (session.model) {
      return (
        getModelById(`cursor/${session.model}`)
        ?? resolveModelDescriptorForProvider(session.model, "cursor")
        ?? null
      );
    }
    return null;
  }

  return getModelById(session.model) ?? resolveModelAlias(session.model) ?? null;
}

function sessionSupportsReasoning(session: AgentChatSession): boolean {
  return resolveSessionModelDescriptor(session)?.capabilities.reasoning ?? true;
}

function initialTurnActivity(session: AgentChatSession): {
  activity: Extract<AgentChatEvent, { type: "activity" }>["activity"];
  detail: string;
} {
  return sessionSupportsReasoning(session)
    ? { activity: "thinking", detail: REASONING_ACTIVITY_DETAIL }
    : { activity: "working", detail: WORKING_ACTIVITY_DETAIL };
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

function buildClaudeV2ExecutableArgs(args: {
  supportsReasoning: boolean;
  effort?: string | null;
}): string[] {
  const executableArgs = [
    "--include-partial-messages",
    "--settings",
    JSON.stringify(CLAUDE_THINKING_SETTINGS),
  ];

  if (args.supportsReasoning) {
    executableArgs.push("--thinking", "adaptive", "--thinking-display", "summarized");
    const effort = args.effort;
    if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
      executableArgs.push("--effort", effort);
    }
  }

  return executableArgs;
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

function isChatToolType(
  toolType: TerminalToolType | null | undefined,
): toolType is "codex-chat" | "claude-chat" | "opencode-chat" | "cursor" {
  return (
    toolType === "codex-chat"
    || toolType === "claude-chat"
    || toolType === "opencode-chat"
    || toolType === "cursor"
  );
}

function providerFromToolType(toolType: TerminalToolType | null | undefined): AgentChatProvider {
  if (toolType === "opencode-chat") return "opencode";
  if (toolType === "claude-chat") return "claude";
  if (toolType === "cursor") return "cursor";
  return "codex";
}

function toolTypeFromProvider(provider: AgentChatProvider): TerminalToolType {
  if (provider === "opencode") return "opencode-chat";
  if (provider === "claude") return "claude-chat";
  if (provider === "cursor") return "cursor";
  return "codex-chat";
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
  if (provider === "cursor") return "Cursor Chat";
  return "AI Chat";
}

const DEFAULT_SESSION_TITLES = new Set(["Codex Chat", "Claude Chat", "AI Chat", "Cursor Chat"]);

function hasCustomChatSessionTitle(title: string | null | undefined, provider: AgentChatProvider): boolean {
  const normalized = String(title ?? "").trim();
  return normalized.length > 0 && normalized !== defaultChatSessionTitle(provider);
}

function resumeCommandForProvider(provider: AgentChatProvider, sessionId: string): string {
  if (provider === "codex") return "chat:codex";
  if (provider === "opencode") return `chat:opencode:${sessionId}`;
  if (provider === "cursor") return `chat:cursor:${sessionId}`;
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

function resolveClaudeCliModelIdFromRuntimeValue(model: string): string | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized.length) return undefined;

  const normalizedWithoutProvider = normalized
    .replace(/^anthropic\//, "")
    .replace(/-api$/, "");

  const inputs = [normalized, normalizedWithoutProvider];

  return listModelDescriptorsForProvider("claude").find((descriptor) => {
    const descriptorShortId = descriptor.shortId.toLowerCase();
    const candidates = new Set([
      descriptor.id.toLowerCase(),
      descriptorShortId,
      descriptor.providerModelId.toLowerCase(),
      descriptor.id.toLowerCase().replace(/^anthropic\//, ""),
    ]);

    if (inputs.some((input) => candidates.has(input))) return true;

    return normalizedWithoutProvider === `claude-${descriptorShortId}`
      || normalizedWithoutProvider.startsWith(`claude-${descriptorShortId}-`)
      || normalizedWithoutProvider.includes(descriptorShortId);
  })?.id;
}

function resolveModelIdFromStoredValue(
  model: string,
  providerHint?: AgentChatProvider,
): string | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized.length) return undefined;

  if (providerHint === "claude") {
    const resolvedClaudeCliModelId = resolveClaudeCliModelIdFromRuntimeValue(normalized);
    if (resolvedClaudeCliModelId) return resolvedClaudeCliModelId;
  }

  const aliasMatch = resolveModelAlias(normalized);
  if (aliasMatch) {
    if (providerHint === "codex" && !(aliasMatch.family === "openai" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "claude" && !(aliasMatch.family === "anthropic" && aliasMatch.isCliWrapped)) return undefined;
    if (providerHint === "opencode" && aliasMatch.isCliWrapped) return undefined;
    if (providerHint === "cursor" && aliasMatch.family !== "cursor") return undefined;
    return aliasMatch.id;
  }

  const matches = MODEL_REGISTRY.filter(
    (entry) =>
      entry.id.toLowerCase() === normalized
      || entry.shortId.toLowerCase() === normalized
      || entry.providerModelId.toLowerCase() === normalized
  );
  if (!matches.length) return undefined;

  let preferred: ModelDescriptor | undefined;
  if (providerHint === "codex") {
    preferred = matches.find((entry) => entry.isCliWrapped && entry.family === "openai");
  } else if (providerHint === "claude") {
    preferred = matches.find((entry) => entry.isCliWrapped && entry.family === "anthropic");
  } else if (providerHint === "opencode") {
    preferred = matches.find((entry) => !entry.isCliWrapped);
  } else if (providerHint === "cursor") {
    preferred = matches.find((entry) => entry.isCliWrapped && entry.family === "cursor");
  }

  return preferred?.id ?? matches[0]?.id;
}

function normalizeReportedModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function extractReportedModelUsageNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value as Record<string, unknown>)
    .map(normalizeReportedModelName)
    .filter((name): name is string => name !== null);
}

function resolveClaudeTurnModelPayload(
  session: Pick<AgentChatSession, "model" | "modelId">,
  candidates: Array<string | null | undefined>,
): { model: string; modelId?: string } {
  for (const candidate of candidates) {
    const normalized = normalizeReportedModelName(candidate);
    if (!normalized) continue;
    const normalizedCliModel = resolveClaudeCliModel(normalized);
    const resolvedCliModelId =
      resolveClaudeCliModelIdFromRuntimeValue(normalized)
      ?? resolveClaudeCliModelIdFromRuntimeValue(normalizedCliModel);
    if (resolvedCliModelId) {
      return { model: normalized, modelId: resolvedCliModelId };
    }
    const resolvedModelId =
      resolveModelIdFromStoredValue(normalized, "claude")
      ?? resolveModelIdFromStoredValue(normalizedCliModel, "claude");
    if (resolvedModelId) {
      return { model: normalized, modelId: resolvedModelId };
    }
    return { model: normalized };
  }

  return {
    model: session.model,
    ...(session.modelId ? { modelId: session.modelId } : {}),
  };
}

function fallbackModelForProvider(provider: AgentChatProvider): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "claude") return DEFAULT_CLAUDE_MODEL;
  if (provider === "cursor") return DEFAULT_CURSOR_MODEL;
  return DEFAULT_OPENCODE_MODEL_ID;
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

function normalizeClaudeTodoItems(
  value: unknown,
): Extract<AgentChatEvent, { type: "todo_update" }>["items"] | null {
  if (!value || typeof value !== "object") return null;
  const todos = (value as { todos?: unknown }).todos;
  if (!Array.isArray(todos) || todos.length === 0) return null;

  const items: Extract<AgentChatEvent, { type: "todo_update" }>["items"] = todos.flatMap((todo, index) => {
    if (!todo || typeof todo !== "object") return [];
    const record = todo as Record<string, unknown>;
    const description = [
      record.content,
      record.activeForm,
      record.description,
      record.text,
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
    if (!description) return [];

    const rawStatus = typeof record.status === "string" ? record.status : "";
    let status: Extract<AgentChatEvent, { type: "todo_update" }>["items"][number]["status"];
    if (rawStatus === "completed") {
      status = "completed";
    } else if (rawStatus === "in_progress" || rawStatus === "inProgress") {
      status = "in_progress";
    } else {
      status = "pending";
    }

    const explicitId = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
    return [{
      id: explicitId ?? `todo-${index}`,
      description,
      status,
    }];
  });

  return items.length ? items : null;
}

function buildStreamingUserContent(
  args: {
    baseText: string;
    attachments: ResolvedAgentChatFileRef[];
    runtimeKind: "claude" | "opencode";
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

      if (args.runtimeKind === "opencode") {
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

export function buildOpenCodeStreamMessages(args: {
  messages: Array<{ role: string; content: string }>;
  persistedTurnUserMessageIndex: number;
  resolvedAttachments: ResolvedAgentChatFileRef[];
  modelDescriptor: ModelDescriptor;
  logger?: Logger;
}): ModelMessage[] {
  return args.messages.map((message, index): ModelMessage => {
    const isPersistedTurnUserMessage = index === args.persistedTurnUserMessageIndex && message.role === "user";
    if (!isPersistedTurnUserMessage) {
      return {
        role: message.role === "user" ? "user" : "assistant",
        content: message.content,
      };
    }

    return {
      role: "user",
      content: buildStreamingUserContent({
        baseText: message.content,
        attachments: args.resolvedAttachments,
        runtimeKind: "opencode",
        modelDescriptor: args.modelDescriptor,
        logger: args.logger,
      }),
    };
  });
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

  if (provider === "claude" && (mode === "subagents" || mode === "parallel")) {
    return [
      "[ADE launch directive]",
      "Use Claude subagents for independent subtasks when they will materially improve latency or coverage.",
      "Split bounded work into narrowly scoped delegates, let them complete independently, then reconcile the results before the final answer.",
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

function buildLaneWorktreeDirective(args: { laneId: string; laneWorktreePath: string }): string | null {
  const laneId = args.laneId.trim();
  const laneWorktreePath = args.laneWorktreePath.trim();
  if (!laneId.length || !laneWorktreePath.length) return null;
  return [
    "[ADE launch directive]",
    `ADE launched this session in lane '${laneId}' at worktree '${laneWorktreePath}'.`,
    "Read, edit, and run commands only inside that worktree. Do not switch to project root, another lane, or another repo unless ADE explicitly relaunches you there.",
  ].join("\n");
}

function buildLaneDirectiveKey(args: { laneId: string; laneWorktreePath: string }): string | null {
  const laneId = args.laneId.trim();
  const laneWorktreePath = args.laneWorktreePath.trim();
  if (!laneId.length || !laneWorktreePath.length) return null;
  return `${laneId}:${laneWorktreePath}`;
}

function composeLaunchDirectives(baseText: string, directives: Array<string | null | undefined>): string {
  const filtered = directives
    .map((directive) => (typeof directive === "string" ? directive.trim() : ""))
    .filter((directive) => directive.length > 0);
  if (filtered.length === 0) return baseText;
  return `${filtered.join("\n\n")}\n\nUser request:\n${baseText}`;
}

export function buildComputerUseDirective(
  backendStatus: ComputerUseBackendStatus | null,
): string | null {
  const hasExternalBackends = backendStatus
    ? backendStatus.backends.some((b) => b.available)
    : false;
  const hasLocalFallback = backendStatus?.localFallback.available ?? true;

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

function normalizeOpenCodePermissionMode(mode: string | undefined): PermissionMode | undefined {
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
const VALID_OPENCODE_PERMISSION_MODES = new Set(["plan", "edit", "full-auto"]);

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

function normalizePersistedOpenCodePermissionMode(value: unknown): AgentChatOpenCodePermissionMode | undefined {
  return normalizePersistedEnum(value, VALID_OPENCODE_PERMISSION_MODES);
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

function legacyClaudeAccessModeToPermissionMode(
  mode: AgentChatClaudeAccessMode,
): AgentChatSession["permissionMode"] {
  switch (mode) {
    case "acceptEdits":
      return "edit";
    case "bypassPermissions":
      return "full-auto";
    default:
      return "default";
  }
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

function legacyPermissionModeToOpenCodePermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
): AgentChatOpenCodePermissionMode | undefined {
  if (!mode) return undefined;
  return mode === "default" || mode === "config-toml" ? "edit" : normalizeOpenCodePermissionMode(mode);
}

function syncLegacyPermissionMode(session: Pick<
  AgentChatSession,
  "provider" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode"
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
    if (session.codexApprovalPolicy === "untrusted" && session.codexSandbox === "workspace-write") return "edit";
    if (
      (session.codexApprovalPolicy === "on-request" || session.codexApprovalPolicy === "on-failure")
      && session.codexSandbox === "workspace-write"
    ) return "default";
    if (
      (session.codexApprovalPolicy === "on-request" || session.codexApprovalPolicy === "untrusted")
      && session.codexSandbox === "read-only"
    ) return "plan";
    return undefined;
  }

  switch (session.opencodePermissionMode) {
    case "plan":
    case "edit":
    case "full-auto":
      return session.opencodePermissionMode;
    default:
      return undefined;
  }
}

function applyLegacyPermissionModeToNativeControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode"
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

  session.opencodePermissionMode = legacyPermissionModeToOpenCodePermissionMode(mode);
}

type ClaudePlanModeTransition = "entered_plan_mode" | "exited_plan_mode";

type ClaudePlanModeNoticeDetail = AgentChatNoticeDetail & {
  permissionModeTransition: ClaudePlanModeTransition;
};

function buildClaudePlanModeNoticeDetail(transition: ClaudePlanModeTransition): ClaudePlanModeNoticeDetail {
  return {
    title: transition === "entered_plan_mode" ? "Plan mode entered" : "Plan mode exited",
    summary: transition === "entered_plan_mode"
      ? "Claude switched into plan mode for this turn."
      : "Claude left plan mode and resumed its prior access mode.",
    permissionModeTransition: transition,
  };
}

function applyClaudePlanModeTransition(
  session: Pick<AgentChatSession, "permissionMode" | "interactionMode" | "claudePermissionMode">,
  nextInteractionMode: AgentChatInteractionMode,
): void {
  session.interactionMode = nextInteractionMode;
  if (nextInteractionMode === "plan") {
    session.permissionMode = "plan";
    return;
  }
  session.permissionMode = legacyClaudeAccessModeToPermissionMode(
    resolveSessionClaudeAccessMode(session, "default"),
  );
}

function hydrateNativePermissionControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode"
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
    session.opencodePermissionMode = session.opencodePermissionMode ?? legacyPermissionModeToOpenCodePermissionMode(session.permissionMode);
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

type CodexCollaborationModePayload = {
  mode: "default" | "plan";
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: string | null;
  };
};

function toHarnessPermissionMode(
  mode: AgentChatSession["permissionMode"] | undefined,
): "plan" | "edit" | "full-auto" {
  if (mode === "plan" || mode === "full-auto") return mode;
  return "edit";
}

function buildCodexDeveloperInstructions(args: {
  laneWorktreePath: string;
  session: Pick<AgentChatSession, "permissionMode" | "interactionMode">;
  collaborationMode: "default" | "plan";
}): string {
  const promptMode = args.collaborationMode === "plan" || args.session.interactionMode === "plan"
    ? "planning"
    : "coding";
  return buildCodingAgentSystemPrompt({
    cwd: args.laneWorktreePath,
    mode: promptMode,
    permissionMode: toHarnessPermissionMode(args.session.permissionMode),
    interactive: true,
  });
}

function buildCodexCollaborationMode(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "model" | "reasoningEffort" | "codexConfigSource"
  >,
  supportedModes: Set<string> | null,
  laneWorktreePath: string,
): CodexCollaborationModePayload | null {
  if (session.provider !== "codex") return null;
  if (resolveSessionCodexConfigSource(session) === "config-toml") return null;
  const requestedMode = session.interactionMode === "plan" || session.permissionMode === "plan"
    ? "plan"
    : "default";
  const mode = (() => {
    if (!supportedModes || supportedModes.size === 0) return requestedMode;
    if (supportedModes.has(requestedMode)) return requestedMode;
    if (requestedMode === "plan" && supportedModes.has("default")) return "default";
    return null;
  })();
  if (!mode) return null;
  return {
    mode,
    settings: {
      model: session.model,
      reasoning_effort: session.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      developer_instructions: buildCodexDeveloperInstructions({
        laneWorktreePath,
        session,
        collaborationMode: mode,
      }),
    },
  };
}

function resolveRequestedCodexCollaborationMode(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "codexConfigSource"
  >,
): "default" | "plan" | null {
  if (session.provider !== "codex") return null;
  if (resolveSessionCodexConfigSource(session) === "config-toml") return null;
  return session.interactionMode === "plan" || session.permissionMode === "plan"
    ? "plan"
    : "default";
}

function parseCodexCollaborationModes(value: unknown): Set<string> | null {
  const normalized = new Set<string>();
  const pushMode = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim().toLowerCase();
      if (trimmed.length) normalized.add(trimmed);
      return;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const record = candidate as Record<string, unknown>;
    const nested = [record.mode, record.name, record.kind];
    for (const entry of nested) {
      if (typeof entry === "string" && entry.trim().length) {
        normalized.add(entry.trim().toLowerCase());
        return;
      }
    }
  };

  if (Array.isArray(value)) {
    value.forEach(pushMode);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [
      record.collaborationModes,
      record.collaboration_modes,
      record.modes,
      record.presets,
      record.items,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        candidate.forEach(pushMode);
      }
    }
  }

  return normalized.size > 0 ? normalized : null;
}

function resolveSessionOpenCodePermissionMode(
  session: Pick<AgentChatSession, "opencodePermissionMode" | "permissionMode">,
  fallback: AgentChatOpenCodePermissionMode,
): AgentChatOpenCodePermissionMode {
  return session.opencodePermissionMode
    ?? legacyPermissionModeToOpenCodePermissionMode(session.permissionMode)
    ?? fallback;
}

function applyLocalHarnessPermissionMode(args: {
  descriptor?: ModelDescriptor;
  requestedPermissionMode?: AgentChatSession["permissionMode"];
  requestedOpenCodePermissionMode?: AgentChatOpenCodePermissionMode;
}): {
  requestedPermissionMode?: AgentChatSession["permissionMode"];
  requestedOpenCodePermissionMode?: AgentChatOpenCodePermissionMode;
} {
  if (!args.descriptor?.authTypes.includes("local")) {
    return {
      requestedPermissionMode: args.requestedPermissionMode,
      requestedOpenCodePermissionMode: args.requestedOpenCodePermissionMode,
    };
  }

  if (args.descriptor.harnessProfile === "read_only") {
    return {
      requestedPermissionMode: "plan",
      requestedOpenCodePermissionMode: "plan",
    };
  }

  return {
    requestedPermissionMode: args.requestedPermissionMode,
    requestedOpenCodePermissionMode: args.requestedOpenCodePermissionMode,
  };
}

function enforceManagedLocalHarnessPermissionMode(
  managed: ManagedChatSession,
  descriptor?: ModelDescriptor | null,
): void {
  const harnessPermissions = applyLocalHarnessPermissionMode({
    descriptor: descriptor ?? resolveSessionModelDescriptor(managed.session) ?? undefined,
    requestedPermissionMode: managed.session.permissionMode,
    requestedOpenCodePermissionMode: managed.session.opencodePermissionMode,
  });
  managed.session.permissionMode = harnessPermissions.requestedPermissionMode ?? managed.session.permissionMode;
  managed.session.opencodePermissionMode = harnessPermissions.requestedOpenCodePermissionMode ?? managed.session.opencodePermissionMode;
}

function resolveCursorSessionModeId(
  session: Pick<AgentChatSession, "cursorModeId" | "opencodePermissionMode" | "permissionMode">,
): string | null {
  const explicit = typeof session.cursorModeId === "string" ? session.cursorModeId.trim() : "";
  if (explicit.length) {
    return explicit === "agent" || explicit === "default" ? null : explicit;
  }
  return resolveSessionOpenCodePermissionMode(session, "edit") === "plan" ? "plan" : null;
}

function resolveCursorAcpLaunchSettings(
  session: Pick<AgentChatSession, "cursorModeId" | "opencodePermissionMode" | "permissionMode">,
): CursorAcpLaunchSettings {
  const explicitCursorModeId = typeof session.cursorModeId === "string"
    ? session.cursorModeId.trim().toLowerCase()
    : "";
  if (!explicitCursorModeId.length) {
    const legacyMode = resolveSessionOpenCodePermissionMode(session, "edit");
    if (legacyMode === "full-auto") {
      return {
        mode: null,
        sandbox: "disabled",
        force: true,
      };
    }
  }
  return {
    mode: (() => {
      const desiredModeId = resolveCursorSessionModeId(session);
      return desiredModeId === "ask" || desiredModeId === "plan" ? desiredModeId : null;
    })(),
    sandbox: "enabled",
    force: false,
  };
}

const CURSOR_ACP_SERVER_LIST_KEY = ["m", "cpServers"].join("");

function cursorAcpSessionRequest<T extends Record<string, unknown>>(request: T): T {
  return {
    ...request,
    [CURSOR_ACP_SERVER_LIST_KEY]: [],
  } as T;
}

function normalizeCursorConfigValueRecord(
  value: unknown,
): Record<string, AgentChatCursorConfigValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized: Record<string, AgentChatCursorConfigValue> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key.length) continue;
    if (typeof rawValue === "boolean") {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      normalized[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed.length) normalized[key] = trimmed;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function buildCursorModeSnapshotFromRuntime(runtime: CursorRuntime): AgentChatCursorModeSnapshot | undefined {
  const hasData =
    Boolean(runtime.modeConfigId)
    || Boolean(runtime.currentModeId)
    || runtime.availableModeIds.length > 0
    || Boolean(runtime.modelConfigId)
    || Boolean(runtime.currentModelId)
    || runtime.availableModelIds.length > 0
    || runtime.configOptions.length > 0;
  if (!hasData) return undefined;
  return {
    ...(runtime.modeConfigId ? { modeConfigId: runtime.modeConfigId } : {}),
    currentModeId: runtime.currentModeId,
    availableModeIds: runtime.availableModeIds,
    ...(runtime.modelConfigId ? { modelConfigId: runtime.modelConfigId } : {}),
    ...(runtime.currentModelId ? { currentModelId: runtime.currentModelId } : {}),
    ...(runtime.availableModelIds.length ? { availableModelIds: runtime.availableModelIds } : {}),
    ...(runtime.configOptions.length ? { configOptions: runtime.configOptions } : {}),
  };
}

function syncCursorModeSnapshot(managed: ManagedChatSession, runtime: CursorRuntime): void {
  const snapshot = buildCursorModeSnapshotFromRuntime(runtime);
  if (snapshot) {
    managed.session.cursorModeSnapshot = snapshot;
    return;
  }
  delete managed.session.cursorModeSnapshot;
}

function resolveCursorRuntimeModelSdkId(
  session: Pick<AgentChatSession, "model" | "modelId">,
): string {
  const byModelId = session.modelId ? getModelById(session.modelId) ?? resolveModelAlias(session.modelId) : null;
  if (byModelId?.family === "cursor") {
    return byModelId.providerModelId;
  }

  const rawModel = String(session.model ?? "").trim();
  if (rawModel.length) {
    const resolved = getModelById(`cursor/${rawModel}`) ?? resolveModelDescriptorForProvider(rawModel, "cursor");
    if (resolved?.family === "cursor") {
      return resolved.providerModelId;
    }
  }

  return DEFAULT_CURSOR_MODEL;
}

function normalizeCursorReportedModelId(
  modelId: string | null | undefined,
  availableModelIds: readonly string[] = [],
): string | null {
  const trimmed = String(modelId ?? "").trim();
  if (!trimmed.length) return null;
  const looksLikeSdkModelId = /^[\w.-]+$/i.test(trimmed);
  if (availableModelIds.includes(trimmed) && looksLikeSdkModelId) return trimmed;
  const descriptor = getModelById(`cursor/${trimmed}`) ?? resolveModelDescriptorForProvider(trimmed, "cursor");
  return descriptor?.family === "cursor" ? descriptor.providerModelId : null;
}

function normalizeSessionNativePermissionControls(
  session: Pick<
    AgentChatSession,
    "provider" | "permissionMode" | "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode"
  >,
  config: ResolvedChatConfig,
): void {
  if (session.provider === "claude") {
    session.interactionMode = resolveSessionClaudeInteractionMode(session);
    session.claudePermissionMode = resolveSessionClaudePermissionMode(session, config.claudePermissionMode);
    delete session.codexApprovalPolicy;
    delete session.codexSandbox;
    delete session.codexConfigSource;
    delete session.opencodePermissionMode;
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
    delete session.opencodePermissionMode;
  } else {
    delete session.interactionMode;
    session.opencodePermissionMode = resolveSessionOpenCodePermissionMode(session, config.opencodePermissionMode);
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
  if (value === "full_tooling" || value === "fallback") {
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
  return provider === "codex" || provider === "claude" || provider === "cursor" || provider === "opencode" ? "full_tooling" : "fallback";
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
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  processService?: ReturnType<typeof createProcessService> | null;
  getTestService?: () => { listSuites: () => any[]; run: (args: any) => Promise<any>; stop: (args: any) => void; listRuns: (args?: any) => any[]; getLogTail: (args: any) => string } | null;
  ptyService?: { create: (args: any) => Promise<{ ptyId: string; sessionId: string }> } | null;
  getAutomationService?: () => { list: () => any[]; triggerManually: (args: any) => Promise<any>; listRuns: (args?: any) => any[] } | null;
  getGitService?: () => CtoOperatorToolDeps["gitService"];
  conflictService?: CtoOperatorToolDeps["conflictService"];
  contextDocService?: CtoOperatorToolDeps["contextDocService"];
  getWorkerBudgetService?: () => CtoOperatorToolDeps["workerBudgetService"];
  getMissionBudgetService?: () => CtoOperatorToolDeps["missionBudgetService"];
  computerUseArtifactBrokerService?: ComputerUseArtifactBrokerService | null;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  logger: Logger;
  appVersion: string;
  getAdeCliAgentEnv?: (baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  onEvent?: (event: AgentChatEventEnvelope) => void;
  onSessionEnded?: (args: { laneId: string; sessionId: string; exitCode: number | null }) => void;
  getDirtyFileTextForPath: (absPath: string) => string | undefined | Promise<string | undefined>;
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
    issueInventoryService,
    processService,
    getTestService,
    ptyService,
    getAutomationService,
    getGitService,
    conflictService,
    contextDocService,
    getWorkerBudgetService,
    getMissionBudgetService,
    computerUseArtifactBrokerService,
    laneService,
    sessionService,
    projectConfigService,
    aiIntegrationService,
    logger,
    appVersion,
    getAdeCliAgentEnv,
    onEvent,
    onSessionEnded,
    getDirtyFileTextForPath,
  } = args;

  if (!getDirtyFileTextForPath) {
    throw new Error("createAgentChatService: getDirtyFileTextForPath is required");
  }
  if (!issueInventoryService) {
    throw new Error("Issue inventory service is required to initialize agent chat.");
  }

  const eventSubscribers = new Set<(event: AgentChatEventEnvelope) => void>();

  // In-memory ring buffer of recent chat events per session. Populated on every
  // emitted event (see emitChatEvent → commitChatEvent) and merged with the
  // persisted transcript when a snapshot is requested. The transcript recovers
  // older project/tab-switch history; the ring contributes events that may not
  // have reached fs.appendFile yet.
  const CHAT_EVENT_HISTORY_BUFFER_MAX_PER_SESSION = 4_000;
  const CHAT_EVENT_HISTORY_RESPONSE_MAX_PER_SESSION = 20_000;
  const eventHistoryBySession = new Map<string, AgentChatEventEnvelope[]>();

  const recordChatEventInHistory = (envelope: AgentChatEventEnvelope): void => {
    const current = eventHistoryBySession.get(envelope.sessionId) ?? [];
    current.push(envelope);
    if (current.length > CHAT_EVENT_HISTORY_BUFFER_MAX_PER_SESSION) {
      current.splice(0, current.length - CHAT_EVENT_HISTORY_BUFFER_MAX_PER_SESSION);
    }
    eventHistoryBySession.set(envelope.sessionId, current);
  };

  let computerUseArtifactBrokerRef = computerUseArtifactBrokerService ?? null;

  const layout = resolveAdeLayout(projectRoot);
  const chatSessionsDir = layout.chatSessionsDir;
  const chatTranscriptsDir = layout.chatTranscriptsDir;
  fs.mkdirSync(chatSessionsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(chatTranscriptsDir, { recursive: true });

  const runSessionIntelligencePrompt = async (args: {
    cwd: string;
    modelId: string;
    prompt: string;
    systemPrompt?: string;
    timeoutMs?: number;
    taskType: "session_title" | "session_summary" | "handoff_summary" | "continuity_summary";
  }) => {
    return await aiIntegrationService.summarizeTerminal({
      cwd: args.cwd,
      model: args.modelId,
      prompt: args.prompt,
      systemPrompt: args.systemPrompt,
      timeoutMs: args.timeoutMs,
      taskType: args.taskType,
    });
  };

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
  const cursorAcpSessionOwners = new Map<string, ManagedChatSession>();
  const cursorAcpBridgeWired = new WeakSet<CursorAcpPooled>();
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
  const AUTO_MEMORY_TEST_MESSAGE_RE = /^(?:this is\s+)?(?:just\s+)?(?:a\s+)?test message[.!?]*$|^(?:just\s+)?testing[.!?]*$/i;

  const classifyAutoMemoryTurn = (
    promptText: string,
    attachmentCount = 0,
  ): AutoMemoryTurnClassification => {
    const trimmed = promptText.trim();
    if (trimmed.length < 12) return "none";
    if (trimmed.startsWith("/")) return "none";
    if (AUTO_MEMORY_TEST_MESSAGE_RE.test(trimmed)) return "none";
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

  const CLAUDE_READ_ONLY_TOOLS = new Set([
    "read", "glob", "grep", "toolsearch", "tasklist", "taskget",
    "webfetch", "websearch",
  ]);

  const normalizeToolNameForApproval = (toolName: string): string =>
    toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const claudeToolNeedsApproval = (
    toolName: string,
    input: Record<string, unknown>,
    permissionMode: string,
  ): boolean => {
    const normalized = normalizeToolNameForApproval(toolName);
    // bypassPermissions → never prompt
    if (permissionMode === "bypassPermissions") return false;
    // plan mode → handled elsewhere (deny writes entirely)
    if (permissionMode === "plan") return false;
    // Read-only tools never need approval
    if (CLAUDE_READ_ONLY_TOOLS.has(normalized)) return false;
    // acceptEdits → only prompt for Bash
    if (permissionMode === "acceptEdits") {
      return normalized.includes("bash");
    }
    // default → prompt for mutating tools (Bash, Write, Edit, NotebookEdit, Agent, etc.)
    if (normalized.includes("bash") || normalized.includes("write") || normalized.includes("edit")
      || normalized.includes("agent") || normalized.includes("notebookedit")) {
      return true;
    }
    return false;
  };

  const buildClaudeToolApprovalDescription = (
    toolName: string,
    input: Record<string, unknown>,
    sdkOptions?: { blockedPath?: string; decisionReason?: string },
  ): string => {
    const lowerName = toolName.toLowerCase();
    let headline: string;
    if (sdkOptions?.decisionReason) {
      headline = sdkOptions.decisionReason;
    } else if (lowerName.includes("bash")) {
      const cmd = typeof input.command === "string" ? input.command
        : typeof input.cmd === "string" ? input.cmd
        : null;
      headline = cmd
        ? `Run command: ${cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd}`
        : "Run a shell command";
    } else if (lowerName.includes("write")) {
      const filePath = typeof input.file_path === "string" ? input.file_path : null;
      headline = filePath ? `Write file: ${filePath}` : "Write a file";
    } else if (lowerName.includes("edit")) {
      const filePath = typeof input.file_path === "string" ? input.file_path : null;
      headline = filePath ? `Edit file: ${filePath}` : "Edit a file";
    } else {
      headline = `Use tool: ${toolName}`;
    }
    if (sdkOptions?.blockedPath) {
      return `${headline}\nPath: ${sdkOptions.blockedPath}`;
    }
    return headline;
  };

  const hasClaudeAskUserAnswers = (input: Record<string, unknown>): boolean => {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const answers = asRecord(input.answers);
    if (!answers || questions.length === 0) return false;
    const hasAnswerValue = (value: unknown): boolean => {
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.some((item) => hasAnswerValue(item));
      if (value && typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some((item) => hasAnswerValue(item));
      }
      return value != null && value !== false;
    };
    return questions.every((q) => {
      const key = typeof q === "object" && q !== null && typeof (q as Record<string, unknown>).id === "string"
        ? (q as Record<string, unknown>).id as string
        : typeof q === "object" && q !== null && typeof (q as Record<string, unknown>).question === "string"
          ? (q as Record<string, unknown>).question as string
          : null;
      if (!key) return false;
      // Check both the question id and the question text as answer keys
      return hasAnswerValue(answers[key])
        || (typeof (q as Record<string, unknown>).question === "string" && hasAnswerValue(answers[(q as Record<string, unknown>).question as string]));
    });
  };

  const buildClaudeAskUserPendingRequest = (
    runtime: ClaudeRuntime,
    input: Record<string, unknown>,
    sdkOptions?: { toolUseID?: string },
  ): PendingInputRequest | null => {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const questions: PendingInputQuestion[] = [];

    for (const [index, rawQuestion] of rawQuestions.entries()) {
      const questionRecord = asRecord(rawQuestion);
      if (!questionRecord) continue;

      const question = typeof questionRecord.question === "string" ? questionRecord.question.trim() : "";
      if (!question.length) continue;
      const questionId = typeof questionRecord.id === "string" && questionRecord.id.trim().length > 0
        ? questionRecord.id.trim()
        : `question_${index + 1}`;

      const header = typeof questionRecord.header === "string" ? questionRecord.header.trim() : "";
      const isMultiSelect = questionRecord.multiSelect === true;
      const options = Array.isArray(questionRecord.options)
        ? questionRecord.options
          .map((rawOption) => {
            const optionRecord = asRecord(rawOption);
            if (!optionRecord) return null;
            const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
            if (!label.length) return null;
            const description = typeof optionRecord.description === "string" ? optionRecord.description.trim() : "";
            const preview = typeof optionRecord.preview === "string" ? optionRecord.preview : "";
            const previewFormat: "markdown" | "html" =
              optionRecord.previewFormat === "html" || optionRecord.previewFormat === "markdown"
                ? optionRecord.previewFormat
                : "markdown";
            return {
              label,
              value: label,
              ...(description.length ? { description } : {}),
              ...(label.endsWith("(Recommended)") ? { recommended: true } : {}),
              ...(preview.trim().length ? { preview, previewFormat } : {}),
            };
          })
          .filter((option): option is NonNullable<typeof option> => option != null)
        : [];

      questions.push({
        id: questionId,
        question,
        ...(header.length ? { header } : {}),
        ...(options.length ? { options } : {}),
        ...(isMultiSelect ? { multiSelect: true } : {}),
        allowsFreeform: true,
        ...(isMultiSelect
          ? {
              impact:
                "This question allows multiple selections. If you want more than one option, type them as a comma-separated answer.",
            }
          : {}),
      });
    }

    if (questions.length === 0) return null;

    const firstQuestion = questions[0];
    const hasStructuredChoices = questions.length > 1 || questions.some((question) => (question.options?.length ?? 0) > 0);
    const itemId = randomUUID();
    return {
      requestId: itemId,
      itemId,
      source: "claude",
      kind: hasStructuredChoices ? "structured_question" : "question",
      title: questions.length === 1 ? "Question from Claude" : "Questions from Claude",
      description: questions.length === 1
        ? firstQuestion?.question ?? "Claude needs an answer before it can continue."
        : "Claude needs a few answers before it can continue.",
      questions,
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
      providerMetadata: {
        tool: "AskUserQuestion",
        questionCount: questions.length,
        ...(sdkOptions?.toolUseID ? { toolUseID: sdkOptions.toolUseID } : {}),
      },
      turnId: runtime.activeTurnId ?? null,
    };
  };

  const buildClaudeAskUserUpdatedInput = (
    input: Record<string, unknown>,
    request: PendingInputRequest,
    response: { answers?: Record<string, string | string[]>; responseText?: string | null },
  ): Record<string, unknown> => {
    const normalizedAnswers = normalizePendingInputAnswers(request, response.answers, response.responseText);
    const mappedAnswers = Object.fromEntries(
      Object.entries(normalizedAnswers)
        .map(([questionId, values]) => {
          // Map internal question ID back to the original question text
          // so Claude's SDK receives answers keyed the way it expects.
          const question = request.questions.find((q) => q.id === questionId);
          const originalKey = question?.question ?? questionId;
          // Preserve array structure for multi-select questions
          const answer: string | string[] = question?.multiSelect ? values : values.join(", ").trim();
          return [originalKey, answer] as const;
        })
        .filter(([, answer]) => (typeof answer === "string" ? answer.length > 0 : answer.length > 0)),
    );

    const existingAnswers = asRecord(input.answers) ?? {};
    return {
      ...input,
      answers: { ...existingAnswers, ...mappedAnswers },
    };
  };

  const buildClaudeCanUseTool = (
    runtime: ClaudeRuntime,
    managed: ManagedChatSession,
  ): ClaudeSDKOptions["canUseTool"] => async (toolName, input, sdkOptions): Promise<ClaudePermissionResult> => {
    // ── EnterPlanMode interception ──
    // Sync ADE session state when the SDK enters plan mode mid-session so
    // the permission-mode picker in the UI stays in sync.
    if (toolName === "EnterPlanMode") {
      if (managed.session.permissionMode !== "plan") {
        applyClaudePlanModeTransition(managed.session, "plan");
        persistChatState(managed);
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Session entered plan mode",
          detail: buildClaudePlanModeNoticeDetail("entered_plan_mode"),
          turnId: runtime.activeTurnId ?? undefined,
        });
      }
      return { behavior: "allow", updatedInput: input };
    }

    // ── ExitPlanMode interception ──
    // Intercept ExitPlanMode to show a plan approval UI instead of letting the
    // SDK handle it natively (which just collapses into the work log).
    if (toolName === "ExitPlanMode") {
      // Idempotency guard: if plan mode was already exited (e.g. retry after
      // the first approval), return immediately without showing the approval UI
      // again. This prevents the retry loop caused by the SDK's ExitPlanMode
      // handler failing with ZodError.
      const alreadyExited = managed.session.permissionMode !== "plan"
        && managed.session.interactionMode !== "plan";
      if (alreadyExited) {
        if (sdkOptions?.toolUseID) {
          runtime.resolvedToolUseIds.add(String(sdkOptions.toolUseID));
        }
        return {
          behavior: "deny",
          message: "Plan mode has already been exited. Proceed with implementation.",
        };
      }

      // In bypass / full-auto mode, auto-approve the plan without showing
      // approval UI — the user opted out of all permission gates.
      const effectiveAccess = managed.session.claudePermissionMode ?? managed.session.permissionMode;
      if (effectiveAccess === "bypassPermissions" || managed.session.permissionMode === "full-auto") {
        // Transition out of plan mode so the UI reflects the change,
        // matching the state update performed after manual approval.
        if (managed.session.permissionMode === "plan" || managed.session.interactionMode === "plan") {
          applyClaudePlanModeTransition(managed.session, "default");
          persistChatState(managed);
        }
        return { behavior: "allow", updatedInput: input };
      }

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
        description: planSummary,
        detail: { tool: "ExitPlanMode", planContent },
      });

      // Block until the user responds via the approval UI.
      let response: { decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null };
      try {
        runtime.pauseIdleWatchdog?.();
        response = await new Promise<typeof response>((resolve) => {
          runtime.approvals.set(approvalItemId, { kind: "approval", resolve, request });
        });
      } finally {
        runtime.approvals.delete(approvalItemId);
        runtime.resumeIdleWatchdog?.();
      }

      // Emit tool_result so derivePendingInputRequests clears this entry.
      const approved = response.decision === "accept" || response.decision === "accept_for_session";
      emitChatEvent(managed, {
        type: "tool_result",
        tool: "ExitPlanMode",
        result: { approved },
        itemId: approvalItemId,
        turnId: runtime.activeTurnId ?? undefined,
        status: approved ? "completed" : "failed",
      });
      if (sdkOptions?.toolUseID) {
        runtime.resolvedToolUseIds.add(String(sdkOptions.toolUseID));
      }

      if (approved) {
        // Switch session out of plan mode so the UI reflects the transition.
        if (managed.session.permissionMode === "plan" || managed.session.interactionMode === "plan") {
          applyClaudePlanModeTransition(managed.session, "default");
          persistChatState(managed);
        }

        // Sync the SDK session so it knows plan mode ended.
        try {
          const sessionControl = getClaudeV2SessionControl(runtime.v2Session);
          if (typeof sessionControl.setPermissionMode === "function") {
            await sessionControl.setPermissionMode(resolveSessionClaudePermissionMode(managed.session, "default"));
          }
        } catch { /* best-effort — the deny result below handles the transition semantically */ }

        // Emit permission mode change notice for UI sync.
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Session exited plan mode",
          detail: buildClaudePlanModeNoticeDetail("exited_plan_mode"),
          turnId: runtime.activeTurnId ?? undefined,
        });

        // Return deny to bypass the SDK's built-in ExitPlanMode handler
        // entirely (which can fail with ZodError due to schema mismatch).
        // Claude sees the message text and knows the plan was approved.
        return {
          behavior: "deny",
          message: "Plan approved by the user. The session has exited plan mode. Proceed with implementing the plan. Do not call ExitPlanMode again.",
        };
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

    if (toolName === "AskUserQuestion") {
      if (hasClaudeAskUserAnswers(input)) {
        return { behavior: "allow", updatedInput: input };
      }

      const request = buildClaudeAskUserPendingRequest(runtime, input, sdkOptions);
      if (!request) {
        return { behavior: "allow", updatedInput: input };
      }

      const approvalItemId = request.itemId ?? request.requestId;
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: request.description ?? "Claude needs input before it can continue.",
        detail: {
          tool: "AskUserQuestion",
          questionCount: request.questions.length,
          ...(sdkOptions?.toolUseID ? { toolUseID: sdkOptions.toolUseID } : {}),
        },
      });

      let response: { decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null };
      try {
        runtime.pauseIdleWatchdog?.();
        response = await new Promise<typeof response>((resolve) => {
          runtime.approvals.set(approvalItemId, { kind: "question", resolve, request });
        });
      } finally {
        runtime.approvals.delete(approvalItemId);
        runtime.resumeIdleWatchdog?.();
      }

      // Emit a tool_result so derivePendingInputRequests clears this entry
      // and the question UI doesn't reappear on the next event flush.
      const answered = response.decision !== "cancel" && response.decision !== "decline";
      emitChatEvent(managed, {
        type: "tool_result",
        tool: "AskUserQuestion",
        result: { answered, decision: response.decision ?? "none" },
        itemId: approvalItemId,
        turnId: runtime.activeTurnId ?? undefined,
        status: answered ? "completed" : "failed",
      });

      // Track the SDK tool_use ID so flushOpenClaudeToolUses skips it
      // (prevents the synthetic "Completed AskUserQuestion when turn ended" noise).
      if (sdkOptions?.toolUseID) {
        runtime.resolvedToolUseIds.add(String(sdkOptions.toolUseID));
      }

      if (response.decision === "cancel" || response.decision === "decline") {
        return {
          behavior: "deny",
          message: "The user declined to answer the questions.",
        };
      }

      const updatedInput = buildClaudeAskUserUpdatedInput(input, request, response);
      if (!hasClaudeAskUserAnswers(updatedInput)) {
        return {
          behavior: "deny",
          message: "The user did not provide answers to the questions.",
        };
      }

      return {
        behavior: "allow",
        updatedInput,
      };
    }

    // ── Memory orientation guard ──
    const state = runtime.turnMemoryPolicyState;
    if (isMemorySearchToolName(toolName) && state) {
      state.explicitSearchPerformed = true;
      state.orientationSatisfied = true;
      return { behavior: "allow", updatedInput: input };
    }
    if (state && state.classification === "required" && !state.orientationSatisfied && !state.explicitSearchPerformed) {
      if (isClaudeMutatingToolCall(toolName, input)) {
        return { behavior: "deny", message: CHAT_MEMORY_GUARD_MESSAGE };
      }
    }

    // ── Tool permission prompts ──
    // Surface approval prompts for non-bypass permission modes so the user can
    // allow or deny individual tool calls (matching the opencode runtime pattern).
    const effectivePermMode = managed.session.claudePermissionMode ?? "default";
    const normalizedToolName = normalizeToolNameForApproval(toolName);
    // Auto-allow ADE `ask_user`: the inline question card carries its
    // own dedicated answer UI, so surfacing a generic "Allow this tool?" permission
    // prompt just hides the real question behind an extra click. Gated by
    // `ai.chat.autoAllowAskUser` (default: true) so policy can flip it off.
    if (isAskUserToolName(toolName) && isAutoAllowAskUserEnabled()) {
      return { behavior: "allow", updatedInput: input };
    }
    if (claudeToolNeedsApproval(toolName, input, effectivePermMode)) {
      // Check session-wide overrides — user already said "Allow for Session" for this tool
      if (runtime.approvalOverrides.has(normalizedToolName)) {
        return { behavior: "allow", updatedInput: input };
      }

      const approvalItemId = randomUUID();
      const turnId = runtime.activeTurnId ?? undefined;
      const description = buildClaudeToolApprovalDescription(toolName, input, sdkOptions);
      const request: PendingInputRequest = {
        requestId: approvalItemId,
        itemId: approvalItemId,
        source: "claude",
        kind: "approval",
        title: `Allow ${toolName}?`,
        description,
        questions: [{
          id: "tool_decision",
          header: toolName,
          question: description,
          options: [
            { label: "Allow", value: "allow", recommended: true },
            { label: "Allow for Session", value: "allow_session" },
            { label: "Deny", value: "deny" },
          ],
          allowsFreeform: true,
        }],
        allowsFreeform: true,
        blocking: true,
        canProceedWithoutAnswer: false,
        providerMetadata: {
          tool: toolName,
          input,
          ...(sdkOptions?.blockedPath ? { blockedPath: sdkOptions.blockedPath } : {}),
          ...(sdkOptions?.decisionReason ? { decisionReason: sdkOptions.decisionReason } : {}),
          ...(sdkOptions?.toolUseID ? { toolUseID: sdkOptions.toolUseID } : {}),
        },
        turnId: turnId ?? null,
      };

      emitPendingInputRequest(managed, request, {
        kind: normalizedToolName.includes("bash") ? "command" : "file_change",
        description,
        detail: { tool: toolName, ...(sdkOptions?.blockedPath ? { blockedPath: sdkOptions.blockedPath } : {}) },
      });

      let response: { decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null };
      try {
        runtime.pauseIdleWatchdog?.();
        response = await new Promise<typeof response>((resolve) => {
          runtime.approvals.set(approvalItemId, { kind: "approval", resolve, request });
        });
      } finally {
        runtime.approvals.delete(approvalItemId);
        runtime.resumeIdleWatchdog?.();
      }

      const approved = response.decision === "accept" || response.decision === "accept_for_session";
      if (response.decision === "accept_for_session") {
        runtime.approvalOverrides.add(normalizedToolName);
      }
      if (approved) {
        return {
          behavior: "allow",
          updatedInput: input,
          ...(response.decision === "accept_for_session" && sdkOptions?.suggestions?.length
            ? { updatedPermissions: sdkOptions.suggestions }
            : {}),
        };
      }
      const feedback = typeof response.responseText === "string" ? response.responseText.trim() : "";
      return {
        behavior: "deny",
        message: feedback.length > 0
          ? `User denied this tool call: ${feedback}`
          : "User denied this tool call.",
      };
    }

    return { behavior: "allow", updatedInput: input };
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

  const previewSessionToolNames = ({
    laneId,
    sessionProfile,
    identityKey,
  }: Pick<AgentChatCreateArgs, "laneId" | "sessionProfile" | "identityKey">): string[] => {
    const effectiveSessionProfile = sessionProfile ?? "workflow";
    if (effectiveSessionProfile === "light") return [];

    const sessionId = `preview:${laneId}`;
    const toolNames = new Set<string>();
    const workflowTools = createWorkflowTools({
      laneService,
      prService: prService ?? undefined,
      computerUseArtifactBrokerService: computerUseArtifactBrokerRef ?? undefined,
      onReportCompletion: null,
      sessionId,
      laneId,
    });
    for (const toolName of Object.keys(workflowTools)) {
      toolNames.add(toolName);
    }

    const linearTools = createLinearTools({
      linearClient: linearClientRef ?? null,
      credentials: linearCredentialsRef ?? null,
    });
    for (const toolName of Object.keys(linearTools)) {
      toolNames.add(toolName);
    }

    for (const toolName of CORE_NATIVE_SESSION_TOOL_NAMES) {
      toolNames.add(toolName);
    }

    if (identityKey === "cto") {
      const ctoTools = createCtoOperatorTools({
        currentSessionId: sessionId,
        defaultLaneId: laneId,
        defaultModelId: null,
        defaultReasoningEffort: null,
        resolveExecutionLane: async ({ requestedLaneId }) => requestedLaneId?.trim() || laneId,
        laneService,
        missionService: getMissionService?.() ?? null,
        aiOrchestratorService: getAiOrchestratorService?.() ?? null,
        workerAgentService: workerAgentService ?? null,
        workerHeartbeatService: workerHeartbeatService ?? null,
        linearDispatcherService: getLinearDispatcherService?.() ?? null,
        flowPolicyService: flowPolicyService ?? null,
        prService: prService ?? null,
        issueInventoryService,
        fileService: fileService ?? null,
        processService: processService ?? null,
        testService: getTestService?.() ?? null,
        ptyService: ptyService ?? null,
        automationService: getAutomationService?.() ?? null,
        gitService: getGitService?.() ?? null,
        conflictService: conflictService ?? null,
        contextDocService: contextDocService ?? null,
        computerUseArtifactBrokerService: computerUseArtifactBrokerRef ?? null,
        workerBudgetService: getWorkerBudgetService?.() ?? null,
        missionBudgetService: getMissionBudgetService?.() ?? null,
        steerChat: undefined,
        cancelSteer: undefined,
        handoffChat: undefined,
        listSubagents: undefined,
        approveToolUse: undefined,
        issueTracker: linearIssueTracker ?? null,
        ctoStateService: ctoStateService ?? null,
        listChats: listSessions,
        getChatStatus: getSessionSummary,
        getChatTranscript,
        createChat: createSession,
        updateChatSession: updateSession,
        sendChatMessage: sendMessage,
        interruptChat: interrupt,
        resumeChat: resumeSession,
        disposeChat: dispose,
        sessionService,
        ensureCtoSession: async ({ laneId: requestedLaneId, modelId, reasoningEffort, reuseExisting }) =>
          ensureIdentitySession({
            identityKey: "cto",
            laneId: requestedLaneId,
            modelId,
            reasoningEffort,
            reuseExisting,
            permissionMode: "full-auto",
          }),
        previewSessionToolNames,
      } as Parameters<typeof createCtoOperatorTools>[0] & {
        previewSessionToolNames: typeof previewSessionToolNames;
      });
      for (const toolName of Object.keys(ctoTools)) {
        toolNames.add(toolName);
      }
    }

    return Array.from(toolNames).sort((a, b) => a.localeCompare(b));
  };

  const deriveSessionCapabilities = (managed: ManagedChatSession | null): AgentChatSessionCapabilities => ({
    supportsSubagentInspection: Boolean(managed && (managed.session.provider === "claude" || managed.session.provider === "codex")),
    supportsSubagentControl: Boolean(managed && managed.runtime?.kind === "claude"),
    supportsReviewMode: Boolean(managed && managed.session.provider === "codex"),
  });

  const getClaudeV2SessionControl = (
    session: ClaudeV2Session | null | undefined,
  ): {
    setMcpServers?: (servers: Record<string, Record<string, unknown>>) => Promise<{
      added?: string[];
      removed?: string[];
      errors?: Record<string, string>;
    }>;
    setPermissionMode?: (mode: AgentChatClaudePermissionMode) => Promise<void>;
    supportedCommands?: () => Promise<Array<{ name?: string; description?: string }>>;
  } => {
    const sessionRecord = session as (ClaudeV2Session & { query?: ClaudeV2Session["query"] }) | null | undefined;
    const query = sessionRecord?.query;

    return {
      setMcpServers: typeof query?.setMcpServers === "function" ? query.setMcpServers.bind(query) : undefined,
      setPermissionMode: typeof sessionRecord?.setPermissionMode === "function"
        ? sessionRecord.setPermissionMode.bind(sessionRecord)
        : (typeof query?.setPermissionMode === "function" ? query.setPermissionMode.bind(query) : undefined),
      supportedCommands: typeof sessionRecord?.supportedCommands === "function"
        ? sessionRecord.supportedCommands.bind(sessionRecord)
        : (typeof query?.supportedCommands === "function" ? query.supportedCommands.bind(query) : undefined),
    };
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

  const readLatestTranscriptTodoItems = (
    managed: ManagedChatSession,
  ): Extract<AgentChatEvent, { type: "todo_update" }>["items"] => {
    try {
      const raw = fs.readFileSync(managed.transcriptPath, "utf8");
      let latest: Extract<AgentChatEvent, { type: "todo_update" }>["items"] = [];
      for (const entry of parseAgentChatTranscript(raw)) {
        if (entry.sessionId !== managed.session.id) continue;
        if (entry.event.type === "todo_update") {
          latest = entry.event.items;
        }
      }
      return latest;
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

  // Read the full on-disk transcript for a session without requiring an active
  // ManagedChatSession. Used by getChatEventHistory to hydrate the in-memory
  // ring buffer on first read, even for sessions that haven't been resumed yet
  // (e.g. a chat whose runtime was torn down by idle_ttl / budget_eviction).
  const readTranscriptEnvelopesForSessionId = (sessionId: string): AgentChatEventEnvelope[] => {
    const managed = managedSessions.get(sessionId);
    if (managed?.transcriptPath) {
      try {
        return parseAgentChatTranscript(fs.readFileSync(managed.transcriptPath, "utf8"))
          .filter((entry) => entry.sessionId === sessionId);
      } catch {
        return [];
      }
    }
    // Fall back to the known transcript layout so sessions that were never
    // ensured into managedSessions (e.g. because they were torn down and
    // haven't been reopened yet) still surface their history.
    const candidates = [
      path.join(transcriptsDir, `${sessionId}.chat.jsonl`),
      path.join(chatTranscriptsDir, `${sessionId}.jsonl`),
    ];
    for (const candidatePath of candidates) {
      try {
        if (!fs.existsSync(candidatePath)) continue;
        const raw = fs.readFileSync(candidatePath, "utf8");
        return parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);
      } catch {
        // try next candidate
      }
    }
    return [];
  };

  const envelopeDedupKey = (entry: AgentChatEventEnvelope): string => {
    // Cross-run-safe key: two envelopes are true duplicates iff timestamp,
    // type, AND payload all match. Sequence numbers can't be trusted (they
    // restart per run), and Claude streaming emits multiple text/reasoning
    // fragments within the same millisecond + type — timestamp+type alone
    // would wrongly collapse those into one. JSON.stringify is fine at our
    // scale (≤2000 events, events typically <1KB).
    return `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
  };

  const mergeEnvelopeStreams = (
    base: AgentChatEventEnvelope[],
    tail: AgentChatEventEnvelope[],
  ): AgentChatEventEnvelope[] => {
    if (!base.length) return tail.slice();
    if (!tail.length) return base.slice();
    const baseKeys = new Set(base.map(envelopeDedupKey));
    const merged = base.slice();
    for (const entry of tail) {
      if (baseKeys.has(envelopeDedupKey(entry))) continue;
      merged.push(entry);
    }
    merged.sort((left, right) => {
      // Timestamp is cross-run consistent; sequence is only a tiebreak
      // within the same run.
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      if (leftTime !== rightTime) return leftTime - rightTime;
      if (typeof left.sequence === "number" && typeof right.sequence === "number") {
        return left.sequence - right.sequence;
      }
      return 0;
    });
    return merged;
  };

  /**
   * Return the complete, ordered event history for a chat session.
   *
   * On first call (or any call that can tolerate a larger read), we merge the
   * on-disk transcript with the in-memory ring buffer so that:
   *   - events that were emitted while the renderer was on a different project
   *     (and therefore dropped by emitProjectEvent) are still recovered;
   *   - events that are still in fs.appendFile flight but already recorded in
   *     the buffer are still delivered;
   *   - truncating the persistent transcript for size does not lose recent
   *     events that the buffer still has.
   *
   * This is the canonical snapshot path for renderer resubscribe / remount.
   */
  const getChatEventHistory = (
    sessionId: string,
    options?: { maxEvents?: number },
  ): { sessionId: string; events: AgentChatEventEnvelope[]; truncated: boolean } => {
    const trimmedId = sessionId.trim();
    if (!trimmedId.length) {
      return { sessionId: trimmedId, events: [], truncated: false };
    }
    // Validate the session belongs to an agent chat before reading any
    // transcript path — this function is reachable via IPC and builds
    // filesystem paths from `trimmedId` downstream.
    const row = sessionService.get(trimmedId);
    if (!row || !isChatToolType(row.toolType)) {
      return { sessionId: trimmedId, events: [], truncated: false };
    }
    const maxEvents = Math.max(
      1,
      Math.min(
        CHAT_EVENT_HISTORY_RESPONSE_MAX_PER_SESSION,
        Math.floor(options?.maxEvents ?? CHAT_EVENT_HISTORY_RESPONSE_MAX_PER_SESSION),
      ),
    );

    // Re-read disk on every snapshot. A long-running background chat can age
    // older entries out of the live ring buffer; the persisted transcript is
    // the durable source for project/tab switch recovery, while the buffer
    // contributes events that fs.appendFile may not have flushed yet.
    const bufferExisting = eventHistoryBySession.get(trimmedId) ?? [];
    let merged = mergeEnvelopeStreams(readTranscriptEnvelopesForSessionId(trimmedId), bufferExisting);
    if (merged.length > CHAT_EVENT_HISTORY_RESPONSE_MAX_PER_SESSION) {
      merged = merged.slice(-CHAT_EVENT_HISTORY_RESPONSE_MAX_PER_SESSION);
    }
    eventHistoryBySession.set(trimmedId, merged.slice(-CHAT_EVENT_HISTORY_BUFFER_MAX_PER_SESSION));

    const truncated = merged.length > maxEvents;
    const windowed = truncated ? merged.slice(-maxEvents) : merged;
    return { sessionId: trimmedId, events: windowed, truncated };
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

  const buildRecentConversationContext = (managed: ManagedChatSession, limit = 20): string => {
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
    const availableModels = await getAvailableRegistryModels(auth);
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
      const result = await runSessionIntelligencePrompt({
        cwd: managed.laneWorktreePath,
        modelId: descriptor.id,
        prompt,
        taskType: "continuity_summary",
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
    if (managed.recentConversationEntries.length > MAX_RECENT_CONVERSATION_ENTRIES) {
      managed.recentConversationEntries.splice(
        0,
        managed.recentConversationEntries.length - MAX_RECENT_CONVERSATION_ENTRIES,
      );
    }
  };

  const refreshReconstructionContext = (managed: ManagedChatSession): void => {
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

    const recentConversation = buildRecentConversationContext(managed);
    if (recentConversation.length) {
      sections.push(["Recent Conversation Tail", recentConversation].join("\n"));
    }

    const nextContext = sections.map((section) => section.trim()).filter((section) => section.length > 0).join("\n\n");
    managed.pendingReconstructionContext = nextContext.length ? nextContext : null;
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
    const localProviders = snapshot.effective.ai?.localProviders;
    return detectAllAuth(configApiKeys, {
      localProviders,
    });
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
    if (runtime.kind === "opencode") {
      if (runtime.busy || runtime.activeTurnId || runtime.eventAbortController) {
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
    const availableModels = await getAvailableRegistryModels(auth);
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
      const result = await runSessionIntelligencePrompt({
        cwd: args.managed.laneWorktreePath,
        modelId: descriptor.id,
        prompt,
        taskType: "handoff_summary",
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

    sessionService.updateMeta({ sessionId: managed.session.id, title, manuallyNamed: false });

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
    if (managed.deleted) return;
    const config = resolveChatConfig();
    if (!config.titleGenerationEnabled) return;
    if (managed.manuallyNamed) return;
    if (managed.autoTitleInFlight) return;
    if (args.stage === "initial" && managed.autoTitleStage !== "none") return;
    if (args.stage === "final") {
      if (!config.titleRefreshOnComplete) return;
      if (managed.autoTitleStage === "final") return;
    }

    const seed = sanitizeAutoTitle(args.latestUserText ?? managed.autoTitleSeed ?? "", 180);
    if (!seed) return;

    const auth = await detectAuth();
    const availableModels = await getAvailableRegistryModels(auth);
    if (!availableModels.length) return;

    const preferredModelId =
      [
        config.titleModelId,
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
      const result = await runSessionIntelligencePrompt({
        cwd: managed.laneWorktreePath,
        modelId: descriptor.id,
        systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
        prompt: [
          args.stage === "final"
            ? "Write a final concise title for this completed coding chat."
            : "Write a concise title for this new coding chat.",
          titleContext.join("\n"),
        ].join("\n\n"),
        taskType: "session_title",
      });
      // Re-check after async — user may have manually renamed while the request was in flight.
      if (managed.manuallyNamed) return;
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

  // OpenCode handles API-key and local-model chats.
  // CLI-wrapped models fall through to the existing Claude/Codex runtimes.
  // Local model discovery is consolidated through OpenCode's provider inventory.

  const getAvailableRegistryModels = async (
    auth: Awaited<ReturnType<typeof detectAuth>>,
  ): Promise<ModelDescriptor[]> => {
    // Local model discovery is handled by OpenCode via probeOpenCodeProviderInventory
    // which populates dynamic OpenCode descriptors (including local providers).
    return getRegistryModels(auth).filter((descriptor) => !descriptor.deprecated);
  };

  const resolveOpenCodeLocalDescriptor = async (
    managed: ManagedChatSession,
    descriptor: ModelDescriptor,
    auth: Awaited<ReturnType<typeof detectAuth>>,
  ): Promise<ModelDescriptor> => {
    if (!(descriptor.family === "ollama" || descriptor.family === "lmstudio")) {
      return descriptor;
    }
    if (descriptor.providerModelId !== "auto") {
      return descriptor;
    }

    const localProvider = descriptor.family as LocalProviderFamily;

    // Use OpenCode dynamic descriptors to find loaded models for this local provider.
    const openCodeLocals = getDynamicOpenCodeModelDescriptors().filter(
      (d) => d.family === localProvider,
    );

    const preferred = auth.find(
      (entry): entry is Extract<Awaited<ReturnType<typeof detectAuth>>[number], { type: "local" }> =>
        entry.type === "local" && entry.provider === localProvider,
    )?.preferredModelId;
    const preferredDescriptor = preferred ? getModelById(preferred) : undefined;
    if (preferredDescriptor && preferredDescriptor.family === localProvider) {
      managed.session.modelId = preferredDescriptor.id;
      managed.session.model = preferredDescriptor.id;
      return preferredDescriptor;
    }

    if (openCodeLocals.length === 1) {
      return openCodeLocals[0]!;
    }

    if (openCodeLocals.length > 1) {
      throw new Error(
        `${descriptor.displayName} has multiple loaded models. Choose a specific ${LOCAL_PROVIDER_LABELS[localProvider]} model or save a preferred local model first.`,
      );
    }

    throw new Error(`${descriptor.displayName} is reachable, but no models are currently loaded.`);
  };

  const startOpenCodeSessionRuntime = async (managed: ManagedChatSession): Promise<"handled" | "fallthrough"> => {
    const modelId = managed.session.modelId;
    if (!modelId) return "fallthrough";

    let descriptor = getModelById(modelId);
    if (!descriptor) return "fallthrough";

    // CLI-wrapped models -> defer to CLI session runtimes.
    if (descriptor.isCliWrapped) return "fallthrough";

    logger.info("agent_chat.opencode_session_starting", {
      sessionId: managed.session.id,
      modelId,
      family: descriptor.family,
    });

    const auth = await detectAuth();
    descriptor = await resolveOpenCodeLocalDescriptor(managed, descriptor, auth);
    enforceManagedLocalHarnessPermissionMode(managed, descriptor);

    const chatConfig = resolveChatConfig();
    const permMode: PermissionMode = resolveSessionOpenCodePermissionMode(
      managed.session,
      chatConfig.opencodePermissionMode,
    );
    const configSnapshot = projectConfigService.get();
    const persisted = readPersistedState(managed.session.id);
    // Discover loaded local models so OpenCode's provider config includes them.
    // inspectLocalProvider results are cached (30s TTL) so this is near-instant
    // when aiIntegrationService has already probed recently.
    const discoveredLocalModels: DiscoveredLocalModelEntry[] = [];
    const localProviderConfigs = configSnapshot.effective.ai?.localProviders ?? {};
    for (const family of ["ollama", "lmstudio"] as const) {
      const providerSettings = localProviderConfigs[family];
      if (providerSettings?.enabled === false) continue;
      const localAuth = auth.find(
        (a): a is Extract<typeof a, { type: "local" }> =>
          a.type === "local" && a.provider === family,
      );
      const endpoint = localAuth?.endpoint ?? providerSettings?.endpoint ?? getLocalProviderDefaultEndpoint(family);
      try {
        const inspection = await inspectLocalProvider(family, endpoint);
        for (const m of inspection.loadedModels) {
          discoveredLocalModels.push({ provider: m.provider, modelId: m.modelId });
        }
      } catch {
        // Non-fatal — provider may be offline
      }
    }
    const handle = await startOpenCodeSession({
      directory: managed.laneWorktreePath,
      title: sessionService.get(managed.session.id)?.title ?? defaultChatSessionTitle("opencode"),
      sessionId: persisted?.providerSessionId,
      projectConfig: configSnapshot.effective,
      discoveredLocalModels,
      ownerKind: "chat",
      ownerId: managed.session.id,
      ownerKey: `chat:${managed.session.id}`,
      leaseKind: "shared",
      logger,
    });

    const runtime: OpenCodeRuntime = {
      kind: "opencode",
      handle,
      busy: false,
      eventAbortController: null,
      activeTurnId: null,
      permissionMode: permMode,
      pendingApprovals: new Map(),
      pendingSteers: [],
      interrupted: false,
      modelDescriptor: descriptor,
      textByPartId: new Map(),
      reasoningByPartId: new Map(),
      toolStateByPartId: new Map(),
    };
    handle.setEvictionHandler((reason) => {
      if (managed.runtime?.kind === "opencode" && managed.runtime.handle === handle) {
        teardownRuntime(
          managed,
          reason === "error" || reason === "config_changed" || reason === "attach_failed"
            ? "handle_close"
            : reason,
        );
      }
    });
    handle.setBusy(false);
    handle.touch();

    // Evict least-recent runtime if at capacity
    {
      let activeCount = 0;
      for (const [, s] of managedSessions) { if (s.runtime) activeCount++; }
      if (activeCount >= MAX_CONCURRENT_ACTIVE_RUNTIMES) evictLeastRecentRuntime(managed.session.id);
    }
    managed.runtime = runtime;
    managed.runtimeInvalidated = false;
    managed.session.provider = "opencode";
    managed.session.opencodePermissionMode = permMode;
    managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    enforceManagedLocalHarnessPermissionMode(managed, descriptor);
    managed.session.capabilityMode = isLightweightSession(managed.session) ? "fallback" : "full_tooling";
    persistChatState(managed);
    return "handled";
  };

  const isCliWrappedModelId = (modelId: string): boolean =>
    (getModelById(modelId) ?? resolveModelAlias(modelId))?.isCliWrapped ?? false;

  const isAutoAllowAskUserEnabled = (): boolean => {
    const chat = projectConfigService.get().effective.ai?.chat;
    return chat?.autoAllowAskUser !== false;
  };

  const isAskUserToolName = (toolName: string | null | undefined): boolean => {
    if (!toolName) return false;
    const normalized = normalizeToolNameForApproval(toolName);
    return normalized === "ask_user";
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
      if (cliMode === "read-only") return "on-request" as const;
      if (cliMode === "edit") return "untrusted" as const;
      return "on-request" as const;
    })();

    const sandboxMode = (() => {
      if (chat.codexSandbox) return chat.codexSandbox;
      if (permissions.cli?.sandboxPermissions) return permissions.cli.sandboxPermissions;
      if (cliMode === "full-auto") return "danger-full-access" as const;
      if (cliMode === "read-only") return "read-only" as const;
      return "workspace-write" as const;
    })();

    const claudePermissionMode = (() => {
      if (chat.claudePermissionMode) return chat.claudePermissionMode;
      if (cliMode === "read-only") return "plan" as const;
      if (cliMode === "full-auto") return "bypassPermissions" as const;
      return "default" as const;
    })();

    const opencodePermissionMode = (() => {
      if (chat.opencodePermissionMode === "plan" || chat.opencodePermissionMode === "edit" || chat.opencodePermissionMode === "full-auto") {
        return chat.opencodePermissionMode;
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

    const legacyChat = chat as Record<string, unknown>;
    const titleGenerationEnabled = si?.titles?.enabled
      ?? (typeof legacyChat.autoTitleEnabled === "boolean" ? legacyChat.autoTitleEnabled : undefined)
      ?? true;
    const titleModelIdRaw = si?.titles?.modelId ?? legacyChat.autoTitleModelId;
    const titleModelId = typeof titleModelIdRaw === "string" && titleModelIdRaw.trim().length
      ? titleModelIdRaw.trim()
      : null;
    const titleRefreshOnComplete = si?.titles?.refreshOnComplete
      ?? (typeof legacyChat.autoTitleRefreshOnComplete === "boolean" ? legacyChat.autoTitleRefreshOnComplete : undefined)
      ?? true;

    // Session-intelligence summaries
    const summaryEnabled = si?.summaries?.enabled ?? true;
    const summaryModelIdRaw = si?.summaries?.modelId;
    const summaryModelId = typeof summaryModelIdRaw === "string" && summaryModelIdRaw.trim().length
      ? summaryModelIdRaw.trim()
      : null;

    return {
      codexApprovalPolicy: approvalPolicy,
      codexSandboxMode: sandboxMode,
      claudePermissionMode,
      opencodePermissionMode,
      sessionBudgetUsd,
      titleGenerationEnabled,
      titleModelId,
      titleRefreshOnComplete,
      summaryEnabled,
      summaryModelId,
    };
  };

  const computeHeadShaBestEffort = async (laneId: string): Promise<string | null> => {
    let cwd: string;
    try {
      ({ laneWorktreePath: cwd } = resolveLaneLaunchContext({
        laneService,
        laneId,
        purpose: "inspect lane git state",
      }));
    } catch (error) {
      logger.warn("agent_chat.head_sha_skipped_invalid_worktree", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const res = await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: 8_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

  const resolveManagedExecutionLaneId = (managed: ManagedChatSession): string =>
    trimLine(managed.preferredExecutionLaneId)
    ?? trimLine(managed.selectedExecutionLaneId)
    ?? managed.session.laneId;

  const refreshHeadShaStartForManagedExecutionLane = async (managed: ManagedChatSession): Promise<void> => {
    const headStart = await computeHeadShaBestEffort(resolveManagedExecutionLaneId(managed)).catch(() => null);
    if (headStart) {
      sessionService.setHeadShaStart(managed.session.id, headStart);
    }
  };

  const captureTurnBeforeSha = (managed: ManagedChatSession): void => {
    const laneId = resolveManagedExecutionLaneId(managed);
    void computeHeadShaBestEffort(laneId).then((sha) => {
      if (sha) managed.turnBeforeSha = sha;
    }).catch(() => {});
  };

  const emitTurnDiffSummaryIfChanged = async (managed: ManagedChatSession, turnId: string): Promise<void> => {
    const beforeSha = managed.turnBeforeSha;
    managed.turnBeforeSha = null;
    if (!beforeSha) return;

    const laneId = resolveManagedExecutionLaneId(managed);
    const afterSha = await computeHeadShaBestEffort(laneId).catch(() => null);
    if (!afterSha || beforeSha === afterSha) return;

    try {
      let cwd: string;
      try {
        ({ laneWorktreePath: cwd } = resolveLaneLaunchContext({
          laneService,
          laneId,
          purpose: "turn diff summary",
        }));
      } catch {
        return;
      }
      const result = await runGit(["diff", "--numstat", `${beforeSha}..${afterSha}`], { cwd, timeoutMs: 10_000 });
      if (result.exitCode !== 0) return;

      const files: Array<{ path: string; additions: number; deletions: number; status: string }> = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split("\t");
        if (parts.length < 3) continue;
        const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
        const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
        const filePath = parts.slice(2).join("\t");
        files.push({ path: filePath, additions, deletions, status: "M" });
        totalAdditions += additions;
        totalDeletions += deletions;
      }

      if (files.length === 0) return;

      // Determine file status (A/M/D) from diff-filter
      const statusResult = await runGit(["diff", "--name-status", `${beforeSha}..${afterSha}`], { cwd, timeoutMs: 10_000 });
      if (statusResult.exitCode === 0) {
        const statusMap = new Map<string, string>();
        for (const line of statusResult.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const tabIdx = trimmed.indexOf("\t");
          if (tabIdx < 0) continue;
          statusMap.set(trimmed.slice(tabIdx + 1).trim(), trimmed.slice(0, tabIdx).trim().charAt(0));
        }
        for (const file of files) {
          file.status = statusMap.get(file.path) ?? "M";
        }
      }

      emitChatEvent(managed, {
        type: "turn_diff_summary",
        turnId,
        beforeSha,
        afterSha,
        files,
        totalAdditions,
        totalDeletions,
      });
    } catch {
      // Silently ignore diff computation failures
    }
  };

  const resolveManagedExecutionContext = (
    managed: ManagedChatSession,
    args: { purpose: string; requestedCwd?: string | null },
  ): LaneLaunchContext & { laneId: string; laneDirectiveKey: string | null } => {
    const laneId = resolveManagedExecutionLaneId(managed);
    const launchContext = resolveLaneLaunchContext({
      laneService,
      laneId,
      purpose: args.purpose,
      requestedCwd: args.requestedCwd,
    });
    return {
      ...launchContext,
      laneId,
      laneDirectiveKey: buildLaneDirectiveKey({
        laneId,
        laneWorktreePath: launchContext.laneWorktreePath,
      }),
    };
  };

  const refreshManagedLaneLaunchContext = (
    managed: ManagedChatSession,
    args: { purpose?: string; requestedCwd?: string | null } = {},
  ): LaneLaunchContext & { laneId: string; laneDirectiveKey: string | null } => {
    const launchContext = resolveManagedExecutionContext(managed, {
      purpose: args.purpose ?? "continue this chat",
      requestedCwd: args.requestedCwd !== undefined ? args.requestedCwd : managed.session.requestedCwd,
    });
    const laneWorktreeChanged = managed.laneWorktreePath !== launchContext.laneWorktreePath;
    managed.laneWorktreePath = launchContext.laneWorktreePath;
    if (
      laneWorktreeChanged
      && (managed.runtime?.kind === "claude"
        || managed.runtime?.kind === "codex"
        || managed.runtime?.kind === "opencode"
        || managed.runtime?.kind === "cursor")
    ) {
      teardownRuntime(managed, "project_close");
      refreshReconstructionContext(managed);
    }
    return launchContext;
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

  const deletePersistedChatFile = (filePath: string | null | undefined): void => {
    const trimmed = typeof filePath === "string" ? filePath.trim() : "";
    if (!trimmed.length) return;
    const resolvedPath = path.resolve(trimmed);
    // Resolve symlinks on the target and both roots before comparing, so a
    // symlink placed inside the chat dir cannot redirect rmSync outside.
    const safeRealpath = (p: string): string | null => {
      try { return fs.realpathSync(p); } catch { return null; }
    };
    const realTarget = safeRealpath(resolvedPath);
    // Missing target is safe to skip — nothing to delete.
    if (!realTarget) return;
    const realAdeDir = safeRealpath(layout.adeDir);
    const realTranscriptRoot = safeRealpath(path.resolve(transcriptsDir));
    const isWithin = (root: string | null): boolean => {
      if (!root) return false;
      const rel = path.relative(root, realTarget);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (!isWithin(realAdeDir) && !isWithin(realTranscriptRoot)) {
      logger.warn("agent_chat.delete_skipped_path_outside_ade", {
        filePath: resolvedPath,
        realTarget,
      });
      return;
    }
    try {
      fs.rmSync(realTarget, { force: true });
    } catch (error) {
      if (isEnoentError(error)) return;
      logger.warn("agent_chat.delete_file_failed", {
        filePath: realTarget,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const rejectActiveSessionTurnCollector = (sessionId: string, message: string): void => {
    const activeCollector = sessionTurnCollectors.get(sessionId);
    if (!activeCollector) return;
    if (activeCollector.timeout) {
      clearTimeout(activeCollector.timeout);
    }
    sessionTurnCollectors.delete(sessionId);
    activeCollector.reject(new Error(message));
  };

  const persistChatState = (managed: ManagedChatSession): void => {
    // Tombstoned sessions (deleted while async work was in flight) must not be
    // re-persisted — otherwise the file recreates after deleteSession removed it.
    if (managed.deleted) return;
    // When runtime has been torn down (null) but NOT intentionally invalidated,
    // fall back to the last persisted state so that provider session ids and
    // lastLaneDirectiveKey survive a transient teardown (e.g. app backgrounding).
    // When runtimeInvalidated is set, teardownRuntime() intentionally cleared
    // runtime state, so we must NOT restore stale values from disk.
    let prevPersisted: PersistedChatState | null = null;
    if (!managed.runtime && !managed.runtimeInvalidated) {
      try { prevPersisted = readPersistedState(managed.session.id); } catch { /* ignore */ }
    }
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
      ...(managed.session.opencodePermissionMode ? { opencodePermissionMode: managed.session.opencodePermissionMode } : {}),
      ...(managed.session.cursorModeSnapshot ? { cursorModeSnapshot: managed.session.cursorModeSnapshot } : {}),
      ...(managed.session.cursorModeId !== undefined ? { cursorModeId: managed.session.cursorModeId } : {}),
      ...(managed.session.cursorConfigValues ? { cursorConfigValues: managed.session.cursorConfigValues } : {}),
      ...(managed.session.permissionMode ? { permissionMode: managed.session.permissionMode } : {}),
      ...(managed.session.identityKey ? { identityKey: managed.session.identityKey } : {}),
      ...(managed.session.surface ? { surface: managed.session.surface } : {}),
      ...(managed.session.automationId ? { automationId: managed.session.automationId } : {}),
      ...(managed.session.automationRunId ? { automationRunId: managed.session.automationRunId } : {}),
      ...(managed.session.capabilityMode ? { capabilityMode: managed.session.capabilityMode } : {}),
      ...(managed.session.completion ? { completion: managed.session.completion } : {}),
      ...(managed.session.threadId ? { threadId: managed.session.threadId } : {}),
      ...(managed.runtime?.kind === "cursor" && managed.runtime.acpSessionId
        ? { acpSessionId: managed.runtime.acpSessionId }
        : {}),
      ...(managed.runtime?.kind === "claude"
        ? { sdkSessionId: managed.runtime.sdkSessionId ?? undefined }
        : prevPersisted?.sdkSessionId ? { sdkSessionId: prevPersisted.sdkSessionId } : {}),
      ...(managed.runtime?.kind === "claude" && managed.runtime.approvalOverrides.size > 0
        ? { approvalOverrides: [...managed.runtime.approvalOverrides] }
        : prevPersisted?.approvalOverrides?.length ? { approvalOverrides: prevPersisted.approvalOverrides } : {}),
      ...(managed.runtime?.kind === "opencode"
        ? { providerSessionId: managed.runtime.handle.sessionId }
        : prevPersisted?.providerSessionId ? { providerSessionId: prevPersisted.providerSessionId } : {}),
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
      ...(managed.lastLaneDirectiveKey
        ? { lastLaneDirectiveKey: managed.lastLaneDirectiveKey }
        : prevPersisted?.lastLaneDirectiveKey ? { lastLaneDirectiveKey: prevPersisted.lastLaneDirectiveKey } : {}),
      manuallyNamed: Boolean(managed.manuallyNamed)
        || (() => {
          const trimmedTitle = String(sessionService.get(managed.session.id)?.title || "").trim();
          return trimmedTitle.length > 0 && !DEFAULT_SESSION_TITLES.has(trimmedTitle);
        })(),
      ...(hasLivePendingInput(managed) ? { awaitingInput: true } : {}),
      ...(managed.session.requestedCwd != null && String(managed.session.requestedCwd).trim().length
        ? { requestedCwd: String(managed.session.requestedCwd).trim() }
        : {}),
      ...(managed.session.idleSinceAt !== undefined ? { idleSinceAt: managed.session.idleSinceAt ?? null } : {}),
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
      let provider = record.provider;
      if (provider === "unified") provider = "opencode";
      if (provider !== "codex" && provider !== "claude" && provider !== "opencode" && provider !== "cursor") {
        return null;
      }
      const laneId = String(record.laneId ?? "").trim();
      const model = String(record.model ?? "").trim();
      const storedModelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
      const modelId = storedModelId.length
        ? (getModelById(storedModelId) ?? resolveModelAlias(storedModelId))?.id
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
      const opencodePermissionMode = normalizePersistedOpenCodePermissionMode(record.opencodePermissionMode ?? (record as any).unifiedPermissionMode);
      const cursorModeSnapshot = record.cursorModeSnapshot && typeof record.cursorModeSnapshot === "object"
        ? record.cursorModeSnapshot as AgentChatCursorModeSnapshot
        : undefined;
      const cursorModeId = typeof record.cursorModeId === "string"
        ? (record.cursorModeId.trim() || null)
        : record.cursorModeId === null
          ? null
          : undefined;
      const cursorConfigValues = normalizeCursorConfigValueRecord(record.cursorConfigValues);
      const identityKey = normalizeIdentityKey(record.identityKey);
      const surface = record.surface === "automation" ? "automation" : "work";
      const capabilityMode = normalizeCapabilityMode(record.capabilityMode);
      const completion = normalizePersistedCompletion(record.completion);
      if (!laneId || !model) return null;
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
      const providerSessionId = typeof record.providerSessionId === "string" && record.providerSessionId.trim().length
        ? record.providerSessionId.trim()
        : undefined;
      const approvalOverrides = Array.isArray(record.approvalOverrides)
        ? record.approvalOverrides.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        : undefined;
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
        ...(opencodePermissionMode ? { opencodePermissionMode } : {}),
        ...(cursorModeSnapshot ? { cursorModeSnapshot } : {}),
        ...(cursorModeId !== undefined ? { cursorModeId } : {}),
        ...(cursorConfigValues ? { cursorConfigValues } : {}),
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
        ...(completion ? { completion } : {}),
        ...(typeof record.threadId === "string" && record.threadId.trim().length
          ? { threadId: record.threadId.trim() }
          : {}),
        ...(typeof record.acpSessionId === "string" && record.acpSessionId.trim().length
          ? { acpSessionId: record.acpSessionId.trim() }
          : {}),
        ...(sdkSessionId ? { sdkSessionId } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        ...(approvalOverrides?.length ? { approvalOverrides } : {}),
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
        ...(typeof record.lastLaneDirectiveKey === "string" && record.lastLaneDirectiveKey.trim().length
          ? { lastLaneDirectiveKey: record.lastLaneDirectiveKey.trim() }
          : {}),
        ...(record.manuallyNamed === true ? { manuallyNamed: true } : {}),
        ...(record.awaitingInput === true ? { awaitingInput: true } : {}),
        ...(typeof record.requestedCwd === "string" && record.requestedCwd.trim().length
          ? { requestedCwd: record.requestedCwd.trim() }
          : {}),
        ...(typeof record.idleSinceAt === "string"
          ? { idleSinceAt: record.idleSinceAt.trim() || null }
          : record.idleSinceAt === null
            ? { idleSinceAt: null }
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

  const setSessionActive = (managed: ManagedChatSession): void => {
    managed.session.status = "active";
    managed.session.idleSinceAt = null;
  };

  const setSessionIdle = (
    managed: ManagedChatSession,
    options?: { idleSinceAt?: string | null },
  ): void => {
    managed.session.status = "idle";
    if (options && "idleSinceAt" in options) {
      managed.session.idleSinceAt = options.idleSinceAt ?? null;
    }
  };

  const markSessionIdleWithFreshCache = (managed: ManagedChatSession): void => {
    setSessionIdle(managed, { idleSinceAt: nowIso() });
  };

  const setSessionEnded = (managed: ManagedChatSession): void => {
    managed.session.status = "ended";
    managed.session.idleSinceAt = null;
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
    }

    // Session summaries are generated only when the chat is explicitly ended in ADE,
    // so "done" events intentionally do not produce a summary here.

    const envelope: AgentChatEventEnvelope = {
      sessionId: managed.session.id,
      timestamp: nowIso(),
      event,
      sequence: ++managed.eventSequence,
    };

    writeTranscript(managed, envelope);
    recordChatEventInHistory(envelope);
    onEvent?.(envelope);
    for (const subscriber of eventSubscribers) {
      try {
        subscriber(envelope);
      } catch (error) {
        logger.warn("agent_chat.event_subscriber_failed", {
          sessionId: envelope.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
    if (collector.timeout) {
      clearTimeout(collector.timeout);
    }
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
    managed.lastActivityTimestamp = Date.now();
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

    if (normalizedEvent.type === "todo_update") {
      managed.todoItems = normalizedEvent.items;
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
    persistChatState(managed);
  };

  const emitPendingInputResolved = (
    managed: ManagedChatSession,
    args: {
      itemId: string;
      decision: AgentChatApprovalDecision;
      turnId?: string | null;
    },
  ): void => {
    const resolution: "cancelled" | "declined" | "accepted" = (() => {
      if (args.decision === "cancel") return "cancelled";
      if (args.decision === "decline") return "declined";
      return "accepted";
    })();
    emitChatEvent(managed, {
      type: "pending_input_resolved",
      itemId: args.itemId,
      resolution,
      ...(typeof args.turnId === "string" && args.turnId.trim().length ? { turnId: args.turnId.trim() } : {}),
    });
    persistChatState(managed);
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
      if (request?.questions.length === 1) {
        const [question] = request.questions;
        if (question && !normalized[question.id]?.length) {
          normalized[question.id] = [trimmedResponse];
        }
      } else {
        normalized["response"] = [trimmedResponse];
      }
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
    const previousExecutionLaneId = resolveManagedExecutionLaneId(managed);
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
    if (resolvedLaneId !== previousExecutionLaneId) {
      await refreshHeadShaStartForManagedExecutionLane(managed);
    }
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

  const setOpenCodeRuntimeBusy = (runtime: OpenCodeRuntime, busy: boolean): void => {
    runtime.busy = busy;
    runtime.handle.setBusy(busy);
    if (!busy) {
      runtime.handle.touch();
    }
  };

  /** Tear down the active runtime, releasing all resources and cancelling pending approvals. */
  const teardownRuntime = (
    managed: ManagedChatSession,
    openCodeReason: "handle_close" | "idle_ttl" | "ended_session" | "model_switch" | "project_close" | "budget_eviction" | "pool_compaction" | "paused_run" | "shutdown" = "handle_close",
  ): void => {
    flushBufferedReasoning(managed);
    flushBufferedText(managed);

    const reasonAllowsPreservation =
      openCodeReason === "idle_ttl"
      || openCodeReason === "budget_eviction"
      || openCodeReason === "pool_compaction"
      || openCodeReason === "paused_run"
      || openCodeReason === "project_close"
      || openCodeReason === "shutdown";

    // If a prior teardown (e.g., idle_ttl) already released the runtime:
    //  - Non-terminal reasons keep the prior teardown's preserved resume
    //    metadata on disk (bail).
    //  - Terminal reasons (handle_close, ended_session, model_switch) must
    //    still invalidate so a future resume can't reattach to a session
    //    the user actually closed.
    if (!managed.runtime) {
      if (!reasonAllowsPreservation) {
        managed.runtimeInvalidated = true;
        clearLaneDirectiveKey(managed);
      }
      return;
    }

    const preserveClaudeResumeState =
      managed.runtime.kind === "claude" && reasonAllowsPreservation;
    if (managed.runtime?.kind === "codex") {
      managed.runtime.suppressExitError = true;
      try { managed.runtime.reader.close(); } catch { /* ignore */ }
      managed.runtime.killTimer = terminateChildProcessTree(
        managed.runtime.process,
        managed.runtime.killTimer,
      );
      managed.runtime.pending.clear();
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "claude") {
      // Mark interrupted so the streaming catch block takes the graceful path
      managed.runtime.interrupted = true;
      if (preserveClaudeResumeState) {
        managed.runtime.sdkSessionId = managed.runtime.sdkSessionId ?? managed.runtime.v2Session?.sessionId ?? null;
        persistChatState(managed);
      }
      cancelClaudeWarmup(managed, managed.runtime, "teardown");
      try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
      managed.runtime.v2Session = null;
      managed.runtime.v2WarmupDone = null;
      managed.runtime.activeSubagents.clear();
      for (const pending of managed.runtime.approvals.values()) {
        pending.resolve({ decision: "cancel" });
      }
      managed.runtime.approvals.clear();
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "opencode") {
      // Mark interrupted so the streaming catch block takes the graceful path
      managed.runtime.interrupted = true;
      managed.runtime.eventAbortController?.abort();
      managed.runtime.handle.setBusy(false);
      for (const pending of managed.runtime.pendingApprovals.values()) {
        managed.runtime.handle.client.postSessionIdPermissionsPermissionId({
          path: { id: managed.runtime.handle.sessionId, permissionID: pending.permissionId },
          query: { directory: managed.runtime.handle.directory },
          body: { response: "reject" },
        }).catch(() => {});
      }
      managed.runtime.pendingApprovals.clear();
      managed.runtime.handle.setEvictionHandler(null);
      try { managed.runtime.handle.close(openCodeReason); } catch { /* ignore */ }
      managed.runtime = null;
    }
    if (managed.runtime?.kind === "cursor") {
      const rt = managed.runtime;
      if (rt.acpSessionId) {
        cursorAcpSessionOwners.delete(rt.acpSessionId);
        void rt.pooled?.connection.unstable_closeSession?.({ sessionId: rt.acpSessionId }).catch(() => {});
      }
      for (const [, w] of rt.permissionWaiters) {
        w.resolve({ outcome: { outcome: "cancelled" } });
      }
      rt.permissionWaiters.clear();
      if (rt.pooled) releaseCursorAcpConnection(rt.poolKey);
      managed.runtime = null;
    }
    managed.runtimeInvalidated = !preserveClaudeResumeState;
    if (!preserveClaudeResumeState) {
      clearLaneDirectiveKey(managed);
    }
  };

  const keepChatSessionOpen = (
    managed: ManagedChatSession,
    args: {
      message: string;
      turnId?: string | null;
      turnStatus?: "failed" | "interrupted";
    },
  ): void => {
    if (managed.closed) return;

    const resolvedTurnId = typeof args.turnId === "string" && args.turnId.trim().length
      ? args.turnId.trim()
      : null;

    for (const pending of managed.localPendingInputs.values()) {
      pending.resolve({ decision: "cancel" });
    }
    managed.localPendingInputs.clear();

    emitChatEvent(managed, {
      type: "error",
      message: args.message,
      ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    });

    if (resolvedTurnId && args.turnStatus) {
      emitChatEvent(managed, {
        type: "status",
        turnStatus: args.turnStatus,
        turnId: resolvedTurnId,
      });
      void emitTurnDiffSummaryIfChanged(managed, resolvedTurnId);
      emitChatEvent(managed, {
        type: "done",
        turnId: resolvedTurnId,
        status: args.turnStatus,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
      });
    }

    setSessionIdle(managed);
    teardownRuntime(managed, "handle_close");
    managed.closed = false;
    managed.endedNotified = false;
    sessionService.reopen(managed.session.id);
    persistChatState(managed);
  };

  const getSessionInactivityTimeoutMs = (managed: ManagedChatSession): number => {
    if (managed.runtime?.kind === "opencode") {
      return OPENCODE_SESSION_INACTIVITY_TIMEOUT_MS;
    }
    return SESSION_INACTIVITY_TIMEOUT_MS;
  };

  const maybeGenerateSessionSummary = async (
    managed: ManagedChatSession,
    deterministicSummary: string | null
  ): Promise<void> => {
    if (managed.deleted) return;
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
    const availableModels = await getAvailableRegistryModels(auth);
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
      const result = await runSessionIntelligencePrompt({
        cwd: managed.laneWorktreePath,
        modelId: descriptor.id,
        prompt,
        taskType: "session_summary",
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

    const endSha = await computeHeadShaBestEffort(resolveManagedExecutionLaneId(managed)).catch(() => null);
    if (endSha) {
      sessionService.setHeadShaEnd(managed.session.id, endSha);
    }

    setSessionEnded(managed);
    managed.closed = true;
    managed.ctoSessionStartedAt = null;
    persistChatState(managed);

    teardownRuntime(managed, "ended_session");

    try {
      onSessionEnded?.({ laneId: managed.session.laneId, sessionId: managed.session.id, exitCode: options?.exitCode ?? null });
    } catch {
      // ignore callback failures
    }

    managedSessions.delete(managed.session.id);
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
      ?? (provider === "opencode"
        ? DEFAULT_OPENCODE_MODEL_ID
        : provider === "cursor"
          ? DEFAULT_CURSOR_DESCRIPTOR?.id
          : undefined);
    const model = provider === "opencode" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
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
        ...(persisted?.opencodePermissionMode ? { opencodePermissionMode: persisted.opencodePermissionMode } : {}),
        ...(persisted?.cursorModeSnapshot ? { cursorModeSnapshot: persisted.cursorModeSnapshot } : {}),
        ...(persisted?.cursorModeId !== undefined ? { cursorModeId: persisted.cursorModeId } : {}),
        ...(persisted?.cursorConfigValues ? { cursorConfigValues: persisted.cursorConfigValues } : {}),
        ...(persisted?.permissionMode ? { permissionMode: persisted.permissionMode } : {}),
        ...(persisted?.identityKey ? { identityKey: persisted.identityKey } : {}),
        capabilityMode: persisted?.capabilityMode ?? inferCapabilityMode(provider),
        completion: persisted?.completion ?? null,
        status: mapTerminalStatusToChatStatus(row.status),
        idleSinceAt: persisted?.idleSinceAt ?? null,
        ...(persisted?.threadId ? { threadId: persisted.threadId } : {}),
        ...(persisted?.requestedCwd != null && String(persisted.requestedCwd).trim().length
          ? { requestedCwd: String(persisted.requestedCwd).trim() }
          : {}),
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
      deleted: false,
      ctoSessionStartedAt: row.status === "running" ? row.startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: hasCustomChatSessionTitle(row.title, provider) ? "initial" : "none",
      autoTitleInFlight: false,
      manuallyNamed: persisted?.manuallyNamed === true
        || (() => {
          const trimmedTitle = String(row.title || "").trim();
          return trimmedTitle.length > 0 && !DEFAULT_SESSION_TITLES.has(trimmedTitle);
        })(),
      summaryInFlight: false,
      continuitySummary: persisted?.continuitySummary ?? null,
      continuitySummaryUpdatedAt: persisted?.continuitySummaryUpdatedAt ?? null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: persisted?.preferredExecutionLaneId ?? null,
      selectedExecutionLaneId: persisted?.selectedExecutionLaneId ?? null,
      lastLaneDirectiveKey: persisted?.lastLaneDirectiveKey ?? null,
      runtimeInvalidated: false,
      todoItems: [],
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
      lastActivityTimestamp: Date.now(),
      turnBeforeSha: null,
    };
    managed.todoItems = readLatestTranscriptTodoItems(managed);
    normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
    managed.transcriptLimitReached = managed.transcriptBytesWritten >= MAX_CHAT_TRANSCRIPT_BYTES;
    refreshReconstructionContext(managed);

    managedSessions.set(sessionId, managed);
    return managed;
  };

  const emitPreparedUserMessage = (
    managed: ManagedChatSession,
    args: {
      text: string;
      attachments: AgentChatFileRef[];
      turnId?: string;
      laneDirectiveKey?: string | null;
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

  const persistDeliveredLaneDirectiveKey = (
    managed: ManagedChatSession,
    laneDirectiveKey?: string | null,
  ): void => {
    if (!laneDirectiveKey || managed.lastLaneDirectiveKey === laneDirectiveKey) return;
    managed.lastLaneDirectiveKey = laneDirectiveKey;
    persistChatState(managed);
  };

  const clearLaneDirectiveKey = (managed: ManagedChatSession): void => {
    managed.lastLaneDirectiveKey = null;
    persistChatState(managed);
  };

  const sendCodexMessage = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
      resolvedAttachments?: ResolvedAgentChatFileRef[];
      laneDirectiveKey?: string | null;
      providerSlashCommand?: boolean;
      forceClaudeUserMessage?: boolean;
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
    setSessionActive(managed);
    emitPreparedUserMessage(managed, {
      text: displayText,
      attachments,
      laneDirectiveKey: args.laneDirectiveKey,
      onDispatched: args.onDispatched,
    });
    emitChatEvent(managed, { type: "status", turnStatus: "started" });
    captureTurnBeforeSha(managed);
    emitChatEvent(managed, {
      type: "activity",
      ...initialTurnActivity(managed.session),
    });
    const providerSlashCommand = args.providerSlashCommand === true;
    const autoMemoryPlan = providerSlashCommand
      ? null
      : await buildAutoMemoryTurnPlan(managed, displayText, attachments);
    const autoMemoryNotice = autoMemoryPlan ? buildAutoMemorySystemNotice(autoMemoryPlan) : null;

    // Intercept /review command — route to review/start RPC instead of turn/start
    if (args.promptText.trim().startsWith("/review")) {
      runtime.awaitingTurnStart = true;
      let reviewResult: { turn?: { id?: string } };
      try {
        reviewResult = await runtime.request<{ turn?: { id?: string } }>("review/start", {
          threadId: managed.session.threadId,
          target: "uncommittedChanges",
        });
      } catch (error) {
        runtime.awaitingTurnStart = false;
        throw error;
      }
      persistDeliveredLaneDirectiveKey(managed, args.laneDirectiveKey);
      const reviewTurnId = typeof reviewResult.turn?.id === "string" ? reviewResult.turn.id : null;
      if (reviewTurnId) {
        runtime.awaitingTurnStart = false;
        runtime.activeTurnId = reviewTurnId;
      }
      return;
    }

    const input: Array<Record<string, unknown>> = [];

    const reconstructionContext = providerSlashCommand ? "" : managed.pendingReconstructionContext?.trim() ?? "";
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
    if (autoMemoryPlan?.contextText.length) {
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

    if (autoMemoryNotice) {
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "memory",
        message: autoMemoryNotice.message,
        detail: autoMemoryNotice.detail,
      });
    }

    await runtime.collaborationModesReady?.catch(() => {});
    const requestedCollaborationMode = resolveRequestedCodexCollaborationMode(managed.session);
    const collaborationMode = buildCodexCollaborationMode(
      managed.session,
      runtime.collaborationModes,
      managed.laneWorktreePath,
    );
    if (
      requestedCollaborationMode === "plan"
      && collaborationMode?.mode !== "plan"
      && !runtime.planModeFallbackNotified
    ) {
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "info",
        message: "Native Codex plan mode is unavailable for this session, so ADE is continuing in default collaboration mode.",
      });
      runtime.planModeFallbackNotified = true;
    } else if (collaborationMode?.mode === "plan") {
      runtime.planModeFallbackNotified = false;
    }
    managed.runtime.awaitingTurnStart = true;
    let result: { turn?: { id?: string } };
    try {
      result = await managed.runtime.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: managed.session.threadId,
        input,
        ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
      });
    } catch (error) {
      managed.runtime.awaitingTurnStart = false;
      throw error;
    }
    persistDeliveredLaneDirectiveKey(managed, args.laneDirectiveKey);

    const turnId = typeof result?.turn?.id === "string" ? result.turn.id : null;
    if (turnId) {
      managed.runtime.awaitingTurnStart = false;
      managed.runtime.activeTurnId = turnId;
      if (managed.runtime.startedTurnId !== turnId) {
        managed.runtime.startedTurnId = turnId;
        emitChatEvent(managed, {
          type: "status",
          turnStatus: "started",
          turnId,
        });
        captureTurnBeforeSha(managed);
        emitChatEvent(managed, {
          type: "activity",
          ...initialTurnActivity(managed.session),
          turnId,
        });
      }
    }
    persistChatState(managed);
  };

  // ── Helpers for OpenCode turn logic ──

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

  const classifyOpenCodeError = (
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

    if (isAbortRelatedError(error)) {
      return {
        message: "Session was interrupted.",
        errorInfo: { category: "unknown", provider: providerFamily, model: modelDisplayName },
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
      laneDirectiveKey?: string | null;
      providerSlashCommand?: boolean;
      forceClaudeUserMessage?: boolean;
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
    runtime.interruptEventsEmitted = false;
    runtime.resolvedToolUseIds.clear();
    setSessionActive(managed);

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
      laneDirectiveKey: args.laneDirectiveKey,
      onDispatched: args.onDispatched,
    });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });
    captureTurnBeforeSha(managed);
    emitChatEvent(managed, {
      type: "activity",
      ...initialTurnActivity(managed.session),
      turnId,
    });

    let assistantText = "";
    let usage: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null } | undefined;
    let costUsd: number | null = null;
    let reportedAssistantModel: string | null = null;
    let reportedInitModel: string | null = null;
    const reportedUsageModels = new Set<string>();
    const turnStartedAt = Date.now();
    let shouldDeliverQueuedSteer = false;
    let firstStreamEventLogged = false;
    const emittedClaudeToolIds = new Set<string>();
    const emittedSyntheticItemIds = new Set<string>();
    const streamedClaudeTextContentKeys = new Set<string>();
    const streamedClaudeThinkingContentKeys = new Set<string>();
    let currentClaudeStreamMessageId: string | null = null;
    // Track a running boundary for assistant messages whose snapshot has no id
    // (and whose stream preamble didn't carry a `message_start` id either — real
    // Claude streams always do, but mocks and older SDK paths don't). Each new
    // id-less assistant snapshot bumps the boundary so sequential assistants in
    // the same turn don't collide at the same content index.
    let claudeAssistantBoundary = 0;
    let claudeAssistantBoundarySealed = false;
    const claudeDedupeKey = (
      messageId: string | null | undefined,
      contentIndex: number | null | undefined,
    ): string | null => {
      if (typeof contentIndex !== "number" || !Number.isFinite(contentIndex)) return null;
      const trimmed = messageId?.trim();
      const id = trimmed && trimmed.length
        ? trimmed
        : `${turnId}:b${claudeAssistantBoundary}`;
      return `${id}:${contentIndex}`;
    };
    const openClaudeToolUses = new Map<string, { toolName: string }>();
    const toolInputJsonByContentIndex = new Map<number, string>();
    const toolUseMetaByContentIndex = new Map<number, { toolName: string; itemId: string }>();
    const emittedClaudeTodoIds = new Set<string>();
    const emitClaudeToolCompletion = (
      itemId: string,
      result: Record<string, unknown>,
      status: "completed" | "failed" | "interrupted",
    ): void => {
      const toolMeta = openClaudeToolUses.get(itemId);
      if (!toolMeta) return;
      openClaudeToolUses.delete(itemId);
      emitChatEvent(managed, {
        type: "tool_result",
        tool: toolMeta.toolName,
        result,
        itemId,
        turnId,
        status,
      });
    };
    const completeClaudeToolUsesFromSummary = (
      toolUseIds: string[],
      summaryText: string,
    ): void => {
      const cleanedSummary = summaryText.trim();
      for (const toolUseId of toolUseIds) {
        const normalizedToolUseId = toolUseId.trim();
        if (!normalizedToolUseId || !openClaudeToolUses.has(normalizedToolUseId)) continue;
        emitClaudeToolCompletion(normalizedToolUseId, {
          synthetic: true,
          source: "claude_tool_use_summary",
          summary: cleanedSummary || `Completed ${openClaudeToolUses.get(normalizedToolUseId)?.toolName ?? "tool"}.`,
        }, "completed");
      }
    };
    const flushOpenClaudeToolUses = (
      finalTurnStatus: "completed" | "failed" | "interrupted",
    ): void => {
      const remainingToolUses = [...openClaudeToolUses.entries()];
      for (const [itemId, toolMeta] of remainingToolUses) {
        // Skip tools already resolved by canUseTool (e.g. answered AskUserQuestion)
        // — their tool_result was emitted inline; don't double-emit a synthetic one.
        if (runtime.resolvedToolUseIds.has(itemId)) {
          openClaudeToolUses.delete(itemId);
          continue;
        }
        emitClaudeToolCompletion(itemId, {
          synthetic: true,
          source: "claude_turn_finalization",
          finalTurnStatus,
          summary: `Completed ${toolMeta.toolName} when the Claude turn ended.`,
        }, finalTurnStatus);
      }
    };
    const maybeEmitTodoUpdate = (toolName: string, input: unknown, itemId: string): void => {
      if (toolName !== "TodoWrite") return;
      if (emittedClaudeTodoIds.has(itemId)) return;
      const todoItems = normalizeClaudeTodoItems(input ?? {});
      if (!todoItems) return;
      emittedClaudeTodoIds.add(itemId);
      emitChatEvent(managed, { type: "todo_update", items: todoItems, turnId });
    };
    let timeoutError: Error | null = null;
    const buildDoneModelPayload = (): { model: string; modelId?: string } =>
      resolveClaudeTurnModelPayload(managed.session, [
        reportedAssistantModel,
        ...(reportedUsageModels.size === 1 ? [...reportedUsageModels] : []),
        reportedInitModel,
      ]);
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
    // Idle watchdog stubs — kept as no-ops so callers (approval flows,
    // elicitations, etc.) don't need to be touched.
    const clearClaudeTurnTimers = (): void => { /* no-op */ };
    const bumpClaudeIdleDeadline = (): void => { /* no-op */ };
    runtime.pauseIdleWatchdog = () => {};
    runtime.resumeIdleWatchdog = () => {};

    try {
      const providerSlashCommand = args.providerSlashCommand === true;
      const autoMemoryPrompt = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
      const autoMemoryPlan = providerSlashCommand
        ? null
        : await buildAutoMemoryTurnPlan(managed, autoMemoryPrompt, attachments);
      const autoMemoryNotice = autoMemoryPlan ? buildAutoMemorySystemNotice(autoMemoryPlan) : null;
      runtime.turnMemoryPolicyState = {
        classification: autoMemoryPlan?.classification ?? "none",
        orientationSatisfied: autoMemoryPlan?.telemetry.searched ?? true,
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

      const reconstructionContext = providerSlashCommand ? "" : managed.pendingReconstructionContext?.trim() ?? "";
      const basePromptText = providerSlashCommand
        ? args.promptText
        : [
            reconstructionContext.length
              ? [
                  "System context (identity reconstruction, do not echo verbatim):",
                  reconstructionContext,
                ].join("\n")
              : null,
            autoMemoryPlan?.contextText.length ? autoMemoryPlan.contextText : null,
            args.promptText,
          ].filter((section): section is string => Boolean(section)).join("\n\n");
      if (reconstructionContext.length) {
        managed.pendingReconstructionContext = null;
        persistChatState(managed);
      }
      // ── V2 persistent session with background pre-warming ──
      // The pre-warm was kicked off in ensureClaudeSessionRuntime. Wait for it.
      await waitForClaudeWarmup(managed, runtime, turnId);
      if (timeoutError) {
        throw timeoutError;
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
        sessionId: runtime.sdkSessionId,
        forceUserMessage: args.forceClaudeUserMessage,
      });
      const turnPermissionMode = resolveClaudeTurnPermissionMode(managed);

      const sessionControl = getClaudeV2SessionControl(runtime.v2Session);
      if (typeof sessionControl.setPermissionMode === "function") {
        try {
          await sessionControl.setPermissionMode(turnPermissionMode);
        } catch (permErr) {
          // Invalidate the V2 session so it is recreated with the correct
          // mode, then rethrow so the turn follows the normal failure path.
          logger.warn("agent_chat.v2_set_permission_mode_failed", {
            sessionId: managed.session.id,
            turnPermissionMode,
            error: String(permErr),
          });
          cancelClaudeWarmup(managed, runtime, "session_reset");
          try { runtime.v2Session?.close(); } catch { /* ignore */ }
          runtime.v2Session = null;
          runtime.v2WarmupDone = null;
          throw new Error(`Permission mode change to '${turnPermissionMode}' was rejected by the SDK. The session will be recreated on the next attempt.`);
        }
      } else if (turnPermissionMode === "plan") {
        throw new Error("Claude plan mode is not available in this Claude SDK build.");
      }

      // V2 pattern: send() then stream() per turn. Session stays alive between turns.
      bumpClaudeIdleDeadline();
      await runtime.v2Session.send(messageToSend);
      persistDeliveredLaneDirectiveKey(managed, args.laneDirectiveKey);

      // Don't emit a pre-emptive "thinking" activity — wait for actual content from the stream.
      // The renderer will show the turn as "started" (from the status event above) which is sufficient.

      for await (const msg of runtime.v2Session.stream()) {
        if (runtime.interrupted) break;
        if (timeoutError) {
          throw timeoutError;
        }
        bumpClaudeIdleDeadline();
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
          reportedInitModel = normalizeReportedModelName(initMsg.model) ?? reportedInitModel;
          if (Array.isArray(initMsg.slash_commands)) {
            applyClaudeSlashCommands(runtime, initMsg.slash_commands);
          }
          try {
            const control = getClaudeV2SessionControl(runtime.v2Session);
            if (typeof control.supportedCommands === "function") {
              control.supportedCommands().then((cmds: any[]) => {
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
            refreshReconstructionContext(managed);
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

        // system:local_command_output — output from local slash commands (/voice, /cost, etc.)
        if (msg.type === "system" && (msg as any).subtype === "local_command_output") {
          const cmdMsg = msg as any;
          const content = typeof cmdMsg.content === "string" ? cmdMsg.content.trim() : "";
          if (content.length > 0) {
            emitChatEvent(managed, {
              type: "text",
              text: content,
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
          const assistantMessageId = typeof betaMessage?.id === "string" ? betaMessage.id : null;
          // If the snapshot has no id, advance the id-less boundary once the
          // prior snapshot is sealed — so two back-to-back id-less assistants
          // don't alias to the same key. While the stream preamble is actively
          // filling in the current boundary (via content_block_delta), we keep
          // the boundary intact so the snapshot still dedupes against deltas.
          if (!assistantMessageId && !currentClaudeStreamMessageId && claudeAssistantBoundarySealed) {
            claudeAssistantBoundary += 1;
            claudeAssistantBoundarySealed = false;
          }
          reportedAssistantModel = normalizeReportedModelName(betaMessage?.model) ?? reportedAssistantModel;
          if (betaMessage?.content && Array.isArray(betaMessage.content)) {
            for (const [blockIndex, block] of betaMessage.content.entries()) {
              if (block.type === "text") {
                const textKey = claudeDedupeKey(assistantMessageId, blockIndex);
                if (!textKey || !streamedClaudeTextContentKeys.has(textKey)) {
                  assistantText += block.text ?? "";
                  emitChatEvent(managed, {
                    type: "text",
                    text: block.text ?? "",
                    turnId,
                  });
                  if (textKey) streamedClaudeTextContentKeys.add(textKey);
                }
              } else if (block.type === "thinking") {
                const thinkingText = block.thinking ?? block.text ?? "";
                const reasoningItemId = buildClaudeContentItemId("thinking", blockIndex);
                const thinkingKey = claudeDedupeKey(assistantMessageId, blockIndex);
                if (thinkingText.trim().length > 0 && (!thinkingKey || !streamedClaudeThinkingContentKeys.has(thinkingKey))) {
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
                  if (thinkingKey) streamedClaudeThinkingContentKeys.add(thinkingKey);
                }
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
                  openClaudeToolUses.set(itemId, { toolName });
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
                  maybeEmitTodoUpdate(toolName, block.input, itemId);
                  // Synthesize a tool_result for the proof observer since the
                  // Claude V2 SDK never surfaces tool results in the stream.
                  const syntheticResult = maybeSyntheticToolResult(toolName, block.input ?? {}, itemId, turnId);
                  if (syntheticResult && !emittedSyntheticItemIds.has(itemId)) {
                    emittedSyntheticItemIds.add(itemId);
                    emitChatEvent(managed, syntheticResult);
                  }
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
          // Snapshot consumed — the next id-less assistant should get a fresh
          // boundary so it doesn't collide on the same turn-scoped key.
          claudeAssistantBoundarySealed = true;
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
                const textKey = claudeDedupeKey(currentClaudeStreamMessageId, contentIndex);
                if (textKey) streamedClaudeTextContentKeys.add(textKey);
                assistantText += text;
                emitChatEvent(managed, { type: "text", text, turnId });
              }
            } else if (delta?.type === "thinking_delta") {
              const text = delta.thinking ?? delta.text ?? "";
              if (text.length) {
                const thinkingKey = claudeDedupeKey(currentClaudeStreamMessageId, contentIndex);
                if (thinkingKey) streamedClaudeThinkingContentKeys.add(thinkingKey);
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
              const idx =
                typeof event.index === "number"
                  ? event.index
                  : typeof contentIndex === "number"
                    ? contentIndex
                    : null;
              const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
              if (idx != null && partial.length) {
                const prev = toolInputJsonByContentIndex.get(idx) ?? "";
                toolInputJsonByContentIndex.set(idx, prev + partial);
              }
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
                const thinkingKey = claudeDedupeKey(currentClaudeStreamMessageId, contentIndex);
                if (thinkingKey) streamedClaudeThinkingContentKeys.add(thinkingKey);
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
                openClaudeToolUses.set(itemId, { toolName });
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
                const todoItems = toolName === "TodoWrite" ? normalizeClaudeTodoItems(block.input ?? {}) : null;
                if (todoItems && !emittedClaudeTodoIds.has(itemId)) {
                  emittedClaudeTodoIds.add(itemId);
                  emitChatEvent(managed, {
                    type: "todo_update",
                    items: todoItems,
                    turnId,
                  });
                }
                if (typeof contentIndex === "number") {
                  const initial =
                    block.input != null && typeof block.input === "object" && Object.keys(block.input as object).length
                      ? JSON.stringify(block.input)
                      : "";
                  toolInputJsonByContentIndex.set(contentIndex, initial);
                  toolUseMetaByContentIndex.set(contentIndex, { toolName, itemId });
                }
              }
            }
          } else if (event.type === "content_block_stop") {
            const stopIndex = typeof event.index === "number" ? event.index : contentIndex;
            if (typeof stopIndex === "number") {
              const meta = toolUseMetaByContentIndex.get(stopIndex);
              if (meta) {
                toolUseMetaByContentIndex.delete(stopIndex);
                const raw = toolInputJsonByContentIndex.get(stopIndex) ?? "";
                toolInputJsonByContentIndex.delete(stopIndex);
                let parsed: unknown = {};
                if (raw.trim().length) {
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    parsed = {};
                  }
                }
                const syntheticResult = maybeSyntheticToolResult(meta.toolName, parsed, meta.itemId, turnId);
                if (syntheticResult && !emittedSyntheticItemIds.has(meta.itemId)) {
                  emittedSyntheticItemIds.add(meta.itemId);
                  emitChatEvent(managed, syntheticResult);
                }
              }
            }
          } else if (event.type === "message_start") {
            currentClaudeStreamMessageId = typeof event.message?.id === "string" ? event.message.id : null;
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
          for (const modelName of extractReportedModelUsageNames(resultMsg.modelUsage)) {
            reportedUsageModels.add(modelName);
          }
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
          if (Array.isArray(resultMsg.permission_denials) && resultMsg.permission_denials.length > 0) {
            const denials = resultMsg.permission_denials as Array<{ tool_name: string; tool_use_id?: string }>;
            const denialSummary = denials.map((d) => d.tool_name).join(", ");
            emitChatEvent(managed, {
              type: "system_notice",
              noticeKind: "info",
              message: `${denials.length} tool call${denials.length === 1 ? " was" : "s were"} denied this turn: ${denialSummary}`,
              turnId,
            });
            for (const denial of denials) {
              if (denial.tool_use_id && openClaudeToolUses.has(denial.tool_use_id)) {
                emitClaudeToolCompletion(denial.tool_use_id, {
                  synthetic: true,
                  source: "permission_denied",
                  tool: denial.tool_name,
                }, "failed");
              }
            }
          }
          continue;
        }

        // tool_use_summary — summarizes groups of tool calls
        if ((msg as any).type === "tool_use_summary") {
          const summaryMsg = msg as any;
          const toolUseIds = Array.isArray(summaryMsg.preceding_tool_use_ids) ? summaryMsg.preceding_tool_use_ids.map(String) : [];
          completeClaudeToolUsesFromSummary(toolUseIds, String(summaryMsg.summary ?? ""));
          emitChatEvent(managed, {
            type: "tool_use_summary",
            summary: String(summaryMsg.summary ?? ""),
            toolUseIds,
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
      if (timeoutError) {
        throw timeoutError;
      }

      // ── Turn completion ──
      clearClaudeTurnTimers();
      runtime.pauseIdleWatchdog = null;
      runtime.resumeIdleWatchdog = null;
      flushOpenClaudeToolUses(runtime.interrupted ? "interrupted" : "completed");
      // Note: v2Session is NOT closed here — it stays alive for the next turn
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.turnMemoryPolicyState = null;
      markSessionIdleWithFreshCache(managed);
      reportProviderRuntimeReady("claude");

      // Flush deferred session reset from mid-turn reasoning effort change
      if (runtime.pendingSessionReset) {
        runtime.pendingSessionReset = false;
        cancelClaudeWarmup(managed, runtime, "session_reset");
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
        runtime.v2WarmupDone = null;
      }

      const doneModel = buildDoneModelPayload();
      const finalStatus = runtime.interrupted ? "interrupted" : "completed";
      if (!runtime.interruptEventsEmitted) {
        emitChatEvent(managed, { type: "status", turnStatus: finalStatus, turnId });
        void emitTurnDiffSummaryIfChanged(managed, turnId);
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: finalStatus,
          ...doneModel,
          ...(usage ? { usage } : {}),
          ...(costUsd != null ? { costUsd } : {}),
        });
      } else {
        void emitTurnDiffSummaryIfChanged(managed, turnId);
      }

      if (assistantText.trim().length > 0) {
        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: assistantText,
        });
      }

      const endSha = await computeHeadShaBestEffort(resolveManagedExecutionLaneId(managed)).catch(() => null);
      if (endSha) {
        sessionService.setHeadShaEnd(managed.session.id, endSha);
      }

      persistChatState(managed);

      // Process queued steers (skip if session was disposed during execution)
      if (runtime.pendingSteers.length) {
        await deliverNextQueuedSteer(managed, runtime);
      }
    } catch (error) {
      clearClaudeTurnTimers();
      runtime.pauseIdleWatchdog = null;
      runtime.resumeIdleWatchdog = null;
      runtime.busy = false;
      runtime.activeTurnId = null;
      runtime.turnMemoryPolicyState = null;
      const effectiveError = timeoutError ?? error;
      const finalToolStatus: "completed" | "failed" | "interrupted" =
        runtime.interrupted || isAbortRelatedError(effectiveError)
          ? "interrupted"
          : "failed";
      flushOpenClaudeToolUses(finalToolStatus);

      // Only close V2 session on genuine errors. User interrupts close and
      // clear the session immediately in interrupt() so the next turn cannot
      // consume buffered events from the abandoned stream.
      if (!runtime.interrupted) {
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
        runtime.v2WarmupDone = null;
      }
      const doneModel = buildDoneModelPayload();
      void emitTurnDiffSummaryIfChanged(managed, turnId);

      if (runtime.interrupted) {
        markSessionIdleWithFreshCache(managed);
        if (!runtime.interruptEventsEmitted) {
          emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
          emitChatEvent(managed, {
            type: "done",
            turnId,
            status: "interrupted",
            ...doneModel,
          });
        }
      } else if (timeoutError) {
        markSessionIdleWithFreshCache(managed);
        const errorMessage = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
        reportProviderRuntimeFailure("claude", errorMessage);
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
          ...doneModel,
        });

        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: `Turn failed: ${errorMessage}`,
        });
      } else if (isAbortRelatedError(effectiveError)) {
        // System-triggered abort (dispose/teardown) that wasn't flagged as interrupted.
        // Treat as interruption to avoid surfacing raw SDK messages like "aborted by user".
        markSessionIdleWithFreshCache(managed);
        if (!runtime.interruptEventsEmitted) {
          emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
          emitChatEvent(managed, {
            type: "done",
            turnId,
            status: "interrupted",
            ...doneModel,
          });
        }
      } else {
        markSessionIdleWithFreshCache(managed);
        const isAuthFailure = isClaudeRuntimeAuthError(effectiveError);
        const errorMessage = isAuthFailure
          ? CLAUDE_RUNTIME_AUTH_ERROR
          : (effectiveError instanceof Error ? effectiveError.message : String(effectiveError));
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
          ...doneModel,
        });

        appendWorkerActivityToCto(managed, {
          activityType: "chat_turn",
          summary: `Turn failed: ${errorMessage}`,
        });

        // If resume failed, clear sessionId and the caller can retry fresh
        const isStaleSessionError = (err: unknown): boolean => {
          const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
          return msg.includes("session not found") || msg.includes("invalid session") || msg.includes("stale session") || msg.includes("session expired");
        };
        if (runtime.sdkSessionId && isStaleSessionError(effectiveError)) {
          logger.warn("agent_chat.claude_sdk_session_error", {
            sessionId: managed.session.id,
            sdkSessionId: runtime.sdkSessionId,
            error: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
          });
          runtime.sdkSessionId = null;
          managed.runtimeInvalidated = true;
          clearLaneDirectiveKey(managed);
          void maybeRefreshIdentityContinuitySummary(managed, "provider_reset");
          refreshReconstructionContext(managed);
          prewarmClaudeV2Session(managed);
        }
      }

      persistChatState(managed);
      cancelQueuedSteers(managed, runtime, runtime.interrupted ? "interrupted" : "failed");
      return;
    }
  };

  // ── Streaming turn for OpenCode runtime ──

  const runTurn = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText?: string;
      attachments?: AgentChatFileRef[];
      resolvedAttachments?: ResolvedAgentChatFileRef[];
      laneDirectiveKey?: string | null;
      providerSlashCommand?: boolean;
      forceClaudeUserMessage?: boolean;
      onDispatched?: () => void;
    },
  ): Promise<void> => {
    const runtimeKind = managed.runtime?.kind;
    if (runtimeKind === "claude") {
      return runClaudeTurn(managed, args);
    }
    if (runtimeKind !== "opencode") {
      throw new Error(`Streaming runtime is not available for session '${managed.session.id}'.`);
    }

    const runtime = managed.runtime as OpenCodeRuntime;
    const validation = validateSessionReadyForTurn(managed);
    if (!validation.ready) {
      logger.warn("agent_chat.turn_not_ready", { sessionId: managed.session.id, reason: validation.reason });
      throw new Error(validation.reason);
    }
    const turnId = randomUUID();
    setOpenCodeRuntimeBusy(runtime, true);
    runtime.activeTurnId = turnId;
    runtime.interrupted = false;
    setSessionActive(managed);
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
      laneDirectiveKey: args.laneDirectiveKey,
      onDispatched: args.onDispatched,
    });
    emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });
    captureTurnBeforeSha(managed);
    emitChatEvent(managed, {
      type: "activity",
      ...initialTurnActivity(managed.session),
      turnId,
    });

    let assistantText = "";
    let usage: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheCreationTokens?: number | null;
    } | undefined;
    let finalAssistantText = "";
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

    try {
      const providerSlashCommand = args.providerSlashCommand === true;
      const autoMemoryPrompt = args.displayText?.trim().length ? args.displayText.trim() : args.promptText;
      const autoMemoryPlan = providerSlashCommand
        ? null
        : await buildAutoMemoryTurnPlan(managed, autoMemoryPrompt, attachments);
      const autoMemoryNotice = autoMemoryPlan ? buildAutoMemorySystemNotice(autoMemoryPlan) : null;
      const turnMemoryPolicyState: TurnMemoryPolicyState | undefined = memoryService && projectId
        ? {
            classification: autoMemoryPlan?.classification ?? "none",
            orientationSatisfied: autoMemoryPlan?.telemetry.searched ?? true,
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
      const userContent = providerSlashCommand
        ? args.promptText
        : [
            managed.pendingReconstructionContext?.trim().length
              ? "System context (ADE continuity, do not echo verbatim):\n" + managed.pendingReconstructionContext.trim()
              : null,
            autoMemoryPlan?.contextText.length ? autoMemoryPlan.contextText : null,
            `${args.promptText}${attachmentHint}`,
          ].filter((section): section is string => Boolean(section)).join("\n\n");

      if (!providerSlashCommand) managed.pendingReconstructionContext = null;

      const abortController = new AbortController();
      runtime.eventAbortController = abortController;
      runtime.textByPartId.clear();
      runtime.reasoningByPartId.clear();
      runtime.toolStateByPartId.clear();

      const toPromptFiles = resolvedAttachments
        .map((attachment) => ({
          path: attachment._resolvedPath,
          mime: inferAttachmentMediaType(attachment),
          filename: path.basename(attachment._resolvedPath),
        }))
        .filter((entry) => fs.existsSync(entry.path));
      const toolSelection = await refreshOpenCodeSessionToolSelection(runtime.handle);

      const promptAccepted = runtime.handle.client.session.promptAsync({
        path: { id: runtime.handle.sessionId },
        query: { directory: runtime.handle.directory },
        body: {
          agent: mapPermissionModeToOpenCodeAgent(runtime.permissionMode),
          model: resolveOpenCodeModelSelection(runtime.modelDescriptor),
          ...(toolSelection ? { tools: toolSelection } : {}),
          parts: buildOpenCodePromptParts({
            prompt: userContent,
            files: toPromptFiles,
          }),
        },
      });

      const eventStream = await openCodeEventStream({
        client: runtime.handle.client,
        directory: runtime.handle.directory,
        signal: abortController.signal,
      });

      await promptAccepted;
      if (args.onDispatched) {
        args.onDispatched();
      }

      let stepNumber = 0;
      for await (const event of eventStream) {
        const resolveSessionId = (): string | null => {
          switch (event.type) {
            case "message.updated":
            case "session.created":
            case "session.updated":
            case "session.deleted":
              return event.properties.info.id;
            case "message.part.updated":
              return event.properties.part.sessionID;
            case "message.part.removed":
              return event.properties.sessionID;
            case "permission.updated":
              return event.properties.sessionID;
            case "permission.replied":
              return event.properties.sessionID;
            case "session.status":
            case "session.idle":
            case "todo.updated":
            case "session.diff":
              return event.properties.sessionID;
            case "session.error":
              return event.properties.sessionID ?? null;
            case "command.executed":
              return event.properties.sessionID;
            case "session.compacted":
              return event.properties.sessionID;
            default:
              return null;
          }
        };

        if (resolveSessionId() !== runtime.handle.sessionId) {
          continue;
        }

        if (event.type === "session.compacted") {
          emitChatEvent(managed, {
            type: "context_compact",
            trigger: "auto",
            turnId,
          });
          continue;
        }

        if (event.type === "message.part.updated") {
          const { part, delta } = event.properties;
          markFirstStreamEvent(part.type);

          if (part.type === "step-start") {
            stepNumber += 1;
            emitChatEvent(managed, {
              type: "step_boundary",
              stepNumber,
              turnId,
            });
            emitChatEvent(managed, {
              type: "activity",
              activity: runtime.modelDescriptor.capabilities.reasoning ? "thinking" : "working",
              detail: runtime.modelDescriptor.capabilities.reasoning ? REASONING_ACTIVITY_DETAIL : WORKING_ACTIVITY_DETAIL,
              turnId,
            });
            continue;
          }

          if (part.type === "step-finish") {
            usage = {
              inputTokens: part.tokens.input,
              outputTokens: part.tokens.output,
              cacheReadTokens: part.tokens.cache.read,
              cacheCreationTokens: part.tokens.cache.write,
            };
            continue;
          }

          if (part.type === "text") {
            // Skip synthetic/ignored prompt parts (e.g. ADE launch directives
            // injected as system context) — they should not be rendered in chat.
            if ((part as { synthetic?: boolean }).synthetic || (part as { ignored?: boolean }).ignored) {
              continue;
            }
            const previous = runtime.textByPartId.get(part.id) ?? "";
            const nextText = part.text;
            const nextDelta = typeof delta === "string"
              ? delta
              : nextText.startsWith(previous)
                ? nextText.slice(previous.length)
                : nextText;
            runtime.textByPartId.set(part.id, nextText);
            if (nextDelta.length) {
              finalAssistantText += nextDelta;
              emitChatEvent(managed, {
                type: "text",
                text: nextDelta,
                turnId,
                itemId: part.id,
              });
            }
            continue;
          }

          if (part.type === "reasoning") {
            const previous = runtime.reasoningByPartId.get(part.id) ?? "";
            const nextText = part.text;
            const nextDelta = typeof delta === "string"
              ? delta
              : nextText.startsWith(previous)
                ? nextText.slice(previous.length)
                : nextText;
            runtime.reasoningByPartId.set(part.id, nextText);
            if (nextDelta.length) {
              emitChatEvent(managed, {
                type: "activity",
                activity: "thinking",
                detail: REASONING_ACTIVITY_DETAIL,
                turnId,
              });
              emitChatEvent(managed, {
                type: "reasoning",
                text: nextDelta,
                turnId,
                itemId: part.id,
              });
            }
            continue;
          }

          if (part.type === "tool") {
            const previousStatus = runtime.toolStateByPartId.get(part.id) ?? null;
            const nextStatus = part.state.status;
            runtime.toolStateByPartId.set(part.id, nextStatus);
            const itemId = part.callID || part.id;
            const toolMetadata = {
              partId: part.id,
            };

            if (!previousStatus) {
              const nextActivity = activityForToolName(part.tool);
              emitChatEvent(managed, {
                type: "activity",
                activity: nextActivity.activity,
                detail: nextActivity.detail,
                turnId,
              });
              emitChatEvent(managed, {
                type: "tool_call",
                tool: part.tool,
                args: part.state.input,
                itemId,
                logicalItemId: part.id,
                turnId,
              });
            }

            if (nextStatus === "completed" && previousStatus !== "completed") {
              emitChatEvent(managed, {
                type: "tool_result",
                tool: part.tool,
                result: {
                  ...toolMetadata,
                  output: part.state.output,
                  metadata: part.state.metadata ?? part.metadata ?? {},
                  attachments: part.state.attachments,
                },
                itemId,
                logicalItemId: part.id,
                turnId,
                status: "completed",
              });
            } else if (nextStatus === "error" && previousStatus !== "error") {
              emitChatEvent(managed, {
                type: "tool_result",
                tool: part.tool,
                result: {
                  ...toolMetadata,
                  error: part.state.error,
                  metadata: part.state.metadata ?? part.metadata ?? {},
                },
                itemId,
                logicalItemId: part.id,
                turnId,
                status: "failed",
              });
              emitChatEvent(managed, {
                type: "error",
                message: `Tool '${part.tool}' failed: ${part.state.error}`,
                itemId,
                turnId,
              });
            }
            continue;
          }

          if (part.type === "patch") {
            for (const file of part.files) {
              emitChatEvent(managed, {
                type: "file_change",
                path: file,
                diff: `OpenCode updated ${file}`,
                kind: "modify",
                itemId: `${part.id}:${file}`,
                logicalItemId: part.id,
                turnId,
                status: "completed",
              });
            }
            continue;
          }

          if (part.type === "subtask") {
            emitChatEvent(managed, {
              type: "subagent_started",
              taskId: part.id,
              description: part.description,
              turnId,
            });
            continue;
          }

          continue;
        }

        if (event.type === "permission.updated") {
          const permission = event.properties;
          const normalizedType = permission.type.trim().toLowerCase();
          const description = permission.title.trim() || normalizedType || "Approval required";
          const category: PendingOpenCodeApproval["category"] = normalizedType.includes("bash")
            || normalizedType.includes("command")
            || description.toLowerCase().includes("command")
            || description.toLowerCase().includes("bash")
            ? "bash"
            : "write";
          const request: PendingInputRequest = {
            requestId: permission.id,
            itemId: permission.id,
            source: "opencode",
            kind: "approval",
            description,
            questions: [],
            allowsFreeform: false,
            blocking: true,
            canProceedWithoutAnswer: false,
            providerMetadata: {
              type: permission.type,
              metadata: permission.metadata,
              callId: permission.callID ?? null,
            },
            turnId,
          };
          runtime.pendingApprovals.set(permission.id, {
            category,
            permissionId: permission.id,
            request,
          });
          emitPendingInputRequest(managed, request, {
            kind: category === "bash" ? "command" : "file_change",
            description,
            detail: permission.metadata,
          });
          continue;
        }

        if (event.type === "permission.replied") {
          const pending = runtime.pendingApprovals.get(event.properties.permissionID);
          if (!pending) continue;
          runtime.pendingApprovals.delete(event.properties.permissionID);
          emitPendingInputResolved(managed, {
            itemId: event.properties.permissionID,
            decision: event.properties.response === "reject"
              ? "decline"
              : "accept",
            turnId: pending.request?.turnId ?? null,
          });
          continue;
        }

        if (event.type === "todo.updated") {
          emitChatEvent(managed, {
            type: "todo_update",
            items: event.properties.todos
              .map((todo: { id: string; content: string; status: string }) => ({
                id: todo.id,
                description: todo.content,
                status: todo.status === "completed"
                  ? "completed"
                  : todo.status === "in_progress"
                    ? "in_progress"
                    : "pending",
              })),
            turnId,
          });
          continue;
        }

        if (event.type === "command.executed") {
          emitChatEvent(managed, {
            type: "activity",
            activity: "running_command",
            detail: `${event.properties.name} ${event.properties.arguments}`.trim(),
            turnId,
          });
          continue;
        }

        if (event.type === "session.error") {
          throw new Error(String(event.properties.error?.data?.message ?? "OpenCode session failed."));
        }

        if (event.type === "session.idle") {
          break;
        }
      }

      // ── Shared turn completion ──
      persistDeliveredLaneDirectiveKey(managed, args.laneDirectiveKey);
      void emitTurnDiffSummaryIfChanged(managed, turnId);
      if (runtime.interrupted) {
        setOpenCodeRuntimeBusy(runtime, false);
        runtime.activeTurnId = null;
        runtime.eventAbortController = null;
        markSessionIdleWithFreshCache(managed);
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
        persistChatState(managed);
      } else {
        setOpenCodeRuntimeBusy(runtime, false);
        runtime.activeTurnId = null;
        runtime.eventAbortController = null;
        markSessionIdleWithFreshCache(managed);

        emitChatEvent(managed, { type: "status", turnStatus: "completed", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "completed",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
          ...(usage ? { usage } : {})
        });

        if (finalAssistantText.trim().length > 0) {
          appendWorkerActivityToCto(managed, {
            activityType: "chat_turn",
            summary: finalAssistantText,
          });
        }

        const endSha = await computeHeadShaBestEffort(resolveManagedExecutionLaneId(managed)).catch(() => null);
        if (endSha) {
          sessionService.setHeadShaEnd(managed.session.id, endSha);
        }

        persistChatState(managed);

        // Process queued steers (skip if session was disposed during execution)
        if (runtime.pendingSteers.length) {
          await deliverNextQueuedSteer(managed, runtime);
        }
      }
    } catch (error) {
      setOpenCodeRuntimeBusy(runtime, false);
      runtime.activeTurnId = null;
      runtime.eventAbortController = null;
      void emitTurnDiffSummaryIfChanged(managed, turnId);

      if (runtime.interrupted) {
        markSessionIdleWithFreshCache(managed);
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      } else if (isAbortRelatedError(error)) {
        // System-triggered abort (dispose/teardown) that wasn't flagged as interrupted.
        markSessionIdleWithFreshCache(managed);
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        emitChatEvent(managed, {
          type: "done",
          turnId,
          status: "interrupted",
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        });
      } else {
        markSessionIdleWithFreshCache(managed);

        const { message: errorMessage, errorInfo } = classifyOpenCodeError(
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
      cancelQueuedSteers(managed, runtime, runtime.interrupted ? "interrupted" : "failed");
      return;
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
      // Auto-allow the ADE `ask_user` tool so the inline question card surfaces
      // immediately instead of being shadowed by a generic "Allow additional
      // permissions?" prompt. Gated by `ai.chat.autoAllowAskUser` (default: true).
      if (isAutoAllowAskUserEnabled()) {
        const permRecord = params.permissions && typeof params.permissions === "object"
          ? params.permissions as Record<string, unknown>
          : null;
        const rawTool = permRecord?.tool ?? permRecord?.toolName;
        const permTool = typeof rawTool === "string" ? rawTool : null;
        if (isAskUserToolName(permTool) || isAskUserToolName(description)) {
          runtime.sendResponse(id, {
            permissions: params.permissions ?? {},
            scope: "turn",
          });
          return;
        }
      }
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
          multiSelect?: boolean;
          options?: Array<{ label?: string; description?: string; preview?: string; previewFormat?: "markdown" | "html" }> | null;
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
                  const preview = typeof option?.preview === "string" ? option.preview : "";
                  return [{
                    label,
                    value: label,
                    ...(description ? { description } : {}),
                    ...(preview.trim().length ? { preview, ...(option?.previewFormat ? { previewFormat: option.previewFormat } : {}) } : {}),
                  }];
                })
              : [];
            return [{
              id: questionId,
              header: typeof question?.header === "string" && question.header.trim().length ? question.header.trim() : `Question ${index + 1}`,
              question: questionText,
              ...(question?.multiSelect === true ? { multiSelect: true } : {}),
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
      runtime.approvals.set(itemId, {
        requestId: id,
        kind: "structured_question",
        request,
        questionResponseKind: "native_request_user_input",
      });
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: request.description ?? "Codex requested input",
      });
      return;
    }

    runtime.sendError(id, `Unsupported server request: ${method || "unknown"}`);
  };

  const parseCodexPlanPayload = (
    value: unknown,
  ): { steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" | "failed" }>; explanation: string | null } | null => {
    const record = (() => {
      if (typeof value !== "string") return asRecord(value);
      try {
        return asRecord(JSON.parse(value));
      } catch {
        return null;
      }
    })();
    if (!record) return null;

    const rawPlan = Array.isArray(record.plan)
      ? record.plan
      : Array.isArray(record.steps)
        ? record.steps
        : null;
    if (!rawPlan) return null;

    const steps = rawPlan
      .map((step) => {
        const entry = asRecord(step);
        if (!entry) return null;
        const text = typeof entry.step === "string"
          ? entry.step
          : typeof entry.text === "string"
            ? entry.text
            : typeof entry.description === "string"
              ? entry.description
              : "";
        const normalizedText = text.trim();
        if (!normalizedText.length) return null;
        const rawStatus = typeof entry.status === "string" ? entry.status : "pending";
        return {
          text: normalizedText,
          status: PLAN_STEP_STATUS_MAP[rawStatus] ?? "pending",
        };
      })
      .filter((entry): entry is { text: string; status: "pending" | "in_progress" | "completed" | "failed" } => entry != null);

    if (!steps.length) return null;

    return {
      steps,
      explanation: typeof record.explanation === "string" && record.explanation.trim().length
        ? record.explanation
        : null,
    };
  };

  const emitCodexPlanUpdate = (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    payload: unknown,
    turnId: string | undefined,
  ): boolean => {
    const normalized = parseCodexPlanPayload(payload);
    if (!normalized) return false;

    emitChatEvent(managed, {
      type: "plan",
      steps: normalized.steps,
      ...(turnId ? { turnId } : {}),
      explanation: normalized.explanation,
    });

    if (managed.session.permissionMode !== "plan") {
      return true;
    }

    const allPending = normalized.steps.every((step) => step.status === "pending");
    if (!allPending) {
      return true;
    }

    const planSummary = normalized.steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n");
    const hasExistingApproval = [...runtime.approvals.values()].some((pending) =>
      pending.kind === "plan_approval"
      && (
        (turnId && (pending.request?.turnId ?? null) === turnId)
        || pending.request?.description === planSummary
      ),
    );
    if (hasExistingApproval) {
      return true;
    }

    const planApprovalItemId = randomUUID();
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
      turnId: turnId ?? runtime.activeTurnId ?? null,
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
    return true;
  };

  const stopActiveCodexSubagents = (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    turnId: string | undefined,
    summary: string,
  ): void => {
    if (runtime.activeSubagents.size === 0) return;
    for (const { taskId } of runtime.activeSubagents.values()) {
      emitChatEvent(managed, {
        type: "subagent_result",
        taskId,
        status: "stopped",
        summary,
        turnId,
      });
    }
    runtime.activeSubagents.clear();
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
    const explicitTurnId = turnIdHint ?? extractCodexTurnId(item);
    const trackedTurnId = runtime.itemTurnIdByItemId.get(itemId) ?? null;
    if (isInterruptedCodexTurn(runtime, explicitTurnId ?? trackedTurnId)) {
      return;
    }
    const turnId = (() => {
      if (eventKind === "started") {
        const startedTurnId = explicitTurnId ?? runtime.activeTurnId ?? undefined;
        if (startedTurnId) {
          runtime.itemTurnIdByItemId.set(itemId, startedTurnId);
          evictOldestEntries(runtime.itemTurnIdByItemId, MAX_SESSION_MAP_ENTRIES);
        }
        return startedTurnId;
      }
      const completedTurnId = explicitTurnId ?? runtime.itemTurnIdByItemId.get(itemId) ?? runtime.activeTurnId ?? undefined;
      runtime.itemTurnIdByItemId.delete(itemId);
      return completedTurnId;
    })();

    if (itemType === "contextCompaction") {
      // Codex emits contextCompaction via item/started + item/completed.
      // Emit the boundary event once, on completion, so the UI badge matches
      // Claude's post-compaction behavior.
      if (eventKind === "completed") {
        emitChatEvent(managed, {
          type: "context_compact",
          trigger: "auto",
          turnId,
        });
      }
      return;
    }

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
      evictOldestEntries(runtime.commandOutputByItemId, MAX_SESSION_MAP_ENTRIES);
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
      evictOldestEntries(runtime.fileChangesByItemId, MAX_SESSION_MAP_ENTRIES);
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

    if (itemType === "toolCall") {
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
        runtime.activeSubagents.set(itemId, {
          taskId: itemId,
          description: String(item.description ?? item.title ?? "Delegated task"),
          background: isBackgroundTask(item as Record<string, unknown>),
        });
        emitChatEvent(managed, {
          type: "subagent_started",
          taskId: itemId,
          description: String(item.description ?? item.title ?? "Delegated task"),
          background: isBackgroundTask(item as Record<string, unknown>),
          turnId,
        });
      }
      if (eventKind === "completed") {
        runtime.activeSubagents.delete(itemId);
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
        const taskId = newThreadId ?? itemId;
        runtime.activeSubagents.set(taskId, {
          taskId,
          description: prompt.slice(0, 120) || "Parallel agent",
          background: isBackgroundTask(item as Record<string, unknown>),
        });
        emitChatEvent(managed, {
          type: "activity",
          activity: "spawning_agent",
          detail: prompt.slice(0, 80) || "Spawning parallel agent",
          turnId,
        });
        emitChatEvent(managed, {
          type: "subagent_started",
          taskId,
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
          runtime.activeSubagents.delete(agentThreadId);
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
        runtime.activeSubagents.delete(targetId);
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
      if (toolName === "update_plan" && eventKind === "started") {
        emitCodexPlanUpdate(managed, runtime, item.arguments, turnId);
      }
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
    const threadIdFromParams = extractCodexThreadId(params);

    if (
      threadIdFromParams
      && managed.session.threadId
      && threadIdFromParams !== managed.session.threadId
    ) {
      logger.debug("agent_chat.codex_ignored_foreign_thread_notification", {
        sessionId: managed.session.id,
        method,
        threadId: threadIdFromParams,
        expectedThreadId: managed.session.threadId,
      });
      return;
    }

    const isIgnoredTurn = turnIdFromParams ? runtime.ignoredTurnIds.has(turnIdFromParams) : false;
    const isTerminalTurnNotification =
      method === "turn/completed"
      || method === "turn/aborted"
      || method === "codex/event/turn_aborted";
    if (isIgnoredTurn) {
      if (isTerminalTurnNotification && turnIdFromParams) {
        runtime.ignoredTurnIds.delete(turnIdFromParams);
      }
      return;
    }

    const isExpectedTurnStart =
      method === "turn/started"
      && runtime.awaitingTurnStart
      && !runtime.activeTurnId
      && !runtime.startedTurnId;
    if (
      turnIdFromParams
      && !isExpectedTurnStart
      && !isCurrentCodexLifecycleTurn(runtime, turnIdFromParams)
    ) {
      logger.warn(`[codex] ignoring ${method} for inactive turn ${turnIdFromParams} in session ${managed.session.id}`);
      return;
    }

    if (shouldSkipDuplicateCodexNotification(runtime, payload)) {
      return;
    }

    if (method === "turn/started") {
      const turn = (params.turn as { id?: unknown } | null) ?? null;
      const turnId = typeof turn?.id === "string" ? turn.id : null;
      if (!runtime.awaitingTurnStart && !runtime.activeTurnId && !runtime.startedTurnId) {
        logger.warn(`[codex] ignoring unsolicited turn/started for session ${managed.session.id}`);
        if (turnId) {
          runtime.ignoredTurnIds.add(turnId);
          if (runtime.ignoredTurnIds.size > 64) {
            const [first] = runtime.ignoredTurnIds;
            if (first) runtime.ignoredTurnIds.delete(first);
          }
        }
        return;
      }
      runtime.awaitingTurnStart = false;
      runtime.activeTurnId = turnId;
      resetAssistantMessageStream(managed);
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
      setSessionActive(managed);
      if (!turnId || runtime.startedTurnId !== turnId) {
        runtime.startedTurnId = turnId;
        emitChatEvent(managed, {
          type: "status",
          turnStatus: "started",
          ...(turnId ? { turnId } : {})
        });
        captureTurnBeforeSha(managed);
        emitChatEvent(managed, {
          type: "activity",
          ...initialTurnActivity(managed.session),
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
      runtime.awaitingTurnStart = false;
      runtime.activeTurnId = null;
      runtime.startedTurnId = null;
      runtime.ignoredTurnIds.delete(turnId);
      resetAssistantMessageStream(managed);
      runtime.itemTurnIdByItemId.clear();
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
      const status = mapCodexTurnStatus(turn?.status);
      const usage = normalizeUsagePayload(turn?.usage ?? turn?.totalUsage);
      markSessionIdleWithFreshCache(managed);
      runtime.approvals.clear();

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

      void emitTurnDiffSummaryIfChanged(managed, turnId);
      emitChatEvent(managed, {
        type: "done",
        turnId,
        status,
        model: managed.session.model,
        ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        ...(usage ? { usage } : {}),
      });

      const endSha = await computeHeadShaBestEffort(resolveManagedExecutionLaneId(managed)).catch(() => null);
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
      const turnId = typeof params.turnId === "string"
        ? params.turnId
        : turnIdFromParams ?? runtime.activeTurnId ?? undefined;
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
      evictOldestEntries(runtime.commandOutputByItemId, MAX_SESSION_MAP_ENTRIES);
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
      evictOldestEntries(runtime.fileDeltaByItemId, MAX_SESSION_MAP_ENTRIES);
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
      emitCodexPlanUpdate(
        managed,
        runtime,
        {
          plan: Array.isArray(params.plan) ? params.plan : [],
          explanation: typeof params.explanation === "string" ? params.explanation : null,
        },
        typeof params.turnId === "string" ? params.turnId : runtime.activeTurnId ?? undefined,
      );
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
      rememberInterruptedCodexTurn(runtime, turnId);
      runtime.awaitingTurnStart = false;
      runtime.activeTurnId = null;
      runtime.startedTurnId = null;
      runtime.ignoredTurnIds.delete(turnId);
      resetAssistantMessageStream(managed);
      runtime.itemTurnIdByItemId.clear();
      runtime.commandOutputByItemId.clear();
      runtime.fileDeltaByItemId.clear();
      runtime.fileChangesByItemId.clear();
      runtime.agentMessageScopeByTurn.clear();
      runtime.agentMessageTextByTurn.clear();
      runtime.recentNotificationKeys.clear();
      runtime.approvals.clear();
      markSessionIdleWithFreshCache(managed);
      stopActiveCodexSubagents(managed, runtime, turnId, "Interrupted by user");
      emitChatEvent(managed, {
        type: "status",
        turnStatus: "interrupted",
        turnId,
      });
      void emitTurnDiffSummaryIfChanged(managed, turnId);
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
    logger.info("agent_chat.codex_runtime_start", {
      sessionId: managed.session.id,
      cwd: managed.laneWorktreePath,
      shellPath: process.env.SHELL ?? "",
      path: process.env.PATH ?? "",
    });
    const spawnEnv = getAdeCliAgentEnv?.(process.env) ?? process.env;
    let codexExecutable: string;
    try {
      codexExecutable = resolveCodexExecutable().path;
      if (!codexExecutable) {
        throw new Error("Codex executable path was empty.");
      }
    } catch (error) {
      logger.error("Failed to resolve Codex executable for spawn in agentChatService (resolveCodexExecutable)", {
        sessionId: managed.session.id,
        cwd: managed.laneWorktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const invocation = resolveCliSpawnInvocation(codexExecutable, ["app-server"]);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: managed.laneWorktreePath,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const reader = readline.createInterface({ input: proc.stdout });
    const pending = new Map<string, PendingRpc>();

    const runtime: CodexRuntime = {
      kind: "codex",
      process: proc,
      reader,
      killTimer: null,
      suppressExitError: false,
      nextRequestId: 1,
      pending,
      approvals: new Map<string, PendingCodexApproval>(),
      activeTurnId: null,
      startedTurnId: null,
      awaitingTurnStart: false,
      threadResumed: false,
      itemTurnIdByItemId: new Map<string, string>(),
      commandOutputByItemId: new Map<string, string>(),
      fileDeltaByItemId: new Map<string, string>(),
      fileChangesByItemId: new Map<string, Array<{ path: string; kind: "create" | "modify" | "delete" }>>(),
      activeSubagents: new Map<string, { taskId: string; description: string; background: boolean }>(),
      interruptedTurnIds: new Set<string>(),
      ignoredTurnIds: new Set<string>(),
      agentMessageScopeByTurn: new Map<string, "item" | "turn">(),
      agentMessageTextByTurn: new Map<string, string>(),
      recentNotificationKeys: new Set<string>(),
      slashCommands: [],
      rateLimits: null,
      collaborationModes: null,
      collaborationModesReady: null,
      planModeFallbackNotified: false,
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
      keepChatSessionOpen(managed, {
        message,
        turnId: runtime.activeTurnId,
        ...(runtime.activeTurnId ? { turnStatus: "failed" as const } : {}),
      });
    });

    proc.on("exit", (code, signal) => {
      const message = `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      if (runtime.killTimer) {
        clearTimeout(runtime.killTimer);
        runtime.killTimer = null;
      }

      for (const request of pending.values()) {
        request.reject(new Error(message));
      }
      pending.clear();

      runtime.approvals.clear();

      if (runtime.suppressExitError) return;
      if (managed.closed || managed.session.status === "ended") return;
      keepChatSessionOpen(managed, {
        message,
        turnId: runtime.activeTurnId,
        ...(runtime.activeTurnId ? { turnStatus: "failed" as const } : {}),
      });
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

    const collaborationModesRequest = runtime.request<unknown>("collaborationMode/list", {})
      .then((res) => {
        const modes = parseCodexCollaborationModes(res);
        if (modes) {
          runtime.collaborationModes = modes;
        }
      })
      .catch(() => { /* collaborationMode/list not supported — ignore */ });
    runtime.collaborationModesReady = Promise.race([
      collaborationModesRequest,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DEFAULT_COLLABORATION_MODES_LIST_TIMEOUT_MS);
        timer.unref?.();
        collaborationModesRequest.finally(() => clearTimeout(timer)).catch(() => {});
      }),
    ]).then(() => undefined);

    runtime.notify("initialized");
    return runtime;
  };

  const ensureCodexSessionRuntime = async (managed: ManagedChatSession): Promise<CodexRuntime> => {
    if (managed.runtime?.kind === "codex") return managed.runtime;
    // Evict least-recent runtime if at capacity
    {
      let activeCount = 0;
      for (const [, s] of managedSessions) { if (s.runtime) activeCount++; }
      if (activeCount >= MAX_CONCURRENT_ACTIVE_RUNTIMES) evictLeastRecentRuntime(managed.session.id);
    }
    const runtime = await startCodexRuntime(managed);
    managed.runtime = runtime;
    managed.runtimeInvalidated = false;
    return runtime;
  };

  type CodexPolicy = {
    approvalPolicy: AgentChatCodexApprovalPolicy;
    sandbox: AgentChatCodexSandbox;
  } | null;

  const resolveCodexThreadParams = (managed: ManagedChatSession): {
    codexPolicy: CodexPolicy;
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
    return { codexPolicy };
  };

  const startFreshCodexThread = async (
    managed: ManagedChatSession,
    runtime: CodexRuntime,
    codexPolicy: CodexPolicy,
  ): Promise<void> => {
    const startResponse = await runtime.request<{ thread?: { id?: string } }>("thread/start", {
      model: managed.session.model,
      ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
      cwd: managed.laneWorktreePath,
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
    const claudeEnv = getAdeCliAgentEnv?.(process.env) ?? process.env;
    const opts: ClaudeSDKOptions = {
      cwd: managed.laneWorktreePath,
      env: claudeEnv,
      permissionMode: claudePermissionMode as any,
      ...(claudePermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } as any : {}),
      includePartialMessages: true,
      agentProgressSummaries: true,
      promptSuggestions: true,
      settings: CLAUDE_THINKING_SETTINGS,
      maxBudgetUsd: chatConfig.sessionBudgetUsd ?? undefined,
      model: resolveClaudeCliModel(managed.session.model),
      pathToClaudeCodeExecutable: claudeExecutable.path,
    };
    if (!lightweight) {
      opts.toolConfig = {
        askUserQuestion: {
          previewFormat: "markdown",
        },
      };
      opts.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: [
          "## ADE Workspace",
          `ADE launched this session in lane worktree: ${managed.laneWorktreePath}.`,
          "Read, edit, and run commands only inside that worktree. Do not switch to project root, another lane, or another repo unless ADE explicitly relaunches you there.",
          "",
          "## ADE Memory",
          "Use the ADE CLI (`ade memory search`, `ade memory add`, `ade memory pin`) when you need project memory from a terminal-capable session.",
          "**Search first:** Before starting non-trivial work, search memory for relevant conventions, past decisions, or known pitfalls when the CLI is available.",
          "**Write sparingly and well:** Only save knowledge a developer joining this project would find useful on their first day. Each memory should be a single actionable insight.",
          "GOOD memories: \"Convention: always use snake_case for DB columns\", \"Decision: chose Postgres over Mongo for ACID transactions\", \"Pitfall: CI silently skips tests if file doesn't match *.test.ts\"",
          "DO NOT save: file paths, raw error messages without lessons, task progress updates, information derivable from git log or the code itself, obvious patterns already visible in the codebase.",
          "",
          "## ADE Tooling",
          "ADE actions are available through the `ade` CLI in terminal-capable sessions.",
          "Run `ade doctor` for readiness, `ade actions list --text` for discovery, typed commands such as `ade lanes list --text`, `ade prs checks <pr> --text`, or `ade proof list --text` first, and `ade actions run ...` as the escape hatch.",
          "Use `--json` for structured output and `--text` for readable output.",
        ].join("\n"),
      };
      opts.settingSources = ["user", "project", "local"];
      opts.canUseTool = buildClaudeCanUseTool(runtime, managed) as any;

      // PreCompact hook: nudge the model to save durable discoveries into
      // ADE memory before the SDK compacts context. Runs inside the SDK's
      // compaction flow so the text never surfaces as a visible user turn.
      (opts as any).hooks = {
        PreCompact: [
          {
            hooks: [
              async () => {
                return {
                  continue: true,
                  systemMessage: DEFAULT_FLUSH_PROMPT,
                };
              },
            ],
          },
        ],
      };

      // Enable provider tool search for non-CTO sessions with large tool catalogs.
      // When enabled, the SDK defers tool definitions and loads them on demand
      // via its ToolSearch capability, keeping the context window lean.
      // CTO sessions disable deferral so operator tools (spawnChat, gitCommit, etc.)
      // are always visible without needing ToolSearch.
      opts.env = {
        ...process.env as Record<string, string>,
        ...opts.env as Record<string, string> | undefined,
        ENABLE_TOOL_SEARCH: managed.session.identityKey === "cto" ? "0" : "auto",
      };
    }
    const claudeDescriptor = resolveSessionModelDescriptor(managed.session);
    const claudeSupportsReasoning = claudeDescriptor?.capabilities.reasoning ?? true;
    opts.executableArgs = buildClaudeV2ExecutableArgs({
      supportsReasoning: claudeSupportsReasoning,
      effort: managed.session.reasoningEffort,
    });
    if (claudeSupportsReasoning) {
      const effort = managed.session.reasoningEffort;
      if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
        opts.effort = effort as any;
      }
      const tokens = effort ? CLAUDE_EFFORT_TO_TOKENS[effort] : undefined;
      if (tokens) {
        opts.thinking = { type: "enabled", budgetTokens: tokens, display: "summarized" } as any;
      } else {
        // Use adaptive thinking when no specific budget applies (e.g. "max",
        // "xhigh", or no effort set). The SDK defaults to adaptive for models
        // that support it, but being explicit ensures thinking is always active
        // for reasoning-capable models.
        opts.thinking = { type: "adaptive", display: "summarized" } as any;
      }
    }
    const model = opts.model ?? resolveClaudeCliModel(managed.session.model) ?? DEFAULT_CLAUDE_MODEL;
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
    reason: "interrupt" | "teardown" | "session_reset" | "timeout",
  ): void => {
    if (!runtime.v2WarmupDone) return;
    runtime.v2WarmupCancelled = true;
    runtime.v2WarmupCancel?.();
    logger.info("agent_chat.claude_v2_prewarm_cancel", {
      sessionId: managed.session.id,
      reason,
    });
  };

  const cancelQueuedSteers = (
    managed: ManagedChatSession,
    runtime: Pick<ClaudeRuntime | OpenCodeRuntime, "pendingSteers" | "activeTurnId">,
    reason: "interrupted" | "failed" | "disposed",
  ): void => {
    const cancelled = runtime.pendingSteers.splice(0);
    if (!cancelled.length) return;

    const cancelReasons: Record<typeof reason, string> = {
      interrupted: "Queued message cancelled because the current turn was interrupted.",
      failed: "Queued message cancelled because the current turn failed.",
      disposed: "Queued message cancelled because the session was closed.",
    };
    const message = cancelReasons[reason];

    for (const steer of cancelled) {
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "info",
        steerId: steer.steerId,
        message,
        turnId: runtime.activeTurnId ?? undefined,
      });
    }
  };

  const waitForClaudeWarmup = async (
    managed: ManagedChatSession,
    runtime: ClaudeRuntime,
    turnId: string,
  ): Promise<void> => {
    if (!runtime.v2WarmupDone) return;

    const warmupWaitStartedAt = Date.now();
    logger.info("agent_chat.claude_v2_turn_waiting_for_warmup", {
      sessionId: managed.session.id,
      turnId,
    });

    let warmupTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const warmupTimeout = new Promise<"timeout">((resolve) => {
        warmupTimeoutHandle = setTimeout(() => resolve("timeout"), CLAUDE_WARMUP_WAIT_TIMEOUT_MS);
      });
      const warmupState = await Promise.race([
        runtime.v2WarmupDone.then(() => "ready" as const),
        warmupTimeout,
      ]);

      if (warmupState === "timeout") {
        logger.warn("agent_chat.claude_v2_turn_warmup_timeout", {
          sessionId: managed.session.id,
          turnId,
          timeoutMs: CLAUDE_WARMUP_WAIT_TIMEOUT_MS,
        });
        cancelClaudeWarmup(managed, runtime, "timeout");
        try { runtime.v2Session?.close(); } catch { /* ignore */ }
        runtime.v2Session = null;
        runtime.v2WarmupDone = null;
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "Claude session warmup timed out. Restarting the session for this turn.",
          turnId,
        });
        return;
      }

      logger.info("agent_chat.claude_v2_turn_warmup_wait_done", {
        sessionId: managed.session.id,
        turnId,
        waitedMs: Date.now() - warmupWaitStartedAt,
      });
    } finally {
      if (warmupTimeoutHandle) clearTimeout(warmupTimeoutHandle);
    }
  };

  const applyClaudeSlashCommands = (
    runtime: ClaudeRuntime,
    commands: Array<string | { name?: string; description?: string; argumentHint?: string }>,
  ): void => {
    const existing = new Map(runtime.slashCommands.map((command) => [command.name, command]));
    for (const command of commands
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
      .filter((command): command is { name: string; description: string; argumentHint?: string } => Boolean(command))) {
      existing.set(command.name, {
        ...existing.get(command.name),
        ...command,
      });
    }
    runtime.slashCommands = [...existing.values()].sort((a, b) => a.name.localeCompare(b.name));
  };

  const deliverNextQueuedSteer = async (
    managed: ManagedChatSession,
    runtime: ClaudeRuntime | OpenCodeRuntime | CursorRuntime,
  ): Promise<boolean> => {
    if (managed.closed) return false;

    const nextSteer = runtime.pendingSteers.shift();
    if (!nextSteer) return false;

    const trimmed = nextSteer.text.trim();
    if (!trimmed.length) {
      persistChatState(managed);
      return false;
    }

    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      steerId: nextSteer.steerId,
      message: "Delivering your queued message...",
      turnId: runtime.activeTurnId ?? undefined,
    });

    runtime.interrupted = false;
    persistChatState(managed);

    // Re-resolve lane context so that a lane switch that occurred while the
    // steer was queued is reflected in the delivered prompt.
    const executionContext = resolveManagedExecutionContext(managed, {
      purpose: "deliver queued steer",
    });
    const laneDirectiveKey = executionContext.laneDirectiveKey;
    const shouldInjectLaneDirective =
      laneDirectiveKey != null && managed.lastLaneDirectiveKey !== laneDirectiveKey;
    const promptText = composeLaunchDirectives(trimmed, [
      shouldInjectLaneDirective
        ? buildLaneWorktreeDirective({
            laneId: executionContext.laneId,
            laneWorktreePath: executionContext.laneWorktreePath,
          })
        : null,
    ]);

    if (runtime.kind === "claude") {
      await runClaudeTurn(managed, {
        promptText,
        displayText: trimmed,
        attachments: nextSteer.attachments,
        resolvedAttachments: nextSteer.resolvedAttachments,
        laneDirectiveKey: shouldInjectLaneDirective ? laneDirectiveKey : null,
      });
    } else if (runtime.kind === "cursor") {
      await runCursorTurn(managed, {
        promptText,
        displayText: trimmed,
        attachments: nextSteer.attachments,
        resolvedAttachments: nextSteer.resolvedAttachments,
        laneDirectiveKey: shouldInjectLaneDirective ? laneDirectiveKey : null,
      });
    } else {
      await runTurn(managed, {
        promptText,
        displayText: trimmed,
        attachments: nextSteer.attachments,
        resolvedAttachments: nextSteer.resolvedAttachments,
        laneDirectiveKey: shouldInjectLaneDirective ? laneDirectiveKey : null,
      });
    }

    return true;
  };

  /** Enqueue a steer or drop it if the queue is full. Returns true if queued. */
  const enqueueSteerOrDrop = (
    managed: ManagedChatSession,
    runtime: Pick<ClaudeRuntime | OpenCodeRuntime, "pendingSteers" | "activeTurnId">,
    sessionId: string,
    steerId: string,
    text: string,
    attachments: AgentChatFileRef[] = [],
    resolvedAttachments: ResolvedAgentChatFileRef[] = [],
  ): boolean => {
    if (runtime.pendingSteers.length >= MAX_PENDING_STEERS) {
      logger.warn("agent_chat.steer_queue_full", { sessionId, queueSize: runtime.pendingSteers.length });
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "info",
        message: "Steer dropped — the queue is full. Wait for the current turn to finish.",
        turnId: runtime.activeTurnId ?? undefined,
      });
      return false;
    }
    runtime.pendingSteers.push({ steerId, text, attachments, resolvedAttachments });
    emitChatEvent(managed, {
      type: "user_message",
      text,
      ...(attachments.length ? { attachments } : {}),
      steerId,
      turnId: runtime.activeTurnId ?? undefined,
      deliveryState: "queued",
    });
    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      steerId,
      message: `Message queued (#${runtime.pendingSteers.length}) — will be sent after the current turn.`,
      turnId: runtime.activeTurnId ?? undefined,
    });
    persistChatState(managed);
    return true;
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

        // Apply permission mode before the first interaction so the session
        // starts with the correct approval behaviour selected in the rebase tab.
        const initialPermissionMode = resolveClaudeTurnPermissionMode(managed);
        const sessionControl = getClaudeV2SessionControl(runtime.v2Session);
        if (typeof sessionControl.setPermissionMode === "function") {
          await sessionControl.setPermissionMode(initialPermissionMode);
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
              const control = getClaudeV2SessionControl(runtime.v2Session);
              if (typeof control.supportedCommands === "function") {
                control.supportedCommands().then((cmds: any[]) => {
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
          // Warmup was cancelled during streaming — clean up and bail
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
        logger.warn("agent_chat.claude_v2_prewarm_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
          claudeExecutablePath: diagClaudePath,
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
    // Evict least-recent runtime if at capacity
    {
      let activeCount = 0;
      for (const [, s] of managedSessions) { if (s.runtime) activeCount++; }
      if (activeCount >= MAX_CONCURRENT_ACTIVE_RUNTIMES) evictLeastRecentRuntime(managed.session.id);
    }
    const persisted = readPersistedState(managed.session.id);
    const currentLaneDirectiveKey = buildLaneDirectiveKey({
      laneId: resolveManagedExecutionLaneId(managed),
      laneWorktreePath: managed.laneWorktreePath,
    });
    const sdkSessionId = currentLaneDirectiveKey != null && persisted?.lastLaneDirectiveKey === currentLaneDirectiveKey
      ? persisted?.sdkSessionId ?? null
      : null;
    const runtime: ClaudeRuntime = {
      kind: "claude",
      sdkSessionId,
      v2Session: null,
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
      interruptEventsEmitted: false,
      turnMemoryPolicyState: null,
      approvalOverrides: new Set<string>(persisted?.approvalOverrides ?? []),
      resolvedToolUseIds: new Set<string>(),
    };
    managed.runtime = runtime;
    managed.runtimeInvalidated = false;

    return runtime;
  };

  const listCodexModelsFromAppServer = async (): Promise<AgentChatModelInfo[]> => {
    const tempSession: ManagedChatSession = {
      session: {
        id: randomUUID(),
        laneId: "temporary",
        provider: "codex",
        model: DEFAULT_CODEX_MODEL,
        capabilityMode: "full_tooling",
        status: "idle",
        idleSinceAt: null,
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
      deleted: false,
      lastActivitySignature: null,
      bufferedReasoning: null,
      ctoSessionStartedAt: null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
      manuallyNamed: false,
      summaryInFlight: false,
      continuitySummary: null,
      continuitySummaryUpdatedAt: null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: null,
      selectedExecutionLaneId: null,
      lastLaneDirectiveKey: null,
      runtimeInvalidated: false,
      todoItems: [],
      activeAssistantMessageId: null,
      previewTextBuffer: null,
      bufferedText: null,
      recentConversationEntries: [],
      localPendingInputs: new Map(),
      eventSequence: 0,
      lastActivityTimestamp: Date.now(),
      turnBeforeSha: null,
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
        if (runtime) {
          terminateChildProcessTree(runtime.process, null);
        }
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
        const id = descriptor.providerModelId;
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
    opencodePermissionMode: requestedOpenCodePermissionModeArg,
    cursorModeId: requestedCursorModeId,
    cursorConfigValues: requestedCursorConfigValues,
    permissionMode: requestedPermMode,
    identityKey,
    surface,
    automationId,
    automationRunId,
    requestedCwd,
  }: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const launchContext = resolveLaneLaunchContext({
      laneService,
      laneId,
      purpose: "start this chat",
      requestedCwd,
    });
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
          : provider === "cursor"
            ? DEFAULT_CURSOR_MODEL
            : "");
    // Resolve modelId from registry if provided
    const requestedModelDescriptor = modelId ? getModelById(modelId) ?? resolveModelAlias(modelId) : undefined;
    const resolvedModelId = requestedModelDescriptor?.id
      ?? resolveModelIdFromStoredValue(normalizedInputModel, provider);

    if (provider === "opencode" && !resolvedModelId && !modelId?.endsWith("/auto")) {
      throw new Error("OpenCode chat requires a known model ID. Select a model from the registry.");
    }

    if (provider === "cursor" && !resolvedModelId) {
      throw new Error("Cursor chat requires a known model. Pick a Cursor model from the model list.");
    }

    const resolvedDescriptor = requestedModelDescriptor ?? (resolvedModelId ? getModelById(resolvedModelId) : undefined);
    if (resolvedModelId && !resolvedDescriptor) {
      throw new Error(`Unknown model '${resolvedModelId}'.`);
    }

    let effectiveProvider: AgentChatProvider = provider;
    let normalizedModel = normalizedInputModel;

    if (resolvedDescriptor) {
      const resolved = resolveProviderGroupForModel(resolvedDescriptor);
      if (resolvedDescriptor.isCliWrapped && resolved === "opencode") {
        throw new Error(
          `Model '${resolvedDescriptor.id}' is CLI-only but does not map to a supported chat runtime.`,
        );
      }
      effectiveProvider = resolved;
      normalizedModel = resolvedDescriptor.isCliWrapped ? resolvedDescriptor.providerModelId : resolvedDescriptor.id;
    }

    const rawEffort = effectiveProvider === "codex"
      ? normalizeReasoningEffort(reasoningEffort) ?? DEFAULT_REASONING_EFFORT
      : normalizeReasoningEffort(reasoningEffort);
    const normalizedReasoningEffort = effectiveProvider === "opencode"
      ? rawEffort
      : effectiveProvider === "cursor"
        ? null
        : validateReasoningEffort(effectiveProvider === "claude" ? "claude" : "codex", rawEffort);
    const normalizedCursorModeId = typeof requestedCursorModeId === "string"
      ? (requestedCursorModeId.trim() || null)
      : requestedCursorModeId === null
        ? null
        : undefined;
    const normalizedCursorConfigValues = normalizeCursorConfigValueRecord(requestedCursorConfigValues);
    const capabilityMode = inferCapabilityMode(effectiveProvider);
    let effectivePermissionMode = identityKey
      ? normalizeIdentityPermissionMode(requestedPermMode, effectiveProvider)
      : requestedPermMode;
    const chatConfig = resolveChatConfig();
    let requestedOpenCodePermissionMode = requestedOpenCodePermissionModeArg;
    const localHarnessPermissions = applyLocalHarnessPermissionMode({
      descriptor: resolvedDescriptor,
      requestedPermissionMode: effectivePermissionMode,
      requestedOpenCodePermissionMode,
    });
    effectivePermissionMode = localHarnessPermissions.requestedPermissionMode;
    requestedOpenCodePermissionMode = localHarnessPermissions.requestedOpenCodePermissionMode;

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
      if (effectiveProvider === "cursor") {
        return {
          opencodePermissionMode: requestedOpenCodePermissionMode
            ?? legacyPermissionModeToOpenCodePermissionMode(effectivePermissionMode)
            ?? chatConfig.opencodePermissionMode,
          ...(normalizedCursorModeId !== undefined ? { cursorModeId: normalizedCursorModeId } : {}),
          ...(normalizedCursorConfigValues
            ? { cursorConfigValues: normalizedCursorConfigValues }
            : {}),
        };
      }
      return {
        opencodePermissionMode: requestedOpenCodePermissionMode
          ?? legacyPermissionModeToOpenCodePermissionMode(effectivePermissionMode)
          ?? chatConfig.opencodePermissionMode,
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
        completion: null,
        status: "idle",
        idleSinceAt: null,
        createdAt: startedAt,
        lastActivityAt: startedAt,
        ...(typeof requestedCwd === "string" && requestedCwd.trim().length
          ? { requestedCwd: requestedCwd.trim() }
          : {}),
      },
      transcriptPath,
      transcriptBytesWritten: fileSizeOrZero(transcriptPath),
      transcriptLimitReached: false,
      metadataPath,
      laneWorktreePath: launchContext.laneWorktreePath,
      runtime: null,
      preview: null,
      closed: false,
      endedNotified: false,
      deleted: false,
      ctoSessionStartedAt: identityKey === "cto" ? startedAt : null,
      pendingReconstructionContext: null,
      autoTitleSeed: null,
      autoTitleStage: "none",
      autoTitleInFlight: false,
      manuallyNamed: false,
      summaryInFlight: false,
      continuitySummary: null,
      continuitySummaryUpdatedAt: null,
      continuitySummaryInFlight: false,
      preferredExecutionLaneId: null,
      selectedExecutionLaneId: null,
      lastLaneDirectiveKey: null,
      runtimeInvalidated: false,
      todoItems: [],
      activeAssistantMessageId: null,
      lastActivitySignature: null,
      bufferedReasoning: null,
      previewTextBuffer: null,
      bufferedText: null,
      recentConversationEntries: [],
      localPendingInputs: new Map(),
      eventSequence: 0,
      lastActivityTimestamp: Date.now(),
      turnBeforeSha: null,
    };
    normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
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
    const targetModel = targetDescriptor.isCliWrapped ? targetDescriptor.providerModelId : targetDescriptor.id;
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
      opencodePermissionMode: managed.session.opencodePermissionMode,
      permissionMode: managed.session.permissionMode,
      surface: managed.session.surface,
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
    const slashCommand = extractLeadingSlashCommand(trimmed);
    const providerSlashCommand = isProviderSlashCommandInput(trimmed);
    const visibleText = displayText?.trim().length ? displayText.trim() : trimmed;

    const managed = ensureManagedSession(sessionId);
    const executionContext = refreshManagedLaneLaunchContext(managed);
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
      setSessionIdle(managed);
      managed.closed = false;
      managed.endedNotified = false;
      managed.ctoSessionStartedAt = managed.session.identityKey === "cto" ? nowIso() : null;
      refreshReconstructionContext(managed);
    }

    if (managed.session.provider === "cursor" && managed.session.status === "active") {
      throw new Error("Turn is already active.");
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
    const laneDirectiveKey = executionContext.laneDirectiveKey;
    const shouldInjectLaneDirective = laneDirectiveKey != null && managed.lastLaneDirectiveKey !== laneDirectiveKey;
    const promptText = providerSlashCommand
      ? trimmed
      : composeLaunchDirectives(trimmed, [
          shouldInjectLaneDirective
            ? buildLaneWorktreeDirective({
                laneId: executionContext.laneId,
                laneWorktreePath: executionContext.laneWorktreePath,
              })
            : null,
          buildExecutionModeDirective(executionMode, managed.session.provider),
          buildClaudeInteractionModeDirective(managed.session.interactionMode, managed.session.provider),
          buildComputerUseDirective(
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
      laneDirectiveKey: providerSlashCommand ? null : shouldInjectLaneDirective ? laneDirectiveKey : null,
      providerSlashCommand,
      forceClaudeUserMessage: managed.session.provider === "claude" && !providerSlashCommand && slashCommand != null,
    };
  };

  const emitDispatchedSendFailure = (prepared: PreparedSendMessage, error: unknown): void => {
    const { managed } = prepared;
    if (managed.closed) return;

    const message = error instanceof Error ? error.message : String(error);
    const turnId = prepared.turnId ?? randomUUID();

    // If the failure is "turn already active", the original turn is still running.
    // Do NOT clear activeTurnId or runtime state — that would corrupt the in-flight
    // turn's streaming (text deltas lose their turnId and each word becomes a
    // separate chat bubble).
    const normalizedMsg = message.toLowerCase();
    const isBusyError = normalizedMsg.includes("turn is already active")
      || normalizedMsg.includes("already active")
      || normalizedMsg.includes("busy");

    if (!isBusyError) {
      setSessionIdle(managed);
    }

    if (managed.runtime?.kind === "codex" && !isBusyError) {
      managed.runtime.activeTurnId = null;
      managed.runtime.startedTurnId = null;
      managed.runtime.itemTurnIdByItemId.clear();
    }
    if (managed.runtime?.kind === "opencode" && !isBusyError) {
      setOpenCodeRuntimeBusy(managed.runtime, false);
      managed.runtime.activeTurnId = null;
      managed.runtime.eventAbortController = null;
    }
    if (managed.runtime?.kind === "claude" && !isBusyError) {
      managed.runtime.busy = false;
      managed.runtime.activeTurnId = null;
    }
    if (managed.runtime?.kind === "cursor" && !isBusyError) {
      managed.runtime.busy = false;
      managed.runtime.activeTurnId = null;
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
    void emitTurnDiffSummaryIfChanged(managed, turnId);
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

  const cursorPoolKeyFor = (managed: ManagedChatSession): string => {
    const launch = resolveCursorAcpLaunchSettings(managed.session);
    return [
      managed.session.laneId,
      managed.laneWorktreePath,
      managed.session.model,
      launch.mode ?? "default",
      launch.sandbox,
      launch.force ? "force" : "guarded",
    ].join(":");
  };

  const mapChatDecisionToCursorPermission = (
    decision: AgentChatApprovalDecision | undefined,
    options: PermissionOption[],
    answers?: Record<string, string | string[]>,
  ): RequestPermissionResponse => {
    // If the caller provided an explicit optionId (e.g. from a structured
    // selection), resolve it directly instead of the coarse decision mapping.
    if (answers) {
      const explicit = Object.values(answers).flat()[0];
      const match = explicit ? options.find((o) => o.optionId === explicit) : undefined;
      if (match) return { outcome: { outcome: "selected", optionId: match.optionId } };
    }
    const pick = (kind: PermissionOption["kind"]) => options.find((o) => o.kind === kind)?.optionId;
    if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
    if (decision === "accept_for_session") {
      const id = pick("allow_always") ?? pick("allow_once");
      if (id) return { outcome: { outcome: "selected", optionId: id } };
    } else if (decision === "accept") {
      const id = pick("allow_once") ?? pick("allow_always");
      if (id) return { outcome: { outcome: "selected", optionId: id } };
    } else if (decision === "decline") {
      const id = pick("reject_once") ?? pick("reject_always");
      if (id) return { outcome: { outcome: "selected", optionId: id } };
    }
    return { outcome: { outcome: "cancelled" } };
  };

  const cursorPermissionOptionLabel = (kind: PermissionOption["kind"]): string => {
    switch (kind) {
      case "allow_once":
        return "Allow once";
      case "allow_always":
        return "Allow for session";
      case "reject_once":
        return "Reject once";
      case "reject_always":
        return "Reject for session";
      default:
        return kind;
    }
  };

  const buildCursorPendingInputRequest = (
    itemId: string,
    req: RequestPermissionRequest,
    turnId?: string | null,
  ): PendingInputRequest => ({
    requestId: itemId,
    itemId,
    source: "cursor",
    kind: "permissions",
    title: req.toolCall.title ?? "Cursor permission required",
    description: req.toolCall.title ?? "Cursor needs approval before continuing.",
    questions: [],
    allowsFreeform: false,
    blocking: true,
    canProceedWithoutAnswer: false,
    options: req.options.map((option) => ({
      label: cursorPermissionOptionLabel(option.kind),
      value: option.optionId,
      ...(option.kind === "allow_always" ? { recommended: true } : {}),
    })),
    providerMetadata: {
      toolCall: req.toolCall,
      options: req.options,
    },
    turnId: turnId ?? null,
  });

  const syncCursorSessionDescriptor = (
    managed: ManagedChatSession,
    providerModelId: string,
  ): void => {
    const trimmed = providerModelId.trim();
    if (!trimmed.length) return;
    managed.session.model = trimmed;
    const descriptor = getModelById(`cursor/${trimmed}`) ?? resolveModelDescriptorForProvider(trimmed, "cursor");
    if (descriptor) {
      managed.session.modelId = descriptor.id;
      if (managed.runtime?.kind === "cursor") {
        managed.runtime.modelSdkId = descriptor.providerModelId;
      }
      return;
    }
    delete managed.session.modelId;
    if (managed.runtime?.kind === "cursor") {
      managed.runtime.modelSdkId = trimmed;
    }
  };

  const applyCursorConfigSnapshot = (
    managed: ManagedChatSession,
    runtime: CursorRuntime,
    configOptions: ReturnType<typeof readCursorAcpConfigSnapshot>,
  ): void => {
    runtime.modeConfigId = configOptions.modeConfigId;
    runtime.availableModeIds = configOptions.availableModeIds;
    runtime.modelConfigId = configOptions.modelConfigId;
    runtime.availableModelIds = configOptions.availableModelIds;
    runtime.configOptions = configOptions.configOptions;

    const currentModeId = configOptions.currentModeId?.trim() ?? "";
    if (currentModeId.length) {
      runtime.currentModeId = currentModeId;
      if (currentModeId !== "plan") {
        runtime.defaultModeId = currentModeId;
      }
    }

    const currentModelId = normalizeCursorReportedModelId(configOptions.currentModelId, runtime.availableModelIds);
    if (currentModelId) {
      runtime.currentModelId = currentModelId;
      syncCursorSessionDescriptor(managed, currentModelId);
    }
    syncCursorModeSnapshot(managed, runtime);
  };

  const ensureCursorSessionState = async (
    managed: ManagedChatSession,
    runtime: CursorRuntime,
  ): Promise<void> => {
    const sessionId = runtime.acpSessionId?.trim();
    if (!sessionId || !runtime.pooled) return;

    const requestedModeId = resolveCursorSessionModeId(managed.session);
    const desiredModeId = requestedModeId ?? runtime.defaultModeId?.trim() ?? null;
    if (desiredModeId && runtime.currentModeId !== desiredModeId) {
      let modeUpdated = false;
      if (runtime.modeConfigId && runtime.availableModeIds.includes(desiredModeId)) {
        try {
          const response = await runtime.pooled.connection.setSessionConfigOption({
            sessionId,
            configId: runtime.modeConfigId,
            value: desiredModeId,
          });
          applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(response.configOptions));
          modeUpdated = true;
        } catch (error) {
          logger.warn("agent_chat.cursor_set_session_mode_config_failed", {
            sessionId: managed.session.id,
            acpSessionId: sessionId,
            desiredModeId,
            configId: runtime.modeConfigId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!modeUpdated) {
        try {
          await runtime.pooled.connection.setSessionMode({
            sessionId,
            modeId: desiredModeId,
          });
          runtime.currentModeId = desiredModeId;
          if (desiredModeId !== "plan" && !runtime.defaultModeId) {
            runtime.defaultModeId = desiredModeId;
          }
          syncCursorModeSnapshot(managed, runtime);
        } catch (error) {
          logger.warn("agent_chat.cursor_set_session_mode_failed", {
            sessionId: managed.session.id,
            acpSessionId: sessionId,
            desiredModeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const desiredModelId = runtime.modelSdkId.trim() || managed.session.model.trim();
    if (!desiredModelId.length) {
      syncCursorModeSnapshot(managed, runtime);
      return;
    }

    if (runtime.currentModelId === desiredModelId) {
      syncCursorSessionDescriptor(managed, desiredModelId);
    } else {
      let modelUpdated = false;
      if (runtime.modelConfigId && runtime.availableModelIds.includes(desiredModelId)) {
        try {
          const response = await runtime.pooled.connection.setSessionConfigOption({
            sessionId,
            configId: runtime.modelConfigId,
            value: desiredModelId,
          });
          applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(response.configOptions));
          if (!normalizeCursorReportedModelId(runtime.currentModelId, runtime.availableModelIds)) {
            runtime.currentModelId = desiredModelId;
            syncCursorSessionDescriptor(managed, desiredModelId);
          }
          modelUpdated = true;
        } catch (error) {
          logger.warn("agent_chat.cursor_set_session_model_config_failed", {
            sessionId: managed.session.id,
            acpSessionId: sessionId,
            desiredModelId,
            configId: runtime.modelConfigId,
            currentModelId: runtime.currentModelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!modelUpdated) {
        try {
          await runtime.pooled.connection.unstable_setSessionModel({
            sessionId,
            modelId: desiredModelId,
          });
          runtime.currentModelId = desiredModelId;
          syncCursorSessionDescriptor(managed, desiredModelId);
          syncCursorModeSnapshot(managed, runtime);
        } catch (error) {
          logger.warn("agent_chat.cursor_set_session_model_failed", {
            sessionId: managed.session.id,
            acpSessionId: sessionId,
            desiredModelId,
            currentModelId: runtime.currentModelId,
            error: error instanceof Error ? error.message : String(error),
          });
          const normalizedCurrentModelId = normalizeCursorReportedModelId(runtime.currentModelId, runtime.availableModelIds);
          if (normalizedCurrentModelId) {
            runtime.currentModelId = normalizedCurrentModelId;
            syncCursorSessionDescriptor(managed, normalizedCurrentModelId);
          }
        }
      }
    }

    const desiredConfigValues = managed.session.cursorConfigValues ?? {};
    for (const option of runtime.configOptions) {
      if (option.id === runtime.modeConfigId || option.id === runtime.modelConfigId) continue;
      const desiredValue = desiredConfigValues[option.id];
      if (desiredValue === undefined || desiredValue === option.currentValue) continue;
      try {
        const response = await runtime.pooled.connection.setSessionConfigOption({
          sessionId,
          configId: option.id,
          ...(typeof desiredValue === "boolean"
            ? { type: "boolean" as const, value: desiredValue }
            : { value: typeof desiredValue === "number" ? String(desiredValue) : desiredValue }),
        });
        applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(response.configOptions));
      } catch (error) {
        logger.warn("agent_chat.cursor_set_session_config_failed", {
          sessionId: managed.session.id,
          acpSessionId: sessionId,
          configId: option.id,
          desiredValue,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    syncCursorModeSnapshot(managed, runtime);
  };

  const refreshCursorSessionState = async (
    managed: ManagedChatSession,
    runtime: CursorRuntime,
    reason: "after_prompt" | "manual_sync",
  ): Promise<void> => {
    const sessionId = runtime.acpSessionId?.trim();
    if (!sessionId || !runtime.pooled) return;

    const loadSession = runtime.pooled.connection.loadSession?.bind(runtime.pooled.connection);
    if (!loadSession) return;

    try {
      const loaded = await loadSession(cursorAcpSessionRequest({
        sessionId,
        cwd: managed.laneWorktreePath,
      }) as Parameters<typeof loadSession>[0]);
      const loadedAvailableModelIds = loaded.models?.availableModels
        ?.map((entry) => String(entry?.modelId ?? "").trim())
        .filter(Boolean) ?? [];
      if (loadedAvailableModelIds.length) {
        runtime.availableModelIds = Array.from(new Set([...runtime.availableModelIds, ...loadedAvailableModelIds]));
      }
      runtime.currentModeId = loaded.modes?.currentModeId ?? runtime.currentModeId;
      runtime.defaultModeId = loaded.modes?.currentModeId ?? runtime.defaultModeId;
      runtime.currentModelId = normalizeCursorReportedModelId(
        loaded.models?.currentModelId,
        runtime.availableModelIds,
      ) ?? runtime.currentModelId;
      applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(loaded.configOptions));
      if (runtime.currentModelId) {
        syncCursorSessionDescriptor(managed, runtime.currentModelId);
      }
      syncCursorModeSnapshot(managed, runtime);
    } catch (error) {
      logger.warn("agent_chat.cursor_load_session_failed", {
        sessionId: managed.session.id,
        acpSessionId: sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const guessImageMimeForPath = (p: string): string => {
    const lower = p.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
  };

  /** Maximum bytes to inline for a non-image attachment in a Cursor ACP prompt. */
  const MAX_INLINE_BYTES = 512 * 1024; // 512 KB

  const buildCursorAcpPromptBlocks = (
    promptText: string,
    resolvedAttachments: ResolvedAgentChatFileRef[],
  ): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> => {
    const blocks: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: promptText }];
    for (const attachment of resolvedAttachments) {
      try {
        // Check file size before reading the full contents into memory.
        let fileSize: number;
        try {
          fileSize = fs.statSync(attachment._resolvedPath).size;
        } catch {
          // stat failed -- skip unreadable attachment
          continue;
        }

        if (attachment.type === "image") {
          const buf = readFileWithinRootSecure(attachment._rootPath, attachment._resolvedPath);
          blocks.push({
            type: "image",
            data: buf.toString("base64"),
            mimeType: guessImageMimeForPath(attachment._resolvedPath),
          });
        } else if (fileSize <= MAX_INLINE_BYTES) {
          // Non-image file attachment -- include content as text if not binary
          const buf = readFileWithinRootSecure(attachment._rootPath, attachment._resolvedPath);
          if (hasNullByte(buf)) {
            blocks.push({
              type: "text",
              text: `[File: ${attachment.path} omitted: binary or unsupported type]`,
            });
          } else {
            const text = buf.toString("utf-8");
            blocks.push({
              type: "text",
              text: `[File: ${attachment.path}]\n${text}`,
            });
          }
        } else {
          // File is too large to inline -- push a placeholder with a truncated preview.
          blocks.push({
            type: "text",
            text: `[File: ${attachment.path} omitted: size ${fileSize} bytes]`,
          });
        }
      } catch {
        // skip unreadable attachment
      }
    }
    return blocks;
  };

  const emitCursorTerminalCommandIfBound = (
    pooled: CursorAcpPooled,
    acpSessionId: string,
    terminalId: string,
  ): void => {
    const owner = cursorAcpSessionOwners.get(acpSessionId);
    if (!owner?.runtime || owner.runtime.kind !== "cursor") return;
    const binding = pooled.terminalWorkLogBindings.get(terminalId);
    if (!binding) return;
    const t = pooled.terminals.get(terminalId);
    if (!t) return;
    const output = t.truncated ? `${t.output}\n…(output truncated)` : t.output;
    const cmdStatus = t.exited ? (t.exitCode === 0 ? "completed" : "failed") : "running";
    emitChatEvent(owner, {
      type: "command",
      command: binding.command,
      cwd: binding.cwd,
      output,
      itemId: binding.itemId,
      turnId: binding.turnId,
      status: cmdStatus,
      ...(t.exited ? { exitCode: t.exitCode } : {}),
    });
  };

  const scheduleCursorTerminalEmit = (
    pooled: CursorAcpPooled,
    terminalId: string,
    acpSessionId: string,
  ): void => {
    const existing = pooled.terminalOutputTimers.get(terminalId);
    if (existing) clearTimeout(existing);
    const DEBOUNCE_MS = 80;
    pooled.terminalOutputTimers.set(
      terminalId,
      setTimeout(() => {
        pooled.terminalOutputTimers.delete(terminalId);
        emitCursorTerminalCommandIfBound(pooled, acpSessionId, terminalId);
      }, DEBOUNCE_MS),
    );
  };

  const wireCursorAcpBridgeHandlers = (pooled: CursorAcpPooled): void => {
    if (cursorAcpBridgeWired.has(pooled)) return;
    cursorAcpBridgeWired.add(pooled);
    pooled.bridge.onSessionUpdate = (note) => {
      const owner = cursorAcpSessionOwners.get(note.sessionId);
      if (!owner?.runtime || owner.runtime.kind !== "cursor") return;
      const previousModeId = owner.runtime.currentModeId;
      if (note.update.sessionUpdate === "current_mode_update") {
        owner.runtime.currentModeId = note.update.currentModeId;
        if (note.update.currentModeId !== "plan") {
          owner.runtime.defaultModeId = note.update.currentModeId;
        }
        // Sync session-level mode fields so ensureCursorSessionState won't
        // revert Cursor back to the old mode on the next turn.
        owner.session.cursorModeId = note.update.currentModeId;
        if (note.update.currentModeId === "plan") {
          owner.session.opencodePermissionMode = "plan";
        } else if (!owner.session.opencodePermissionMode || owner.session.opencodePermissionMode === "plan") {
          owner.session.opencodePermissionMode = "edit";
        }
        syncCursorModeSnapshot(owner, owner.runtime);
        persistChatState(owner);
      } else if (note.update.sessionUpdate === "config_option_update") {
        applyCursorConfigSnapshot(owner, owner.runtime, readCursorAcpConfigSnapshot(note.update.configOptions));
        persistChatState(owner);
      }
      const turnId = owner.runtime.activeTurnId ?? "";
      const resolveTerminal = (tid: string) => {
        const t = pooled.terminals.get(tid);
        if (!t) return null;
        return {
          output: t.output,
          cwd: t.cwd,
          commandLine: t.command,
          exited: t.exited,
          exitCode: t.exitCode,
          truncated: t.truncated,
        };
      };
      const events = mapAcpSessionNotificationToChatEvents(note, { turnId, previousModeId }, resolveTerminal);
      for (const ev of events) {
        if (ev.type === "command") {
          const termId = parseAcpTerminalIdFromCommandItemId(ev.itemId);
          if (termId && pooled.terminals.has(termId)) {
            pooled.terminalWorkLogBindings.set(termId, {
              itemId: ev.itemId,
              turnId: ev.turnId ?? "",
              command: ev.command,
              cwd: ev.cwd,
            });
          }
        }
        emitChatEvent(owner, ev);
      }
    };
    pooled.bridge.onTerminalOutputDelta = (terminalId, acpSessionId) => {
      scheduleCursorTerminalEmit(pooled, terminalId, acpSessionId);
    };
    pooled.bridge.flushTerminalOutput = (terminalId, acpSessionId) => {
      const pending = pooled.terminalOutputTimers.get(terminalId);
      if (pending) {
        clearTimeout(pending);
        pooled.terminalOutputTimers.delete(terminalId);
      }
      emitCursorTerminalCommandIfBound(pooled, acpSessionId, terminalId);
    };
    pooled.bridge.onTerminalDisposed = (terminalId) => {
      const pending = pooled.terminalOutputTimers.get(terminalId);
      if (pending) {
        clearTimeout(pending);
        pooled.terminalOutputTimers.delete(terminalId);
      }
      pooled.terminalWorkLogBindings.delete(terminalId);
    };
    pooled.bridge.onPermission = async (req) => {
      const owner = cursorAcpSessionOwners.get(req.sessionId);
      if (!owner || owner.runtime?.kind !== "cursor") {
        return { outcome: { outcome: "cancelled" } };
      }
      const cursorRt = owner.runtime;
      // Auto-allow the ADE `ask_user` tool — the inline question card
      // provides its own answer UI, and the permission prompt just hides it.
      const rawInput = req.toolCall.rawInput as Record<string, unknown> | null | undefined;
      const rawToolCandidate = rawInput?.name ?? rawInput?.tool ?? rawInput?.toolName;
      const rawToolName = typeof rawToolCandidate === "string" ? rawToolCandidate : null;
      const toolCallTitle = typeof req.toolCall.title === "string" ? req.toolCall.title : "";
      if (isAutoAllowAskUserEnabled() && (isAskUserToolName(rawToolName) || isAskUserToolName(toolCallTitle))) {
        const allow = req.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
        if (allow) {
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }
      }
      const itemId = randomUUID();
      return new Promise<RequestPermissionResponse>((outerResolve) => {
        cursorRt.permissionWaiters.set(itemId, {
          options: req.options,
          resolve: (resp: RequestPermissionResponse) => {
            cursorRt.permissionWaiters.delete(itemId);
            outerResolve(resp);
          },
        });
        const request = buildCursorPendingInputRequest(itemId, req, cursorRt.activeTurnId ?? null);
        emitChatEvent(owner, {
          type: "approval_request",
          itemId,
          kind: "tool_call",
          description: req.toolCall.title ?? "Permission required",
          turnId: cursorRt.activeTurnId ?? undefined,
          detail: { cursorAcp: true, request, toolCall: req.toolCall, options: req.options },
        });
      });
    };
  };

  const ensureCursorRuntime = async (managed: ManagedChatSession): Promise<CursorRuntime> => {
    const poolKey = cursorPoolKeyFor(managed);
    const launchModelSdkId = resolveCursorRuntimeModelSdkId(managed.session);
    const shouldSyncSessionModel = managed.session.model !== launchModelSdkId || !managed.session.modelId;
    if (shouldSyncSessionModel) {
      syncCursorSessionDescriptor(managed, launchModelSdkId);
      persistChatState(managed);
    }
    if (managed.runtime?.kind === "cursor") {
      const existing = managed.runtime;
      if (existing.poolKey !== poolKey) {
        if (existing.acpSessionId) {
          cursorAcpSessionOwners.delete(existing.acpSessionId);
          try {
            await existing.pooled?.connection.unstable_closeSession?.({ sessionId: existing.acpSessionId });
          } catch {
            // ignore
          }
        }
        for (const [, w] of existing.permissionWaiters) {
          w.resolve({ outcome: { outcome: "cancelled" } });
        }
        existing.permissionWaiters.clear();
        if (existing.pooled) releaseCursorAcpConnection(existing.poolKey);
        managed.runtime = null;
      } else {
        if (!existing.pooled) throw new Error("Cursor ACP connection not available");
        wireCursorAcpBridgeHandlers(existing.pooled);
        existing.pooled.bridge.getRootPath = () => managed.laneWorktreePath;
        existing.pooled.bridge.getDirtyFileText = getDirtyFileTextForPath;
        return existing;
      }
    } else if (managed.runtime) {
      teardownRuntime(managed, "handle_close");
    }

    // Evict least-recent runtime if at capacity
    {
      let activeCount = 0;
      for (const [, s] of managedSessions) { if (s.runtime) activeCount++; }
      if (activeCount >= MAX_CONCURRENT_ACTIVE_RUNTIMES) evictLeastRecentRuntime(managed.session.id);
    }

    const pooled = await acquireCursorAcpConnection({
      poolKey,
      agentPath: resolveCursorAgentExecutable().path,
      workspacePath: managed.laneWorktreePath,
      modelSdkId: launchModelSdkId,
      launchSettings: resolveCursorAcpLaunchSettings(managed.session),
      appVersion,
    });
    wireCursorAcpBridgeHandlers(pooled);
    pooled.bridge.getRootPath = () => managed.laneWorktreePath;
    pooled.bridge.getDirtyFileText = getDirtyFileTextForPath;

    const rt: CursorRuntime = {
      kind: "cursor",
      poolKey,
      pooled,
      acpSessionId: null,
      activeTurnId: null,
      busy: false,
      interrupted: false,
      modelSdkId: launchModelSdkId,
      modelConfigId: null,
      currentModelId: null,
      availableModelIds: [],
      pendingSteers: [],
      permissionWaiters: new Map(),
      modeConfigId: null,
      currentModeId: null,
      availableModeIds: [],
      defaultModeId: null,
      configOptions: [],
    };
    managed.runtime = rt;

    const persistedAcp = readPersistedState(managed.session.id)?.acpSessionId?.trim();
    if (persistedAcp && typeof pooled.connection.unstable_resumeSession === "function") {
      try {
        const resumed = await pooled.connection.unstable_resumeSession({
          sessionId: persistedAcp,
          cwd: managed.laneWorktreePath,
        });
        const resumedAvailableModelIds = resumed.models?.availableModels
          ?.map((entry) => String(entry?.modelId ?? "").trim())
          .filter(Boolean) ?? [];
        if (resumedAvailableModelIds.length) {
          rt.availableModelIds = Array.from(new Set([...rt.availableModelIds, ...resumedAvailableModelIds]));
        }
        rt.acpSessionId = persistedAcp;
        rt.currentModeId = resumed.modes?.currentModeId ?? rt.currentModeId;
        rt.defaultModeId = resumed.modes?.currentModeId ?? rt.defaultModeId;
        rt.currentModelId = normalizeCursorReportedModelId(
          resumed.models?.currentModelId,
          rt.availableModelIds,
        ) ?? rt.currentModelId;
        applyCursorConfigSnapshot(managed, rt, readCursorAcpConfigSnapshot(resumed.configOptions));
        if (rt.currentModelId) {
          syncCursorSessionDescriptor(managed, rt.currentModelId);
        }
        syncCursorModeSnapshot(managed, rt);
        cursorAcpSessionOwners.set(persistedAcp, managed);
      } catch {
        // stale session id — create a new ACP session on first prompt
      }
    }

    return rt;
  };

  const runCursorTurn = async (
    managed: ManagedChatSession,
    args: {
      promptText: string;
      displayText: string;
      attachments: AgentChatFileRef[];
      resolvedAttachments: ResolvedAgentChatFileRef[];
      laneDirectiveKey?: string | null;
      turnId?: string;
      optimisticCursorTurnStart?: boolean;
      onDispatched?: () => void;
    },
  ): Promise<void> => {
    const runtime = await ensureCursorRuntime(managed);
    const validation = validateSessionReadyForTurn(managed);
    if (!validation.ready) {
      throw new Error(validation.reason);
    }

    const turnId = args.turnId ?? randomUUID();
    runtime.interrupted = false;
    runtime.busy = true;
    runtime.activeTurnId = turnId;
    setSessionActive(managed);

    const displayText = args.displayText.trim().length ? args.displayText.trim() : args.promptText;
    if (!args.optimisticCursorTurnStart) {
      emitPreparedUserMessage(managed, {
        text: displayText,
        attachments: args.attachments,
        turnId,
        laneDirectiveKey: args.laneDirectiveKey,
        onDispatched: args.onDispatched,
      });
      emitChatEvent(managed, { type: "status", turnStatus: "started", turnId });
      captureTurnBeforeSha(managed);
    }
    emitChatEvent(managed, {
      type: "activity",
      ...initialTurnActivity(managed.session),
      turnId,
    });

    const turnStartedAt = Date.now();
    let shouldDeliverQueuedSteer = false;
    try {
      const autoMemoryPlan = await buildAutoMemoryTurnPlan(managed, displayText, args.attachments);
      const autoMemoryNotice = buildAutoMemorySystemNotice(autoMemoryPlan);
      if (autoMemoryNotice) {
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "memory",
          message: autoMemoryNotice.message,
          detail: autoMemoryNotice.detail,
          turnId,
        });
      }

      let composed = args.promptText;
      const reconstructionContext = managed.pendingReconstructionContext?.trim() ?? "";
      if (reconstructionContext.length) {
        composed = [
          "System context (CTO reconstruction, do not echo verbatim):",
          reconstructionContext,
          "",
          composed,
        ].join("\n");
        managed.pendingReconstructionContext = null;
      }
      if (autoMemoryPlan.contextText.length) {
        composed = `${autoMemoryPlan.contextText}\n\n${composed}`;
      }

      const promptBlocks = buildCursorAcpPromptBlocks(composed, args.resolvedAttachments);

      if (!runtime.acpSessionId) {
        if (!runtime.pooled) throw new Error("Cursor ACP connection not available");
        const created = await runtime.pooled.connection.newSession(cursorAcpSessionRequest({
          cwd: managed.laneWorktreePath,
        }) as Parameters<typeof runtime.pooled.connection.newSession>[0]);
        const createdAvailableModelIds = created.models?.availableModels
          ?.map((entry) => String(entry?.modelId ?? "").trim())
          .filter(Boolean) ?? [];
        if (createdAvailableModelIds.length) {
          runtime.availableModelIds = Array.from(new Set([...runtime.availableModelIds, ...createdAvailableModelIds]));
        }
        const sid = created.sessionId;
        runtime.acpSessionId = sid;
        runtime.currentModeId = created.modes?.currentModeId ?? runtime.currentModeId;
        runtime.defaultModeId = created.modes?.currentModeId ?? runtime.defaultModeId;
        runtime.currentModelId = normalizeCursorReportedModelId(
          created.models?.currentModelId,
          runtime.availableModelIds,
        ) ?? runtime.currentModelId;
        applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(created.configOptions));
        if (runtime.currentModelId) {
          syncCursorSessionDescriptor(managed, runtime.currentModelId);
        }
        syncCursorModeSnapshot(managed, runtime);
        cursorAcpSessionOwners.set(sid, managed);
        persistChatState(managed);
      }

      await ensureCursorSessionState(managed, runtime);
      persistChatState(managed);

      logger.info("agent_chat.cursor_prompt_start", {
        sessionId: managed.session.id,
        turnId,
        model: managed.session.model,
        durationMs: Date.now() - turnStartedAt,
      });

      if (!runtime.pooled) throw new Error("Cursor ACP connection not available");

      // Signal dispatch completion before awaiting the prompt so the dispatch
      // resolves as soon as the request is sent rather than after it returns.
      if (args.onDispatched) {
        args.onDispatched();
        args.onDispatched = undefined;
      }

      const promptRes = await runtime.pooled.connection.prompt({
        sessionId: runtime.acpSessionId!,
        prompt: promptBlocks,
      });

      await refreshCursorSessionState(managed, runtime, "after_prompt");

      persistDeliveredLaneDirectiveKey(managed, args.laneDirectiveKey);

      const descriptor = resolveSessionModelDescriptor(managed.session);
      const usage = promptRes.usage
        ? {
            inputTokens: promptRes.usage.inputTokens,
            outputTokens: promptRes.usage.outputTokens,
            cacheReadTokens: promptRes.usage.cachedReadTokens ?? null,
            cacheCreationTokens: promptRes.usage.cachedWriteTokens ?? null,
          }
        : undefined;

      void emitTurnDiffSummaryIfChanged(managed, turnId);
      if (runtime.interrupted || promptRes.stopReason === "cancelled") {
        markSessionIdleWithFreshCache(managed);
        cancelQueuedSteers(managed, runtime, "interrupted");
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        for (const ev of mapStopReasonToTerminalEvents({
          stopReason: "cancelled",
          turnId,
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
          usage,
        })) {
          emitChatEvent(managed, ev);
        }
      } else {
        markSessionIdleWithFreshCache(managed);
        emitChatEvent(managed, { type: "status", turnStatus: "completed", turnId });
        for (const ev of mapStopReasonToTerminalEvents({
          stopReason: promptRes.stopReason,
          turnId,
          model: managed.session.model,
          ...(managed.session.modelId
            ? { modelId: managed.session.modelId }
            : descriptor
              ? { modelId: descriptor.id }
              : {}),
          usage,
        })) {
          emitChatEvent(managed, ev);
        }
        shouldDeliverQueuedSteer = runtime.pendingSteers.length > 0;
      }

      appendWorkerActivityToCto(managed, {
        activityType: "chat_turn",
        summary: "Cursor agent turn completed.",
      });
      persistChatState(managed);
    } catch (error) {
      markSessionIdleWithFreshCache(managed);
      const msg = error instanceof Error ? error.message : String(error);

      // Drain pending permission waiters so they don't block future sends.
      for (const [, w] of runtime.permissionWaiters) {
        w.resolve({ outcome: { outcome: "cancelled" } });
      }
      runtime.permissionWaiters.clear();

      // Drop queued steers so they don't replay on the next turn.
      cancelQueuedSteers(managed, runtime, runtime.interrupted ? "interrupted" : "failed");
      void emitTurnDiffSummaryIfChanged(managed, turnId);

      if (runtime.interrupted) {
        emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId });
        for (const ev of mapStopReasonToTerminalEvents({
          stopReason: "cancelled",
          turnId,
          model: managed.session.model,
          ...(managed.session.modelId ? { modelId: managed.session.modelId } : {}),
        })) {
          emitChatEvent(managed, ev);
        }
      } else {
        emitChatEvent(managed, { type: "error", message: msg, turnId });
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
          summary: `Turn failed: ${msg}`,
        });
      }
      persistChatState(managed);
    } finally {
      runtime.busy = false;
      runtime.activeTurnId = null;
      if (managed.session.status === "active") {
        setSessionIdle(managed);
      }
    }
    if (!managed.closed && shouldDeliverQueuedSteer) {
      try {
        await deliverNextQueuedSteer(managed, runtime);
      } catch (error) {
        logger.warn("agent_chat.cursor_deliver_queued_steer_failed", {
          sessionId: managed.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
      laneDirectiveKey,
      providerSlashCommand,
      forceClaudeUserMessage,
      onDispatched,
      turnId,
      optimisticCursorTurnStart,
    } = prepared;

    // OpenCode runtime dispatch
    if (managed.session.provider === "opencode") {
      if (!managed.runtime || managed.runtime.kind !== "opencode") {
        const restarted = await startOpenCodeSessionRuntime(managed);
        if (restarted !== "handled" || !managed.runtime) {
          throw new Error(`OpenCode runtime is not available for session '${managed.session.id}'.`);
        }
      }
      if (reasoningEffort) {
        managed.session.reasoningEffort = normalizeReasoningEffort(reasoningEffort);
      }
      // Re-sync permission mode so mid-session changes take effect on this turn.
      if (managed.runtime?.kind === "opencode") {
        const chatConfig = resolveChatConfig();
        const previousPermissionMode = managed.runtime.permissionMode;
        managed.runtime.permissionMode = resolveSessionOpenCodePermissionMode(
          managed.session,
          chatConfig.opencodePermissionMode,
        );
        if (managed.runtime.permissionMode !== previousPermissionMode) {
          persistChatState(managed);
        }
      }
      await runTurn(managed, {
        promptText,
        displayText: visibleText,
        attachments,
        resolvedAttachments,
        laneDirectiveKey,
        providerSlashCommand,
        onDispatched,
      });
      return;
    }

    if (managed.session.provider === "cursor") {
      const chatConfig = resolveChatConfig();
      managed.session.opencodePermissionMode = resolveSessionOpenCodePermissionMode(
        managed.session,
        chatConfig.opencodePermissionMode,
      );
      managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
      await runCursorTurn(managed, {
        promptText,
        displayText: visibleText,
        attachments,
        resolvedAttachments,
        laneDirectiveKey,
        turnId,
        optimisticCursorTurnStart,
        onDispatched,
      });
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

      // Re-sync codex approval policy so mid-session changes take effect on this turn.
      if (runtime.threadResumed) {
        const prevApproval = managed.session.codexApprovalPolicy;
        const prevSandbox = managed.session.codexSandbox;
        const prevConfigSource = managed.session.codexConfigSource;
        resolveCodexThreadParams(managed);
        if (
          managed.session.codexConfigSource !== prevConfigSource
          || managed.session.codexApprovalPolicy !== prevApproval
          || managed.session.codexSandbox !== prevSandbox
        ) {
          // Policy or config source drifted — force a re-resume so the codex
          // server picks up the new ADE-controlled settings on this turn.
          runtime.threadResumed = false;
        }
      }

      if (!runtime.threadResumed) {
        const threadIdToResume = managed.session.threadId || readPersistedState(sessionId)?.threadId;
        const { codexPolicy } = resolveCodexThreadParams(managed);

        if (threadIdToResume) {
          try {
            await runtime.request("thread/resume", {
              threadId: threadIdToResume,
              model: managed.session.model,
              ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
              cwd: managed.laneWorktreePath,
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
            await startFreshCodexThread(managed, runtime, codexPolicy);
          }
        } else {
          await startFreshCodexThread(managed, runtime, codexPolicy);
        }
      }

      await sendCodexMessage(managed, {
        promptText,
        displayText: visibleText,
        attachments,
        resolvedAttachments,
        laneDirectiveKey,
        providerSlashCommand,
        onDispatched,
      });
      return;
    }

    const nextClaudeEffort = validateReasoningEffort("claude", normalizeReasoningEffort(reasoningEffort));
    if (nextClaudeEffort) {
      managed.session.reasoningEffort = nextClaudeEffort;
    }

    ensureClaudeSessionRuntime(managed);
    await runClaudeTurn(managed, {
      promptText,
      displayText: visibleText,
      attachments,
      resolvedAttachments,
      laneDirectiveKey,
      providerSlashCommand,
      forceClaudeUserMessage,
      onDispatched,
    });
  };

  const sendMessage = async (
    args: AgentChatSendArgs,
    options?: { awaitDispatch?: boolean },
  ): Promise<void> => {
    const dispatchStartedAt = Date.now();
    const prepared = prepareSendMessage(args);
    if (!prepared) return;
    prepared.managed.lastActivityTimestamp = Date.now();
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

    if (prepared.managed.session.provider === "cursor") {
      const turnId = randomUUID();
      prepared.turnId = turnId;
      prepared.optimisticCursorTurnStart = true;
      emitChatEvent(prepared.managed, {
        type: "user_message",
        text: prepared.visibleText,
        attachments: prepared.attachments,
        turnId,
      });
      emitChatEvent(prepared.managed, { type: "status", turnStatus: "started", turnId });
      captureTurnBeforeSha(prepared.managed);
      emitChatEvent(prepared.managed, {
        type: "activity",
        ...initialTurnActivity(prepared.managed.session),
        turnId,
      });
      setSessionActive(prepared.managed);
      persistChatState(prepared.managed);
      // NOTE: onDispatched is NOT called here. It will be called inside
      // runCursorTurn after the real ACP prompt has been initiated, so the
      // caller's awaitDispatch promise resolves only once the backend has
      // acknowledged the prompt.
    }

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

  const steer = async ({ sessionId, text, attachments = [] }: AgentChatSteerArgs): Promise<AgentChatSteerResult> => {
    const trimmed = text.trim();
    const steerId = randomUUID();
    if (!trimmed.length) {
      return { steerId, queued: false };
    }

    const managed = ensureManagedSession(sessionId);
    if (attachments.length && managed.session.provider !== "claude" && managed.session.provider !== "codex") {
      throw new Error("Attachments are only supported for Claude and Codex follow-up messages right now.");
    }

    // OpenCode runtime steer
    if (managed.runtime?.kind === "opencode") {
      const runtime = managed.runtime;
      if (runtime.busy) {
        enqueueSteerOrDrop(managed, runtime, sessionId, steerId, trimmed);
        return { steerId, queued: true };
      }
      const preparedSteer = prepareSendMessage({
        sessionId,
        text: trimmed,
        displayText: trimmed,
        attachments: [],
      });
      if (!preparedSteer) {
        return { steerId, queued: false };
      }
      await executePreparedSendMessage(preparedSteer);
      return { steerId, queued: false };
    }

    if (managed.session.provider === "cursor") {
      if (managed.runtime?.kind === "cursor" && managed.runtime.busy) {
        const rt = managed.runtime;
        if (rt.pendingSteers.length >= MAX_PENDING_STEERS) {
          logger.warn("agent_chat.steer_queue_full", { sessionId, queueSize: rt.pendingSteers.length });
          emitChatEvent(managed, {
            type: "system_notice",
            noticeKind: "info",
            message: "Steer dropped — the queue is full. Wait for the current turn to finish.",
            turnId: rt.activeTurnId ?? undefined,
          });
          return { steerId, queued: false };
        }
        rt.pendingSteers.push({ steerId, text: trimmed, attachments: [], resolvedAttachments: [] });
        emitChatEvent(managed, {
          type: "user_message",
          text: trimmed,
          steerId,
          turnId: rt.activeTurnId ?? undefined,
          deliveryState: "queued",
        });
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          steerId,
          message: "Message queued — will be sent when the current turn completes.",
          turnId: rt.activeTurnId ?? undefined,
        });
        persistChatState(managed);
        return { steerId, queued: true };
      }
      const preparedSteer = prepareSendMessage({
        sessionId,
        text: trimmed,
        displayText: trimmed,
        attachments: [],
      });
      if (!preparedSteer) {
        return { steerId, queued: false };
      }
      await executePreparedSendMessage(preparedSteer);
      return { steerId, queued: false };
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      await runtime.collaborationModesReady?.catch(() => {});
      if (!managed.session.threadId || !runtime.activeTurnId) {
        throw new Error("No active turn to steer.");
      }

      const preparedSteer = prepareSendMessage({
        sessionId,
        text: trimmed,
        displayText: trimmed,
        attachments,
      });
      if (!preparedSteer) {
        return { steerId, queued: false };
      }

      const input: Array<Record<string, unknown>> = [
        {
          type: "text",
          text: trimmed,
          text_elements: [],
        },
      ];
      for (const attachment of preparedSteer.resolvedAttachments) {
        const stagedPath = stageAttachmentForCodexInput(attachment);
        if (attachment.type === "image") {
          input.push({ type: "localImage", path: stagedPath });
          continue;
        }
        const name = path.basename(attachment.path) || attachment.path;
        input.push({ type: "mention", name, path: stagedPath });
      }

      await runtime.request("turn/steer", {
        threadId: managed.session.threadId,
        expectedTurnId: runtime.activeTurnId,
        input,
      });
      emitChatEvent(managed, {
        type: "user_message",
        text: preparedSteer.visibleText,
        ...(preparedSteer.attachments.length ? { attachments: preparedSteer.attachments } : {}),
        steerId,
        deliveryState: "delivered",
        turnId: runtime.activeTurnId,
      });
      return { steerId, queued: false };
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    const preparedSteer = prepareSendMessage({
      sessionId,
      text: trimmed,
      displayText: trimmed,
      attachments,
    });
    if (!preparedSteer) {
      return { steerId, queued: false };
    }
    if (runtime.busy) {
      enqueueSteerOrDrop(
        managed,
        runtime,
        sessionId,
        steerId,
        preparedSteer.visibleText,
        preparedSteer.attachments,
        preparedSteer.resolvedAttachments,
      );
      return { steerId, queued: true };
    }
    await executePreparedSendMessage(preparedSteer);
    return { steerId, queued: false };
  };

  const cancelSteer = async ({ sessionId, steerId }: AgentChatCancelSteerArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);
    const runtime = managed.runtime;
    if (!runtime || runtime.kind === "codex") return;

    const queue = runtime.pendingSteers;
    const idx = queue.findIndex((s) => s.steerId === steerId);
    if (idx === -1) return;

    queue.splice(idx, 1);
    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      steerId,
      message: "Queued message cancelled.",
      turnId: runtime.activeTurnId ?? undefined,
    });
    persistChatState(managed);
  };

  const editSteer = async ({ sessionId, steerId, text }: AgentChatEditSteerArgs): Promise<void> => {
    const trimmed = text.trim();
    const managed = ensureManagedSession(sessionId);
    const runtime = managed.runtime;
    if (!runtime || runtime.kind === "codex") return;

    const idx = runtime.pendingSteers.findIndex((s) => s.steerId === steerId);
    if (idx === -1) return;

    if (!trimmed.length) {
      runtime.pendingSteers.splice(idx, 1);
      emitChatEvent(managed, {
        type: "system_notice",
        noticeKind: "info",
        steerId,
        message: "Queued message cancelled (empty edit).",
        turnId: runtime.activeTurnId ?? undefined,
      });
      persistChatState(managed);
      return;
    }

    runtime.pendingSteers[idx].text = trimmed;
    emitChatEvent(managed, {
      type: "user_message",
      text: trimmed,
      steerId,
      turnId: runtime.activeTurnId ?? undefined,
      deliveryState: "queued",
    });
    persistChatState(managed);
  };

  const interrupt = async ({ sessionId }: AgentChatInterruptArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // OpenCode runtime interrupt
    if (managed.runtime?.kind === "opencode") {
      if (managed.runtime.interrupted) return;
      managed.runtime.interrupted = true;
      managed.runtime.eventAbortController?.abort();
      try {
        await managed.runtime.handle.client.session.abort({
          path: { id: managed.runtime.handle.sessionId },
          query: { directory: managed.runtime.handle.directory },
        });
      } catch {
        // Ignore provider abort failures; SSE cancellation still tears the turn down.
      }
      cancelQueuedSteers(managed, managed.runtime, "interrupted");
      persistChatState(managed);
      for (const pending of managed.runtime.pendingApprovals.values()) {
        managed.runtime.handle.client.postSessionIdPermissionsPermissionId({
          path: { id: managed.runtime.handle.sessionId, permissionID: pending.permissionId },
          query: { directory: managed.runtime.handle.directory },
          body: { response: "reject" },
        }).catch(() => {});
      }
      managed.runtime.pendingApprovals.clear();
      return;
    }

    if (managed.runtime?.kind === "cursor") {
      const rt = managed.runtime;
      rt.interrupted = true;
      if (rt.acpSessionId) {
        try {
          await rt.pooled?.connection.cancel({ sessionId: rt.acpSessionId });
        } catch {
          // ignore
        }
      }
      for (const [, w] of rt.permissionWaiters) {
        w.resolve({ outcome: { outcome: "cancelled" } });
      }
      rt.permissionWaiters.clear();
      cancelQueuedSteers(managed, rt, "interrupted");
      return;
    }

    if (managed.session.provider === "codex") {
      const runtime = await ensureCodexSessionRuntime(managed);
      await runtime.collaborationModesReady?.catch(() => {});
      if (!managed.session.threadId || !runtime.activeTurnId) return;
      rememberInterruptedCodexTurn(runtime, runtime.activeTurnId);
      await runtime.request("turn/interrupt", {
        threadId: managed.session.threadId,
        turnId: runtime.activeTurnId
      });
      stopActiveCodexSubagents(managed, runtime, runtime.activeTurnId ?? undefined, "Interrupted by user");
      return;
    }

    const runtime = ensureClaudeSessionRuntime(managed);
    // Idempotency guard: skip if already interrupted (e.g. rapid cancel clicks)
    if (runtime.interrupted) return;
    logger.info("agent_chat.turn_interrupt_requested", {
      sessionId,
      provider: "claude",
      turnId: runtime.activeTurnId,
      busy: runtime.busy,
      warmupInFlight: Boolean(runtime.v2WarmupDone),
    });
    // Set interrupted before touching the runtime so the streaming loop can
    // break cleanly while the underlying SDK stream is aborted below.
    runtime.interrupted = true;
    const interruptedTurnId = runtime.activeTurnId;
    if (runtime.busy && interruptedTurnId) {
      runtime.interruptEventsEmitted = true;
      runtime.busy = false;
      runtime.activeTurnId = null;
      emitChatEvent(managed, { type: "status", turnStatus: "interrupted", turnId: interruptedTurnId });
      emitChatEvent(managed, {
        type: "done",
        turnId: interruptedTurnId,
        status: "interrupted",
      });
    }
    cancelClaudeWarmup(managed, runtime, "interrupt");
    const interruptedSession = runtime.v2Session;
    if (interruptedSession) {
      runtime.sdkSessionId = runtime.sdkSessionId ?? interruptedSession.sessionId ?? null;
      try { interruptedSession.close(); } catch { /* ignore */ }
      runtime.v2Session = null;
      runtime.v2WarmupDone = null;
    }
    cancelQueuedSteers(managed, runtime, "interrupted");
    // Drain pending approvals so their promises settle instead of hanging forever
    for (const pending of runtime.approvals.values()) {
      pending.resolve({ decision: "cancel" });
    }
    runtime.approvals.clear();

    // Emit subagent_result "stopped" for every active subagent so the UI
    // properly transitions them from "running" → "stopped" (matching Claude Code CLI behaviour).
    const turnId = interruptedTurnId ?? undefined;
    for (const { taskId } of runtime.activeSubagents.values()) {
      emitChatEvent(managed, {
        type: "subagent_result",
        taskId,
        status: "stopped",
        summary: "Interrupted by user",
        turnId,
      });
    }
    runtime.activeSubagents.clear();
    persistChatState(managed);
    logger.info("agent_chat.turn_interrupt_completed", {
      sessionId,
      provider: "claude",
      turnId: interruptedTurnId,
      busy: runtime.busy,
    });
  };

  const resumeSession = async ({ sessionId }: { sessionId: string }): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    refreshManagedLaneLaunchContext(managed, { purpose: "resume this chat" });
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
        const { codexPolicy } = resolveCodexThreadParams(managed);
        try {
          await runtime.request("thread/resume", {
            threadId,
            model: managed.session.model,
            ...(managed.session.reasoningEffort ? { reasoningEffort: managed.session.reasoningEffort } : {}),
            cwd: managed.laneWorktreePath,
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
          await startFreshCodexThread(managed, runtime, codexPolicy);
        }
      }
      // Re-sync codex approval policy from persisted/config settings
      managed.session.codexApprovalPolicy = persisted?.codexApprovalPolicy ?? managed.session.codexApprovalPolicy;
      managed.session.codexSandbox = persisted?.codexSandbox ?? managed.session.codexSandbox;
      managed.session.codexConfigSource = persisted?.codexConfigSource ?? managed.session.codexConfigSource;
      managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
    } else if (managed.session.provider === "cursor") {
      await ensureCursorRuntime(managed);
      managed.session.opencodePermissionMode = persisted?.opencodePermissionMode ?? managed.session.opencodePermissionMode;
      managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
      enforceManagedLocalHarnessPermissionMode(managed);
      sessionService.setResumeCommand(sessionId, `chat:cursor:${sessionId}`);
    } else if (managed.session.provider === "opencode" || (managed.session.modelId && !isCliWrappedModelId(managed.session.modelId))) {
      const result = await startOpenCodeSessionRuntime(managed);
      if (result === "handled" && managed.runtime?.kind === "opencode") {
        managed.session.opencodePermissionMode = persisted?.opencodePermissionMode ?? managed.session.opencodePermissionMode;
        managed.session.permissionMode = syncLegacyPermissionMode(managed.session) ?? managed.session.permissionMode;
        enforceManagedLocalHarnessPermissionMode(managed, managed.runtime.modelDescriptor);
        managed.runtime.permissionMode = resolveSessionOpenCodePermissionMode(
          managed.session,
          resolveChatConfig().opencodePermissionMode,
        );
        sessionService.setResumeCommand(sessionId, `chat:opencode:${sessionId}`);
      } else {
        if (managed.session.provider === "opencode") {
          throw new Error(`Unable to resume OpenCode runtime for model '${managed.session.model}'.`);
        }
        // Fallthrough to Claude — SDK manages history via sdkSessionId
        ensureClaudeSessionRuntime(managed);
        // Re-sync permission mode from persisted/config settings
        const fallbackPermMode = resolveClaudeTurnPermissionMode(managed);
        if (managed.runtime?.kind === "claude" && managed.runtime.v2Session) {
          const control = getClaudeV2SessionControl(managed.runtime.v2Session);
          if (typeof control.setPermissionMode === "function") {
            try {
              await control.setPermissionMode(fallbackPermMode);
            } catch {
              // Session was created without --dangerously-skip-permissions.
              // Invalidate so it is recreated with the correct mode.
              try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
              managed.runtime.v2Session = null;
              managed.runtime.v2WarmupDone = null;
            }
          }
        }
        sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
      }
    } else {
      // Claude — SDK manages history via sdkSessionId
      ensureClaudeSessionRuntime(managed);
      // Re-sync permission mode from persisted/config settings
      const claudePermMode = resolveClaudeTurnPermissionMode(managed);
      if (managed.runtime?.kind === "claude" && managed.runtime.v2Session) {
        const control = getClaudeV2SessionControl(managed.runtime.v2Session);
        if (typeof control.setPermissionMode === "function") {
          try {
            await control.setPermissionMode(claudePermMode);
          } catch {
            try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
            managed.runtime.v2Session = null;
            managed.runtime.v2WarmupDone = null;
          }
        }
      }
      sessionService.setResumeCommand(sessionId, `chat:claude:${sessionId}`);
    }

    sessionService.reopen(sessionId);
    setSessionIdle(managed);
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
    const liveManaged = managedSessions.get(row.id) ?? null;
    const liveSession = liveManaged?.session ?? null;
    const provider = liveSession?.provider ?? persisted?.provider ?? providerFromToolType(row.toolType);
    const fallbackModel = liveSession?.model ?? persisted?.model ?? fallbackModelForProvider(provider);
    const hydratedModelId = liveSession?.modelId
      ?? persisted?.modelId
      ?? resolveModelIdFromStoredValue(fallbackModel, provider)
      ?? (provider === "opencode"
        ? DEFAULT_OPENCODE_MODEL_ID
        : provider === "cursor"
          ? DEFAULT_CURSOR_DESCRIPTOR?.id
          : undefined);
    const model = provider === "opencode" ? (hydratedModelId ?? fallbackModel) : fallbackModel;
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
      ...(liveSession?.opencodePermissionMode || persisted?.opencodePermissionMode
        ? { opencodePermissionMode: liveSession?.opencodePermissionMode ?? persisted?.opencodePermissionMode }
        : {}),
      ...(liveSession?.cursorModeSnapshot || persisted?.cursorModeSnapshot
        ? { cursorModeSnapshot: liveSession?.cursorModeSnapshot ?? persisted?.cursorModeSnapshot }
        : {}),
      ...(liveSession?.cursorModeId !== undefined || persisted?.cursorModeId !== undefined
        ? { cursorModeId: liveSession?.cursorModeId ?? persisted?.cursorModeId ?? null }
        : {}),
      ...(liveSession?.cursorConfigValues || persisted?.cursorConfigValues
        ? { cursorConfigValues: liveSession?.cursorConfigValues ?? persisted?.cursorConfigValues }
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
      completion: liveSession?.completion ?? persisted?.completion ?? null,
      status: liveSession?.status ?? (row.status === "running" ? "idle" : "ended"),
      idleSinceAt: (liveSession?.status ?? (row.status === "running" ? "idle" : "ended")) === "idle"
        ? liveSession?.idleSinceAt ?? persisted?.idleSinceAt ?? null
        : null,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastActivityAt: liveSession?.lastActivityAt ?? persisted?.updatedAt ?? row.endedAt ?? row.startedAt,
      lastOutputPreview: row.lastOutputPreview,
      summary: row.summary ?? null,
      ...((hasLivePendingInput(liveManaged) || persisted?.awaitingInput === true) ? { awaitingInput: true } : {}),
      ...(liveSession?.threadId || persisted?.threadId
        ? { threadId: liveSession?.threadId ?? persisted?.threadId }
        : {}),
      ...(liveSession?.requestedCwd != null || persisted?.requestedCwd != null
        ? { requestedCwd: liveSession?.requestedCwd ?? persisted?.requestedCwd ?? null }
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
      enforceManagedLocalHarnessPermissionMode(managed);
      normalizeSessionNativePermissionControls(managed.session, resolveChatConfig());
      managed.selectedExecutionLaneId = selectedExecutionLaneId ?? managed.selectedExecutionLaneId;
      refreshReconstructionContext(managed);
      await refreshHeadShaStartForManagedExecutionLane(managed);
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
      if (workerIdentity?.adapterType === "openclaw-webhook" || workerIdentity?.adapterType === "process") return "opencode";
      if (preferredProviderRaw.includes("codex") || preferredProviderRaw.includes("openai")) return "codex";
      if (preferredProviderRaw.includes("claude") || preferredProviderRaw.includes("anthropic")) return "claude";
      return "opencode";
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
      if (!resolvedDescriptor.isCliWrapped) return "opencode";
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
    refreshReconstructionContext(managed);
    await refreshHeadShaStartForManagedExecutionLane(managed);
    persistChatState(managed);
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
    const resolvedDecision: AgentChatApprovalDecision = decision ?? "decline";
    const localPending = managed.localPendingInputs.get(itemId);
    if (localPending) {
      managed.localPendingInputs.delete(itemId);
      localPending.resolve({ decision: resolvedDecision, answers, responseText });
      emitPendingInputResolved(managed, {
        itemId,
        decision: resolvedDecision,
        turnId: localPending.request.turnId ?? null,
      });
      return;
    }

    if (managed.runtime?.kind === "codex") {
      const runtime = managed.runtime;
      const pending = runtime.approvals.get(itemId);
      if (!pending) {
        logger.warn("agent_chat.codex_approval_not_found", {
          sessionId,
          itemId,
          decision: resolvedDecision,
        });
        emitPendingInputResolved(managed, {
          itemId,
          decision: resolvedDecision === "accept" || resolvedDecision === "accept_for_session" ? "cancel" : resolvedDecision,
          turnId: null,
        });
        emitChatEvent(managed, {
          type: "system_notice",
          noticeKind: "info",
          message: "That request is no longer active.",
        });
        persistChatState(managed);
        return;
      }
      const ensureWritable = (): void => {
        if (!runtime.process.stdin.writable) {
          throw new Error("Codex app-server connection is unavailable. Retry after the session reconnects.");
        }
      };

      // Plan approval is created locally (not a JSON-RPC server request).
      // On approve, send a follow-up turn telling Codex to implement.
      // On reject, send feedback for revision.
      if (pending.kind === "plan_approval") {
        const approved = resolvedDecision === "accept" || resolvedDecision === "accept_for_session";
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
        runtime.approvals.delete(itemId);
        emitPendingInputResolved(managed, {
          itemId,
          decision: resolvedDecision,
          turnId: pending.request?.turnId ?? null,
        });
        return;
      }

      if (pending.kind === "permissions") {
        const approved = resolvedDecision === "accept" || resolvedDecision === "accept_for_session";
        ensureWritable();
        runtime.sendResponse(pending.requestId, {
          permissions: approved ? (pending.permissions ?? {}) : {},
          scope: resolvedDecision === "accept_for_session" ? "session" : "turn",
        });
        runtime.approvals.delete(itemId);
        emitPendingInputResolved(managed, {
          itemId,
          decision: resolvedDecision,
          turnId: pending.request?.turnId ?? null,
        });
        return;
      }
      if (pending.kind === "structured_question") {
        if (resolvedDecision === "decline" || resolvedDecision === "cancel") {
          // Native Codex request_user_input only accepts an answers map.
          // Empty answers represent a declined/cancelled prompt without
          // interrupting the surrounding turn.
          ensureWritable();
          runtime.sendResponse(pending.requestId, { answers: {} });
          runtime.approvals.delete(itemId);
          emitPendingInputResolved(managed, {
            itemId,
            decision: resolvedDecision,
            turnId: pending.request?.turnId ?? null,
          });
          return;
        }
        const normalizedAnswers = normalizePendingInputAnswers(pending.request, answers, responseText);
        ensureWritable();
        runtime.sendResponse(pending.requestId, {
          answers: Object.fromEntries(
            Object.entries(normalizedAnswers).map(([questionId, values]) => [questionId, { answers: values }]),
          ),
        });
        runtime.approvals.delete(itemId);
        emitPendingInputResolved(managed, {
          itemId,
          decision: resolvedDecision,
          turnId: pending.request?.turnId ?? null,
        });
        return;
      }

      const mapped = mapApprovalDecisionForCodex(resolvedDecision);
      ensureWritable();
      runtime.sendResponse(pending.requestId, { decision: mapped });
      runtime.approvals.delete(itemId);
      emitPendingInputResolved(managed, {
        itemId,
        decision: resolvedDecision,
        turnId: pending.request?.turnId ?? null,
      });
      return;
    }

    if (managed.runtime?.kind === "claude") {
      const pending = managed.runtime.approvals.get(itemId);
      if (!pending) {
        // The approval may have already been resolved (e.g. double-click,
        // turn interrupted, or stale UI state). Log and return silently
        // instead of throwing — the UI will clear the stale entry.
        logger.warn("agent_chat.claude_approval_not_found", {
          sessionId,
          itemId,
          decision,
        });
        return;
      }
      managed.runtime.approvals.delete(itemId);
      pending.resolve({ decision: resolvedDecision, answers, responseText });
      emitPendingInputResolved(managed, {
        itemId,
        decision: resolvedDecision,
        turnId: pending.request?.turnId ?? null,
      });
      return;
    }

    if (managed.runtime?.kind === "opencode") {
      const pending = managed.runtime.pendingApprovals.get(itemId);
      if (!pending) {
        throw new Error(`No pending approval found for item '${itemId}'.`);
      }
      managed.runtime.pendingApprovals.delete(itemId);
      await managed.runtime.handle.client.postSessionIdPermissionsPermissionId({
        path: {
          id: managed.runtime.handle.sessionId,
          permissionID: pending.permissionId,
        },
        query: {
          directory: managed.runtime.handle.directory,
        },
        body: {
          response: resolvedDecision === "accept_for_session"
            ? "always"
            : resolvedDecision === "accept"
              ? "once"
              : "reject",
        },
      });
      emitPendingInputResolved(managed, {
        itemId,
        decision: resolvedDecision,
        turnId: pending.request?.turnId ?? null,
      });
      return;
    }

    if (managed.runtime?.kind === "cursor") {
      const pending = managed.runtime.permissionWaiters.get(itemId);
      if (!pending) {
        // Treat missing waiter as a benign race (e.g. the Cursor turn already
        // resolved or was cancelled before the user responded). Simply no-op.
        logger.debug("agent_chat.cursor_permission_waiter_missing", {
          sessionId,
          itemId,
        });
        return;
      }
      managed.runtime.permissionWaiters.delete(itemId);
      pending.resolve(mapChatDecisionToCursorPermission(resolvedDecision, pending.options, answers));
      emitPendingInputResolved(managed, {
        itemId,
        decision: resolvedDecision,
        turnId: managed.runtime.activeTurnId ?? null,
      });
      return;
    }

    logger.warn("agent_chat.approval_without_live_runtime", {
      sessionId,
      itemId,
      decision: resolvedDecision,
    });
    emitPendingInputResolved(managed, {
      itemId,
      decision: resolvedDecision === "accept" || resolvedDecision === "accept_for_session" ? "cancel" : resolvedDecision,
      turnId: null,
    });
    emitChatEvent(managed, {
      type: "system_notice",
      noticeKind: "info",
      message: "That request is no longer active.",
    });
    persistChatState(managed);
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

  const availableModelsRequests = new Map<string, Promise<AgentChatModelInfo[]>>();

  const loadAvailableModels = async (args: {
    provider: AgentChatProvider;
    activateRuntime?: boolean;
  }): Promise<AgentChatModelInfo[]> => {
    const provider = args.provider;
    if (provider === "codex") {
      return listCodexModelsFromAppServer();
    }
    if (provider === "claude") {
      return listClaudeModelsFromSdk();
    }

    if (provider === "cursor") {
      try {
        const agentPath = resolveCursorAgentExecutable().path;
        const ordered = await discoverCursorCliModelDescriptors(agentPath);
        const preferred = pickDefaultCursorDescriptorFromCliList(ordered);
        return ordered.map((d) => ({
          id: d.id,
          displayName: d.displayName,
          description: `${d.displayName} (Cursor CLI)`,
          isDefault: preferred ? d.id === preferred.id : false,
          reasoningEfforts: d.reasoningTiers?.map((tier) => ({
            effort: tier,
            description: `${tier} reasoning`,
          })) ?? [],
        }));
      } catch {
        return [];
      }
    }

    if (provider === "opencode") {
      try {
        const effectiveConfig = projectConfigService.get().effective;
        let modelIds: string[];
        let error: string | null;
        if (args.activateRuntime) {
          const inventory = await probeOpenCodeProviderInventory({
            projectRoot,
            projectConfig: effectiveConfig,
            logger,
            force: false,
          });
          modelIds = inventory.modelIds;
          error = inventory.error;
        } else {
          const peeked = peekOpenCodeInventoryCache({
            projectRoot,
            projectConfig: effectiveConfig,
          });
          if (peeked) {
            modelIds = peeked.modelIds;
            error = peeked.error;
          } else {
            const inventory = await probeOpenCodeProviderInventory({
              projectRoot,
              projectConfig: effectiveConfig,
              logger,
              force: false,
            });
            modelIds = inventory.modelIds;
            error = inventory.error;
          }
        }
        if (error) {
          logger.warn("agent_chat.opencode_inventory_empty", { error });
        }
        if (modelIds.length === 0) {
          return [];
        }
        const rows: Array<{
          id: string;
          displayName: string;
          description: string;
          isDefault: boolean;
          reasoningEfforts: Array<{ effort: string; description: string }>;
        }> = [];
        let firstRow = true;
        for (const id of modelIds) {
          const descriptor = getModelById(id);
          if (!descriptor) continue;
          const tiers = descriptor.reasoningTiers ?? [];
          rows.push({
            id: descriptor.id,
            displayName: descriptor.displayName,
            description: `${descriptor.displayName} (OpenCode)`,
            isDefault: firstRow,
            reasoningEfforts: tiers.map((tier) => ({
              effort: tier,
              description: `${tier} reasoning`,
            })),
          });
          firstRow = false;
        }
        return rows;
      } catch (error) {
        logger.warn("agent_chat.opencode_model_catalog_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }

    // Fallback for non-OpenCode providers: return models ADE can currently resolve.
    try {
      const auth = await detectAuth();
      const available = await getAvailableRegistryModels(auth);
      const targetModels = available.filter((m) => m.family === provider);
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

  const getAvailableModels = async ({
    provider,
    activateRuntime,
  }: {
    provider: AgentChatProvider;
    activateRuntime?: boolean;
  }): Promise<AgentChatModelInfo[]> => {
    const requestKey = `${provider}:${activateRuntime === true ? "active" : "passive"}`;
    const existingRequest = availableModelsRequests.get(requestKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = loadAvailableModels({ provider, activateRuntime });
    availableModelsRequests.set(requestKey, request);
    try {
      return await request;
    } finally {
      if (availableModelsRequests.get(requestKey) === request) {
        availableModelsRequests.delete(requestKey);
      }
    }
  };

  const dispose = async ({ sessionId }: AgentChatDisposeArgs): Promise<void> => {
    const managed = ensureManagedSession(sessionId);

    // Interrupt active codex turn before teardown
    if (managed.runtime?.kind === "codex") {
      try {
        if (managed.session.threadId && managed.runtime.activeTurnId) {
          rememberInterruptedCodexTurn(managed.runtime, managed.runtime.activeTurnId);
          await managed.runtime.request("turn/interrupt", {
            threadId: managed.session.threadId,
            turnId: managed.runtime.activeTurnId
          });
          stopActiveCodexSubagents(
            managed,
            managed.runtime,
            managed.runtime.activeTurnId ?? undefined,
            "Interrupted while closing the session",
          );
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

    if (managed.runtime?.kind === "cursor") {
      managed.runtime.interrupted = true;
      cancelQueuedSteers(managed, managed.runtime, "disposed");
      if (managed.runtime.acpSessionId) {
        try {
          await managed.runtime.pooled?.connection.cancel({ sessionId: managed.runtime.acpSessionId });
        } catch {
          // ignore
        }
      }
    }

    // Mark streaming runtimes as interrupted so the catch block handles gracefully
    if (managed.runtime?.kind === "claude" || managed.runtime?.kind === "opencode") {
      managed.runtime.interrupted = true;
      cancelQueuedSteers(managed, managed.runtime, "disposed");
    }

    await finishSession(managed, "disposed", {
      summary: managed.preview ? `Session closed: ${managed.preview}` : "Session closed."
    });
  };

  const deleteSession = async ({ sessionId }: AgentChatDeleteArgs): Promise<void> => {
    const trimmedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!trimmedSessionId.length) {
      throw new Error("Chat session id is required.");
    }

    const existing = sessionService.get(trimmedSessionId);
    if (!existing) {
      throw new Error(`Chat session '${trimmedSessionId}' was not found.`);
    }
    if (!isChatToolType(existing.toolType)) {
      throw new Error(`Session '${trimmedSessionId}' is not an agent chat session.`);
    }

    // Tombstone the session before any async work so in-flight persistence
    // (auto-title, summary, chat state writes) bails instead of recreating files.
    // We do NOT set endedNotified here — dispose() still needs to run finishSession
    // so sessionService.end fires.
    const tombstoned = managedSessions.get(trimmedSessionId);
    if (tombstoned) {
      tombstoned.deleted = true;
    }

    if (existing.status === "running") {
      await dispose({ sessionId: trimmedSessionId });
    }

    const current = sessionService.get(trimmedSessionId);
    if (!current) return;

    rejectActiveSessionTurnCollector(trimmedSessionId, `Chat session '${trimmedSessionId}' was deleted.`);

    const managed = managedSessions.get(trimmedSessionId);
    if (managed) {
      // Resolve any outstanding input waiters (plan approvals, questions, etc.)
      // so callers awaiting them unblock with a cancellation instead of hanging
      // forever once the session is gone.
      for (const pending of managed.localPendingInputs.values()) {
        pending.resolve({ decision: "cancel" });
      }
      managed.localPendingInputs.clear();
      managed.deleted = true;
      managed.closed = true;
      managed.endedNotified = true;
      managed.ctoSessionStartedAt = null;
      clearSubagentSnapshots(trimmedSessionId);
      teardownRuntime(managed, "ended_session");
      managedSessions.delete(trimmedSessionId);
    } else {
      clearSubagentSnapshots(trimmedSessionId);
    }
    eventHistoryBySession.delete(trimmedSessionId);

    const persistedMetadataPath = metadataPathFor(trimmedSessionId);
    const dedicatedTranscriptPath = path.join(chatTranscriptsDir, `${trimmedSessionId}.jsonl`);
    const transcriptPaths = new Set<string>([
      persistedMetadataPath,
      dedicatedTranscriptPath,
      current.transcriptPath,
    ]);
    for (const filePath of transcriptPaths) {
      deletePersistedChatFile(filePath);
    }

    sessionService.deleteSession(trimmedSessionId);
  };

  const disposeAll = async (): Promise<void> => {
    clearInterval(sessionCleanupTimer);
    for (const sessionId of [...managedSessions.keys()]) {
      try {
        await dispose({ sessionId });
      } catch {
        // ignore shutdown errors
      }
    }
  };

  const forceDisposeAll = (): void => {
    clearInterval(sessionCleanupTimer);
    for (const sessionId of [...sessionTurnCollectors.keys()]) {
      rejectActiveSessionTurnCollector(sessionId, `Chat session '${sessionId}' was closed during shutdown.`);
    }
    for (const [sessionId, managed] of managedSessions) {
      try {
        clearSubagentSnapshots(sessionId);
        for (const pending of managed.localPendingInputs.values()) {
          pending.resolve({ decision: "cancel" });
        }
        managed.localPendingInputs.clear();
        managed.closed = true;
        managed.endedNotified = true;
        managed.ctoSessionStartedAt = null;
        // teardownRuntime must run before `deleted = true` so its persistChatState()
        // call can write the preserved Claude resume metadata for "shutdown".
        teardownRuntime(managed, "shutdown");
        managed.deleted = true;
      } catch {
        // ignore emergency shutdown failures
      }
    }
    managedSessions.clear();
  };

  // --- Session inactivity cleanup ---
  const sessionCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [, managed] of managedSessions) {
      if (
        managed.runtime
        && !managed.closed
        && managed.session.status === "idle"
        && !hasLivePendingInput(managed)
        && now - managed.lastActivityTimestamp > getSessionInactivityTimeoutMs(managed)
      ) {
        teardownRuntime(managed, "idle_ttl");
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if the timer is still scheduled
  if (sessionCleanupTimer.unref) sessionCleanupTimer.unref();

  // --- Max concurrent active runtimes eviction ---
  const evictLeastRecentRuntime = (excludeSessionId: string): void => {
    let oldest: ManagedChatSession | null = null;
    let oldestTimestamp = Infinity;
    for (const [id, managed] of managedSessions) {
      if (id === excludeSessionId) continue;
      if (!managed.runtime) continue;
      if (managed.session.status !== "idle") continue;
      if (hasLivePendingInput(managed)) continue;
      if (managed.lastActivityTimestamp < oldestTimestamp) {
        oldestTimestamp = managed.lastActivityTimestamp;
        oldest = managed;
      }
    }
    if (oldest) {
      teardownRuntime(oldest, "budget_eviction");
    }
  };

  const updateSession = async ({
    sessionId,
    title,
    manuallyNamed,
    modelId,
    reasoningEffort,
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    opencodePermissionMode,
    cursorModeId,
    cursorConfigValues,
    permissionMode,
  }: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const managed = ensureManagedSession(sessionId);
    const chatConfig = resolveChatConfig();
    const isIdentitySession = Boolean(managed.session.identityKey);
    const hasConversation = managed.recentConversationEntries.length > 0 || readTranscriptConversationEntries(managed).length > 0;
    const prevCodexApprovalPolicy = managed.session.codexApprovalPolicy;
    const prevCodexSandbox = managed.session.codexSandbox;
    const prevCodexConfigSource = managed.session.codexConfigSource;

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
      const nextModel = descriptor.isCliWrapped ? descriptor.providerModelId : descriptor.id;
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
        teardownRuntime(managed, "model_switch");
        refreshReconstructionContext(managed);
      }

      const currentTitle = sessionService.get(sessionId)?.title ?? null;
      managed.session.provider = nextProvider;
      managed.session.modelId = descriptor.id;
      managed.session.model = nextModel;
      managed.session.capabilityMode = inferCapabilityMode(nextProvider);
      if (previousProvider !== nextProvider || previousProvider === "codex") {
        delete managed.session.threadId;
        managed.runtimeInvalidated = true;
        clearLaneDirectiveKey(managed);
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
      enforceManagedLocalHarnessPermissionMode(managed, descriptor);
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

    if (opencodePermissionMode !== undefined) {
      managed.session.opencodePermissionMode = opencodePermissionMode;
    }

    if (cursorModeId !== undefined) {
      managed.session.cursorModeId = typeof cursorModeId === "string"
        ? (cursorModeId.trim() || null)
        : null;
    }

    if (cursorConfigValues !== undefined) {
      managed.session.cursorConfigValues = normalizeCursorConfigValueRecord(cursorConfigValues);
      if (!managed.session.cursorConfigValues) {
        delete managed.session.cursorConfigValues;
      }
    }

    if (
      permissionMode !== undefined
      || interactionMode !== undefined
      || claudePermissionMode !== undefined
      || codexApprovalPolicy !== undefined
      || codexSandbox !== undefined
      || codexConfigSource !== undefined
      || opencodePermissionMode !== undefined
      || cursorModeId !== undefined
      || cursorConfigValues !== undefined
    ) {
      enforceManagedLocalHarnessPermissionMode(managed);
      normalizeSessionNativePermissionControls(managed.session, chatConfig);
      if (managed.runtime?.kind === "opencode") {
        managed.runtime.permissionMode = resolveSessionOpenCodePermissionMode(
          managed.session,
          chatConfig.opencodePermissionMode,
        );
      }
      if (
        managed.runtime?.kind === "codex"
        && (
          managed.session.codexApprovalPolicy !== prevCodexApprovalPolicy
          || managed.session.codexSandbox !== prevCodexSandbox
          || managed.session.codexConfigSource !== prevCodexConfigSource
        )
      ) {
        managed.runtime.threadResumed = false;
      }
      if (managed.runtime?.kind === "claude" && managed.runtime.v2Session) {
        const turnPermissionMode = resolveClaudeTurnPermissionMode(managed);
        const control = getClaudeV2SessionControl(managed.runtime.v2Session);
        if (typeof control.setPermissionMode === "function") {
          try {
            await control.setPermissionMode(turnPermissionMode);
          } catch (permErr) {
            // If the SDK rejects the mode change (e.g. escalating to
            // bypassPermissions on a session not started with
            // --dangerously-skip-permissions), invalidate the V2 session
            // so it is recreated with the correct mode on the next turn.
            // When busy, only log the failure — don't tear down the active session.
            logger.warn("agent_chat.v2_set_permission_mode_failed", {
              sessionId: managed.session.id,
              turnPermissionMode,
              error: String(permErr),
            });
            if (!managed.runtime.busy) {
              cancelClaudeWarmup(managed, managed.runtime, "session_reset");
              try { managed.runtime.v2Session?.close(); } catch { /* ignore */ }
              managed.runtime.v2Session = null;
              managed.runtime.v2WarmupDone = null;
            }
          }
        }
      }
      if (managed.runtime?.kind === "cursor" && !managed.runtime.busy) {
        await ensureCursorSessionState(managed, managed.runtime);
      }
    }

    if (title !== undefined) {
      const normalizedTitle = String(title ?? "").trim();
      const hasExplicitTitle = normalizedTitle.length > 0;
      sessionService.updateMeta({
        sessionId,
        manuallyNamed: manuallyNamed ?? false,
        title: hasExplicitTitle ? normalizedTitle : defaultChatSessionTitle(managed.session.provider),
      });
      if (manuallyNamed !== undefined) {
        managed.manuallyNamed = manuallyNamed && hasExplicitTitle;
      } else if (hasExplicitTitle) {
        managed.manuallyNamed = true;
      } else {
        managed.manuallyNamed = false;
      }
    }
    // Allow resetting manuallyNamed independently when no title change is provided
    if (manuallyNamed !== undefined && title === undefined) {
      managed.manuallyNamed = manuallyNamed;
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
    refreshManagedLaneLaunchContext(managed, { purpose: "warm this chat" });

    const descriptor = getModelById(modelId) ?? resolveModelAlias(modelId);
    if (!descriptor) return;

    const isCursorCli = descriptor.family === "cursor" && descriptor.isCliWrapped;
    const isAnthropicCli = descriptor.family === "anthropic" && descriptor.isCliWrapped;
    if (!isAnthropicCli && !isCursorCli) return;

    if (isCursorCli) {
      if (managed.session.provider !== "cursor") return;
      if (managed.session.modelId !== descriptor.id) return;
      if (managed.session.status === "active") return;
      if (managed.runtime && managed.runtime.kind !== "cursor") return;
      if (managed.runtime?.kind === "cursor" && managed.runtime.busy) return;

      const runtime = await ensureCursorRuntime(managed);
      if (!runtime.pooled) return;
      if (!runtime.acpSessionId) {
        const created = await runtime.pooled.connection.newSession(cursorAcpSessionRequest({
          cwd: managed.laneWorktreePath,
        }) as Parameters<typeof runtime.pooled.connection.newSession>[0]);
        const createdAvailableModelIds = created.models?.availableModels
          ?.map((entry) => String(entry?.modelId ?? "").trim())
          .filter(Boolean) ?? [];
        if (createdAvailableModelIds.length) {
          runtime.availableModelIds = Array.from(new Set([...runtime.availableModelIds, ...createdAvailableModelIds]));
        }
        const sid = created.sessionId;
        runtime.acpSessionId = sid;
        runtime.currentModeId = created.modes?.currentModeId ?? runtime.currentModeId;
        runtime.defaultModeId = created.modes?.currentModeId ?? runtime.defaultModeId;
        runtime.currentModelId = normalizeCursorReportedModelId(
          created.models?.currentModelId,
          runtime.availableModelIds,
        ) ?? runtime.currentModelId;
        applyCursorConfigSnapshot(managed, runtime, readCursorAcpConfigSnapshot(created.configOptions));
        if (runtime.currentModelId) {
          syncCursorSessionDescriptor(managed, runtime.currentModelId);
        }
        syncCursorModeSnapshot(managed, runtime);
        cursorAcpSessionOwners.set(sid, managed);
      }
      await ensureCursorSessionState(managed, runtime);
      persistChatState(managed);
      return;
    }

    // Warmup should never rewrite the live session model. It's only allowed to
    // prime the currently-selected Claude runtime when the backend session is
    // already aligned with the requested model and fully idle.
    if (managed.session.provider !== "claude") return;
    if (managed.session.modelId !== descriptor.id) return;
    if (managed.session.status === "active") return;
    if (managed.runtime && managed.runtime.kind !== "claude") return;
    if (managed.runtime?.kind === "claude" && managed.runtime.busy) return;

    // Only prewarm if the session is idle (not mid-turn) and not already warmed
    if (managed.runtime?.kind === "claude" && (managed.runtime.v2Session || managed.runtime.v2WarmupDone)) return;

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

    const localCommands: AgentChatSlashCommand[] = provider === "claude"
      ? []
      : [{ name: "/clear", description: "Clear chat history", source: "local" }];
    if (provider === "claude") {
      localCommands.push({
        name: "/login",
        description: "Sign in to Claude Code for this chat runtime",
        source: "local",
      });
    }

    // Claude SDK commands plus filesystem-backed Claude Code commands/skills.
    if (provider === "claude") {
      const sdkCommands = managed.runtime?.kind === "claude" ? managed.runtime.slashCommands : [];
      const sdkCmds: AgentChatSlashCommand[] = [
        ...sdkCommands,
        ...discoverClaudeSlashCommands(managed.laneWorktreePath),
      ].map((cmd: { name: string; description: string; argumentHint?: string }) => ({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        source: "sdk" as const,
      }));
      const merged = new Map<string, AgentChatSlashCommand>();
      for (const command of sdkCmds) {
        merged.set(command.name, command);
      }
      for (const command of localCommands) {
        merged.set(command.name, command);
      }
      return [...merged.values()];
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

    // OpenCode / Cursor — only local commands
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
    timeoutMs,
  }: AgentChatSendArgs & { timeoutMs?: number | null }): Promise<{
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

    const normalizedTimeoutMs = timeoutMs === undefined
      ? DEFAULT_RUN_SESSION_TURN_TIMEOUT_MS
      : timeoutMs == null || Number(timeoutMs) === 0
        ? null
        : Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
          ? Math.max(15_000, Math.floor(Number(timeoutMs)))
          : DEFAULT_RUN_SESSION_TURN_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
      const collector: SessionTurnCollector = {
        resolve,
        reject,
        outputText: "",
        lastError: null,
        timeout: null,
      };

      if (normalizedTimeoutMs != null) {
        collector.timeout = setTimeout(() => {
          if (sessionTurnCollectors.get(sessionId) !== collector) return;
          sessionTurnCollectors.delete(sessionId);
          void interrupt({ sessionId }).catch((interruptError) => {
            logger.warn("agent_chat.run_session_turn_timeout_interrupt_failed", {
              sessionId,
              error: interruptError instanceof Error ? interruptError.message : String(interruptError),
            });
          });
          reject(new Error(
            `Timed out waiting for session '${sessionId}' to finish the current turn. The turn was interrupted, but the chat stayed open.`,
          ));
        }, normalizedTimeoutMs);
      }

      sessionTurnCollectors.set(sessionId, collector);

      void executePreparedSendMessage(prepared).catch((error) => {
        if (collector.timeout) {
          clearTimeout(collector.timeout);
        }
        if (sessionTurnCollectors.get(sessionId) === collector) {
          sessionTurnCollectors.delete(sessionId);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  /**
   * Create a blocking pending-input request for a chat session (used by ADE ask_user
   * when no missionId is available).  Returns the user's answer.
   */
  const requestChatInput = async (args: {
    chatSessionId: string;
    title: string;
    body: string;
    source?: PendingInputSource;
    providerMetadata?: Record<string, unknown>;
    eventDescription?: string;
    eventDetail?: Record<string, unknown>;
    questions?: Array<{
      id?: string;
      header?: string;
      question: string;
      options?: Array<{
        label: string;
        value?: string;
        description?: string;
        recommended?: boolean;
        preview?: string;
        previewFormat?: string;
      }>;
      multiSelect?: boolean;
      allowsFreeform?: boolean;
      isSecret?: boolean;
      defaultAssumption?: string | null;
      impact?: string | null;
    }>;
  }): Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null }> => {
    const inferQuestionsFromBody = (bodyText: string): PendingInputQuestion[] | null => {
      const normalizedBody = bodyText.replace(/\r/g, "").trim();
      if (!normalizedBody.length) return null;

      const buildStructuredQuestion = (
        prompt: string,
        options: Array<{ label: string; value: string }>,
      ): PendingInputQuestion[] | null => {
        const question = prompt.trim().replace(/\s+/g, " ");
        const normalizedOptions = options
          .map((option) => ({
            label: option.label.trim(),
            value: option.value.trim(),
          }))
          .filter((option) => option.label.length > 0 && option.value.length > 0);
        if (!question.length || normalizedOptions.length < 2) return null;
        return [{
          id: "answer",
          header: "Question 1",
          question,
          options: normalizedOptions,
          allowsFreeform: true,
        }];
      };

      const optionLinePattern = /^(?:[-*]\s*)?([0-9A-Za-z]+)[.)]\s+(.+)$/;
      const nonEmptyLines = normalizedBody
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const firstOptionLineIndex = nonEmptyLines.findIndex((line) => optionLinePattern.test(line));
      if (firstOptionLineIndex >= 1) {
        const prompt = nonEmptyLines.slice(0, firstOptionLineIndex).join(" ");
        const options = nonEmptyLines.slice(firstOptionLineIndex).flatMap((line) => {
          const match = line.match(optionLinePattern);
          if (!match) return [];
          return [{
            value: match[1]!.trim(),
            label: match[2]!.trim(),
          }];
        });
        const inferred = buildStructuredQuestion(prompt, options);
        if (inferred) return inferred;
      }

      const optionMarkerPattern = /([0-9A-Za-z]+)[.)]\s+/g;
      const markers = Array.from(normalizedBody.matchAll(optionMarkerPattern));
      if (markers.length < 2) return null;
      const firstMarker = markers[0];
      if (!firstMarker || firstMarker.index == null || firstMarker.index <= 0) return null;

      const prompt = normalizedBody.slice(0, firstMarker.index).trim();
      const options = markers.flatMap((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = index + 1 < markers.length
          ? (markers[index + 1]?.index ?? normalizedBody.length)
          : normalizedBody.length;
        const rawLabel = normalizedBody
          .slice(start, end)
          .replace(/\s+(?:Reply|Respond|Choose|Select|Pick|Answer)\b[\s\S]*$/i, "")
          .trim();
        if (!rawLabel.length) return [];
        return [{
          value: match[1]!.trim(),
          label: rawLabel,
        }];
      });
      return buildStructuredQuestion(prompt, options);
    };

    const managed = ensureManagedSession(args.chatSessionId);
    const itemId = randomUUID();
    const fallbackQuestions = inferQuestionsFromBody(args.body) ?? [{ id: "answer", header: "Question 1", question: args.body, allowsFreeform: true }];
    const requestedQuestions = args.questions?.length ? args.questions : fallbackQuestions;
    const questions: PendingInputQuestion[] = requestedQuestions.map(
      (q, i) => ({
        id: q.id ?? `q_${i + 1}`,
        header: q.header?.trim().length ? q.header.trim() : `Question ${i + 1}`,
        question: q.question.trim(),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        ...(q.allowsFreeform !== undefined ? { allowsFreeform: q.allowsFreeform } : { allowsFreeform: true }),
        ...(q.isSecret === true ? { isSecret: true } : {}),
        ...(typeof q.defaultAssumption === "string" && q.defaultAssumption.trim().length
          ? { defaultAssumption: q.defaultAssumption.trim() }
          : {}),
        ...(typeof q.impact === "string" && q.impact.trim().length
          ? { impact: q.impact.trim() }
          : {}),
        ...(q.options?.length ? {
          options: q.options.map((o) => ({
            label: o.label,
            value: o.value ?? o.label,
            ...(typeof o.description === "string" && o.description.trim().length ? { description: o.description.trim() } : {}),
            ...(o.recommended === true ? { recommended: true } : {}),
            ...(typeof o.preview === "string" && o.preview.trim().length ? { preview: o.preview } : {}),
            ...(o.previewFormat === "markdown" || o.previewFormat === "html" ? { previewFormat: o.previewFormat } : {}),
          })),
        } : {}),
      }),
    );
    const request: PendingInputRequest = {
      requestId: itemId,
      itemId,
      source: args.source ?? "ade",
      kind: questions.some((q) => q.options?.length) ? "structured_question" : "question",
      title: args.title,
      description: questions[0]?.question ?? args.body,
      questions,
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
      ...(args.providerMetadata ? { providerMetadata: args.providerMetadata } : {}),
      turnId: managed.runtime?.activeTurnId ?? null,
    };

    const response = await new Promise<{
      decision?: AgentChatApprovalDecision;
      answers?: Record<string, string | string[]>;
      responseText?: string | null;
    }>((resolve) => {
      managed.localPendingInputs.set(itemId, { request, resolve });
      emitPendingInputRequest(managed, request, {
        kind: "tool_call",
        description: args.eventDescription ?? request.description ?? args.body,
        ...(args.eventDetail !== undefined ? { detail: args.eventDetail } : {}),
      });
    });

    const normalizedAnswers = normalizePendingInputAnswers(request, response.answers, response.responseText);
    return {
      decision: response.decision ?? "none",
      answers: normalizedAnswers,
      responseText: typeof response.responseText === "string" ? response.responseText : null,
    };
  };

  return {
    createSession,
    handoffSession,
    sendMessage,
    runSessionTurn,
    steer,
    cancelSteer,
    editSteer,
    interrupt,
    resumeSession,
    listSessions,
    getSessionSummary,
    getChatTranscript,
    getChatEventHistory,
    ensureIdentitySession,
    approveToolUse,
    respondToInput,
    requestChatInput,
    getAvailableModels,
    getSlashCommands,
    codexFuzzyFileSearch,
    dispose,
    deleteSession,
    disposeAll,
    forceDisposeAll,
    updateSession,
    warmupModel,
    listSubagents,
    getSessionCapabilities,
    previewSessionToolNames,
    subscribeToEvents(callback: (event: AgentChatEventEnvelope) => void) {
      eventSubscribers.add(callback);
      return () => {
        eventSubscribers.delete(callback);
      };
    },
    /** Clean up temp attachment files older than 7 days. Call on app startup. */
    cleanupStaleAttachments() {
      try {
        const projectRoot = args.projectRoot;
        if (!projectRoot) return;
        const cleanupDir = (dirPath: string) => {
          if (!fs.existsSync(dirPath)) return;
          const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
          for (const entry of fs.readdirSync(dirPath)) {
            try {
              const filePath = path.join(dirPath, entry);
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs < cutoff) {
                fs.rmSync(filePath, { recursive: true, force: true });
              }
            } catch {
              // Best-effort cleanup only.
            }
          }
        };

        cleanupDir(path.join(projectRoot, ".ade", "attachments"));
        cleanupDir(path.join(resolveAdeLayout(projectRoot).tmpDir, "agent-chat-attachments"));
      } catch { /* ignore */ }
    },
    setComputerUseArtifactBrokerService(svc: ComputerUseArtifactBrokerService) {
      computerUseArtifactBrokerRef = svc;
    },
  };
}
