import fs from "node:fs";
import path from "node:path";
import { readBinaryVersion } from "./binary.js";
import { isAdeClientEvent, type AdeClientEvent, type AdeClientEventMap } from "./clientEvents.js";
import { buildDoctorReport } from "./doctorReport.js";
import { AdeError, errorMessage } from "./errors.js";
import { ChatEventHub } from "./eventStream.js";
import { modelSelectionOf } from "./modelSelection.js";
import { PersonalChatsApi, summaryTurnActive } from "./personalChats.js";
import { probeRuntimeSignature, type RuntimeSignature } from "./runtimeSignature.js";
import { flattenCatalog } from "./providers.js";
import { createProviderStatusPublisher } from "./providerStatusPublisher.js";
import { readRestartPolicy, resolveRuntimeBinary, RuntimeSupervisor } from "./runtimeSupervisor.js";
import { resolveRuntimeSocketPath } from "./socketPath.js";
import type { AdeThread, Thread } from "./thread.js";
import { createThreadOpener, isAbsentSessionError } from "./threadOpener.js";
import { ThreadStore } from "./threadStore.js";
import type {
  AgentChatModelCatalog,
  AgentChatSessionSummary,
  DoctorReport,
  ModelCatalogEntry,
  ProviderStatus,
  ProviderStatusRpcResult,
  ThreadSummary,
  Unsubscribe,
} from "./types.js";
import type {
  CreateAdeChatOptions,
  InternalAdeChatOptions,
  ThreadOpenOptions,
  ThreadResumeOptions,
} from "./clientOptions.js";

// Re-exported from here because `@ade-dev/sdk` has always published them from
// this module; the split is internal and must not move a public name.
export type {
  CreateAdeChatOptions,
  InternalAdeChatOptions,
  ThreadOpenOptions,
  ThreadRefreshOptions,
  ThreadResumeOptions,
} from "./clientOptions.js";
export { ADE_CLIENT_EVENTS, type AdeClientEvent, type AdeClientEventMap } from "./clientEvents.js";

const MAX_RECENT_ERRORS = 20;

/**
 * RULE FOR ANYTHING ADDED TO THIS SURFACE — destructive while streaming.
 *
 * An SDK caller has no ambient signal that a turn is live. `send()` resolves as
 * soon as the turn is dispatched, not when it completes, so nothing in the API
 * tells a settings handler or a render effect that a reply is mid-flight. And
 * when a turn dies from a runtime teardown it emits neither `error` nor `done`
 * — subscribers just stop receiving. Silent truncation is therefore the default
 * failure mode of every destructive operation here, not an edge case.
 *
 * So any new operation that can end a running turn must pick one, explicitly:
 *   - refuse mid-turn and name the way out (`setModel`, which throws and points
 *     at `interrupt()` or `{ force: true }`); or
 *   - proceed, and say plainly in its own docs that in-flight turns end without
 *     a completion event (`dispose`, because a shutdown that can refuse is
 *     worse than a lost reply).
 *
 * What is not acceptable is the third option: destroying the turn quietly and
 * letting the consumer discover it as a response that stopped mid-sentence.
 */
export interface AdeChatClient {
  providers: {
    /**
     * Per-provider install, auth and availability.
     *
     * Served from the runtime's probe cache when the runtime supports it, and
     * derived from the model catalog when it does not. Read `source` on each
     * record before presenting any of it as a fact about the machine.
     */
    status(): Promise<Record<string, ProviderStatus>>;
    /**
     * The same map, with the runtime's probe cache bypassed.
     *
     * This is the "I just installed it" button. It spawns `--version` for every
     * provider, so it is the slow path — `status()` and the `onChange` poll
     * never bypass the cache.
     */
    refresh(): Promise<Record<string, ProviderStatus>>;
    onChange(cb: (status: Record<string, ProviderStatus>) => void): Unsubscribe;
  };
  models: { list(): Promise<ModelCatalogEntry[]> };
  threads: {
    /** Open a thread, creating it when the key is new to this home. */
    open(key: string, opts: ThreadOpenOptions): Promise<AdeThread>;
    /**
     * Reopen a key this home already stores. The provider and model come from
     * the stored record, so an app that reopens `"support"` after a restart
     * does not have to remember how it was created.
     */
    open(key: string, opts?: ThreadResumeOptions): Promise<AdeThread>;
    /**
     * Every chat in this home, archived ones included, newest activity first
     * is NOT guaranteed — sort on `updatedAt` yourself.
     */
    list(): Promise<ThreadSummary[]>;
    /**
     * Delete a thread: its runtime session, its transcript, and its key.
     *
     * A running turn is interrupted FIRST, so subscribers receive the turn's
     * `done` before the session goes away rather than a stream that simply
     * stops. Then the runtime deletes the session, the key is removed from the
     * thread store, and a live `AdeThread` for the key is released — it throws
     * `disposed`-style errors from the runtime afterwards, so drop it.
     *
     * A key whose session the runtime already lost is still removed. A key the
     * store does not know and no live thread holds throws `thread_not_found`.
     * Throws `invalid_option` on a runtime without the `delete` action.
     */
    delete(key: string): Promise<void>;
    /**
     * Archive a thread. The key and transcript are kept; `list()` reports it
     * with `archived: true`, and `unarchive` brings it back.
     *
     * Like `delete`, a running turn is interrupted first so it ends with a
     * `done` event rather than silently. Throws `thread_not_found` for a key
     * the store does not know, and `invalid_option` on a runtime without the
     * `archive` action.
     */
    archive(key: string): Promise<void>;
    /** Reverse `archive`. Same errors. */
    unarchive(key: string): Promise<void>;
  };
  doctor(): Promise<DoctorReport>;
  exportThread(key: string): Promise<string>;
  /**
   * Listen for runtime lifecycle events: `"exit"`, `"transport"`, `"restart"`.
   * See {@link AdeClientEventMap} for the payloads. Returns the unsubscribe.
   *
   * Listeners survive an `autoRestart`, because the client object does.
   */
  on<E extends AdeClientEvent>(event: E, cb: (payload: AdeClientEventMap[E]) => void): Unsubscribe;
  /**
   * Stop the runtime and release this client. Idempotent.
   *
   * Ends any turn still in flight, and — like every teardown on this surface —
   * without an `error` or `done` event first: the child process goes away, so
   * subscribers simply stop receiving. Deliberately NOT guarded the way
   * `setModel` is, because dispose is the teardown path and a shutdown that can
   * refuse is worse than a truncated reply. If a caller needs the reply, it
   * must await the turn before disposing; the transcript is durable either way
   * and `exportThread` still returns everything that was persisted.
   */
  dispose(): Promise<void>;
}

/**
 * Boots an isolated ADE runtime and returns a chat client that owns it.
 *
 * The returned client owns the child process: `dispose()` stops it, and the
 * process exit hooks stop it if the host dies first. Two clients on one `home`
 * would fight over the same socket and state root, so an app opens one per
 * isolated home.
 *
 * Before shipping, read the MCP caveat on
 * {@link ThreadOpenOptions.loadUserMcpServers}: withholding the user's own MCP
 * config is enforced only on Claude and best-effort on Codex, Cursor, Droid and
 * OpenCode. Check `thread.mcpCapability.strictRequested === true` AND
 * `.level === "enforced"` before telling your users that only their tools are
 * loaded — on a delivery-only thread the level says nothing about isolation.
 */
export async function createAdeChat(
  options: CreateAdeChatOptions | InternalAdeChatOptions,
): Promise<AdeChatClient> {
  const internal = options as InternalAdeChatOptions;
  const logger = options.logger ?? (() => {});
  const home = path.resolve(options.home);
  if (!home || home === path.parse(home).root) {
    throw new AdeError("invalid_option", "`home` must be a real directory path.");
  }
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });

  const socketPath = internal.socketPath ?? resolveRuntimeSocketPath(home);
  const binary = await resolveRuntimeBinary(options, home, logger);

  const recentErrors: DoctorReport["recentErrors"] = [];
  const recordError = (scope: string, error: unknown): void => {
    recentErrors.push({ at: new Date().toISOString(), scope, message: errorMessage(error) });
    while (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
    logger(`ade sdk: ${scope} failed: ${errorMessage(error)}`);
  };

  let disposed = false;
  const assertUsable = (): void => {
    if (disposed) throw new AdeError("disposed", "This ADE chat client was disposed.");
  };

  // ---- client events -------------------------------------------------------

  const clientListeners = new Map<AdeClientEvent, Set<(payload: never) => void>>();
  const emitClient = <E extends AdeClientEvent>(event: E, payload: AdeClientEventMap[E]): void => {
    for (const listener of [...(clientListeners.get(event) ?? [])]) {
      try {
        (listener as (value: AdeClientEventMap[E]) => void)(payload);
      } catch (error) {
        logger(`ade sdk: a "${event}" listener threw: ${errorMessage(error)}`);
      }
    }
  };
  const onClient = <E extends AdeClientEvent>(
    event: E,
    cb: (payload: AdeClientEventMap[E]) => void,
  ): Unsubscribe => {
    if (!isAdeClientEvent(event)) {
      throw new AdeError("invalid_option", `Unknown client event "${String(event)}".`);
    }
    let set = clientListeners.get(event);
    if (!set) {
      set = new Set();
      clientListeners.set(event, set);
    }
    const listener = cb as (payload: never) => void;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  // ---- runtime -------------------------------------------------------------

  /** Every thread listens here; each runtime connection's stream feeds it. */
  const hub = new ChatEventHub();
  const liveSessions = new Map<string, Thread>();
  const runtime = await RuntimeSupervisor.start({
    options,
    home,
    socketPath,
    binary,
    restartPolicy: readRestartPolicy(options.autoRestart),
    hub,
    logger,
    recordError,
    emitClient,
    isDisposed: () => disposed,
    onLost: (message) => {
      for (const thread of liveSessions.values()) thread.notifyRuntimeLost(message);
    },
    // A restart is asynchronous (it sleeps its backoff first), so `opener` is
    // always initialized by the time this runs.
    onRebound: () => opener.rebindLiveThreads(liveSessions),
  });

  /**
   * The signing state of a binary does not change while that binary is running,
   * so the probe runs at most once per client. `doctor()` is called from health
   * checks and support flows, and two `codesign` plus `spctl` spawns on every
   * one of them would be a real cost for a value that cannot have moved.
   */
  let signatureProbe: Promise<RuntimeSignature | null> | null = null;
  const readRuntimeSignature = (): Promise<RuntimeSignature | null> => {
    if (!binary.binaryPath) return Promise.resolve(null);
    signatureProbe ??= probeRuntimeSignature(binary.binaryPath);
    return signatureProbe;
  };

  const chats = new PersonalChatsApi(() => runtime.connection);
  const store = ThreadStore.forHome(home, logger);

  // ---- providers -----------------------------------------------------------

  const readCatalog = async (
    mode: "cached" | "refresh-stale" = "refresh-stale",
  ): Promise<AgentChatModelCatalog | null> => {
    try {
      return await chats.modelCatalog({ mode });
    } catch (error) {
      recordError("modelCatalog", error);
      return null;
    }
  };

  /** Catalog display names by model id, from the cached catalog. Never throws. */
  const displayNames = async (): Promise<Map<string, string>> => {
    const rows = flattenCatalog(await readCatalog("cached"));
    return new Map(rows.map((row) => [row.id, row.displayName]));
  };

  const providerStatus = createProviderStatusPublisher({
    probeSupported: () => runtime.initialize.capabilities?.providers?.status === true,
    readCatalog,
    requestProbe: (refresh) =>
      runtime.connection.request<ProviderStatusRpcResult>("providers.status", { refresh }, { timeoutMs: 30_000 }),
    recordError,
    logger,
    ...(internal.providerPollIntervalMs ? { pollIntervalMs: internal.providerPollIntervalMs } : {}),
    isDisposed: () => disposed,
  });
  const publishProviderStatus = providerStatus.publish;

  // ---- threads -------------------------------------------------------------

  const opener = createThreadOpener({
    home,
    defaultInstructions: options.instructions,
    mcpHeaders: options.mcpHeaders,
    chats,
    store,
    hub,
    logger,
    recordError,
    assertUsable,
    displayNames,
    runtime: {
      reportsCapabilities: () => runtime.capabilities() !== null,
      mcpServers: () => runtime.capabilities()?.mcpServers === true,
      updateMcpServers: () => runtime.capabilities()?.updateMcpServers === true,
      /**
       * Whether the runtime lists the read-only `pendingInputs` action.
       *
       * A runtime that does not is not broken, it is older: `pendingApprovals()`
       * then reconstructs the set from the events this client saw, which cannot
       * include anything raised before it connected. The action list is the
       * check rather than a try/catch, because a failed call would have to be
       * told apart from a real error on every invocation.
       */
      pendingInputs: () => runtime.actionListed("pendingInputs"),
      historyPage: () => runtime.actionListed("getEventHistoryPage"),
    },
  });

  /**
   * In-flight `open` calls, keyed by thread key.
   *
   * Without this, two concurrent `open("main")` calls both miss `liveSessions`,
   * both reach `chats.create`, and the app ends up with TWO runtime chats for
   * one durable key — the store keeps the last one and the first is orphaned
   * with its own provider process. A React effect that re-runs (StrictMode, a
   * changed model id) does exactly that, so it is the normal case, not a race
   * a caller can be asked to avoid.
   */
  const openInFlight = new Map<string, Promise<AdeThread>>();

  const openThread = (key: string, opts: ThreadResumeOptions = {}): Promise<AdeThread> => {
    assertUsable();
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      return Promise.reject(new AdeError("invalid_option", "A thread key must be a non-empty string."));
    }

    // A thread this client already opened is returned as-is, before any option
    // is looked at — the same rule the record-backed resume follows, and for
    // the same reason: one key is one conversation, and re-applying options to
    // a live one would move an agent that is already running. The mismatch
    // warning lives on the resume path, which is where the stored values are.
    // `refresh` is the exception and is applied through `updateMcpServers`,
    // which skips a map identical to the one it last sent.
    const existing = liveSessions.get(trimmedKey);
    if (existing) {
      const refreshServers = opts.refresh?.mcpServers;
      if (!refreshServers) return Promise.resolve(existing);
      return existing.updateMcpServers(refreshServers).then(
        () => existing,
        (error: unknown) => {
          logger(`ade sdk: thread "${trimmedKey}" could not apply refresh.mcpServers: ${errorMessage(error)}`);
          return existing;
        },
      );
    }

    const pending = openInFlight.get(trimmedKey);
    if (pending) return pending;

    const started = opener
      .open(trimmedKey, opts)
      .then((thread) => {
        liveSessions.set(trimmedKey, thread);
        return thread;
      })
      .finally(() => {
        openInFlight.delete(trimmedKey);
      });
    openInFlight.set(trimmedKey, started);
    return started;
  };

  const listThreads = async (): Promise<ThreadSummary[]> => {
    assertUsable();
    const [sessions, records, names] = await Promise.all([
      chats.list(true).catch((error) => {
        recordError("list", error);
        return [] as AgentChatSessionSummary[];
      }),
      store.all(),
      displayNames(),
    ]);
    const recordBySession = new Map(records.map((record) => [record.sessionId, record]));
    return sessions.map((session) => {
      const record = recordBySession.get(session.sessionId);
      return {
        key: record?.key ?? null,
        sessionId: session.sessionId,
        provider: session.provider,
        model: session.model,
        title: session.title ?? null,
        status: session.status,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        updatedAt: session.lastActivityAt,
        archived: Boolean(session.archivedAt),
        modelSelection: modelSelectionOf(session, names, record?.modelId ? { modelId: record.modelId } : undefined),
      };
    });
  };

  /**
   * The session a key points at, for the lifecycle actions and export: the
   * live thread's (which a recreate may have moved) over the record's.
   */
  const sessionForKey = async (
    key: string,
  ): Promise<{ trimmedKey: string; sessionId: string; live: Thread | undefined }> => {
    const trimmedKey = typeof key === "string" ? key.trim() : "";
    if (!trimmedKey) throw new AdeError("invalid_option", "A thread key must be a non-empty string.");
    const live = liveSessions.get(trimmedKey);
    const record = await store.get(trimmedKey);
    const sessionId = live?.id ?? record?.sessionId;
    if (!sessionId) {
      throw new AdeError("thread_not_found", `No thread is registered under the key "${trimmedKey}".`);
    }
    return { trimmedKey, sessionId, live };
  };

  /**
   * Interrupt a running turn before a lifecycle action ends it.
   *
   * The destructive-while-streaming rule on `AdeChatClient`: a delete or
   * archive that tore a turn down quietly would leave subscribers with a reply
   * that just stops. An interrupt ends it with `done`. A session the runtime
   * no longer has has no turn to end.
   */
  const interruptIfRunning = async (sessionId: string): Promise<void> => {
    let summary: AgentChatSessionSummary | null = null;
    try {
      summary = await chats.getSummary(sessionId);
    } catch (error) {
      if (isAbsentSessionError(error)) return;
      throw error;
    }
    if (summaryTurnActive(summary)) await chats.interrupt(sessionId);
  };

  const requireAction = (action: string, what: string): void => {
    if (!runtime.actionAvailable(action)) {
      throw new AdeError(
        "invalid_option",
        `This ADE runtime cannot ${what} a chat (no "${action}" action). Upgrade the runtime.`,
      );
    }
  };

  const deleteThread = async (key: string): Promise<void> => {
    assertUsable();
    requireAction("delete", "delete");
    const { trimmedKey, sessionId, live } = await sessionForKey(key);
    // An open that is still resolving would re-register the key after the
    // delete; wait it out so the delete is the last word.
    await openInFlight.get(trimmedKey)?.catch(() => {});
    await interruptIfRunning(sessionId);
    try {
      await chats.delete(sessionId);
    } catch (error) {
      if (!isAbsentSessionError(error)) throw error;
    }
    await store.remove(trimmedKey);
    const current = liveSessions.get(trimmedKey) ?? live;
    current?.dispose();
    liveSessions.delete(trimmedKey);
  };

  const archiveThread = async (key: string): Promise<void> => {
    assertUsable();
    requireAction("archive", "archive");
    const { sessionId } = await sessionForKey(key);
    await interruptIfRunning(sessionId);
    await chats.archive(sessionId);
  };

  const unarchiveThread = async (key: string): Promise<void> => {
    assertUsable();
    requireAction("unarchive", "unarchive");
    const { sessionId } = await sessionForKey(key);
    await chats.unarchive(sessionId);
  };

  // ---- client --------------------------------------------------------------

  const client: AdeChatClient = {
    providers: {
      status: async () => {
        assertUsable();
        return await publishProviderStatus();
      },
      refresh: async () => {
        assertUsable();
        return await publishProviderStatus(true);
      },
      onChange: providerStatus.onChange,
    },

    models: {
      list: async () => {
        assertUsable();
        return flattenCatalog(await readCatalog("refresh-stale"));
      },
    },

    threads: {
      open: openThread,
      list: listThreads,
      delete: deleteThread,
      archive: archiveThread,
      unarchive: unarchiveThread,
    },

    on: onClient,

    doctor: async () => {
      assertUsable();
      const { initialize, events } = runtime;
      const [version, statuses, records, signature] = await Promise.all([
        binary.binaryPath ? readBinaryVersion(binary) : Promise.resolve(initialize.runtimeInfo?.version ?? null),
        publishProviderStatus().catch(() => ({}) as Record<string, ProviderStatus>),
        store.all(),
        readRuntimeSignature(),
      ]);
      const socketConnected = !runtime.connection.isClosed;
      let live = 0;
      if (socketConnected) {
        const sessions = await chats.list(true).catch((error) => {
          recordError("list", error);
          return [] as AgentChatSessionSummary[];
        });
        const known = new Set(sessions.map((session) => session.sessionId));
        live = records.filter((record) => known.has(record.sessionId)).length;
      }
      return buildDoctorReport({
        binary,
        version: version ?? null,
        signature,
        providers: statuses,
        socketPath,
        socketConnected,
        runtimeVersion: initialize.runtimeInfo?.version ?? null,
        runtimePid: initialize.runtimeInfo?.pid ?? runtime.sidecar?.child.pid ?? null,
        events: {
          mode: events.transport,
          epoch: events.currentEpoch,
          gapsRecovered: events.recoveredGapCount,
        },
        threads: { tracked: records.length, live },
        recentErrors: [...recentErrors],
        compatibility: runtime.compatibility,
      });
    },

    exportThread: async (key) => {
      assertUsable();
      const { sessionId } = await sessionForKey(key);
      const snapshot = await chats.getEventHistory({ sessionId });
      // JSONL: one envelope per line, in transcript order. The same shape ADE
      // writes to its own durable transcripts, so the output drops straight
      // into any tool that already reads those.
      return (snapshot?.events ?? []).map((envelope) => JSON.stringify(envelope)).join("\n");
    },

    dispose: async () => {
      if (disposed) return;
      disposed = true;
      providerStatus.dispose();
      // Each thread holds a listener on the shared event hub from its
      // constructor. Clearing the map alone left those subscribed for the life
      // of the client, with every envelope fanned out to all of them.
      for (const thread of liveSessions.values()) thread.dispose();
      liveSessions.clear();
      openInFlight.clear();
      clientListeners.clear();
      await runtime.dispose();
      hub.clear();
      logger("ade sdk: disposed");
    },
  };

  return client;
}
