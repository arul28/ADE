import fs from "node:fs";
import path from "node:path";
import { readBinaryVersion, resolveBinary } from "./binary.js";
import { checkRuntimeCompatibility, SUPPORTED_RUNTIME_RANGE } from "./compatibility.js";
import { buildDoctorReport } from "./doctorReport.js";
import { resolveBundledRuntime } from "./bundledRuntime.js";
import { DEFAULT_RELEASE_REPO } from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { ChatEventHub, ChatEventStream } from "./eventStream.js";
import { JsonRpcConnection } from "./jsonRpc.js";
import {
  canonicalThreadCwd,
  normalizeInstructions,
  normalizeInstructionsCapability,
  normalizePermissionCapability,
  normalizeSettingSources,
  normalizeSettingSourcesCapability,
  validateThreadCwd,
} from "./hostConfig.js";
import { normalizeMcpCapability } from "./mcpCapability.js";
import {
  missingHeadersWarning,
  toStoredMcpServers,
  withResolvedHeaders,
  type StoredMcpServerConfig,
} from "./mcpHeaders.js";
import {
  isPermissionPolicy,
  isSupportedProvider,
  readApprovalTimeoutMs,
  resolvePermissionArgs,
  type PermissionPreset,
  type ThreadPermissionPolicy,
} from "./permissions.js";
import { PersonalChatsApi } from "./personalChats.js";
import { probeRuntimeSignature, type RuntimeSignature } from "./runtimeSignature.js";
import { flattenCatalog } from "./providers.js";
import { createProviderStatusPublisher } from "./providerStatusPublisher.js";
import { threadOpenWarnings, threadResumeMismatchWarnings } from "./threadWarnings.js";
import { reclaimStaleRuntime, runtimePidfilePath } from "./runtimePidfile.js";
import { DEFAULT_ADE_ROLE, startSidecar, type Sidecar } from "./sidecar.js";
import { resolveRuntimeSocketPath } from "./socketPath.js";
import { Thread, type AdeThread } from "./thread.js";
import { ThreadStore, type ThreadRecord } from "./threadStore.js";
import { SDK_VERSION } from "./version.js";
import type {
  AdeInitializeResult,
  AdeProvider,
  AgentChatEventEnvelope,
  AgentChatModelCatalog,
  AgentChatSessionSummary,
  DoctorReport,
  McpServerConfig,
  ModelCatalogEntry,
  ProviderStatus,
  ProviderStatusRpcResult,
  RuntimeCompatibility,
  ThreadModelSelection,
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

/**
 * Payloads of the client-level events, by name.
 *
 * These are about the RUNTIME, not about any one thread. A thread learns that
 * its runtime died from the synthetic `status` envelope on its own `status`
 * channel; a host learns it here, once.
 */
export type AdeClientEventMap = {
  /**
   * The runtime process this client spawned exited without `dispose()`.
   * `error` is the tail of its stderr, when it wrote any. Not emitted in attach
   * mode, where the client owns no process — watch `transport` there.
   */
  exit: { code: number | null; signal: string | null; error: string | null };
  /**
   * The socket to the runtime closed unexpectedly (`"closed"`), or an
   * `autoRestart` brought it back (`"reconnected"`).
   */
  transport: { state: "closed" | "reconnected"; error: string | null };
  /** One `autoRestart` attempt finished. `attempt` counts from 1 per outage. */
  restart: { attempt: number; ok: boolean; error: string | null };
};

/** The client-level event names. See {@link AdeClientEventMap}. */
export type AdeClientEvent = keyof AdeClientEventMap;

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

function isAbsentSessionError(error: unknown): boolean {
  if (!(error instanceof AdeError)) return false;
  if (error.code === "thread_not_found") return true;
  // Timeouts and a closed socket are not "the session is gone": recreating
  // would drop injected MCP under the same key. Only a not-found RPC is a
  // genuine wipe.
  if (error.code !== "rpc_error") return false;
  return /not found/i.test(error.message);
}

/**
 * The provider a resumed thread runs, for attributing an approval request.
 *
 * The runtime's own summary wins over the stored record: a `setModel` in an
 * earlier session may have moved the thread, and the record is only as fresh as
 * the last write. Falls back to Claude when neither is a provider this SDK
 * knows, which is the same closed-union default the rest of the file uses.
 */
function resolveThreadProvider(...candidates: Array<string | undefined>): AdeProvider {
  for (const candidate of candidates) {
    if (candidate && isSupportedProvider(candidate)) return candidate;
  }
  return "claude";
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_RECENT_ERRORS = 20;
const DEFAULT_RESTART_ATTEMPTS = 5;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;

/** A turn is running, as far as a summary can say. */
function summaryTurnActive(summary: AgentChatSessionSummary | null): boolean {
  return summary?.status === "active" || typeof summary?.currentTurnStartedAt === "string";
}

/** Whether a stored MCP map has a remote server that needs header values. */
function needsHeaderValues(servers: Record<string, StoredMcpServerConfig> | undefined): boolean {
  if (!servers) return false;
  return Object.values(servers).some(
    (server) => (server.type === "http" || server.type === "sse") && (server.headerNames?.length ?? 0) > 0,
  );
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
  const sidecarRole = internal.adeDefaultRole ?? DEFAULT_ADE_ROLE;
  const restartPolicy = options.autoRestart
    ? {
        maxAttempts:
          typeof options.autoRestart === "object" && options.autoRestart.maxAttempts !== undefined
            ? Math.max(1, Math.floor(options.autoRestart.maxAttempts))
            : DEFAULT_RESTART_ATTEMPTS,
        backoffMs:
          typeof options.autoRestart === "object" && options.autoRestart.backoffMs !== undefined
            ? Math.max(0, options.autoRestart.backoffMs)
            : DEFAULT_RESTART_BACKOFF_MS,
      }
    : null;

  let binary: {
    binaryPath: string;
    runtimeRoot: string | null;
    nodeModulesPath: string | null;
    source: DoctorReport["runtime"]["source"];
    checksumVerified: boolean;
  } = {
    binaryPath: "",
    runtimeRoot: null,
    nodeModulesPath: null,
    source: "attached",
    checksumVerified: false,
  };

  if (!internal.attach) {
    const resolved = await resolveBinary({
      home,
      logger,
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.runtimeNodeModules ? { runtimeNodeModules: options.runtimeNodeModules } : {}),
      ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
      ...(options.allowDownload !== undefined ? { allowDownload: options.allowDownload } : {}),
      channel: options.channel ?? "latest",
      repo: internal.releaseRepo ?? DEFAULT_RELEASE_REPO,
      ...(internal.download ? { download: internal.download } : {}),
      ...(internal.allowPathDiscovery !== undefined
        ? { allowPathDiscovery: internal.allowPathDiscovery }
        : {}),
      ...(internal.resolveBundledFrom
        ? {
            resolveBundled: (bundleOptions: { platform: NodeJS.Platform; arch: string }) =>
              resolveBundledRuntime({
                ...bundleOptions,
                resolveFrom: internal.resolveBundledFrom as string,
              }),
          }
        : {}),
    });
    binary = {
      ...resolved,
      // `resolvePackagedRuntime()` returns `source: "packaged"` beside the
      // paths it resolved, so a host that spreads it in is reported as running
      // the copy inside its own bundle rather than an anonymous pinned path.
      ...(resolved.source === "explicit" && options.source === "packaged"
        ? { source: "packaged" as const }
        : {}),
    };
  }

  /**
   * Start (or reach) a runtime and return its connection.
   *
   * Called once at create and again by every `autoRestart` attempt, so the
   * reclaim rule below applies to a respawn exactly as it does to a first
   * start.
   */
  const boot = async (): Promise<{ connection: JsonRpcConnection; sidecar: Sidecar | null }> => {
    if (internal.attach) {
      // Attach mode never spawns: used by tests against a mock server and by
      // embedders that already manage the runtime's lifecycle.
      return { connection: await JsonRpcConnection.connect(socketPath), sidecar: null };
    }
    // A previous host that died without unwinding can still own this home. The
    // runtime's own parent-death watchdog ends it within a few seconds, but a
    // new client starting inside that window would race a dying process for the
    // same endpoint. Reclaiming first makes the outcome deterministic: reuse a
    // healthy runtime, end a confirmed-stale one, and leave anything we cannot
    // positively identify alone (pid reuse means a recorded pid may now belong
    // to the user's editor).
    const reclaim = await reclaimStaleRuntime({
      home,
      socketPath,
      logger,
      probeEndpoint: async (endpoint) => {
        // "Answers a connection" is the liveness proof. Cheap, and it cannot
        // false-positive the way a process-name match would.
        try {
          const probe = await JsonRpcConnection.connect(endpoint);
          probe.close();
          return true;
        } catch {
          return false;
        }
      },
    });
    if (reclaim.action === "left") {
      // Spawning anyway would put a SECOND runtime on one SQLite state root.
      // Two writers over the same database is corruption, which is strictly
      // worse than refusing to start, and the caller cannot discover it from
      // inside. Fatal, with everything needed to resolve it by hand.
      throw new AdeError(
        "spawn_failed",
        `Another process (pid ${reclaim.pid}) is recorded as owning this ADE home and could not be ` +
          `confirmed stale: ${reclaim.reason}. Starting a second runtime on the same state root risks ` +
          `database corruption. Stop pid ${reclaim.pid} if it is an old ADE runtime, or delete ` +
          `${runtimePidfilePath(home)} if it is not.`,
      );
    }
    if (reclaim.action === "reused") {
      // Adopting the live runtime instead of spawning a second one for the same
      // home, which would fight over the socket and the database.
      return { connection: await JsonRpcConnection.connect(socketPath), sidecar: null };
    }
    const started = await startSidecar({
      binaryPath: binary.binaryPath,
      runtimeRoot: binary.runtimeRoot,
      nodeModulesPath: binary.nodeModulesPath,
      socketPath,
      home,
      logger,
      ...(internal.startupTimeoutMs ? { startupTimeoutMs: internal.startupTimeoutMs } : {}),
      adeDefaultRole: sidecarRole,
    });
    return { connection: started.connection, sidecar: started };
  };

  /**
   * `ade/initialize` + `ade/initialized`, then the compatibility verdict.
   *
   * Closes what `boot` opened on any failure, so a refused or broken runtime
   * never outlives the call that found it.
   */
  const handshake = async (bound: {
    connection: JsonRpcConnection;
    sidecar: Sidecar | null;
  }): Promise<{ initialize: AdeInitializeResult; compatibility: RuntimeCompatibility }> => {
    let result: AdeInitializeResult;
    try {
      result = await bound.connection.request<AdeInitializeResult>(
        "ade/initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientName: internal.clientName ?? "ade-sdk",
          // Least privilege. "cto" is the TUI's trusted-operator role and grants
          // far more than personal chats need; every action this client calls is
          // covered by "agent", which the live fixture verifies against a real
          // runtime rather than taking on trust.
          identity: { role: sidecarRole, callerId: `ade-sdk:${process.pid}` },
        },
        { timeoutMs: 60_000 },
      );
      await bound.connection.request("ade/initialized", undefined, { timeoutMs: 30_000 });
    } catch (error) {
      bound.connection.close();
      await bound.sidecar?.stop();
      throw new AdeError("handshake_failed", `The ADE runtime handshake failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const verdict = checkRuntimeCompatibility(result.runtimeInfo?.version ?? null);
    if (!verdict.supported) {
      const line =
        `ade sdk: runtime ${verdict.version ?? "(unknown version)"} is outside the range this SDK supports ` +
        `(${SUPPORTED_RUNTIME_RANGE})` +
        (verdict.note ? ` — ${verdict.note}` : "");
      if (options.requireCompatibleRuntime) {
        bound.connection.close();
        await bound.sidecar?.stop();
        throw new AdeError("runtime_incompatible", `${line}. Install a supported runtime.`);
      }
      logger(`${line}; features it lacks are detected and degrade`);
    }
    return { initialize: result, compatibility: verdict };
  };

  const firstBoot = await boot();
  const firstHandshake = await handshake(firstBoot);
  let connection = firstBoot.connection;
  let sidecar = firstBoot.sidecar;
  let initialize = firstHandshake.initialize;
  let compatibility = firstHandshake.compatibility;

  const recentErrors: DoctorReport["recentErrors"] = [];
  const recordError = (scope: string, error: unknown): void => {
    recentErrors.push({ at: new Date().toISOString(), scope, message: errorMessage(error) });
    while (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
    logger(`ade sdk: ${scope} failed: ${errorMessage(error)}`);
  };

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

  // Read through functions, not captured once: an `autoRestart` may land on a
  // runtime that answers the handshake differently (a newer binary on PATH, a
  // reused process), and the flags must follow the runtime actually connected.
  const capabilitiesOf = () => initialize.capabilities?.personalChats ?? null;
  const actionListed = (action: string): boolean => {
    const actions = capabilitiesOf()?.actions;
    return Array.isArray(actions) && actions.includes(action);
  };
  {
    const capabilities = capabilitiesOf();
    if (capabilities && Array.isArray(capabilities.actions) && capabilities.actions.length === 0) {
      logger("ade sdk: the runtime reports no personal chat actions; calls will fail");
    }
  }
  const mcpSupported = (): boolean => capabilitiesOf()?.mcpServers === true;
  /**
   * Whether the runtime lists the read-only `pendingInputs` action.
   *
   * A runtime that does not is not broken, it is older: `pendingApprovals()`
   * then reconstructs the set from the events this client saw, which cannot
   * include anything raised before it connected. The action list is the check
   * rather than a try/catch, because a failed call would have to be told apart
   * from a real error on every invocation.
   */
  const pendingInputsSupported = (): boolean => actionListed("pendingInputs");
  const updateMcpServersSupported = (): boolean => capabilitiesOf()?.updateMcpServers === true;
  /**
   * Whether an action is available, for the actions this SDK added after the
   * list was first published. A runtime that sends no list at all is trusted,
   * the same way every older action always has been.
   */
  const actionAvailable = (action: string): boolean => {
    const actions = capabilitiesOf()?.actions;
    return !Array.isArray(actions) || actions.includes(action);
  };

  const chats = new PersonalChatsApi(() => connection);
  const store = ThreadStore.forHome(home, logger);
  /** Every thread listens here; each runtime connection's stream feeds it. */
  const hub = new ChatEventHub();
  const startEvents = async (): Promise<ChatEventStream> => {
    const stream = new ChatEventStream({
      connection,
      pushSupported: capabilitiesOf()?.pushEvents === true,
      logger,
      ...(internal.pollIntervalMs ? { pollIntervalMs: internal.pollIntervalMs } : {}),
      onError: recordError,
    });
    stream.onEvent((envelope) => hub.emit(envelope));
    await stream.start();
    return stream;
  };
  let events = await startEvents();

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
    if (event !== "exit" && event !== "transport" && event !== "restart") {
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
  const displayNameFor = async (modelId: string): Promise<string | null> =>
    (await displayNames()).get(modelId) ?? null;

  const providerStatus = createProviderStatusPublisher({
    probeSupported: () => initialize.capabilities?.providers?.status === true,
    readCatalog,
    requestProbe: (refresh) =>
      connection.request<ProviderStatusRpcResult>(
        "providers.status",
        { refresh },
        { timeoutMs: 30_000 },
      ),
    recordError,
    logger,
    ...(internal.providerPollIntervalMs
      ? { pollIntervalMs: internal.providerPollIntervalMs }
      : {}),
    isDisposed: () => disposed,
  });
  const publishProviderStatus = providerStatus.publish;

  // ---- threads -------------------------------------------------------------

  const liveSessions = new Map<string, Thread>();

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

  /**
   * Keeps the durable record in step with a mid-thread model switch. Skipping
   * this would make the switch survive only until the next resume, which reads
   * provider/model straight back out of this file.
   */
  const persistThreadModel = (key: string) => async (
    selection: { provider: string; model: string; modelId: string },
  ): Promise<void> => {
    try {
      await store.touch(key, {
        ...(selection.provider ? { provider: selection.provider } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
      });
    } catch (error) {
      recordError("threadStore.touch", error);
    }
  };

  /** Persists a title or a refreshed MCP map; header values never reach disk. */
  const persistThreadRecord = (key: string) => async (patch: {
    title?: string | null;
    mcpServers?: Record<string, McpServerConfig>;
  }): Promise<void> => {
    try {
      await store.touch(key, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.mcpServers !== undefined
          ? { mcpServers: toStoredMcpServers(patch.mcpServers), requestedMcp: true }
          : {}),
      });
    } catch (error) {
      recordError("threadStore.touch", error);
    }
  };

  const emitSynthetic = (envelope: AgentChatEventEnvelope): void => hub.emit(envelope);

  /** The model a summary describes, with its display name, or null for none. */
  const modelSelectionOf = (
    summary: { provider?: unknown; model?: unknown; modelId?: unknown } | null,
    names: Map<string, string>,
    fallback?: { provider?: string; model?: string; modelId?: string },
  ): ThreadModelSelection | null => {
    const provider =
      typeof summary?.provider === "string" && summary.provider ? summary.provider : fallback?.provider ?? "";
    const model = typeof summary?.model === "string" && summary.model ? summary.model : fallback?.model ?? "";
    const modelId =
      typeof summary?.modelId === "string" && summary.modelId
        ? summary.modelId
        : fallback?.modelId ?? model;
    if (!modelId && !model) return null;
    return {
      modelId,
      provider,
      model,
      displayName: names.get(modelId) ?? names.get(model) ?? null,
    };
  };

  const openThread = (key: string, opts: ThreadResumeOptions = {}): Promise<AdeThread> => {
    assertUsable();
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      return Promise.reject(
        new AdeError("invalid_option", "A thread key must be a non-empty string."),
      );
    }

    // A thread this client already opened is returned as-is, before any option
    // is looked at — the same rule the record-backed resume below follows, and
    // for the same reason: one key is one conversation, and re-applying options
    // to a live one would move an agent that is already running. The mismatch
    // warning lives on the resume path, which is where the stored values are.
    // `refresh` is the exception and is applied through `updateMcpServers`.
    const existing = liveSessions.get(trimmedKey);
    if (existing) {
      const refreshServers = opts.refresh?.mcpServers;
      if (!refreshServers) return Promise.resolve(existing);
      return existing.updateMcpServers(refreshServers).then(
        () => existing,
        (error: unknown) => {
          logger(
            `ade sdk: thread "${trimmedKey}" could not apply refresh.mcpServers: ${errorMessage(error)}`,
          );
          return existing;
        },
      );
    }

    const pending = openInFlight.get(trimmedKey);
    if (pending) return pending;

    const started = openThreadUncached(trimmedKey, opts).finally(() => {
      openInFlight.delete(trimmedKey);
    });
    openInFlight.set(trimmedKey, started);
    return started;
  };

  /**
   * `chats.create`, with the engine's own argument refusals translated.
   *
   * The engine rejects a bad `requestedCwd` or policy with a message that
   * starts `invalid_argument:`, which arrives here as a generic `rpc_error`.
   * A caller cannot branch on prose, and the two cases are genuinely different:
   * `rpc_error` says the runtime failed, `invalid_option` says the arguments
   * were wrong. Everything else is passed through untouched.
   */
  const createChat = async (
    args: Record<string, unknown>,
  ): Promise<AgentChatSessionSummary> => {
    try {
      return await chats.create(args);
    } catch (error) {
      if (error instanceof AdeError && error.code === "rpc_error" && /invalid_argument:/.test(error.message)) {
        throw new AdeError("invalid_option", error.message, { cause: error });
      }
      throw error;
    }
  };

  /**
   * Push fresh MCP servers onto a session that is being resumed.
   *
   * Runs when the caller passed `refresh.mcpServers`, or when the stored
   * servers need header values and an `mcpHeaders` callback can supply them —
   * the runtime does not keep header values across its own restarts either, so
   * a resume that skipped this would reconnect MCP unauthenticated. Never
   * throws: a refresh that fails leaves the thread usable on its old servers,
   * and says so.
   */
  const refreshMcpOnResume = async (
    key: string,
    sessionId: string,
    record: ThreadRecord,
    refreshServers: Record<string, McpServerConfig> | undefined,
  ): Promise<AgentChatSessionSummary | null> => {
    const source: Record<string, McpServerConfig | StoredMcpServerConfig> | undefined =
      refreshServers ??
      (options.mcpHeaders && needsHeaderValues(record.mcpServers) ? record.mcpServers : undefined);
    if (!source) return null;
    const resolved = withResolvedHeaders(key, source, options.mcpHeaders);
    const warning = missingHeadersWarning(key, resolved.missing);
    if (warning) logger(warning);
    if (!updateMcpServersSupported()) {
      logger(
        `ade sdk: thread "${key}" could not refresh its MCP servers: this runtime does not advertise ` +
          `capabilities.personalChats.updateMcpServers, so it keeps the servers it already has`,
      );
      return null;
    }
    try {
      const updated = (await chats.updateSession({
        sessionId,
        mcpServers: resolved.servers,
      })) as AgentChatSessionSummary | null;
      await store.touch(key, { mcpServers: toStoredMcpServers(resolved.servers), requestedMcp: true });
      return updated;
    } catch (error) {
      recordError(`refresh mcpServers for "${key}"`, error);
      return null;
    }
  };

  const openThreadUncached = async (
    trimmedKey: string,
    opts: ThreadResumeOptions,
    register = true,
  ): Promise<Thread> => {
    // Provider/model are validated at the CREATE branch below, not here: a
    // durable key already recorded both, so reopening `"support"` after a
    // restart must not force the caller to remember how it was created.
    const record = await store.get(trimmedKey);
    const suppliedForComparison = {
      // Canonicalized, not merely resolved: the stored value is the
      // engine's canonical spelling, so a plain `path.resolve` compares
      // two names for one directory and reports a caller's own unchanged
      // `cwd` as ignored.
      ...(opts.cwd !== undefined ? { cwd: canonicalThreadCwd(opts.cwd) } : {}),
      ...(opts.instructions !== undefined
        ? { instructions: normalizeInstructions(opts.instructions) }
        : {}),
      ...(opts.settingSources !== undefined ? { settingSources: opts.settingSources } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
      // Compared in the stored form. The record keeps header NAMES, so a map
      // passed with its bearer token would otherwise never equal the record
      // and every resume would report the servers as ignored. A caller who is
      // replacing them passes `refresh`, which is not compared at all.
      ...(opts.mcpServers !== undefined && opts.refresh?.mcpServers === undefined
        ? { mcpServers: toStoredMcpServers(opts.mcpServers) }
        : {}),
      ...(opts.loadUserMcpServers !== undefined
        ? { loadUserMcpServers: opts.loadUserMcpServers }
        : {}),
    };
    const storedForComparison = (from: ThreadRecord) => ({
      ...(from.cwd !== undefined ? { cwd: from.cwd } : {}),
      ...(from.instructions !== undefined ? { instructions: from.instructions } : {}),
      ...(from.settingSources !== undefined ? { settingSources: from.settingSources } : {}),
      ...(from.permissionPolicy !== undefined ? { permissionPolicy: from.permissionPolicy } : {}),
      ...(from.mcpServers !== undefined ? { mcpServers: from.mcpServers } : {}),
      ...(from.loadUserMcpServers !== undefined
        ? { loadUserMcpServers: from.loadUserMcpServers }
        : {}),
    });

    if (record) {
      // Resume: the mapping is only trustworthy if the runtime still has the
      // session. A home copied between machines, a deleted chat, or a wiped
      // state root all leave a dangling key — recreate rather than fail.
      let summary: AgentChatSessionSummary | null = null;
      try {
        summary = await chats.getSummary(record.sessionId);
      } catch (error) {
        if (!isAbsentSessionError(error)) throw error;
        recordError("getSummary", error);
      }
      if (summary?.sessionId) {
        await store.touch(trimmedKey, { title: summary.title ?? record.title ?? null });
        // A capability report is only meaningful for a thread that asked for
        // one. If this thread is on record as having requested nothing, ignore
        // whatever the runtime volunteered: a runtime that ever defaults a stub
        // onto every summary would otherwise invert the documented meaning of
        // `mcpCapability === null` for every chat at once. Records with no
        // stored answer (legacy, or created outside the SDK) trust the runtime.
        //
        // A refresh that pushed servers is itself an MCP request, so its
        // report is always read.
        const refreshed = await refreshMcpOnResume(
          trimmedKey,
          summary.sessionId,
          record,
          opts.refresh?.mcpServers,
        );
        const resumedCapability = refreshed
          ? normalizeMcpCapability(refreshed.mcpCapability)
          : record.requestedMcp === false
            ? null
            : normalizeMcpCapability(summary.mcpCapability);
        // The host-config reports come off the RECORD, not off `opts`. A resume
        // re-applies what the thread was created with and ignores new options,
        // so reading "was instructions requested?" from this call's arguments
        // would report a capability for a request this session never made.
        //
        // That rule is quiet, and quiet is the problem: a caller who passes a
        // new `cwd` and a new policy believes the agent is confined to both.
        // Say so once, per resume, for every option that actually differs.
        for (const line of threadResumeMismatchWarnings({
          key: trimmedKey,
          supplied: suppliedForComparison,
          stored: storedForComparison(record),
        })) {
          logger(line);
        }
        const names = await displayNames();
        const thread = new Thread(
          summary.sessionId,
          trimmedKey,
          resumedCapability,
          chats,
          hub,
          assertUsable,
          persistThreadModel(trimmedKey),
          {
            provider: resolveThreadProvider(summary.provider, record.provider),
            instructionsCapability: normalizeInstructionsCapability(
              summary.instructionsCapability,
              record.instructions !== undefined,
            ),
            settingSourcesCapability: normalizeSettingSourcesCapability(
              summary.settingSourcesCapability,
              record.settingSources !== undefined,
            ),
            permissionCapability: normalizePermissionCapability(
              summary.permissionCapability,
              record.permissionPolicy !== undefined,
            ),
            requestedInstructions: record.instructions !== undefined,
            requestedSettingSources: record.settingSources !== undefined,
            requestedPermissionPolicy: record.permissionPolicy !== undefined,
            pendingInputsSupported: pendingInputsSupported(),
            logger,
            title: summary.title ?? record.title ?? null,
            model: modelSelectionOf(summary, names, {
              provider: record.provider,
              model: record.model,
              ...(record.modelId ? { modelId: record.modelId } : {}),
            }),
            ...threadServices(trimmedKey, record.permissionPolicy),
          },
        );
        if (register) liveSessions.set(trimmedKey, thread);
        return thread;
      }
      logger(
        `ade sdk: thread "${trimmedKey}" pointed at a session the runtime no longer has; creating a new one`,
      );
      await store.remove(trimmedKey);
      // The same stored-wins rule as a resume, so the same honesty about the
      // options it overrode.
      for (const line of threadResumeMismatchWarnings({
        key: trimmedKey,
        verb: "recreated",
        supplied: suppliedForComparison,
        stored: storedForComparison(record),
      })) {
        logger(line);
      }
    }

    // ---- create ------------------------------------------------------------
    // A RECREATE (the key has a record, the runtime lost its session) rebuilds
    // the thread the record describes. The stored value wins for every field
    // that shapes what the agent can do; the call's options only fill a field
    // the record lacks. The call's options winning was the 0.2 rule, and it let
    // any caller able to name a key — a renderer over the Electron bridge —
    // rebuild a lost thread on another provider, under a looser policy, or with
    // no MCP servers at all. For a brand-new key there is no record and the
    // call's options are all there is.
    const provider = (record?.provider || opts.provider) as AdeProvider | undefined;
    const model = record?.modelId || record?.model || opts.model;
    if (!provider || !isSupportedProvider(provider)) {
      throw new AdeError(
        "invalid_option",
        record
          ? `The stored thread "${trimmedKey}" names an unsupported provider (${String(provider)}).`
          : `Opening the new thread "${trimmedKey}" needs a provider. Pass { provider, model }.`,
      );
    }
    if (!model?.trim()) {
      throw new AdeError(
        "invalid_option",
        `Opening the new thread "${trimmedKey}" needs a model id. Pass { provider, model }.`,
      );
    }

    // Host configuration: the record, then this call's options, then the
    // client-wide default.
    const instructions =
      record?.instructions ??
      normalizeInstructions(opts.instructions) ??
      normalizeInstructions(options.instructions);
    const cwd =
      record?.cwd ?? (opts.cwd !== undefined ? validateThreadCwd(opts.cwd, home) : undefined);
    const settingSources = record?.settingSources ?? normalizeSettingSources(opts.settingSources);
    const permissions: PermissionPreset | ThreadPermissionPolicy =
      record?.permissionPolicy ?? opts.permissions ?? "default";
    const permissionPolicy = isPermissionPolicy(permissions) ? permissions : undefined;
    // Validated here so a bad value fails the open, not a timer later.
    readApprovalTimeoutMs(permissionPolicy);

    // `refresh.mcpServers` is the one field that replaces the record; the
    // record's servers carry header NAMES only, so their values come from the
    // `mcpHeaders` callback.
    const suppliedMcp =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0
        ? opts.mcpServers
        : undefined;
    const mcpSource: Record<string, McpServerConfig | StoredMcpServerConfig> | undefined =
      opts.refresh?.mcpServers ??
      (record?.mcpServers && Object.keys(record.mcpServers).length > 0 ? record.mcpServers : undefined) ??
      suppliedMcp;
    const resolvedMcp = mcpSource
      ? withResolvedHeaders(trimmedKey, mcpSource, options.mcpHeaders)
      : undefined;
    const headersWarning = resolvedMcp ? missingHeadersWarning(trimmedKey, resolvedMcp.missing) : null;
    if (headersWarning) logger(headersWarning);
    const mcpServers = resolvedMcp?.servers;
    const loadUserMcpServers =
      record?.loadUserMcpServers !== undefined ? record.loadUserMcpServers : opts.loadUserMcpServers;

    // Two distinct questions, and conflating them is a bug: "did the caller
    // supply servers" gates the drop warning, while "did the caller make any
    // MCP request at all" (servers OR strict mode) gates the capability
    // bookkeeping. A strict-only request supplies no servers but is still a
    // request, and it succeeds.
    const suppliedServers =
      mcpServers !== undefined && Object.keys(mcpServers).length > 0;
    const askedForMcp = suppliedServers || loadUserMcpServers !== undefined;

    if (suppliedServers && !mcpSupported() && capabilitiesOf()) {
      // Never silently drop MCP config: an app that asked for a tool server and
      // did not get one behaves wrongly rather than visibly failing.
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support per-thread MCP servers (capabilities.personalChats.mcpServers is not set). Upgrade the runtime or drop `mcpServers`.",
      );
    }

    const title = opts.title ?? record?.title ?? undefined;
    const created = await createChat({
      provider,
      model,
      ...(title ? { title } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      // A policy sends `permissionMode: "default"` plus the policy itself, so a
      // runtime that does not understand `permissionPolicy` behaves like
      // today's `"default"` rather than like `always-allow`. Degrading toward
      // more prompting is the only safe direction for a permission surface.
      // `approvalTimeoutMs` never reaches the wire: the normalizer drops every
      // field the engine does not define, and the SDK enforces that one itself.
      ...resolvePermissionArgs(provider, permissions),
      ...(instructions ? { instructions } : {}),
      // `requestedCwd` is the field name the engine has always used for this.
      ...(cwd ? { requestedCwd: cwd } : {}),
      ...(settingSources ? { settingSources } : {}),
      // `suppliedServers`, NOT truthiness. `mcpServers: {}` is an empty object,
      // which is truthy — so a bare `opts.mcpServers` check made an empty map
      // send servers on the wire AND turn strict mode on, while every local
      // decision (the drop warning, `requestedMcp` on the durable record) read
      // it as "nothing supplied". A caller who passed `{}` got silent
      // strictness plus a stored record that would later discard the runtime's
      // own capability report.
      ...(suppliedServers ? { mcpServers } : {}),
      // `strictMcpConfig` is the wire spelling of "do not load the user's own
      // MCP config", and it is a TRISTATE: absent lets the session profile
      // decide (strict, for the profile SDK threads run), true withholds, and
      // an explicit false overrides the profile to load it. So a caller that
      // asked for the user's servers must send `false` rather than omit the
      // key — omitting it would silently give them the opposite.
      //
      // Gated on the same `askedForMcp` the bookkeeping below uses: one
      // question, one answer, so the wire and the record can never disagree.
      ...(askedForMcp ? { strictMcpConfig: loadUserMcpServers !== true } : {}),
    });
    if (!created?.sessionId) {
      throw new AdeError("protocol_error", "The ADE runtime created a chat with no session id.");
    }

    // The CANONICAL path, as the runtime echoes it on the create summary, not
    // the caller's spelling. The engine resolves the path before it binds the
    // session, so one directory reached through a symlink or in another case
    // comes back as one string. Recording the caller's spelling made a later
    // `open()` with the runtime's own spelling of the SAME directory log a
    // resume mismatch and report the stored value as ignored, on a `cwd`
    // nothing had changed. Falls back to the resolved path a runtime that
    // echoes nothing.
    const recordedCwd = cwd
      ? (typeof created.requestedCwd === "string" && created.requestedCwd ? created.requestedCwd : cwd)
      : undefined;

    const now = new Date().toISOString();
    await store.put({
      key: trimmedKey,
      sessionId: created.sessionId,
      provider,
      model,
      ...(typeof created.modelId === "string" && created.modelId ? { modelId: created.modelId } : {}),
      createdAt: record?.createdAt ?? now,
      lastOpenedAt: now,
      title: created.title ?? title ?? null,
      requestedMcp: askedForMcp,
      // Header NAMES only. The values went on the wire above and nowhere else.
      ...(suppliedServers && mcpServers ? { mcpServers: toStoredMcpServers(mcpServers) } : {}),
      ...(loadUserMcpServers !== undefined ? { loadUserMcpServers } : {}),
      ...(instructions ? { instructions } : {}),
      ...(recordedCwd ? { cwd: recordedCwd } : {}),
      ...(settingSources ? { settingSources } : {}),
      ...(permissionPolicy ? { permissionPolicy } : {}),
    });
    const capability = normalizeMcpCapability(created.mcpCapability);
    const instructionsCapability = normalizeInstructionsCapability(
      created.instructionsCapability,
      instructions !== undefined,
    );
    const settingSourcesCapability = normalizeSettingSourcesCapability(
      created.settingSourcesCapability,
      settingSources !== undefined,
    );
    const permissionCapability = normalizePermissionCapability(
      created.permissionCapability,
      permissionPolicy !== undefined,
    );
    // Every honesty rule for a freshly opened thread lives in one pure
    // function, unit-tested directly. See `threadWarnings.ts`.
    for (const line of threadOpenWarnings({
      key: trimmedKey,
      suppliedServers,
      mcpServers,
      loadUserMcpServers,
      instructions,
      settingSources,
      permissionPolicy,
      mcpCapability: capability,
      instructionsCapability,
      settingSourcesCapability,
      permissionCapability,
    })) {
      logger(line);
    }

    const names = await displayNames();
    const thread = new Thread(
      created.sessionId,
      trimmedKey,
      capability,
      chats,
      hub,
      assertUsable,
      persistThreadModel(trimmedKey),
      {
        provider,
        instructionsCapability,
        settingSourcesCapability,
        permissionCapability,
        // What the CALLER asked for, not what came back. `setModel` re-derives
        // every report and needs the request, which a null report cannot carry.
        requestedInstructions: instructions !== undefined,
        requestedSettingSources: settingSources !== undefined,
        requestedPermissionPolicy: permissionPolicy !== undefined,
        pendingInputsSupported: pendingInputsSupported(),
        logger,
        title: created.title ?? title ?? null,
        model: modelSelectionOf(created, names, { provider, model }),
        ...threadServices(trimmedKey, permissionPolicy),
      },
    );
    if (register) liveSessions.set(trimmedKey, thread);
    return thread;
  };

  /** The per-thread hooks every `Thread` gets, whichever branch built it. */
  function threadServices(key: string, policy: ThreadPermissionPolicy | undefined) {
    const approvalTimeoutMs = readApprovalTimeoutMs(policy);
    return {
      displayNameFor,
      onRecordChanged: persistThreadRecord(key),
      emitSynthetic,
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      updateMcpServersSupported: updateMcpServersSupported(),
      historyPageSupported: actionListed("getEventHistoryPage"),
      ...(options.mcpHeaders ? { resolveMcpHeaders: options.mcpHeaders } : {}),
    };
  }

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
   * The session a key points at, for the three lifecycle actions: the live
   * thread's (which a recreate may have moved) over the record's.
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
   * The destructive-while-streaming rule at the top of this file: a delete or
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
    if (!actionAvailable(action)) {
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

  // ---- runtime loss and restart -------------------------------------------

  /** Bumped per connection, so a late signal from a replaced runtime is ignored. */
  let generation = 0;
  let lostGeneration = -1;
  let restarting: Promise<void> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The runtime is gone. Runs once per connection, whichever signal came first.
   *
   * Tells every live thread (the synthetic `status` error), then restarts when
   * the host opted in.
   */
  const onRuntimeLost = (gen: number, message: string): void => {
    if (disposed || gen !== generation || lostGeneration === gen) return;
    lostGeneration = gen;
    for (const thread of liveSessions.values()) thread.notifyRuntimeLost(message);
    if (restartPolicy && !restarting) {
      restarting = restartRuntime().finally(() => {
        restarting = null;
      });
    }
  };

  const watchRuntime = (): void => {
    const gen = ++generation;
    const watchedConnection = connection;
    watchedConnection.onClose((error) => {
      if (disposed || gen !== generation) return;
      recordError("transport", error);
      emitClient("transport", { state: "closed", error: errorMessage(error) });
      onRuntimeLost(gen, `The connection to the ADE runtime closed: ${errorMessage(error)}`);
    });
    const child = sidecar?.child;
    if (child) {
      const stderr: string[] = [];
      child.stderr?.on("data", (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          stderr.push(line);
          if (stderr.length > 20) stderr.shift();
        }
      });
      child.once("exit", (code, signal) => {
        if (disposed || gen !== generation) return;
        const tail = stderr.length > 0 ? stderr.join("\n") : null;
        recordError("runtime", `exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
        emitClient("exit", { code, signal: signal ?? null, error: tail });
        onRuntimeLost(
          gen,
          `The ADE runtime exited (code ${code ?? "null"}, signal ${signal ?? "null"}); the turn in flight, if any, ended.`,
        );
      });
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        resolve();
      }, ms);
      restartTimer.unref?.();
    });

  /**
   * Re-bind every live thread to the new runtime.
   *
   * A session the new runtime still has keeps its thread object untouched,
   * with fresh MCP header values pushed when the record needs them. A session
   * it lost is recreated from the record and the old object ADOPTS the new
   * session, because a host and a bridge both hold that object.
   */
  const rebindLiveThreads = async (): Promise<void> => {
    for (const [key, thread] of [...liveSessions]) {
      try {
        const record = await store.get(key);
        let summary: AgentChatSessionSummary | null = null;
        try {
          summary = await chats.getSummary(thread.id);
        } catch (error) {
          if (!isAbsentSessionError(error)) throw error;
        }
        if (summary?.sessionId) {
          if (record) {
            const refreshed = await refreshMcpOnResume(key, thread.id, record, undefined);
            if (refreshed) thread.setMcpCapability(normalizeMcpCapability(refreshed.mcpCapability));
          }
          continue;
        }
        if (!record) continue;
        const fresh = await openThreadUncached(key, {}, false);
        thread.adoptSession(fresh);
      } catch (error) {
        recordError(`restart reopen "${key}"`, error);
      }
    }
  };

  const restartRuntime = async (): Promise<void> => {
    const policy = restartPolicy!;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await sleep(policy.backoffMs * 2 ** (attempt - 1));
      if (disposed) return;
      try {
        const bound = await boot();
        let next: { initialize: AdeInitializeResult; compatibility: RuntimeCompatibility };
        try {
          next = await handshake(bound);
        } catch (error) {
          throw error;
        }
        if (disposed) {
          bound.connection.close();
          await bound.sidecar?.stop();
          return;
        }
        const previousEvents = events;
        connection = bound.connection;
        sidecar = bound.sidecar;
        initialize = next.initialize;
        compatibility = next.compatibility;
        await previousEvents.dispose();
        events = await startEvents();
        watchRuntime();
        await rebindLiveThreads();
        logger(`ade sdk: runtime restarted (attempt ${attempt})`);
        emitClient("restart", { attempt, ok: true, error: null });
        emitClient("transport", { state: "reconnected", error: null });
        return;
      } catch (error) {
        recordError(`restart attempt ${attempt}`, error);
        emitClient("restart", { attempt, ok: false, error: errorMessage(error) });
      }
    }
    logger(`ade sdk: gave up restarting the runtime after ${policy.maxAttempts} attempts`);
  };

  watchRuntime();

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
      const [version, providerStatus, records, signature] = await Promise.all([
        binary.binaryPath
          ? readBinaryVersion(binary)
          : Promise.resolve(initialize.runtimeInfo?.version ?? null),
        publishProviderStatus().catch(() => ({}) as Record<string, ProviderStatus>),
        store.all(),
        readRuntimeSignature(),
      ]);
      const socketConnected = !connection.isClosed;
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
        providers: providerStatus,
        socketPath,
        socketConnected,
        runtimeVersion: initialize.runtimeInfo?.version ?? null,
        runtimePid: initialize.runtimeInfo?.pid ?? sidecar?.child.pid ?? null,
        events: {
          mode: events.transport,
          epoch: events.currentEpoch,
          gapsRecovered: events.recoveredGapCount,
        },
        threads: { tracked: records.length, live },
        recentErrors: [...recentErrors],
        compatibility,
      });
    },

    exportThread: async (key) => {
      assertUsable();
      const trimmedKey = key.trim();
      const live = liveSessions.get(trimmedKey);
      const record = await store.get(trimmedKey);
      const sessionId = live?.id ?? record?.sessionId;
      if (!sessionId) {
        throw new AdeError("thread_not_found", `No thread is registered under the key "${key}".`);
      }
      const snapshot = await chats.getEventHistory({ sessionId });
      // JSONL: one envelope per line, in transcript order. The same shape ADE
      // writes to its own durable transcripts, so the output drops straight
      // into any tool that already reads those.
      return (snapshot?.events ?? [])
        .map((envelope) => JSON.stringify(envelope))
        .join("\n");
    },

    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      providerStatus.dispose();
      // Each thread holds a listener on the shared event hub from its
      // constructor. Clearing the map alone left those subscribed for the life
      // of the client, with every envelope fanned out to all of them.
      for (const thread of liveSessions.values()) thread.dispose();
      liveSessions.clear();
      openInFlight.clear();
      clientListeners.clear();
      await events.dispose();
      hub.clear();
      connection.close();
      await sidecar?.stop();
      logger("ade sdk: disposed");
    },
  };

  return client;
}
