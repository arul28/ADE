import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import {
  buildWindowsListeningPortHolderQueryArgs,
  parseWindowsPortHolders,
} from "./windowsPortHolders";
import { DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT } from "./syncProtocol";
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
  /** Stable-enough birth identity used with pid/executable to reject PID reuse. */
  processStartedAt?: string | null;
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
  processMatchesOwner?: (owner: SyncHostSingletonOwner) => boolean | null;
  scanListeners?: () => SyncHostSingletonOwner[];
  platform?: NodeJS.Platform;
  /** Injectable process runner for the native listener scan (lsof / PowerShell). */
  scanListenersReadText?: (command: string, args: string[]) => string;
  /**
   * Answer from the lock file alone and skip the native listener scan.
   *
   * The scan is the fallback for a brain that was hard-killed and left its lock
   * behind, so it only pays off in the rare case -- but it costs a process spawn
   * in EVERY case, because the lock check short-circuits only when it already
   * found a conflict. On Windows that spawn is a full-machine
   * `Get-NetTCPConnection` + `Get-CimInstance` query, which is far too expensive
   * for a caller sitting in front of first paint. See the desktop launch gate.
   */
  skipListenerScan?: boolean;
};

// Which leases THIS process currently holds. The lock file answers "who owns
// mobile sync on this machine"; this answers "is it me", which is the question
// every other machine-exclusive subsystem (relay tunnel, account-directory
// publisher) actually needs. Without it those subsystems gated on merely
// HAVING a listener, so a secondary brain with an ephemeral fallback listener
// happily dialed the relay and evicted the real host in a ~4s loop.
const heldLeaseIds = new Set<string>();
const authorityHandlers = new Set<(held: boolean) => void>();

function notifyAuthorityChanged(held: boolean): void {
  for (const handler of [...authorityHandlers]) {
    try {
      handler(held);
    } catch {
      // A subscriber must never break lease bookkeeping.
    }
  }
}

/** True when this process holds the machine-wide sync host lease. */
export function holdsSyncHostSingleton(): boolean {
  return heldLeaseIds.size > 0;
}

/**
 * Subscribe to authority transitions (not every acquire/release — only
 * none-held → held and held → none-held). Returns an unsubscribe function.
 */
export function onSyncHostSingletonAuthorityChanged(
  handler: (held: boolean) => void,
): () => void {
  authorityHandlers.add(handler);
  return () => {
    authorityHandlers.delete(handler);
  };
}

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

function windowsPidStopCommand(pid: number): string {
  return `Stop-Process -Id ${Math.floor(pid)} -Force -ErrorAction SilentlyContinue`;
}

function withPidKillFallback(
  command: string,
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!Number.isFinite(pid) || pid <= 0) return command;
  const normalizedPid = Math.floor(pid);
  if (platform === "win32") {
    if (command.includes(`Stop-Process -Id ${normalizedPid}`)) return command;
    // Windows releases before the native port could persist POSIX recovery
    // commands. Replace those instead of copying another unusable command.
    return windowsPidStopCommand(normalizedPid);
  }
  if (command.includes(`/bin/kill ${normalizedPid}`)) return command;
  return `${command}; /bin/kill ${normalizedPid} 2>/dev/null || true`;
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

function executableFromCommandLine(commandLine: string | null): string | null {
  const match = commandLine?.trim().match(/^(?:"([^"]+)"|(.+?\.exe))(?=\s|$)/i);
  const executable = match?.[1] ?? match?.[2] ?? null;
  return executable ? path.win32.basename(executable).toLowerCase() : null;
}

function defaultProcessMatchesOwner(
  owner: SyncHostSingletonOwner,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform !== "win32") return null;
  const script = [
    `$target = Get-Process -Id ${Math.floor(owner.pid)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $target) { exit 3 }",
    "$executablePath = $null",
    "$startedAt = $null",
    "try { $executablePath = $target.Path } catch {}",
    "try { $startedAt = $target.StartTime.ToUniversalTime().ToString('o') } catch {}",
    "[Console]::Out.Write((@{ executablePath = $executablePath; startedAt = $startedAt } | ConvertTo-Json -Compress))",
  ].join("; ");
  let raw = "";
  try {
    raw = execFileSync(
      resolveTrustedWindowsTool("powershell"),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    // If process inspection is unavailable, remain conservative and preserve
    // the lock rather than risking two live sync hosts.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      executablePath?: unknown;
      startedAt?: unknown;
    };
    const expectedExecutable = executableFromCommandLine(owner.commandLine);
    const actualExecutable = typeof parsed.executablePath === "string" && parsed.executablePath.trim()
      ? path.win32.basename(parsed.executablePath.trim()).toLowerCase()
      : null;
    if (expectedExecutable && actualExecutable && expectedExecutable !== actualExecutable) {
      return false;
    }
    const expectedStartedAtMs = owner.processStartedAt
      ? Date.parse(owner.processStartedAt)
      : Number.NaN;
    const actualStartedAtMs = typeof parsed.startedAt === "string"
      ? Date.parse(parsed.startedAt)
      : Number.NaN;
    if (
      Number.isFinite(expectedStartedAtMs)
      && Number.isFinite(actualStartedAtMs)
      && Math.abs(expectedStartedAtMs - actualStartedAtMs) > 2_000
    ) {
      return false;
    }
    return true;
  } catch {
    return null;
  }
}

function safeReadLock(
  lockPath: string,
  platform: NodeJS.Platform = process.platform,
): SyncHostSingletonLockFile | null {
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
    const rawQuitCommand = typeof row.quitCommand === "string" && row.quitCommand.trim()
      ? row.quitCommand
      : buildQuitCommand({ pid, commandLine: null, appName: null, packageChannel: null, adeHome: null });
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
        processStartedAt:
          typeof row.processStartedAt === "string" && Number.isFinite(Date.parse(row.processStartedAt))
            ? row.processStartedAt
            : null,
        quitCommand: withPidKillFallback(rawQuitCommand, pid, platform),
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

export function buildQuitCommand(args: {
  pid: number;
  commandLine: string | null;
  appName: string | null;
  packageChannel: string | null;
  adeHome: string | null;
  serviceName?: string | null;
  platform?: NodeJS.Platform;
}): string {
  if ((args.platform ?? process.platform) === "win32") {
    return Number.isFinite(args.pid) && args.pid > 0
      ? windowsPidStopCommand(args.pid)
      : "";
  }
  const commandLine = args.commandLine ?? "";
  const channel = normalizedChannel(args.packageChannel)
    ?? (/ADE Beta\.app|ade-beta|\bADE Beta\b/i.test(commandLine) ? "beta" : null)
    ?? (/ADE Alpha\.app|ade-alpha|\bADE Alpha\b/i.test(commandLine) ? "alpha" : null);
  // The sync-host brain runs as a launchd LaunchAgent (com.ade.runtime[.channel])
  // in the persistent/headless runtime-service mode, with KeepAlive — so a plain
  // `kill` just respawns it. Stop it the right way: `launchctl bootout` the
  // service. This works no matter where the app actually lives (/Applications, a
  // dev worktree, anywhere) — unlike the old hardcoded `/Applications/<App>.app`
  // CLI path, which broke for non-standard installs. Fall back to killing the pid
  // for a child-process (non-launchd) brain.
  const label = args.serviceName && args.serviceName.trim()
    ? args.serviceName.trim()
    : `com.ade.runtime${channel ? `.${channel}` : ""}`;
  const parts = [`launchctl bootout gui/$(id -u)/${label} 2>/dev/null || true`];
  if (Number.isFinite(args.pid) && args.pid > 0) {
    parts.push(`/bin/kill ${args.pid} 2>/dev/null || true`);
  }
  return parts.join("; ");
}

function currentOwner(args: {
  port?: number | null;
  projectRoot?: string | null;
}): SyncHostSingletonOwner {
  const now = new Date().toISOString();
  const channel = normalizedChannel(process.env.ADE_PACKAGE_CHANNEL);
  const appName = process.env.ADE_DESKTOP_APP_NAME?.trim() || defaultAppName(channel);
  const commandLine = commandLineText();
  const serviceName = process.env.ADE_RUNTIME_SERVICE_NAME?.trim() || null;
  const processStartedAt = new Date(
    Date.now() - Math.max(0, process.uptime() * 1_000),
  ).toISOString();
  return {
    id: randomUUID(),
    pid: process.pid,
    port: normalizePort(args.port),
    appName,
    packageChannel: channel,
    adeHome: process.env.ADE_HOME?.trim() || null,
    serviceName,
    socketPath: process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || process.env.ADE_RPC_SOCKET_PATH?.trim() || null,
    projectRoot: args.projectRoot ? path.resolve(args.projectRoot) : null,
    commandLine,
    processStartedAt,
    quitCommand: buildQuitCommand({
      pid: process.pid,
      commandLine,
      appName,
      packageChannel: channel,
      adeHome: process.env.ADE_HOME?.trim() || null,
      serviceName,
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
      windowsHide: true,
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

function legacyOwner(
  pid: number,
  port: number,
  commandLine: string | null,
  // The scan that produced this row already knows which platform it scanned.
  // Defaulting to `process.platform` here would hand a macOS `launchctl bootout`
  // recovery command to a caller that scanned Windows listeners (and vice versa)
  // whenever the scanned platform is injected rather than the host's.
  platform: NodeJS.Platform = process.platform,
): SyncHostSingletonOwner {
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
    processStartedAt: null,
    quitCommand: buildQuitCommand({ pid, commandLine, appName, packageChannel: channel, adeHome, platform }),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Windows spelling of `looksLikeAdeSyncHostProcess`.
 *
 * The POSIX matchers above require forward slashes and whitespace-delimited
 * tokens; a Windows command line has neither, because every spawned argument is
 * quoted (`... "…\ade-cli\cli.cjs" "serve"`). Applying them to a real Windows
 * command line matches nothing at all.
 */
export function looksLikeAdeWindowsSyncHostProcess(commandLine: string): boolean {
  const normalized = commandLine.replace(/"/g, " ").replace(/\//g, "\\");
  // A bare `serve` verb somewhere in the arguments...
  if (!/(?:^|[\s\\])serve(?:\s|$)/i.test(normalized)) return false;
  // ...launched by something that is recognisably an ADE entry point.
  return /[\\\s](?:cli\.cjs|ade\.exe|ade-beta\.exe|ade-alpha\.exe|ADE Beta\.exe|ADE Alpha\.exe)(?=\s)/i
    .test(normalized);
}

type SyncHostListenerScanDeps = {
  platform?: NodeJS.Platform;
  /** Injectable process runner so both branches are testable off their host. */
  readText?: (command: string, args: string[]) => string;
};

function defaultScanText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      // PowerShell needs to start a runtime and load Get-NetTCPConnection plus
      // CIM before it answers; the 2s POSIX budget kills it every time.
      timeout: command.toLowerCase().endsWith("powershell.exe") ? 15_000 : 2_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    return typeof (error as { stdout?: unknown }).stdout === "string"
      ? (error as { stdout: string }).stdout
      : "";
  }
}

/**
 * Windows listener scan: `Get-NetTCPConnection -State Listen` over the sync-host
 * port band, joined to `Win32_Process` for the command line, reusing the exact
 * query `sharedSyncListener` already builds for a single port.
 *
 * Before this existed, `detectSyncHostSingletonConflict` had NO listener-scan
 * fallback on Windows -- the darwin guard returned an empty array that read as
 * "no other sync host is running" -- so only the lock file protected the
 * singleton, and a hard-killed brain is exactly the case that leaves that lock
 * behind unreleased.
 */
function scanWindowsSyncHostListeners(
  readText: (command: string, args: string[]) => string,
): SyncHostSingletonOwner[] {
  let powershell: string;
  let args: string[];
  try {
    powershell = resolveTrustedWindowsTool("powershell");
    args = buildWindowsListeningPortHolderQueryArgs(DEFAULT_SYNC_HOST_PORT, SYNC_HOST_MAX_PORT);
  } catch {
    return [];
  }
  const holders = parseWindowsPortHolders(readText(powershell, args));
  const owners: SyncHostSingletonOwner[] = [];
  for (const holder of holders) {
    if (holder.pid === process.pid) continue;
    // A holder owned by another user has no readable command line without
    // elevation, and an unidentifiable listener must never be reported as an
    // ADE sync host: the caller would tell the user to quit a stranger.
    if (!holder.command || !looksLikeAdeWindowsSyncHostProcess(holder.command)) continue;
    owners.push(legacyOwner(holder.pid, holder.port ?? DEFAULT_SYNC_HOST_PORT, holder.command, "win32"));
  }
  return owners;
}

function scanNativeSyncHostListeners(
  deps: SyncHostListenerScanDeps = {},
): SyncHostSingletonOwner[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return [];
  if (isTestProcess() && process.env.ADE_SYNC_HOST_LEGACY_SCAN !== "1") return [];
  const readText = deps.readText ?? defaultScanText;
  if (platform === "win32") return scanWindowsSyncHostListeners(readText);
  const output = readText("lsof", [
    "-nP",
    `-iTCP:${DEFAULT_SYNC_HOST_PORT}-${SYNC_HOST_MAX_PORT}`,
    "-sTCP:LISTEN",
  ]);
  const listeners = parseLsofListeners(output)
    .filter((listener) => listener.pid !== process.pid);
  const commands = psCommandLines(listeners.map((listener) => listener.pid));
  return listeners
    .map((listener) => legacyOwner(
      listener.pid,
      listener.port,
      commands.get(listener.pid) ?? null,
      "darwin",
    ))
    .filter((owner, index) => {
      if (owner.commandLine != null) return looksLikeAdeSyncHostProcess(owner.commandLine);
      return looksLikeAdeProcessName(listeners[index]?.processName ?? "");
    });
}

function activeLockConflict(
  lockPath: string,
  pidAlive: (pid: number) => boolean,
  processMatchesOwner: (owner: SyncHostSingletonOwner) => boolean | null,
  platform: NodeJS.Platform = process.platform,
): SyncHostSingletonConflict | null {
  const lock = safeReadLock(lockPath, platform);
  if (!lock) return null;
  if (lock.owner.pid === process.pid) return null;
  if (!pidAlive(lock.owner.pid)) {
    unlinkLock(lockPath);
    return null;
  }
  if (processMatchesOwner(lock.owner) === false) {
    // Windows can reuse a dead brain's PID after a reboot or crash. A live PID
    // is not proof that it is still the process recorded in this lock.
    unlinkLock(lockPath);
    return null;
  }
  return { reason: "lock", owner: lock.owner };
}

export function detectSyncHostSingletonConflict(
  deps: SyncHostSingletonDeps = {},
): SyncHostSingletonConflict | null {
  const hasExplicitDeps = Boolean(
    deps.lockPath
    || deps.pidAlive
    || deps.processMatchesOwner
    || deps.scanListeners
    || deps.scanListenersReadText
    || deps.platform,
  );
  if (
    isTestProcess() &&
    process.env.ADE_SYNC_HOST_SINGLETON_TEST_MODE !== "1" &&
    !hasExplicitDeps
  ) {
    return null;
  }
  const lockPath = deps.lockPath ?? syncHostSingletonLockPath();
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const processMatchesOwner = deps.processMatchesOwner
    ?? ((owner) => defaultProcessMatchesOwner(owner, deps.platform));
  const lockConflict = activeLockConflict(
    lockPath,
    pidAlive,
    processMatchesOwner,
    deps.platform,
  );
  if (lockConflict) return lockConflict;
  if (deps.skipListenerScan) return null;
  const listener = (deps.scanListeners
    ?? (() => scanNativeSyncHostListeners({
      platform: deps.platform,
      readText: deps.scanListenersReadText,
    })))()
    .find((owner) => owner.pid !== process.pid && pidAlive(owner.pid));
  return listener ? { reason: "listener", owner: listener } : null;
}

export function assertNoSyncHostSingletonConflict(deps: SyncHostSingletonDeps = {}): void {
  const conflict = detectSyncHostSingletonConflict(deps);
  if (conflict) throw new SyncHostSingletonConflictError(conflict);
}

function defaultAdeHomeForChannel(channel: string | null): string {
  if (channel === "beta") return path.join(os.homedir(), ".ade-beta");
  if (channel === "alpha") return path.join(os.homedir(), ".ade-alpha");
  return path.join(os.homedir(), ".ade");
}

// The mobile sync singleton is machine-wide across channels, so a stable
// brain hosting sync must never be reaped by a beta install (and vice
// versa). Same-channel owners are stale siblings of the brain being
// (re)started and are safe to replace.
export function isSameChannelSyncHostOwner(
  owner: SyncHostSingletonOwner,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const currentChannel = normalizedChannel(env.ADE_PACKAGE_CHANNEL);
  const currentAdeHome = env.ADE_HOME?.trim() || defaultAdeHomeForChannel(currentChannel);
  if (owner.adeHome) {
    return path.resolve(owner.adeHome) === path.resolve(currentAdeHome);
  }
  const currentServiceName = env.ADE_RUNTIME_SERVICE_NAME?.trim()
    || (currentChannel ? `com.ade.runtime.${currentChannel}` : "com.ade.runtime");
  if (owner.serviceName) {
    return owner.serviceName === currentServiceName;
  }
  return normalizedChannel(owner.packageChannel) === currentChannel;
}

export function acquireSyncHostSingleton(
  args: { port?: number | null; projectRoot?: string | null },
  deps: SyncHostSingletonDeps = {},
): SyncHostSingletonLease {
  assertNoSyncHostSingletonConflict(deps);
  const lockPath = deps.lockPath ?? syncHostSingletonLockPath();
  const owner = currentOwner(args);
  const processMatchesOwner = deps.processMatchesOwner
    ?? ((candidate) => defaultProcessMatchesOwner(candidate, deps.platform));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeLock(lockPath, owner, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "EEXIST") throw error;
      const conflict = activeLockConflict(
        lockPath,
        deps.pidAlive ?? defaultPidAlive,
        processMatchesOwner,
        deps.platform,
      );
      if (conflict) throw new SyncHostSingletonConflictError(conflict);
      unlinkLock(lockPath);
      if (attempt === 1) writeLock(lockPath, owner, "wx");
    }
  }
  const hadAuthority = holdsSyncHostSingleton();
  heldLeaseIds.add(owner.id);
  if (!hadAuthority) notifyAuthorityChanged(true);
  return {
    owner,
    updatePort(port: number) {
      const next = {
        ...owner,
        port: normalizePort(port),
        updatedAt: new Date().toISOString(),
      };
      Object.assign(owner, next);
      const lock = safeReadLock(lockPath, deps.platform);
      if (lock?.owner.id === owner.id && lock.owner.pid === process.pid) {
        writeLock(lockPath, owner, "w");
      }
    },
    dispose() {
      const lock = safeReadLock(lockPath, deps.platform);
      if (lock?.owner.id === owner.id && lock.owner.pid === process.pid) {
        unlinkLock(lockPath);
      }
      if (heldLeaseIds.delete(owner.id) && !holdsSyncHostSingleton()) {
        notifyAuthorityChanged(false);
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
