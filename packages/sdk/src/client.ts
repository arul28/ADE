import fs from "node:fs";
import path from "node:path";
import { readBinaryVersion, resolveBinary } from "./binary.js";
import { buildDoctorReport } from "./doctorReport.js";
import { resolveBundledRuntime } from "./bundledRuntime.js";
import { DEFAULT_RELEASE_REPO } from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { ChatEventStream } from "./eventStream.js";
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
  isPermissionPolicy,
  isSupportedProvider,
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
import { ThreadStore } from "./threadStore.js";
import { SDK_VERSION } from "./version.js";
import type {
  AdeInitializeResult,
  AdeProvider,
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
  ThreadResumeOptions,
} from "./clientOptions.js";

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
    list(): Promise<ThreadSummary[]>;
  };
  doctor(): Promise<DoctorReport>;
  exportThread(key: string): Promise<string>;
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

  let sidecar: Sidecar | null = null;
  let connection: JsonRpcConnection;
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

  if (internal.attach) {
    // Attach mode never spawns: used by tests against a mock server and by
    // embedders that already manage the runtime's lifecycle.
    connection = await JsonRpcConnection.connect(socketPath);
  } else {
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
    binary = { ...resolved };
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
      connection = await JsonRpcConnection.connect(socketPath);
    } else {
    sidecar = await startSidecar({
      binaryPath: resolved.binaryPath,
      runtimeRoot: resolved.runtimeRoot,
      nodeModulesPath: resolved.nodeModulesPath,
      socketPath,
      home,
      logger,
      ...(internal.startupTimeoutMs ? { startupTimeoutMs: internal.startupTimeoutMs } : {}),
      adeDefaultRole: sidecarRole,
    });
    connection = sidecar.connection;
    }
  }

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

  let initialize: AdeInitializeResult;
  try {
    initialize = await connection.request<AdeInitializeResult>(
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
    await connection.request("ade/initialized", undefined, { timeoutMs: 30_000 });
  } catch (error) {
    connection.close();
    await sidecar?.stop();
    throw new AdeError("handshake_failed", `The ADE runtime handshake failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const capabilities = initialize.capabilities?.personalChats ?? null;
  if (capabilities && Array.isArray(capabilities.actions) && capabilities.actions.length === 0) {
    logger("ade sdk: the runtime reports no personal chat actions; calls will fail");
  }
  const mcpSupported = capabilities?.mcpServers === true;
  /**
   * Whether the runtime lists the read-only `pendingInputs` action.
   *
   * A runtime that does not is not broken, it is older: `pendingApprovals()`
   * then reconstructs the set from the events this client saw, which cannot
   * include anything raised before it connected. The action list is the check
   * rather than a try/catch, because a failed call would have to be told apart
   * from a real error on every invocation.
   */
  const pendingInputsSupported =
    Array.isArray(capabilities?.actions) && capabilities.actions.includes("pendingInputs");

  const chats = new PersonalChatsApi(connection);
  const store = ThreadStore.forHome(home, logger);
  const events = new ChatEventStream({
    connection,
    pushSupported: capabilities?.pushEvents === true,
    logger,
    ...(internal.pollIntervalMs ? { pollIntervalMs: internal.pollIntervalMs } : {}),
    onError: recordError,
  });
  await events.start();

  let disposed = false;
  const assertUsable = (): void => {
    if (disposed) throw new AdeError("disposed", "This ADE chat client was disposed.");
  };

  connection.onClose((error) => {
    if (disposed) return;
    recordError("transport", error);
  });

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

  const providerStatus = createProviderStatusPublisher({
    probeSupported: initialize.capabilities?.providers?.status === true,
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
      });
    } catch (error) {
      recordError("threadStore.touch", error);
    }
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
    const existing = liveSessions.get(trimmedKey);
    if (existing) return Promise.resolve(existing);

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

  const openThreadUncached = async (
    trimmedKey: string,
    opts: ThreadResumeOptions,
  ): Promise<AdeThread> => {

    // Provider/model are validated at the CREATE branch below, not here: a
    // durable key already recorded both, so reopening `"support"` after a
    // restart must not force the caller to remember how it was created.
    const record = await store.get(trimmedKey);
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
        const resumedCapability =
          record.requestedMcp === false
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
          supplied: {
            // Canonicalized, not merely resolved: the stored value is the
            // engine's canonical spelling, so a plain `path.resolve` compares
            // two names for one directory and reports a caller's own unchanged
            // `cwd` as ignored.
            ...(opts.cwd !== undefined ? { cwd: canonicalThreadCwd(opts.cwd) } : {}),
            ...(opts.instructions !== undefined
              ? { instructions: normalizeInstructions(opts.instructions) }
              : {}),
            ...(opts.settingSources !== undefined
              ? { settingSources: opts.settingSources }
              : {}),
            ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
            ...(opts.mcpServers !== undefined ? { mcpServers: opts.mcpServers } : {}),
            ...(opts.loadUserMcpServers !== undefined
              ? { loadUserMcpServers: opts.loadUserMcpServers }
              : {}),
          },
          stored: {
            ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
            ...(record.instructions !== undefined ? { instructions: record.instructions } : {}),
            ...(record.settingSources !== undefined
              ? { settingSources: record.settingSources }
              : {}),
            ...(record.permissionPolicy !== undefined
              ? { permissionPolicy: record.permissionPolicy }
              : {}),
            ...(record.mcpServers !== undefined ? { mcpServers: record.mcpServers } : {}),
            ...(record.loadUserMcpServers !== undefined
              ? { loadUserMcpServers: record.loadUserMcpServers }
              : {}),
          },
        })) {
          logger(line);
        }
        const thread = new Thread(
          summary.sessionId,
          trimmedKey,
          resumedCapability,
          chats,
          events,
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
            pendingInputsSupported,
            logger,
          },
        );
        liveSessions.set(trimmedKey, thread);
        return thread;
      }
      logger(
        `ade sdk: thread "${trimmedKey}" pointed at a session the runtime no longer has; creating a new one`,
      );
      await store.remove(trimmedKey);
    }

    // ---- create ------------------------------------------------------------
    // Recreating a dangling key falls back to the record's own provider/model
    // AND its stored MCP request, so a resume that has to rebuild still lands
    // on the same tool surface. `opts` win when the caller re-supplies them.
    const provider = (opts.provider ?? record?.provider) as AdeProvider | undefined;
    const model = opts.model ?? record?.model;
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

    // Host configuration follows the same precedence the provider and model do:
    // this call's options, then what the key was created with, then the
    // client-wide default. A recreate after the runtime lost the session has to
    // rebuild the same thread, not a differently-behaved one under the old name.
    const instructions =
      normalizeInstructions(opts.instructions) ??
      record?.instructions ??
      normalizeInstructions(options.instructions);
    const cwd =
      opts.cwd !== undefined ? validateThreadCwd(opts.cwd, home) : record?.cwd;
    const settingSources = normalizeSettingSources(opts.settingSources) ?? record?.settingSources;
    const permissions: PermissionPreset | ThreadPermissionPolicy =
      opts.permissions ?? record?.permissionPolicy ?? "default";
    const permissionPolicy = isPermissionPolicy(permissions) ? permissions : undefined;

    const mcpServers =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0
        ? opts.mcpServers
        : record?.mcpServers;
    const loadUserMcpServers =
      opts.loadUserMcpServers !== undefined
        ? opts.loadUserMcpServers
        : record?.loadUserMcpServers;

    // Two distinct questions, and conflating them is a bug: "did the caller
    // supply servers" gates the drop warning, while "did the caller make any
    // MCP request at all" (servers OR strict mode) gates the capability
    // bookkeeping. A strict-only request supplies no servers but is still a
    // request, and it succeeds.
    const suppliedServers =
      mcpServers !== undefined && Object.keys(mcpServers).length > 0;
    const askedForMcp = suppliedServers || loadUserMcpServers !== undefined;

    if (suppliedServers && !mcpSupported && capabilities) {
      // Never silently drop MCP config: an app that asked for a tool server and
      // did not get one behaves wrongly rather than visibly failing.
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support per-thread MCP servers (capabilities.personalChats.mcpServers is not set). Upgrade the runtime or drop `mcpServers`.",
      );
    }

    const created = await createChat({
      provider,
      model,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      // A policy sends `permissionMode: "default"` plus the policy itself, so a
      // runtime that does not understand `permissionPolicy` behaves like
      // today's `"default"` rather than like `always-allow`. Degrading toward
      // more prompting is the only safe direction for a permission surface.
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
      createdAt: now,
      lastOpenedAt: now,
      title: created.title ?? opts.title ?? null,
      requestedMcp: askedForMcp,
      ...(suppliedServers ? { mcpServers } : {}),
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

    const thread = new Thread(
      created.sessionId,
      trimmedKey,
      capability,
      chats,
      events,
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
        pendingInputsSupported,
        logger,
      },
    );
    liveSessions.set(trimmedKey, thread);
    return thread;
  };

  const listThreads = async (): Promise<ThreadSummary[]> => {
    assertUsable();
    const [sessions, records] = await Promise.all([
      chats.list(true).catch((error) => {
        recordError("list", error);
        return [] as AgentChatSessionSummary[];
      }),
      store.all(),
    ]);
    const keyBySession = new Map(records.map((record) => [record.sessionId, record.key]));
    return sessions.map((session) => ({
      key: keyBySession.get(session.sessionId) ?? null,
      sessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
      title: session.title ?? null,
      status: session.status,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      archived: Boolean(session.archivedAt),
    }));
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

    threads: { open: openThread, list: listThreads },

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
      });
    },

    exportThread: async (key) => {
      assertUsable();
      const record = await store.get(key.trim());
      if (!record) {
        throw new AdeError("thread_not_found", `No thread is registered under the key "${key}".`);
      }
      const snapshot = await chats.getEventHistory({ sessionId: record.sessionId });
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
      providerStatus.dispose();
      // Each thread holds a listener on the shared event stream from its
      // constructor. Clearing the map alone left those subscribed for the life
      // of the client, with every envelope fanned out to all of them.
      for (const thread of liveSessions.values()) thread.dispose();
      liveSessions.clear();
      openInFlight.clear();
      await events.dispose();
      connection.close();
      await sidecar?.stop();
      logger("ade sdk: disposed");
    },
  };

  return client;
}
