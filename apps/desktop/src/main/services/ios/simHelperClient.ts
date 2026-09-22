import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../shared/utils";

/**
 * Supervisor and NDJSON client for the vendored simulator helper
 * (`apps/desktop/native/ADESimHelper`).
 *
 * Deliberately the same shape as `services/capture/captureHelper.ts` — one
 * long-lived child, a line-capped stdout reader, a bounded restart budget with
 * backoff, an in-band `quit` before any signal — because the failure modes of a
 * supervised NDJSON child are identical and a second, subtly different
 * supervision policy in the same app is how one of them rots.
 *
 * Two things are NOT copied from the capture helper, and both are deliberate:
 *
 * 1. **Requests are correlated by id, not by arrival order.** One helper drives
 *    every simulator on this Mac, so two devices' replies interleave. The
 *    helper echoes the request id on every reply (`Protocol.swift` rule 2) and
 *    this client refuses to resolve anything it cannot correlate.
 * 2. **A restart rejects every in-flight request.** A command whose helper died
 *    did not run; resolving it after the restart would report a tap that never
 *    landed.
 */

/** A failure the helper reported, or one this client synthesised for it. */
export class SimHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SimHelperError";
    this.code = code;
  }
}

export const APPLE_HELPER_UNAVAILABLE_CODE = "APPLE_HELPER_UNAVAILABLE" as const;

export type SimHelperEventPayload = { type: string } & Record<string, unknown>;

export interface SimHelperTransport {
  /** Send one NDJSON command; resolves with the `ok` payload or rejects with SimHelperError {code,message}. */
  send(command: Record<string, unknown> & { type: string; udid?: string }): Promise<Record<string, unknown>>;
  /** Subscribe to helper events (capture-started, capture-stopped, and any new record-* events). */
  onEvent(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  /** Absolute path of the helper binary in use, for diagnostics. */
  readonly binaryPath: string;
}

export type SimHelperClient = SimHelperTransport & {
  /** True once the child has spawned and announced `ready`. */
  isReady(): boolean;
  /** The running helper's pid, or null. */
  pid(): number | null;
  /** The protocol version the running helper announced, or null. */
  protocolVersion(): number | null;
  /** Whether a binary exists at `binaryPath` right now. */
  exists(): boolean;
  dispose(): void;
};

export type SimHelperClientOptions = {
  binaryPath: string;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  /** Injected in tests so no process is forked. */
  spawnHelper?: (binaryPath: string) => ChildProcess;
  /** Base backoff between restarts; multiplied by the attempt number. */
  restartDelayMs?: number;
  requestTimeoutMs?: number;
  platform?: NodeJS.Platform;
};

const MAX_BUFFERED_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_DELAY_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_MS = 500;
/** How long a helper must stay up before its restart budget is forgiven. */
const STABLE_AFTER_MS = 30_000;

const HELPER_EXECUTABLE_NAME = "ade-sim-helper";
/** What `swift build` produces, in the order a developer is likeliest to have. */
const SWIFT_BUILD_RELATIVE_PATHS = [
  path.join(".build", "release", "ADESimHelper"),
  path.join(".build", "arm64-apple-macosx", "release", "ADESimHelper"),
  path.join(".build", "x86_64-apple-macosx", "release", "ADESimHelper"),
  path.join(".build", "debug", "ADESimHelper"),
  path.join(".build", "arm64-apple-macosx", "debug", "ADESimHelper"),
  path.join(".build", "x86_64-apple-macosx", "debug", "ADESimHelper"),
];

const moduleDir = typeof __dirname === "string"
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

function fileIsUsable(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the helper binary lives, packaged and in a dev checkout.
 *
 * The lookup mirrors `resolveCaptureHelperExecutablePath` for the packaged case
 * (`Resources/native/<name>`) and then falls back to what a developer actually
 * has on disk: the `resources/native` drop that `npm run build:sim-helper`
 * writes, and — because that script is not wired into `dev` — the raw
 * `swift build` product under `native/ADESimHelper/.build`.
 *
 * Exported and pure so a test can assert the order without a filesystem.
 */
export function simHelperExecutableCandidates(input: {
  /** `process.resourcesPath` in Electron; null elsewhere. */
  resourcesPath?: string | null;
  /** Repo/app roots to search for the dev drops. */
  searchRoots?: string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const candidates: string[] = [];
  const override = input.env?.ADE_SIM_HELPER_PATH?.trim();
  if (override) candidates.push(path.resolve(override));
  const resourcesPath = input.resourcesPath?.trim();
  if (resourcesPath) candidates.push(path.join(resourcesPath, "native", HELPER_EXECUTABLE_NAME));
  for (const root of input.searchRoots ?? []) {
    candidates.push(path.join(root, "resources", "native", HELPER_EXECUTABLE_NAME));
    candidates.push(path.join(root, "apps", "desktop", "resources", "native", HELPER_EXECUTABLE_NAME));
    for (const relative of SWIFT_BUILD_RELATIVE_PATHS) {
      candidates.push(path.join(root, "native", "ADESimHelper", relative));
      candidates.push(path.join(root, "apps", "desktop", "native", "ADESimHelper", relative));
    }
  }
  return Array.from(new Set(candidates));
}

/** Every ancestor of `start`, nearest first, so a bundled file can find the app root. */
function ancestorDirectories(start: string, depth = 8): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  for (let index = 0; index < depth; index += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/**
 * The helper binary this process should use.
 *
 * Returns the first candidate that exists, or — when none does — the packaged
 * path, so `status` can report a concrete absent path instead of an empty
 * string and the error says which file is missing.
 */
export function resolveSimHelperExecutablePath(input: {
  resourcesPath?: string | null;
  searchRoots?: string[];
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
} = {}): string {
  const exists = input.exists ?? fileIsUsable;
  const searchRoots = input.searchRoots ?? ancestorDirectories(moduleDir);
  const candidates = simHelperExecutableCandidates({
    resourcesPath: input.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : null),
    searchRoots,
    env: input.env ?? process.env,
  });
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0] ?? "";
}

type PendingRequest = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
};

export function createSimHelperClient(options: SimHelperClientOptions): SimHelperClient {
  const platform = options.platform ?? process.platform;
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const listeners = new Set<(event: SimHelperEventPayload) => void>();
  const pending = new Map<string, PendingRequest>();

  let child: ChildProcess | null = null;
  let ready = false;
  let helperPid: number | null = null;
  let helperProtocol: number | null = null;
  let stdoutBuffer = "";
  let stderrTail = "";
  let restartAttempts = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let stableTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let nextRequestId = 1;

  const emit = (event: SimHelperEventPayload): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        options.logger.debug("sim_helper.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const failPending = (error: Error): void => {
    // Copied before iterating: a rejection handler can send a new command, and
    // mutating the map mid-iteration would drop it.
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, request] of entries) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  };

  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      options.logger.debug("sim_helper.invalid_line", { line: line.slice(0, 200) });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    const type = parsed.type;
    if (type === "ready") {
      ready = true;
      helperProtocol = typeof parsed.protocol === "number" ? parsed.protocol : null;
      helperPid = typeof parsed.pid === "number" ? parsed.pid : child?.pid ?? null;
      options.logger.info("sim_helper.ready", { pid: helperPid, protocol: helperProtocol });
      emit({ type, ...parsed });
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : null;
    const request = id ? pending.get(id) : null;
    if (request && id) {
      pending.delete(id);
      clearTimeout(request.timer);
      if (type === "error") {
        request.reject(new SimHelperError(
          typeof parsed.code === "string" ? parsed.code : "failed",
          typeof parsed.message === "string" ? parsed.message : `Simulator helper ${request.type} failed.`,
        ));
      } else {
        request.resolve(parsed);
      }
    }
    // `capture-started` carries BOTH a request id and stream facts the rest of
    // the service subscribes to, so it is answered above and broadcast here.
    // An unknown `record-*` event (unit 2C's) has no id and only lands here.
    if (type !== "ok" && type !== "error") emit({ type, ...parsed });
  };

  const consumeStdout = (chunk: string): void => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_BUFFERED_STDOUT_BYTES) {
      options.logger.warn?.("sim_helper.stdout_overflow");
      stdoutBuffer = "";
      return;
    }
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleLine(line);
    }
  };

  const scheduleRestart = (): void => {
    if (disposed || restartTimer || restartAttempts >= MAX_RESTART_ATTEMPTS) return;
    restartAttempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, restartDelayMs * restartAttempts);
    restartTimer.unref?.();
  };

  const spawnHelper = options.spawnHelper
    ?? ((binaryPath: string) => spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      // The helper leads its own process group so a dispose reaches anything it
      // forked. It is deliberately not `unref`ed: ADE holds the handle.
      detached: true,
      env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    }));

  function start(): boolean {
    if (disposed || child) return false;
    if (platform !== "darwin") return false;
    if (!fileIsUsable(options.binaryPath)) {
      options.logger.warn?.("sim_helper.binary_missing", { binaryPath: options.binaryPath });
      return false;
    }
    let spawned: ChildProcess;
    try {
      spawned = spawnHelper(options.binaryPath);
    } catch (error) {
      options.logger.warn?.("sim_helper.spawn_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleRestart();
      return false;
    }
    child = spawned;
    ready = false;
    helperPid = spawned.pid ?? null;
    stdoutBuffer = "";
    stderrTail = "";
    spawned.stdout?.setEncoding("utf8");
    spawned.stderr?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => consumeStdout(chunk));
    spawned.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    spawned.stdin?.on("error", (error: Error) => {
      if (disposed) return;
      options.logger.debug("sim_helper.stdin_error", { error: error.message });
    });
    spawned.once("error", (error: Error) => {
      options.logger.warn?.("sim_helper.error", { error: error.message });
    });
    stableTimer = setTimeout(() => {
      stableTimer = null;
      restartAttempts = 0;
    }, STABLE_AFTER_MS);
    stableTimer.unref?.();
    spawned.once("exit", (code, signal) => {
      // Every mutation is guarded on this still being the live child: a dispose
      // or a restart inside the grace window has already replaced it, and an
      // unguarded handler would clear the NEW child's readiness.
      if (child !== spawned) return;
      child = null;
      ready = false;
      helperPid = null;
      helperProtocol = null;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      const detail = stderrTail.trim();
      options.logger.info("sim_helper.exited", { code, signal, disposed, detail: detail.slice(-500) || null });
      failPending(new SimHelperError(
        APPLE_HELPER_UNAVAILABLE_CODE,
        detail || `The simulator helper exited with ${signal ?? code ?? "an unknown status"}.`,
      ));
      if (!disposed) scheduleRestart();
    });
    return true;
  }

  const ensureStarted = (): void => {
    if (child || disposed) return;
    // A caller asking for work is the signal that the restart budget should be
    // forgiven: the previous failure may have been a missing Xcode that is now
    // installed, and an exhausted budget otherwise wedges the surface forever.
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) restartAttempts = 0;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    start();
  };

  const send = (command: Record<string, unknown> & { type: string; udid?: string }): Promise<Record<string, unknown>> => {
    if (disposed) {
      return Promise.reject(new SimHelperError(APPLE_HELPER_UNAVAILABLE_CODE, "The simulator helper client has been disposed."));
    }
    if (platform !== "darwin") {
      return Promise.reject(new SimHelperError(APPLE_HELPER_UNAVAILABLE_CODE, "Apple device control is only available on macOS."));
    }
    ensureStarted();
    const active = child;
    if (!active || !active.stdin?.writable) {
      return Promise.reject(new SimHelperError(
        APPLE_HELPER_UNAVAILABLE_CODE,
        fileIsUsable(options.binaryPath)
          ? "The simulator helper is not running yet. Try again in a moment."
          : `The simulator helper binary is missing at ${options.binaryPath}. Run \`npm run build:sim-helper\` in apps/desktop.`,
      ));
    }
    const id = `r${nextRequestId++}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SimHelperError("timeout", `The simulator helper did not answer \`${command.type}\` within ${Math.round(requestTimeoutMs / 1000)}s.`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, type: command.type });
      try {
        active.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new SimHelperError(
          APPLE_HELPER_UNAVAILABLE_CODE,
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    listeners.clear();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    const active = child;
    child = null;
    ready = false;
    failPending(new SimHelperError(APPLE_HELPER_UNAVAILABLE_CODE, "The simulator helper client has been disposed."));
    if (!active) return;
    // In-band quit first so the helper tears its capture sessions down; the
    // kill is the backstop for a helper wedged inside CoreSimulator.
    try {
      active.stdin?.write(`${JSON.stringify({ type: "quit", id: "quit" })}\n`);
      active.stdin?.end();
    } catch {
      // Already gone; the kill below is the only path left.
    }
    const killTimer = setTimeout(() => {
      if (active.exitCode == null && active.signalCode == null) {
        // The helper is spawned `detached`, so it leads its own process group
        // and any children it forked inherit it. Signal the group; fall back to
        // the leader if the group is already gone.
        const pid = active.pid;
        try {
          if (pid != null) process.kill(-pid, "SIGKILL");
          else active.kill("SIGKILL");
        } catch {
          try {
            active.kill("SIGKILL");
          } catch {
            // Already reaped.
          }
        }
      }
    }, GRACEFUL_SHUTDOWN_MS);
    killTimer.unref?.();
  };

  return {
    get binaryPath() {
      return options.binaryPath;
    },
    send,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isReady: () => ready,
    pid: () => helperPid,
    protocolVersion: () => helperProtocol,
    exists: () => fileIsUsable(options.binaryPath),
    dispose,
  };
}
