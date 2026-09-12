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
    currentTurnStartedAt: null,
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
  /**
   * Identity key of this chat's orchestration parent, when the parent IS an
   * identity session (today: the CTO). Resolved by the caller from HOST state —
   * the same `listSessions` answer this projection is built from — because the
   * parent's identity is a fact about the parent row, and a renderer-side cache
   * of it would go stale the moment a chat is reparented or the CTO thread is
   * recreated.
   *
   * Passed in rather than read off `chat` for the same reason
   * `orchestrationParentSessionId` is: a summary describes ITSELF, and asking
   * one row to carry a claim about a different row is how the two drift.
   */
  parentIdentityKey?: string | null,
): TerminalSessionSummary {
  const base: TerminalSessionSummary = {
    ...session,
    currentTurnStartedAt: chat.currentTurnStartedAt ?? null,
    nextWakeAt: chat.nextWakeAt,
    usageLimitParkedUntil: chat.usageLimitParkedUntil ?? null,
    usageLimitResume: chat.usageLimitResume ?? null,
    chatActivityMode: chat.interactionMode === "plan" ? "planning" : null,
    activeBackgroundTaskCount: chat.activeBackgroundTaskCount ?? 0,
    ...(chat.backgroundWork ? { backgroundWork: chat.backgroundWork } : {}),
    ...(chat.backgroundWorkSince ? { backgroundWorkSince: chat.backgroundWorkSince } : {}),
    ...(chat.runtimeProcesses?.length ? { runtimeProcesses: chat.runtimeProcesses } : {}),
    ...(chat.modelHandoffHistory?.length
      ? { modelHandoffHistory: chat.modelHandoffHistory }
      : {}),
    // Whatever the provider actually reported, and nothing more. A blank or
    // absent model must stay absent on the row: the card renders the chip only
    // when there is a real answer, so "we do not know" and "no model" have to
    // be the same value here rather than an empty string the UI has to re-test.
    ...(chat.model?.trim() ? { model: chat.model.trim() } : {}),
    ...(chat.modelId?.trim() ? { modelId: chat.modelId.trim() } : {}),
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
    // Only stamped when there genuinely is an identity parent. Writing an
    // explicit `null` would make every ordinary spawned chat carry the field,
    // and "present but null" and "absent" would then have to mean the same
    // thing at every read site — one more invariant for no gain.
    // The caller's resolution wins, and the chat service's own field is the
    // fallback — either side may be the one that knows, and both read the same
    // host state, so they cannot disagree about a parent that exists.
    ...(chat.orchestrationParentSessionId && (parentIdentityKey ?? chat.parentIdentityKey)
      ? { parentIdentityKey: parentIdentityKey ?? chat.parentIdentityKey }
      : {}),
    ...(chat.spawnKind ? { spawnKind: chat.spawnKind } : {}),
    ...(chat.steeringInput ? { steeringInput: true } : {}),
    lastActivityAt: chat.lastActivityAt ?? session.lastActivityAt ?? null,
    ...(chat.cursorCloudAgentId ? { cursorCloudAgentId: chat.cursorCloudAgentId } : {}),
  };
  if (chat.awaitingInput) {
    const pendingInputItemId = chat.pendingInputItemId ?? session.pendingInputItemId ?? null;
    return {
      ...base,
      runtimeState: "waiting-input",
      chatIdleSinceAt: null,
      pendingInputItemId,
      // `provider_structured` is the claim "there is a structured card the
      // provider is blocked on", and `canonicalSessionState` treats it as a
      // needs-you trigger in its OWN right — independent of the item id. So
      // stamping it with a null item id manufactures a Needs you that names no
      // card: nothing to answer, and answering the card that just settled does
      // not clear it, because the answer clears the item id (and the attention
      // columns) while this source would be re-stamped on the next projection.
      // With no item id, leave whatever the row already declared alone.
      ...(pendingInputItemId
        ? { attentionSource: "provider_structured" as const }
        : {
            attentionSource: session.attentionSource === "provider_structured"
              ? null
              : session.attentionSource,
          }),
    };
  }
  if (chat.status === "active") {
    return {
      ...base,
      runtimeState: "running",
      chatIdleSinceAt: null,
      pendingInputItemId: null,
      attentionSource: session.attentionSource === "provider_structured" ? null : session.attentionSource,
    };
  }
  if (chat.status === "idle" || chat.status === "ended") {
    return {
      ...base,
      runtimeState: "idle",
      chatIdleSinceAt: chat.idleSinceAt ?? null,
      pendingInputItemId: null,
      attentionSource: session.attentionSource === "provider_structured" ? null : session.attentionSource,
    };
  }
  return fallbackUnprojectedChatSession(base);
}

export function projectChatSummariesOntoSessions(
  sessions: TerminalSessionSummary[],
  allChats: AgentChatSessionSummary[],
): TerminalSessionSummary[] {
  const identitySessionIds = new Set<string>();
  /**
   * Identity sessions, by id, so a CHILD can be told who its parent is.
   *
   * The identity rows are already in `allChats` (the caller asks for them with
   * `includeIdentity: true`) and are already indexed here to be filtered OUT of
   * the roster — the CTO thread is hidden from every session list. Keying their
   * identity here costs one map and makes the lineage stamp a pure function of
   * host state: no extra fetch, no renderer cache, and nothing to go stale.
   */
  const identityKeyBySessionId = new Map<string, string>();
  const chatSummaryBySessionId = new Map<string, AgentChatSessionSummary>();
  for (const chat of allChats) {
    if (chat.identityKey) {
      identitySessionIds.add(chat.sessionId);
      identityKeyBySessionId.set(chat.sessionId, chat.identityKey);
    } else {
      chatSummaryBySessionId.set(chat.sessionId, chat);
    }
  }

  return sessions
    .filter((session) => !identitySessionIds.has(session.id))
    .map((session) => {
      if (!isChatToolType(session.toolType)) return session;
      const chat = chatSummaryBySessionId.get(session.id);
      if (!chat) return fallbackUnprojectedChatSession(session);
      const parentIdentityKey = chat.orchestrationParentSessionId
        ? identityKeyBySessionId.get(chat.orchestrationParentSessionId) ?? null
        : null;
      return projectChatOntoSession(session, chat, parentIdentityKey);
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
    if (!chat) return fallbackUnprojectedChatSession(session);
    // Same fact, same source, one row at a time: the detail path has no roster
    // to index, so it asks the host for the parent directly rather than letting
    // the caller supply an answer the list path derived.
    let parentIdentityKey: string | null = null;
    if (chat.orchestrationParentSessionId && services.agentChatService) {
      const parent = await services.agentChatService.getSessionSummary(
        chat.orchestrationParentSessionId,
      );
      parentIdentityKey = parent?.identityKey ?? null;
    }
    return projectChatOntoSession(session, chat, parentIdentityKey);
  } catch (error) {
    services.logger.warn("sessions.chat_projection_failed", {
      sessionId,
      error: getErrorMessage(error),
    });
    return fallbackUnprojectedChatSession(session);
  }
}
