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
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  AgentChatCodexSandbox,
  AgentChatContextUsage,
  AgentChatCursorConfigValue,
  AgentChatDispatchSteerMode,
  AgentChatDispatchSteerResult,
  AgentChatDroidPermissionMode,
  AgentChatEventEnvelope,
  AgentChatMainTranscriptArgs,
  AgentChatEventHistoryPage,
  AgentChatFileRef,
  AgentChatInteractionMode,
  AgentChatKillDroidWorkerArgs,
  AgentChatMessageSessionKind,
  AgentChatMessageSessionResult,
  AgentChatModelCatalog,
  AgentChatModelCatalogArgs,
  AgentChatModelInfo,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
  AgentChatScheduledWorkState,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatSteerResult,
  AgentChatSubagentListArgs,
  AgentChatSubagentSnapshot,
  AgentChatSubagentTranscriptArgs,
  AgentChatSubagentTranscriptMessage,
  ClaudeActiveGoal,
  CodexThreadGoal,
} from "../../../desktop/src/shared/types/chat";
import type {
  AiSettingsStatus,
  LaneEnvInitProgress,
  LaneTemplate,
  OpenCodeRuntimeSnapshot,
} from "../../../desktop/src/shared/types/config";
import type { DiffLineStats, GitBranchSummary } from "../../../desktop/src/shared/types/git";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { PrLaneSummary } from "../../../desktop/src/shared/types/prs";
import type {
  ChatTerminalPreviewResult,
  ChatTerminalSession,
  PtyResumeSessionResult,
  PtySendToSessionResult,
  TerminalSessionSummary,
} from "../../../desktop/src/shared/types";
import { discoverAllProjectSlashCommands } from "../../../desktop/src/main/services/chat/projectSlashCommandDiscovery";
import type { AdeCodeConnection, AdeCodeInterfaceMode, AdeCodeProvider, ChatHistorySnapshot, CreatedChat, NavigateRequest, NavigateResult } from "./types";

export const DEFAULT_CODEX_REASONING_EFFORT = "low";

export async function listLanes(
  connection: AdeCodeConnection,
  options: { includeArchived?: boolean } = {},
): Promise<LaneSummary[]> {
  return await connection.action<LaneSummary[]>("lane", "list", {
    includeArchived: options.includeArchived ?? false,
    includeStatus: true,
  });
}

export type DefaultLaneSetupResult = {
  progress: LaneEnvInitProgress;
  templateId: string | null;
};

export async function runDefaultLaneSetup(
  connection: AdeCodeConnection,
  laneId: string,
  options: { templateId?: string | null } = {},
): Promise<DefaultLaneSetupResult> {
  const [templates, defaultTemplateId] = await Promise.all([
    connection.action<LaneTemplate[]>("lane", "listTemplates").catch(() => []),
    connection.action<string | null>("lane", "getDefaultTemplate").catch(() => null),
  ]);
  const explicitTemplateId = typeof options.templateId === "string" ? options.templateId.trim() : "";
  const trimmedTemplateId = explicitTemplateId || (typeof defaultTemplateId === "string" ? defaultTemplateId.trim() : "");
  const templateId = trimmedTemplateId
    ? templates.find((template) => template.id === trimmedTemplateId)?.id ?? null
    : null;
  if (explicitTemplateId && !templateId) {
    throw new Error(`Setup template "${explicitTemplateId}" was not found.`);
  }
  const progress = templateId
    ? await connection.action<LaneEnvInitProgress>("lane", "applyTemplate", { laneId, templateId })
    : await connection.action<LaneEnvInitProgress>("lane", "initEnv", { laneId });
  return { progress, templateId };
}

export async function listGitBranches(
  connection: AdeCodeConnection,
  laneId: string,
): Promise<GitBranchSummary[]> {
  // git.listBranches returns local + remote-tracking refs (remote names come
  // back in "<remote>/<name>" form). Used by the new-lane branch typeahead.
  return (await connection.action<GitBranchSummary[]>("git", "listBranches", { laneId })) ?? [];
}

export async function listLaneDiffStats(
  connection: AdeCodeConnection,
  laneIds?: string[],
): Promise<Record<string, DiffLineStats>> {
  // Normalize a null/undefined action result (older runtimes, transport
  // hiccups) to an empty record — callers keep this in render-time state.
  return (await connection.action<Record<string, DiffLineStats>>("diff", "listLaneDiffStats", {
    ...(laneIds ? { laneIds } : {}),
  })) ?? {};
}

export async function listChatSessions(
  connection: AdeCodeConnection,
  laneId?: string | null,
  options: { includeArchived?: boolean } = {},
): Promise<AgentChatSessionSummary[]> {
  return await connection.action<AgentChatSessionSummary[]>("chat", "listSessions", {
    ...(laneId ? { laneId } : {}),
    includeArchived: options.includeArchived ?? false,
  });
}

export async function getScheduledWorkState(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatScheduledWorkState> {
  return await connection.action<AgentChatScheduledWorkState>("chat", "getScheduledWorkState", {
    sessionId,
  });
}

export async function archiveChatSession(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<void> {
  await connection.action("chat", "archiveSession", { sessionId });
}

export async function unarchiveChatSession(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<void> {
  await connection.action("chat", "unarchiveSession", { sessionId });
}

export async function deleteChatSession(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<void> {
  await connection.action("chat", "deleteSession", { sessionId });
}

const CHAT_BACKED_TERMINAL_TOOL_TYPES = new Set([
  "codex-chat",
  "claude-chat",
  "opencode-chat",
  "cursor",
  "droid-chat",
]);

const TRACKED_CLI_PROVIDERS = new Set<AdeCodeProvider>([
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
]);

/**
 * Resolve the CLI provider backing a tracked terminal session (or null when the
 * session is not a provider CLI — e.g. a plain shell). Recognizes provider
 * metadata, the tool-type prefix, and, as a legacy fallback, a `claude` resume
 * command. Mirrors terminalSessionResumeProvider in app.tsx and
 * isTerminalSessionLaunchable in remoteLauncher.ts. Callers should exclude
 * CHAT_BACKED_TERMINAL_TOOL_TYPES first (a "cursor" chat vs a "cursor-cli" CLI).
 */
export function trackedCliTerminalProvider(session: ChatTerminalSession): AdeCodeProvider | null {
  const metaProvider = session.resumeMetadata?.provider;
  if (metaProvider && TRACKED_CLI_PROVIDERS.has(metaProvider as AdeCodeProvider)) {
    return metaProvider as AdeCodeProvider;
  }
  const toolType = session.toolType ?? "";
  if (toolType.startsWith("codex")) return "codex";
  if (toolType.startsWith("cursor")) return "cursor";
  if (toolType.startsWith("droid")) return "droid";
  if (toolType.startsWith("opencode")) return "opencode";
  if (toolType.startsWith("claude")) return "claude";
  const resumeCommand = typeof session.resumeCommand === "string" ? session.resumeCommand.trim().toLowerCase() : "";
  return resumeCommand && /\bclaude\b/.test(resumeCommand) ? "claude" : null;
}

export async function listTerminalSessions(
  connection: AdeCodeConnection,
  laneId?: string | null,
): Promise<ChatTerminalSession[]> {
  const sessions = await connection.action<ChatTerminalSession[]>("terminal", "list", {
    ...(laneId ? { laneId } : {}),
    limit: 200,
  });
  return sessions.filter((session) => {
    const toolType = session.toolType ?? "";
    if (CHAT_BACKED_TERMINAL_TOOL_TYPES.has(toolType)) return false;
    return trackedCliTerminalProvider(session) !== null;
  });
}

export async function previewTerminal(
  connection: AdeCodeConnection,
  terminalId: string,
): Promise<ChatTerminalPreviewResult> {
  return await connection.action<ChatTerminalPreviewResult>("terminal", "preview", {
    terminalId,
  });
}

export async function writeTerminal(
  connection: AdeCodeConnection,
  terminalId: string,
  data: string,
): Promise<void> {
  await connection.action("terminal", "write", { terminalId, data });
}

export async function resizeTerminal(
  connection: AdeCodeConnection,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await connection.action("terminal", "resize", { terminalId, cols, rows });
}

export async function signalTerminal(
  connection: AdeCodeConnection,
  terminalId: string,
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
): Promise<void> {
  await connection.action("terminal", "signal", { terminalId, signal });
}

/** The five provider CLIs the TUI can launch as a tracked terminal session. */
export type CliTerminalProvider = Extract<AdeCodeProvider, "claude" | "codex" | "cursor" | "droid" | "opencode">;

export type StartCliTerminalSessionResult = {
  provider: string;
  laneId: string;
  title: string;
  permissionMode: AgentChatPermissionMode;
  model: string | null;
  ptyId: string;
  sessionId: string;
  startupCommand: string | null;
  initialInputWritten: boolean;
  session: ChatTerminalSession | null;
};

function terminalSummaryToChatSession(session: TerminalSessionSummary): ChatTerminalSession {
  return {
    terminalId: session.id,
    ptyId: session.ptyId,
    chatSessionId: session.chatSessionId ?? null,
    laneId: session.laneId,
    laneName: session.laneName,
    title: session.title,
    toolType: session.toolType,
    goal: session.goal,
    status: session.status,
    runtimeState: session.runtimeState,
    active: session.status === "running",
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    pid: null,
    resumeCommand: session.resumeCommand,
    resumeMetadata: session.resumeMetadata,
    lastOutputPreview: session.lastOutputPreview,
    summary: session.summary,
  };
}

export function normalizeChatTerminalSession(
  session: ChatTerminalSession | TerminalSessionSummary | null,
): ChatTerminalSession | null {
  if (!session) return null;
  if ("terminalId" in session) return session;
  return terminalSummaryToChatSession(session);
}

/**
 * Start a tracked provider CLI terminal via the shared `start_cli_session`
 * action. The runtime owns launch-command construction (including Cursor CLI
 * model-variant resolution) and title/goal derivation, so the TUI only forwards
 * the picked provider/model/reasoning/permission plus the pane dimensions.
 */
export async function startCliTerminalSession(args: {
  connection: AdeCodeConnection;
  provider: CliTerminalProvider;
  laneId: string;
  title?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  permissionMode?: AgentChatPermissionMode | null;
  initialInput?: string | null;
  cols: number;
  rows: number;
}): Promise<StartCliTerminalSessionResult> {
  const result = await args.connection.tool<Omit<StartCliTerminalSessionResult, "session"> & {
    session: ChatTerminalSession | TerminalSessionSummary | null;
  }>("start_cli_session", {
    laneId: args.laneId,
    provider: args.provider,
    title: args.title ?? undefined,
    model: args.model ?? undefined,
    reasoningEffort: args.reasoningEffort ?? undefined,
    ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
    permissionMode: args.permissionMode ?? "default",
    initialInput: args.initialInput ?? undefined,
    cols: args.cols,
    rows: args.rows,
    tracked: true,
  });
  return {
    ...result,
    session: normalizeChatTerminalSession(result.session),
  };
}

export async function sendToTerminalSession(args: {
  connection: AdeCodeConnection;
  sessionId: string;
  text: string;
  cols: number;
  rows: number;
}): Promise<PtySendToSessionResult> {
  return await args.connection.action<PtySendToSessionResult>("pty", "sendToSession", {
    sessionId: args.sessionId,
    text: args.text,
    cols: args.cols,
    rows: args.rows,
  });
}

export async function resumeTerminalSession(args: {
  connection: AdeCodeConnection;
  sessionId: string;
  cols: number;
  rows: number;
}): Promise<PtyResumeSessionResult> {
  return await args.connection.action<PtyResumeSessionResult>("pty", "resumeSession", {
    sessionId: args.sessionId,
    cols: args.cols,
    rows: args.rows,
  });
}

export async function listPrsByLane(connection: AdeCodeConnection): Promise<PrLaneSummary[]> {
  return await connection.action<PrLaneSummary[]>("pr", "listPrsByLane", {});
}

export async function getChatHistory(
  connection: AdeCodeConnection,
  sessionId: string,
  maxEvents = 20_000,
): Promise<ChatHistorySnapshot> {
  return await connection.actionList<ChatHistorySnapshot>("chat", "getChatEventHistory", [sessionId, { maxEvents }]);
}

export async function getChatHistoryPage(
  connection: AdeCodeConnection,
  sessionId: string,
  beforeOffset: number,
  maxBytes?: number,
): Promise<AgentChatEventHistoryPage> {
  const page = await connection.actionList<AgentChatEventHistoryPage | null | undefined>(
    "chat",
    "getChatEventHistoryPage",
    [sessionId, { beforeOffset, ...(maxBytes ? { maxBytes } : {}) }],
  );
  // Defensive normalization: an older daemon (or a routing miss) can yield
  // null/partial results — treat those as "nothing pageable" so the scroll-back
  // loop terminates instead of spinning on a malformed cursor.
  if (!page || typeof page !== "object") {
    return { sessionId, events: [], startOffset: 0, hasMore: false, sessionFound: false };
  }
  return {
    sessionId: typeof page.sessionId === "string" ? page.sessionId : sessionId,
    events: Array.isArray(page.events) ? page.events : [],
    startOffset: typeof page.startOffset === "number" && Number.isFinite(page.startOffset)
      ? page.startOffset
      : 0,
    hasMore: page.hasMore === true,
    sessionFound: page.sessionFound !== false,
  };
}

export async function getSlashCommands(
  connection: AdeCodeConnection,
  args: string | null | AgentChatSlashCommandsArgs,
): Promise<AgentChatSlashCommand[]> {
  if (!args) return [];
  const requestArgs = typeof args === "string" ? { sessionId: args } : args;
  if (!requestArgs.sessionId && !requestArgs.laneId) return [];
  return await connection.action<AgentChatSlashCommand[]>("chat", "getSlashCommands", requestArgs);
}

export async function getContextUsage(
  connection: AdeCodeConnection,
  sessionId: string,
): Promise<AgentChatContextUsage | null> {
  return await connection.action<AgentChatContextUsage | null>("chat", "getContextUsage", { sessionId });
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

export function discoverProjectSlashCommands(workspaceRoot: string): AgentChatSlashCommand[] {
  return discoverAllProjectSlashCommands(workspaceRoot);
}

export async function getAvailableModels(
  connection: AdeCodeConnection,
  provider: AgentChatProvider,
  options: { interfaceMode?: AdeCodeInterfaceMode } = {},
): Promise<AgentChatModelInfo[]> {
  const cursorSource = options.interfaceMode === "cli" ? "cli" : "sdk";
  return await connection.action<AgentChatModelInfo[]>("chat", "getAvailableModels", {
    provider,
    // Cursor needs a live probe for SDK/CLI service tiers. Droid is also probed
    // here for live model/reasoning inventory, but Droid fast choices are model
    // IDs such as `claude-opus-4-6-fast`, not a separate service-tier toggle.
    // Codex is intentionally NOT here: its tiers come from the app-server, which
    // loadAvailableModels always queries regardless of activateRuntime.
    activateRuntime: provider === "cursor" || provider === "droid",
    ...(provider === "cursor" ? { cursorSource } : {}),
  });
}

export async function getModelCatalog(
  connection: AdeCodeConnection,
  args: AgentChatModelCatalogArgs = {},
): Promise<AgentChatModelCatalog> {
  return await connection.action<AgentChatModelCatalog>("chat", "modelCatalog", args);
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
  fastMode?: boolean;
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
          ? (getDefaultModelDescriptor("droid")?.providerModelId ?? "claude-sonnet-4-5-20250929")
          : "gpt-5.6-sol";
  const reasoningEffort = args.reasoningEffort
    ?? (provider === "codex" ? descriptor?.defaultReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT : null);
  return await args.connection.action<AgentChatSession>("chat", "createSession", {
    laneId: args.laneId,
    provider,
    model,
    ...(modelId ? { modelId } : {}),
    ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(args.fastMode === true ? { fastMode: true } : {}),
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

export async function messageChatSession(
  connection: AdeCodeConnection,
  sessionId: string,
  text: string,
  kind: AgentChatMessageSessionKind = "auto",
  attachments: AgentChatFileRef[] = [],
): Promise<AgentChatMessageSessionResult> {
  return await connection.action<AgentChatMessageSessionResult>("chat", "messageSession", {
    sessionId,
    text,
    kind,
    ...(attachments.length ? { attachments } : {}),
  });
}

export async function steerChatMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  text: string,
  attachments: AgentChatFileRef[] = [],
): Promise<AgentChatSteerResult> {
  return await connection.action<AgentChatSteerResult>("chat", "steer", {
    sessionId,
    text,
    ...(attachments.length ? { attachments } : {}),
  });
}

export async function cancelSteerMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  steerId: string,
): Promise<void> {
  await connection.action("chat", "cancelSteer", { sessionId, steerId });
}

/**
 * Upload raw attachment bytes to the runtime and get back a path that is valid
 * on the runtime's filesystem. This is the only correct way to attach a locally
 * sourced file (e.g. a pasted clipboard image) when the runtime is remote: the
 * bytes are written under `<runtime projectRoot>/.ade/attachments/...` on the
 * runtime machine, so the agent can actually read them. Mirrors the desktop
 * composer's `window.ade.agentChat.saveTempAttachment`.
 */
export async function saveRuntimeTempAttachment(
  connection: AdeCodeConnection,
  args: { data: string; filename: string },
): Promise<{ path: string }> {
  return await connection.action<{ path: string }>("chat", "saveTempAttachment", args);
}

export async function editSteerMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  steerId: string,
  text: string,
): Promise<void> {
  await connection.action("chat", "editSteer", { sessionId, steerId, text });
}

export async function dispatchSteerMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  steerId: string,
  mode: AgentChatDispatchSteerMode,
): Promise<AgentChatDispatchSteerResult> {
  return await connection.action<AgentChatDispatchSteerResult>("chat", "dispatchSteer", { sessionId, steerId, mode });
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

export async function recoverCodexTurn(
  connection: AdeCodeConnection,
  args: AgentChatRecoverCodexTurnArgs,
): Promise<AgentChatRecoverCodexTurnResult> {
  return await connection.action<AgentChatRecoverCodexTurnResult>(
    "chat",
    "recoverCodexTurn",
    args,
  );
}

/**
 * Pull a subagent's real child transcript from the daemon. Only meaningful for
 * runtimes with `canViewFullTranscript` (Codex app-server threads, OpenCode
 * child sessions); other runtimes return `null`/`[]` and the caller falls back
 * to the locally-reconstructed transcript. Mirrors the desktop takeover path.
 */
export async function getSubagentTranscript(
  connection: AdeCodeConnection,
  args: AgentChatSubagentTranscriptArgs,
): Promise<AgentChatSubagentTranscriptMessage[] | null> {
  return await connection.action<AgentChatSubagentTranscriptMessage[] | null>(
    "chat",
    "getSubagentTranscript",
    {
      sessionId: args.sessionId,
      agentId: args.agentId,
      ...(args.taskId != null ? { taskId: args.taskId } : {}),
      ...(args.laneId != null ? { laneId: args.laneId } : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    },
  );
}

export async function getMainTranscript(
  connection: AdeCodeConnection,
  args: AgentChatMainTranscriptArgs,
): Promise<AgentChatSubagentTranscriptMessage[] | null> {
  return await connection.action<AgentChatSubagentTranscriptMessage[] | null>(
    "chat",
    "getMainTranscript",
    {
      sessionId: args.sessionId,
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    },
  );
}

/** Daemon-backed roster of subagents for a session (richer than event-derived snapshots). */
export async function listSubagents(
  connection: AdeCodeConnection,
  args: AgentChatSubagentListArgs,
): Promise<AgentChatSubagentSnapshot[]> {
  const result = await connection.action<AgentChatSubagentSnapshot[] | null>("chat", "listSubagents", {
    sessionId: args.sessionId,
  });
  return Array.isArray(result) ? result : [];
}

/** Kill a single Droid AGI mission worker (only spawned in AGI orchestrator mode). */
export async function killDroidWorker(
  connection: AdeCodeConnection,
  args: AgentChatKillDroidWorkerArgs,
): Promise<void> {
  await connection.action("chat", "killDroidWorker", {
    sessionId: args.sessionId,
    workerSessionId: args.workerSessionId,
  });
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
  fastMode?: boolean;
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
    ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
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

// ---------------------------------------------------------------------------
// Model picker: cross-surface favorites + recents persisted in ade-cli.
// ---------------------------------------------------------------------------

export async function getModelPickerFavorites(connection: AdeCodeConnection): Promise<string[]> {
  const result = await connection.request<{ favorites: string[] }>("modelPicker.getFavorites", {});
  return Array.isArray(result?.favorites) ? result.favorites : [];
}

export async function toggleModelPickerFavorite(
  connection: AdeCodeConnection,
  modelId: string,
): Promise<{ favorites: string[]; isFavorite: boolean }> {
  const result = await connection.request<{ favorites: string[]; isFavorite: boolean }>(
    "modelPicker.toggleFavorite",
    { modelId },
  );
  return {
    favorites: Array.isArray(result?.favorites) ? result.favorites : [],
    isFavorite: Boolean(result?.isFavorite),
  };
}

export async function getModelPickerRecents(connection: AdeCodeConnection): Promise<string[]> {
  const result = await connection.request<{ recents: string[] }>("modelPicker.getRecents", {});
  return Array.isArray(result?.recents) ? result.recents : [];
}

export async function pushModelPickerRecent(
  connection: AdeCodeConnection,
  modelId: string,
): Promise<string[]> {
  const result = await connection.request<{ recents: string[] }>("modelPicker.pushRecent", {
    modelId,
  });
  return Array.isArray(result?.recents) ? result.recents : [];
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
  /** Last-turn input tokens read from cache (Codex `cachedInputTokens` / `cacheReadTokens`). */
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
  let compactionProtected = false;
  let protectedCompactionTurnId: string | null = null;
  let rateLimit: TokenStats["rateLimit"] = null;
  const readCacheReadTokens = (bucket: Record<string, unknown> | null): number | null => {
    if (!bucket) return null;
    if (typeof bucket.cacheReadTokens === "number") return bucket.cacheReadTokens;
    if (typeof (bucket as { cachedInputTokens?: unknown }).cachedInputTokens === "number") {
      return (bucket as { cachedInputTokens: number }).cachedInputTokens;
    }
    return null;
  };
  const readCacheWriteTokens = (bucket: Record<string, unknown> | null): number | null => {
    if (!bucket) return null;
    return typeof bucket.cacheWriteTokens === "number" ? bucket.cacheWriteTokens : null;
  };
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "status" && event.turnStatus === "started") {
      streaming = true;
      if (compactionProtected && typeof event.turnId === "string"
        && (!protectedCompactionTurnId || event.turnId !== protectedCompactionTurnId)) {
        compactionProtected = false;
        protectedCompactionTurnId = null;
      }
    }
    if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) streaming = false;
    if (event.type === "tokens") {
      if (compactionProtected) continue;
      inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : inputTokens;
      outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : outputTokens;
      cacheReadTokens = readCacheReadTokens(event) ?? cacheReadTokens;
      cacheCreationTokens = typeof event.cacheWriteTokens === "number" ? event.cacheWriteTokens : cacheCreationTokens;
      if (typeof event.contextWindow === "number") eventLimit = event.contextWindow;
    }
    if (event.type === "codex_token_usage") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      const total = usage?.total && typeof usage.total === "object" ? usage.total as Record<string, unknown> : null;
      const last = usage?.last && typeof usage.last === "object" ? usage.last as Record<string, unknown> : null;
      const hasContextOccupancy = typeof last?.inputTokens === "number" || typeof total?.inputTokens === "number";
      if (typeof usage?.modelContextWindow === "number") eventLimit = usage.modelContextWindow;
      if (!hasContextOccupancy) continue;
      inputTokens = typeof last?.inputTokens === "number"
        ? last.inputTokens
        : typeof total?.inputTokens === "number" ? total.inputTokens : inputTokens;
      outputTokens = typeof last?.outputTokens === "number"
        ? last.outputTokens
        : typeof total?.outputTokens === "number" ? total.outputTokens : outputTokens;
      // Codex passes cached read tokens as either cacheReadTokens (camelCase) or
      // cachedInputTokens (snake-cased upstream variant aliased through). Prefer
      // last-turn reading over total.
      cacheReadTokens = readCacheReadTokens(last) ?? readCacheReadTokens(total) ?? cacheReadTokens;
      cacheCreationTokens = readCacheWriteTokens(last) ?? readCacheWriteTokens(total) ?? cacheCreationTokens;
    }
    if (event.type === "context_usage") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      inputTokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : inputTokens;
      outputTokens = null;
      cacheReadTokens = null;
      cacheCreationTokens = null;
      if (typeof usage?.maxTokens === "number") eventLimit = usage.maxTokens;
    }
    if (event.type === "done") {
      if (compactionProtected) continue;
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : inputTokens;
      outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : outputTokens;
      cacheReadTokens = readCacheReadTokens(usage) ?? cacheReadTokens;
      cacheCreationTokens = typeof usage?.cacheCreationTokens === "number" ? usage.cacheCreationTokens : cacheCreationTokens;
      costUsd = typeof event.costUsd === "number" ? event.costUsd : costUsd;
      // Parity with desktop's contextUsageModel: the non-Codex runtimes attach the
      // effective context window to the terminal `done` event, so honor it for the
      // dial when present (runtime-reported window beats the registry fallback).
      if (typeof usage?.contextWindow === "number") eventLimit = usage.contextWindow;
    }
    const completedCompaction = (event.type === "context_compact" && event.state !== "started")
      || (event.type === "codex_context_compaction" && event.state === "completed");
    if (completedCompaction) {
      compactionProtected = true;
      protectedCompactionTurnId = typeof event.turnId === "string" ? event.turnId : null;
      inputTokens = event.type === "context_compact" && typeof event.postTokens === "number" ? event.postTokens : null;
      outputTokens = null;
      cacheReadTokens = null;
      cacheCreationTokens = null;
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

/**
 * Walk the event stream and return the most recently observed Codex goal.
 * Returns `null` when no goal has been set or the latest event is a clear.
 */
export function latestGoal(events: AgentChatEventEnvelope[]): CodexThreadGoal | null {
  let goal: CodexThreadGoal | null = null;
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "codex_goal_updated") {
      const next = (event as { goal?: CodexThreadGoal | null }).goal ?? null;
      goal = next ?? null;
    } else if (event.type === "codex_goal_cleared") {
      goal = null;
    }
  }
  return goal;
}

/**
 * Walk the event stream and return the most recently observed Claude goal.
 * When this transcript window has no goal event, retain the session snapshot;
 * an explicit clear event always wins over that fallback.
 */
export function deriveClaudeGoalFromEvents(
  events: AgentChatEventEnvelope[],
  sessionGoal: ClaudeActiveGoal | null | undefined = null,
): ClaudeActiveGoal | null {
  let goal = sessionGoal ?? null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "claude_goal_updated") {
      goal = event.goal;
    } else if (event.type === "claude_goal_cleared") {
      goal = null;
    }
  }
  return goal;
}
