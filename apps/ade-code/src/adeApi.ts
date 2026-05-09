import { getDefaultModelDescriptor, type ModelProviderGroup } from "../../desktop/src/shared/modelRegistry";
import type {
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSlashCommand,
} from "../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../desktop/src/shared/types/lanes";
import type { AdeCodeConnection, ChatHistorySnapshot, CreatedChat, NavigateRequest, NavigateResult } from "./types";

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

export async function createChatSession(args: {
  connection: AdeCodeConnection;
  laneId: string;
  title?: string | null;
  provider?: ModelProviderGroup;
  modelId?: string | null;
  reasoningEffort?: string | null;
}): Promise<CreatedChat> {
  const provider = args.provider ?? "codex";
  const descriptor = args.modelId
    ? null
    : getDefaultModelDescriptor(provider);
  const modelId = args.modelId ?? descriptor?.id ?? null;
  const model = descriptor?.providerModelId ?? descriptor?.shortId ?? (provider === "claude" ? "sonnet" : "gpt-5.5");
  return await args.connection.action<AgentChatSession>("chat", "createSession", {
    laneId: args.laneId,
    provider,
    model,
    ...(modelId ? { modelId } : {}),
    ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    surface: "work",
  });
}

export async function sendChatMessage(
  connection: AdeCodeConnection,
  sessionId: string,
  text: string,
  attachments: AgentChatFileRef[] = [],
): Promise<void> {
  await connection.action("chat", "sendMessage", {
    sessionId,
    text,
    ...(attachments.length ? { attachments } : {}),
  });
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
}): Promise<AgentChatSession> {
  return await args.connection.action("chat", "updateSession", {
    sessionId: args.sessionId,
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
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

export function latestTokenStats(events: AgentChatEventEnvelope[]): TokenStats {
  let percent: number | null = null;
  let streaming = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "status" && event.turnStatus === "started") streaming = true;
    if (event.type === "done" || (event.type === "status" && event.turnStatus === "completed")) streaming = false;
    if (event.type === "tokens") {
      inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : inputTokens;
      outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : outputTokens;
      const used = typeof event.totalTokens === "number"
        ? event.totalTokens
        : inputTokens != null || outputTokens != null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : null;
      const limit = typeof event.contextWindow === "number" ? event.contextWindow : null;
      if (used != null && limit != null && limit > 0) {
        percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
      }
    }
    if (event.type === "done") {
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
      inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : inputTokens;
      outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : outputTokens;
      costUsd = typeof event.costUsd === "number" ? event.costUsd : costUsd;
    }
  }
  return { percent, streaming, inputTokens, outputTokens, costUsd };
}
