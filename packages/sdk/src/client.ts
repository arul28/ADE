import fs from "node:fs";
import path from "node:path";
import { readBinaryVersion, resolveBinary } from "./binary.js";
import { DEFAULT_RELEASE_REPO, type RuntimeDownloader } from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { ChatEventStream } from "./eventStream.js";
import { JsonRpcConnection } from "./jsonRpc.js";
import { isSupportedProvider, permissionArgs, type PermissionPreset } from "./permissions.js";
import { PersonalChatsApi } from "./personalChats.js";
import {
  deriveProviderStatus,
  flattenCatalog,
  providerStatusFingerprint,
} from "./providers.js";
import { reclaimStaleRuntime, runtimePidfilePath } from "./runtimePidfile.js";
import { DEFAULT_ADE_ROLE, startSidecar, type Sidecar } from "./sidecar.js";
import { resolveRuntimeSocketPath } from "./socketPath.js";
import { Thread, type AdeThread } from "./thread.js";
import { ThreadStore } from "./threadStore.js";
import type {
  AdeInitializeResult,
  AdeProvider,
  AgentChatModelCatalog,
  AgentChatSessionSummary,
  DoctorReport,
  McpCapabilityReport,
  McpServerConfig,
  ModelCatalogEntry,
  ProviderStatus,
  ThreadSummary,
  Unsubscribe,
} from "./types.js";

export type CreateAdeChatOptions = {
  /** Isolated per-app ADE state root. Created if missing. */
  home: string;
  /** Pin a specific `ade` build. Skips PATH discovery and the downloader. */
  binaryPath?: string;
  /** Release channel for the downloader: `latest` (default) or a tag. */
  channel?: string;
  logger?: (line: string) => void;
};

/** Escape hatches for tests and embedders. Not part of the stable surface. */
export type InternalAdeChatOptions = CreateAdeChatOptions & {
  /** Override the endpoint (a mock server's temp socket, for instance). */
  socketPath?: string;
  /** Attach to an already-running runtime instead of spawning one. */
  attach?: boolean;
  download?: RuntimeDownloader;
  releaseRepo?: string;
  allowPathDiscovery?: boolean;
  clientName?: string;
  /** Override the least-privilege role. Escape hatch; not for normal use. */
  adeDefaultRole?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Interval for `providers.onChange` re-derivation while listeners exist. */
  providerPollIntervalMs?: number;
};

export type ThreadOpenOptions = {
  provider: AdeProvider;
  model: string;
  /**
   * MCP servers to attach to this thread.
   *
   * Refused outright by providers with no MCP surface (Pi), so a thread never
   * opens silently tool-less. Read {@link AdeThread.mcpCapability} afterwards
   * for what the provider actually delivered.
   *
   * Supplying servers also turns on strict mode unless you set
   * `loadUserMcpServers: true` — see that field.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Whether to also load the user's and project's own MCP configuration.
   *
   * Applies when you supply `mcpServers` or set this flag explicitly: either
   * makes the SDK send `strictMcpConfig` — `true` to withhold the user's
   * config, and an explicit `false` (not an omission) when you set this flag
   * true, because omitting the key is not the same as asking for the user's
   * servers.
   *
   * A thread that does neither sends no MCP field at all and lets the runtime's
   * session profile decide. The profile SDK threads run is strict by default,
   * so "sent nothing" means the user's own MCP config is withheld — pass
   * `loadUserMcpServers: true` if you want it loaded.
   *
   * IMPORTANT — false is NOT a uniform guarantee. Only Claude can enforce it.
   * Every other provider is best-effort because the gap is in the provider's
   * own SDK, not in ADE:
   *
   * | provider | strict mode | what still loads anyway                        |
   * |----------|-------------|------------------------------------------------|
   * | claude   | enforced    | nothing (MCP-wise)                             |
   * | codex    | best-effort | servers contributed by a Codex *plugin*        |
   * | cursor   | best-effort | user-layer servers                             |
   * | droid    | best-effort | tools appearing only after the first sweep     |
   * | opencode | best-effort | the global OpenCode config dir (for auth)      |
   * | pi       | unsupported | n/a — no MCP surface at all                    |
   *
   * That table is a summary of ADE's own `CALLER_MCP_SUPPORT` table in
   * `apps/desktop/src/shared/callerMcpServers.ts`, which is where each level,
   * mechanism and residual is decided; this doc comment restates it and must be
   * updated when a row there changes.
   *
   * Note that even for Claude, "enforced" scopes to MCP only: the user's
   * rules, commands, and output styles still load, because those are not MCP
   * and are not what strict mode excludes.
   *
   * Do not present this to your users as "only your tools are loaded" without
   * checking {@link AdeThread.mcpCapability}: it names the exact residual for
   * the thread you actually got, and it is authoritative where this table is
   * only a summary.
   *
   * The table above applies only when this is false. Setting it TRUE (or
   * supplying servers and opting back in) is a delivery-only request: the
   * user's own MCP config loads by design, the report comes back with
   * `strictRequested: false`, `residual` is null, and `mechanism` describes how
   * the servers were delivered rather than any enforcement. Nothing in that
   * report claims isolation, because none was asked for.
   */
  loadUserMcpServers?: boolean;
  permissions?: PermissionPreset;
  reasoningEffort?: string;
  title?: string;
};

/**
 * Options for reopening a key this home already knows.
 *
 * `provider` and `model` become optional because a durable thread already
 * recorded them — but they are still used if the runtime lost the session and
 * the thread has to be recreated, so a caller that has them should pass them.
 */
export type ThreadResumeOptions = Partial<ThreadOpenOptions>;

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
    status(): Promise<Record<string, ProviderStatus>>;
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

/**
 * Validates the runtime's MCP capability report before it reaches the public
 * API. An unrecognised `level` is dropped rather than widened: a caller
 * branching on "enforced" must never be handed a value the SDK cannot vouch for.
 */
function normalizeMcpCapability(value: unknown): McpCapabilityReport | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<McpCapabilityReport>;
  if (
    source.level !== "enforced" &&
    source.level !== "best-effort" &&
    source.level !== "unsupported"
  ) {
    return null;
  }
  const strictRequested = source.strictRequested === true;
  return {
    level: source.level,
    mechanism: typeof source.mechanism === "string" ? source.mechanism : "",
    // Null whenever strict mode was not requested: `residual` names what strict
    // mode could not exclude, and a delivery-only thread excluded nothing by
    // design. A runtime that volunteered one anyway would be describing an
    // isolation ADE was never asked to perform.
    residual: strictRequested && typeof source.residual === "string" ? source.residual : null,
    delivered: source.delivered === true,
    // Absent on a runtime that predates the field. False is the conservative
    // reading: it understates isolation rather than promising one nothing
    // verified.
    strictRequested,
  };
}

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_PROVIDER_POLL_MS = 30_000;
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
    source: DoctorReport["binary"]["source"];
    checksumVerified: boolean;
  } = { binaryPath: "", runtimeRoot: null, source: "option", checksumVerified: false };

  if (internal.attach) {
    // Attach mode never spawns: used by tests against a mock server and by
    // embedders that already manage the runtime's lifecycle.
    connection = await JsonRpcConnection.connect(socketPath);
  } else {
    const resolved = await resolveBinary({
      home,
      logger,
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      channel: options.channel ?? "latest",
      repo: internal.releaseRepo ?? DEFAULT_RELEASE_REPO,
      ...(internal.download ? { download: internal.download } : {}),
      ...(internal.allowPathDiscovery !== undefined
        ? { allowPathDiscovery: internal.allowPathDiscovery }
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

  let providerFingerprint = "";
  const providerListeners = new Set<(status: Record<string, ProviderStatus>) => void>();
  let providerTimer: ReturnType<typeof setTimeout> | null = null;
  const providerPollMs = internal.providerPollIntervalMs ?? DEFAULT_PROVIDER_POLL_MS;

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

  const publishProviderStatus = async (): Promise<Record<string, ProviderStatus>> => {
    const status = deriveProviderStatus(await readCatalog("cached"));
    const fingerprint = providerStatusFingerprint(status);
    if (fingerprint !== providerFingerprint) {
      providerFingerprint = fingerprint;
      for (const listener of [...providerListeners]) {
        try {
          listener(status);
        } catch {
          // A subscriber throwing must not stop the others.
        }
      }
    }
    return status;
  };

  const scheduleProviderPoll = (): void => {
    if (providerTimer || disposed || providerListeners.size === 0) return;
    providerTimer = setTimeout(() => {
      providerTimer = null;
      void publishProviderStatus().finally(() => scheduleProviderPoll());
    }, providerPollMs);
    providerTimer.unref?.();
  };

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
      const summary = await chats.getSummary(record.sessionId).catch((error) => {
        recordError("getSummary", error);
        return null;
      });
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
        const thread = new Thread(
          summary.sessionId,
          trimmedKey,
          resumedCapability,
          chats,
          events,
          assertUsable,
          persistThreadModel(trimmedKey),
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
    // Recreating a dangling key falls back to the record's own provider/model,
    // so a resume that has to rebuild still lands on the right agent.
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

    // Two distinct questions, and conflating them is a bug: "did the caller
    // supply servers" gates the drop warning, while "did the caller make any
    // MCP request at all" (servers OR strict mode) gates the capability
    // bookkeeping. A strict-only request supplies no servers but is still a
    // request, and it succeeds.
    const suppliedServers =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0;
    const askedForMcp = suppliedServers || opts.loadUserMcpServers !== undefined;

    if (suppliedServers && !mcpSupported && capabilities) {
      // Never silently drop MCP config: an app that asked for a tool server and
      // did not get one behaves wrongly rather than visibly failing.
      throw new AdeError(
        "invalid_option",
        "This ADE runtime does not support per-thread MCP servers (capabilities.personalChats.mcpServers is not set). Upgrade the runtime or drop `mcpServers`.",
      );
    }

    const created = await chats.create({
      provider,
      model,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...permissionArgs(provider, opts.permissions ?? "default"),
      // `suppliedServers`, NOT truthiness. `mcpServers: {}` is an empty object,
      // which is truthy — so a bare `opts.mcpServers` check made an empty map
      // send servers on the wire AND turn strict mode on, while every local
      // decision (the drop warning, `requestedMcp` on the durable record) read
      // it as "nothing supplied". A caller who passed `{}` got silent
      // strictness plus a stored record that would later discard the runtime's
      // own capability report.
      ...(suppliedServers ? { mcpServers: opts.mcpServers } : {}),
      // `strictMcpConfig` is the wire spelling of "do not load the user's own
      // MCP config", and it is a TRISTATE: absent lets the session profile
      // decide (strict, for the profile SDK threads run), true withholds, and
      // an explicit false overrides the profile to load it. So a caller that
      // asked for the user's servers must send `false` rather than omit the
      // key — omitting it would silently give them the opposite.
      //
      // Gated on the same `askedForMcp` the bookkeeping below uses: one
      // question, one answer, so the wire and the record can never disagree.
      ...(askedForMcp ? { strictMcpConfig: opts.loadUserMcpServers !== true } : {}),
    });
    if (!created?.sessionId) {
      throw new AdeError("protocol_error", "The ADE runtime created a chat with no session id.");
    }

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
    });
    const capability = normalizeMcpCapability(created.mcpCapability);
    // Scoped to requests the runtime actually reports on: supplied servers, or
    // an explicit strictness request. A bare `loadUserMcpServers: true` asks
    // for nothing to be withheld and nothing to be injected, so the runtime
    // emits no capability report BY DESIGN — warning there would cry wolf on
    // every correct delivery-only thread, and a warning that fires when nothing
    // is wrong stops being read when something is.
    const expectsCapabilityReport = suppliedServers || opts.loadUserMcpServers === false;
    if (expectsCapabilityReport && !capability) {
      // The caller asked and the runtime said nothing. Silence here would read
      // downstream as "no MCP was requested", which is the one wrong conclusion
      // available — so name it instead.
      logger(
        `ade sdk: thread "${trimmedKey}" requested MCP but the runtime reported no capability; treat the guarantee as unverified`,
      );
    }
    // Branch on `level`, never on `delivered`. `delivered` is false for a
    // provider with no MCP surface, and older runtimes ALSO returned false for
    // a strict-only request (strict mode, no servers) that had in fact been
    // enforced perfectly — so a client keyed on it reported a successful
    // isolation request as a failure. `level` is the field that actually
    // varies, and "unsupported" is the only value meaning nothing landed.
    //
    // Guarded on `suppliedServers` as well: with no servers to drop there is
    // nothing to warn about, whatever the runtime reports.
    if (suppliedServers && capability?.level === "unsupported") {
      logger(
        `ade sdk: thread "${trimmedKey}" opened WITHOUT the requested MCP servers (${capability.mechanism})`,
      );
    }
    // Independent of the above, not chained to it: a best-effort residual must
    // still surface on a thread whose servers did land.
    if (capability?.residual) {
      logger(`ade sdk: thread "${trimmedKey}" MCP strict mode is best-effort: ${capability.residual}`);
    }

    const thread = new Thread(
      created.sessionId,
      trimmedKey,
      capability,
      chats,
      events,
      assertUsable,
      persistThreadModel(trimmedKey),
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
      onChange: (cb) => {
        providerListeners.add(cb);
        // Seed the new listener with the current state, then start polling.
        void publishProviderStatus().catch(() => {});
        scheduleProviderPoll();
        return () => {
          providerListeners.delete(cb);
          if (providerListeners.size === 0 && providerTimer) {
            clearTimeout(providerTimer);
            providerTimer = null;
          }
        };
      },
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
      const [version, providerStatus, records] = await Promise.all([
        binary.binaryPath
          ? readBinaryVersion(binary.binaryPath, binary.runtimeRoot)
          : Promise.resolve(initialize.runtimeInfo?.version ?? null),
        publishProviderStatus().catch(() => ({}) as Record<string, ProviderStatus>),
        store.all(),
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
      const providersOk = Object.values(providerStatus).some((entry) => entry.available);
      return {
        ok: socketConnected && events.transport !== "unavailable" && providersOk,
        binary: {
          path: binary.binaryPath || "(attached)",
          version: version ?? null,
          source: binary.source,
          checksumVerified: binary.checksumVerified,
        },
        socket: {
          path: socketPath,
          connected: socketConnected,
          runtimeVersion: initialize.runtimeInfo?.version ?? null,
          pid: initialize.runtimeInfo?.pid ?? sidecar?.child.pid ?? null,
        },
        events: {
          mode: events.transport,
          epoch: events.currentEpoch,
          gapsRecovered: events.recoveredGapCount,
        },
        providers: providerStatus,
        threads: { tracked: records.length, live },
        recentErrors: [...recentErrors],
      } satisfies DoctorReport;
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
      if (providerTimer) clearTimeout(providerTimer);
      providerTimer = null;
      providerListeners.clear();
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
