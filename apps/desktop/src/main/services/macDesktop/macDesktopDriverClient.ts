/**
 * The NDJSON client for `ade-desktop-driver`.
 *
 * One JSON object per line over the helper's stdin/stdout:
 *
 *   request `{"id":"7","op":"display.create", …}`
 *   reply   `{"id":"7","ok":true,"result":{…}}` / `{"id":"7","ok":false,"error":{…}}`
 *   event   `{"event":"windows-changed", …}`
 *
 * Restart-with-backoff and the health shape are modelled on
 * `AttentionNotchHelper`, deliberately: the two helpers fail the same ways
 * (missing binary, permission refusal, a build that does not speak this
 * protocol), and the settings surfaces already know how to render that health.
 *
 * Everything the service can ask for is named once, in {@link MAC_DESKTOP_DRIVER_OPS}.
 * The op names are the dotted spelling the feature doc and the CLI use, and the
 * helper accepts only that spelling — the camelCase names its Swift enum was
 * born with are gone from both sides.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

import type { Logger } from "../logging/logger";
import {
  MAC_DESKTOP_MACOS_ONLY_MESSAGE,
  type MacDesktopDriverHealth,
} from "../../../shared/types/macDesktop";

/**
 * Every op name the service is allowed to send.
 *
 * One table, because the helper's own table lives in another language in
 * another process: a typo here is otherwise an `unknown_op` at runtime, and the
 * only way to reconcile the two lists is to have exactly one of them per side.
 *
 * Exactly the ops something calls. An op named here and called nowhere is a
 * capability the helper has to keep answering for no reader, and the two sides
 * can only be reconciled against each other if this list is the true one.
 */
export const MAC_DESKTOP_DRIVER_OPS = {
  health: "ping",
  createDisplay: "display.create",
  destroyDisplay: "display.destroy",
  reconcileDisplays: "display.reconcile",
  watchPermissions: "watch-permissions",
  requestPermission: "request-permission",
  listWindows: "window.list",
  parkWindow: "window.park",
  unparkWindow: "window.unpark",
  launch: "app.launch",
  present: "present",
  observe: "observe",
  input: "input",
  setLease: "lease.set",
  clearLease: "lease.clear",
  screenshot: "capture.screenshot",
  startStream: "stream.start",
  setStreamRate: "stream.setRate",
  setStreamCursorVisible: "stream.setCursorVisible",
  stopStream: "stream.stop",
  startRecording: "record.start",
  stopRecording: "record.stop",
} as const;

/**
 * The driver's "not while the mouse button is down" refusal code.
 *
 * Named here beside the op table because it is the other half of the same
 * cross-process contract: the one driver failure the Node side retries instead
 * of surfacing, matched on code rather than on message.
 */
export const MAC_DESKTOP_GESTURE_IN_FLIGHT_CODE = "gesture_in_flight" as const;

export type MacDesktopDriverOp = (typeof MAC_DESKTOP_DRIVER_OPS)[keyof typeof MAC_DESKTOP_DRIVER_OPS];

/** Restarts inside the unstable window before the helper is declared dead. */
const MAX_RESTART_ATTEMPTS = 4;
/** A helper that lives this long is considered healthy again. */
const STABLE_AFTER_MS = 30_000;
const BASE_RESTART_DELAY_MS = 400;
const MAX_RESTART_DELAY_MS = 10_000;
/** A reply that never arrives must not wedge the caller's promise forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** A single NDJSON line longer than this is a protocol fault, not a message. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
/**
 * How long a restart waits for the old helper to exit on SIGTERM before it
 * kills it outright.
 *
 * The helper handles SIGTERM on its main thread, and a main thread stuck in a
 * framework call does not get to it. Going ahead without the kill started a
 * second helper while the first still held every lane's virtual display.
 */
const RESTART_TERM_GRACE_MS = 2_000;
/** And how long after the SIGKILL before the restart proceeds regardless. */
const RESTART_KILL_GRACE_MS = 1_000;
/** One stderr line longer than this is cut before it reaches the log. */
const MAX_STDERR_LINE_CHARS = 2_000;

export class MacDesktopDriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    // See `MacDesktopError`: the code prefix is what reaches the CLI's hints.
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "MacDesktopDriverError";
    this.code = code;
  }
}

export type MacDesktopDriverEvent = { event: string } & Record<string, unknown>;

export type MacDesktopDriverClientDeps = {
  /**
   * Where the helper binary is. Null means "this host cannot have one" — off
   * darwin, or in a build that shipped without the native resources.
   */
  resolveExecutablePath: () => string | null;
  logger: Logger;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  /** Test seam. Defaults to `child_process.spawn`. */
  spawnProcess?: typeof spawn;
  /** Fired whenever the health shape changes, so the service can re-publish. */
  onHealthChanged?: (health: MacDesktopDriverHealth) => void;
  /**
   * Fired when a running helper dies. Every lane's display died with it, and
   * only the service knows what to tell those lanes.
   */
  onDriverLost?: (reason: string) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  op: string;
};

export function createMacDesktopDriverClient(deps: MacDesktopDriverClientDeps) {
  const platform = deps.platform ?? process.platform;
  const spawnProcess = deps.spawnProcess ?? spawn;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams | null = null;
  let childReady = false;
  let disposed = false;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextRequestId = 0;
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let startPromise: Promise<void> | null = null;
  let lastProtocolError: string | null = null;
  let version: string | null = null;
  let lastHealth: MacDesktopDriverHealth | null = null;

  const pending = new Map<string, PendingRequest>();
  const listeners = new Set<(event: MacDesktopDriverEvent) => void>();

  const executablePath = (): string | null => {
    try {
      return deps.resolveExecutablePath();
    } catch {
      return null;
    }
  };

  const buildHealth = (): MacDesktopDriverHealth => {
    if (platform !== "darwin") {
      return {
        state: "unsupported",
        title: "Mac Desktop needs macOS",
        message: MAC_DESKTOP_MACOS_ONLY_MESSAGE,
        recovery: null,
        version: null,
      };
    }
    const binary = executablePath();
    if (!binary || !fs.existsSync(binary)) {
      return {
        state: "missing",
        title: "Mac Desktop needs reinstalling",
        message: "The native desktop driver is missing from this ADE installation. Reinstall or update ADE, then restart it.",
        recovery: "reinstall_or_update",
        version: null,
      };
    }
    if (lastProtocolError) {
      return {
        state: "protocol_error",
        title: "Mac Desktop needs an update",
        message: "The native desktop driver is incompatible with this ADE build. Update ADE, then restart it.",
        recovery: "reinstall_or_update",
        version,
      };
    }
    if (child && childReady) {
      return {
        state: "running",
        title: "Mac Desktop is ready",
        message: "The native desktop driver is running.",
        recovery: null,
        version,
      };
    }
    if (!child && restartAttempts >= MAX_RESTART_ATTEMPTS && !restartTimer) {
      return {
        state: "crash_loop",
        title: "Mac Desktop stopped",
        message: "The native desktop driver repeatedly exited. Restart ADE; if it happens again, reinstall or update the app.",
        recovery: "reinstall_or_update",
        version,
      };
    }
    return {
      state: "starting",
      title: "Mac Desktop is starting",
      message: "ADE is preparing the native desktop driver.",
      recovery: "retry",
      version,
    };
  };

  const publishHealth = (): MacDesktopDriverHealth => {
    const health = buildHealth();
    const changed = !lastHealth
      || lastHealth.state !== health.state
      || lastHealth.version !== health.version
      || lastHealth.message !== health.message;
    lastHealth = health;
    if (changed) deps.onHealthChanged?.(health);
    return health;
  };

  const settlePending = (error: Error): void => {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  const emit = (event: MacDesktopDriverEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        deps.logger.debug("mac_desktop.driver_event_listener_failed", {
          event: event.event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.length) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      lastProtocolError = "The desktop driver wrote a line that is not JSON.";
      deps.logger.warn("mac_desktop.driver_protocol_error", { sample: trimmed.slice(0, 200) });
      publishHealth();
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) {
      const eventName = typeof record.event === "string" ? record.event : null;
      if (!eventName) return;
      if (eventName === "protocol_error") {
        lastProtocolError = typeof record.message === "string" ? record.message : "protocol error";
        publishHealth();
        return;
      }
      emit({ ...record, event: eventName });
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (record.ok === true) {
      entry.resolve(record.result ?? {});
      return;
    }
    const error = (record.error ?? {}) as Record<string, unknown>;
    const code = typeof error.code === "string" ? error.code : "MAC_DESKTOP_DRIVER_UNAVAILABLE";
    const message = typeof error.message === "string" && error.message.length
      ? error.message
      : `The desktop driver refused ${entry.op}.`;
    entry.reject(new MacDesktopDriverError(code, message));
  };

  const consumeStdout = (chunk: string): void => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > MAX_LINE_BYTES && !stdoutBuffer.includes("\n")) {
      // A line this long with no terminator is not a message this build will
      // ever parse; keeping it only grows the buffer until the process dies.
      stdoutBuffer = "";
      lastProtocolError = "The desktop driver wrote an oversized line.";
      publishHealth();
      return;
    }
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      consumeLine(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  };

  /**
   * The helper's stderr, one log line per line it wrote.
   *
   * At `info`, not `debug`: the default level drops `debug`, and the helper's
   * stderr is the only record of what it saw — a watchdog answering for a
   * stuck request, an app that stopped answering accessibility, a display the
   * window server ended. Everything it writes there is a lane id, an app name,
   * a window id or a framework error; nothing a user typed.
   */
  const consumeStderr = (chunk: string): void => {
    stderrBuffer += chunk;
    let newlineIndex = stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex).trim();
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      if (line.length) {
        deps.logger.info("mac_desktop.driver_stderr", { message: line.slice(0, MAX_STDERR_LINE_CHARS) });
      }
      newlineIndex = stderrBuffer.indexOf("\n");
    }
    // A partial line this long is not going to end; log what there is.
    if (stderrBuffer.length > MAX_STDERR_LINE_CHARS) {
      deps.logger.info("mac_desktop.driver_stderr", { message: stderrBuffer.slice(0, MAX_STDERR_LINE_CHARS) });
      stderrBuffer = "";
    }
  };

  const scheduleRestart = (): void => {
    if (disposed || restartTimer) return;
    restartAttempts += 1;
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      deps.logger.error("mac_desktop.driver_crash_loop", { attempts: restartAttempts - 1 });
      publishHealth();
      return;
    }
    const delay = Math.min(MAX_RESTART_DELAY_MS, BASE_RESTART_DELAY_MS * 2 ** (restartAttempts - 1));
    deps.logger.info("mac_desktop.driver_restart_scheduled", { attempt: restartAttempts, delayMs: delay });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed) return;
      void start().catch(() => {
        // `start` already recorded the failure in health.
      });
    }, delay);
    restartTimer.unref?.();
    publishHealth();
  };

  const start = (): Promise<void> => {
    if (disposed) return Promise.reject(new MacDesktopDriverError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The desktop driver client is disposed."));
    if (child && childReady) return Promise.resolve();
    if (startPromise) return startPromise;
    // A handle that never reached `spawn` — or whose `close` was attributed to
    // a newer one — would otherwise sit here forever: `isRunning()` stays
    // false, health stays "starting", and every request answers "the desktop
    // driver is not running" with nothing behind it that will ever recover.
    // Drop the stale child so this attempt spawns a real one.
    if (child) {
      const stale = child;
      child = null;
      childReady = false;
      try {
        stale.kill("SIGKILL");
      } catch {
        // Already gone; the handle was the only thing left of it.
      }
    }

    const attempt = new Promise<void>((resolve, reject) => {
      if (platform !== "darwin") {
        reject(new MacDesktopDriverError("MAC_DESKTOP_UNSUPPORTED_PLATFORM", MAC_DESKTOP_MACOS_ONLY_MESSAGE));
        return;
      }
      const binary = executablePath();
      if (!binary || !fs.existsSync(binary)) {
        publishHealth();
        reject(new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          "The native desktop driver is missing from this ADE installation.",
        ));
        return;
      }
      let spawned: ChildProcessWithoutNullStreams;
      try {
        spawned = spawnProcess(binary, [], {
          env: { ...process.env, LC_ALL: "en_US.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        scheduleRestart();
        reject(new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }
      child = spawned;
      childReady = false;
      stdoutBuffer = "";
      stderrBuffer = "";
      spawned.stdout.setEncoding("utf8");
      spawned.stderr.setEncoding("utf8");
      spawned.stdout.on("data", (chunk: string) => consumeStdout(chunk));
      spawned.stderr.on("data", (chunk: string) => consumeStderr(chunk));
      spawned.stdin.on("error", (error: Error) => {
        if (!disposed) deps.logger.debug("mac_desktop.driver_stdin_error", { error: error.message });
      });
      spawned.once("error", (error: Error) => {
        deps.logger.warn("mac_desktop.driver_error", { error: error.message });
        // A spawn that fails outright (ENOENT, EACCES, ETXTBSY while the binary
        // is being replaced) emits `error`, and only logging it left `child`
        // pointing at a handle that never starts and never closes: health stayed
        // "starting" forever and every request answered "the desktop driver is
        // not running" with no restart behind it. Treat it as the exit it is.
        if (child !== spawned) return;
        child = null;
        childReady = false;
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
        const failure = new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          `The desktop driver could not start (${error.message}).`,
        );
        settlePending(failure);
        scheduleRestart();
        publishHealth();
        reject(failure);
      });
      spawned.once("spawn", () => {
        if (child !== spawned) return;
        childReady = true;
        lastProtocolError = null;
        deps.logger.info("mac_desktop.driver_started", { pid: spawned.pid ?? null });
        stableTimer = setTimeout(() => {
          stableTimer = null;
          restartAttempts = 0;
          publishHealth();
        }, STABLE_AFTER_MS);
        stableTimer.unref?.();
        publishHealth();
        resolve();
      });
      spawned.once("close", (code: number | null, signal: string | null) => {
        if (child !== spawned) return;
        const wasReady = childReady;
        child = null;
        childReady = false;
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        // Unasked-for, this took every lane's display with it: a warning.
        deps.logger[disposed ? "info" : "warn"]("mac_desktop.driver_exited", {
          code,
          signal,
          disposed,
          pid: spawned.pid ?? null,
          pendingRequests: pending.size,
        });
        settlePending(new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          `The desktop driver stopped (${detail}).`,
        ));
        if (disposed) return;
        if (wasReady) deps.onDriverLost?.(detail);
        scheduleRestart();
        publishHealth();
        reject(new MacDesktopDriverError("MAC_DESKTOP_DRIVER_UNAVAILABLE", `The desktop driver stopped (${detail}).`));
      });
    });

    // `startPromise` holds the DERIVED promise, so the guard has to compare
    // against that one. Comparing against `attempt` was never true, which left
    // `startPromise` set forever: after the first attempt settled, every later
    // `start()` returned that stale promise and never spawned again. The driver
    // could therefore be started exactly once per process — once it exited for
    // any reason, health sat on "starting" and every call answered "the desktop
    // driver is not running" with no restart that could ever take effect.
    const settled: Promise<void> = attempt.finally(() => {
      if (startPromise === settled) startPromise = null;
    }) as Promise<void>;
    startPromise = settled;
    // The rejection is delivered to whoever awaited `start`; without this the
    // `finally` chain above is an unhandled rejection of its own.
    startPromise.catch(() => {});
    return attempt;
  };

  const request = async <T = unknown>(
    op: MacDesktopDriverOp,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> => {
    if (disposed) {
      throw new MacDesktopDriverError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The desktop driver client is disposed.");
    }
    await start();
    const active = child;
    if (!active || !childReady) {
      throw new MacDesktopDriverError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The desktop driver is not running.");
    }
    nextRequestId += 1;
    const id = String(nextRequestId);
    const line = `${JSON.stringify({ id, op, ...payload })}\n`;
    return await new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pending.delete(id);
          // The helper's own watchdog answers a stuck handler at 15 seconds,
          // so a request that reaches this timer was never dispatched: the
          // helper's main thread was busy with something else the whole time.
          deps.logger.warn("mac_desktop.driver_request_timeout", {
            op,
            timeoutMs,
            pendingRequests: pending.size,
            pid: active.pid ?? null,
          });
          reject(new MacDesktopDriverError(
            "MAC_DESKTOP_DRIVER_UNAVAILABLE",
            `The desktop driver did not answer ${op} in ${timeoutMs}ms.`,
          ));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        op,
      });
      try {
        active.stdin.write(line);
      } catch (error) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  };

  return {
    /** Starts the helper if it is not already up. Idempotent. */
    async ensureStarted(): Promise<void> {
      await start();
    },

    /**
     * Kills the helper and starts a fresh one, resolving once the new child is
     * ready.
     *
     * macOS often does not show a Screen Recording grant made after a process
     * started to that same process; a new one sees it. This deliberately does
     * not go through `scheduleRestart`: an asked-for restart is not a crash, so
     * neither the backoff nor the crash-loop counter applies, and the caller is
     * owed a promise that settles when the replacement is up.
     */
    async restart(): Promise<void> {
      if (disposed) {
        throw new MacDesktopDriverError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The desktop driver client is disposed.");
      }
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      const running = child;
      deps.logger.info("mac_desktop.driver_restart_requested", { pid: running?.pid ?? null });
      if (running) {
        // Null `child` first. The `close` handler attributes a close to the
        // current handle, so leaving this one current would let a requested
        // restart schedule an unwanted backoff restart and a driver-lost event.
        child = null;
        childReady = false;
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }
        settlePending(new MacDesktopDriverError(
          "MAC_DESKTOP_DRIVER_UNAVAILABLE",
          "The desktop driver was restarted.",
        ));
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          running.once("close", done);
          try {
            running.kill("SIGTERM");
          } catch {
            // Already gone; the handle was the only thing left of it.
            done();
          }
          // A close that never arrives must not wedge the restart, and the
          // process behind it must not outlive it either: a helper still
          // holding its displays beside a new one is two owners of one lane.
          // Unref'd so neither timer holds the process open on its own.
          const escalate = setTimeout(() => {
            if (settled) return;
            deps.logger.warn("mac_desktop.driver_restart_kill", { pid: running.pid ?? null });
            try {
              running.kill("SIGKILL");
            } catch {
              // Already gone.
            }
            const fallback = setTimeout(done, RESTART_KILL_GRACE_MS);
            fallback.unref?.();
          }, RESTART_TERM_GRACE_MS);
          escalate.unref?.();
        });
      }
      restartAttempts = 0;
      await start();
    },

    isRunning(): boolean {
      return Boolean(child && childReady);
    },

    request,

    onEvent(listener: (event: MacDesktopDriverEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getHealth(): MacDesktopDriverHealth {
      return publishHealth();
    },

    /** Records the version the `ping` reply carried, for the health card. */
    setVersion(next: string | null): void {
      if (version === next) return;
      version = next;
      publishHealth();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      settlePending(new MacDesktopDriverError(
        "MAC_DESKTOP_DRIVER_UNAVAILABLE",
        "The desktop driver client was disposed.",
      ));
      listeners.clear();
      const running = child;
      child = null;
      childReady = false;
      running?.kill();
    },
  };
}

export type MacDesktopDriverClient = ReturnType<typeof createMacDesktopDriverClient>;
