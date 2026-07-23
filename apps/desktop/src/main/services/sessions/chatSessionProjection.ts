import type {
  AgentChatSessionSummary,
  TerminalSessionSummary,
} from "../../../shared/types";

export function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const normalized = toolType.trim().toLowerCase();
  return normalized === "cursor" || normalized.endsWith("-chat");
}

/**
 * Persisted chat rows stay "running" so they remain resumable across provider
 * restarts. If chat-state projection is unavailable, treat that storage state
 * as quiet rather than presenting a false live/green session.
 */
export function fallbackUnprojectedChatSession(
  session: TerminalSessionSummary,
): TerminalSessionSummary {
  if (!isChatToolType(session.toolType) || session.status !== "running") return session;
  return {
    ...session,
    runtimeState: session.pendingInputItemId ? "waiting-input" : "idle",
    chatIdleSinceAt: session.chatIdleSinceAt ?? null,
  };
}

/**
 * Project chat runtime state and orchestration identity onto its terminal row.
 * All desktop surfaces use this mapping so list, detail, and lane summaries do
 * not disagree about whether an agent is running or waiting.
 */
export function projectChatOntoSession(
  session: TerminalSessionSummary,
  chat: AgentChatSessionSummary,
): TerminalSessionSummary {
  const base: TerminalSessionSummary = {
    ...session,
    nextWakeAt: chat.nextWakeAt,
    ...(chat.claudeTag !== undefined ? { claudeTag: chat.claudeTag } : {}),
    ...(chat.orchestrationRunId
      ? {
          orchestrationRunId: chat.orchestrationRunId,
          orchestrationRole: chat.orchestrationRole,
          orchestrationTag: chat.orchestrationTag,
        }
      : {}),
    ...(chat.orchestrationParentSessionId
      ? { orchestrationParentSessionId: chat.orchestrationParentSessionId }
      : {}),
    ...(chat.spawnKind ? { spawnKind: chat.spawnKind } : {}),
  };
  if (chat.awaitingInput) {
    return {
      ...base,
      runtimeState: "waiting-input",
      chatIdleSinceAt: null,
      pendingInputItemId: chat.pendingInputItemId ?? session.pendingInputItemId ?? null,
    };
  }
  if (chat.status === "active") {
    return { ...base, runtimeState: "running", chatIdleSinceAt: null };
  }
  if (chat.status === "idle" || chat.status === "ended") {
    return { ...base, runtimeState: "idle", chatIdleSinceAt: chat.idleSinceAt ?? null };
  }
  return fallbackUnprojectedChatSession(base);
}
