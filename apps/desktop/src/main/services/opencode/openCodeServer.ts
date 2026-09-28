import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import type { Logger } from "../logging/logger";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import {
  ADE_OPENCODE_XDG_LAYOUT_VERSION,
  resolveAdeOpenCodeIsolationPaths,
  resolveAdeOpenCodeRuntimeRoot,
  type OpenCodeIsolationPaths,
} from "../../../shared/opencodeDataHome";
import {
  killWindowsProcessTree,
  quoteWindowsCmdArg,
  resolveWindowsCmdLineInvocation,
  shouldUseWindowsCmdWrapper,
  windowsPowerShellCommand,
} from "../shared/processExecution";
import { parseProcessRows, terminateOrphanProcess as terminateProcessOrphan } from "../shared/processOrphans";
import { probeOpenCodeBinaryQuarantine, resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";

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
};

export const SHARED_OPENCODE_PROFILE: OpenCodeServerProfile = { key: "shared", isolated: false };

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
  /** Basic-auth header value a separate client (the terminal app) can reuse. */
  readonly authorization: string;
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

type OpenCodeProcessSnapshot = {
  pid: number;
  ppid: number;
  command: string;
};

type OpenCodeProcessController = {
  listProcesses(): OpenCodeProcessSnapshot[];
  listListeningPids(port: number): number[];
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  killProcessTree(pid: number): boolean;
  waitForMs(ms: number): Promise<void>;
};

export type OpenCodeOrphanRecoveryResult = {
  recoveredPids: number[];
  skippedPids: number[];
};

type ElectronLikeModule = {
  app?: {
    getPath(name: string): string;
  };
};

type OpenCodeServerEntry = {
  id: string;
  key: string;
  isolated: boolean;
  server: OpenCodeServerInstance;
  password: string;
  authorization: string;
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
const ORPHAN_RECOVERY_TERM_GRACE_MS = 250;
/** The shared server outlives a quiet spell; restarting it costs a cold boot. */
const SHARED_SERVER_IDLE_MS = 10 * 60_000;
/** A per-chat profile has no other users; free its memory soon after release. */
const PROFILE_SERVER_IDLE_MS = 60_000;
const EVENT_STREAM_RETRY_MIN_MS = 250;
const EVENT_STREAM_RETRY_MAX_MS = 5_000;
const OPENCODE_BASIC_AUTH_USER = "opencode";
const ADE_OPENCODE_MANAGED_ENV = "ADE_OPENCODE_MANAGED";
const ADE_OPENCODE_OWNER_PID_ENV = "ADE_OPENCODE_OWNER_PID";

const serverEntries = new Map<string, OpenCodeServerEntry>();
const inFlightEntries = new Map<string, Promise<OpenCodeServerEntry>>();
const protectedLaunchPorts = new Set<number>();

function commandLooksLikeOpenCodeServe(command: string): boolean {
  return /\bopencode(?:\.cmd|\.bat|\.exe)?\b/i.test(command) && /\bserve\b/i.test(command);
}

function readLinuxProcessEnvironment(pid: number): string[] {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return raw
      .split("\0")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function parseOneCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === "\"") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

/** Parses WMIC `process get ... /FORMAT:CSV` stdout into snapshots (exported for unit tests). */
export function parseWindowsWmicProcessCsv(stdout: string): OpenCodeProcessSnapshot[] {
  const rows: OpenCodeProcessSnapshot[] = [];
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return rows;

  const header = parseOneCsvLine(lines[0]!);
  const processIdIdx = header.indexOf("ProcessId");
  const parentProcessIdIdx = header.indexOf("ParentProcessId");
  const commandLineIdx = header.indexOf("CommandLine");
  if (processIdIdx < 0 || parentProcessIdIdx < 0 || commandLineIdx < 0) {
    return rows;
  }

  const maxIdx = Math.max(processIdIdx, parentProcessIdIdx, commandLineIdx);
  for (let li = 1; li < lines.length; li += 1) {
    const cells = parseOneCsvLine(lines[li]!);
    if (cells.length <= maxIdx) continue;
    const pid = Number(cells[processIdIdx]?.trim());
    const ppid = Number(cells[parentProcessIdIdx]?.trim());
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
      continue;
    }
    const command = (cells[commandLineIdx] ?? "").trim();
    rows.push({ pid, ppid, command });
  }
  return rows;
}

function listWindowsProcessesFromWmic(): OpenCodeProcessSnapshot[] {
  const result = spawnSync(
    "wmic",
    ["process", "get", "ProcessId,ParentProcessId,CommandLine", "/FORMAT:CSV"],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return parseWindowsWmicProcessCsv(result.stdout);
}

function listWindowsProcessesFromPowerShell(): OpenCodeProcessSnapshot[] {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
  const result = spawnSync(
    // The System32 path, so a poisoned PATH cannot answer the listing.
    windowsPowerShellCommand(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return parseWindowsWmicProcessCsv(result.stdout);
}

function listWindowsProcesses(): OpenCodeProcessSnapshot[] {
  const fromWmic = listWindowsProcessesFromWmic();
  if (fromWmic.length > 0 && fromWmic.every((process) => process.command.trim().length > 0)) {
    return fromWmic;
  }
  return listWindowsProcessesFromPowerShell();
}

function withDarwinCandidateEnvironments(rows: OpenCodeProcessSnapshot[]): OpenCodeProcessSnapshot[] {
  if (process.platform !== "darwin") return rows;
  const candidatePids = rows
    .filter((proc) => commandLooksLikeOpenCodeServe(proc.command))
    .map((proc) => proc.pid);
  if (candidatePids.length === 0) return rows;

  const result = spawnSync(
    "ps",
    ["-wwE", "-p", candidatePids.join(","), "-o", "pid=,ppid=,command="],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return rows;
  }

  const enrichedByPid = new Map(parseProcessRows(result.stdout).map((proc) => [proc.pid, proc]));
  return rows.map((proc) => enrichedByPid.get(proc.pid) ?? proc);
}

const defaultOpenCodeProcessController: OpenCodeProcessController = {
  listProcesses(): OpenCodeProcessSnapshot[] {
    if (process.platform === "win32") {
      return listWindowsProcesses();
    }
    const psArgs = process.platform === "linux"
      ? ["-ww", "-axo", "pid=,ppid=,command="]
      : ["-ww", "-axo", "pid=,ppid=,command="];
    const result = spawnSync("ps", psArgs, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    const rows = parseProcessRows(result.stdout);
    if (process.platform === "linux") {
      return rows.map((proc) => {
        if (!commandLooksLikeOpenCodeServe(proc.command)) return proc;
        return {
          ...proc,
          command: [proc.command, ...readLinuxProcessEnvironment(proc.pid)].join(" "),
        };
      });
    }
    return withDarwinCandidateEnvironments(rows);
  },
  listListeningPids(port: number): number[] {
    if (!Number.isInteger(port) || port <= 0) return [];
    if (process.platform === "win32") return [];
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  },
  isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killProcess(pid: number, signal: NodeJS.Signals): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  },
  killProcessTree(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === "win32") {
      // The trusted System32 `taskkill /T /F`, so a poisoned PATH cannot
      // answer the kill.
      return killWindowsProcessTree(pid, (detail) => {
        console.error("opencode.kill_process_tree_taskkill_failed", detail);
      });
    }
    // Unix: best-effort tree kill. Send SIGTERM to the process group first
    // (covers children spawned via setsid/group leader). Then walk any
    // descendants with pkill -TERM -P as a fallback. Finally SIGTERM the pid
    // itself so at minimum the root process terminates.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Not a group leader (or no permission); fall through to child-walk.
    }
    try {
      spawnSync("pkill", ["-TERM", "-P", String(pid)], { windowsHide: true });
    } catch {
      // pkill may be unavailable; ignore.
    }
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  },
  waitForMs(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};
let openCodeProcessController: OpenCodeProcessController = defaultOpenCodeProcessController;
let orphanRecoveryPromise: Promise<OpenCodeOrphanRecoveryResult> | null = null;
let lastOrphanRecoveryResult: OpenCodeOrphanRecoveryResult = {
  recoveredPids: [],
  skippedPids: [],
};
let orphanRecoveryCompleted = false;

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

function stopChildProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid && openCodeProcessController.killProcessTree(proc.pid)) {
    return;
  }
  proc.kill();
}

// `--port` may appear in a recorded command line either bare (`--port=N` or
// `--port N`) or wrapped in cmd.exe-style quotes (`"--port=N"` / `"--port" "N"`)
// because the Windows launch path quotes every token through
// {@link quoteWindowsCmdArg}. Allow leading/trailing `"` as a token boundary
// alongside whitespace so PID discovery still matches managed servers spawned
// via the Windows wrapper.
function commandHasPort(command: string, port: number): boolean {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s"])--port(?:=|\\s+|"\\s+")${escapedPort}(?:[\\s"]|$)`,
  ).test(command);
}

function parseManagedOpenCodePort(command: string): number | null {
  const match = command.match(/(?:^|[\s"])--port(?:=|\s+|"\s+")(\d+)(?:[\s"]|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
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

function resolveOpenCodeListenerPid(port: number): number | null {
  const listeningPids = openCodeProcessController.listListeningPids(port);
  if (listeningPids.length === 1) return listeningPids[0]!;
  if (listeningPids.length > 1) {
    const managed = openCodeProcessController.listProcesses()
      .filter((proc) => listeningPids.includes(proc.pid))
      .find((proc) => isManagedOpenCodeServeCommand(proc.command, buildManagedConfigMarkers()));
    return managed?.pid ?? listeningPids[0]!;
  }

  const configMarkers = buildManagedConfigMarkers();
  const matching = openCodeProcessController.listProcesses()
    .filter((proc) =>
      commandHasPort(proc.command, port)
      && isManagedOpenCodeServeCommand(proc.command, configMarkers)
    );
  if (matching.length === 0) return null;
  const nonNode = matching.find((proc) => !/\bnode(?:\.exe)?\b/i.test(proc.command));
  return (nonNode ?? matching[0]!).pid;
}

function terminateOpenCodeServerProcesses(proc: ChildProcess, listenerPid: number | null): void {
  const listenerHandled = listenerPid !== null && openCodeProcessController.isProcessAlive(listenerPid);
  if (listenerHandled) {
    if (process.platform === "win32") {
      openCodeProcessController.killProcessTree(listenerPid);
    } else {
      openCodeProcessController.killProcess(listenerPid, "SIGTERM");
    }
  }

  // When the listener PID matches the spawned child PID, the kill above already
  // signalled it -- do not double-kill the same process.
  if (listenerHandled && listenerPid === proc.pid) {
    return;
  }

  stopChildProcess(proc);
}

/**
 * Roots an older ADE could have written before the shared resolver existed.
 *
 * Orphan recovery must still reap a server launched under Electron `userData`;
 * no live code resolves a data home there any more (see
 * `shared/opencodeDataHome.ts` for why that split was a bug).
 */
function resolveLegacyManagedOpenCodeRoots(current: string): string[] {
  const roots: string[] = [];
  try {
    const electron = require("electron") as ElectronLikeModule;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      roots.push(path.resolve(userDataPath, "opencode-runtime"));
    }
  } catch {
    // Not running under Electron.
  }
  // A brain launched with ADE_HOME (or the XDG override) elsewhere may still
  // have old servers under the plain home root; Windows cannot see their env,
  // so the registry scan must know the path. This is the only way they get
  // reaped after an upgrade.
  const homeDir = os.homedir().trim();
  if (homeDir.length > 0) roots.push(path.resolve(homeDir, ".ade", "opencode-runtime"));
  return roots.filter((root) => path.resolve(root) !== path.resolve(current));
}

function resolveKnownAdeManagedOpenCodeRoots(): string[] {
  const current = resolveAdeOpenCodeRuntimeRoot();
  const roots = new Set<string>([current]);
  for (const legacy of resolveLegacyManagedOpenCodeRoots(current)) roots.add(legacy);
  return [...roots];
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

function buildManagedConfigMarkers(): string[] {
  const markers = new Set<string>();
  for (const root of resolveKnownAdeManagedOpenCodeRoots()) {
    const xdgRoot = path.join(root, `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`);
    markers.add(`XDG_CONFIG_HOME=${path.join(xdgRoot, "config")}`);
    markers.add(`OPENCODE_CONFIG_DIR=${path.join(xdgRoot, "config", "opencode")}`);
  }
  return [...markers];
}

function isManagedOpenCodeServeCommand(command: string, configMarkers: string[]): boolean {
  // Windows: managed markers are injected into the cmd.exe command line (WMIC/CIM omit child env).
  if (
    /\bcmd(?:\.exe)?\b/i.test(command)
    && command.includes(`${ADE_OPENCODE_MANAGED_ENV}=1`)
    && /\bopencode(?:\.cmd|\.bat|\.exe)?\b/i.test(command)
    && /\bserve\b/i.test(command)
  ) {
    return true;
  }
  if (!/\bopencode(?:\.cmd|\.bat|\.exe)?\b\s+serve\b/i.test(command)) return false;
  if (command.includes(`${ADE_OPENCODE_MANAGED_ENV}=1`)) return true;
  // Keep recognizing older isolated servers that predate the ownership marker.
  return command.includes("OPENCODE_DISABLE_PROJECT_CONFIG=1")
    && configMarkers.some((marker) => command.includes(marker));
}

/**
 * On-disk record of a server process ADE launched. Windows process listings do
 * not expose a child's environment, so the `ADE_OPENCODE_MANAGED` marker that
 * identifies managed servers in `ps -wwE` output on macOS (and `/proc/<pid>/environ`
 * on Linux) has no Windows equivalent. This registry is the platform-neutral
 * identity: it survives an ADE crash, so the next launch can reap the servers the
 * dead process left behind on every platform.
 */
type ManagedOpenCodeServerRecord = {
  pid: number;
  port: number;
  ownerPid: number;
  startedAt: number;
  /** The server's generated config, which holds provider keys; removed with the record. */
  configFile?: string;
};

function managedServerRegistryDirs(): string[] {
  return resolveKnownAdeManagedOpenCodeRoots().map((root) => (
    path.join(root, `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`, "runtime", "servers")
  ));
}

function managedServerRecordPath(pid: number): string {
  return path.join(
    resolveAdeOpenCodeIsolationPaths().runtimeDir,
    "servers",
    `${pid}.json`,
  );
}

function writeManagedServerRecord(record: ManagedOpenCodeServerRecord): void {
  try {
    const filePath = managedServerRecordPath(record.pid);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record), "utf8");
  } catch {
    // Recovery is best-effort; a registry write failure must not fail a launch.
  }
}

function removeManagedServerRecord(pid: number): void {
  for (const dir of managedServerRegistryDirs()) {
    const file = path.join(dir, `${pid}.json`);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagedOpenCodeServerRecord>;
      if (typeof record.configFile === "string") removeProfileConfig(record.configFile);
    } catch {
      // No record here, or an unreadable one.
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

function readManagedServerRecords(): Array<{ file: string; record: ManagedOpenCodeServerRecord }> {
  const out: Array<{ file: string; record: ManagedOpenCodeServerRecord }> = [];
  const seenPids = new Set<number>();
  for (const dir of managedServerRegistryDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagedOpenCodeServerRecord>;
        const pid = Number(parsed.pid);
        const ownerPid = Number(parsed.ownerPid);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0) {
          fs.rmSync(file, { force: true });
          continue;
        }
        if (seenPids.has(pid)) continue;
        seenPids.add(pid);
        out.push({
          file,
          record: {
            pid,
            ownerPid,
            port: Number.isInteger(Number(parsed.port)) ? Number(parsed.port) : 0,
            startedAt: Number.isFinite(Number(parsed.startedAt)) ? Number(parsed.startedAt) : 0,
            ...(typeof parsed.configFile === "string" ? { configFile: parsed.configFile } : {}),
          },
        });
      } catch {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
  return out;
}

function parseManagedOwnerPid(command: string): number | null {
  const match = command.match(new RegExp(`${ADE_OPENCODE_OWNER_PID_ENV}=(\\d+)`, "i"));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Terminate an orphaned managed server, escalating once if it survives the
 * grace period. Windows has no POSIX signals, so it uses a `taskkill /T /F`
 * tree kill on both passes; Unix escalates SIGTERM → SIGKILL.
 */
async function terminateOrphanProcess(pid: number): Promise<boolean> {
  const outcome = await terminateProcessOrphan(pid, {
    platform: process.platform,
    graceMs: ORPHAN_RECOVERY_TERM_GRACE_MS,
    isAlive: (target) => openCodeProcessController.isProcessAlive(target),
    waitMs: (ms) => openCodeProcessController.waitForMs(ms),
    kill: (target, signal) => openCodeProcessController.killProcess(target, signal),
    killTree: (target) => openCodeProcessController.killProcessTree(target),
  });
  return outcome === "exited";
}

export async function recoverManagedOpenCodeOrphans(args: {
  force?: boolean;
  logger?: Logger | null;
} = {}): Promise<OpenCodeOrphanRecoveryResult> {
  if (orphanRecoveryPromise) {
    const inFlightResult = await orphanRecoveryPromise;
    if (!args.force) {
      return inFlightResult;
    }
  }

  if (!args.force && orphanRecoveryCompleted) {
    return lastOrphanRecoveryResult;
  }

  const recoveryPromise = (async () => {
    const configMarkers = buildManagedConfigMarkers();
    const activePorts = activeManagedOpenCodePorts();
    const recoveredPids: number[] = [];
    const skippedPids: number[] = [];
    const handledPids = new Set<number>();
    const snapshot = openCodeProcessController.listProcesses();
    const commandByPid = new Map(snapshot.map((proc) => [proc.pid, proc.command]));

    for (const proc of snapshot) {
      if (proc.pid === process.pid) continue;
      if (!isManagedOpenCodeServeCommand(proc.command, configMarkers)) continue;

      const ownerPid = parseManagedOwnerPid(proc.command);
      if (ownerPid === process.pid) {
        const port = parseManagedOpenCodePort(proc.command);
        if (port != null && activePorts.has(port)) {
          skippedPids.push(proc.pid);
          continue;
        }
      }
      const ownerAlive = ownerPid != null
        && openCodeProcessController.isProcessAlive(ownerPid);
      const isOrphan = ownerPid != null
        ? !ownerAlive || ownerPid === process.pid
        : proc.ppid === 1;

      if (!isOrphan) {
        skippedPids.push(proc.pid);
        continue;
      }

      if (!await terminateOrphanProcess(proc.pid)) {
        skippedPids.push(proc.pid);
        args.logger?.warn("opencode.server_orphan_recovery_failed", {
          pid: proc.pid,
          ownerPid,
          ppid: proc.ppid,
        });
        continue;
      }
      handledPids.add(proc.pid);
      recoveredPids.push(proc.pid);
      args.logger?.warn("opencode.server_orphan_recovered", {
        pid: proc.pid,
        ownerPid,
        ppid: proc.ppid,
        port: parseManagedOpenCodePort(proc.command),
      });
      removeManagedServerRecord(proc.pid);
    }

    // Second pass: the on-disk registry. This is the only identity that works on
    // Windows, where a process listing cannot show a child's environment and the
    // managed markers therefore never appear on the server's command line.
    for (const { file, record } of readManagedServerRecords()) {
      if (record.pid === process.pid) continue;
      if (handledPids.has(record.pid)) continue;
      if (!openCodeProcessController.isProcessAlive(record.pid)) {
        removeManagedServerRecord(record.pid);
        continue;
      }
      // Guard against PID reuse: the live process must still look like an
      // OpenCode server before we are willing to kill it.
      const command = commandByPid.get(record.pid);
      if (command !== undefined && !commandLooksLikeOpenCodeServe(command)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
        continue;
      }
      const ownerAlive = record.ownerPid !== process.pid
        && openCodeProcessController.isProcessAlive(record.ownerPid);
      if (ownerAlive) {
        skippedPids.push(record.pid);
        continue;
      }
      if (record.ownerPid === process.pid && record.port > 0 && activePorts.has(record.port)) {
        skippedPids.push(record.pid);
        continue;
      }
      if (!await terminateOrphanProcess(record.pid)) {
        skippedPids.push(record.pid);
        args.logger?.warn("opencode.server_orphan_recovery_failed", {
          pid: record.pid,
          ownerPid: record.ownerPid,
          source: "registry",
        });
        continue;
      }
      handledPids.add(record.pid);
      recoveredPids.push(record.pid);
      args.logger?.warn("opencode.server_orphan_recovered", {
        pid: record.pid,
        ownerPid: record.ownerPid,
        port: record.port,
        source: "registry",
      });
      removeManagedServerRecord(record.pid);
    }

    lastOrphanRecoveryResult = { recoveredPids, skippedPids };
    orphanRecoveryCompleted = true;
    return lastOrphanRecoveryResult;
  })().finally(() => {
    orphanRecoveryPromise = null;
  });

  orphanRecoveryPromise = recoveryPromise;
  return await recoveryPromise;
}

/**
 * Where a profile's generated config file lives: one file per profile and
 * process. The file holds provider keys, so it lives only as long as its
 * server, and two brains on one ADE home never share (or delete) one file.
 */
function profileConfigFile(paths: OpenCodeIsolationPaths, key: string): string {
  const safe = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(paths.root, "config-ade", `${safe}.${process.pid}.json`);
}

function isProfileConfigFile(file: string): boolean {
  const dir = path.resolve(resolveAdeOpenCodeIsolationPaths().root, "config-ade");
  const resolved = path.resolve(file);
  return path.dirname(resolved) === dir && resolved.endsWith(".json");
}

function removeProfileConfig(file: string): void {
  // A registry record is data on disk: never delete a path it names outside the config directory.
  if (!isProfileConfigFile(file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
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

    const fail = (error: Error): void => {
      cleanupStartup();
      stopChildProcess(proc);
      if (proc.pid) removeManagedServerRecord(proc.pid);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${OPEN_CODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPEN_CODE_SERVER_START_TIMEOUT_MS);

    const onStdout = (chunk: Buffer): void => {
      if (resolved) return;
      output += chunk.toString();
      for (const line of output.split("\n")) {
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
      if (proc.pid) removeManagedServerRecord(proc.pid);
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

function closeEntry(entry: OpenCodeServerEntry, reason: string, logger?: Logger | null): void {
  if (entry.closed) return;
  entry.closed = true;
  clearIdleTimer(entry);
  entry.streamAbort?.abort();
  if (serverEntries.get(entry.key) === entry) serverEntries.delete(entry.key);
  unprotectLaunchPortForUrl(entry.server.url);
  try {
    entry.server.close();
  } catch {
    // ignore shutdown failures
  }
  removeProfileConfig(entry.configFile);
  logServerEvent(logger, "opencode.server_shutdown", entry, { reason });
}

function scheduleIdleShutdown(entry: OpenCodeServerEntry, logger?: Logger | null): void {
  clearIdleTimer(entry);
  if (entry.refCount > 0 || entry.closed) return;
  const idleMs = entry.key === SHARED_OPENCODE_PROFILE.key ? SHARED_SERVER_IDLE_MS : PROFILE_SERVER_IDLE_MS;
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
    id: randomUUID(),
    key: args.profile.key,
    isolated: args.profile.isolated,
    server,
    password,
    authorization,
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
    entry.closed = true;
    removeProfileConfig(entry.configFile);
    clearIdleTimer(entry);
    entry.streamAbort?.abort();
    if (serverEntries.get(entry.key) === entry) serverEntries.delete(entry.key);
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

function buildLease(entry: OpenCodeServerEntry, logger?: Logger | null): OpenCodeServerLease {
  let released = false;
  const ownListeners = new Set<OpenCodeEventListener>();
  return {
    key: entry.key,
    url: entry.server.url,
    authorization: entry.authorization,
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
  profile?: OpenCodeServerProfile;
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
  const profile = args.profile ?? SHARED_OPENCODE_PROFILE;
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
  const lease = buildLease(entry, args.logger);
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

/** The running shared server, if any, without starting one. */
export function peekSharedOpenCodeServerUrl(): string | null {
  const entry = serverEntries.get(SHARED_OPENCODE_PROFILE.key);
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
      refCount: entry.refCount,
      listenerCount: entry.listeners.size,
      startedAt: entry.startedAt,
      lastUsedAt: entry.lastUsedAt,
    })),
    orphanRecovery: lastOrphanRecoveryResult,
  };
}
