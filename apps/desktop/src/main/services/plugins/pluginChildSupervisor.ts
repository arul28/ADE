import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Logger } from "../logging/logger";
import { terminateProcessTree } from "../shared/processExecution";
import { pluginHasRuntimeEntry, type PluginManifest } from "../../../shared/plugins/manifest";
import { emitPluginChange } from "./pluginEvents";
import {
  decodePluginFrame,
  encodePluginFrame,
  fromPluginStructuralError,
  PluginSdkError,
  PLUGIN_LOG_LINE_MAX_BYTES,
  PLUGIN_LOG_RING_CAPACITY,
  PLUGIN_SDK_VERSION,
  type PluginChildFrame,
  type PluginHostFrame,
  type PluginLogEntry,
  type PluginRuntimeStatus,
  type PluginSdkMethod,
} from "../../../shared/plugins/sdk";
import { PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS } from "../../../shared/plugins/sockets";

/**
 * Environment the plugin child must never see.
 *
 * Same idea as `sanitizeCursorSdkWorkerBaseEnv`: the child is untrusted code
 * running as the user, so every variable that would hand it a control channel
 * back into ADE (the runtime sockets), a credential, or a way to re-enter the
 * service installer is stripped. `ADE_RUNTIME_PARENT_PID` is deleted here and
 * re-added below with THIS process's pid, so the orphan check in the child
 * watches its actual parent rather than an inherited one.
 */
export const PLUGIN_CHILD_ENV_DENYLIST = [
  "ADE_HOME",
  "ADE_PACKAGE_CHANNEL",
  "ADE_RUNTIME_SOCKET_PATH",
  "ADE_RPC_SOCKET_PATH",
  "ADE_DESKTOP_BRIDGE_SOCKET_PATH",
  "ADE_RUNTIME_BUILD_HASH",
  "ADE_RUNTIME_PARENT_PID",
  "ADE_RUNTIME_IDLE_EXIT_MS",
  "ADE_CLI_ENTRY_PATH",
  "ADE_CLI_JS",
  "ADE_CLI_INSTALL_NAME",
  "ADE_DEFAULT_ROLE",
  "ADE_CHAT_SESSION_ID",
  "ADE_DESKTOP_APP_NAME",
  "ADE_AGENT_SKILLS_DIRS",
  "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION",
  "ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL",
  "ADE_PLUGIN_CHILD_BOOTSTRAP_PATH",
  "ELECTRON_RUN_AS_NODE",
] as const;

/** Grace the child gets to answer `shutdown` before its tree is killed. */
const PLUGIN_CHILD_DISPOSE_GRACE_MS = 3_000;

/** How long `start()` waits for the child's `ready` frame. */
export const PLUGIN_CHILD_READY_TIMEOUT_MS = 20_000;

/**
 * Default ceiling on one `invoke` round-trip.
 *
 * Re-exported from the socket taxonomy rather than spelled again here: the
 * renderer sizes its IPC budget from that same number, and two spellings would
 * let the channel expire before the child does — which replaces the typed
 * `plugin_timeout` with an opaque IPC error. A caller may name its own budget
 * per call; see `pluginSocketInvokeTimeoutMs`.
 */
const PLUGIN_CHILD_INVOKE_TIMEOUT_MS = PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS;

/** Bytes of stderr retained for crash messages. */
const PLUGIN_CHILD_STDERR_RING_BYTES = 4_000;

/** A single NDJSON line larger than this is a protocol failure, not a message. */
const PLUGIN_CHILD_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Backoff, ported from `windowsSupervisor.ts`: min(30s, 1s * 2^(n-1)). */
const PLUGIN_CHILD_INITIAL_RESTART_DELAY_MS = 1_000;
const PLUGIN_CHILD_MAX_RESTART_DELAY_MS = 30_000;

/** A child that stayed up this long is healthy; its restart count resets. */
const PLUGIN_CHILD_HEALTHY_RUNTIME_MS = 60_000;

/**
 * Consecutive fast failures before the host stops reviving a plugin.
 *
 * Backoff alone never gives up, so a plugin that crashes on startup respawns
 * every 30s forever — burning CPU, filling the log ring with the same trace,
 * and leaving the UI in a permanent "starting" flicker that never resolves into
 * something the user can act on. Five is enough to ride out a transient cause
 * (a file being rewritten by `ade plugin dev`, a port not yet free) and few
 * enough that a genuinely broken plugin settles into its dead state quickly.
 * "Fast" means the child died before {@link PLUGIN_CHILD_HEALTHY_RUNTIME_MS},
 * so a plugin that runs for a minute between crashes is never contained.
 */
export const PLUGIN_CHILD_MAX_FAST_FAILURES = 5;

export function pluginChildRestartDelayMs(restartCount: number): number {
  const exponent = Math.min(Math.max(restartCount - 1, 0), 20);
  return Math.min(PLUGIN_CHILD_MAX_RESTART_DELAY_MS, PLUGIN_CHILD_INITIAL_RESTART_DELAY_MS * 2 ** exponent);
}

export function sanitizePluginChildBaseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of PLUGIN_CHILD_ENV_DENYLIST) delete env[key];
  return env;
}

export type PluginChildSupervisor = {
  readonly pluginId: string;
  status(): PluginRuntimeStatus;
  restartCount(): number;
  lastCrashAt(): string | null;
  pid(): number | null;
  /** Resolves when the child sent `ready`. Rejects on spawn failure. */
  start(): Promise<void>;
  invoke(action: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  send(frame: PluginHostFrame): boolean;
  logs(): PluginLogEntry[];
  dispose(): Promise<void>;
};

const moduleDir = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function resolveChildBootstrapPath(): string {
  const configured = process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(moduleDir, "pluginChildBootstrap.cjs"),
    path.join(process.cwd(), "dist", "main", "pluginChildBootstrap.cjs"),
    path.join(process.cwd(), "dist", "pluginChildBootstrap.cjs"),
    path.join(process.cwd(), "apps", "desktop", "dist", "main", "pluginChildBootstrap.cjs"),
    path.join(process.cwd(), "apps", "ade-cli", "dist", "pluginChildBootstrap.cjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

type PendingInvoke = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createPluginChildSupervisor(args: {
  pluginId: string;
  pluginRoot: string;
  manifest: PluginManifest;
  logger: Logger;
  config: Record<string, string | number | boolean | null>;
  onSdkCall: (method: PluginSdkMethod, params: Record<string, unknown>) => Promise<unknown>;
  onLog?: (entry: PluginLogEntry) => void;
  /** Test seam: override timers so a crash/backoff test needs no real waiting. */
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): PluginChildSupervisor {
  const { pluginId, pluginRoot, manifest, logger } = args;
  const now = args.now ?? (() => Date.now());
  const setTimer = args.setTimeoutFn ?? setTimeout;
  const clearTimer = args.clearTimeoutFn ?? clearTimeout;
  const hasEntry = pluginHasRuntimeEntry(manifest);

  let child: ChildProcess | null = null;
  let status: PluginRuntimeStatus = hasEntry ? "idle" : "no-entry";
  /**
   * Every status transition goes through here so a subscriber cannot miss one:
   * the child's lifecycle is driven from six places (ready frame, exit, restart
   * timer, spawn, stop, dispose) and a bare assignment in any of them would be
   * a silently unreported state change.
   */
  const setStatus = (next: PluginRuntimeStatus): void => {
    if (status === next) return;
    status = next;
    emitPluginChange({ kind: "status", pluginId, status: next });
  };
  let restarts = 0;
  let fastFailures = 0;
  let crashedAt: string | null = null;
  let disposed = false;
  let stopping = false;
  let startedAtMs = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let startInFlight: Promise<void> | null = null;
  let stdoutBuffer = "";
  let stderrRing = "";
  const pending = new Map<string, PendingInvoke>();
  const logRing: PluginLogEntry[] = [];

  const appendLog = (entry: PluginLogEntry): void => {
    const message = entry.message.length > PLUGIN_LOG_LINE_MAX_BYTES
      ? `${entry.message.slice(0, PLUGIN_LOG_LINE_MAX_BYTES)}…`
      : entry.message;
    const trimmed: PluginLogEntry = { ...entry, message };
    logRing.push(trimmed);
    if (logRing.length > PLUGIN_LOG_RING_CAPACITY) logRing.splice(0, logRing.length - PLUGIN_LOG_RING_CAPACITY);
    args.onLog?.(trimmed);
  };

  const rememberStderr = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    stderrRing = `${stderrRing}\n${trimmed}`.trim().slice(-PLUGIN_CHILD_STDERR_RING_BYTES);
  };

  const summarizeStderr = (): string | null => {
    const lines = stderrRing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    return lines.slice(-3).join(" ");
  };

  const send = (frame: PluginHostFrame): boolean => {
    const target = child;
    // stdin exists ONLY as the RPC channel, and a write to a closed pipe is an
    // unhandled EPIPE that would take the host down with the plugin.
    if (!target || !target.stdin || !target.stdin.writable) return false;
    try {
      return target.stdin.write(encodePluginFrame(frame));
    } catch (error) {
      logger.warn("plugin.child_write_failed", {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const rejectPending = (error: Error): void => {
    for (const [, waiter] of pending) {
      if (waiter.timer) clearTimer(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  /**
   * Which spawn the pending ready timer belongs to.
   *
   * A crash-restart loop can have the previous child's ready timer still armed
   * while the NEXT child is in `starting`: without the generation check that
   * timer sees `status === "starting"`, decides the (healthy, just-spawned)
   * child timed out, and kills it. The counter makes a timer only ever able to
   * fail the spawn it was armed for.
   */
  let spawnGeneration = 0;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReadyTimer = (): void => {
    if (!readyTimer) return;
    clearTimer(readyTimer);
    readyTimer = null;
  };

  const settleReady = (error: Error | null): void => {
    // Every path out of `starting` runs through here — ready frame, exit,
    // spawn error, closed stdin — so this is the one place the timer has to be
    // dropped for it never to outlive its own spawn.
    clearReadyTimer();
    const resolve = readyResolve;
    const reject = readyReject;
    readyResolve = null;
    readyReject = null;
    if (error) reject?.(error);
    else resolve?.();
  };

  const handleFrame = (frame: PluginChildFrame): void => {
    switch (frame.type) {
      case "ready": {
        setStatus("running");
        startedAtMs = now();
        appendLog({ at: new Date(now()).toISOString(), level: "info", message: `Plugin ready (${frame.actions.length} actions).` });
        settleReady(null);
        return;
      }
      case "sdk": {
        void args.onSdkCall(frame.method, frame.params)
          .then((result) => send({ type: "sdkResult", requestId: frame.requestId, result }))
          .catch((error: unknown) => {
            const structural = error instanceof PluginSdkError
              ? { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) }
              : { code: "internal_error" as const, message: error instanceof Error ? error.message : String(error) };
            send({ type: "sdkResult", requestId: frame.requestId, error: structural });
          });
        return;
      }
      case "invokeResult": {
        const waiter = pending.get(frame.requestId);
        if (!waiter) return;
        pending.delete(frame.requestId);
        if (waiter.timer) clearTimer(waiter.timer);
        if (frame.error) waiter.reject(fromPluginStructuralError(frame.error));
        else waiter.resolve(frame.result);
        return;
      }
      case "log": {
        appendLog({
          at: new Date(now()).toISOString(),
          level: frame.level,
          message: frame.message,
          ...(frame.fields ? { fields: frame.fields } : {}),
        });
        return;
      }
      case "fatal": {
        appendLog({ at: new Date(now()).toISOString(), level: "error", message: frame.error.message });
        logger.warn("plugin.child_fatal", { pluginId, code: frame.error.code, message: frame.error.message });
        return;
      }
    }
  };

  const consumeStdout = (chunk: string): void => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > PLUGIN_CHILD_MAX_FRAME_BYTES) {
      stdoutBuffer = "";
      logger.warn("plugin.child_frame_oversized", { pluginId, limit: PLUGIN_CHILD_MAX_FRAME_BYTES });
      return;
    }
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = decodePluginFrame<PluginChildFrame>(line);
      if (!frame) continue;
      try {
        handleFrame(frame);
      } catch (error) {
        logger.warn("plugin.child_frame_handler_failed", {
          pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const isContained = (): boolean => fastFailures >= PLUGIN_CHILD_MAX_FAST_FAILURES;

  const scheduleRestart = (): void => {
    if (disposed) return;
    const delay = pluginChildRestartDelayMs(restarts);
    setStatus("restarting");
    logger.info("plugin.child_restart_scheduled", { pluginId, restartCount: restarts, delayMs: delay });
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (disposed) return;
      void start().catch((error: unknown) => {
        logger.warn("plugin.child_restart_failed", {
          pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delay);
    restartTimer.unref?.();
  };

  const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    child = null;
    stdoutBuffer = "";
    const lifetimeMs = startedAtMs > 0 ? now() - startedAtMs : 0;
    startedAtMs = 0;
    if (disposed || stopping) {
      setStatus("stopped");
      rejectPending(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" stopped.`));
      settleReady(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" stopped.`));
      return;
    }
    // A child that stayed up long enough to be considered healthy starts its
    // backoff over, so a plugin that crashes once a day never inherits
    // yesterday's 30-second delay.
    const healthy = lifetimeMs >= PLUGIN_CHILD_HEALTHY_RUNTIME_MS;
    restarts = healthy ? 0 : restarts + 1;
    fastFailures = healthy ? 0 : fastFailures + 1;
    crashedAt = new Date(now()).toISOString();
    setStatus("crashed");
    const detail = summarizeStderr();
    const exitStatus = code ?? signal ?? "unknown";
    const message = detail
      ? `Plugin "${pluginId}" exited (${exitStatus}). ${detail}`
      : `Plugin "${pluginId}" exited (${exitStatus}).`;
    logger.warn("plugin.child_exited", { pluginId, code, signal, restartCount: restarts, lifetimeMs });
    appendLog({ at: crashedAt, level: "error", message });
    rejectPending(new PluginSdkError("plugin_crashed", message, { exitCode: code, signal }));
    settleReady(new PluginSdkError("plugin_crashed", message, { exitCode: code, signal }));
    if (fastFailures >= PLUGIN_CHILD_MAX_FAST_FAILURES) {
      // Containment. The status stays `crashed` rather than moving on to
      // `restarting`, and that difference IS the contract: `restarting` means
      // the host is still trying, `crashed` means it has stopped and the user
      // has to act. The surfaces read exactly that to decide between a spinner
      // and the dead state with Restart / View logs.
      logger.warn("plugin.child_restart_contained", { pluginId, fastFailures, lifetimeMs });
      appendLog({
        at: crashedAt,
        level: "error",
        message: `Stopped restarting "${pluginId}" after ${fastFailures} failures in a row. Restart it to try again.`,
      });
      return;
    }
    scheduleRestart();
  };

  const spawnChild = (): Promise<void> => new Promise<void>((resolve, reject) => {
    const generation = (spawnGeneration += 1);
    const bootstrapPath = resolveChildBootstrapPath();
    const env: NodeJS.ProcessEnv = {
      ...sanitizePluginChildBaseEnv(process.env),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ADE_PLUGIN_ID: pluginId,
      ADE_PLUGIN_ROOT: pluginRoot,
      ADE_RUNTIME_PARENT_PID: String(process.pid),
    };
    let spawned: ChildProcess;
    try {
      // `spawn`, not `fork`: fork insists on an IPC channel, and D12 puts the
      // whole protocol on stdio NDJSON so stdin has exactly one purpose.
      spawned = spawn(process.execPath, [bootstrapPath], {
        cwd: pluginRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      setStatus("crashed");
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    child = spawned;
    setStatus("starting");
    stderrRing = "";
    stdoutBuffer = "";
    readyResolve = resolve;
    readyReject = reject;

    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => consumeStdout(chunk));
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (chunk: string) => {
      rememberStderr(chunk);
      logger.debug("plugin.child_stderr", { pluginId, text: chunk.trim().slice(0, 500) });
    });
    spawned.stdin?.on("error", (error: Error) => {
      logger.debug("plugin.child_stdin_error", { pluginId, error: error.message });
    });
    spawned.once("error", (error: Error) => {
      logger.warn("plugin.child_process_error", { pluginId, error: error.message });
      // A process that never spawned emits `error` and no `exit`, so the state
      // handleExit would have written has to be written here instead.
      if (spawned.pid == null) {
        child = null;
        setStatus("crashed");
        crashedAt = new Date(now()).toISOString();
      }
      settleReady(error);
    });
    spawned.once("exit", (code, signal) => handleExit(code, signal));

    clearReadyTimer();
    readyTimer = setTimer(() => {
      readyTimer = null;
      if (generation !== spawnGeneration || status !== "starting") return;
      settleReady(new PluginSdkError("plugin_timeout", `Plugin "${pluginId}" did not become ready in time.`));
      stopChild();
    }, PLUGIN_CHILD_READY_TIMEOUT_MS);
    readyTimer.unref?.();

    const helloSent = send({
      type: "hello",
      sdkVersion: PLUGIN_SDK_VERSION,
      pluginId,
      pluginRoot,
      manifest,
      config: args.config,
    });
    if (!helloSent) {
      settleReady(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" closed its input channel before starting.`));
    }
  });

  const stopChild = (): void => {
    const target = child;
    if (!target) return;
    stopping = true;
    const escalate = (): void => {
      if (target.exitCode != null || target.killed) return;
      terminateProcessTree(target);
    };
    if (!send({ type: "shutdown" })) {
      escalate();
      return;
    }
    const graceTimer = setTimer(escalate, PLUGIN_CHILD_DISPOSE_GRACE_MS);
    graceTimer.unref?.();
  };

  const start = (): Promise<void> => {
    if (!hasEntry) {
      return Promise.reject(new PluginSdkError("plugin_no_entry", `Plugin "${pluginId}" ships no runtime entry.`));
    }
    if (disposed) {
      return Promise.reject(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" is no longer running.`));
    }
    // A contained plugin is revived by replacing the supervisor (the host drops
    // and rebuilds it on restart/enable/disable), never by another `invoke`.
    // Auto-reviving here would make the fifth failure meaningless: the next
    // call would start the crash loop over with no user ever seeing it.
    if (isContained()) {
      return Promise.reject(new PluginSdkError(
        "plugin_crashed",
        `Plugin "${pluginId}" stopped after ${fastFailures} failures in a row. Restart it to try again.`,
        { fastFailures },
      ));
    }
    if (child && status === "running") return Promise.resolve();
    // Single-flight, the `withSocketSpawnLock` analogue reduced to what this
    // problem actually needs. There is no cross-process resource to arbitrate —
    // a plugin child is owned by one host and reached over its own stdio — so
    // the only race is two concurrent `invoke`s here both deciding to spawn,
    // and one promise per supervisor closes it. Deliberately NOT a module-level
    // map keyed by plugin id: `reload` disposes a supervisor and builds a new
    // one for the same id, and a shared map would hand the new supervisor the
    // dead one's in-flight promise, resolving `start()` with no child running.
    if (startInFlight) return startInFlight;
    stopping = false;
    startInFlight = spawnChild().finally(() => {
      startInFlight = null;
    });
    return startInFlight;
  };

  return {
    pluginId,
    status: () => status,
    restartCount: () => restarts,
    lastCrashAt: () => crashedAt,
    pid: () => child?.pid ?? null,
    start,
    async invoke(action, invokeArgs, options) {
      if (!hasEntry) throw new PluginSdkError("plugin_no_entry", `Plugin "${pluginId}" ships no runtime entry.`);
      if (disposed) throw new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" is no longer running.`);
      await start();
      const requestId = randomUUID();
      return await new Promise<unknown>((resolve, reject) => {
        const timeoutMs = Math.max(1_000, options?.timeoutMs ?? PLUGIN_CHILD_INVOKE_TIMEOUT_MS);
        const timer = setTimer(() => {
          if (!pending.delete(requestId)) return;
          reject(new PluginSdkError("plugin_timeout", `Plugin "${pluginId}" action "${action}" timed out.`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer });
        if (!send({ type: "invoke", requestId, action, args: invokeArgs })) {
          pending.delete(requestId);
          clearTimer(timer);
          reject(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" is not accepting requests.`));
        }
      });
    },
    send,
    logs: () => [...logRing],
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (restartTimer) {
        clearTimer(restartTimer);
        restartTimer = null;
      }
      clearReadyTimer();
      const target = child;
      if (!target) {
        setStatus("stopped");
        rejectPending(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" stopped.`));
        return;
      }
      const exited = new Promise<void>((resolve) => {
        if (target.exitCode != null) {
          resolve();
          return;
        }
        target.once("exit", () => resolve());
      });
      stopChild();
      await exited;
      setStatus("stopped");
      rejectPending(new PluginSdkError("plugin_crashed", `Plugin "${pluginId}" stopped.`));
    },
  };
}
