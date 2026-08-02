import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";

export type ServiceManagerResult = {
  ok: boolean;
  serviceName: string;
  action: "install" | "uninstall";
  path: string | null;
  message: string;
  // Set when the result was refused because the caller is running inside the
  // very brain it tried to mutate. Consumers must branch on this typed flag,
  // never on the human-readable `message` text.
  selfMutationBlocked?: boolean;
  /** Typed install verification stage for callers that need repair diagnostics. */
  failureStep?: "predecessor_exit" | "replacement_pid" | "replacement_responsive";
};

/**
 * A replacement that reached its readiness phase is already registered with
 * the platform supervisor. That supervisor owns subsequent retries; starting
 * an unmanaged daemon for the same endpoint would create a competing brain.
 */
export function serviceManagerOwnsRuntimeRecovery(result: ServiceManagerResult): boolean {
  return !result.ok && result.failureStep === "replacement_responsive";
}

export type ServiceManagerStatusResult = {
  ok: boolean;
  serviceName: string;
  action: "status";
  installed: boolean | null;
  running: boolean | null;
  path: string | null;
  message: string;
};

export type AdeServiceCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export function resolveRuntimeServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_RUNTIME_SERVICE_NAME?.trim();
  if (explicit) return explicit;
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "com.ade.runtime.alpha";
  if (channel === "beta") return "com.ade.runtime.beta";
  return "com.ade.runtime";
}

export const ADE_RUNTIME_SERVICE_NAME = resolveRuntimeServiceName();

export type ServiceManagerProcessResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type ServiceManagerSpawnSync = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => ServiceManagerProcessResult;

function processOutputText(result: ServiceManagerProcessResult): string {
  if (typeof result.stdout === "string") return result.stdout.trim();
  if (Buffer.isBuffer(result.stdout)) return result.stdout.toString("utf8").trim();
  return "";
}

/**
 * The ancestry query could not be answered at all — the mechanism itself is
 * broken/absent, so we know NOTHING about the process tree. Distinct from
 * `null`, which is the definitive answer "this process has no further parent".
 */
export const PARENT_PID_UNKNOWN = "unknown" as const;

export type ParentPidLookup = number | null | typeof PARENT_PID_UNKNOWN;

/** Exit code the win32 parent-pid query uses for "no such process". */
const WINDOWS_PARENT_PID_NOT_FOUND_EXIT = 3;

/**
 * PowerShell to print a pid's ParentProcessId, or exit 3 when the pid is gone.
 *
 * `Get-CimInstance Win32_Process` rather than `wmic`: wmic is deprecated and is
 * being removed from Windows, and this matches the CIM queries already used by
 * `serviceManager/windowsSupervisor.ts`.
 */
export function buildWindowsParentPidQueryArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for the Windows parent-process query: ${String(pid)}`);
  }
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    `if ($null -eq $process) { exit ${WINDOWS_PARENT_PID_NOT_FOUND_EXIT} }`,
    "[Console]::Out.Write([string]$process.ParentProcessId)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function readWindowsParentPid(run: ServiceManagerSpawnSync, pid: number): ParentPidLookup {
  let result: ServiceManagerProcessResult;
  try {
    // Resolve through the hardened GLOBALROOT lookup: a bare `powershell` is
    // redirectable via PATH/SystemRoot, and this guard protects a teardown.
    // 5s was not enough: powershell.exe cold start plus the first CIM call in a
    // session routinely exceeds it on a contended Windows host, and the timeout
    // is indistinguishable from a real failure, so the guard below falls back to
    // PARENT_PID_UNKNOWN and refuses a teardown the user is entitled to. The
    // walk in isCurrentProcessDescendantOfPid stops at the first
    // PARENT_PID_UNKNOWN, so this budget is spent at most once per lookup chain.
    result = run(
      resolveTrustedWindowsTool("powershell"),
      buildWindowsParentPidQueryArgs(pid),
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
  } catch {
    return PARENT_PID_UNKNOWN;
  }
  // Only "the process does not exist" is a definitive end of the chain. Any
  // other non-zero status (spawn failure, CIM unavailable, timeout) means the
  // ancestry is undetermined, NOT that we reached the root.
  if (result.status === WINDOWS_PARENT_PID_NOT_FOUND_EXIT) return null;
  if (result.status !== 0) return PARENT_PID_UNKNOWN;
  const text = processOutputText(result);
  if (!/^\d+$/.test(text)) return PARENT_PID_UNKNOWN;
  const parentPid = Number.parseInt(text, 10);
  if (!Number.isFinite(parentPid)) return PARENT_PID_UNKNOWN;
  // ParentProcessId 0 is the Idle pseudo-process: the top of the tree.
  return parentPid > 0 ? parentPid : null;
}

function readPosixParentPid(run: ServiceManagerSpawnSync, pid: number): ParentPidLookup {
  // `ps` exits 1 both for "no such pid" and for a genuine failure, so a POSIX
  // host cannot distinguish the two the way the win32 branch above can. `ps` is
  // part of every POSIX base system, so treat a failure as end-of-chain.
  const result = run("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const parentPid = Number.parseInt(processOutputText(result), 10);
  return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
}

/**
 * Parent pid of `pid`, dispatched per platform the same way
 * `serviceManager/index.ts` dispatches `getRuntimeServiceMainPid`.
 */
export function readParentPid(
  run: ServiceManagerSpawnSync,
  pid: number,
  platform: NodeJS.Platform = process.platform,
): ParentPidLookup {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return platform === "win32"
    ? readWindowsParentPid(run, pid)
    : readPosixParentPid(run, pid);
}

/**
 * Whether this process is running inside the process tree rooted at `targetPid`.
 *
 * This is a SAFETY guard: its callers use it to refuse tearing down the very
 * runtime the command was issued from. When ancestry cannot be determined
 * (`PARENT_PID_UNKNOWN`) it therefore answers `true` — fail CLOSED. A false
 * "yes" costs the user one refusal that names the
 * `ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1` override; a false "no" silently
 * destroys a live runtime and every active session on it. Only the first is
 * recoverable.
 */
export function isCurrentProcessDescendantOfPid(args: {
  targetPid: number;
  run?: ServiceManagerSpawnSync;
  currentPid?: number;
  platform?: NodeJS.Platform;
  parentPid?: (pid: number) => ParentPidLookup;
}): boolean {
  const targetPid = Math.floor(args.targetPid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;
  const run = args.run ?? spawnSync;
  const platform = args.platform ?? process.platform;
  const readPid = args.parentPid ?? ((pid: number) => readParentPid(run, pid, platform));
  const seen = new Set<number>();
  let cursor = Math.floor(args.currentPid ?? process.pid);
  while (Number.isFinite(cursor) && cursor > 0 && !seen.has(cursor)) {
    if (cursor === targetPid) return true;
    seen.add(cursor);
    const next = readPid(cursor);
    if (next === PARENT_PID_UNKNOWN) return true;
    if (!next || next === cursor) return false;
    cursor = next;
  }
  return false;
}

const RUNTIME_ENV_PASSTHROUGH = [
  "NODE_PATH",
  "ADE_HOME",
  "ADE_PACKAGE_CHANNEL",
  "ADE_DESKTOP_APP_NAME",
  "ADE_RUNTIME_SERVICE_NAME",
  "ADE_RUNTIME_ROOT",
  "ADE_RUNTIME_NODE_MODULES",
  "ADE_DEFAULT_ROLE",
  "ADE_WINDOWS_USER_SID",
] as const;

function runtimeEnvironment(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  for (const key of RUNTIME_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value?.trim()) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function fileSha256(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function resolveCliPackageRoot(entryPath: string): string | null {
  const seen = new Set<string>();
  const starts = entryPath ? [path.dirname(entryPath)] : [process.cwd()];
  for (const start of starts) {
    if (!start) continue;
    let cursor = path.resolve(start);
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const packageJson = path.join(cursor, "package.json");
      const srcCli = path.join(cursor, "src", "cli.ts");
      if (fs.existsSync(packageJson) && fs.existsSync(srcCli)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

function resolveCliDistPath(entryPath: string): string | null {
  const packageRoot = resolveCliPackageRoot(entryPath);
  if (!packageRoot) return null;
  const distPath = path.join(packageRoot, "dist", "cli.cjs");
  return fs.existsSync(distPath) ? distPath : null;
}

export function resolveAdeServiceCommandBuildHash(command: AdeServiceCommand): string | null {
  const firstArg = command.args[0] ? path.resolve(command.args[0]) : "";
  const isNodeServeFallback =
    command.command === process.execPath
    && command.args.length === 1
    && command.args[0] === "serve";
  if (isNodeServeFallback) {
    const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
      ? path.resolve(process.argv[1])
      : "";
    const distPath = resolveCliDistPath(entry);
    return distPath ? fileSha256(distPath) : null;
  }
  if (command.command === process.execPath && firstArg && fs.existsSync(firstArg)) {
    return fileSha256(firstArg);
  }
  if (command.command !== process.execPath && fs.existsSync(command.command)) {
    return fileSha256(path.resolve(command.command));
  }
  return null;
}

function withRuntimeBuildHash(command: AdeServiceCommand): AdeServiceCommand {
  const buildHash = resolveAdeServiceCommandBuildHash(command);
  if (!buildHash) return command;
  return {
    ...command,
    env: {
      ...(command.env ?? {}),
      ADE_RUNTIME_BUILD_HASH: buildHash,
    },
  };
}

export type TerminatePidDeps = {
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  pidAlive?: (pid: number) => boolean;
  graceTimeoutMs?: number;
};

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function terminatePidGracefully(pid: number | null, deps: TerminatePidDeps = {}): void {
  if (!pid || pid <= 0 || pid === process.pid) return;
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    sleepSync(50);
  }
  try {
    kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export async function terminatePidGracefullyAsync(
  pid: number | null,
  deps: TerminatePidDeps = {},
): Promise<void> {
  if (!pid || pid <= 0 || pid === process.pid) return;
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    // This timer is awaited: it must stay referenced, or a standalone CLI
    // (e.g. `ade serve --install-service` repairing a wedged brain) can run
    // out of referenced work and exit before the SIGKILL escalation and the
    // subsequent `launchctl load` ever happen.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  try {
    kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export function resolveAdeServeCliScriptPath(command: AdeServiceCommand): string {
  const first = command.args[0]?.trim();
  if (first && first !== "serve") return first;
  return command.command;
}

// A ps command line counts as a stale channel brain when it runs this
// channel's packaged CLI in `serve` mode against the channel's primary
// socket. Isolated (--no-sync), installer, and foreign-socket runtimes are
// other lifecycles and must not be reaped by a service install.
export function isStaleChannelServeCommandLine(
  commandLine: string,
  opts: { cliScriptPath: string; primarySocketPath: string },
): boolean {
  const line = commandLine.trim();
  if (!line || !opts.cliScriptPath) return false;
  const socketMatch = line.match(/--socket(?:=|\s+)(\S+)/);
  const explicitPrimarySocket = socketMatch
    ? path.resolve(socketMatch[1]) === path.resolve(opts.primarySocketPath)
    : false;
  const cliIndex = line.indexOf(opts.cliScriptPath);
  const alternateCliMatch = line.match(
    /\b(?:ade-cli[\\/](?:bin[\\/]ade|cli\.cjs)|apps[\\/]ade-cli[\\/]dist[\\/]cli\.cjs|cli\.cjs)(?=\s+serve(?:\s|$))/,
  );
  const tail = cliIndex >= 0
    ? line.slice(cliIndex + opts.cliScriptPath.length)
    : alternateCliMatch?.index != null
      ? line.slice(alternateCliMatch.index + alternateCliMatch[0].length)
      : "";
  if (!/^\s+serve(?:\s|$)/.test(tail)) return false;
  if (/--(?:install-service|uninstall-service|service-status|no-sync)\b/.test(tail)) return false;
  if (socketMatch && !explicitPrimarySocket) {
    return false;
  }
  if (cliIndex < 0 && !explicitPrimarySocket) return false;
  return true;
}

export function listStaleChannelServePids(
  run: ServiceManagerSpawnSync,
  opts: { cliScriptPath: string; primarySocketPath: string; excludePids?: number[] },
): number[] {
  const result = run("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const output = typeof result.stdout === "string"
    ? result.stdout
    : Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : "";
  const exclude = new Set([process.pid, ...(opts.excludePids ?? [])]);
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0 || exclude.has(pid)) continue;
    if (isStaleChannelServeCommandLine(match[2], opts)) pids.push(pid);
  }
  return pids;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cmdQuote(value: string): string {
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat((backslashes * 2) + 1);
      quoted += "\"";
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

export function resolveAdeServeCommand(): AdeServiceCommand {
  const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
    ? path.resolve(process.argv[1])
    : "";
  const isNodeScript = /\.(?:cjs|mjs|js|ts)$/i.test(entry) && fs.existsSync(entry);
  if (isNodeScript) {
    return withRuntimeBuildHash({
      command: process.execPath,
      args: [entry, "serve"],
      env: runtimeEnvironment(),
    });
  }
  if (entry && fs.existsSync(entry)) {
    return withRuntimeBuildHash({
      command: entry,
      args: ["serve"],
      env: runtimeEnvironment(),
    });
  }
  return withRuntimeBuildHash({
    command: process.execPath,
    args: ["serve"],
    env: runtimeEnvironment(),
  });
}

export function renderCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

export function renderWindowsCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(cmdQuote).join(" ");
}


function streamToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

export function serviceManagerResultText(result: ServiceManagerProcessResult): string {
  return streamToText(result.stderr) || streamToText(result.stdout);
}
