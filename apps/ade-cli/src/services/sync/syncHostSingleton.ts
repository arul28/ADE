import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SYNC_HOST_PORT } from "./syncProtocol";

const SYNC_HOST_MAX_PORT = 8999;
const LOCK_VERSION = 1;

export type SyncHostSingletonOwner = {
  id: string;
  pid: number;
  port: number | null;
  appName: string | null;
  packageChannel: string | null;
  adeHome: string | null;
  serviceName: string | null;
  socketPath: string | null;
  projectRoot: string | null;
  commandLine: string | null;
  quitCommand: string;
  createdAt: string;
  updatedAt: string;
};

type SyncHostSingletonLockFile = {
  version: number;
  owner: SyncHostSingletonOwner;
};

export type SyncHostSingletonConflict = {
  owner: SyncHostSingletonOwner;
  reason: "lock" | "listener";
};

export type SyncHostSingletonLease = {
  owner: SyncHostSingletonOwner;
  updatePort: (port: number) => void;
  dispose: () => void;
};

export type SyncHostSingletonDeps = {
  lockPath?: string;
  pidAlive?: (pid: number) => boolean;
  scanListeners?: () => SyncHostSingletonOwner[];
};

export class SyncHostSingletonConflictError extends Error {
  readonly conflict: SyncHostSingletonConflict;

  constructor(conflict: SyncHostSingletonConflict) {
    super(formatSyncHostSingletonConflictMessage(conflict));
    this.name = "SyncHostSingletonConflictError";
    this.conflict = conflict;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function userId(): string {
  try {
    return String(typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid);
  } catch {
    return "user";
  }
}

export function syncHostSingletonLockPath(): string {
  const override = process.env.ADE_SYNC_HOST_LOCK_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), `ade-sync-host-${userId()}.json`);
}

function isTestProcess(): boolean {
  return Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === "test");
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeReadLock(lockPath: string): SyncHostSingletonLockFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const owner = record.owner;
    if (record.version !== LOCK_VERSION || !owner || typeof owner !== "object" || Array.isArray(owner)) {
      return null;
    }
    const row = owner as Record<string, unknown>;
    const pid = typeof row.pid === "number" ? row.pid : Number(row.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      version: LOCK_VERSION,
      owner: {
        id: typeof row.id === "string" && row.id.trim() ? row.id : "unknown",
        pid,
        port: typeof row.port === "number" && Number.isFinite(row.port) ? row.port : null,
        appName: typeof row.appName === "string" && row.appName.trim() ? row.appName : null,
        packageChannel: typeof row.packageChannel === "string" && row.packageChannel.trim() ? row.packageChannel : null,
        adeHome: typeof row.adeHome === "string" && row.adeHome.trim() ? row.adeHome : null,
        serviceName: typeof row.serviceName === "string" && row.serviceName.trim() ? row.serviceName : null,
        socketPath: typeof row.socketPath === "string" && row.socketPath.trim() ? row.socketPath : null,
        projectRoot: typeof row.projectRoot === "string" && row.projectRoot.trim() ? row.projectRoot : null,
        commandLine: typeof row.commandLine === "string" && row.commandLine.trim() ? row.commandLine : null,
        quitCommand: typeof row.quitCommand === "string" && row.quitCommand.trim()
          ? row.quitCommand
          : buildQuitCommand({ pid, commandLine: null, appName: null, packageChannel: null, adeHome: null }),
        createdAt: typeof row.createdAt === "string" && row.createdAt.trim() ? row.createdAt : new Date().toISOString(),
        updatedAt: typeof row.updatedAt === "string" && row.updatedAt.trim() ? row.updatedAt : new Date().toISOString(),
      },
    };
  } catch {
    return null;
  }
}

function writeLock(lockPath: string, owner: SyncHostSingletonOwner, flag: "wx" | "w"): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({ version: LOCK_VERSION, owner }, null, 2)}\n`, {
    encoding: "utf8",
    flag,
    mode: 0o600,
  });
}

function unlinkLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // best effort
  }
}

function normalizePort(port: number | null | undefined): number | null {
  if (!Number.isFinite(port)) return null;
  const parsed = Math.floor(Number(port));
  return parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

function normalizedChannel(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function defaultAppName(channel: string | null): string {
  if (channel === "beta") return "ADE Beta";
  if (channel === "alpha") return "ADE Alpha";
  return "ADE";
}

function commandLineText(): string {
  const args = process.argv.filter((value) => value && value.trim());
  return [process.execPath, ...args.slice(1)].join(" ");
}

function buildQuitCommand(args: {
  pid: number;
  commandLine: string | null;
  appName: string | null;
  packageChannel: string | null;
  adeHome: string | null;
}): string {
  const commandLine = args.commandLine ?? "";
  const channel = normalizedChannel(args.packageChannel)
    ?? (/ADE Beta\.app|ade-beta|\bADE Beta\b/i.test(commandLine) ? "beta" : null)
    ?? (/ADE Alpha\.app|ade-alpha|\bADE Alpha\b/i.test(commandLine) ? "alpha" : null);
  const adeHome = args.adeHome
    ?? (channel === "beta" ? path.join(os.homedir(), ".ade-beta") : null)
    ?? (channel === "alpha" ? path.join(os.homedir(), ".ade-alpha") : null)
    ?? path.join(os.homedir(), ".ade");
  if (channel === "beta") {
    const betaCli = "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta";
    return `ADE_PACKAGE_CHANNEL=beta ADE_HOME=${shellQuote(adeHome)} ${shellQuote(betaCli)} brain stop --text`;
  }
  if (channel === "alpha") {
    const alphaCli = "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade-alpha";
    return `ADE_PACKAGE_CHANNEL=alpha ADE_HOME=${shellQuote(adeHome)} ${shellQuote(alphaCli)} brain stop --text`;
  }
  const stableCli = "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade";
  return `ADE_HOME=${shellQuote(adeHome)} ${shellQuote(stableCli)} brain stop --text`;
}

function currentOwner(args: {
  port?: number | null;
  projectRoot?: string | null;
}): SyncHostSingletonOwner {
  const now = new Date().toISOString();
  const channel = normalizedChannel(process.env.ADE_PACKAGE_CHANNEL);
  const appName = process.env.ADE_DESKTOP_APP_NAME?.trim() || defaultAppName(channel);
  const commandLine = commandLineText();
  return {
    id: randomUUID(),
    pid: process.pid,
    port: normalizePort(args.port),
    appName,
    packageChannel: channel,
    adeHome: process.env.ADE_HOME?.trim() || null,
    serviceName: process.env.ADE_RUNTIME_SERVICE_NAME?.trim() || null,
    socketPath: process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || null,
    projectRoot: args.projectRoot ? path.resolve(args.projectRoot) : null,
    commandLine,
    quitCommand: buildQuitCommand({
      pid: process.pid,
      commandLine,
      appName,
      packageChannel: channel,
      adeHome: process.env.ADE_HOME?.trim() || null,
    }),
    createdAt: now,
    updatedAt: now,
  };
}

function parseLsofListeners(output: string): Array<{ pid: number; port: number; processName: string }> {
  const listeners: Array<{ pid: number; port: number; processName: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\d+)\s+.*\bTCP\s+\S+:(\d+)\s+\(LISTEN\)/);
    if (!match) continue;
    const pid = Number(match[2]);
    const port = Number(match[3]);
    if (
      Number.isFinite(pid) &&
      Number.isFinite(port) &&
      port >= DEFAULT_SYNC_HOST_PORT &&
      port <= SYNC_HOST_MAX_PORT
    ) {
      listeners.push({ pid, port, processName: match[1] });
    }
  }
  return listeners;
}

function psCommandLines(pids: number[]): Map<number, string> {
  const unique = Array.from(new Set(pids.filter((pid) => pid > 0)));
  if (unique.length === 0) return new Map();
  try {
    const output = execFileSync("ps", ["-p", unique.join(","), "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const commands = new Map<number, string>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      commands.set(Number(match[1]), match[2]);
    }
    return commands;
  } catch {
    return new Map();
  }
}

function looksLikeAdeSyncHostProcess(commandLine: string): boolean {
  return /ADE(?: Beta| Alpha)?\.app\/Contents\/MacOS\/ADE/i.test(commandLine)
    || /ade-cli\/cli\.cjs\s+serve\b/i.test(commandLine)
    || /\bade(?:-beta|-alpha)?\b.*\bserve\b/i.test(commandLine);
}

function looksLikeAdeProcessName(processName: string): boolean {
  return /^ADE(?:\s+Beta|\s+Alpha)?$/i.test(processName)
    || /^ade(?:-beta|-alpha)?$/i.test(processName);
}

function legacyOwner(pid: number, port: number, commandLine: string | null): SyncHostSingletonOwner {
  const channel = commandLine && /ADE Beta\.app|ade-beta|\bADE Beta\b/i.test(commandLine)
    ? "beta"
    : commandLine && /ADE Alpha\.app|ade-alpha|\bADE Alpha\b/i.test(commandLine)
      ? "alpha"
      : null;
  const appName = commandLine && /\bADE Beta\b|ADE Beta\.app/i.test(commandLine)
    ? "ADE Beta"
    : commandLine && /\bADE Alpha\b|ADE Alpha\.app/i.test(commandLine)
      ? "ADE Alpha"
      : "ADE";
  const adeHome = channel === "beta"
    ? path.join(os.homedir(), ".ade-beta")
    : channel === "alpha"
      ? path.join(os.homedir(), ".ade-alpha")
      : path.join(os.homedir(), ".ade");
  const now = new Date().toISOString();
  return {
    id: `legacy-${pid}-${port}`,
    pid,
    port,
    appName,
    packageChannel: channel,
    adeHome,
    serviceName: channel ? `com.ade.runtime.${channel}` : "com.ade.runtime",
    socketPath: null,
    projectRoot: null,
    commandLine,
    quitCommand: buildQuitCommand({ pid, commandLine, appName, packageChannel: channel, adeHome }),
    createdAt: now,
    updatedAt: now,
  };
}

function scanNativeSyncHostListeners(): SyncHostSingletonOwner[] {
  if (process.platform !== "darwin") return [];
  if (isTestProcess() && process.env.ADE_SYNC_HOST_LEGACY_SCAN !== "1") return [];
  let output = "";
  try {
    output = execFileSync("lsof", [
      "-nP",
      `-iTCP:${DEFAULT_SYNC_HOST_PORT}-${SYNC_HOST_MAX_PORT}`,
      "-sTCP:LISTEN",
    ], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch (error) {
    output = typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
  }
  const listeners = parseLsofListeners(output)
    .filter((listener) => listener.pid !== process.pid);
  const commands = psCommandLines(listeners.map((listener) => listener.pid));
  return listeners
    .map((listener) => legacyOwner(
      listener.pid,
      listener.port,
      commands.get(listener.pid) ?? null,
    ))
    .filter((owner, index) => {
      if (owner.commandLine != null) return looksLikeAdeSyncHostProcess(owner.commandLine);
      return looksLikeAdeProcessName(listeners[index]?.processName ?? "");
    });
}

function activeLockConflict(
  lockPath: string,
  pidAlive: (pid: number) => boolean,
): SyncHostSingletonConflict | null {
  const lock = safeReadLock(lockPath);
  if (!lock) return null;
  if (lock.owner.pid === process.pid) return null;
  if (!pidAlive(lock.owner.pid)) {
    unlinkLock(lockPath);
    return null;
  }
  return { reason: "lock", owner: lock.owner };
}

export function detectSyncHostSingletonConflict(
  deps: SyncHostSingletonDeps = {},
): SyncHostSingletonConflict | null {
  const hasExplicitDeps = Boolean(deps.lockPath || deps.pidAlive || deps.scanListeners);
  if (
    isTestProcess() &&
    process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE !== "1" &&
    !hasExplicitDeps
  ) {
    return null;
  }
  const lockPath = deps.lockPath ?? syncHostSingletonLockPath();
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const lockConflict = activeLockConflict(lockPath, pidAlive);
  if (lockConflict) return lockConflict;
  const listener = (deps.scanListeners ?? scanNativeSyncHostListeners)()
    .find((owner) => owner.pid !== process.pid && pidAlive(owner.pid));
  return listener ? { reason: "listener", owner: listener } : null;
}

export function assertNoSyncHostSingletonConflict(deps: SyncHostSingletonDeps = {}): void {
  const conflict = detectSyncHostSingletonConflict(deps);
  if (conflict) throw new SyncHostSingletonConflictError(conflict);
}

export function acquireSyncHostSingleton(
  args: { port?: number | null; projectRoot?: string | null },
  deps: SyncHostSingletonDeps = {},
): SyncHostSingletonLease {
  assertNoSyncHostSingletonConflict(deps);
  const lockPath = deps.lockPath ?? syncHostSingletonLockPath();
  const owner = currentOwner(args);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeLock(lockPath, owner, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "EEXIST") throw error;
      const conflict = activeLockConflict(lockPath, deps.pidAlive ?? defaultPidAlive);
      if (conflict) throw new SyncHostSingletonConflictError(conflict);
      unlinkLock(lockPath);
      if (attempt === 1) writeLock(lockPath, owner, "wx");
    }
  }
  return {
    owner,
    updatePort(port: number) {
      const next = {
        ...owner,
        port: normalizePort(port),
        updatedAt: new Date().toISOString(),
      };
      Object.assign(owner, next);
      const lock = safeReadLock(lockPath);
      if (lock?.owner.id === owner.id && lock.owner.pid === process.pid) {
        writeLock(lockPath, owner, "w");
      }
    },
    dispose() {
      const lock = safeReadLock(lockPath);
      if (lock?.owner.id === owner.id && lock.owner.pid === process.pid) {
        unlinkLock(lockPath);
      }
    },
  };
}

export function formatSyncHostSingletonConflictMessage(
  conflict: SyncHostSingletonConflict,
): string {
  const owner = conflict.owner;
  const name = owner.appName ?? "ADE";
  const portText = owner.port != null ? ` on port ${owner.port}` : "";
  const pidText = Number.isFinite(owner.pid) && owner.pid > 0 ? `pid ${owner.pid}` : "unknown pid";
  return [
    `Another ADE brain is already hosting mobile sync${portText}.`,
    `Running instance: ${name} (${pidText}).`,
    "Quit that brain before starting this ADE brain:",
    `  ${owner.quitCommand}`,
  ].join("\n");
}
