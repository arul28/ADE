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
 * The helper accepts both the camelCase spelling its Swift enum was born with
 * and the dotted spelling the feature doc uses; the dotted one is what goes on
 * the wire from here, because that is the spelling the doc and the CLI read.
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
 */
export const MAC_DESKTOP_DRIVER_OPS = {
  health: "ping",
  probePermissions: "permissions.probe",
  requestPermissions: "permissions.request",
  createDisplay: "display.create",
  destroyDisplay: "display.destroy",
  listDisplays: "display.list",
  reconcileDisplays: "display.reconcile",
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
  stopStream: "stream.stop",
  lastFrame: "stream.lastFrame",
  startRecording: "record.start",
  stopRecording: "record.stop",
  setCursorOverlay: "cursor.set",
  idleSeconds: "input.idleSeconds",
  quit: "quit",
} as const;

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

export class MacDesktopDriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
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
  now?: () => number;
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
  const now = deps.now ?? (() => Date.now());
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams | null = null;
  let childReady = false;
  let disposed = false;
  let stdoutBuffer = "";
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

  const scheduleRestart = (): void => {
    if (disposed || restartTimer) return;
    restartAttempts += 1;
    if (restartAttempts > MAX_RESTART_ATTEMPTS) {
      publishHealth();
      return;
    }
    const delay = Math.min(MAX_RESTART_DELAY_MS, BASE_RESTART_DELAY_MS * 2 ** (restartAttempts - 1));
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
      spawned.stdout.setEncoding("utf8");
      spawned.stderr.setEncoding("utf8");
      spawned.stdout.on("data", (chunk: string) => consumeStdout(chunk));
      spawned.stderr.on("data", (chunk: string) => {
        deps.logger.debug("mac_desktop.driver_stderr", { message: chunk.slice(0, 2_000) });
      });
      spawned.stdin.on("error", (error: Error) => {
        if (!disposed) deps.logger.debug("mac_desktop.driver_stdin_error", { error: error.message });
      });
      spawned.once("error", (error: Error) => {
        deps.logger.warn("mac_desktop.driver_error", { error: error.message });
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
        deps.logger.info("mac_desktop.driver_exited", { code, signal, disposed });
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

    startPromise = attempt.finally(() => {
      if (startPromise === attempt) startPromise = null;
    }) as Promise<void>;
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
    ops: MAC_DESKTOP_DRIVER_OPS,

    /** Starts the helper if it is not already up. Idempotent. */
    async ensureStarted(): Promise<void> {
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

    /** Clears the crash-loop counter and tries again, for a settings retry. */
    retry(): MacDesktopDriverHealth {
      if (disposed) return publishHealth();
      restartAttempts = 0;
      lastProtocolError = null;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!child) {
        void start().catch(() => {
          // Health already carries the failure.
        });
      }
      return publishHealth();
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
