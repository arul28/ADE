import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import type { Logger } from "../logging/logger";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { resolveAdeOpenCodeIsolationPaths, type OpenCodeIsolationPaths } from "../../../shared/opencodeDataHome";
import {
  quoteWindowsCmdArg,
  resolveWindowsCmdLineInvocation,
  shouldUseWindowsCmdWrapper,
} from "../shared/processExecution";
import { probeOpenCodeBinaryQuarantine, resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import {
  ADE_OPENCODE_MANAGED_ENV,
  ADE_OPENCODE_OWNER_PID_ENV,
  lastOpenCodeOrphanRecovery,
  recoverManagedOpenCodeOrphans as recoverOrphans,
  removeManagedServerRecord,
  removeProfileConfig,
  resolveOpenCodeListenerPid,
  stopChildProcess,
  terminateOpenCodeServerProcesses,
  writeManagedServerRecord,
  type OpenCodeOrphanRecoveryResult,
} from "./openCodeServerOrphans";

/**
 * ADE's OpenCode 2.0 servers.
 *
 * One long-lived `opencode serve` per *profile*. Every ordinary chat, the model
 * inventory, auth, and one-shot tasks share the `shared` profile. A chat whose
 * OpenCode config must differ from everyone else's (its own MCP servers, a
 * harness preset provider, a strict MCP surface) gets a profile of its own,
 * because OpenCode config is per server.
 *
 * Config reaches the server as a file named by `OPENCODE_CONFIG`, which
 * OpenCode 2.0 watches and hot-reloads, so an API key or a local model added
 * while a server runs applies without a restart.
 *
 * The server writes ADE's owned data home, never the user's personal store:
 * OpenCode 2.0 migrates a v1 database in place when it opens one, and the
 * user's own OpenCode may still be 1.x.
 */

/**
 * Typed classification of an OpenCode binary/server launch failure. Surfaced to
 * the UI (via a stable, single-line error message; see
 * {@link renderOpenCodeDiagnostic}) so it can offer a precise fix instead of a
 * generic error.
 */
export type OpenCodeDiagnostic =
  | { kind: "not-installed" }
  | { kind: "quarantined"; binaryPath: string; fixCommand: string }
  | { kind: "bad-signature"; binaryPath: string }
  | { kind: "port-conflict"; port: number }
  | { kind: "launch-timeout" }
  | { kind: "unknown"; message: string };

/** The generated config ADE hands a server. Opaque here; built by `openCodeConfig.ts`. */
export type OpenCodeServerConfig = Record<string, unknown>;

/**
 * Which server a caller needs. `key` names the profile; callers with the same
 * key share one process. `isolated` hides the user's global config (and with it
 * their MCP servers, agents, and skills) behind ADE's own config.
 */
export type OpenCodeServerProfile = {
  key: string;
  isolated: boolean;
  /** A long-lived server many chats and helpers use, rather than one chat's own. */
  shared: boolean;
};


export type OpenCodeServerOwnerKind = "inventory" | "oneshot" | "chat" | "auth" | "terminal";

export type OpenCodeEventListener = {
  /** Every event the server publishes. Listeners filter by session id themselves. */
  onEvent(event: OpenCodeEvent): void;
  /**
   * The event stream dropped and came back. OpenCode streams are live-only:
   * whatever was published during the gap is gone, so a listener with an open
   * turn must reconcile against the server (`session.active`, messages).
   */
  onReconnected?(): void;
  /** The server process exited. Every listener of that server gets this once. */
  onServerExit?(error: Error): void;
};

export type OpenCodeServerLease = {
  readonly key: string;
  readonly url: string;
  /** The server password a separate client (the terminal app) authenticates with. */
  readonly password: string;
  readonly client: OpenCodeClient;
  /** False once the process exited or was shut down. */
  isAlive(): boolean;
  listen(listener: OpenCodeEventListener): () => void;
  /** Rewrite the server's config file; OpenCode hot-reloads it. */
  updateConfig(config: OpenCodeServerConfig): void;
  release(): void;
};

export type OpenCodeRuntimeDiagnosticsEntry = {
  key: string;
  url: string;
  pid: number | null;
  isolated: boolean;
  shared: boolean;
  refCount: number;
  listenerCount: number;
  startedAt: number;
  lastUsedAt: number;
};

type OpenCodeServerInstance = {
  url: string;
  pid: number | null;
  close(): void;
  onExit(handler: (error: Error) => void): void;
};

type OpenCodeServerLaunchArgs = {
  port: number;
  env: NodeJS.ProcessEnv;
};

type OpenCodeServeLaunchSpec = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  useShell: boolean;
  windowsVerbatimArguments: boolean;
};

type OpenCodeServerEntry = {
  key: string;
  isolated: boolean;
  shared: boolean;
  server: OpenCodeServerInstance;
  password: string;
  client: OpenCodeClient;
  configFile: string;
  configJson: string;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  listeners: Set<OpenCodeEventListener>;
  streamAbort: AbortController | null;
  streamRunning: boolean;
  startedAt: number;
  lastUsedAt: number;
};

const PORT_RETRY_ATTEMPTS = 3;
const OPEN_CODE_SERVER_START_TIMEOUT_MS = 20_000;
/** The shared server outlives a quiet spell; restarting it costs a cold boot. */
const SHARED_SERVER_IDLE_MS = 10 * 60_000;
/** A per-chat profile has no other users; free its memory soon after release. */
const PROFILE_SERVER_IDLE_MS = 60_000;
const EVENT_STREAM_RETRY_MIN_MS = 250;
const EVENT_STREAM_RETRY_MAX_MS = 5_000;
const OPENCODE_BASIC_AUTH_USER = "opencode";

const serverEntries = new Map<string, OpenCodeServerEntry>();
const inFlightEntries = new Map<string, Promise<OpenCodeServerEntry>>();
const protectedLaunchPorts = new Set<number>();

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an OpenCode port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "EADDRINUSE") return true;
    if (error instanceof Error) {
      return error.message.includes("EADDRINUSE") || error.message.includes("address already in use");
    }
  }
  return false;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/**
 * Classify a raw OpenCode launch/probe failure into a typed diagnostic. See the
 * task heuristics: ENOENT / no resolved binary → not-installed; EADDRINUSE →
 * port-conflict; startup deadline → launch-timeout; explicit darwin
 * signature/developer-verification evidence → quarantined or bad-signature
 * only when the quarantine probe is conclusive; anything else → unknown.
 */
export function classifyOpenCodeLaunchFailure(
  error: unknown,
  context: { port: number; binaryPath: string | null },
): OpenCodeDiagnostic {
  const binaryPath = context.binaryPath;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();

  if (!binaryPath || code === "ENOENT" || lower.includes("enoent") || lower.includes("executable is not available")) {
    return { kind: "not-installed" };
  }
  if (isPortConflict(error)) {
    return { kind: "port-conflict", port: context.port };
  }
  if (lower.includes("timeout waiting for server to start")) {
    return { kind: "launch-timeout" };
  }
  const hasExplicitSignatureEvidence = lower.includes("code signature")
    || lower.includes("developer cannot be verified");
  if (process.platform === "darwin" && hasExplicitSignatureEvidence) {
    const quarantine = probeOpenCodeBinaryQuarantine(binaryPath);
    if (quarantine === "quarantined") {
      return {
        kind: "quarantined",
        binaryPath,
        fixCommand: `xattr -d com.apple.quarantine "${binaryPath}"`,
      };
    }
    if (quarantine === "clean") {
      return { kind: "bad-signature", binaryPath };
    }
  }
  return { kind: "unknown", message: message || "OpenCode server failed to launch." };
}

/**
 * Render a diagnostic into a stable, single-line, actionable message. The
 * `OpenCode: <kind>:` prefix is contract-stable — UI surfaces may key off it.
 */
export function renderOpenCodeDiagnostic(diagnostic: OpenCodeDiagnostic): string {
  switch (diagnostic.kind) {
    case "not-installed":
      return "OpenCode: not-installed: OpenCode binary could not be found. Install OpenCode or ensure it is on your PATH.";
    case "quarantined":
      return `OpenCode: quarantined: OpenCode binary is quarantined by macOS Gatekeeper. Fix: ${diagnostic.fixCommand}`;
    case "bad-signature":
      return `OpenCode: bad-signature: OpenCode binary at "${diagnostic.binaryPath}" failed macOS code-signature verification. Reinstall OpenCode from a trusted source.`;
    case "port-conflict":
      return `OpenCode: port-conflict: Port ${diagnostic.port} is already in use. Free the port or retry.`;
    case "launch-timeout":
      return "OpenCode: launch-timeout: OpenCode server did not become ready in time. Retry, or kill any hung opencode process and try again.";
    case "unknown":
      return `OpenCode: unknown: ${diagnostic.message}`;
  }
}

/** Launch failure carrying its typed {@link OpenCodeDiagnostic} for callers that can key off it. */
export class OpenCodeLaunchError extends Error {
  readonly diagnostic: OpenCodeDiagnostic;
  constructor(diagnostic: OpenCodeDiagnostic) {
    super(renderOpenCodeDiagnostic(diagnostic));
    this.name = "OpenCodeLaunchError";
    this.diagnostic = diagnostic;
  }
}

function toOpenCodeLaunchError(
  error: unknown,
  context: { port: number; binaryPath: string | null },
): OpenCodeLaunchError {
  if (error instanceof OpenCodeLaunchError) return error;
  return new OpenCodeLaunchError(classifyOpenCodeLaunchFailure(error, context));
}

function activeManagedOpenCodePorts(): Set<number> {
  const ports = new Set<number>(protectedLaunchPorts);
  for (const entry of serverEntries.values()) {
    try {
      const parsed = new URL(entry.server.url);
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port > 0) {
        ports.add(port);
      }
    } catch {
      // Ignore malformed diagnostic URLs from test doubles or future remotes.
    }
  }
  return ports;
}

/** Reap servers a dead ADE left behind, never this process's live ones. */
export async function recoverManagedOpenCodeOrphans(args: {
  force?: boolean;
  logger?: Logger | null;
} = {}): Promise<OpenCodeOrphanRecoveryResult> {
  return await recoverOrphans({ ...args, activePorts: activeManagedOpenCodePorts });
}

function unprotectLaunchPortForUrl(url: string): void {
  try {
    const port = Number(new URL(url).port);
    if (Number.isInteger(port) && port > 0) {
      protectedLaunchPorts.delete(port);
    }
  } catch {
    // Ignore malformed diagnostic URLs from test doubles or future remotes.
  }
}

function ensureOpenCodeIsolationDirs(paths: OpenCodeIsolationPaths): void {
  for (const dir of [
    paths.root,
    paths.configHome,
    paths.dataHome,
    paths.stateHome,
    paths.cacheHome,
    paths.runtimeDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Where a profile's generated config file lives: one file per profile and
 * process. The file holds provider keys, so it lives only as long as its
 * server, and two brains on one ADE home never share (or delete) one file.
 */
function profileConfigFile(paths: OpenCodeIsolationPaths, key: string): string {
  const safe = createHash("sha256").update(key).digest("hex").slice(0, 24);
  // Unique per start: a server that is still exiting (idle close, then a quick
  // re-acquire) must never delete the file of its successor.
  return path.join(paths.root, "config-ade", `${safe}.${process.pid}.${randomUUID()}.json`);
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Write the config atomically: OpenCode watches the file, and a reader that
 * lands between truncate and write would load an empty config. The directory
 * and file are private to the user, because the config holds provider keys.
 */
function writeProfileConfig(file: string, json: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    // Windows refuses a rename onto a file another process (OpenCode's
    // watcher) has open for a moment; retry briefly instead of failing.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (process.platform !== "win32" || !RENAME_RETRY_CODES.has(code) || attempt >= 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * The env of an ADE-owned server.
 *
 * - Data/state/cache are forced into ADE's runtime root. These three ARE the
 *   ownership guarantee; inheriting a user `XDG_DATA_HOME` would open (and
 *   migrate in place) the user's own OpenCode store.
 * - The user's config home still loads for an ordinary profile, so their
 *   providers, agents, skills, and MCP servers work in ADE. An isolated profile
 *   points it at an empty ADE directory and disables project config.
 * - `OPENCODE_CONFIG` carries ADE's generated config; it layers over the user's
 *   global config and hot-reloads.
 */
function buildOpenCodeServerEnv(args: {
  paths: OpenCodeIsolationPaths;
  isolated: boolean;
  configFile: string;
  password: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = userProcessEnv();
  // ADE owns these; a user value would redirect the server's config, auth, or
  // listener away from what ADE manages.
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_DB;
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_PASSWORD;
  env.XDG_DATA_HOME = args.paths.dataHome;
  env.XDG_STATE_HOME = args.paths.stateHome;
  env.XDG_CACHE_HOME = args.paths.cacheHome;
  if (args.isolated) {
    env.XDG_CONFIG_HOME = args.paths.configHome;
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_CONFIG_CONTENT;
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  }
  env.OPENCODE_CONFIG = args.configFile;
  env.OPENCODE_SERVER_PASSWORD = args.password;
  // ADE resolves and pins the binary, so OpenCode's own updater stays off.
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  env[ADE_OPENCODE_MANAGED_ENV] = "1";
  env[ADE_OPENCODE_OWNER_PID_ENV] = String(process.pid);
  return env;
}

function buildOpenCodeServeLaunchSpec(args: OpenCodeServerLaunchArgs): OpenCodeServeLaunchSpec {
  const executable = resolveOpenCodeBinaryPath();
  if (!executable) {
    throw new Error("OpenCode executable is not available.");
  }
  const serveArgs = ["serve", "--hostname=127.0.0.1", `--port=${args.port}`];
  // Only shim through cmd.exe when the resolved target actually needs it (a
  // `.cmd`/`.bat` shim, or an extensionless file), matching
  // {@link shouldUseWindowsCmdWrapper}. The bundled runtime is a real `.exe`, so
  // wrapping it would add a cmd.exe parent that owns the server; when that
  // parent died without its tree, the surviving `opencode.exe` carried no
  // managed markers on its command line and orphan recovery could not reap it.
  if (process.platform === "win32" && shouldUseWindowsCmdWrapper(executable)) {
    const serveCmdLine = [executable, ...serveArgs].map(quoteWindowsCmdArg).join(" ");
    const assignments = [
      `set ${quoteWindowsCmdArg(`${ADE_OPENCODE_MANAGED_ENV}=1`)}`,
      `set ${quoteWindowsCmdArg(`${ADE_OPENCODE_OWNER_PID_ENV}=${process.pid}`)}`,
    ];
    const cmdLine = `${assignments.join("&&")}&&${serveCmdLine}`;
    const invocation = resolveWindowsCmdLineInvocation(cmdLine, args.env);
    return {
      executable: invocation.command,
      args: invocation.args,
      env: args.env,
      useShell: false,
      windowsVerbatimArguments: true,
    };
  }
  return {
    executable,
    args: serveArgs,
    env: args.env,
    useShell: false,
    windowsVerbatimArguments: false,
  };
}

/** `server listening on http://127.0.0.1:<port>` (2.0); older builds prefixed `opencode`. */
function parseOpenCodeServerListenUrl(line: string): string | null {
  const normalized = line.trim();
  if (!/\bserver\s+listening\b/i.test(normalized)) return null;
  const match = normalized.match(/\bon\s+(https?:\/\/[^\s]+)/i)
    ?? normalized.match(/\b(https?:\/\/[^\s]+)/i);
  return match?.[1] ?? null;
}

async function launchOpenCodeServer(args: OpenCodeServerLaunchArgs): Promise<OpenCodeServerInstance> {
  const launchSpec = buildOpenCodeServeLaunchSpec(args);
  const proc = spawn(launchSpec.executable, launchSpec.args, {
    env: launchSpec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: launchSpec.windowsVerbatimArguments,
    shell: launchSpec.useShell,
  });
  if (proc.pid) {
    const configFile = launchSpec.env.OPENCODE_CONFIG;
    writeManagedServerRecord({
      pid: proc.pid,
      port: args.port,
      ownerPid: process.pid,
      startedAt: Date.now(),
      ...(configFile ? { configFile } : {}),
    });
  }

  let output = "";
  let resolved = false;
  const exitHandlers: Array<(error: Error) => void> = [];

  return await new Promise<OpenCodeServerInstance>((resolve, reject) => {
    const cleanupStartup = (): void => {
      clearTimeout(timeoutId);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("error", onError);
    };

    // A failed attempt keeps the config file: the port-conflict retry launches
    // with the same one, and startEntry removes it when every attempt fails.
    const fail = (error: Error): void => {
      cleanupStartup();
      stopChildProcess(proc);
      if (proc.pid) removeManagedServerRecord(proc.pid, { keepConfig: true });
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${OPEN_CODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPEN_CODE_SERVER_START_TIMEOUT_MS);

    const onStdout = (chunk: Buffer): void => {
      if (resolved) return;
      output += chunk.toString();
      // Only complete lines: a chunk can end inside the URL, and a cut-off
      // port would resolve the start with the wrong address.
      const lines = output.split("\n");
      lines.pop();
      for (const line of lines) {
        const url = parseOpenCodeServerListenUrl(line);
        if (!url) continue;
        resolved = true;
        cleanupStartup();
        // Keep draining the pipes: a full stdout buffer blocks the server.
        proc.stdout?.resume();
        proc.stderr?.resume();
        const listenerPid = resolveOpenCodeListenerPid(args.port) ?? proc.pid ?? null;
        resolve({
          url,
          pid: listenerPid,
          close() {
            terminateOpenCodeServerProcesses(proc, listenerPid);
            if (proc.pid) removeManagedServerRecord(proc.pid);
          },
          onExit(handler) {
            exitHandlers.push(handler);
          },
        });
        return;
      }
    };

    const onStderr = (chunk: Buffer): void => {
      if (resolved) return;
      output += chunk.toString();
    };

    proc.on("exit", (code, signal) => {
      if (proc.pid) removeManagedServerRecord(proc.pid, { keepConfig: !resolved });
      if (!resolved) {
        cleanupStartup();
        let message = `Server exited with code ${code}`;
        if (output.trim()) message += `\nServer output: ${output}`;
        reject(new Error(message));
        return;
      }
      const error = new Error(`OpenCode server exited (code ${code ?? "null"}, signal ${signal ?? "none"}).`);
      for (const handler of exitHandlers.splice(0)) handler(error);
    });

    const onError = (error: Error): void => {
      cleanupStartup();
      reject(error);
    };

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", onError);
  });
}

async function launchOpenCodeServerWithRetry(env: NodeJS.ProcessEnv): Promise<OpenCodeServerInstance> {
  const binaryPath = resolveOpenCodeBinaryPath();
  let lastError: unknown;
  let lastPort = 0;
  for (let attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt += 1) {
    const port = await findAvailablePort();
    lastPort = port;
    protectedLaunchPorts.add(port);
    try {
      return await launchOpenCodeServer({ port, env });
    } catch (error) {
      protectedLaunchPorts.delete(port);
      lastError = error;
      if (!isPortConflict(error)) {
        throw toOpenCodeLaunchError(error, { port, binaryPath });
      }
    }
  }
  throw toOpenCodeLaunchError(lastError, { port: lastPort, binaryPath });
}

function logServerEvent(
  logger: Logger | null | undefined,
  event: string,
  entry: OpenCodeServerEntry,
  extra: Record<string, unknown> = {},
): void {
  logger?.info(event, {
    profile: entry.key,
    isolated: entry.isolated,
    url: entry.server.url,
    pid: entry.server.pid,
    refCount: entry.refCount,
    ...extra,
  });
}

function clearIdleTimer(entry: OpenCodeServerEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

/**
 * Mark an entry closed and drop everything that belongs to its process: the
 * idle timer, the event stream, the pool slot, the protected port, and the
 * config file (which holds provider keys). Shared by shutdown and exit.
 */
function detachEntry(entry: OpenCodeServerEntry): void {
  entry.closed = true;
  clearIdleTimer(entry);
  entry.streamAbort?.abort();
  if (serverEntries.get(entry.key) === entry) serverEntries.delete(entry.key);
  unprotectLaunchPortForUrl(entry.server.url);
  removeProfileConfig(entry.configFile);
}

function closeEntry(entry: OpenCodeServerEntry, reason: string, logger?: Logger | null): void {
  if (entry.closed) return;
  detachEntry(entry);
  try {
    entry.server.close();
  } catch {
    // ignore shutdown failures
  }
  logServerEvent(logger, "opencode.server_shutdown", entry, { reason });
}

function scheduleIdleShutdown(entry: OpenCodeServerEntry, logger?: Logger | null): void {
  clearIdleTimer(entry);
  if (entry.refCount > 0 || entry.closed) return;
  const idleMs = entry.shared ? SHARED_SERVER_IDLE_MS : PROFILE_SERVER_IDLE_MS;
  entry.idleTimer = setTimeout(() => {
    if (entry.refCount > 0) return;
    closeEntry(entry, "idle", logger);
  }, idleMs);
  entry.idleTimer.unref?.();
}

/**
 * The server's one event stream, fanned out to every listener.
 *
 * OpenCode 2.0 subscriptions are live-only and do not reconnect by themselves.
 * The loop resubscribes with backoff and tells listeners about the gap once the
 * new stream is up, so a chat with an open turn can reconcile what it missed.
 */
function ensureEventStream(entry: OpenCodeServerEntry, logger?: Logger | null): void {
  if (entry.streamRunning || entry.closed) return;
  entry.streamRunning = true;
  void (async () => {
    let backoffMs = EVENT_STREAM_RETRY_MIN_MS;
    let hadGap = false;
    while (!entry.closed) {
      const abort = new AbortController();
      entry.streamAbort = abort;
      try {
        for await (const event of entry.client.event.subscribe({ signal: abort.signal })) {
          if (event.type === "server.connected") {
            backoffMs = EVENT_STREAM_RETRY_MIN_MS;
            if (hadGap) {
              hadGap = false;
              for (const listener of [...entry.listeners]) {
                try {
                  listener.onReconnected?.();
                } catch (error) {
                  logger?.warn("opencode.event_listener_failed", { phase: "reconnected", error: String(error) });
                }
              }
            }
            continue;
          }
          for (const listener of [...entry.listeners]) {
            try {
              listener.onEvent(event);
            } catch (error) {
              logger?.warn("opencode.event_listener_failed", {
                type: event.type,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      } catch (error) {
        if (entry.closed || abort.signal.aborted) break;
        logger?.warn("opencode.event_stream_error", {
          profile: entry.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (entry.closed) break;
      hadGap = true;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, EVENT_STREAM_RETRY_MAX_MS);
    }
    entry.streamRunning = false;
  })();
}

async function startEntry(args: {
  profile: OpenCodeServerProfile;
  config: OpenCodeServerConfig;
  logger?: Logger | null;
}): Promise<OpenCodeServerEntry> {
  await recoverManagedOpenCodeOrphans({ logger: args.logger });
  const paths = resolveAdeOpenCodeIsolationPaths();
  ensureOpenCodeIsolationDirs(paths);
  const configFile = profileConfigFile(paths, args.profile.key);
  const configJson = JSON.stringify(args.config);
  writeProfileConfig(configFile, configJson);
  const password = randomBytes(24).toString("base64url");
  const env = buildOpenCodeServerEnv({
    paths,
    isolated: args.profile.isolated,
    configFile,
    password,
  });
  let server: OpenCodeServerInstance;
  try {
    server = await launchOpenCodeServerWithRetry(env);
  } catch (error) {
    removeProfileConfig(configFile);
    throw error;
  }
  const authorization = `Basic ${Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${password}`).toString("base64")}`;
  const client = OpenCode.make({ baseUrl: server.url, headers: { authorization } });
  const entry: OpenCodeServerEntry = {
    key: args.profile.key,
    isolated: args.profile.isolated,
    shared: args.profile.shared,
    server,
    password,
    client,
    configFile,
    configJson,
    refCount: 0,
    idleTimer: null,
    closed: false,
    listeners: new Set(),
    streamAbort: null,
    streamRunning: false,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  server.onExit((error) => {
    const wasClosed = entry.closed;
    detachEntry(entry);
    if (wasClosed) return;
    args.logger?.warn("opencode.server_exited", { profile: entry.key, error: error.message });
    for (const listener of [...entry.listeners]) {
      try {
        listener.onServerExit?.(error);
      } catch {
        // A listener failing to react must not stop the others.
      }
    }
  });
  // A new server answers before its model catalog has loaded; a session
  // created with a model in that window races it. `integration.list` blocks
  // until the catalog is ready.
  await client.integration.list().catch((error: unknown) => {
    args.logger?.warn("opencode.server_catalog_wait_failed", {
      profile: args.profile.key,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  logServerEvent(args.logger, "opencode.server_started", entry);
  return entry;
}

function buildLease(
  entry: OpenCodeServerEntry,
  logger?: Logger | null,
  owner?: { kind: OpenCodeServerOwnerKind; id: string | null },
): OpenCodeServerLease {
  let released = false;
  const ownListeners = new Set<OpenCodeEventListener>();
  return {
    key: entry.key,
    url: entry.server.url,
    password: entry.password,
    client: entry.client,
    isAlive: () => !entry.closed,
    listen(listener) {
      entry.listeners.add(listener);
      ownListeners.add(listener);
      ensureEventStream(entry, logger);
      return () => {
        entry.listeners.delete(listener);
        ownListeners.delete(listener);
      };
    },
    updateConfig(config) {
      if (entry.closed) return;
      const json = JSON.stringify(config);
      if (json === entry.configJson) return;
      // Recorded only once written, so a failed write is retried by the next identical config.
      writeProfileConfig(entry.configFile, json);
      entry.configJson = json;
      logServerEvent(logger, "opencode.server_config_updated", entry);
    },
    release() {
      if (released) return;
      released = true;
      for (const listener of ownListeners) entry.listeners.delete(listener);
      ownListeners.clear();
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      // Paired with `opencode.server_acquired`: without it, the start of the
      // idle-shutdown countdown is invisible in the logs.
      logServerEvent(logger, "opencode.server_released", entry, {
        ownerKind: owner?.kind ?? null,
        ownerId: owner?.id ?? null,
      });
      scheduleIdleShutdown(entry, logger);
    },
  };
}

/**
 * A lease on the server for `profile`, starting it when none runs.
 *
 * A caller's config replaces the profile's config file when it differs, so
 * the running server hot-reloads it. Concurrent first acquires share one launch.
 */
export async function acquireOpenCodeServer(args: {
  /** Required: the shared server is per set of project settings (`sharedOpenCodeProfileFor`). */
  profile: OpenCodeServerProfile;
  /**
   * The profile's config. Omit it to use a running server as it is (a caller
   * that only needs a client); a server started without one gets ADE's
   * defaults until a caller with a config updates it.
   */
  config?: OpenCodeServerConfig;
  /**
   * "replace" (default) writes the caller's config to a running server.
   * "if-starting" uses it only to start one: callers that build a narrower
   * config (inventory, auth, terminal) must not overwrite the chats' fuller one.
   * "providers" replaces only the running config's `providers`: a key change
   * reaches a running server and leaves the chats' skills and agents alone.
   */
  configMode?: "replace" | "if-starting" | "providers";
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const profile = args.profile;
  let entry = serverEntries.get(profile.key);
  if (entry?.closed) {
    serverEntries.delete(profile.key);
    entry = undefined;
  }
  if (!entry) {
    let pending = inFlightEntries.get(profile.key);
    if (!pending) {
      pending = startEntry({
        profile,
        config: args.config ?? { share: "disabled", update: "disable" },
        logger: args.logger,
      }).finally(() => {
        inFlightEntries.delete(profile.key);
      });
      inFlightEntries.set(profile.key, pending);
    }
    entry = await pending;
    // The server can exit while it loads its catalog, or a shutdown can close
    // it; a lease on it would fail on its first request.
    if (entry.closed) throw new Error("The OpenCode server stopped while it was starting. Try again.");
    serverEntries.set(profile.key, entry);
  }
  clearIdleTimer(entry);
  entry.refCount += 1;
  entry.lastUsedAt = Date.now();
  const lease = buildLease(entry, args.logger, { kind: args.ownerKind, id: args.ownerId ?? null });
  const configMode = args.configMode ?? "replace";
  try {
    if (args.config && configMode === "replace") lease.updateConfig(args.config);
    if (args.config && configMode === "providers") {
      const running = JSON.parse(entry.configJson) as OpenCodeServerConfig;
      const providers = (args.config as { providers?: unknown }).providers;
      const merged: Record<string, unknown> = { ...running };
      if (providers === undefined) delete merged.providers;
      else merged.providers = providers;
      lease.updateConfig(merged);
    }
  } catch (error) {
    // A failed config write must not leave a lease counted forever: the
    // server would never reach its idle shutdown.
    lease.release();
    throw error;
  }
  logServerEvent(args.logger, "opencode.server_acquired", entry, {
    ownerKind: args.ownerKind,
    ownerId: args.ownerId ?? null,
  });
  return lease;
}

/** The running server for `profile`, if any, without starting one. */
export function peekOpenCodeServerUrl(profile: OpenCodeServerProfile): string | null {
  const entry = serverEntries.get(profile.key);
  return entry && !entry.closed ? entry.server.url : null;
}

export function shutdownOpenCodeServers(filter: { key?: string } = {}, logger?: Logger | null): void {
  for (const entry of [...serverEntries.values()]) {
    if (filter.key && entry.key !== filter.key) continue;
    closeEntry(entry, "shutdown", logger);
  }
  // A server still starting is closed as soon as it is up; otherwise it would
  // outlive this process and wait for the next start's orphan recovery.
  for (const [key, pending] of inFlightEntries) {
    if (filter.key && key !== filter.key) continue;
    void pending.then((entry) => closeEntry(entry, "shutdown", logger), () => {});
  }
}

export function getOpenCodeRuntimeDiagnostics(): {
  servers: OpenCodeRuntimeDiagnosticsEntry[];
  orphanRecovery: OpenCodeOrphanRecoveryResult;
} {
  return {
    servers: [...serverEntries.values()].map((entry) => ({
      key: entry.key,
      url: entry.server.url,
      pid: entry.server.pid,
      isolated: entry.isolated,
      shared: entry.shared,
      refCount: entry.refCount,
      listenerCount: entry.listeners.size,
      startedAt: entry.startedAt,
      lastUsedAt: entry.lastUsedAt,
    })),
    orphanRecovery: lastOpenCodeOrphanRecovery(),
  };
}
