import type { ChildProcess } from "node:child_process";
import { resolveBinary } from "./binary.js";
import { resolveBundledRuntime } from "./bundledRuntime.js";
import type { AdeClientEvent, AdeClientEventMap } from "./clientEvents.js";
import type { CreateAdeChatOptions, InternalAdeChatOptions } from "./clientOptions.js";
import { checkRuntimeCompatibility, SUPPORTED_RUNTIME_RANGE } from "./compatibility.js";
import { DEFAULT_RELEASE_REPO } from "./download.js";
import { AdeError, errorMessage } from "./errors.js";
import { ChatEventStream, type ChatEventHub } from "./eventStream.js";
import { JsonRpcConnection } from "./jsonRpc.js";
import { reclaimStaleRuntime, runtimePidfilePath } from "./runtimePidfile.js";
import { DEFAULT_ADE_ROLE, startSidecar, type Sidecar } from "./sidecar.js";
import type { DoctorReport, RuntimeCompatibility } from "./types.js";
import type { AdeInitializeResult } from "./wireTypes.js";

/**
 * The runtime a client owns: finding it, starting (or reaching) it, the
 * handshake, the event stream, and — with `autoRestart` — bringing it back.
 *
 * Owns every value that changes when the runtime is replaced: the connection,
 * the spawned sidecar, the `initialize` answer, the compatibility verdict, the
 * event stream and the connection generation. Everything else reads them
 * through this object at call time, so an `autoRestart` moves the whole client
 * without handing anyone a new reference. Threads are not its business: after
 * a restart it calls `onRebound`, and the client re-binds them.
 */

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_RESTART_ATTEMPTS = 5;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;

/** The runtime binary a client runs, as `doctor()` reports it. */
export type RuntimeBinary = {
  binaryPath: string;
  runtimeRoot: string | null;
  nodeModulesPath: string | null;
  source: DoctorReport["runtime"]["source"];
  checksumVerified: boolean;
};

/** `autoRestart`, resolved. */
export type RestartPolicy = { maxAttempts: number; backoffMs: number };

/** Resolve `createAdeChat({ autoRestart })` to a policy, or null when off. */
export function readRestartPolicy(autoRestart: CreateAdeChatOptions["autoRestart"]): RestartPolicy | null {
  if (!autoRestart) return null;
  const custom = typeof autoRestart === "object" ? autoRestart : {};
  return {
    maxAttempts:
      custom.maxAttempts !== undefined ? Math.max(1, Math.floor(custom.maxAttempts)) : DEFAULT_RESTART_ATTEMPTS,
    backoffMs: custom.backoffMs !== undefined ? Math.max(0, custom.backoffMs) : DEFAULT_RESTART_BACKOFF_MS,
  };
}

/**
 * Find the runtime binary the options ask for. Attach mode spawns nothing,
 * so it has no binary and reports `source: "attached"`.
 */
export async function resolveRuntimeBinary(
  options: CreateAdeChatOptions | InternalAdeChatOptions,
  home: string,
  logger: (line: string) => void,
): Promise<RuntimeBinary> {
  const internal = options as InternalAdeChatOptions;
  if (internal.attach) {
    return { binaryPath: "", runtimeRoot: null, nodeModulesPath: null, source: "attached", checksumVerified: false };
  }
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
    ...(internal.allowPathDiscovery !== undefined ? { allowPathDiscovery: internal.allowPathDiscovery } : {}),
    ...(internal.resolveBundledFrom
      ? {
          resolveBundled: (bundleOptions: { platform: NodeJS.Platform; arch: string }) =>
            resolveBundledRuntime({ ...bundleOptions, resolveFrom: internal.resolveBundledFrom as string }),
        }
      : {}),
  });
  return {
    ...resolved,
    // `resolvePackagedRuntime()` returns `source: "packaged"` beside the
    // paths it resolved, so a host that spreads it in is reported as running
    // the copy inside its own bundle rather than an anonymous pinned path.
    ...(resolved.source === "explicit" && options.source === "packaged" ? { source: "packaged" as const } : {}),
  };
}

export type RuntimeSupervisorDeps = {
  options: CreateAdeChatOptions | InternalAdeChatOptions;
  home: string;
  socketPath: string;
  binary: RuntimeBinary;
  restartPolicy: RestartPolicy | null;
  /** Every connection's event stream feeds this one hub. */
  hub: ChatEventHub;
  logger: (line: string) => void;
  recordError: (scope: string, error: unknown) => void;
  emitClient: <E extends AdeClientEvent>(event: E, payload: AdeClientEventMap[E]) => void;
  isDisposed: () => boolean;
  /** The runtime went away. Called once per connection, before any restart. */
  onLost: (message: string) => void;
  /** A restart reconnected; re-bind whatever was bound to the old runtime. */
  onRebound: () => Promise<void>;
};

type Bound = { connection: JsonRpcConnection; sidecar: Sidecar | null };
type Handshake = { initialize: AdeInitializeResult; compatibility: RuntimeCompatibility };

/** A child that has neither exited nor been killed by a signal. */
function childAlive(child: ChildProcess | undefined): boolean {
  return Boolean(child) && child?.exitCode === null && child?.signalCode === null;
}

export class RuntimeSupervisor {
  // Set by `start()` before the instance is handed out.
  private bound!: Bound;
  private handshaken!: Handshake;
  private stream!: ChatEventStream;
  /** Bumped per connection, so a late signal from a replaced runtime is ignored. */
  private generation = 0;
  private lostGeneration = -1;
  private restarting: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly deps: RuntimeSupervisorDeps) {}

  /** Boot, handshake, start the event stream and watch for loss. */
  static async start(deps: RuntimeSupervisorDeps): Promise<RuntimeSupervisor> {
    const supervisor = new RuntimeSupervisor(deps);
    supervisor.bound = await supervisor.boot();
    supervisor.handshaken = await supervisor.handshake(supervisor.bound);
    const capabilities = supervisor.capabilities();
    if (capabilities && Array.isArray(capabilities.actions) && capabilities.actions.length === 0) {
      deps.logger("ade sdk: the runtime reports no personal chat actions; calls will fail");
    }
    supervisor.stream = await supervisor.startEvents();
    supervisor.watch();
    return supervisor;
  }

  get connection(): JsonRpcConnection {
    return this.bound.connection;
  }

  get sidecar(): Sidecar | null {
    return this.bound.sidecar;
  }

  get initialize(): AdeInitializeResult {
    return this.handshaken.initialize;
  }

  get compatibility(): RuntimeCompatibility {
    return this.handshaken.compatibility;
  }

  get events(): ChatEventStream {
    return this.stream;
  }

  /**
   * The runtime's personal-chat capabilities, read at call time: an
   * `autoRestart` may land on a runtime that answers the handshake differently
   * (a newer binary on PATH, a reused process), and every flag must follow the
   * runtime actually connected.
   */
  capabilities() {
    return this.handshaken.initialize.capabilities?.personalChats ?? null;
  }

  /** Whether the runtime lists `action` (false when it sends no list). */
  actionListed(action: string): boolean {
    const actions = this.capabilities()?.actions;
    return Array.isArray(actions) && actions.includes(action);
  }

  /**
   * Whether an action is available, for the actions this SDK added after the
   * list was first published. A runtime that sends no list at all is trusted,
   * the same way every older action always has been.
   */
  actionAvailable(action: string): boolean {
    const actions = this.capabilities()?.actions;
    return !Array.isArray(actions) || actions.includes(action);
  }

  /** Stop the restart clock, the event stream, the socket and the child. */
  async dispose(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.stream.dispose();
    this.bound.connection.close();
    await this.bound.sidecar?.stop();
  }

  /**
   * Start (or reach) a runtime and return its connection.
   *
   * Called once at create and again by every `autoRestart` attempt, so the
   * reclaim rule below applies to a respawn exactly as it does to a first
   * start.
   */
  private async boot(): Promise<Bound> {
    const { options, home, socketPath, binary, logger } = this.deps;
    const internal = options as InternalAdeChatOptions;
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
      adeDefaultRole: internal.adeDefaultRole ?? DEFAULT_ADE_ROLE,
    });
    return { connection: started.connection, sidecar: started };
  }

  /**
   * `ade/initialize` + `ade/initialized`, then the compatibility verdict.
   *
   * Closes what `boot` opened on any failure, so a refused or broken runtime
   * never outlives the call that found it.
   */
  private async handshake(bound: Bound): Promise<Handshake> {
    const { options, logger } = this.deps;
    const internal = options as InternalAdeChatOptions;
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
          identity: { role: internal.adeDefaultRole ?? DEFAULT_ADE_ROLE, callerId: `ade-sdk:${process.pid}` },
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
  }

  private async startEvents(): Promise<ChatEventStream> {
    const internal = this.deps.options as InternalAdeChatOptions;
    const stream = new ChatEventStream({
      connection: this.bound.connection,
      pushSupported: this.capabilities()?.pushEvents === true,
      logger: this.deps.logger,
      ...(internal.pollIntervalMs ? { pollIntervalMs: internal.pollIntervalMs } : {}),
      onError: this.deps.recordError,
    });
    stream.onEvent((envelope) => this.deps.hub.emit(envelope));
    await stream.start();
    return stream;
  }

  /**
   * The runtime is gone. Runs once per connection, whichever signal came first.
   *
   * Tells the client (which tells every live thread), then restarts when the
   * host opted in.
   */
  private lost(gen: number, message: string): void {
    if (this.deps.isDisposed() || gen !== this.generation || this.lostGeneration === gen) return;
    this.lostGeneration = gen;
    this.deps.onLost(message);
    const policy = this.deps.restartPolicy;
    if (policy && !this.restarting) {
      this.restarting = this.restart(policy).finally(() => {
        this.restarting = null;
      });
    }
  }

  private watch(): void {
    const gen = ++this.generation;
    const { recordError, emitClient, isDisposed } = this.deps;
    this.bound.connection.onClose((error) => {
      if (isDisposed() || gen !== this.generation) return;
      recordError("transport", error);
      emitClient("transport", { state: "closed", error: errorMessage(error) });
      this.lost(gen, `The connection to the ADE runtime closed: ${errorMessage(error)}`);
    });
    const child = this.bound.sidecar?.child;
    if (!child) return;
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderr.push(line);
        if (stderr.length > 20) stderr.shift();
      }
    });
    child.once("exit", (code, signal) => {
      if (isDisposed() || gen !== this.generation) return;
      const tail = stderr.length > 0 ? stderr.join("\n") : null;
      recordError("runtime", `exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
      emitClient("exit", { code, signal: signal ?? null, error: tail });
      this.lost(
        gen,
        `The ADE runtime exited (code ${code ?? "null"}, signal ${signal ?? "null"}); the turn in flight, if any, ended.`,
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        resolve();
      }, ms);
      this.restartTimer.unref?.();
    });
  }

  private async restart(policy: RestartPolicy): Promise<void> {
    const { logger, recordError, emitClient, isDisposed } = this.deps;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await this.sleep(policy.backoffMs * 2 ** (attempt - 1));
      if (isDisposed()) return;
      try {
        const bound = await this.boot();
        const next = await this.handshake(bound);
        if (isDisposed()) {
          bound.connection.close();
          await bound.sidecar?.stop();
          return;
        }
        // A `reused` boot hands back no sidecar: it reached a runtime that was
        // already answering. When that is the child THIS client spawned (only
        // the socket dropped), keep its handle, or `dispose()` would leave it
        // running with nobody to stop it.
        const previous = this.bound.sidecar;
        const sidecar = bound.sidecar ?? (previous && childAlive(previous.child) ? previous : null);
        const previousEvents = this.stream;
        this.bound = { connection: bound.connection, sidecar };
        this.handshaken = next;
        await previousEvents.dispose();
        this.stream = await this.startEvents();
        this.watch();
        await this.deps.onRebound();
        logger(`ade sdk: runtime restarted (attempt ${attempt})`);
        emitClient("restart", { attempt, ok: true, error: null, final: true });
        emitClient("transport", { state: "reconnected", error: null });
        return;
      } catch (error) {
        recordError(`restart attempt ${attempt}`, error);
        emitClient("restart", {
          attempt,
          ok: false,
          error: errorMessage(error),
          final: attempt >= policy.maxAttempts,
        });
      }
    }
    logger(`ade sdk: gave up restarting the runtime after ${policy.maxAttempts} attempts`);
  }
}
