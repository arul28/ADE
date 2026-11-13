import type {
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatSessionSummary,
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

/** The fields of a send the owner's gate reads; attachments and local context stay here. */
function guestSendArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["sessionId", "text", "displayText", "clientSendId", "modelId", "reasoningEffort", "permissionMode", "interactionMode"]) {
    if (args[key] !== undefined) out[key] = args[key];
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

  const emit = (entry: AgentChatEventEnvelope) => {
    for (const listener of [...listeners]) {
      try { listener(entry); } catch { /* a listener's failure is its own */ }
    }
  };

  const offSnapshot = connection.on("chatSnapshot", (snapshot) => {
    if (!subscriptions.has(snapshot.sessionId)) return;
    const queue = waiting.get(snapshot.sessionId);
    if (queue?.length) {
      // A history read asked for this tail: it becomes the pane's history.
      waiting.delete(snapshot.sessionId);
      seen.delete(snapshot.sessionId);
      for (const entry of snapshot.events) remember(entry);
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
    for (const entry of snapshot.events) if (remember(entry)) emit(entry);
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
    // Without the send right, a message the owner may send becomes a draft.
    send: async (args: Record<string, unknown>) => {
      const rights = readGuestState()?.rights;
      if (rights && !rights.speak.send && rights.speak.drafts) {
        await call("chat.createDraft", { originSessionId: args.sessionId, text: args.text });
        return;
      }
      const sendArgs = guestSendArgs(args);
      // The owner's computer drops a repeated send by this id (a retry after a lost answer).
      if (typeof sendArgs.clientSendId !== "string") sendArgs.clientSendId = `lsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      await call("chat.send", sendArgs);
    },
    steer: (args: Record<string, unknown>) => call("chat.steer", guestSendArgs(args)),
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
      const changes = Object.entries(args).filter(([key, value]) => key !== "sessionId" && value !== undefined);
      if (changes.length > 0) await call("chat.updateSession", args);
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
    getImageDataUrl: (path: string) => call<{ dataUrl: string }>("chat.getImageDataUrl", { path, ...(firstSubscribed() ? { sessionId: firstSubscribed() } : {}) }),
    onEvent: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } satisfies PartialAgentChatApi;

  function firstSubscribed(): string | null {
    return subscriptions.keys().next().value ?? null;
  }

  const dispose = () => {
    offSnapshot();
    offEvent();
    offState();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    waiting.clear();
    listeners.clear();
  };
  return Object.assign(api as PartialAgentChatApi as unknown as MachineBoundAgentChatApi, { dispose });
}

