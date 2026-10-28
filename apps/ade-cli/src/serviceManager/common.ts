import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import {
  resolveMachineAdeDir,
  resolveMachineAdeLayout,
  resolveReachableMachineRuntimeSocketPath,
} from "../services/projects/machineLayout";
import { requestAdeRuntimeShutdown } from "./runtimeShutdownRequest";
import { buildPackagedRuntimeNodeModulePaths } from "../../../desktop/src/main/services/runtime/packagedNodePath";

/**
 * The launchd plist key that lets a background service read an evicted cloud
 * file instead of failing on the placeholder.
 *
 * Named once because three places must agree on it: the two plists that write
 * it, and the storage probe that reads a plist back to report whether an
 * install predates it. A typo in any one of them is invisible until a user's
 * project will not open.
 */
export const MATERIALIZE_DATALESS_FILES_KEY = "MaterializeDatalessFiles";

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
  /**
   * Typed install verification stage for callers that need repair diagnostics.
   * `background_item_blocked` is macOS refusing to start the agent because
   * ADE is switched off under Login Items → "Allow in the Background"; no
   * restart can fix that, only the person at the keyboard can.
   * `launchd_register` is launchd refusing to register the job at all; the
   * message carries launchctl's own error.
   */
  failureStep?: "predecessor_exit" | "replacement_pid" | "replacement_responsive" | "background_item_blocked" | "launchd_register";
  /**
   * The service is registered and its brain process is alive, but it had not
   * answered on the socket when the install's wait budget ran out. That is a
   * brain still coming up (first launch, slow disk, big project database), not
   * a broken one — the platform supervisor keeps it, and callers should keep
   * waiting for the endpoint rather than restart it.
   */
  starting?: boolean;
  /**
   * The install actually (re)started the service child. Absent/false when the
   * install was a no-op (already running and answering) or when it chose to
   * wait for a young brain instead of restarting it — callers that need a
   * restart to have happened (the one-time trust reset) check this rather than
   * `ok`.
   */
  restarted?: boolean;
};

// Re-exported so the many existing `from "./common"` importers keep working;
// the definitions live in runtimeServiceBudgets.ts with the rest of the
// lifecycle budgets they have to stay ordered against.
export {
  RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS,
  RUNTIME_SERVICE_START_WAIT_MS,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
  WINDOWS_HANDOVER_TIMEOUT_MS,
} from "./runtimeServiceBudgets";

/**
 * Parses `ps -o etime=` output (`[[dd-]hh:]mm:ss`) into milliseconds.
 * Returns null for anything it does not recognise so callers fail open.
 */
export function parsePsElapsedMs(raw: string): number | null {
  const text = raw.trim();
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every((value) => Number.isFinite(value))) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

/** Milliseconds a POSIX process has been alive, or null when unknown. */
export function readPidElapsedMs(
  pid: number,
  run: ServiceManagerSpawnSync = spawnSync,
): number | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const result = run("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return parsePsElapsedMs(processOutputRaw(result));
}

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
  /**
   * macOS Background Items verdict for the launch agent, read only when the
   * agent is installed but not running (the one case where it explains
   * anything). Absent on other platforms and when it was not read.
   */
  backgroundItem?: BackgroundItemStatus;
};

/**
 * What macOS's Background Task Management says about a launch agent
 * (`SMAppService.statusForLegacyPlist(at:)`). `requires_approval` is the
 * user-visible "Allow in the Background" switch being off: launchd keeps the
 * job loaded and never starts it.
 */
export type BackgroundItemStatus =
  | "enabled"
  | "requires_approval"
  | "not_registered"
  | "not_found"
  | "unknown";

export const BACKGROUND_ITEM_BLOCKED_MESSAGE =
  "macOS is blocking ADE's background service. Turn on ADE in System Settings → General → Login Items & Extensions → Allow in the Background.";

export type AdeServiceCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** The uid launchd domains are keyed by (`gui/<uid>`, `user/<uid>`). */
export function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
}

export function resolveRuntimeServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_RUNTIME_SERVICE_NAME?.trim();
  if (explicit) return explicit;
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "com.ade.runtime.alpha";
  if (channel === "beta") return "com.ade.runtime.beta";
  return "com.ade.runtime";
}

export const ADE_RUNTIME_SERVICE_NAME = resolveRuntimeServiceName();

/**
 * The ADE app a launch agent belongs to, for the plist's
 * `AssociatedBundleIdentifiers`. Without it macOS (13+) cannot tie the agent
 * to an app and names the signing team instead: the "Software from “<the
 * developer's name>” can run in the background" notification, and an
 * unlabelled row in Login Items. With it, both show ADE's name and icon.
 */
export function resolveAssociatedAppBundleId(env: NodeJS.ProcessEnv = process.env): string {
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "com.ade.desktop.alpha";
  if (channel === "beta") return "com.ade.desktop.beta";
  return "com.ade.desktop";
}

export type ServiceManagerProcessResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  /** Set by `spawnSync` when the child never ran or was killed (e.g. ETIMEDOUT). */
  error?: Error | undefined;
  /** Signal that killed the child, if any — `SIGTERM` for a blown `timeout`. */
  signal?: NodeJS.Signals | null;
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

/** Untrimmed stdout, for line-oriented output whose first line matters. */
export function processOutputRaw(result: ServiceManagerProcessResult): string {
  if (typeof result.stdout === "string") return result.stdout;
  if (Buffer.isBuffer(result.stdout)) return result.stdout.toString("utf8");
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

/**
 * Per-attempt budgets for the win32 parent-pid query, in order.
 *
 * 5s was not enough: powershell.exe cold start plus the first CIM call in a
 * session routinely exceeds it on a contended Windows host, and a timeout is
 * indistinguishable from a real failure, so the guard falls back to
 * PARENT_PID_UNKNOWN and refuses a teardown the user is entitled to. 15s was
 * still not enough on a CPU-saturated host (a 2-core CI runner running other
 * suites in parallel), so a timeout gets ONE retry on a longer budget: by then
 * powershell.exe and the CIM infrastructure are warm, so the retry is the
 * steady-state cost, not another cold start. Only a timeout is retried — a real
 * answer (including "no such process") and a real failure are both final.
 *
 * The walk in isCurrentProcessDescendantOfPid stops at the first
 * PARENT_PID_UNKNOWN, so this budget is spent at most once per lookup chain.
 */
const WINDOWS_PARENT_PID_QUERY_TIMEOUTS_MS = [15_000, 25_000] as const;

/**
 * Whether `spawnSync` killed the child because it blew its `timeout` budget, as
 * opposed to the child answering. Node reports this as `error.code === 'ETIMEDOUT'`
 * with a null status; the signal check covers runtimes that only surface the kill.
 */
function isSpawnTimeout(result: ServiceManagerProcessResult): boolean {
  if (result.status !== null) return false;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT" || result.signal === "SIGTERM";
}

function readWindowsParentPid(run: ServiceManagerSpawnSync, pid: number): ParentPidLookup {
  let result: ServiceManagerProcessResult | undefined;
  for (const [attempt, timeout] of WINDOWS_PARENT_PID_QUERY_TIMEOUTS_MS.entries()) {
    try {
      // Resolve through the hardened GLOBALROOT lookup: a bare `powershell` is
      // redirectable via PATH/SystemRoot, and this guard protects a teardown.
      result = run(
        resolveTrustedWindowsTool("powershell"),
        buildWindowsParentPidQueryArgs(pid),
        { encoding: "utf8", timeout, windowsHide: true },
      );
    } catch {
      return PARENT_PID_UNKNOWN;
    }
    const isLastAttempt = attempt === WINDOWS_PARENT_PID_QUERY_TIMEOUTS_MS.length - 1;
    if (isLastAttempt || !isSpawnTimeout(result)) break;
  }
  if (!result) return PARENT_PID_UNKNOWN;
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

/**
 * The module dirs a packaged CLI entry (`<resources>/ade-cli/cli.cjs`) needs
 * on NODE_PATH. Its externals (`@linear/sdk`, `yaml`, ...) live in the app's
 * asar, not next to the entry, so a runtime started without NODE_PATH cannot
 * load them. These are the same dirs, in the same order, as the installed
 * `ade` wrapper uses on macOS and Windows. Empty for a dev entry, which
 * resolves its modules from the repo.
 */
export function packagedCliNodeModulePaths(
  entryPath: string,
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    exists?: (candidate: string) => boolean;
  } = {},
): string[] {
  const entryDir = path.dirname(entryPath);
  if (path.basename(entryDir).toLowerCase() !== "ade-cli") return [];
  const resourcesPath = path.dirname(entryDir);
  const exists = options.exists ?? fs.existsSync;
  const paths = buildPackagedRuntimeNodeModulePaths({
    resourcesPath,
    platform: options.platform,
    arch: options.arch,
  });
  // Only an entry that sits next to an app asar is a packaged one.
  return paths.some((candidate) => exists(path.dirname(candidate))) ? paths : [];
}

/**
 * Node's compile cache for the brain. The brain is one ~19 MB bundle that Node
 * would otherwise parse on every start. The `ade` wrappers already set the same
 * cache for the CLI, but the service manager starts the brain directly, so it
 * needs its own setting. The setting goes in the environment because Node
 * compiles the bundle before any of its code runs, so nothing inside it can
 * reach the entry file. Node writes the cache when the brain exits gracefully,
 * not when it is killed, and it ignores a directory it cannot use.
 */
function runtimeCompileCacheEnv(env: Record<string, string>): Record<string, string> {
  // Node disables the cache when this variable is set at all, even to an empty value.
  if (process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) return {};
  const explicit = process.env.NODE_COMPILE_CACHE?.trim();
  if (explicit) return { NODE_COMPILE_CACHE: explicit };
  return { NODE_COMPILE_CACHE: defaultRuntimeCompileCacheDir(env) };
}

/** The brain's compile-cache root when no NODE_COMPILE_CACHE overrides it. */
export function defaultRuntimeCompileCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMachineAdeDir(env), "cache", "node-compile");
}

function runtimeEnvironment(entry?: string): Record<string, string> | undefined {
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
  Object.assign(env, runtimeCompileCacheEnv(env));
  // A service started from a process without NODE_PATH (the desktop, a
  // Windows task) still has to load the packaged CLI's externals.
  const packagedPaths = entry ? packagedCliNodeModulePaths(entry) : [];
  if (packagedPaths.length) {
    const inherited = (env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
    const merged = [...packagedPaths, ...inherited.filter((item) => !packagedPaths.includes(item))];
    env.NODE_PATH = merged.join(path.delimiter);
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

/**
 * One Windows process, read in a single PowerShell call. `startTime` is the
 * creation time from `Win32_Process.CreationDate` as ISO-8601 UTC. With the
 * command line it is the identity a kill must find unchanged: a pid can be
 * handed to another program once its owner exits.
 */
export type WindowsProcessFacts = {
  pid: number;
  startTime: string;
  commandLine: string;
  executablePath: string | null;
  parentPid: number | null;
};

export type WindowsProcessRead =
  | { state: "found"; facts: WindowsProcessFacts }
  | { state: "gone" }
  | { state: "unreadable"; reason: string };

/**
 * How a stop of one pid ended. `stopped`: the process is gone, whether it exited
 * or was already gone. `killed`: the verified kill ran and the process is gone.
 * `not-proven`: the process is alive but was not proven to be the one the caller
 * means to stop, so it was left running. `failed`: the proven kill did not take.
 */
export type PidStopOutcome = "stopped" | "killed" | "not-proven" | "failed";

/**
 * Runs `powershell.exe` with `args`. The CLI injects its sync `spawnSync`; the
 * brain uses the async default so its event loop is never blocked on the probe.
 */
export type WindowsPowerShell = (
  args: string[],
) => ServiceManagerProcessResult | Promise<ServiceManagerProcessResult>;

/** Exit codes of the identity and kill scripts. Anything else is a failed read or kill. */
const WINDOWS_PROCESS_GONE_EXIT = 3;
const WINDOWS_PROCESS_NOT_PROVEN_EXIT = 4;
const WINDOWS_PROCESS_KILL_FAILED_EXIT = 5;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 10_000;

function windowsProcessFilter(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for the Windows process query: ${String(pid)}`);
  }
  return powerShellSingleQuotedLiteral(`ProcessId = ${pid}`);
}

/**
 * PowerShell that prints one process's facts as JSON, or exits 3 when it is gone.
 * Read-only: it never kills anything.
 */
export function buildWindowsProcessReadArgs(pid: number): string[] {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$record = Get-CimInstance Win32_Process -Filter ${windowsProcessFilter(pid)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $record) { exit ${WINDOWS_PROCESS_GONE_EXIT} }`,
    "$startTime = ([datetime]$record.CreationDate).ToUniversalTime().ToString('o')",
    // Command lines carry user paths, which may hold non-ASCII; the JSON must
    // reach the caller byte-for-byte, not through the console code page.
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::Out.Write((@{ pid = [int]$record.ProcessId; startTime = $startTime; commandLine = [string]$record.CommandLine; executablePath = [string]$record.ExecutablePath; parentPid = [int]$record.ParentProcessId } | ConvertTo-Json -Compress))",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

/**
 * PowerShell that kills the process `expected` names, and nothing else.
 *
 * The process is opened first, and the handle is held for the rest of the
 * script. The CIM record for the pid is then read and must match the expected
 * birth time and command line exactly. Only then does `Kill()` run, on the held
 * handle, so a pid reused between the read and the kill cannot be the target.
 * Exit 0 means the process is gone; 3 gone before the check; 4 not proven; 5 the
 * kill failed or the process did not exit in time.
 */
export function buildWindowsVerifiedKillArgs(
  expected: Pick<WindowsProcessFacts, "pid" | "startTime" | "commandLine">,
): string[] {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$process = $null",
    `try { $process = [System.Diagnostics.Process]::GetProcessById(${Math.floor(expected.pid)}); $null = $process.Handle } catch { $process = $null }`,
    `$record = Get-CimInstance Win32_Process -Filter ${windowsProcessFilter(expected.pid)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $record) { exit ${WINDOWS_PROCESS_GONE_EXIT} }`,
    `if ($null -eq $process) { exit ${WINDOWS_PROCESS_NOT_PROVEN_EXIT} }`,
    `if ((([datetime]$record.CreationDate).ToUniversalTime().ToString('o')) -cne ${powerShellSingleQuotedLiteral(expected.startTime)}) { exit ${WINDOWS_PROCESS_NOT_PROVEN_EXIT} }`,
    `if (([string]$record.CommandLine) -cne ${powerShellSingleQuotedLiteral(expected.commandLine)}) { exit ${WINDOWS_PROCESS_NOT_PROVEN_EXIT} }`,
    `try { $process.Kill() } catch { if ($process.HasExited) { exit 0 }; exit ${WINDOWS_PROCESS_KILL_FAILED_EXIT} }`,
    `if (-not $process.WaitForExit(5000)) { exit ${WINDOWS_PROCESS_KILL_FAILED_EXIT} }`,
    "exit 0",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Reads a process record. A missing or empty start time or command line is never identity. */
export function parseWindowsProcessRead(
  result: ServiceManagerProcessResult,
  pid: number,
): WindowsProcessRead {
  if (result.status === WINDOWS_PROCESS_GONE_EXIT) return { state: "gone" };
  if (result.status !== 0) {
    return {
      state: "unreadable",
      reason: serviceManagerResultText(result) || `the process query exited with status ${String(result.status)}`,
    };
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(processOutputText(result)) as Record<string, unknown> | null;
  } catch {
    return { state: "unreadable", reason: "the process query returned an unreadable record" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { state: "unreadable", reason: "the process query returned an unreadable record" };
  }
  const startTime = nonEmptyText(parsed.startTime);
  const commandLine = nonEmptyText(parsed.commandLine);
  if (Number(parsed.pid) !== pid || !startTime || !commandLine) {
    return { state: "unreadable", reason: `the command line or start time of pid ${pid} is not readable` };
  }
  const parentPid = Number(parsed.parentPid);
  return {
    state: "found",
    facts: {
      pid,
      startTime,
      commandLine,
      executablePath: nonEmptyText(parsed.executablePath),
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
    },
  };
}

function verifiedKillOutcome(result: ServiceManagerProcessResult): PidStopOutcome {
  switch (result.status) {
    case 0: return "killed";
    case WINDOWS_PROCESS_GONE_EXIT: return "stopped";
    case WINDOWS_PROCESS_NOT_PROVEN_EXIT: return "not-proven";
    default: return "failed";
  }
}

/** The default `WindowsPowerShell`: `powershell.exe`, run asynchronously so the caller's event loop keeps turning. */
function runWindowsPowerShellAsync(args: string[]): Promise<ServiceManagerProcessResult> {
  return new Promise((resolve) => {
    let command: string;
    try {
      command = resolveTrustedWindowsTool("powershell");
    } catch (error) {
      resolve({ status: null, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          status: error ? (typeof code === "number" ? code : null) : 0,
          stdout,
          stderr,
          error: error ?? undefined,
        });
      },
    );
  });
}

/** Reads the facts of `pid` in one PowerShell call. */
export async function readWindowsProcessFacts(
  pid: number,
  run: WindowsPowerShell = runWindowsPowerShellAsync,
): Promise<WindowsProcessRead> {
  let result: ServiceManagerProcessResult;
  try {
    result = await run(buildWindowsProcessReadArgs(pid));
  } catch (error) {
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  return parseWindowsProcessRead(result, pid);
}

/** Kills exactly the process `expected` describes, or nothing. See `buildWindowsVerifiedKillArgs`. */
export async function killVerifiedWindowsProcess(
  expected: Pick<WindowsProcessFacts, "pid" | "startTime" | "commandLine">,
  run: WindowsPowerShell = runWindowsPowerShellAsync,
): Promise<PidStopOutcome> {
  let result: ServiceManagerProcessResult;
  try {
    result = await run(buildWindowsVerifiedKillArgs(expected));
  } catch {
    return "failed";
  }
  return verifiedKillOutcome(result);
}

/**
 * Reads `pid`, asks `isExpected` about what it finds, and kills that exact
 * process only when the answer is yes. A pid that cannot be read, or that is
 * not expected, is left running and reported as `not-proven`.
 */
export async function killIdentifiedWindowsProcess(
  pid: number,
  isExpected: (facts: WindowsProcessFacts) => boolean,
  run: WindowsPowerShell = runWindowsPowerShellAsync,
): Promise<PidStopOutcome> {
  const read = await readWindowsProcessFacts(pid, run);
  if (read.state === "gone") return "stopped";
  if (read.state === "unreadable") return "not-proven";
  let expected: boolean;
  try {
    expected = isExpected(read.facts) === true;
  } catch {
    expected = false;
  }
  if (!expected) return "not-proven";
  return killVerifiedWindowsProcess(read.facts, run);
}

/** Two reads describe the same process: same pid, birth time and command line. */
export function sameWindowsProcess(live: WindowsProcessFacts, expected: WindowsProcessFacts): boolean {
  return live.pid === expected.pid
    && live.startTime === expected.startTime
    && live.commandLine === expected.commandLine;
}

export type TerminatePidDeps = {
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  pidAlive?: (pid: number) => boolean;
  /**
   * How long the target is given to EXIT once it has accepted the shutdown
   * request (win32) or been sent SIGTERM (POSIX). Deliberately separate from
   * `shutdownRequestTimeoutMs`: a caller that wants a snappy handshake must not
   * thereby shorten the flush window -- see `WINDOWS_COOPERATIVE_GRACE_MS`.
   */
  graceTimeoutMs?: number;
  /**
   * win32 only: how long to wait for the brain to ACKNOWLEDGE the JSON-RPC
   * shutdown request. Spent before the grace window starts, and answering is
   * cheap, so this is short. No answer means nothing on that endpoint claims
   * this pid, and the caller escalates immediately rather than waiting out a
   * grace window for a brain that never agreed to leave.
   */
  shutdownRequestTimeoutMs?: number;
  platform?: NodeJS.Platform;
  /**
   * The JSON-RPC endpoint the target brain serves. Windows has no signal that
   * a target can handle, so this is the ONLY way to ask a brain to exit in an
   * orderly fashion. Defaults to this channel's primary socket, which is what
   * every process `isStaleChannelServeCommandLine` matches is serving.
   */
  runtimeSocketPath?: string | null;
  /** Injectable cooperative-shutdown request (see runtimeShutdownRequest.ts). */
  requestRuntimeShutdown?: (args: {
    pid: number;
    socketPath: string;
    timeoutMs: number;
  }) => Promise<{ requested: boolean; reason?: string }>;
  /**
   * win32 only: whether the process read from `pid` is the one this caller means
   * to stop, decided from the facts PowerShell reads off the live process. It is
   * asked only on the non-cooperative escalation, never on a cooperative stop.
   * `answered` is true when the process accepted the shutdown request on this
   * endpoint, and false when nothing did. With no check supplied nothing is
   * force-killed: a PID record or a port scan can name a pid that Windows has
   * since handed to another program.
   */
  isExpectedProcess?: (facts: WindowsProcessFacts, answered: boolean) => boolean;
  /**
   * win32 only: the PowerShell boundary the identity read and the verified kill
   * run through. Defaults to `powershell.exe`, run off the event loop.
   */
  runWindowsPowerShell?: WindowsPowerShell;
};

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

/**
 * How long a Windows brain is given AFTER it has accepted a cooperative
 * shutdown request. The POSIX grace window is 1.5s, but there the brain's own
 * SIGTERM handler arms a 10s force-exit as a second line of defence; on Windows
 * this loop is the only line of defence, so a bare 1.5s would frequently
 * escalate to a force-kill on a brain that was midway through an orderly flush
 * -- the exact corruption this whole path exists to avoid.
 *
 * The window is measured from the moment the brain ACCEPTS the request, so the
 * RPC round trip is not charged against it; that budget is
 * `shutdownRequestTimeoutMs`. One knob used to feed both, which meant a caller
 * asking for a snappier handshake silently bought a shorter flush window too.
 */
const WINDOWS_COOPERATIVE_GRACE_MS = 5_000;

/**
 * Default budget for the `runtime/info` + `shutdown` round trip. Both are
 * in-memory answers on an already-listening endpoint, so a brain healthy enough
 * to flush answers well inside this; one that does not is wedged, and waiting
 * longer only delays the escalation.
 */
const WINDOWS_SHUTDOWN_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Whether `pid` still names a live process.
 *
 * Signal 0 is the one "signal" libuv does not map onto `TerminateProcess`, so
 * this is a pure existence probe on Windows as well as POSIX. `EPERM` means the
 * pid exists but belongs to a process we may not signal -- alive, not absent.
 * Reporting it as absent would end a grace loop early and leave a brain running
 * that the caller believes it stopped.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the facts read off a live process are the process the caller means to
 * stop. Fails closed: a check that is not supplied, or that throws, is no proof.
 */
function provablyExpectedProcess(
  facts: WindowsProcessFacts,
  answered: boolean,
  deps: TerminatePidDeps,
): boolean {
  if (!deps.isExpectedProcess) return false;
  try {
    return deps.isExpectedProcess(facts, answered) === true;
  } catch {
    return false;
  }
}

/**
 * Synchronous SIGTERM-then-SIGKILL teardown. POSIX only.
 *
 * The cooperative Windows path needs a socket round trip, which cannot be done
 * synchronously from this process, so a win32 caller MUST use
 * `terminatePidGracefullyAsync`. This path makes no PowerShell call, so it cannot
 * prove a win32 pid is the process it means to stop, and it never force-kills
 * one: a live pid comes back `not-proven`.
 */
export function terminatePidGracefully(pid: number | null, deps: TerminatePidDeps = {}): PidStopOutcome {
  if (!pid || pid <= 0 || pid === process.pid) return "stopped";
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? isPidAlive;
  if ((deps.platform ?? process.platform) === "win32") {
    return pidAlive(pid) ? "not-proven" : "stopped";
  }
  try {
    kill(pid, "SIGTERM");
  } catch {
    return "stopped";
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return "stopped";
    sleepSync(50);
  }
  try {
    kill(pid, "SIGKILL");
    return "killed";
  } catch {
    return "stopped";
  }
}

function sleepAsync(ms: number): Promise<void> {
  // This timer is awaited: it must stay referenced, or a standalone CLI
  // (e.g. `ade serve --install-service` repairing a wedged brain) can run
  // out of referenced work and exit before the escalation and the
  // subsequent `launchctl load` ever happen.
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Windows counterpart of the SIGTERM/SIGKILL sequence below.
 *
 * There is no Windows signal a Node process can handle, so "graceful" has to
 * mean something else here: ask the brain over its own JSON-RPC endpoint (the
 * `shutdown` method runs the exact `finish()` the macOS SIGTERM handler runs),
 * wait out the grace window, and only then force it. Before this existed every
 * Windows teardown was `TerminateProcess` -- the grace loop, the `pidAlive`
 * poll and the SIGKILL escalation were all dead code, and the brain was killed
 * mid-write with no SQLite/CRDT flush and no lock-file release.
 */
async function terminateWindowsPidGracefullyAsync(
  pid: number,
  deps: TerminatePidDeps,
): Promise<PidStopOutcome> {
  const pidAlive = deps.pidAlive ?? isPidAlive;
  const requestShutdown = deps.requestRuntimeShutdown ?? requestAdeRuntimeShutdown;
  let socketPath = deps.runtimeSocketPath ?? null;
  if (socketPath === null) {
    try {
      socketPath = resolveReachableMachineRuntimeSocketPath();
    } catch {
      socketPath = null;
    }
  }
  let cooperative = false;
  if (socketPath) {
    const requestTimeoutMs = Math.max(
      250,
      Math.floor(deps.shutdownRequestTimeoutMs ?? WINDOWS_SHUTDOWN_REQUEST_TIMEOUT_MS),
    );
    try {
      cooperative = (await requestShutdown({ pid, socketPath, timeoutMs: requestTimeoutMs })).requested;
    } catch {
      cooperative = false;
    }
  }
  if (!cooperative) {
    // Nothing answered for this pid on this endpoint: either it is not an ADE
    // brain, or it is too wedged to answer. A wedged brain can only be force-killed,
    // and only once its identity is proven. A stale record can name a pid that
    // another program now owns; that one stays alive, and the caller is told so.
    if (!pidAlive(pid)) return "stopped";
    return escalateWindowsPid(pid, false, deps);
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? WINDOWS_COOPERATIVE_GRACE_MS);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return "stopped";
    await sleepAsync(50);
  }
  // The brain may have exited right at the deadline. Re-check before escalating.
  if (!pidAlive(pid)) return "stopped";
  // It accepted the request on this endpoint a moment ago, so the pid named the
  // brain that answered. The kill still binds to what is read now, never to the pid.
  return escalateWindowsPid(pid, true, deps);
}

/**
 * The last-resort kill of a win32 pid: read its identity, let the caller's check
 * decide, then kill that exact process. No check, or a check that says no, is
 * `not-proven`, and the process is left running.
 */
async function escalateWindowsPid(
  pid: number,
  answered: boolean,
  deps: TerminatePidDeps,
): Promise<PidStopOutcome> {
  if (!deps.isExpectedProcess) return "not-proven";
  return killIdentifiedWindowsProcess(
    pid,
    (facts) => provablyExpectedProcess(facts, answered, deps),
    deps.runWindowsPowerShell ?? runWindowsPowerShellAsync,
  );
}

/**
 * Stops `pid` the way its platform allows, and reports how it ended. On win32 a
 * cooperative stop is a shutdown request over the endpoint and never reads the
 * process identity; only the escalation does.
 */
export async function terminatePidGracefullyAsync(
  pid: number | null,
  deps: TerminatePidDeps = {},
): Promise<PidStopOutcome> {
  if (!pid || pid <= 0 || pid === process.pid) return "stopped";
  if ((deps.platform ?? process.platform) === "win32") {
    return terminateWindowsPidGracefullyAsync(pid, deps);
  }
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? isPidAlive;
  try {
    kill(pid, "SIGTERM");
  } catch {
    return "stopped";
  }
  const deadline = Date.now() + (deps.graceTimeoutMs ?? 1_500);
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return "stopped";
    await sleepAsync(50);
  }
  try {
    kill(pid, "SIGKILL");
    return "killed";
  } catch {
    return "stopped";
  }
}

export function resolveAdeServeCliScriptPath(command: AdeServiceCommand): string {
  const first = command.args[0]?.trim();
  if (first && first !== "serve") return first;
  return command.command;
}

function isWindowsNamedPipePath(value: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(value.trim().replace(/\//g, "\\"));
}

/**
 * Whether two `--socket` values name the same endpoint.
 *
 * A Windows brain's endpoint is a named pipe, and both halves of that name are
 * case-insensitive: the kernel's pipe namespace is, and so is the filesystem
 * whose paths ADE hashes into the name. `===` on the resolved strings therefore
 * rejects genuine matches on Windows. POSIX socket paths ARE case-sensitive, so
 * that branch keeps the exact comparison it has always had.
 */
function isSameServeSocketPath(left: string, right: string): boolean {
  if (isWindowsNamedPipePath(left) || isWindowsNamedPipePath(right)) {
    const normalize = (value: string): string =>
      value.trim().replace(/\//g, "\\").toLowerCase();
    return normalize(left) === normalize(right);
  }
  return path.resolve(left) === path.resolve(right);
}

/** The `--socket` a serve command line names, or null when it names none. */
function serveSocketArgument(commandLine: string): string | null {
  return commandLine.match(/--socket"?(?:=|\s+)"?([^"\s]+)/)?.[1] ?? null;
}

// A ps/CIM command line counts as a stale channel brain when it runs this
// channel's packaged CLI in `serve` mode against the channel's primary
// socket. Isolated (--no-sync), installer, and foreign-socket runtimes are
// other lifecycles and must not be reaped by a service install.
//
// Every token boundary below tolerates a `"`: Windows quotes EVERY spawned
// argument (`renderWindowsCommand` -> `cmdQuote`), so a live supervisor-launched
// brain reads `"...\node.exe" "...\cli.cjs" "serve"` and the tail after the CLI
// path starts `" "serve"`, not ` serve`. Measured against a real
// supervisor-launched process read back through `Get-CimInstance Win32_Process`,
// the whitespace-only spellings made this predicate always false on Windows --
// including for every user whose home path contains a space, because Node quotes
// those arguments too. `windowsSupervisor.buildWindowsRuntimeQueryArgs` carries
// the same fix for its own predicate.
export function isStaleChannelServeCommandLine(
  commandLine: string,
  opts: { cliScriptPath: string; primarySocketPath: string },
): boolean {
  const line = commandLine.trim();
  if (!line || !opts.cliScriptPath) return false;
  const socketArgument = serveSocketArgument(line);
  const explicitPrimarySocket = socketArgument !== null
    ? isSameServeSocketPath(socketArgument, opts.primarySocketPath)
    : false;
  const cliIndex = line.indexOf(opts.cliScriptPath);
  const alternateCliMatch = line.match(
    /\b(?:ade-cli[\\/](?:bin[\\/]ade|cli\.cjs)|apps[\\/]ade-cli[\\/]dist[\\/]cli\.cjs|cli\.cjs)(?="?\s+"?serve"?(?:\s|$))/,
  );
  const tail = cliIndex >= 0
    ? line.slice(cliIndex + opts.cliScriptPath.length)
    : alternateCliMatch?.index != null
      ? line.slice(alternateCliMatch.index + alternateCliMatch[0].length)
      : "";
  if (!/^"?\s+"?serve"?(?:\s|$)/.test(tail)) return false;
  if (/--(?:install-service|uninstall-service|service-status|no-sync)\b/.test(tail)) return false;
  if (socketArgument !== null && !explicitPrimarySocket) {
    return false;
  }
  if (cliIndex < 0 && !explicitPrimarySocket) return false;
  return true;
}

/**
 * Result of a stale-brain scan.
 *
 * `{ ok: false }` is NOT `{ ok: true, pids: [] }`: the first means the scan
 * mechanism could not answer at all, the second means it answered "none". The
 * two used to be the same value, which is how the Windows scan came to look
 * like a clean bill of health -- `ps -axo` does not exist there, `spawnSync`
 * returned `status: null`, and the `!== 0` guard turned that into an empty
 * list indistinguishable from a real answer.
 */
export type StaleChannelServeScan =
  | { ok: true; pids: number[] }
  | { ok: false; reason: string };

/**
 * PowerShell that prints `<pid>\t<command line>` for every process on the
 * machine, as the win32 equivalent of `ps -axo pid=,command=`.
 *
 * `Get-CimInstance Win32_Process` for the same reason as everywhere else in
 * this directory: `wmic` is deprecated and is being removed from Windows. A tab
 * delimiter rather than a space because Windows command lines start with a
 * quoted, space-bearing executable path.
 */
export function buildWindowsProcessCommandLineQueryArgs(): string[] {
  const query = [
    "$ErrorActionPreference = 'Stop'",
    "$rows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue"
      + " | Where-Object { $_.CommandLine } "
      + "| ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" })",
    "[Console]::Out.Write(($rows -join \"`n\"))",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function parseStaleChannelServePids(
  output: string,
  separator: RegExp,
  opts: { cliScriptPath: string; primarySocketPath: string; excludePids?: number[] },
): number[] {
  const exclude = new Set([process.pid, ...(opts.excludePids ?? [])]);
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(separator);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0 || exclude.has(pid)) continue;
    if (isStaleChannelServeCommandLine(match[2]!, opts)) pids.push(pid);
  }
  return pids;
}

export function listStaleChannelServePids(
  run: ServiceManagerSpawnSync,
  opts: { cliScriptPath: string; primarySocketPath: string; excludePids?: number[] },
  platform: NodeJS.Platform = process.platform,
): StaleChannelServeScan {
  if (platform === "win32") {
    let result: ServiceManagerProcessResult;
    try {
      result = run(
        resolveTrustedWindowsTool("powershell"),
        buildWindowsProcessCommandLineQueryArgs(),
        // Same budget as the other CIM lookups here: powershell.exe cold start
        // plus the first CIM call in a session routinely exceeds 5s on a
        // contended host, and a timeout is indistinguishable from a real answer.
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
      );
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        reason: serviceManagerResultText(result)
          || `the Windows process query exited with status ${String(result.status)}`,
      };
    }
    return {
      ok: true,
      pids: parseStaleChannelServePids(processOutputRaw(result), /^(\d+)\t(.+)$/, opts),
    };
  }
  const result = run("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: serviceManagerResultText(result)
        || `\`ps -axo\` exited with status ${String(result.status)}`,
    };
  }
  return {
    ok: true,
    pids: parseStaleChannelServePids(processOutputRaw(result), /^(\d+)\s+(.+)$/, opts),
  };
}

/** The channel brain a stop means to reach: this channel's CLI serving its primary socket. */
export type ChannelServeMatch = { cliScriptPath: string; primarySocketPath: string };

/**
 * The identity a force-kill of a channel brain needs, for `terminatePidGracefullyAsync`.
 *
 * A brain that accepted the shutdown request on the channel endpoint (`answered`)
 * is held to the stale-scan predicate. A pid that answered nothing must also name
 * the channel socket on its command line. Without `--socket` the endpoint comes
 * from the process environment, which this command line cannot show, so such a
 * process is left running rather than killed on a guess.
 */
export function channelServeIdentity(
  match: ChannelServeMatch,
): (facts: WindowsProcessFacts, answered: boolean) => boolean {
  return (facts, answered) =>
    isStaleChannelServeCommandLine(facts.commandLine, match)
    && (answered || serveSocketArgument(facts.commandLine) !== null);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A PowerShell single-quoted literal: a `'` doubles, nothing else is special. */
export function powerShellSingleQuotedLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("PowerShell values cannot contain NUL bytes.");
  return `'${value.replace(/'/g, "''")}'`;
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

/**
 * The CLI the app runs its brain from (`ADE_CLI_JS`, else the packaged one),
 * when this process is that app's Electron main. Main's argv names no script
 * (`ADE.exe` alone, or a file or deeplink it was opened with), so the argv
 * rules below would describe an `ADE serve` brain that never runs. Every
 * check that proves a live brain against this command then refuses the real
 * one: on Windows that refusal aborted every update install from 1.2.112 on.
 */
function electronMainCliScript(): string | null {
  const electronProcess = process as NodeJS.Process & { type?: string; resourcesPath?: string };
  if (electronProcess.type !== "browser") return null;
  // `resolveCliScriptPath` honors this override first, so this must too.
  const override = process.env.ADE_CLI_JS?.trim();
  if (override) return path.resolve(override);
  const resourcesPath = electronProcess.resourcesPath?.trim();
  if (!resourcesPath) return null;
  const cliPath = path.join(resourcesPath, "ade-cli", "cli.cjs");
  return fs.existsSync(cliPath) ? cliPath : null;
}

export function resolveAdeServeCommand(): AdeServiceCommand {
  // Same path `resolveCliScriptPath` in the desktop pool hands the brain it
  // spawns, so the command matches the running brain's character for character.
  const mainCli = electronMainCliScript();
  if (mainCli) {
    return withRuntimeBuildHash({
      command: process.execPath,
      args: [mainCli, "serve"],
      env: runtimeEnvironment(mainCli),
    });
  }
  const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
    ? path.resolve(process.argv[1])
    : "";
  const isNodeScript = /\.(?:cjs|mjs|js|ts)$/i.test(entry) && fs.existsSync(entry);
  if (isNodeScript) {
    return withRuntimeBuildHash({
      command: process.execPath,
      args: [entry, "serve"],
      env: runtimeEnvironment(entry),
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

/** Whether launchd has the job registered in the gui or user domain. */
export function isLaunchAgentRegistered(label: string, run: ServiceManagerSpawnSync = spawnSync): boolean {
  const uid = currentUid();
  return [`gui/${uid}`, `user/${uid}`].some(
    (domain) => run("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0,
  );
}

/** Whether the job is on launchd's disabled list for the gui domain. */
export function isLaunchAgentDisabled(label: string, run: ServiceManagerSpawnSync = spawnSync): boolean {
  const answer = run("launchctl", ["print-disabled", `gui/${currentUid()}`], { encoding: "utf8" });
  if (answer.status !== 0) return false;
  const line = (typeof answer.stdout === "string" ? answer.stdout : answer.stdout?.toString("utf8") ?? "")
    .split("\n")
    .find((entry) => entry.includes(`"${label}"`));
  // Older macOS prints `=> true` for a disabled job; newer prints `=> disabled`.
  return line != null && /=>\s*(disabled|true)\b/.test(line);
}

export type LaunchAgentLoadResult = { ok: true } | { ok: false; detail: string };

/**
 * Registers a LaunchAgent with launchd and confirms that it is registered.
 *
 * Never trust `launchctl load`'s exit code. For a job on launchd's disabled
 * list (the "Allow in the Background" switch turned off once, or an old
 * `unload -w`), `load` prints `Load failed: 5: Input/output error`, exits 0
 * and registers nothing. The kickstart that follows then fails with "Could not
 * find service". Two real Macs ended up there after an update, and Repair and
 * Reset both reinstalled through this same load, so neither could fix it.
 *
 * So: clear the disabled override, `bootstrap` into the gui domain (which
 * reports its errors), fall back to `load -w` where there is no gui domain
 * (an ssh session), and then ask launchd whether the job exists.
 */
export function loadLaunchAgent(
  servicePath: string,
  label: string,
  run: ServiceManagerSpawnSync = spawnSync,
): LaunchAgentLoadResult {
  const uid = currentUid();
  for (const domain of [`gui/${uid}`, `user/${uid}`]) {
    run("launchctl", ["enable", `${domain}/${label}`], { stdio: "ignore" });
  }
  const bootstrap = run("launchctl", ["bootstrap", `gui/${uid}`, servicePath], { encoding: "utf8" });
  if (isLaunchAgentRegistered(label, run)) return { ok: true };
  const bootstrapText = serviceManagerResultText(bootstrap)
    || `launchctl bootstrap exited with status ${bootstrap.status ?? "unknown"}.`;
  const load = run("launchctl", ["load", "-w", servicePath], { encoding: "utf8" });
  if (isLaunchAgentRegistered(label, run)) return { ok: true };
  const loadText = serviceManagerResultText(load);
  return {
    ok: false,
    detail: loadText ? `${bootstrapText} launchctl load: ${loadText}` : bootstrapText,
  };
}

/**
 * The registered service owns a live brain that has not answered on its socket
 * yet.
 *
 * Every path that could otherwise reach `spawnDaemon` has to see this and
 * stop: an unmanaged brain on a supervised socket is a second brain, and the
 * user's actual problem is only that the first one is still starting. The TUI
 * client and the machine-daemon path had a class each for exactly this, which
 * meant two places to keep the "do not spawn a rival" rule.
 */
export type RuntimeServiceStillStartingReason =
  /** The socket has not answered yet; nothing has been waited out. */
  | { kind: "not_answered"; socketPath: string; installMessage?: string | null }
  /** The installer failed but the registered service still owns recovery. */
  | { kind: "recovery_owned"; installMessage: string }
  /** A `starting` install outlasted the caller's own connect budget. */
  | { kind: "wait_exhausted"; socketPath: string; installMessage: string };

export function runtimeServiceStillStartingMessage(
  reason: RuntimeServiceStillStartingReason,
): string {
  if (reason.kind === "recovery_owned") {
    return `${reason.installMessage} The registered service still owns recovery for this endpoint, `
      + "so ADE did not start a competing manual brain.";
  }
  if (reason.kind === "wait_exhausted") {
    return `${reason.installMessage} It had still not answered on ${reason.socketPath} when ADE stopped waiting, `
      + "so ADE did not start a competing manual brain.";
  }
  const detail = reason.installMessage?.trim() ? ` (${reason.installMessage.trim()})` : "";
  return "ADE's background service is still starting — try again in a moment."
    + ` It had not answered on ${reason.socketPath} yet${detail}`
    + ", so ADE did not start a second brain alongside it.";
}

export class RuntimeServiceStillStartingError extends Error {
  readonly reason: RuntimeServiceStillStartingReason;

  constructor(reason: RuntimeServiceStillStartingReason) {
    super(runtimeServiceStillStartingMessage(reason));
    this.name = "RuntimeServiceStillStartingError";
    this.reason = reason;
  }
}
