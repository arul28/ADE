import type { SyncChatEventPayload } from "../../../shared/types/sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { requestDataUrl, requestFileBlob } from "./infra/fileBlob";

export function createAgentChatNamespace(infra: AdapterInfra): AdeNamespace<"agentChat"> {
  const { client, commands, events, terminalRegistry } = infra;
  const chatSubscriptions = new Map<string, () => void>();
  const deliveredEvents: string[] = [];
  const deliveredEventSet = new Set<string>();

  function emitChatEvent(payload: SyncChatEventPayload): void {
    const key = chatEventKey(payload);
    if (key) {
      if (deliveredEventSet.has(key)) return;
      deliveredEventSet.add(key);
      deliveredEvents.push(key);
      while (deliveredEvents.length > 500) {
        const oldest = deliveredEvents.shift();
        if (oldest) deliveredEventSet.delete(oldest);
      }
    }
    events.emit("agentChatEvent", payload);
  }

  function ensureChatSubscription(sessionId: string | null | undefined): void {
    if (!sessionId || chatSubscriptions.has(sessionId)) return;
    const unsubscribe = client.subscribeChat(
      sessionId,
      { maxBytes: 1024 * 1024 },
      {
        snapshot: (payload) => {
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

  infra.addDispose(
    events.on("chatsInvalidated", async () => {
      const sessions = await commands.call<unknown[]>("chat.listSessions", {}, {
        fallback: [],
        idempotent: true,
      });
      ensureFromResult(sessions);
    })
  );

  infra.addDispose(() => {
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
  });

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  const agentChat: Record<string, unknown> = {
    list: async (args?: unknown) => {
      const result = await call<unknown[]>("chat.listSessions", args, []);
      ensureFromResult(result);
      return result;
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
      await call("chat.steer", args, undefined, false);
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
    getEventHistory: async (args: unknown) => {
      const record = asRecord(args);
      ensureChatSubscription(stringField(record, "sessionId"));
      return await call(
        "chat.getChatEventHistory",
        args,
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

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function chatEventKey(payload: SyncChatEventPayload): string | null {
  const seq = typeof payload.seq === "number" ? payload.seq : typeof payload.sequence === "number" ? payload.sequence : null;
  if (seq !== null) return `${payload.sessionId}:seq:${seq}`;
  const eventType = payload.event && typeof payload.event === "object" && "type" in payload.event ? String(payload.event.type) : "";
  return `${payload.sessionId}:ts:${payload.timestamp}:${eventType}`;
}
