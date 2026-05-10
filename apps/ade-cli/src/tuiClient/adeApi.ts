import {
  getDefaultModelDescriptor,
  getModelById,
  getRuntimeModelRefForDescriptor,
  resolveProviderGroupForModel,
  type ModelProviderGroup,
} from "../../../desktop/src/shared/modelRegistry";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCursorConfigValue,
  AgentChatDroidPermissionMode,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatInteractionMode,
  AgentChatModelInfo,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
} from "../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus, OpenCodeRuntimeSnapshot } from "../../../desktop/src/shared/types/config";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { AdeCodeConnection, ChatHistorySnapshot, CreatedChat, NavigateRequest, NavigateResult } from "./types";

export const DEFAULT_CODEX_REASONING_EFFORT = "low";

export async function listLanes(connection: AdeCodeConnection): Promise<LaneSummary[]> {
  return await connection.action<LaneSummary[]>("lane", "list", {
    includeArchived: false,
    includeStatus: true,
  });
}

export async function listChatSessions(
  connection: AdeCodeConnection,
  laneId?: string | null,
): Promise<AgentChatSessionSummary[]> {
  const argsList = laneId ? [laneId] : [];
  return await connection.actionList<AgentChatSessionSummary[]>("chat", "listSessions", argsList);
}

export async function getChatHistory(
  connection: AdeCodeConnection,
  sessionId: string,
  maxEvents = 500,
): Promise<ChatHistorySnapshot> {
  return await connection.actionList<ChatHistorySnapshot>("chat", "getChatEventHistory", [sessionId, { maxEvents }]);
}

export async function getSlashCommands(
  connection: AdeCodeConnection,
  sessionId: string | null,
): Promise<AgentChatSlashCommand[]> {
  if (!sessionId) return [];
  return await connection.action<AgentChatSlashCommand[]>("chat", "getSlashCommands", { sessionId });
}

export async function getAvailableModels(
  connection: AdeCodeConnection,
  provider: AgentChatProvider,
): Promise<AgentChatModelInfo[]> {
  return await connection.action<AgentChatModelInfo[]>("chat", "getAvailableModels", {
    provider,
    activateRuntime: false,
  });
}

export async function getAiSettingsStatus(
  connection: AdeCodeConnection,
  args: { force?: boolean; refreshOpenCodeInventory?: boolean } = {},
): Promise<AiSettingsStatus> {
  return await connection.action<AiSettingsStatus>("ai", "getStatus", args);
}

export async function getStoredApiKeyProviders(connection: AdeCodeConnection): Promise<string[]> {
  return await connection.action<string[]>("ai", "listApiKeys", {});
}

export async function getOpenCodeRuntimeDiagnostics(connection: AdeCodeConnection): Promise<OpenCodeRuntimeSnapshot> {
  return await connection.action<OpenCodeRuntimeSnapshot>("ai", "getOpenCodeRuntimeDiagnostics", {});
}

export async function createChatSession(args: {
  connection: AdeCodeConnection;
  laneId: string;
  title?: string | null;
  provider?: ModelProviderGroup;
  modelId?: string | null;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
}): Promise<CreatedChat> {
  const requestedDescriptor = args.modelId ? getModelById(args.modelId) : undefined;
  const provider = args.provider
    ?? (requestedDescriptor ? resolveProviderGroupForModel(requestedDescriptor) : "codex");
  const descriptor = requestedDescriptor ?? getDefaultModelDescriptor(provider);
  const modelId = args.modelId ?? descriptor?.id ?? null;
  const model = descriptor
    ? getRuntimeModelRefForDescriptor(descriptor, provider)
    : provider === "claude"
      ? "sonnet"
      : provider === "cursor"
        ? "auto"
        : provider === "droid"
          ? "claude-sonnet-4-5-20250929"
          : "gpt-5.5";
  const reasoningEffort = args.reasoningEffort ?? (provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null);
  return await args.connection.action<AgentChatSession>("chat", "createSession", {
    laneId: args.laneId,
    provider,
    model,
    ...(modelId ? { modelId } : {}),
    ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(provider === "codex" && args.codexFastMode === true ? { codexFastMode: true } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(provider === "claude" && args.interactionMode ? { interactionMode: args.interactionMode } : {}),
    ...(provider === "claude" && args.claudePermissionMode ? { claudePermissionMode: args.claudePermissionMode } : {}),
    ...(provider === "codex" && args.codexApprovalPolicy ? { codexApprovalPolicy: args.codexApprovalPolicy } : {}),
    ...(provider === "codex" && args.codexSandbox ? { codexSandbox: args.codexSandbox } : {}),
    ...(provider === "codex" && args.codexConfigSource ? { codexConfigSource: args.codexConfigSource } : {}),
    ...(provider === "opencode" && args.opencodePermissionMode ? { opencodePermissionMode: args.opencodePermissionMode } : {}),
    ...(provider === "droid" && args.droidPermissionMode ? { droidPermissionMode: args.droidPermissionMode } : {}),
    ...(provider === "cursor" && args.cursorModeId !== undefined ? { cursorModeId: args.cursorModeId } : {}),
    ...(provider === "cursor" && args.cursorConfigValues ? { cursorConfigValues: args.cursorConfigValues } : {}),
    surface: "work",
  });
}

export async function sendChatMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  text: string,
  attachments: AgentChatFileRef[] = [],
): Promise<void> {
  await connection.actionList("chat", "sendMessage", [
    {
      sessionId,
      text,
      ...(attachments.length ? { attachments } : {}),
    },
    { awaitDispatch: true },
  ]);
}

export async function approveToolUse(args: {
  connection: AdeCodeConnection;
  sessionId: string;
  itemId: string;
  decision: "accept" | "accept_for_session" | "decline" | "cancel";
  responseText?: string | null;
}): Promise<void> {
  await args.connection.action("chat", "approveToolUse", {
    sessionId: args.sessionId,
    itemId: args.itemId,
    decision: args.decision,
    ...(args.responseText ? { responseText: args.responseText } : {}),
  });
}

export async function respondToInput(args: {
  connection: AdeCodeConnection;
  sessionId: string;
  itemId: string;
  decision?: "accept" | "accept_for_session" | "decline" | "cancel";
  answers?: Record<string, string | string[]>;
  responseText?: string | null;
}): Promise<void> {
  await args.connection.action("chat", "respondToInput", {
    sessionId: args.sessionId,
    itemId: args.itemId,
    ...(args.decision ? { decision: args.decision } : {}),
    ...(args.answers ? { answers: args.answers } : {}),
    ...(args.responseText ? { responseText: args.responseText } : {}),
  });
}

export async function interruptChat(connection: AdeCodeConnection, sessionId: string): Promise<void> {
  await connection.action("chat", "interrupt", { sessionId });
}

export async function resumeChat(connection: AdeCodeConnection, sessionId: string): Promise<AgentChatSession> {
  return await connection.action("chat", "resumeSession", { sessionId });
}

export async function renameChat(connection: AdeCodeConnection, sessionId: string, title: string): Promise<AgentChatSession> {
  return await connection.action("chat", "updateSession", {
    sessionId,
    title,
    manuallyNamed: true,
  });
}

export async function updateChatModel(args: {
  connection: AdeCodeConnection;
  sessionId: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  codexFastMode?: boolean;
  permissionMode?: AgentChatPermissionMode;
  interactionMode?: AgentChatInteractionMode;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeId?: string | null;
  cursorConfigValues?: Record<string, AgentChatCursorConfigValue>;
}): Promise<AgentChatSession> {
  return await args.connection.action("chat", "updateSession", {
    sessionId: args.sessionId,
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.codexFastMode !== undefined ? { codexFastMode: args.codexFastMode } : {}),
    ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
    ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
    ...(args.claudePermissionMode !== undefined ? { claudePermissionMode: args.claudePermissionMode } : {}),
    ...(args.codexApprovalPolicy !== undefined ? { codexApprovalPolicy: args.codexApprovalPolicy } : {}),
    ...(args.codexSandbox !== undefined ? { codexSandbox: args.codexSandbox } : {}),
    ...(args.codexConfigSource !== undefined ? { codexConfigSource: args.codexConfigSource } : {}),
    ...(args.opencodePermissionMode !== undefined ? { opencodePermissionMode: args.opencodePermissionMode } : {}),
    ...(args.droidPermissionMode !== undefined ? { droidPermissionMode: args.droidPermissionMode } : {}),
    ...(args.cursorModeId !== undefined ? { cursorModeId: args.cursorModeId } : {}),
    ...(args.cursorConfigValues !== undefined ? { cursorConfigValues: args.cursorConfigValues } : {}),
  });
}

export async function navigateDesktop(connection: AdeCodeConnection, request: NavigateRequest): Promise<NavigateResult> {
  return await connection.request<NavigateResult>("app/navigate", request);
}

export function newestSession(sessions: AgentChatSessionSummary[]): AgentChatSessionSummary | null {
  return [...sessions].sort((left, right) => (
    new Date(right.lastActivityAt ?? right.startedAt).getTime()
    - new Date(left.lastActivityAt ?? left.startedAt).getTime()
  ))[0] ?? null;
}

export type TokenStats = {
  percent: number | null;
  streaming: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export function latestTokenStats(
  events: AgentChatEventEnvelope[],
  fallbackContextWindow?: number | null,
): TokenStats {
  let percent: number | null = null;
  let streaming = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  let eventLimit: number | null = null;
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "status" && event.turnStatus === "started") streaming = true;
    if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) streaming = false;
    if (event.type === "tokens") {
      inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : inputTokens;
      outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : outputTokens;
      if (typeof event.contextWindow === "number") eventLimit = event.contextWindow;
    }
    if (event.type === "done") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : inputTokens;
      outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : outputTokens;
      costUsd = typeof event.costUsd === "number" ? event.costUsd : costUsd;
    }
  }
  const used = inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null;
  const limit = eventLimit ?? (typeof fallbackContextWindow === "number" && fallbackContextWindow > 0 ? fallbackContextWindow : null);
  if (used != null && limit != null && limit > 0) {
    percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return { percent, streaming, inputTokens, outputTokens, costUsd };
}
