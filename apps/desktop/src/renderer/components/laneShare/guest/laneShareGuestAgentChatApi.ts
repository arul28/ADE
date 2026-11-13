import type {
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatSessionSummary,
  AgentChatSteerResult,
} from "../../../../shared/types";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import type { MachineBoundAgentChatApi } from "../../chat/agentChatApi";
import { CONSERVATIVE_ATTACHMENT_STAGING_MODE } from "../../chat/chatAttachmentStaging";
import { boundChatRefusal, boundChatRefusals, sessionFromSummary, type PartialAgentChatApi } from "../../chat/boundAgentChatApi";
import type { LaneShareGuestConnection, LaneShareGuestConnectionState } from "./laneShareGuestConnection";

/**
 * `window.ade.agentChat`, re-pointed at one shared lane on the owner's
 * computer, so a guest reads and writes a shared chat in ADE's real chat pane.
 *
 * Every call goes through the guest connection, whose allow-list and the
 * owner's own guest gates decide what runs; nothing here reaches a project
 * runtime. History comes from the connection's chat subscription (a tail,
 * then live events). Methods with no guest command are absent or refuse, and
 * the pane hides what would call them. The pin a pane passes is ignored: the
 * adapter is bound to its share when it is made.
 */

type Listener = (event: AgentChatEventEnvelope) => void;

/** How long a history read waits for the owner's tail before it reads as unreachable. */
const SNAPSHOT_TIMEOUT_MS = 20_000;
const MAX_SEEN_KEYS = 64;
const WHERE = "on a shared lane";

export type LaneShareGuestAgentChatApi = MachineBoundAgentChatApi & {
  /** Ends the chat subscriptions this adapter opened. */
  dispose(): void;
};

function eventKey(entry: AgentChatEventEnvelope): string {
  return `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
}

/**
 * The fields of a send the owner's gate reads; attachments and local context
 * stay here. A model, reasoning level or mode the owner locked (an empty list:
 * "keep the chat's own") is left out, so the chat keeps its current one; the
 * pane may hold a hidden model's placeholder name.
 */
function guestSendArgs(args: Record<string, unknown>, rights: LaneShareGuestState["rights"] | null): Record<string, unknown> {
  const locked = new Set<string>();
  if (rights?.run.models.length === 0) locked.add("modelId");
  if (rights?.run.reasoningLevels.length === 0) locked.add("reasoningEffort");
  if (rights?.run.permissionModes.length === 0) locked.add("permissionMode");
  const out: Record<string, unknown> = {};
  for (const key of ["sessionId", "text", "displayText", "clientSendId", "modelId", "reasoningEffort", "permissionMode", "interactionMode"]) {
    if (args[key] !== undefined && !locked.has(key)) out[key] = args[key];
  }
  return out;
}

export function createLaneShareGuestAgentChatApi(
  connection: LaneShareGuestConnection,
  readGuestState: () => LaneShareGuestState | null,
): LaneShareGuestAgentChatApi {
  const listeners = new Set<Listener>();
  /** Sessions this adapter subscribed to, with their unsubscribe. */
  const subscriptions = new Map<string, () => void>();
  /** The newest event timestamp seen per session, and the keys seen at it (reconnect tails overlap). */
  const seen = new Map<string, { timestamp: string; keys: Set<string> }>();
  const waiting = new Map<string, Array<(snapshot: AgentChatEventHistorySnapshot) => void>>();

  const remember = (entry: AgentChatEventEnvelope): boolean => {
    const key = eventKey(entry);
    const last = seen.get(entry.sessionId);
    if (last && entry.timestamp < last.timestamp) return false;
    if (last && entry.timestamp === last.timestamp) {
      if (last.keys.has(key)) return false;
      if (last.keys.size < MAX_SEEN_KEYS) last.keys.add(key);
      return true;
    }
    seen.set(entry.sessionId, { timestamp: entry.timestamp, keys: new Set([key]) });
    return true;
  };

  /** The streamed text the pane holds for the current text or reasoning run, per session. */
  const textRuns = new Map<string, { key: string; text: string }>();
  const textRunKey = (entry: AgentChatEventEnvelope): string | null => {
    const event = entry.event as { type: string; text?: unknown; turnId?: unknown; itemId?: unknown; messageId?: unknown };
    if ((event.type !== "text" && event.type !== "reasoning") || typeof event.text !== "string") return null;
    return `${event.type}#${String(event.turnId ?? "")}#${String(event.itemId ?? "")}#${String(event.messageId ?? "")}`;
  };

  const emit = (entry: AgentChatEventEnvelope) => {
    const key = textRunKey(entry);
    if (key) {
      const run = textRuns.get(entry.sessionId);
      const text = (entry.event as { text: string }).text;
      textRuns.set(entry.sessionId, { key, text: run?.key === key ? run.text + text : text });
    } else {
      textRuns.delete(entry.sessionId);
    }
    for (const listener of [...listeners]) {
      try { listener(entry); } catch { /* a listener's failure is its own */ }
    }
  };

  /**
   * A row of a reconnect tail. The owner folds a run of streamed deltas into
   * one row, so a run the pane already got in part comes back whole: only the
   * part after what the pane holds is new.
   */
  const emitReplayed = (entry: AgentChatEventEnvelope) => {
    const key = textRunKey(entry);
    const run = textRuns.get(entry.sessionId);
    if (key && run?.key === key) {
      const text = (entry.event as { text: string }).text;
      if (run.text.startsWith(text)) return;
      if (text.startsWith(run.text)) {
        emit({ ...entry, event: { ...entry.event, text: text.slice(run.text.length) } as AgentChatEventEnvelope["event"] });
        return;
      }
    }
    emit(entry);
  };

  const offSnapshot = connection.on("chatSnapshot", (snapshot) => {
    if (!subscriptions.has(snapshot.sessionId)) return;
    const queue = waiting.get(snapshot.sessionId);
    if (queue?.length) {
      // A history read asked for this tail: it becomes the pane's history.
      waiting.delete(snapshot.sessionId);
      seen.delete(snapshot.sessionId);
      textRuns.delete(snapshot.sessionId);
      for (const entry of snapshot.events) remember(entry);
      // The history may end inside a streamed run: the pane holds that text.
      const last = snapshot.events[snapshot.events.length - 1];
      const lastKey = last ? textRunKey(last) : null;
      if (last && lastKey) textRuns.set(snapshot.sessionId, { key: lastKey, text: (last.event as { text: string }).text });
      const history: AgentChatEventHistorySnapshot = {
        sessionId: snapshot.sessionId,
        events: snapshot.events,
        truncated: snapshot.truncated,
        hasOlderHistory: false,
        sessionFound: true,
      };
      for (const resolve of queue) resolve(history);
      return;
    }
    // A tail after a reconnect: only what the pane has not had yet.
    for (const entry of snapshot.events) if (remember(entry)) emitReplayed(entry);
  });
  const offEvent = connection.on("chatEvent", (entry) => {
    if (!subscriptions.has(entry.sessionId)) return;
    if (remember(entry)) emit(entry);
  });
  // The connection drops its subscriptions when the socket closes; take them
  // up again on the next connect, so the pane keeps getting events.
  let wasConnected = connection.state.kind === "connected";
  const offState = connection.on("state", (state: LaneShareGuestConnectionState) => {
    const connected = state.kind === "connected";
    if (connected && !wasConnected) {
      for (const sessionId of [...subscriptions.keys()]) subscriptions.set(sessionId, connection.subscribeChat(sessionId));
    }
    wasConnected = connected;
  });

  const subscribe = (sessionId: string) => {
    if (subscriptions.has(sessionId)) {
      subscriptions.get(sessionId)?.();
    }
    subscriptions.set(sessionId, connection.subscribeChat(sessionId));
  };

  const getEventHistory = async (args: { sessionId: string }): Promise<AgentChatEventHistorySnapshot> => {
    const { sessionId } = args;
    if (!connection.listSessions().some((session) => session.sessionId === sessionId)) {
      await connection.refreshSessions().catch(() => undefined);
    }
    if (connection.state.kind !== "connected" || !connection.listSessions().some((session) => session.sessionId === sessionId)) {
      return { sessionId, events: [], truncated: false, unavailable: true };
    }
    return await new Promise<AgentChatEventHistorySnapshot>((resolve) => {
      const timer = setTimeout(() => {
        const queue = waiting.get(sessionId)?.filter((entry) => entry !== done) ?? [];
        if (queue.length) waiting.set(sessionId, queue); else waiting.delete(sessionId);
        resolve({ sessionId, events: [], truncated: false, unavailable: true });
      }, SNAPSHOT_TIMEOUT_MS);
      const done = (snapshot: AgentChatEventHistorySnapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      };
      waiting.set(sessionId, [...(waiting.get(sessionId) ?? []), done]);
      subscribe(sessionId);
    });
  };

  const call = <T = unknown>(action: string, args: Record<string, unknown>) => connection.call<T>(action, args);

  // The owner's computer reads an image only when the asking chat names it.
  // The adapter does not know which open chat shows the image, so it asks as
  // each one in turn (the main chat first, then subagent views).
  const getImageDataUrl = async (path: string): Promise<{ dataUrl: string }> => {
    let lastError: unknown = new Error("No chat on this shared lane shows that image.");
    for (const sessionId of subscriptions.keys()) {
      try {
        return await call<{ dataUrl: string }>("chat.getImageDataUrl", { path, sessionId });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  /** Without the send right, a message the owner may send becomes a draft for the owner. */
  const sentAsDraft = async (args: Record<string, unknown>): Promise<boolean> => {
    const rights = readGuestState()?.rights;
    if (!rights || rights.speak.send || !rights.speak.drafts) return false;
    await call("chat.createDraft", { originSessionId: args.sessionId, text: args.text });
    return true;
  };

  const summaryOf = (sessionId: string) => call<AgentChatSessionSummary | null>("chat.getSummary", { sessionId });

  const api = {
    ...boundChatRefusals(WHERE),
    list: async () => {
      const rows = await Promise.all(
        connection.listSessions()
          .filter((session) => session.kind === "chat" || session.kind === "subagent")
          .map((session) => summaryOf(session.sessionId).catch(() => null)),
      );
      return rows.filter((row): row is AgentChatSessionSummary => Boolean(row));
    },
    getSummary: (args: { sessionId: string }) => summaryOf(args.sessionId),
    create: async (args: Record<string, unknown>) => {
      const result = await call<AgentChatSessionSummary | (AgentChatSessionSummary & { id?: string }) | null>("chat.create", {
        ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
        ...(typeof args.model === "string" ? { model: args.model } : {}),
        ...(typeof args.modelId === "string" ? { modelId: args.modelId } : {}),
        ...(typeof args.reasoningEffort === "string" ? { reasoningEffort: args.reasoningEffort } : {}),
        ...(typeof args.permissionMode === "string" ? { permissionMode: args.permissionMode } : {}),
      });
      await connection.refreshSessions().catch(() => undefined);
      const rawId = result?.sessionId ?? (result as { id?: unknown } | null)?.id;
      const sessionId = typeof rawId === "string" && rawId ? rawId : null;
      if (!sessionId) throw new Error("The owner's computer did not start the chat.");
      const summary = await summaryOf(sessionId).catch(() => null);
      return sessionFromSummary(summary ?? ({ ...(result as object), sessionId } as AgentChatSessionSummary));
    },
    send: async (args: Record<string, unknown>) => {
      if (await sentAsDraft(args)) return;
      const sendArgs = guestSendArgs(args, readGuestState()?.rights ?? null);
      // The owner's computer drops a repeated send by this id (a retry after a lost answer).
      if (typeof sendArgs.clientSendId !== "string") sendArgs.clientSendId = `lsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      await call("chat.send", sendArgs);
    },
    // "Send now" and "interrupt" ride on the dispatch mode; the owner's gate reads it.
    // During a turn the pane steers; a draft-only guest still gets a draft.
    steer: async (args: Record<string, unknown>) => (await sentAsDraft(args))
      ? { steerId: `draft-${Date.now().toString(36)}`, queued: false }
      : call<AgentChatSteerResult>("chat.steer", {
      ...guestSendArgs(args, readGuestState()?.rights ?? null),
      ...(typeof args.dispatchMode === "string" ? { dispatchMode: args.dispatchMode } : {}),
    }),
    // Queue edits, subagent stops and turn recovery are the owner's; the pane
    // still offers some of them, so they answer with a reason, not a crash.
    moveSteer: boundChatRefusal("Reordering queued messages", WHERE),
    dispatchSteer: boundChatRefusal("Sending a queued message now", WHERE),
    cancelDispatchedSteer: boundChatRefusal("Taking back a sent message", WHERE),
    restoreCancelledQueue: boundChatRefusal("Restoring the queue", WHERE),
    resolveUnprocessedMessage: boundChatRefusal("Resending a message", WHERE),
    recoverTurn: boundChatRefusal("Turn recovery", WHERE),
    stopTask: boundChatRefusal("Stopping a subagent", WHERE),
    startSideChat: boundChatRefusal("A side chat", WHERE),
    cancelSteer: (args: Record<string, unknown>) => call<void>("chat.cancelSteer", args),
    interrupt: (args: Record<string, unknown>) => call("chat.interrupt", args),
    respondToInput: (args: Record<string, unknown>) => call<void>("chat.respondToInput", args),
    approve: (args: Record<string, unknown>) => call<void>("chat.approve", args),
    dismissPendingInput: (args: Record<string, unknown>) => call<void>("chat.dismissPendingInput", args),
    listPendingInputs: (args: Record<string, unknown>) => call("chat.listPendingInputs", args),
    getTurnFileDiff: (args: Record<string, unknown>) => call("chat.getTurnFileDiff", args),
    updateSession: async (args: Record<string, unknown>) => {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      // The pane syncs its settings before a send; an update that changes
      // nothing is not sent (it would count against the guest's rate limit).
      // A locked setting stays the chat's own; the pane's copy is not sent.
      const rights = readGuestState()?.rights ?? null;
      const lockedKeys = new Set([
        ...(rights?.run.models.length === 0 ? ["modelId", "model"] : []),
        ...(rights?.run.reasoningLevels.length === 0 ? ["reasoningEffort"] : []),
        ...(rights?.run.permissionModes.length === 0 ? ["permissionMode"] : []),
      ]);
      const changes = Object.entries(args).filter(([key, value]) => key !== "sessionId" && value !== undefined && !lockedKeys.has(key));
      if (changes.length > 0) await call("chat.updateSession", { sessionId, ...Object.fromEntries(changes) });
      const summary = await summaryOf(sessionId);
      if (!summary) throw new Error("The owner's computer did not answer.");
      return sessionFromSummary(summary);
    },
    // The guest picks only from the models the owner allows; the pane gets
    // those through its model override, not from the owner's catalog.
    models: async () => [],
    slashCommands: async () => [],
    getEventHistory,
    getAttachmentStagingMode: async () => CONSERVATIVE_ATTACHMENT_STAGING_MODE,
    saveTempAttachment: boundChatRefusal("Attachments", WHERE),
    getImageDataUrl,
    onEvent: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } satisfies PartialAgentChatApi;


  const dispose = () => {
    offSnapshot();
    offEvent();
    offState();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    waiting.clear();
    textRuns.clear();
    listeners.clear();
  };
  return Object.assign(api as PartialAgentChatApi as unknown as MachineBoundAgentChatApi, { dispose });
}

