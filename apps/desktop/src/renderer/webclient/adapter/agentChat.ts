import type { SyncChatEventPayload } from "../../../shared/types/sync";
import { LEGACY_MAX_CHAT_ATTACHMENT_BYTES } from "../../../shared/chatAttachmentLimits";
import type {
  AgentChatCancelDispatchedSteerResult,
  AgentChatCancelScheduledWorkResult,
  AgentChatCreateScheduledWorkResult,
  AgentChatDispatchSteerResult,
  AgentChatHandoffResult,
  AgentChatInterruptResult,
  AgentChatLaunchCliResult,
  AgentChatMarkCrossMachineHandoffArgs,
  AgentChatModelCatalog,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatReloadClaudePluginsResult,
  AgentChatRegenerateSessionMetadataResult,
  AgentChatRestoreCancelledQueueResult,
  AgentChatScheduledWorkItem,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionSummary,
  AgentChatSetScheduledWorkPausedResult,
  AgentChatSteerResult,
  AutoLaneIdentitySuggestion,
  PromptStashCreateArgs,
  PromptStashDeleteArgs,
  PromptStashEntry,
} from "../../../shared/types/chat";
import { deriveSmartLinkPreview } from "../../../shared/smartLinks";
import { NO_SUBAGENT_CAPABILITY } from "../../../shared/subagentCapabilities";
import type { AdapterInfra, AdeNamespace } from "./types";
import { requestDataUrl, requestFileBlob } from "./infra/fileBlob";
import { chatEventDedupKey } from "./infra/chatEventDedup";
import { chatSessionFromRemoteSummary } from "./infra/chatSessionShape";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

// The browser gets authoritative ordered history through
// chat.getChatEventHistory. chat_subscribe snapshots still matter as bounded
// reconnect recovery when the host cannot resume from the prior sequence.
// The adapter dedupes that replay, while the renderer inserts recovered rows
// chronologically rather than appending them after the real tail. Older
// history remains available through getChatEventHistoryPage on scrollback.
const WEB_CHAT_INITIAL_SNAPSHOT_MAX_BYTES = 128 * 1024;
const WEB_CHAT_INITIAL_HISTORY_MAX_EVENTS = 512;
const WEB_CHAT_INITIAL_HISTORY_MAX_BYTES = 128 * 1024;
const WEB_CHAT_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
const WEB_CHAT_PROJECT_SUBSCRIPTION_LIMIT = 8;

export function createAgentChatNamespace(infra: AdapterInfra): AdeNamespace<"agentChat"> {
  const { client, commands, events, terminalRegistry } = infra;
  const chatSubscriptions = new Map<string, () => void>();
  const deliveredEvents: string[] = [];
  const deliveredEventSet = new Set<string>();
  let visibleSessionId: string | null = null;

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

  function ensureChatSubscription(
    sessionId: string | null | undefined,
    options: { visible?: boolean } = {},
  ): void {
    if (!sessionId) return;
    if (options.visible) visibleSessionId = sessionId;
    const existingUnsubscribe = chatSubscriptions.get(sessionId);
    if (existingUnsubscribe) {
      // Map insertion order is the LRU order. A selected/reused chat should
      // survive ahead of background chats visited earlier in this tab.
      chatSubscriptions.delete(sessionId);
      chatSubscriptions.set(sessionId, existingUnsubscribe);
      return;
    }
    while (chatSubscriptions.size >= WEB_CHAT_PROJECT_SUBSCRIPTION_LIMIT) {
      const oldest = [...chatSubscriptions.entries()].find(([candidateId]) => (
        candidateId !== visibleSessionId
      ));
      // Preserve the hard bound even if future pinning rules ever make every
      // resident stream ineligible for eviction.
      if (!oldest) return;
      chatSubscriptions.delete(oldest[0]);
      oldest[1]();
    }
    const unsubscribe = client.subscribeChat(
      sessionId,
      { maxBytes: WEB_CHAT_INITIAL_SNAPSHOT_MAX_BYTES },
      {
        // A non-resumed reconnect snapshot is the only payload carrying events
        // missed while the host was unavailable or its replay ring overflowed.
        // emitChatEvent removes overlap with already-delivered live rows; the
        // renderer's history merge preserves chronological transcript order.
        snapshot: (snapshot) => {
          snapshot.events.forEach((payload) => emitChatEvent(payload));
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
    visibleSessionId = null;
    deliveredEvents.length = 0;
    deliveredEventSet.clear();
  }));

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function callRequired<T>(
    action: string,
    args: unknown,
    capability: "Scheduled work" | "Chat history" | "Chat",
    idempotent: boolean,
  ): Promise<T> {
    return commands.call<T>(action, asRecord(args), {
      fallback: () => {
        throw new Error(`${capability} action '${action}' is unavailable on the connected ADE host.`);
      },
      idempotent,
    });
  }

  function callRequiredRead<T>(action: string, args: unknown): Promise<T> {
    return callRequired<T>(action, args, "Chat history", true);
  }

  function callRequiredMutation<T>(action: string, args: unknown): Promise<T> {
    return callRequired<T>(action, args, "Chat", false);
  }

  /**
   * A chat's runtime pin names the machine the chat actually lives on. This
   * adapter speaks to exactly one machine, so every member the Electron
   * contract declares with a trailing pin must declare it here too — omitting
   * the parameter does not make the pin harmless, it makes JS discard it and
   * run the read or write against whichever host this adapter holds.
   *
   * The members below stay `async` so an unroutable pin rejects rather than
   * throwing synchronously out of the caller's expression; `onEvent` is the
   * exception, since a subscription has no promise to reject.
   */
  function guardPin(operation: string, pin: RuntimePinArg): void {
    assertWebRuntimePinRoutable(`agentChat.${operation}`, pin, infra);
  }

  // Typed, not cast: `AdeNamespace` compares every method implemented here
  // against the real `window.ade.agentChat` contract. The previous
  // `Record<string, unknown>` + `as` cast is what let `create`/`launch`
  // return the host's session SUMMARY (`sessionId`) where callers read an
  // `AgentChatSession` (`id`) — a mismatch TypeScript would have caught.
  const agentChat: AdeNamespace<"agentChat"> = {
    list: async (args?) => {
      // Session lists drive UI metadata only. Subscribing every result eagerly
      // replays each transcript tail and can block the selected chat's
      // hydration behind background sessions.
      return await call<AgentChatSessionSummary[]>("chat.listSessions", args, []);
    },
    getSummary: async (args, pin) => {
      guardPin("getSummary", pin);
      const result = await call<AgentChatSessionSummary | null>("chat.getSummary", args, null);
      ensureFromResult(result);
      return result;
    },
    // Both answer with an AgentChatSessionSummary; every caller consumes an
    // AgentChatSession. Translate rather than pass through — see
    // `chatSessionFromRemoteSummary`.
    create: async (args, pin) => {
      guardPin("create", pin);
      const result = await callRequiredMutation<unknown>("chat.create", args);
      ensureFromResult(result);
      return chatSessionFromRemoteSummary(result);
    },
    launch: async (args) => {
      const result = await callRequiredMutation<unknown>("chat.launch", args);
      ensureFromResult(result);
      return chatSessionFromRemoteSummary(result);
    },
    launchCli: async (args) => {
      const result = await callRequiredMutation<AgentChatLaunchCliResult>("chat.launchCli", args);
      ensureFromResult(result);
      // The launch answers with ids, not a session summary; bind the pty so
      // terminal writes for this session resolve without waiting for a roster
      // read. (The previous `result.terminalSession` field never existed on
      // this type and registered `undefined` on every launch.)
      if (result?.sessionId && result?.ptyId) terminalRegistry.register(result.sessionId, result.ptyId);
      return result;
    },
    generateAutoLaneIdentity: async (args, pin) => {
      guardPin("generateAutoLaneIdentity", pin);
      return await callRequiredMutation<AutoLaneIdentitySuggestion>("chat.generateAutoLaneIdentity", args);
    },
    parallelLaunchState: {
      get: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("parallelLaunchState.get", pin);
        return await call("chat.getParallelLaunchState", args, null);
      },
      set: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("parallelLaunchState.set", pin);
        await call("chat.setParallelLaunchState", args, undefined, false);
      },
    },
    promptStashes: {
      list: async (pin?: RuntimePinArg) => {
        guardPin("promptStashes.list", pin);
        const result = await call<unknown>("chat.listPromptStashes", {}, []);
        return Array.isArray(result) ? result as PromptStashEntry[] : [];
      },
      create: async (args: PromptStashCreateArgs, pin?: RuntimePinArg) => {
        guardPin("promptStashes.create", pin);
        return await callRequiredMutation<PromptStashEntry>("chat.createPromptStash", args);
      },
      delete: async (args: PromptStashDeleteArgs, pin?: RuntimePinArg) => {
        guardPin("promptStashes.delete", pin);
        return await callRequiredMutation<boolean>("chat.deletePromptStash", args);
      },
    },
    handoff: async (args, pin) => {
      guardPin("handoff", pin);
      return await callRequiredMutation<AgentChatHandoffResult>("chat.handoff", args);
    },
    // The cross-machine handoff trio is a real sync command surface
    // (`chat.prepareCrossMachineHandoff` / `validateCrossMachineSource` /
    // `markCrossMachineHandoff` are all registered remote commands), so the web
    // client implements them rather than letting the fallback proxy answer
    // `undefined` — which made the handoff modal look like it had succeeded.
    // A host without them still fails loudly through `callRequired`.
    prepareCrossMachineHandoff: async (args, pin) => {
      guardPin("prepareCrossMachineHandoff", pin);
      return await callRequiredMutation<AgentChatPrepareCrossMachineHandoffResult>(
        "chat.prepareCrossMachineHandoff",
        args,
      );
    },
    validateCrossMachineSource: async (args, pin) => {
      guardPin("validateCrossMachineSource", pin);
      await callRequiredMutation<void>("chat.validateCrossMachineSource", args);
    },
    markCrossMachineHandoff: async (args: AgentChatMarkCrossMachineHandoffArgs, pin) => {
      guardPin("markCrossMachineHandoff", pin);
      await callRequiredMutation<void>("chat.markCrossMachineHandoff", args);
    },
    send: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("send", pin);
      await call("chat.send", args, undefined, false);
      ensureChatSubscription(stringField(asRecord(args), "sessionId"));
    },
    steer: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("steer", pin);
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
    cancelSteer: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("cancelSteer", pin);
      // An unreachable host must not resolve: the message stays queued and the
      // agent still sends it, so a silent `undefined` reads as a cancellation
      // that never happened. Every other mutation here already throws.
      await callRequiredMutation("chat.cancelSteer", args);
    },
    editSteer: async (args: unknown) => {
      await callRequiredMutation("chat.editSteer", args);
    },
    dispatchSteer: async (args, pin) => {
      guardPin("dispatchSteer", pin);
      return await callRequiredMutation<AgentChatDispatchSteerResult>("chat.dispatchSteer", args);
    },
    cancelDispatchedSteer: async (args, pin) => {
      guardPin("cancelDispatchedSteer", pin);
      return await callRequiredMutation<AgentChatCancelDispatchedSteerResult>(
        "chat.cancelDispatchedSteer",
        args,
      );
    },
    interrupt: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("interrupt", pin);
      return await call<AgentChatInterruptResult>(
        "chat.interrupt",
        args,
        { mode: "stop_and_clear", cancelledQueuedCount: 0 },
        false,
      );
    },
    stopTask: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("stopTask", pin);
      return await call(
        "chat.stopTask",
        args,
        { sessionId: "", taskId: "", stopped: false },
        false,
      );
    },
    restoreCancelledQueue: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("restoreCancelledQueue", pin);
      return await call<AgentChatRestoreCancelledQueueResult>(
        "chat.restoreCancelledQueue",
        args,
        { restored: false, restoredCount: 0 },
        false,
      );
    },
    approve: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("approve", pin);
      await call("chat.approve", args, undefined, false);
    },
    respondToInput: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("respondToInput", pin);
      await call("chat.respondToInput", args, undefined, false);
    },
    models: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("models", pin);
      return await call("chat.models", args, []);
    },
    modelCatalog: async (args?, pin?) => {
      // A catalog describes the machine that served it, so a foreign pin cannot
      // be answered from this adapter's single connection. The picker treats a
      // rejection as "no catalog" and falls back to the pin-scoped model list.
      guardPin("modelCatalog", pin);
      return await call<AgentChatModelCatalog>("chat.modelCatalog", args, {
        groups: [],
        fetchedAt: new Date(0).toISOString(),
        stale: true,
      });
    },
    archive: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("archive", pin);
      await call("chat.archive", args, undefined, false);
    },
    unarchive: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("unarchive", pin);
      await call("chat.unarchive", args, undefined, false);
    },
    delete: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("delete", pin);
      await call("chat.delete", args, undefined, false);
    },
    updateSession: async (args, pin) => {
      guardPin("updateSession", pin);
      return await callRequiredMutation<AgentChatSession>("chat.updateSession", args);
    },
    regenerateSessionMetadata: async (args, pin) => {
      guardPin("regenerateSessionMetadata", pin);
      return await callRequiredMutation<AgentChatRegenerateSessionMetadataResult>(
        "chat.regenerateSessionMetadata",
        args,
      );
    },
    createScheduledWork: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("createScheduledWork", pin);
      return await callRequired<AgentChatCreateScheduledWorkResult>(
        "chat.createScheduledWork", args, "Scheduled work", false,
      );
    },
    listScheduledWork: async (args?: unknown, pin?: RuntimePinArg) => {
      guardPin("listScheduledWork", pin);
      return await call<AgentChatScheduledWorkItem[]>("chat.listScheduledWork", args, []);
    },
    cancelScheduledWork: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("cancelScheduledWork", pin);
      return await callRequired<AgentChatCancelScheduledWorkResult>(
        "chat.cancelScheduledWork", args, "Scheduled work", false,
      );
    },
    setScheduledWorkPaused: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("setScheduledWorkPaused", pin);
      return await callRequired<AgentChatSetScheduledWorkPausedResult>(
        "chat.setScheduledWorkPaused", args, "Scheduled work", false,
      );
    },
    warmupModel: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("warmupModel", pin);
      await call("chat.warmupModel", args, undefined, false);
    },
    // No promise to reject: a subscription taking a foreign pin is asking for
    // another machine's event stream, and handing back this machine's stream
    // would be a silent mis-route, so the refusal is synchronous.
    onEvent: (listener, pin) => {
      guardPin("onEvent", pin);
      return events.on("agentChatEvent", listener as never);
    },
    slashCommands: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("slashCommands", pin);
      return await call("chat.getSlashCommands", args, []);
    },
    reloadClaudePlugins: (args) =>
      callRequiredMutation<AgentChatReloadClaudePluginsResult>("chat.reloadClaudePlugins", args),
    setClaudeOutputStyle: (args) => callRequiredMutation<AgentChatSession>("chat.setClaudeOutputStyle", args),
    getSubagentTranscript: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getSubagentTranscript", pin);
      return await call("chat.getSubagentTranscript", args, null);
    },
    getMainTranscript: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getMainTranscript", pin);
      return await call("chat.getMainTranscript", args, null);
    },
    getContextUsage: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getContextUsage", pin);
      return await call("chat.getContextUsage", args, null);
    },
    rewindFiles: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("rewindFiles", pin);
      return await call(
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
      );
    },
    fileSearch: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("fileSearch", pin);
      try {
        const blob = await requestFileBlob(client, infra.state, "quickOpen", asRecord(args));
        return JSON.parse(blob.content);
      } catch {
        return [];
      }
    },
    getTurnFileDiff: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getTurnFileDiff", pin);
      return await call("chat.getTurnFileDiff", args, null);
    },
    listSubagents: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("listSubagents", pin);
      return await call("chat.listSubagents", args, []);
    },
    getSessionCapabilities: async (args, pin) => {
      guardPin("getSessionCapabilities", pin);
      return await call<AgentChatSessionCapabilities>("chat.getSessionCapabilities", args, {
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
        subagent: NO_SUBAGENT_CAPABILITY,
      });
    },
    saveTempAttachment: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("saveTempAttachment", pin);
      return await call("chat.saveTempAttachment", args, { path: "" }, false);
    },
    // The hosted web client has no `webUtils`, so a dropped or picked file
    // never carries a real disk path — there is nothing to copy or stream and
    // the browser only ever holds bytes. It stays on the base64 command with
    // the legacy ceiling, and `stageFileAttachment` is unreachable by
    // construction rather than by a runtime check that could drift.
    getAttachmentStagingMode: async () => ({
      mode: "base64" as const,
      maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
    }),
    stageFileAttachment: async () => {
      throw new Error("Attachment upload is not available in the web client.");
    },
    getImageDataUrl: async (path: string, pin?: RuntimePinArg) => {
      guardPin("getImageDataUrl", pin);
      return { dataUrl: (await requestDataUrl(client, infra.state, "readArtifact", { path })) ?? "" };
    },
    resolveSmartLinkPreview: (args: unknown) => {
      const record = asRecord(args);
      const url = stringField(record, "url");
      return call("chat.resolveSmartLinkPreview", record, deriveSmartLinkPreview(url));
    },
    getEventHistory: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getEventHistory", pin);
      const record = asRecord(args);
      // AgentChatPane requests history when a session becomes visible. Metadata
      // reads such as list/getSummary are also used for background rows, so this
      // is the adapter's authoritative selected-session signal.
      ensureChatSubscription(stringField(record, "sessionId"), { visible: true });
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
          // This fallback is only used when the host command could not be
          // reached or dispatched — i.e. the runtime is unreachable, NOT an
          // authoritative "no such session". Without `unavailable` the renderer
          // treats the bare `sessionFound: false` as authoritative and either
          // tombstones the chat or wipes the rendered transcript.
          sessionId: stringField(record, "sessionId"),
          events: [],
          truncated: false,
          sessionFound: false,
          unavailable: true,
        }
      );
    },
    getEventHistoryPage: async (args: unknown, pin?: RuntimePinArg) => {
      guardPin("getEventHistoryPage", pin);
      const record = asRecord(args);
      ensureChatSubscription(stringField(record, "sessionId"), { visible: true });
      const historyPageAction = commands.hasAction("chat.getChatEventHistoryPage")
        ? "chat.getChatEventHistoryPage"
        : commands.hasAction("agentChat.getEventHistoryPage")
          ? "agentChat.getEventHistoryPage"
          : "chat.getChatEventHistoryPage";
      return await callRequiredRead(
        historyPageAction,
        {
          ...record,
          maxBytes: boundedPositiveInteger(
            record.maxBytes,
            WEB_CHAT_HISTORY_PAGE_MAX_BYTES,
          ),
        }
      );
    },
    codex: {
      getGoal: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.getGoal", pin);
        return await call("chat.codex.getGoal", args, null);
      },
      setGoal: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.setGoal", pin);
        return await call("chat.codex.setGoal", args, null, false);
      },
      setGoalStatus: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.setGoalStatus", pin);
        return await call("chat.codex.setGoalStatus", args, null, false);
      },
      clearGoal: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.clearGoal", pin);
        return await call("chat.codex.clearGoal", args, null, false);
      },
      resetMemory: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.resetMemory", pin);
        await call("chat.codex.resetMemory", args, undefined, false);
      },
      terminateBackgroundTerminal: async (args: unknown, pin?: RuntimePinArg) => {
        guardPin("codex.terminateBackgroundTerminal", pin);
        await call("chat.codex.terminateBackgroundTerminal", args, undefined, false);
      },
    },
  };

  return agentChat;
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
