import type {
  AgentChatEventEnvelope,
  AgentChatSession,
  AgentChatSessionSummary,
  PersonalChatAction,
  PersonalChatCallArgs,
  PersonalChatCallResponse,
} from "../../../shared/types";
import type { AgentChatApi } from "../chat/agentChatApi";
import { CONSERVATIVE_ATTACHMENT_STAGING_MODE } from "../chat/chatAttachmentStaging";

/**
 * `window.ade.agentChat`, re-pointed at the machine's personal-chat scope.
 *
 * This is the one place a chat pane's calls are translated for a chat with no
 * project. Every method maps to a `personalChats.*` action and ignores the
 * project pin a pane passes, because a personal chat lives on the window's
 * machine, not on a project. Methods personal chats have no backend action for
 * (fork, rewind, compact, goals, handoff, import, Codex goal/voice, lane
 * naming, mention search, file search, prompt stashes) are absent, and the
 * pane hides what would call them. Nothing here falls back to the project API.
 */

export type PersonalChatsBridge = {
  call(request: PersonalChatCallArgs): Promise<PersonalChatCallResponse>;
  streamEvents(request?: { cursor?: number; limit?: number }): Promise<{
    events: Array<{ id: number; payload: Record<string, unknown> }>;
    nextCursor: number;
    hasMore: boolean;
  }>;
};

const EVENT_POLL_MS = 700;

function resultOf<T>(response: PersonalChatCallResponse | T): T {
  if (response && typeof response === "object" && "result" in response) {
    return (response as PersonalChatCallResponse).result as T;
  }
  return response as T;
}

/** A chat event envelope out of one buffered runtime event, whatever it is wrapped in. */
export function personalEnvelopeFromPayload(payload: Record<string, unknown>): AgentChatEventEnvelope | null {
  const candidates = [payload.envelope, payload.chatEvent, payload.event, payload];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.sessionId === "string"
      && typeof record.timestamp === "string"
      && record.event
      && typeof record.event === "object"
    ) {
      return record as unknown as AgentChatEventEnvelope;
    }
  }
  return null;
}

/** The pane reads `created.id`; personal `create` answers with a summary. */
function sessionFromSummary(summary: AgentChatSessionSummary): AgentChatSession {
  return { ...summary, id: summary.sessionId } as unknown as AgentChatSession;
}

export function createPersonalAgentChatApi(bridge: PersonalChatsBridge): AgentChatApi {
  const call = async <T>(action: PersonalChatAction, args?: unknown): Promise<T> => {
    const request = (args === undefined ? { action } : { action, args }) as PersonalChatCallArgs;
    return resultOf<T>(await bridge.call(request));
  };

  // One poller for every subscriber (the pane, the rail), started by the first
  // and stopped by the last.
  const listeners = new Set<(event: AgentChatEventEnvelope) => void>();
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  const poll = async () => {
    timer = null;
    if (!listeners.size || polling) return;
    polling = true;
    try {
      const result = await bridge.streamEvents({ cursor, limit: 200 });
      cursor = result.nextCursor ?? cursor;
      for (const entry of result.events ?? []) {
        const envelope = personalEnvelopeFromPayload(entry.payload ?? {});
        if (!envelope) continue;
        for (const listener of [...listeners]) {
          try { listener(envelope); } catch { /* a listener's failure is its own */ }
        }
      }
    } catch {
      // Transient: the next tick retries. The pane's own recovery re-reads history.
    } finally {
      polling = false;
      if (listeners.size) timer = setTimeout(() => void poll(), EVENT_POLL_MS);
    }
  };

  // Actions personal chats have no backend for. The pane hides the controls
  // that call them; these answer any path that still reaches one with a
  // clear refusal instead of a TypeError, and never with a project call.
  const unavailable = (name: string) => async () => {
    throw new Error(`${name} is not available in a chat without a project.`);
  };

  const api = {
    // Best-effort pre-start of a CLI-backed model; the personal runtime
    // starts the provider on the first send instead.
    warmupModel: async () => undefined,
    handoff: unavailable("Handoff"),
    rewindFiles: unavailable("Rewind"),
    recoverContinuity: unavailable("Transcript recovery"),
    recoverCodexTurn: unavailable("Codex turn recovery"),
    generateAutoLaneIdentity: unavailable("Lane naming"),
    getContextUsage: unavailable("/context"),
    dismissPendingInput: unavailable("Dismissing a question"),
    parallelLaunchState: { get: unavailable("Parallel launch"), set: unavailable("Parallel launch") },
    codex: {
      getGoal: async () => null,
      setGoal: unavailable("Codex goals"),
      clearGoal: unavailable("Codex goals"),
      setGoalStatus: unavailable("Codex goals"),
      resetMemory: unavailable("Codex memory reset"),
      terminateBackgroundTerminal: unavailable("Stopping a Codex background terminal"),
    },
    list:(args?: { includeArchived?: boolean }) =>
      call<AgentChatSessionSummary[]>("list", { includeArchived: args?.includeArchived === true })
        .then((rows) => (Array.isArray(rows) ? rows : [])),
    getSummary: (args: { sessionId: string }) => call<AgentChatSessionSummary | null>("getSummary", { sessionId: args.sessionId }),
    create: async (args: Record<string, unknown>) => {
      // The lane is the pane's business, not a personal chat's: the scope
      // places the chat on its own internal lane.
      const { laneId: _laneId, ...rest } = args;
      return sessionFromSummary(await call<AgentChatSessionSummary>("create", { ...rest, personalProfile: "assistant" }));
    },
    send: (args: unknown) => call<void>("send", args),
    steer: (args: unknown) => call("steer", args),
    cancelSteer: (args: unknown) => call<void>("cancelSteer", args),
    editSteer: (args: unknown) => call<void>("editSteer", args),
    moveSteer: (args: unknown) => call<void>("moveSteer", args),
    dispatchSteer: (args: unknown) => call("dispatchSteer", args),
    cancelDispatchedSteer: (args: unknown) => call("cancelDispatchedSteer", args),
    interrupt: (args: unknown) => call("interrupt", args),
    stopTask: (args: unknown) => call("stopTask", args),
    restoreCancelledQueue: (args: unknown) => call("restoreCancelledQueue", args),
    recoverTurn: (args: unknown) => call("recoverTurn", args),
    resolveUnprocessedMessage: (args: unknown) => call("resolveUnprocessedMessage", args),
    respondToInput: (args: unknown) => call<void>("respondToInput", args),
    approve: (args: unknown) => call<void>("approve", args),
    updateSession: async (args: { sessionId: string }) =>
      sessionFromSummary(await call<AgentChatSessionSummary>("updateSession", args)),
    archive: (args: { sessionId: string }) => call<void>("archive", { sessionId: args.sessionId }),
    unarchive: (args: { sessionId: string }) => call<void>("unarchive", { sessionId: args.sessionId }),
    delete: (args: { sessionId: string }) => call<void>("delete", { sessionId: args.sessionId }),
    createScheduledWork: (args: unknown) => call("createScheduledWork", args),
    cancelScheduledWork: (args: unknown) => call("cancelScheduledWork", args),
    setScheduledWorkPaused: (args: unknown) => call("setScheduledWorkPaused", args),
    resumeUsageLimitNow: (args: unknown) => call("resumeUsageLimitNow", args),
    continueUsageLimitOnAlternate: (args: unknown) => call("continueUsageLimitOnAlternate", args),
    models: (args: unknown) => call("models", args),
    modelCatalog: (args?: unknown) => call("modelCatalog", args),
    slashCommands: (args: { sessionId?: string; provider?: string | null }) =>
      call("slashCommands", {
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      }).then((rows) => (Array.isArray(rows) ? rows : [])),
    getEventHistory: (args: unknown) => call("getEventHistory", args),
    getEventHistoryPage: (args: unknown) => call("getEventHistoryPage", args),
    // Personal attachments are images saved into the scope's own store; the
    // scope refuses anything else, so the composer is told to send bytes.
    getAttachmentStagingMode: async () => CONSERVATIVE_ATTACHMENT_STAGING_MODE,
    saveTempAttachment: (args: { data: string; filename: string }) =>
      call<{ path: string }>("saveTempAttachment", { base64: args.data, filename: args.filename }),
    getImageDataUrl: (path: string) => call<{ dataUrl: string }>("getImageDataUrl", { path }),
    onEvent: (listener: (event: AgentChatEventEnvelope) => void) => {
      listeners.add(listener);
      if (listeners.size === 1 && timer == null && !polling) void poll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
  return api as unknown as AgentChatApi;
}
