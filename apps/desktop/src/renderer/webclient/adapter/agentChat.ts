import type { SyncChatEventPayload } from "../../../shared/types/sync";
import type {
  AgentChatCancelScheduledWorkResult,
  AgentChatCreateScheduledWorkResult,
  AgentChatScheduledWorkItem,
  AgentChatSetScheduledWorkPausedResult,
  AgentChatSteerResult,
} from "../../../shared/types/chat";
import { deriveSmartLinkPreview } from "../../../shared/smartLinks";
import type { AdapterInfra, AdeNamespace } from "./types";
import { requestDataUrl, requestFileBlob } from "./infra/fileBlob";
import { chatEventDedupKey } from "./infra/chatEventDedup";

// The browser gets the current chat tail through both chat_subscribe and
// chat.getChatEventHistory. Keep each initial payload small: remote hosts
// serialize those responses ahead of later summary/model commands. Older
// history remains available through getChatEventHistoryPage when the user
// scrolls back.
const WEB_CHAT_INITIAL_SNAPSHOT_MAX_BYTES = 128 * 1024;
const WEB_CHAT_INITIAL_HISTORY_MAX_EVENTS = 512;
const WEB_CHAT_INITIAL_HISTORY_MAX_BYTES = 128 * 1024;
const WEB_CHAT_PROJECT_SUBSCRIPTION_LIMIT = 8;

export function createAgentChatNamespace(infra: AdapterInfra): AdeNamespace<"agentChat"> {
  const { client, commands, events, terminalRegistry } = infra;
  const chatSubscriptions = new Map<string, () => void>();
  const deliveredEvents: string[] = [];
  const deliveredEventSet = new Set<string>();

  function emitChatEvent(payload: SyncChatEventPayload): void {
    const key = chatEventDedupKey(payload);
    if (deliveredEventSet.has(key)) return;
    deliveredEventSet.add(key);
    deliveredEvents.push(key);
    while (deliveredEvents.length > 500) {
      const oldest = deliveredEvents.shift();
      if (oldest) deliveredEventSet.delete(oldest);
    }
    events.emit("agentChatEvent", payload);
  }

  function resetDeliveredSyncEpoch(sessionId: string): void {
    const prefix = `${sessionId}:sync-seq:`;
    let writeIndex = 0;
    for (const key of deliveredEvents) {
      if (key.startsWith(prefix)) {
        deliveredEventSet.delete(key);
        continue;
      }
      deliveredEvents[writeIndex] = key;
      writeIndex += 1;
    }
    deliveredEvents.length = writeIndex;
  }

  function ensureChatSubscription(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const existingUnsubscribe = chatSubscriptions.get(sessionId);
    if (existingUnsubscribe) {
      // Map insertion order is the LRU order. A selected/reused chat should
      // survive ahead of background chats visited earlier in this tab.
      chatSubscriptions.delete(sessionId);
      chatSubscriptions.set(sessionId, existingUnsubscribe);
      return;
    }
    while (chatSubscriptions.size >= WEB_CHAT_PROJECT_SUBSCRIPTION_LIMIT) {
      const oldest = chatSubscriptions.entries().next().value as [string, () => void] | undefined;
      if (!oldest) break;
      chatSubscriptions.delete(oldest[0]);
      oldest[1]();
    }
    const unsubscribe = client.subscribeChat(
      sessionId,
      { maxBytes: WEB_CHAT_INITIAL_SNAPSHOT_MAX_BYTES },
      {
        snapshot: (payload) => {
          if (payload.resumed !== true) resetDeliveredSyncEpoch(payload.sessionId);
          for (const event of payload.events) emitChatEvent(event as SyncChatEventPayload);
        },
        event: (payload) => {
          emitChatEvent(payload);
        },
      }
    );
    chatSubscriptions.set(sessionId, unsubscribe);
  }

  function ensureFromResult(result: unknown): void {
    if (!result || typeof result !== "object") return;
    if (Array.isArray(result)) {
      for (const item of result) ensureFromResult(item);
      return;
    }
    const record = result as Record<string, unknown>;
    ensureChatSubscription(stringField(record, "sessionId") || stringField(record, "id"));
  }

  infra.addDispose(client.onChatEvent((payload) => {
    // Incoming events already belong to an explicit client subscription.
    // Re-subscribing here can replace a machine-scoped personal-chat
    // subscription for the same session id with a project-scoped one.
    emitChatEvent(payload);
  }));

  infra.addDispose(() => {
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
  });

  infra.addDispose(events.on("projectBoundary", () => {
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
    deliveredEvents.length = 0;
    deliveredEventSet.clear();
  }));

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function callRequired<T>(action: string, args: unknown): Promise<T> {
    return commands.call<T>(action, asRecord(args), {
      fallback: () => {
        throw new Error(`Scheduled work action '${action}' is unavailable on the connected ADE host.`);
      },
      idempotent: false,
    });
  }

  const agentChat: Record<string, unknown> = {
    list: async (args?: unknown) => {
      // Session lists drive UI metadata only. Subscribing every result eagerly
      // replays each transcript tail and can block the selected chat's
      // hydration behind background sessions.
      return await call<unknown[]>("chat.listSessions", args, []);
    },
    getSummary: async (args: unknown) => {
      const result = await call("chat.getSummary", args, null);
      ensureFromResult(result);
      return result;
    },
    create: async (args: unknown) => {
      const result = await call("chat.create", args, null, false);
      ensureFromResult(result);
      return result;
    },
    launch: async (args: unknown) => {
      const result = await call("chat.launch", args, null, false);
      ensureFromResult(result);
      return result;
    },
    launchCli: async (args: unknown) => {
      const result = await call("chat.launchCli", args, null, false);
      ensureFromResult(result);
      terminalRegistry.registerSummary((result as { terminalSession?: unknown } | null)?.terminalSession as never);
      return result;
    },
    suggestLaneName: (args: unknown) => call("chat.suggestLaneName", args, ""),
    parallelLaunchState: {
      get: (args: unknown) => call("chat.getParallelLaunchState", args, null),
      set: async (args: unknown) => {
        await call("chat.setParallelLaunchState", args, undefined, false);
      },
    },
    handoff: (args: unknown) => call("chat.handoff", args, null, false),
    send: async (args: unknown) => {
      await call("chat.send", args, undefined, false);
      ensureChatSubscription(stringField(asRecord(args), "sessionId"));
    },
    steer: async (args: unknown) => {
      // Do NOT fabricate a queued success when chat.steer can't execute
      // (missing descriptor, disconnected/host_unavailable). A fake
      // `queued: true` would clear the draft and, for Send now, try to dispatch
      // a steer id that never existed — silently losing the message. Use an
      // unreachable-sentinel fallback and throw so the composer restores the
      // draft and surfaces the connection error instead.
      const UNSENT_SENTINEL = "__ade_steer_unsent__";
      const result = await call<AgentChatSteerResult>("chat.steer", args, {
        steerId: UNSENT_SENTINEL,
        queued: false,
      }, false);
      if (result.steerId === UNSENT_SENTINEL) {
        throw new Error("Couldn't reach the ADE host to send this message. Check the connection and resend.");
      }
      return result;
    },
    cancelSteer: async (args: unknown) => {
      await call("chat.cancelSteer", args, undefined, false);
    },
    editSteer: async (args: unknown) => {
      await call("chat.editSteer", args, undefined, false);
    },
    dispatchSteer: (args: unknown) => call("chat.dispatchSteer", args, { ok: false, error: "unsupported" }, false),
    cancelDispatchedSteer: (args: unknown) => call("chat.cancelDispatchedSteer", args, { ok: false, error: "unsupported" }, false),
    interrupt: async (args: unknown) => {
      await call("chat.interrupt", args, undefined, false);
    },
    approve: async (args: unknown) => {
      await call("chat.approve", args, undefined, false);
    },
    respondToInput: async (args: unknown) => {
      await call("chat.respondToInput", args, undefined, false);
    },
    models: (args: unknown) => call("chat.models", args, []),
    modelCatalog: (args?: unknown) => call("chat.modelCatalog", args, { providers: [], models: [] }),
    archive: async (args: unknown) => {
      await call("chat.archive", args, undefined, false);
    },
    unarchive: async (args: unknown) => {
      await call("chat.unarchive", args, undefined, false);
    },
    delete: async (args: unknown) => {
      await call("chat.delete", args, undefined, false);
    },
    updateSession: (args: unknown) => call("chat.updateSession", args, null, false),
    createScheduledWork: (args: unknown) =>
      callRequired<AgentChatCreateScheduledWorkResult>("chat.createScheduledWork", args),
    listScheduledWork: (args?: unknown) =>
      call<AgentChatScheduledWorkItem[]>("chat.listScheduledWork", args, []),
    cancelScheduledWork: (args: unknown) =>
      callRequired<AgentChatCancelScheduledWorkResult>("chat.cancelScheduledWork", args),
    setScheduledWorkPaused: (args: unknown) =>
      callRequired<AgentChatSetScheduledWorkPausedResult>("chat.setScheduledWorkPaused", args),
    warmupModel: async (args: unknown) => {
      await call("chat.warmupModel", args, undefined, false);
    },
    onEvent: (listener: (event: unknown) => void) => events.on("agentChatEvent", listener as never),
    slashCommands: (args: unknown) => call("chat.getSlashCommands", args, []),
    listClaudePlugins: (args?: unknown) => call("chat.listClaudePlugins", args, []),
    reloadClaudePlugins: (args: unknown) => call("chat.reloadClaudePlugins", args, { plugins: [] }, false),
    listClaudeOutputStyles: (args?: unknown) => call("chat.listClaudeOutputStyles", args, []),
    setClaudeOutputStyle: (args: unknown) => call("chat.setClaudeOutputStyle", args, null, false),
    listClaudeSessions: (args?: unknown) => call("chat.listClaudeSessions", args, []),
    getClaudeSessionInfo: (args: unknown) => call("chat.getClaudeSessionInfo", args, null),
    getClaudeSessionMessages: (args: unknown) => call("chat.getClaudeSessionMessages", args, []),
    getSubagentTranscript: (args: unknown) => call("chat.getSubagentTranscript", args, null),
    getMainTranscript: (args: unknown) => call("chat.getMainTranscript", args, null),
    getContextUsage: (args: unknown) => call("chat.getContextUsage", args, null),
    rewindFiles: (args: unknown) =>
      call(
        "chat.rewindFiles",
        args,
        {
          canRewind: false,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          dryRun: true,
        },
        false
      ),
    fileSearch: async (args: unknown) => {
      try {
        const blob = await requestFileBlob(client, infra.state, "quickOpen", asRecord(args));
        return JSON.parse(blob.content);
      } catch {
        return [];
      }
    },
    getTurnFileDiff: (args: unknown) => call("chat.getTurnFileDiff", args, null),
    listSubagents: (args: unknown) => call("chat.listSubagents", args, []),
    killDroidWorker: async (args: unknown) => {
      await call("chat.killDroidWorker", args, undefined, false);
    },
    getSessionCapabilities: (args: unknown) => call("chat.getSessionCapabilities", args, { capabilities: [] }),
    saveTempAttachment: (args: unknown) => call("chat.saveTempAttachment", args, { path: "" }, false),
    getImageDataUrl: async (path: string) => ({ dataUrl: (await requestDataUrl(client, infra.state, "readArtifact", { path })) ?? "" }),
    resolveSmartLinkPreview: (args: unknown) => {
      const record = asRecord(args);
      const url = stringField(record, "url");
      return call("chat.resolveSmartLinkPreview", record, deriveSmartLinkPreview(url));
    },
    getEventHistory: async (args: unknown) => {
      const record = asRecord(args);
      ensureChatSubscription(stringField(record, "sessionId"));
      return await call(
        "chat.getChatEventHistory",
        {
          ...record,
          maxEvents: boundedPositiveInteger(
            record.maxEvents,
            WEB_CHAT_INITIAL_HISTORY_MAX_EVENTS,
          ),
          maxBytes: boundedPositiveInteger(
            record.maxBytes,
            WEB_CHAT_INITIAL_HISTORY_MAX_BYTES,
          ),
        },
        {
          sessionId: stringField(record, "sessionId"),
          events: [],
          truncated: false,
          sessionFound: false,
        }
      );
    },
    getEventHistoryPage: async (args: unknown) => {
      const record = asRecord(args);
      ensureChatSubscription(stringField(record, "sessionId"));
      return await call(
        "chat.getChatEventHistoryPage",
        args,
        {
          sessionId: stringField(record, "sessionId"),
          events: [],
          nextBeforeOffset: null,
          hasMore: false,
        }
      );
    },
    codex: {
      getGoal: (args: unknown) => call("chat.codex.getGoal", args, null),
      setGoal: (args: unknown) => call("chat.codex.setGoal", args, null, false),
      setGoalStatus: (args: unknown) => call("chat.codex.setGoalStatus", args, null, false),
      clearGoal: (args: unknown) => call("chat.codex.clearGoal", args, null, false),
    },
  };

  return agentChat as AdeNamespace<"agentChat">;
}

function boundedPositiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
