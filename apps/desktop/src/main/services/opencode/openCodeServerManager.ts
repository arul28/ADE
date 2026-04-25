import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Config as OpenCodeConfig } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import { stableStringify } from "../shared/utils";
import { processOutputToString, quoteWindowsCmdArg, resolveWindowsCmdInvocation } from "../shared/processExecution";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";

export type OpenCodeServerLeaseKind = "shared" | "dedicated";
export type OpenCodeServerOwnerKind = "inventory" | "oneshot" | "chat" | "coordinator";
export type OpenCodeServerShutdownReason =
  | "handle_close"
  | "attach_failed"
  | "idle_ttl"
  | "paused_run"
  | "ended_session"
  | "model_switch"
  | "project_close"
  | "budget_eviction"
  | "pool_compaction"
  | "shutdown"
  | "config_changed"
  | "error";

type OpenCodeServerInstance = {
  url: string;
  close(): void;
};

type OpenCodeServerLaunchArgs = {
  port: number;
  config: OpenCodeConfig;
};

type OpenCodeIsolationPaths = {
  root: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  runtimeDir: string;
};

type OpenCodeServeLaunchSpec = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  useShell: boolean;
  xdgPaths: OpenCodeIsolationPaths;
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

type OpenCodeServerLauncher = (args: OpenCodeServerLaunchArgs) => Promise<OpenCodeServerInstance>;
type ElectronLikeModule = {
  app?: {
    getPath(name: string): string;
  };
};

type OpenCodeServerEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  server: OpenCodeServerInstance;
  idleTtlMs: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
  busy: boolean;
  onEvict: ((reason: OpenCodeServerShutdownReason) => void) | null;
  startedAt: number;
  lastUsedAt: number;
};

export type OpenCodeServerLease = {
  url: string;
  release(reason?: OpenCodeServerShutdownReason): void;
  close(reason?: OpenCodeServerShutdownReason): void;
  touch(): void;
  setBusy(busy: boolean): void;
  setEvictionHandler(handler: ((reason: OpenCodeServerShutdownReason) => void) | null): void;
};

export type OpenCodeRuntimeDiagnosticsEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  url: string;
  busy: boolean;
  refCount: number;
  startedAt: number;
  lastUsedAt: number;
};

const PORT_RETRY_ATTEMPTS = 3;
const DEFAULT_SHARED_IDLE_TTL_MS = 15_000;
const MAX_DEDICATED_OPENCODE_SERVERS = 6;
const OPEN_CODE_SERVER_START_TIMEOUT_MS = 15_000;
const ORPHAN_RECOVERY_TERM_GRACE_MS = 250;
const ADE_OPENCODE_XDG_LAYOUT_VERSION = 1;
const ADE_OPENCODE_MANAGED_ENV = "ADE_OPENCODE_MANAGED";
const ADE_OPENCODE_OWNER_PID_ENV = "ADE_OPENCODE_OWNER_PID";

const sharedEntries = new Map<string, OpenCodeServerEntry>();
const dedicatedEntries = new Map<string, OpenCodeServerEntry>();
const inFlightEntries = new Map<string, Promise<OpenCodeServerEntry>>();
const acquireQueues = new Map<string, Array<() => void>>();
const protectedLaunchPorts = new Set<number>();
let openCodeServerLauncher: OpenCodeServerLauncher = defaultOpenCodeServerLauncher;

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
    "powershell.exe",
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

const defaultOpenCodeProcessController: OpenCodeProcessController = {
  listProcesses(): OpenCodeProcessSnapshot[] {
    if (process.platform === "win32") {
      return listWindowsProcesses();
    }
    const psArgs = process.platform === "linux"
      ? ["-ww", "-axo", "pid=,ppid=,command="]
      : ["-wwE", "-axo", "pid=,ppid=,command="];
    const result = spawnSync("ps", psArgs, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    const rows: OpenCodeProcessSnapshot[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: process.platform === "linux"
          ? [match[3], ...readLinuxProcessEnvironment(Number(match[1]))].join(" ")
          : match[3],
      });
    }
    return rows;
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
      try {
        const out = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        if (!out.error && out.status === 0) {
          return true;
        }
        console.error("opencode.kill_process_tree_taskkill_failed", {
          pid,
          status: out.status,
          stdout: processOutputToString(out.stdout),
          stderr: processOutputToString(out.stderr),
          error: out.error,
        });
      } catch (error) {
        console.error("opencode.kill_process_tree_taskkill_failed", { pid, error });
      }
      return false;
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

function serializeConfigFingerprint(config: OpenCodeConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

async function withAcquireLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = acquireQueues.get(lockKey);
  if (queue) {
    queue.push(release);
    await gate;
  } else {
    acquireQueues.set(lockKey, [release]);
    release();
  }

  try {
    return await fn();
  } finally {
    const currentQueue = acquireQueues.get(lockKey);
    if (currentQueue) {
      currentQueue.shift();
      const next = currentQueue[0];
      if (next) {
        next();
      } else {
        acquireQueues.delete(lockKey);
      }
    }
  }
}

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

function stopChildProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid && openCodeProcessController.killProcessTree(proc.pid)) {
    return;
  }
  proc.kill();
}

function commandHasPort(command: string, port: number): boolean {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)--port(?:=|\\s+)${escapedPort}(?:\\s|$)`).test(command);
}

function parseManagedOpenCodePort(command: string): number | null {
  const match = command.match(/(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

function activeManagedOpenCodePorts(): Set<number> {
  const ports = new Set<number>(protectedLaunchPorts);
  for (const entry of [...sharedEntries.values(), ...dedicatedEntries.values()]) {
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

function resolveAdeManagedOpenCodeRoot(): string {
  const override = process.env.ADE_OPENCODE_XDG_ROOT?.trim();
  if (override) return path.resolve(override);
  try {
    const electron = require("electron") as ElectronLikeModule;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      return path.resolve(userDataPath, "opencode-runtime");
    }
  } catch {
    // Ignore when running outside Electron, such as unit tests.
  }
  const homeDir = os.homedir().trim();
  if (homeDir.length > 0) {
    return path.resolve(homeDir, ".ade", "opencode-runtime");
  }
  return path.resolve(os.tmpdir(), "ade-opencode-runtime");
}

function resolveHomeManagedOpenCodeRoot(): string | null {
  const homeDir = os.homedir().trim();
  if (!homeDir.length) return null;
  return path.resolve(homeDir, ".ade", "opencode-runtime");
}

function resolveKnownAdeManagedOpenCodeRoots(): string[] {
  const roots = new Set<string>();
  roots.add(resolveAdeManagedOpenCodeRoot());
  const homeRoot = resolveHomeManagedOpenCodeRoot();
  if (homeRoot) roots.add(homeRoot);
  return [...roots];
}

function resolveOpenCodeIsolationPaths(): OpenCodeIsolationPaths {
  const root = path.join(
    resolveAdeManagedOpenCodeRoot(),
    `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`,
  );
  return {
    root,
    configHome: path.join(root, "config"),
    dataHome: path.join(root, "data"),
    stateHome: path.join(root, "state"),
    cacheHome: path.join(root, "cache"),
    runtimeDir: path.join(root, "runtime"),
  };
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

function buildIsolatedOpenCodeEnv(
  config: OpenCodeConfig,
  paths: OpenCodeIsolationPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("OPENCODE_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_RUNTIME_DIR: paths.runtimeDir,
    OPENCODE_CONFIG_DIR: path.join(paths.configHome, "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    [ADE_OPENCODE_MANAGED_ENV]: "1",
    [ADE_OPENCODE_OWNER_PID_ENV]: String(process.pid),
  };
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
    return command.includes("OPENCODE_DISABLE_PROJECT_CONFIG=1");
  }
  if (!/\bopencode(?:\.cmd|\.bat|\.exe)?\b\s+serve\b/i.test(command)) return false;
  if (!command.includes("OPENCODE_DISABLE_PROJECT_CONFIG=1")) return false;
  if (command.includes(`${ADE_OPENCODE_MANAGED_ENV}=1`)) return true;
  return configMarkers.some((marker) => command.includes(marker));
}

function parseManagedOwnerPid(command: string): number | null {
  const match = command.match(new RegExp(`${ADE_OPENCODE_OWNER_PID_ENV}=(\\d+)`, "i"));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 50));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!openCodeProcessController.isProcessAlive(pid)) {
      return true;
    }
    await openCodeProcessController.waitForMs(50);
  }
  return !openCodeProcessController.isProcessAlive(pid);
}

function pruneIdleSharedEntries(
  excludeKey: string | null,
  logger?: Logger | null,
): void {
  for (const entry of [...sharedEntries.values()]) {
    if (excludeKey && entry.key === excludeKey) continue;
    if (entry.refCount > 0) continue;
    shutdownEntry(entry, "pool_compaction", logger);
  }
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

    for (const proc of openCodeProcessController.listProcesses()) {
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

      if (process.platform === "win32") {
        openCodeProcessController.killProcessTree(proc.pid);
        const exitedGracefully = await waitForProcessExit(proc.pid, ORPHAN_RECOVERY_TERM_GRACE_MS);
        if (!exitedGracefully && openCodeProcessController.isProcessAlive(proc.pid)) {
          openCodeProcessController.killProcessTree(proc.pid);
          const exitedAfterKill = await waitForProcessExit(proc.pid, ORPHAN_RECOVERY_TERM_GRACE_MS);
          if (!exitedAfterKill && openCodeProcessController.isProcessAlive(proc.pid)) {
            skippedPids.push(proc.pid);
            args.logger?.warn("opencode.server_orphan_recovery_failed", {
              pid: proc.pid,
              ownerPid,
              ppid: proc.ppid,
            });
            continue;
          }
        }
      } else {
        openCodeProcessController.killProcess(proc.pid, "SIGTERM");
        const exitedGracefully = await waitForProcessExit(proc.pid, ORPHAN_RECOVERY_TERM_GRACE_MS);
        if (!exitedGracefully && openCodeProcessController.isProcessAlive(proc.pid)) {
          openCodeProcessController.killProcess(proc.pid, "SIGKILL");
          const exitedAfterKill = await waitForProcessExit(proc.pid, ORPHAN_RECOVERY_TERM_GRACE_MS);
          if (!exitedAfterKill && openCodeProcessController.isProcessAlive(proc.pid)) {
            skippedPids.push(proc.pid);
            args.logger?.warn("opencode.server_orphan_recovery_failed", {
              pid: proc.pid,
              ownerPid,
              ppid: proc.ppid,
            });
            continue;
          }
        }
      }
      recoveredPids.push(proc.pid);
      args.logger?.warn("opencode.server_orphan_recovered", {
        pid: proc.pid,
        ownerPid,
        ppid: proc.ppid,
        port: parseManagedOpenCodePort(proc.command),
      });
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

function buildOpenCodeServeLaunchSpec(args: OpenCodeServerLaunchArgs): OpenCodeServeLaunchSpec {
  const executable = resolveOpenCodeBinaryPath();
  if (!executable) {
    throw new Error("OpenCode executable is not available.");
  }
  const xdgPaths = resolveOpenCodeIsolationPaths();
  ensureOpenCodeIsolationDirs(xdgPaths);
  const env = buildIsolatedOpenCodeEnv(args.config, xdgPaths);
  if (process.platform === "win32") {
    const invocation = resolveWindowsCmdInvocation(
      executable,
      ["serve", "--hostname=127.0.0.1", `--port=${args.port}`],
      env,
    );
    const cmdLine =
      `set ${quoteWindowsCmdArg(`${ADE_OPENCODE_MANAGED_ENV}=1`)}`
      + `&&set ${quoteWindowsCmdArg("OPENCODE_DISABLE_PROJECT_CONFIG=1")}`
      + `&&set ${quoteWindowsCmdArg(`${ADE_OPENCODE_OWNER_PID_ENV}=${process.pid}`)}`
      + `&&${invocation.args[3] ?? ""}`;
    return {
      executable: invocation.command,
      args: ["/d", "/s", "/c", cmdLine],
      env,
      useShell: false,
      xdgPaths,
    };
  }

  return {
    executable,
    args: [
      "serve",
      "--hostname=127.0.0.1",
      `--port=${args.port}`,
    ],
    env,
    useShell: false,
    xdgPaths,
  };
}

async function defaultOpenCodeServerLauncher(
  args: OpenCodeServerLaunchArgs,
): Promise<OpenCodeServerInstance> {
  const launchSpec = buildOpenCodeServeLaunchSpec(args);
  const proc = spawn(launchSpec.executable, launchSpec.args, {
    env: launchSpec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
    shell: launchSpec.useShell,
  });

  let output = "";
  let resolved = false;

  return await new Promise<OpenCodeServerInstance>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    const fail = (error: Error): void => {
      cleanup();
      stopChildProcess(proc);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${OPEN_CODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPEN_CODE_SERVER_START_TIMEOUT_MS);

    const onStdout = (chunk: Buffer): void => {
      if (resolved) return;
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          fail(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        resolved = true;
        cleanup();
        const listenerPid = resolveOpenCodeListenerPid(args.port) ?? proc.pid ?? null;
        resolve({
          url: match[1],
          close() {
            cleanup();
            terminateOpenCodeServerProcesses(proc, listenerPid);
          },
        });
        return;
      }
    };

    const onStderr = (chunk: Buffer): void => {
      output += chunk.toString();
    };

    const onExit = (code: number | null): void => {
      if (resolved) return;
      cleanup();
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
  });
}

async function createOpencodeServerWithRetry(
  config: OpenCodeConfig,
): Promise<OpenCodeServerInstance> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt += 1) {
    const port = await findAvailablePort();
    protectedLaunchPorts.add(port);
    try {
      return await openCodeServerLauncher({ port, config });
    } catch (error) {
      protectedLaunchPorts.delete(port);
      lastError = error;
      if (!isPortConflict(error)) throw error;
    }
  }
  throw lastError;
}

function logRuntimeEvent(
  logger: Logger | null | undefined,
  event: string,
  entry: OpenCodeServerEntry,
  extra: Record<string, unknown> = {},
): void {
  logger?.info(event, {
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    ...extra,
  });
}

function clearIdleTimer(entry: OpenCodeServerEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function removeEntry(entry: OpenCodeServerEntry): void {
  clearIdleTimer(entry);
  if (entry.leaseKind === "shared") {
    sharedEntries.delete(entry.key);
    return;
  }
  dedicatedEntries.delete(entry.key);
}

function shutdownEntry(
  entry: OpenCodeServerEntry,
  reason: OpenCodeServerShutdownReason,
  logger?: Logger | null,
): void {
  removeEntry(entry);
  try {
    entry.server.close();
  } catch {
    // ignore shutdown failures
  }
  logRuntimeEvent(logger, "opencode.server_shutdown", entry, { reason });
  void recoverManagedOpenCodeOrphans({ force: true, logger }).catch(() => {});
}

function scheduleSharedIdleTimer(
  entry: OpenCodeServerEntry,
  logger?: Logger | null,
): void {
  clearIdleTimer(entry);
  if (!entry.idleTtlMs || entry.refCount > 0) return;
  entry.idleTimer = setTimeout(() => {
    const current = sharedEntries.get(entry.key);
    if (!current || current.id !== entry.id || current.refCount > 0) return;
    shutdownEntry(current, "idle_ttl", logger);
  }, entry.idleTtlMs);
  if (entry.idleTimer.unref) entry.idleTimer.unref();
}

function buildLease(entry: OpenCodeServerEntry, logger?: Logger | null): OpenCodeServerLease {
  let released = false;
  const touch = (): void => {
    entry.lastUsedAt = Date.now();
  };
  const release = (reason: OpenCodeServerShutdownReason = "handle_close"): void => {
    if (released) return;
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();
    logRuntimeEvent(logger, "opencode.server_released", entry, { reason, refCount: entry.refCount });
    if (entry.leaseKind === "shared") {
      if (entry.refCount === 0 && reason === "error") {
        shutdownEntry(entry, reason, logger);
        return;
      }
      scheduleSharedIdleTimer(entry, logger);
      return;
    }
    if (entry.refCount === 0) {
      shutdownEntry(entry, reason, logger);
    }
  };
  touch();
  return {
    url: entry.server.url,
    release,
    close(reason = "handle_close") {
      release(reason);
    },
    touch,
    setBusy(busy: boolean) {
      entry.busy = busy;
      entry.lastUsedAt = Date.now();
    },
    setEvictionHandler(handler) {
      entry.onEvict = handler;
    },
  };
}

function pickDedicatedEvictionCandidate(excludeKey?: string): OpenCodeServerEntry | null {
  let oldest: OpenCodeServerEntry | null = null;
  for (const entry of dedicatedEntries.values()) {
    if (entry.key === excludeKey) continue;
    if (entry.busy || entry.refCount > 0) continue;
    if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
      oldest = entry;
    }
  }
  return oldest;
}

function enforceDedicatedBudget(
  logger?: Logger | null,
  excludeKey?: string,
): void {
  if (dedicatedEntries.size < MAX_DEDICATED_OPENCODE_SERVERS) return;
  const candidate = pickDedicatedEvictionCandidate(excludeKey);
  if (!candidate) {
    throw new Error(
      `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). Close or wait for an idle chat/mission runtime before starting another OpenCode session.`,
    );
  }
  candidate.onEvict?.("budget_eviction");
  const stillPresent = dedicatedEntries.get(candidate.key);
  if (stillPresent) {
    if (stillPresent.refCount > 0 || stillPresent.busy) {
      throw new Error(
        `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). The selected eviction candidate is still leased and cannot be reclaimed safely.`,
      );
    }
    shutdownEntry(stillPresent, "budget_eviction", logger);
  }
}

async function createEntry(args: {
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  config: OpenCodeConfig;
  configFingerprint: string;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerEntry> {
  const inflightKey = `${args.leaseKind}:${args.key}:${args.configFingerprint}`;
  const existingPromise = inFlightEntries.get(inflightKey);
  if (existingPromise) return await existingPromise;

  const createPromise = (async () => {
    await recoverManagedOpenCodeOrphans({ logger: args.logger });
    const server = await createOpencodeServerWithRetry(args.config);
    const entry: OpenCodeServerEntry = {
      id: randomUUID(),
      key: args.key,
      leaseKind: args.leaseKind,
      ownerKind: args.ownerKind,
      ownerId: args.ownerId?.trim() || null,
      configFingerprint: args.configFingerprint,
      server,
      idleTtlMs: args.leaseKind === "shared" ? args.idleTtlMs ?? DEFAULT_SHARED_IDLE_TTL_MS : null,
      idleTimer: null,
      refCount: 0,
      busy: false,
      onEvict: null,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    logRuntimeEvent(args.logger, "opencode.server_started", entry);
    return entry;
  })().finally(() => {
    inFlightEntries.delete(inflightKey);
  });

  inFlightEntries.set(inflightKey, createPromise);
  return await createPromise;
}

export async function acquireSharedOpenCodeServer(args: {
  config: OpenCodeConfig;
  key?: string;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const configFingerprint = serializeConfigFingerprint(args.config);
  const key = args.key?.trim() || configFingerprint;
  return await withAcquireLock(`shared:${key}`, async () => {
    while (true) {
      const existing = sharedEntries.get(key);
      if (existing && existing.configFingerprint === configFingerprint) {
        clearIdleTimer(existing);
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        pruneIdleSharedEntries(key, args.logger);
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_rejected", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        throw new Error(
          `Shared OpenCode server for key "${key}" is still in use (refCount=${existing.refCount}) with a different config. Cannot acquire a lease with the requested configuration.`
        );
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      const entry = await createEntry({
        key,
        leaseKind: "shared",
        ownerKind: args.ownerKind ?? "oneshot",
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        idleTtlMs: args.idleTtlMs,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        unprotectLaunchPortForUrl(entry.server.url);
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      sharedEntries.set(key, entry);
      unprotectLaunchPortForUrl(entry.server.url);
      pruneIdleSharedEntries(key, args.logger);
      return buildLease(entry, args.logger);
    }
  });
}

export async function acquireDedicatedOpenCodeServer(args: {
  ownerKey: string;
  config: OpenCodeConfig;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const ownerKey = args.ownerKey.trim();
  if (!ownerKey.length) {
    throw new Error("ownerKey is required for dedicated OpenCode servers.");
  }
  const configFingerprint = serializeConfigFingerprint(args.config);
  return await withAcquireLock(`dedicated:${ownerKey}`, async () => {
    while (true) {
      const existing = dedicatedEntries.get(ownerKey);
      if (existing && existing.configFingerprint === configFingerprint) {
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_rejected", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        throw new Error(
          `Dedicated OpenCode server for "${ownerKey}" is still in use (refCount=${existing.refCount}) with a different config. Cannot acquire a lease with the requested configuration.`
        );
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      enforceDedicatedBudget(args.logger, ownerKey);
      const entry = await createEntry({
        key: ownerKey,
        leaseKind: "dedicated",
        ownerKind: args.ownerKind,
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        unprotectLaunchPortForUrl(entry.server.url);
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      dedicatedEntries.set(ownerKey, entry);
      unprotectLaunchPortForUrl(entry.server.url);
      return buildLease(entry, args.logger);
    }
  });
}

export function shutdownOpenCodeServers(filter: {
  leaseKind?: OpenCodeServerLeaseKind;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
} = {}): void {
  const matches = (entry: OpenCodeServerEntry): boolean => {
    if (filter.leaseKind && entry.leaseKind !== filter.leaseKind) return false;
    if (filter.ownerKind && entry.ownerKind !== filter.ownerKind) return false;
    if (filter.ownerId !== undefined && entry.ownerId !== (filter.ownerId?.trim() || null)) return false;
    return true;
  };
  for (const entry of [...sharedEntries.values(), ...dedicatedEntries.values()]) {
    if (!matches(entry)) continue;
    shutdownEntry(entry, "shutdown");
  }
}

export function getOpenCodeRuntimeDiagnostics(): {
  sharedCount: number;
  dedicatedCount: number;
  entries: OpenCodeRuntimeDiagnosticsEntry[];
} {
  const entries = [...sharedEntries.values(), ...dedicatedEntries.values()].map((entry) => ({
    id: entry.id,
    key: entry.key,
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    busy: entry.busy,
    refCount: entry.refCount,
    startedAt: entry.startedAt,
    lastUsedAt: entry.lastUsedAt,
  }));
  return {
    sharedCount: sharedEntries.size,
    dedicatedCount: dedicatedEntries.size,
    entries,
  };
}

export function __resetOpenCodeServerManagerForTests(): void {
  shutdownOpenCodeServers();
  inFlightEntries.clear();
  acquireQueues.clear();
  openCodeServerLauncher = defaultOpenCodeServerLauncher;
  openCodeProcessController = defaultOpenCodeProcessController;
  orphanRecoveryPromise = null;
  lastOrphanRecoveryResult = { recoveredPids: [], skippedPids: [] };
  orphanRecoveryCompleted = false;
}

export function __setOpenCodeServerLauncherForTests(
  launcher: OpenCodeServerLauncher | null,
): void {
  openCodeServerLauncher = launcher ?? defaultOpenCodeServerLauncher;
}

export function __setOpenCodeProcessControllerForTests(
  controller: Partial<OpenCodeProcessController> | null,
): void {
  openCodeProcessController = controller
    ? {
        listProcesses: controller.listProcesses ?? (() => []),
        listListeningPids: controller.listListeningPids ?? (() => []),
        isProcessAlive: controller.isProcessAlive ?? (() => false),
        killProcess: controller.killProcess ?? (() => {}),
        killProcessTree: controller.killProcessTree ?? (() => false),
        waitForMs: controller.waitForMs ?? (async () => {}),
      }
    : defaultOpenCodeProcessController;
  orphanRecoveryPromise = null;
  lastOrphanRecoveryResult = { recoveredPids: [], skippedPids: [] };
  orphanRecoveryCompleted = false;
}

export function __buildOpenCodeServeLaunchSpecForTests(args: {
  config: OpenCodeConfig;
  port?: number;
}): OpenCodeServeLaunchSpec {
  return buildOpenCodeServeLaunchSpec({
    port: args.port ?? 4096,
    config: args.config,
  });
}

export function __resolveOpenCodeListenerPidForTests(port: number): number | null {
  return resolveOpenCodeListenerPid(port);
}

/** Test hook: whether a WMIC/CIM command line would be treated as an ADE-managed OpenCode serve. */
export function __isManagedOpenCodeServeCommandForTests(command: string): boolean {
  return isManagedOpenCodeServeCommand(command, buildManagedConfigMarkers());
}

export function __terminateOpenCodeServerProcessesForTests(
  proc: ChildProcess,
  listenerPid: number | null,
): void {
  terminateOpenCodeServerProcesses(proc, listenerPid);
}
