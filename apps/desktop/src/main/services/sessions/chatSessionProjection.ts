import type {
  AgentChatSessionSummary,
  ListSessionsArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
} from "../../../shared/types";
import { sanitizeResumeTargetId } from "../../utils/terminalSessionSignals";
import { getErrorMessage } from "../shared/utils";

type ChatProjectionServices = {
  sessionService: {
    list(args?: ListSessionsArgs): TerminalSessionSummary[];
    get(sessionId: string): TerminalSessionSummary | null;
  };
  ptyService?: {
    enrichSessions(sessions: TerminalSessionSummary[]): TerminalSessionSummary[];
    ensureResumeTargets?(sessionIds: string[]): Promise<void>;
  } | null;
  agentChatService?: {
    listSessions(
      laneId?: string,
      options?: { includeIdentity?: boolean; includeAutomation?: boolean },
    ): Promise<AgentChatSessionSummary[]>;
    getSessionSummary(sessionId: string): Promise<AgentChatSessionSummary | null>;
  } | null;
  logger: {
    warn(event: string, data: Record<string, unknown>): void;
  };
};

function sessionNeedsResumeTargetHydration(session: TerminalSessionSummary): boolean {
  if (!session.tracked || session.status === "running") return false;
  if (sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null)) return false;
  return (
    session.toolType === "claude"
    || session.toolType === "codex"
    || session.toolType === "claude-orchestrated"
    || session.toolType === "codex-orchestrated"
  );
}

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
    return {
      ...base,
      runtimeState: "running",
      chatIdleSinceAt: null,
      pendingInputItemId: null,
    };
  }
  if (chat.status === "idle" || chat.status === "ended") {
    return {
      ...base,
      runtimeState: "idle",
      chatIdleSinceAt: chat.idleSinceAt ?? null,
      pendingInputItemId: null,
    };
  }
  return fallbackUnprojectedChatSession(base);
}

export function projectChatSummariesOntoSessions(
  sessions: TerminalSessionSummary[],
  allChats: AgentChatSessionSummary[],
): TerminalSessionSummary[] {
  const identitySessionIds = new Set(
    allChats
      .filter((chat) => Boolean(chat.identityKey))
      .map((chat) => chat.sessionId),
  );
  const chatSummaryBySessionId = new Map(
    allChats
      .filter((chat) => !chat.identityKey)
      .map((chat) => [chat.sessionId, chat] as const),
  );

  return sessions
    .filter((session) => !identitySessionIds.has(session.id))
    .map((session) => {
      if (!isChatToolType(session.toolType)) return session;
      const chat = chatSummaryBySessionId.get(session.id);
      return chat
        ? projectChatOntoSession(session, chat)
        : fallbackUnprojectedChatSession(session);
    });
}

export async function listSessionsWithChatProjection(
  services: ChatProjectionServices,
  args: ListSessionsArgs = {},
): Promise<TerminalSessionSummary[]> {
  let listedSessions = services.sessionService.list(args);
  const missingResumeTargetIds = listedSessions
    .filter(sessionNeedsResumeTargetHydration)
    .slice(0, 10)
    .map((session) => session.id);
  if (missingResumeTargetIds.length > 0 && services.ptyService?.ensureResumeTargets) {
    try {
      await services.ptyService.ensureResumeTargets(missingResumeTargetIds);
      listedSessions = services.sessionService.list(args);
    } catch (error) {
      services.logger.warn("sessions.resume_target_hydration_failed", {
        sessionIds: missingResumeTargetIds,
        err: String(error),
      });
    }
  }
  const sessions = services.ptyService
    ? services.ptyService.enrichSessions(listedSessions)
    : listedSessions;
  const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
  let allChats: AgentChatSessionSummary[] = [];
  if (services.agentChatService) {
    try {
      allChats = await services.agentChatService.listSessions(laneId || undefined, {
        includeIdentity: true,
        includeAutomation: true,
      });
    } catch (error) {
      services.logger.warn("sessions.chat_projection_failed", {
        laneId: laneId || null,
        error: getErrorMessage(error),
      });
    }
  }
  return projectChatSummariesOntoSessions(sessions, allChats);
}

export async function getSessionWithChatProjection(
  services: ChatProjectionServices,
  sessionId: string,
): Promise<TerminalSessionDetail | null> {
  let persisted = services.sessionService.get(sessionId);
  if (!persisted) return null;
  if (sessionNeedsResumeTargetHydration(persisted) && services.ptyService?.ensureResumeTargets) {
    try {
      await services.ptyService.ensureResumeTargets([sessionId]);
      persisted = services.sessionService.get(sessionId) ?? persisted;
    } catch (error) {
      services.logger.warn("sessions.resume_target_hydration_failed", {
        sessionIds: [sessionId],
        err: String(error),
      });
    }
  }
  const session = services.ptyService?.enrichSessions([persisted])[0] ?? persisted;
  if (!isChatToolType(session.toolType)) return session;
  try {
    const chat = await services.agentChatService?.getSessionSummary(sessionId);
    return chat
      ? projectChatOntoSession(session, chat)
      : fallbackUnprojectedChatSession(session);
  } catch (error) {
    services.logger.warn("sessions.chat_projection_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
    return fallbackUnprojectedChatSession(session);
  }
}
