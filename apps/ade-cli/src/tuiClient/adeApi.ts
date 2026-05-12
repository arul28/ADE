import {
  getDefaultModelDescriptor,
  getModelById,
  getRuntimeModelRefForDescriptor,
  resolveProviderGroupForModel,
  type ModelProviderGroup,
} from "../../../desktop/src/shared/modelRegistry";
import type {
  AgentChatClaudeOutputStyle,
  AgentChatClaudePlugin,
  AgentChatReloadClaudePluginsResult,
  AgentChatClaudeMcpServerStatus,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatContextUsage,
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
import { discoverClaudeSlashCommands } from "../../../desktop/src/main/services/chat/claudeSlashCommandDiscovery";
import { discoverCodexSlashCommands } from "../../../desktop/src/main/services/chat/codexSlashCommandDiscovery";
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

export async function getContextUsage(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatContextUsage | null> {
  return await connection.action<AgentChatContextUsage | null>("chat", "getContextUsage", { sessionId });
}

export async function getClaudeMcpStatus(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatClaudeMcpServerStatus[]> {
  return await connection.action<AgentChatClaudeMcpServerStatus[]>("chat", "getClaudeMcpStatus", { sessionId });
}

export async function listClaudePlugins(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatClaudePlugin[]> {
  return await connection.action<AgentChatClaudePlugin[]>("chat", "listClaudePlugins", { sessionId });
}

export async function reloadClaudePlugins(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatReloadClaudePluginsResult> {
  return await connection.action<AgentChatReloadClaudePluginsResult>("chat", "reloadClaudePlugins", { sessionId });
}

export async function listClaudeOutputStyles(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatClaudeOutputStyle[]> {
  return await connection.action<AgentChatClaudeOutputStyle[]>("chat", "listClaudeOutputStyles", { sessionId });
}

export async function setClaudeOutputStyle(
  connection: AdeCodeConnection,
  sessionId: string,
  outputStyle: string,
): Promise<AgentChatSession> {
  return await connection.action<AgentChatSession>("chat", "setClaudeOutputStyle", { sessionId, outputStyle });
}

function slashCommandKey(value: string): string {
  return value.trim().toLowerCase();
}

export function discoverProjectSlashCommands(workspaceRoot: string): AgentChatSlashCommand[] {
  const byName = new Map<string, AgentChatSlashCommand>();
  const add = (command: { name: string; description: string; argumentHint?: string }) => {
    const key = slashCommandKey(command.name);
    if (key === "/login") return;
    if (byName.has(key)) return;
    byName.set(key, {
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      source: "sdk",
    });
  };
  for (const command of discoverClaudeSlashCommands(workspaceRoot)) add(command);
  for (const command of discoverCodexSlashCommands(workspaceRoot)) add(command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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

export async function tagChat(connection: AdeCodeConnection, sessionId: string, tag: string | null): Promise<AgentChatSession> {
  return await connection.action("chat", "updateSession", {
    sessionId,
    tag,
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
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  rateLimit: {
    usedPercentage: number | null;
    resetsAt: number | null;
  } | null;
};

export function latestTokenStats(
  events: AgentChatEventEnvelope[],
  fallbackContextWindow?: number | null,
): TokenStats {
  let percent: number | null = null;
  let streaming = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheCreationTokens: number | null = null;
  let costUsd: number | null = null;
  let eventLimit: number | null = null;
  let rateLimit: TokenStats["rateLimit"] = null;
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "status" && event.turnStatus === "started") streaming = true;
    if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) streaming = false;
    if (event.type === "tokens") {
      inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : inputTokens;
      outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : outputTokens;
      cacheReadTokens = typeof event.cacheReadTokens === "number" ? event.cacheReadTokens : cacheReadTokens;
      cacheCreationTokens = typeof event.cacheWriteTokens === "number" ? event.cacheWriteTokens : cacheCreationTokens;
      if (typeof event.contextWindow === "number") eventLimit = event.contextWindow;
    }
    if (event.type === "done") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : inputTokens;
      outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : outputTokens;
      cacheReadTokens = typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : cacheReadTokens;
      cacheCreationTokens = typeof usage?.cacheCreationTokens === "number" ? usage.cacheCreationTokens : cacheCreationTokens;
      costUsd = typeof event.costUsd === "number" ? event.costUsd : costUsd;
    }
    if (event.type === "system_notice" && event.noticeKind === "rate_limit") {
      const detail = typeof event.detail === "string" ? event.detail : "";
      const pct = detail.match(/(\d+(?:\.\d+)?)%\s+utilized/i);
      const reset = detail.match(/resets\s+([0-9TZ:.-]+)/i);
      const resetMs = reset?.[1] ? Date.parse(reset[1]) : Number.NaN;
      rateLimit = {
        usedPercentage: pct?.[1] ? Number(pct[1]) : null,
        resetsAt: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : null,
      };
    }
  }
  const used = inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null;
  const limit = eventLimit ?? (typeof fallbackContextWindow === "number" && fallbackContextWindow > 0 ? fallbackContextWindow : null);
  if (used != null && limit != null && limit > 0) {
    percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return { percent, streaming, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextWindow: limit, costUsd, rateLimit };
}
