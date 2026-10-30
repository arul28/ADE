import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExclusiveFileLockTimeoutError, withExclusiveFileLock } from "../lib/exclusiveFileLock";
import {
  resolveTrustedWindowsTool,
  TrustedWindowsToolError,
  type TrustedWindowsTool,
} from "../lib/trustedWindowsTools";
import {
  type AdeServiceCommand,
  channelServeIdentity,
  cmdQuote,
  isPidAlive,
  isStaleChannelServeCommandLine,
  killVerifiedWindowsProcess,
  listStaleChannelServePids,
  powerShellSingleQuotedLiteral,
  type PidStopOutcome,
  readWindowsProcessFacts,
  renderWindowsCommand,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  resolveRuntimeServiceName,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
  sameWindowsProcess,
  serviceManagerResultText,
  WINDOWS_HANDOVER_TIMEOUT_MS,
  terminatePidGracefullyAsync,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
  type WindowsPowerShell,
  type WindowsProcessFacts,
} from "./common";
import { parseCommandLine } from "../../../desktop/src/shared/shell";
import {
  resolveMachineAdeDir,
  resolveMachineAdeLayout,
  resolveReachableMachineRuntimeSocketPath,
} from "../services/projects/machineLayout";
import { BRAIN_HEARTBEAT_FILE } from "../services/runtime/brainHeartbeat";
import { BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE } from "../services/runtime/brainLoopWatchdog";
import {
  defaultWindowsRuntimeReadiness,
  queryWindowsSupervisor,
  readWindowsServicePidRecord as readWindowsSupervisorPidRecord,
  renderWindowsServiceLauncher,
  waitForWindowsRuntimeReadiness,
  windowsConsoleHostCommand,
  windowsPowerShellCommand,
  type WindowsRuntimeReadinessProbe,
  type WindowsServicePidRecord,
} from "./windowsSupervisor";
import { RUNTIME_SERVICE_INSTALL_LOCK_WAIT_MS } from "./runtimeServiceBudgets";

export {
  buildWindowsRuntimeQueryArgs,
  buildWindowsSupervisorQueryArgs,
  renderWindowsServiceLauncher,
  windowsPowerShellCommand,
  type WindowsServicePidRecord,
} from "./windowsSupervisor";

export const TASK_NAME = "ADE Runtime";
export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const TASK_NOT_FOUND_EXIT_CODE = 3;
const REGISTRY_VALUE_NOT_FOUND_EXIT_CODE = 1;

/**
 * `reg.exe` / `schtasks.exe` / `taskkill.exe`, resolved on first use and then
 * memoized -- see the note on `windowsPowerShellCommand`.
 *
 * These were module-scope `const`s, so a host where the GLOBALROOT lookup fails
 * took the whole CLI down at import time: `serviceManager/index` pulls this
 * module in, and the brain's own startup path pulls that in via
 * `sharedSyncListener`. Now only the commands that actually shell out to a tool
 * can fail, and they fail with a `ServiceManagerResult`.
 */
const trustedToolCache = new Map<TrustedWindowsTool, string>();

function trustedTool(tool: TrustedWindowsTool): string {
  const cached = trustedToolCache.get(tool);
  if (cached) return cached;
  const resolved = resolveTrustedWindowsTool(tool);
  trustedToolCache.set(tool, resolved);
  return resolved;
}

export function windowsRegCommand(): string {
  return trustedTool("reg");
}

export function windowsSchtasksCommand(): string {
  return trustedTool("schtasks");
}

/**
 * Converts a trusted-tool resolution failure into the typed refusal every
 * service-manager entry point already returns, instead of an unhandled throw.
 */
function isTrustedWindowsToolError(error: unknown): boolean {
  return error instanceof TrustedWindowsToolError;
}

function windowsToolFailureResult<T extends { ok: false; message: string }>(
  error: unknown,
  base: Omit<T, "ok" | "message">,
): T {
  return {
    ...base,
    ok: false,
    message: error instanceof Error
      ? `Unable to reach the Windows tools this operation needs: ${error.message}`
      : "Unable to reach the Windows tools this operation needs.",
  } as T;
}

type WindowsServiceManagerDeps = {
  command?: AdeServiceCommand;
  env?: NodeJS.ProcessEnv;
  launcherPath?: string;
  pidPath?: string;
  serviceName?: string;
  spawnSync?: ServiceManagerSpawnSync;
  userName?: string;
  readPidRecord?: (pidPath: string) => WindowsServicePidRecord | null;
  readinessProbe?: WindowsRuntimeReadinessProbe;
  handoverTimeoutMs?: number;
  handoverPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Process liveness for the supervisor/brain pids in the record; tests inject
   * it. Only ever a cheap gate on ENTERING the young-brain wait -- the
   * authority on whether a recorded pid is really ours is the readiness
   * probe's `Win32_Process` identity check, which runs inside that wait and
   * decides whether the install may report `starting`.
   */
  pidAlive?: (pid: number) => boolean;
};

function resolvedServiceName(
  deps: Pick<WindowsServiceManagerDeps, "env" | "serviceName">,
  command?: AdeServiceCommand,
): string {
  if (deps.serviceName?.trim()) return deps.serviceName.trim();
  return resolveRuntimeServiceName({
    ...(deps.env ?? process.env),
    ...(command?.env ?? {}),
  });
}

let cachedWindowsUserSid: string | null | undefined;

/**
 * The current user's Windows SID, or `null` when it cannot be read.
 *
 * ADE-160: the registered Run value's name must be identical whichever session
 * the install runs in. `USERDOMAIN` is not — it is `WORKGROUP` inside an
 * OpenSSH session and the machine name at the desktop — so an install over SSH
 * used to add a SECOND `ADE Runtime (stable-*)` value pointing at the same
 * launcher, and every later sign-in started two supervisors. A SID is the same
 * in every context of one account, so the value name is derived from it now.
 * `whoami` is not one of the hardened tools this file resolves, so the SID
 * comes from PowerShell's own identity; a host where even that fails falls back
 * to the bare account name.
 *
 * Memoized for the process: one account's SID cannot change, and install,
 * status and uninstall all call into this helper during a single CLI run.
 */
export function resolveWindowsUserSid(run: ServiceManagerSpawnSync = spawnSync): string | null {
  if (process.platform !== "win32") return null;
  if (cachedWindowsUserSid !== undefined) return cachedWindowsUserSid;
  let sid: string | null = null;
  try {
    const result = run(
      windowsPowerShellCommand(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const value = typeof result.stdout === "string"
      ? result.stdout.trim()
      : Buffer.isBuffer(result.stdout)
        ? result.stdout.toString("utf8").trim()
        : "";
    if (result.status === 0 && /^S-\d-\d+(?:-\d+)*$/i.test(value)) sid = value;
  } catch {
    // A host that will not hand over the trusted powershell, or a spawn that
    // failed outright, is a fallback case, not a failure of the install.
    sid = null;
  }
  cachedWindowsUserSid = sid;
  return sid;
}

export function resolveWindowsTaskUser(env: NodeJS.ProcessEnv = process.env): string {
  // Stable, session-independent identity for the Run value name and the
  // cross-session supervisor mutex.
  const sid = resolveWindowsUserSid();
  if (sid) return sid;
  // Fallback when the SID cannot be read. Deliberately NOT `USERDOMAIN`: that
  // is exactly the value that made an SSH install and a desktop install
  // disagree. The bare account name is the same in both contexts.
  const username = env.USERNAME?.trim() || os.userInfo().username.trim();
  if (!username) {
    throw new Error("Unable to resolve the current Windows user for background-service registration.");
  }
  const account = username.includes("\\")
    ? username.slice(username.lastIndexOf("\\") + 1).trim()
    : username;
  if (!account) {
    throw new Error("Unable to resolve the current Windows user for background-service registration.");
  }
  return account;
}

function serviceChannelLabel(serviceName: string): string {
  const normalized = serviceName.trim().toLowerCase();
  if (normalized === "com.ade.runtime") return "stable";
  if (normalized.endsWith(".alpha")) return "alpha";
  return "custom";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function resolveWindowsTaskName(args: {
  serviceName?: string;
  userName?: string;
} = {}): string {
  const serviceName = args.serviceName ?? resolveRuntimeServiceName();
  const userName = args.userName ?? resolveWindowsTaskUser();
  const identity = `${serviceName.trim().toLowerCase()}\0${userName.trim().toLowerCase()}`;
  return `${TASK_NAME} (${serviceChannelLabel(serviceName)}-${shortHash(identity)})`;
}

export function resolveWindowsAdeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.resolve(env.ADE_HOME?.trim() || resolveMachineAdeDir(env));
}

export function resolveWindowsServiceLauncherPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
} = {}): string {
  const env = args.env ?? process.env;
  const serviceName = args.serviceName ?? resolveRuntimeServiceName(env);
  const adeDir = resolveWindowsAdeDir(env);
  return path.win32.join(
    adeDir,
    "runtime",
    `brain-service-${shortHash(serviceName.trim().toLowerCase())}.ps1`,
  );
}

export function resolveWindowsServicePidPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
} = {}): string {
  return `${resolveWindowsServiceLauncherPath(args)}.pid.json`;
}

/**
 * launchd parity for `StandardOutPath`/`StandardErrorPath`: the detached,
 * hidden supervisor has nowhere to write, so without this a supervisor death
 * leaves no evidence anywhere on the machine.
 */
export function resolveWindowsSupervisorLogPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
} = {}): string {
  return `${resolveWindowsServiceLauncherPath(args)}.log`;
}

/**
 * launchd parity for the BRAIN's own `StandardOutPath`/`StandardErrorPath`:
 * the supervisor redirects the brain's stdout and stderr here (one file, a
 * stream tag per line, rotated at 10 MB). The supervisor log above holds only
 * the supervisor's own lines.
 */
export function resolveWindowsBrainOutputLogPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
  /** The launcher this service actually uses, when the caller already has it. */
  launcherPath?: string;
} = {}): string {
  return `${args.launcherPath ?? resolveWindowsServiceLauncherPath(args)}.output.log`;
}

export function readWindowsServicePidRecord(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
  pidPath?: string;
} = {}): WindowsServicePidRecord | null {
  const pidPath = args.pidPath ?? resolveWindowsServicePidPath(args);
  return readWindowsSupervisorPidRecord(pidPath);
}

export function buildWindowsCreateTaskArgs(
  command: string,
  userName = resolveWindowsTaskUser(),
  taskName = resolveWindowsTaskName({ userName }),
): string[] {
  return [
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    taskName,
    "/TR",
    command,
    "/RU",
    userName,
    "/IT",
    "/F",
  ];
}

export function buildWindowsRunTaskArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  return ["/Run", "/TN", taskName];
}

export function buildWindowsEndTaskArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  return ["/End", "/TN", taskName];
}

export function buildWindowsQueryTaskArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  const taskNameLiteral = powerShellSingleQuotedLiteral(taskName);
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `try { $task = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq ${taskNameLiteral} } | Select-Object -First 1 } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
    `if ($null -eq $task) { exit ${TASK_NOT_FOUND_EXIT_CODE} }`,
    "[Console]::Out.Write($task.State.ToString())",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

/**
 * The task's whole XML definition, for a diagnostic report.
 *
 * `schtasks /Query /XML` writes UTF-16 to stdout, which a UTF-8 read turns into
 * NUL-interleaved garbage. `Export-ScheduledTask` through `[Console]::Out`
 * emits ordinary text, the same way every other task query in this file does.
 */
export function buildWindowsExportTaskArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  const taskNameLiteral = powerShellSingleQuotedLiteral(taskName);
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `try { $xml = Export-ScheduledTask -TaskPath '\\' -TaskName ${taskNameLiteral} -ErrorAction Stop } catch { [Console]::Error.Write($_.Exception.Message); exit ${TASK_NOT_FOUND_EXIT_CODE} }`,
    `if ($null -eq $xml) { exit ${TASK_NOT_FOUND_EXIT_CODE} }`,
    "[Console]::Out.Write($xml)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

/** Delimits the Execute/Arguments fields emitted by the task action query. */
export const WINDOWS_TASK_ACTION_FIELD_SEPARATOR = "\u001f";

/**
 * The pre-channel installer registered a single global `ADE Runtime` task whose
 * name carried no channel or user identity, so the only durable ownership
 * evidence it left behind is its action: the packaged executable plus CLI entry
 * of the channel that created it. (Legacy actions never carried the runtime
 * environment, so `ADE_HOME` is not recoverable from them.) This query returns
 * the Execute/Arguments pair of every action, unit-separator delimited, so
 * migration can prove the task belongs to the current install before ending it.
 */
export function buildWindowsQueryTaskActionArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  const taskNameLiteral = powerShellSingleQuotedLiteral(taskName);
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `try { $task = Get-ScheduledTask -TaskPath '\\' -ErrorAction Stop | Where-Object { $_.TaskName -eq ${taskNameLiteral} } | Select-Object -First 1 } catch { [Console]::Error.Write($_.Exception.Message); exit 4 }`,
    `if ($null -eq $task) { exit ${TASK_NOT_FOUND_EXIT_CODE} }`,
    "$separator = [string][char]31",
    "$fields = @($task.Actions | ForEach-Object { [string]$_.Execute; [string]$_.Arguments })",
    "[Console]::Out.Write($fields -join $separator)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function normalizeWindowsPathText(value: string): string {
  return value
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/**
 * True when a legacy task action launches *this* channel's install. Both the
 * executable and the CLI entry must match, because development builds of every
 * channel share `process.execPath`; requiring the entry script as well keeps a
 * Beta operation from claiming a Stable task that happens to run the same Node.
 */
export function isWindowsLegacyTaskOwnedByCommand(
  output: string | Buffer | null | undefined,
  command: AdeServiceCommand,
): boolean {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output ?? "";
  if (!text.trim()) return false;
  const executable = normalizeWindowsPathText(command.command);
  if (!executable) return false;
  const cliScript = normalizeWindowsPathText(resolveAdeServeCliScriptPath(command));
  const fields = text.split(WINDOWS_TASK_ACTION_FIELD_SEPARATOR);
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const execute = normalizeWindowsPathText(fields[index] ?? "");
    if (execute !== executable) continue;
    // An absolute entry path can only appear at a real token boundary, because
    // its drive prefix cannot occur mid-token.
    if (cliScript && cliScript !== executable) {
      const args = normalizeWindowsPathText(fields[index + 1] ?? "");
      if (!args.includes(cliScript)) continue;
    }
    return true;
  }
  return false;
}

export function buildWindowsDeleteTaskArgs(
  taskName = resolveWindowsTaskName(),
): string[] {
  return ["/Delete", "/TN", taskName, "/F"];
}

export function buildWindowsRunKeyQueryArgs(valueName: string): string[] {
  return ["QUERY", WINDOWS_RUN_KEY, "/V", valueName];
}

export function buildWindowsRunKeyAddArgs(valueName: string, command: string): string[] {
  return ["ADD", WINDOWS_RUN_KEY, "/V", valueName, "/T", "REG_SZ", "/D", command, "/F"];
}

export function buildWindowsRunKeyDeleteArgs(valueName: string): string[] {
  return ["DELETE", WINDOWS_RUN_KEY, "/V", valueName, "/F"];
}

/**
 * The `ADE Runtime (<channel>-` prefix shared by every Run value this channel
 * owns, whatever user identity (and therefore hash) wrote it. Pruning by
 * prefix catches a value an older, SSH-run install left behind under a
 * different hash.
 */
export function windowsRunValuePrefix(serviceName: string): string {
  return `${TASK_NAME} (${serviceChannelLabel(serviceName)}-`;
}

/** Enumerates every value under the current user's Run key, not just one name. */
export function buildWindowsRunKeyListArgs(): string[] {
  return ["QUERY", WINDOWS_RUN_KEY];
}

export type WindowsRunValue = { name: string; command: string };

/**
 * Parse `reg query HKCU\...\Run` output. `reg` separates a value's name, type
 * and data with runs of four spaces; ADE's value names never carry one, the
 * same assumption `buildWindowsRunKeyQueryArgs` already relies on.
 */
export function parseWindowsRunKeyValues(
  output: string | Buffer | null | undefined,
): WindowsRunValue[] {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output ?? "";
  const values: WindowsRunValue[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    if (name) values.push({ name, command: match[3]!.trim() });
  }
  return values;
}

/** True when a Run value's command launches this exact launcher script. */
export function windowsRunCommandNamesLauncher(
  command: string,
  launcherPath: string,
): boolean {
  const normalizedLauncher = normalizeWindowsPathText(launcherPath);
  if (!normalizedLauncher) return false;
  const fileArg = /(?:^|\s)"?-file"?\s+(?:"([^"]+)"|(\S+))(?=\s|$)/i.exec(command);
  return fileArg != null && normalizeWindowsPathText(fileArg[1] ?? fileArg[2] ?? "") === normalizedLauncher;
}

/**
 * What a user is told when the always-on guarantee does not hold.
 *
 * macOS never needs this: `launchctl` owns the process, so "installed" and
 * "survives this session" are the same fact. On Windows they are two different
 * facts, and reporting only the first is how a session-bound brain came to look
 * like a healthy one.
 */
export const WINDOWS_SESSION_BOUND_WARNING =
  "The always-on guarantee does NOT hold: this machine refused both handovers "
  + "(Task Scheduler registration and WMI Win32_Process.Create), so the brain is "
  + "running inside the job object of the session that started it and Windows "
  + "will terminate it -- with no exit code and no restart -- as soon as that "
  + "terminal, editor or agent exits. It will come back at your next sign-in via "
  + "the startup entry. To make it always-on now, allow scheduled-task "
  + "registration or WMI process creation for your user, or run `ade brain "
  + "start` from a session that is not job-confined.";

/** Transient one-shot task used only to escape the caller's job object. */
export function resolveWindowsStartTaskName(taskName = resolveWindowsTaskName()): string {
  return `${taskName} (start)`;
}

/**
 * Registers, runs, and immediately unregisters a one-shot task whose action is
 * the supervisor launcher.
 *
 * `Register-ScheduledTask` is used rather than `schtasks /Create` because
 * `schtasks` caps `/TR` at 261 characters, which a deep `ADE_HOME` blows past;
 * the cmdlet has no such limit. `ExecutionTimeLimit` is explicitly zeroed --
 * the Task Scheduler default is three days, and an always-on brain must not be
 * terminated by its own launcher on day four. Unregistering does not terminate
 * the process the task already started, so nothing is left registered.
 *
 * ---
 *
 * Why this task needs no counterpart to the launchd `MaterializeDatalessFiles`
 * key.
 *
 * Windows has the same class of file the macOS key exists for: a OneDrive
 * Files On-Demand placeholder holds no contents until something reads it. The
 * difference is who is allowed to hydrate one. macOS gates materialization on a
 * per-process I/O policy that a launchd job does not get by default; Windows
 * gates it on the cloud filter driver being able to reach a sync engine running
 * in the reader's own logon session, and grants it to every ordinary process
 * there. This task registers no `-Principal`, so it runs as the user who
 * installed it, in that user's session -- the same session their OneDrive runs
 * in. Hydration is therefore already allowed, and there is no per-task setting
 * that would grant or deny it.
 *
 * The failure mode Windows does have is a hydration that is attempted and does
 * not finish: OneDrive signed out, offline, or paused. That surfaces as an
 * ERROR_CLOUD_FILE_* code rather than as EDEADLK, and classifying it belongs to
 * the storage errno classifier, not to this launcher.
 */
export function buildWindowsStartTaskArgs(
  launcherPath: string,
  startTaskName: string,
): string[] {
  // The action is the console host, not PowerShell: see `windowsLauncherCommand`.
  const launcherArguments = `--headless ${renderWindowsCommand(windowsLauncherPowerShellCommand(launcherPath))}`;
  const nameLiteral = powerShellSingleQuotedLiteral(startTaskName);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${powerShellSingleQuotedLiteral(windowsConsoleHostCommand())} -Argument ${powerShellSingleQuotedLiteral(launcherArguments)}`,
    // Far-future one-shot trigger: the task only ever runs because we start it.
    "$trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddDays(3650))",
    // Priority 4 is an ordinary app's. The default, 7, starts the supervisor
    // (and so the brain and the desktop driver, which inherit it) below normal
    // with LOW memory and I/O priority: on a PC under memory pressure Windows
    // trims the brain first and pages it back in behind every other process,
    // and its event loop sat in PageIn waits for 2-45 s at a time.
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4",
    [
      `try { Register-ScheduledTask -TaskName ${nameLiteral} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${nameLiteral}`,
      // Unregistering before the engine has spawned the action would cancel it,
      // so wait for the task to actually enter Running first.
      "$deadline = [DateTime]::UtcNow.AddSeconds(15)",
      `while ([DateTime]::UtcNow -lt $deadline -and (Get-ScheduledTask -TaskName ${nameLiteral} -ErrorAction SilentlyContinue).State -ne 'Running') { Start-Sleep -Milliseconds 100 } } finally { Unregister-ScheduledTask -TaskName ${nameLiteral} -Confirm:$false -ErrorAction SilentlyContinue }`,
    ].join("; "),
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Second escape route, used when Task Scheduler is unavailable or denied by
 * policy: create the supervisor through WMI's `Win32_Process.Create`.
 *
 * This is not a heuristic. Windows documents the behaviour directly in *Job
 * Objects*: "by default any child processes it creates using CreateProcess are
 * also associated with the job. (Child processes created using
 * Win32_Process.Create are not associated with the job.)" The process is
 * spawned by the WMI provider host `WmiPrvSE.exe`, which lives under the DCOM
 * service host, so it is not a descendant of the caller at all -- and unlike
 * the Task Scheduler route it ends up in no job whatsoever.
 *
 * It is the fallback rather than the primary because it is the more commonly
 * blocked of the two: WMI process creation is a well-known lateral-movement
 * technique and is what endpoint-protection rules disable first. The two
 * failure modes are largely independent, which is exactly what makes chaining
 * them worth doing.
 *
 * `Win32_ProcessStartup.ShowWindow` is set to SW_HIDE because a process created
 * this way gets default startup information rather than the caller's, so
 * without it an always-on brain would flash a console window.
 */
export function buildWindowsWmiStartArgs(launcherPath: string): string[] {
  const commandLine = windowsLauncherCommand(launcherPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$arguments = @{ CommandLine = ${powerShellSingleQuotedLiteral(commandLine)}; CurrentDirectory = ${powerShellSingleQuotedLiteral(path.win32.dirname(launcherPath))}; ProcessStartupInformation = [CimInstance]$startup }`,
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments",
    "if ($null -eq $result) { [Console]::Error.Write('Win32_Process.Create returned no result.'); exit 5 }",
    "if ($result.ReturnValue -ne 0) { [Console]::Error.Write(\"Win32_Process.Create failed with return value $($result.ReturnValue).\"); exit 5 }",
    "[Console]::Out.Write($result.ProcessId)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Starts the supervisor **outside the caller's job object**.
 *
 * A process started with `Process.Start`/`ShellExecuteEx` is an ordinary
 * descendant of whoever ran `ade brain start`, and on Windows job membership is
 * inherited and cannot be escaped: `CREATE_BREAKAWAY_FROM_JOB` fails with
 * ERROR_ACCESS_DENIED unless the job sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK`,
 * which kill-on-close jobs do not. Terminals, editors, CI agents and Electron
 * all put their children in `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` jobs, so the
 * supervisor *and* the brain it guards were silently terminated the moment the
 * session that installed them went away -- no exit code, no log, no restart.
 *
 * The Task Scheduler service starts task actions itself, so a process launched
 * through a task is parented to `svchost.exe` and belongs to no job of ours.
 * That is the same ownership handover macOS gets from `launchctl load`, and it
 * matches the login path, where `explorer.exe` (also job-free) runs the HKCU
 * `Run` entry.
 *
 * A one-shot task is used rather than an ONLOGON one because ONLOGON task
 * registration requires elevation while a one-shot does not -- which is exactly
 * why login persistence stays on the HKCU `Run` key.
 */
function startWindowsSupervisorDetached(
  run: ServiceManagerSpawnSync,
  launcherPath: string,
  taskName: string,
): string | null {
  const viaTask = run(
    windowsPowerShellCommand(),
    buildWindowsStartTaskArgs(launcherPath, resolveWindowsStartTaskName(taskName)),
    { encoding: "utf8", windowsHide: true },
  );
  if (viaTask.status === 0) return null;
  // Task Scheduler is unavailable or denied by policy. WMI is a second,
  // independently documented escape: `Win32_Process.Create` children are not
  // associated with the caller's job.
  const viaWmi = run(windowsPowerShellCommand(), buildWindowsWmiStartArgs(launcherPath), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (viaWmi.status === 0) return null;
  // Both handovers refused. The in-session launch still brings the brain up,
  // but it is bound to the lifetime of the session that started it. The
  // supervisor detects that about itself and records it, so `brain status`
  // says so out loud instead of reporting a healthy always-on brain.
  const start = run(windowsPowerShellCommand(), buildWindowsStartLauncherArgs(launcherPath), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (start.status === 0) return null;
  return serviceManagerResultText(start) || "PowerShell launch failed.";
}

export function buildWindowsStartLauncherArgs(launcherPath: string): string[] {
  const childArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
  ];
  const childCommandLine = childArgs.map(cmdQuote).join(" ");
  const command = [
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    `$startInfo.FileName = ${powerShellSingleQuotedLiteral(windowsPowerShellCommand())}`,
    `$startInfo.Arguments = ${powerShellSingleQuotedLiteral(childCommandLine)}`,
    "$startInfo.UseShellExecute = $true",
    "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
    "$process = [System.Diagnostics.Process]::Start($startInfo)",
    "if ($null -eq $process) { throw 'Windows failed to start the ADE brain supervisor.' }",
    "[Console]::Out.Write($process.Id)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", command];
}

export function isWindowsTaskStateRunning(output: string | Buffer | null | undefined): boolean {
  const state = Buffer.isBuffer(output) ? output.toString("utf8") : output ?? "";
  return state.trim().toLowerCase() === "running";
}

type WindowsTaskRemovalResult =
  | { ok: true; removed: boolean }
  | { ok: false; message: string };

/** What a scheduled task is, read without changing it. */
type WindowsTaskState =
  | { ok: true; present: false }
  | { ok: true; present: true; running: boolean }
  | { ok: false; message: string };

/**
 * Reads a scheduled task, and for the legacy name whether this command owns it,
 * without changing anything. A caller that must identify its processes first reads
 * here, and removes the task with `endAndDeleteWindowsTask` once that is done.
 */
function inspectWindowsTask(
  run: ServiceManagerSpawnSync,
  taskName: string,
  description: string,
  /**
   * Present only for the unnamespaced legacy task. Channel task names already
   * encode the channel and the Windows principal, so they need no extra proof
   * of ownership; the legacy name is global and shared across every channel on
   * the machine, so it must not be touched without one.
   */
  ownedBy?: AdeServiceCommand,
): WindowsTaskState {
  const query = run(
    windowsPowerShellCommand(),
    buildWindowsQueryTaskArgs(taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (query.status === TASK_NOT_FOUND_EXIT_CODE) {
    return { ok: true, present: false };
  }
  if (query.status !== 0) {
    return {
      ok: false,
      message: `Unable to query the ${description}: ${serviceManagerResultText(query) || "PowerShell task query failed."}`,
    };
  }
  if (ownedBy) {
    const action = run(
      windowsPowerShellCommand(),
      buildWindowsQueryTaskActionArgs(taskName),
      { encoding: "utf8", windowsHide: true },
    );
    if (action.status === TASK_NOT_FOUND_EXIT_CODE) {
      return { ok: true, present: false };
    }
    if (action.status !== 0) {
      return {
        ok: false,
        message: `Unable to query the ${description}: ${serviceManagerResultText(action) || "PowerShell task action query failed."}`,
      };
    }
    // Another channel's always-on brain. Leaving it running is the whole point
    // of side-by-side isolation; `ade brain status` still reports it.
    if (!isWindowsLegacyTaskOwnedByCommand(action.stdout, ownedBy)) {
      return { ok: true, present: false };
    }
  }
  return { ok: true, present: true, running: isWindowsTaskStateRunning(query.stdout) };
}

/** Ends a running task and deletes it. Only for a task `inspectWindowsTask` found present. */
function endAndDeleteWindowsTask(
  run: ServiceManagerSpawnSync,
  taskName: string,
  description: string,
  state: Extract<WindowsTaskState, { present: true }>,
): WindowsTaskRemovalResult {
  if (state.running) {
    const end = run(windowsSchtasksCommand(), buildWindowsEndTaskArgs(taskName), {
      encoding: "utf8",
      windowsHide: true,
    });
    if (end.status !== 0) {
      return {
        ok: false,
        message: `Unable to end the ${description}: ${serviceManagerResultText(end) || "schtasks end failed."}`,
      };
    }
  }
  const remove = run(windowsSchtasksCommand(), buildWindowsDeleteTaskArgs(taskName), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (remove.status !== 0) {
    return {
      ok: false,
      message: `Unable to delete the ${description}: ${serviceManagerResultText(remove) || "schtasks delete failed."}`,
    };
  }
  return { ok: true, removed: true };
}

function removeWindowsTaskIfPresent(
  run: ServiceManagerSpawnSync,
  taskName: string,
  description: string,
  ownedBy?: AdeServiceCommand,
): WindowsTaskRemovalResult {
  const state = inspectWindowsTask(run, taskName, description, ownedBy);
  if (!state.ok) return state;
  if (!state.present) return { ok: true, removed: false };
  return endAndDeleteWindowsTask(run, taskName, description, state);
}

/** The supervisor process itself: Windows PowerShell running the launcher script. */
function windowsLauncherPowerShellCommand(launcherPath: string): AdeServiceCommand {
  return {
    command: windowsPowerShellCommand(),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
    ],
  };
}

/**
 * The command line that starts the supervisor at sign-in (the Run value) and
 * through WMI: the launcher's PowerShell, inside `conhost.exe --headless`.
 *
 * Started bare, powershell.exe is a console program with no console to
 * inherit, so Windows opens one for it -- on Windows 11 that is a Windows
 * Terminal window, which takes the foreground -- and `-WindowStyle Hidden`
 * only hides it once PowerShell is already running. Every sign-in, update,
 * repair and restart flashed a terminal and stole the user's keystrokes. A
 * headless console host gives PowerShell a console with no window at all.
 * conhost starts the client with this same command line, so the supervisor is
 * still a powershell.exe whose command line names the launcher, which is what
 * the PID and predecessor checks look for.
 */
function windowsLauncherCommand(launcherPath: string): string {
  return `${cmdQuote(windowsConsoleHostCommand())} --headless ${renderWindowsCommand(windowsLauncherPowerShellCommand(launcherPath))}`;
}

/**
 * Stops the brain the supervisor was guarding, cooperatively first.
 *
 * The macOS counterpart of this path (`installLaunchd`) sends a real SIGTERM
 * and the brain's handler flushes SQLite/CRDT state, tears down sockets and
 * releases the sync-host lock before exiting. Windows has no catchable signal,
 * and this path used to be a single `taskkill /PID <supervisor> /T /F` -- which
 * takes the brain down with the supervisor tree, mid-write, on the very common
 * `ade serve --install-service` / reinstall route. The next start then had to
 * recover from a lock file its owner never got to release.
 *
 * The sequence itself lives in `common.terminatePidGracefullyAsync`: it asks
 * over the RPC endpoint (same `finish()` macOS gets), waits out the grace
 * window, and forces only what is still standing. Crucially it verifies the pid
 * over `runtime/info` before asking anything to exit, so a recycled pid from a
 * stale supervisor record cannot talk down an unrelated brain. The last-resort
 * kill is a verified kill: it reads the process, lets `isExpectedProcess` decide,
 * and kills only that exact process through a handle, so a pid reused in between
 * is left alone. The PowerShell calls go through this file's injected `spawnSync`,
 * so tests observe the escalation instead of really killing a pid.
 *
 * The supervisor must already be gone when this runs, or it would simply
 * restart the brain we just stopped. The caller decides `isExpectedProcess` before
 * that stop, from the facts it read while the supervisor was still alive.
 */
async function stopWindowsBrainGracefully(
  run: ServiceManagerSpawnSync,
  args: {
    socketPath: string;
    runtimePid: number;
    isExpectedProcess: (facts: WindowsProcessFacts, answered: boolean) => boolean;
  },
): Promise<PidStopOutcome> {
  return terminatePidGracefullyAsync(args.runtimePid, {
    platform: "win32",
    runtimeSocketPath: args.socketPath,
    runWindowsPowerShell: windowsPowerShellRunner(run),
    isExpectedProcess: args.isExpectedProcess,
  });
}

/** The PowerShell boundary for identity reads and verified kills, through this file's injected `spawnSync`. */
function windowsPowerShellRunner(run: ServiceManagerSpawnSync): WindowsPowerShell {
  return (args) => run(windowsPowerShellCommand(), args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

/**
 * Whether `facts` is this launcher's supervisor: a powershell running the
 * launcher script, the same identity `queryWindowsSupervisor` checks.
 */
function isLauncherSupervisor(facts: WindowsProcessFacts, launcherPath: string): boolean {
  const executable = facts.executablePath ? path.win32.basename(facts.executablePath).toLowerCase() : "";
  return /^powershell(\.exe)?$/.test(executable)
    && facts.commandLine.toLowerCase().includes(launcherPath.toLowerCase());
}

const LAUNCHER_START_INFO_LINE = /^\$startInfo\.(FileName|Arguments) = '((?:[^']|'')*)'\s*$/gm;

/**
 * The brain command a launcher script runs, read back from the `$startInfo`
 * lines `renderWindowsServiceLauncher` wrote into it. Null when the script is
 * missing or does not have that shape.
 *
 * Whoever installed the service decided this command, and it need not be the
 * caller's own: the app's brain is `ADE.exe …\ade-cli\cli.cjs serve`, while a
 * standalone runtime's is `ade.exe serve`, and either may stop the other's.
 * Proving the live brain against the caller's command alone refused every such
 * pair, which aborted Windows update installs from 1.2.112 on.
 */
function readLauncherBrainCommand(launcherPath: string): AdeServiceCommand | null {
  let script: string;
  try {
    script = fs.readFileSync(launcherPath, "utf8");
  } catch {
    return null;
  }
  const fields: Partial<Record<"FileName" | "Arguments", string>> = {};
  for (const match of script.matchAll(LAUNCHER_START_INFO_LINE)) {
    const key = match[1] as "FileName" | "Arguments";
    // The first assignment is the brain's; a later one would be something else.
    fields[key] ??= (match[2] ?? "").replace(/''/g, "'");
  }
  const command = fields.FileName?.trim();
  if (!command || fields.Arguments == null) return null;
  return { command, args: parseCommandLine(fields.Arguments, { platform: "win32" }) };
}

/** The brain command this channel's installed Windows service runs, or null when none is installed. */
export function readWindowsServiceBrainCommand(env: NodeJS.ProcessEnv = process.env): AdeServiceCommand | null {
  return readLauncherBrainCommand(resolveWindowsServiceLauncherPath({ env }));
}

/**
 * Reads the brain the supervisor recorded, while that supervisor still runs, and
 * proves it. The proof is that its command line is this channel's serve brain and
 * its parent is the supervisor. "This channel's serve brain" is the command the
 * launcher runs, or the caller's own when the launcher cannot be read. A
 * supervisor that is gone cannot vouch for the parent afterwards, so this runs
 * before anything is stopped. `facts` is null when the recorded brain is already
 * gone.
 */
async function readRecordedBrain(
  run: ServiceManagerSpawnSync,
  args: {
    runtimePid: number;
    supervisorPid: number;
    command: AdeServiceCommand;
    socketPath: string;
    launcherPath: string;
  },
): Promise<{ ok: true; facts: WindowsProcessFacts | null } | { ok: false; message: string }> {
  const read = await readWindowsProcessFacts(args.runtimePid, windowsPowerShellRunner(run));
  if (read.state === "gone") return { ok: true, facts: null };
  const unverified = {
    ok: false as const,
    message: `Could not verify the brain process ${args.runtimePid}; it was left running. Nothing was changed.`,
  };
  if (read.state === "unreadable") return unverified;
  const candidates = [readLauncherBrainCommand(args.launcherPath), args.command]
    .filter((command): command is AdeServiceCommand => command !== null);
  const isServeBrain = candidates.some((command) =>
    isStaleChannelServeCommandLine(read.facts.commandLine, {
      cliScriptPath: resolveAdeServeCliScriptPath(command),
      primarySocketPath: args.socketPath,
    }));
  if (!isServeBrain) return unverified;
  if (read.facts.parentPid !== args.supervisorPid) return unverified;
  return { ok: true, facts: read.facts };
}

/**
 * What the startup-entry removal will stop, identified before anything changes.
 * `ok: false` is a refusal, and nothing has been changed when it is returned.
 */
type WindowsStartupPlan =
  | { ok: false; message: string }
  | {
    ok: true;
    /** The per-user startup Run value exists, so it is deleted. */
    installed: boolean;
    /** The recorded supervisor is running. */
    supervisorRunning: boolean;
    /** The recorded supervisor as read, while it is still running. */
    supervisor: WindowsProcessFacts | null;
    /** The recorded brain as read, when the supervisor that started it is ours. */
    brain: { socketPath: string; runtimePid: number; facts: WindowsProcessFacts } | null;
    /** Every other ADE supervisor of this launcher, and its children, as read. */
    predecessors: WindowsPredecessorGroup[];
  };

/**
 * Reads everything the startup-entry removal would stop, and decides whether it may.
 * It only reads: a refusal leaves the startup entry, the scheduled task and every
 * process as they were.
 */
async function planWindowsStartupRemoval(
  run: ServiceManagerSpawnSync,
  args: {
    valueName: string;
    launcherPath: string;
    pidPath: string;
    /**
     * Present whenever the caller can name the brain's endpoint and the command it
     * runs. Without it there is no cooperative channel, and the brain is not
     * stopped here; the supervisor tree is still force-killed.
     */
    brain?: { socketPath: string; command: AdeServiceCommand };
  },
): Promise<WindowsStartupPlan> {
  const query = run(windowsRegCommand(), buildWindowsRunKeyQueryArgs(args.valueName), {
    encoding: "utf8",
    windowsHide: true,
  });
  const installed = query.status === 0;
  if (!installed && query.status !== REGISTRY_VALUE_NOT_FOUND_EXIT_CODE) {
    return {
      ok: false,
      message: `Unable to query the ADE per-user startup entry: ${serviceManagerResultText(query) || "reg query failed."}`,
    };
  }

  const supervisor = queryWindowsSupervisor({
    spawnSync: run,
    launcherPath: args.launcherPath,
    pidPath: args.pidPath,
  });
  if (supervisor.error) return { ok: false, message: supervisor.error };
  let supervisorFacts: WindowsProcessFacts | null = null;
  let brain: Extract<WindowsStartupPlan, { ok: true }>["brain"] = null;
  if (supervisor.running && supervisor.pid) {
    const supervisorPid = supervisor.pid;
    // The brain is the supervisor's child, so `/T` would kill it here. Take the
    // supervisor alone first -- it is a stateless restart loop with nothing to
    // flush -- and only then talk the brain down. Without this ordering the
    // supervisor would relaunch the brain the moment it exited.
    const runtimePid = args.brain ? supervisor.record?.runtimePid ?? null : null;
    // Identify the brain before anything is stopped. Its proof names this
    // supervisor as the parent, which only holds while the supervisor still runs.
    if (args.brain && runtimePid != null) {
      const recorded = await readRecordedBrain(run, {
        runtimePid,
        supervisorPid,
        command: args.brain.command,
        socketPath: args.brain.socketPath,
        launcherPath: args.launcherPath,
      });
      if (!recorded.ok) return { ok: false, message: recorded.message };
      if (recorded.facts) {
        brain = { socketPath: args.brain.socketPath, runtimePid, facts: recorded.facts };
      }
    }
    // The supervisor is killed only as it is read here, and only while it is still
    // this launcher's. With no recorded brain there is no brain of this channel left
    // to stop, because the supervisor records every brain it starts.
    const read = await readWindowsProcessFacts(supervisorPid, windowsPowerShellRunner(run));
    if (
      read.state === "unreadable"
      || (read.state === "found" && !isLauncherSupervisor(read.facts, args.launcherPath))
    ) {
      return {
        ok: false,
        message: `Could not verify the ADE startup process ${supervisorPid}; it was left running. Nothing was changed.`,
      };
    }
    if (read.state === "found") supervisorFacts = read.facts;
  }

  const listing = readWindowsPredecessorListing(run, args.launcherPath);
  if (!listing.ok) return { ok: false, message: listing.message };
  const predecessors = await confirmWindowsPredecessors(run, listing.groups);
  if (!predecessors.ok) return { ok: false, message: predecessors.message };

  return {
    ok: true,
    installed,
    supervisorRunning: supervisor.running,
    supervisor: supervisorFacts,
    brain,
    predecessors: predecessors.groups,
  };
}

/**
 * Stops what the plan identified, then deletes the startup Run value. The supervisor
 * goes first and alone, and the brain only once it is gone, because a live
 * supervisor would start the brain again. Every kill is verified against the facts
 * the plan read.
 */
async function removeWindowsStartupEntry(
  run: ServiceManagerSpawnSync,
  args: { valueName: string; pidPath: string },
  plan: Extract<WindowsStartupPlan, { ok: true }>,
): Promise<WindowsTaskRemovalResult> {
  if (plan.supervisor) {
    // Killed by its verified handle and nothing else: never a bare pid, and never a tree.
    const outcome = await killVerifiedWindowsProcess(plan.supervisor, windowsPowerShellRunner(run));
    if (outcome === "not-proven" || outcome === "failed") {
      return {
        ok: false,
        message: `Could not verify the ADE startup process ${plan.supervisor.pid}; it was left running.`,
      };
    }
  }
  if (plan.brain) {
    // Only this exact process, as the plan read it, may be stopped: a pid reused since
    // then is a different process and is left alone.
    const brainFacts = plan.brain.facts;
    const outcome = await stopWindowsBrainGracefully(run, {
      socketPath: plan.brain.socketPath,
      runtimePid: plan.brain.runtimePid,
      isExpectedProcess: (live) => sameWindowsProcess(live, brainFacts),
    });
    if (outcome === "not-proven" || outcome === "failed") {
      return {
        ok: false,
        message: `Could not verify the brain process ${plan.brain.runtimePid}; it was left running.`,
      };
    }
  }
  if (plan.installed) {
    const remove = run(windowsRegCommand(), buildWindowsRunKeyDeleteArgs(args.valueName), {
      encoding: "utf8",
      windowsHide: true,
    });
    if (remove.status !== 0) {
      return {
        ok: false,
        message: `Unable to delete the ADE per-user startup entry: ${serviceManagerResultText(remove) || "reg delete failed."}`,
      };
    }
  }
  try { fs.rmSync(args.pidPath, { force: true }); } catch { /* advisory record */ }
  return { ok: true, removed: plan.installed || plan.supervisorRunning };
}

type WindowsRunPruneResult =
  | { ok: true; removed: string[] }
  | { ok: false; removed: string[]; message: string };

/**
 * Delete every Run value that belongs to this channel or names this launcher,
 * except `keepValueName` when one is given.
 *
 * The ADE-160 residue was TWO `ADE Runtime (stable-*)` values pointing at the
 * same launcher, because an SSH install hashed a different `USERDOMAIN` than a
 * desktop install. Removing only the value the current context computes a name
 * for never removed the other one, so every sign-in started two supervisors.
 * Matching on the channel prefix AND on the launcher path also reaps a value
 * written before the naming scheme stabilised. Returns what it removed so the
 * caller can report it.
 */
function pruneWindowsRunValues(
  run: ServiceManagerSpawnSync,
  args: { serviceName: string; launcherPath: string; keepValueName?: string | null },
): WindowsRunPruneResult {
  const query = run(windowsRegCommand(), buildWindowsRunKeyListArgs(), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (query.status !== 0 && query.status !== REGISTRY_VALUE_NOT_FOUND_EXIT_CODE) {
    return {
      ok: false,
      removed: [],
      message: `Unable to list the ADE per-user startup entries: ${serviceManagerResultText(query) || "reg query failed."}`,
    };
  }
  const removed: string[] = [];
  for (const value of parseWindowsRunKeyValues(query.stdout)) {
    if (args.keepValueName && value.name === args.keepValueName) continue;
    // Channel labels are not ownership: distinct custom services share one.
    // Domain/SSH duplicate hashes still name the same canonical launcher.
    if (!windowsRunCommandNamesLauncher(value.command, args.launcherPath)) continue;
    const remove = run(windowsRegCommand(), buildWindowsRunKeyDeleteArgs(value.name), {
      encoding: "utf8",
      windowsHide: true,
    });
    if (remove.status !== 0) {
      return {
        ok: false,
        removed,
        message: `Unable to remove a stale ADE per-user startup entry: ${serviceManagerResultText(remove) || "reg delete failed."}`,
      };
    }
    removed.push(value.name);
  }
  if (removed.length > 0) {
    try {
      process.stderr.write(
        `ADE removed ${removed.length} stale startup ${removed.length === 1 ? "entry" : "entries"}: ${removed.join(", ")}\n`,
      );
    } catch { /* logging is best effort */ }
  }
  return { ok: true, removed };
}

/** One ADE supervisor of this launcher, and the processes it started, as read at one moment. */
type WindowsPredecessorGroup = { supervisor: WindowsProcessFacts; children: WindowsProcessFacts[] };

/**
 * PowerShell that lists the supervisors of this launcher that run in this user's
 * session, and each one's child processes, as they are now. Read-only: it stops
 * nothing. One tab-separated line per process: `S` for a supervisor or `C` for a
 * child, then pid, parent pid, birth time, executable path and command line. The
 * command line comes last, so a tab inside it survives.
 *
 * The PID record is last-writer-wins, so a live supervisor the record does not name
 * is invisible to `queryWindowsSupervisor`. The command line is the durable identity,
 * so install and uninstall use this to find every predecessor, including one started
 * by another logon session, before either removes or starts anything.
 */
function buildWindowsPredecessorQueryArgs(launcherPath: string): string[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Command lines carry user paths, which may hold non-ASCII; the facts must reach
    // the caller byte-for-byte, so they match what the verified kill reads back.
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$launcher = ${powerShellSingleQuotedLiteral(launcherPath)}`,
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$escaped = [Regex]::Escape($launcher)",
    `$pattern = '(?i)(?:^|\\s)-File\\s+(?:"' + $escaped + '"|' + $escaped + ')(?=\\s|$)'`,
    "$lines = [System.Collections.Generic.List[string]]::new()",
    "function Format-ProcessLine([string]$kind, $row) {",
    "  \"$kind`t$($row.ProcessId)`t$($row.ParentProcessId)`t$(([datetime]$row.CreationDate).ToUniversalTime().ToString('o'))`t$($row.ExecutablePath)`t$($row.CommandLine)\"",
    "}",
    "foreach ($row in @(Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\")) {",
    "  if (-not $row.CommandLine -or $row.CommandLine -notmatch $pattern) { continue }",
    "  $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid",
    "  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { continue }",
    "  $lines.Add((Format-ProcessLine 'S' $row))",
    "  foreach ($childRow in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $row.ProcessId))) {",
    "    $childOwner = Invoke-CimMethod -InputObject $childRow -MethodName GetOwnerSid",
    "    if ($childOwner.ReturnValue -ne 0 -or $childOwner.Sid -ne $sid) { continue }",
    // A child born before its parent cannot be its child: the parent's pid was reused.
    "    if (([datetime]$childRow.CreationDate) -lt ([datetime]$row.CreationDate)) { continue }",
    "    $lines.Add((Format-ProcessLine 'C' $childRow))",
    "  }",
    "}",
    "[Console]::Out.Write(($lines -join \"`n\"))",
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Parses the listing. A line that does not parse makes the whole listing unreadable
 * (`null`), so nothing is stopped on a guess. A child whose supervisor is not in the
 * listing is not stopped.
 */
function parseWindowsPredecessorListing(output: string): WindowsPredecessorGroup[] | null {
  const groups: WindowsPredecessorGroup[] = [];
  const children: Array<{ parentPid: number; facts: WindowsProcessFacts }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [kind, pidText, parentText, startTime, executablePath, ...commandParts] = line.split("\t");
    const commandLine = commandParts.join("\t");
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0 || !startTime || !commandLine) {
      return null;
    }
    const facts: WindowsProcessFacts = {
      pid,
      startTime,
      commandLine,
      executablePath: executablePath || null,
      parentPid: parentPid || null,
    };
    if (kind === "S") groups.push({ supervisor: facts, children: [] });
    else if (kind === "C") children.push({ parentPid, facts });
    else return null;
  }
  for (const child of children) {
    groups.find((group) => group.supervisor.pid === child.parentPid)?.children.push(child.facts);
  }
  return groups;
}

/** Reads the predecessors of this launcher, as they are now. Changes nothing. */
function readWindowsPredecessorListing(
  run: ServiceManagerSpawnSync,
  launcherPath: string,
): { ok: true; groups: WindowsPredecessorGroup[] } | { ok: false; message: string } {
  const result = run(windowsPowerShellCommand(), buildWindowsPredecessorQueryArgs(launcherPath), {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      message: `Unable to verify the existing ADE supervisors: ${serviceManagerResultText(result) || "the identity check failed."} Nothing was changed.`,
    };
  }
  const groups = parseWindowsPredecessorListing(String(result.stdout ?? ""));
  if (!groups) {
    return {
      ok: false,
      message: "Unable to verify the existing ADE supervisors: the process listing was unreadable. Nothing was changed.",
    };
  }
  return { ok: true, groups };
}

/** The live facts of `expected` while they still match it exactly; `gone` once it has exited; `unverified` otherwise. */
async function confirmWindowsProcess(
  expected: WindowsProcessFacts,
  runner: WindowsPowerShell,
): Promise<WindowsProcessFacts | "gone" | "unverified"> {
  const read = await readWindowsProcessFacts(expected.pid, runner);
  if (read.state === "gone") return "gone";
  if (read.state === "unreadable") return "unverified";
  return sameWindowsProcess(read.facts, expected) ? read.facts : "unverified";
}

/**
 * Re-reads every process the listing named, and keeps only those still exactly as
 * listed. A supervisor that has exited takes its children out of scope, as it always
 * has. One that changed since it was listed (a reused pid, or a different command
 * line) refuses the whole stop.
 */
async function confirmWindowsPredecessors(
  run: ServiceManagerSpawnSync,
  groups: WindowsPredecessorGroup[],
): Promise<{ ok: true; groups: WindowsPredecessorGroup[] } | { ok: false; message: string }> {
  const runner = windowsPowerShellRunner(run);
  const confirmed: WindowsPredecessorGroup[] = [];
  for (const group of groups) {
    const supervisor = await confirmWindowsProcess(group.supervisor, runner);
    if (supervisor === "unverified") {
      return {
        ok: false,
        message: `Could not verify the ADE supervisor process ${group.supervisor.pid}; it was left running. Nothing was changed.`,
      };
    }
    if (supervisor === "gone") continue;
    const children: WindowsProcessFacts[] = [];
    for (const child of group.children) {
      const live = await confirmWindowsProcess(child, runner);
      if (live === "unverified") {
        return {
          ok: false,
          message: `Could not verify the ADE brain process ${child.pid}; it was left running. Nothing was changed.`,
        };
      }
      if (live !== "gone") children.push(live);
    }
    confirmed.push({ supervisor, children });
  }
  return { ok: true, groups: confirmed };
}

/**
 * Stops the confirmed predecessors: each supervisor, then its children, every kill
 * verified against the facts confirmed above. A process that no longer matches is a
 * failure, not a skip.
 */
async function stopWindowsPredecessors(
  run: ServiceManagerSpawnSync,
  groups: WindowsPredecessorGroup[],
): Promise<WindowsTaskRemovalResult> {
  const runner = windowsPowerShellRunner(run);
  let removed = false;
  for (const group of groups) {
    const supervisorOutcome = await killVerifiedWindowsProcess(group.supervisor, runner);
    if (supervisorOutcome === "not-proven" || supervisorOutcome === "failed") {
      return {
        ok: false,
        message: `Could not stop the ADE supervisor ${group.supervisor.pid}; it was left running.`,
      };
    }
    if (supervisorOutcome === "killed") removed = true;
    for (const child of group.children) {
      const outcome = await killVerifiedWindowsProcess(child, runner);
      if (outcome === "not-proven" || outcome === "failed") {
        return {
          ok: false,
          message: `Could not stop the ADE brain process ${child.pid}; it was left running.`,
        };
      }
    }
  }
  return { ok: true, removed };
}

export async function installWindowsService(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  try {
    return await withWindowsServiceInstallLock(deps, "install", () => installWindowsServiceImpl(deps));
  } catch (error) {
    if (!isTrustedWindowsToolError(error)) throw error;
    return windowsToolFailureResult<ServiceManagerResult & { ok: false; message: string }>(error, {
      serviceName: resolvedServiceName(deps),
      action: "install",
      path: null,
    });
  }
}

/**
 * One install or uninstall at a time per ADE home. Two of them racing is how a
 * brain one of them just started gets replaced by the other: the second finds
 * the new brain not ready yet, falls through to replacement and stops it. Queued
 * behind the first, the second takes the keep or young-brain path instead.
 *
 * The lock sits beside the launcher, which is `<ADE home>\runtime` in production
 * (the directory resolveMachineAdeLayout().runtimeDir names). A test that points
 * launcherPath at a temp dir therefore never takes a real ADE home's lock.
 */
async function withWindowsServiceInstallLock(
  deps: WindowsServiceManagerDeps,
  action: "install" | "uninstall",
  task: () => Promise<ServiceManagerResult>,
): Promise<ServiceManagerResult> {
  const serviceCommand = deps.command ?? resolveAdeServeCommand();
  const runtimeEnv = { ...(deps.env ?? process.env), ...(serviceCommand.env ?? {}) };
  const serviceName = resolvedServiceName(deps, serviceCommand);
  const launcherPath = deps.launcherPath
    ?? resolveWindowsServiceLauncherPath({ env: runtimeEnv, serviceName });
  try {
    return await withExclusiveFileLock(
      path.join(path.dirname(launcherPath), "service-install.lock"),
      task,
      { waitMs: RUNTIME_SERVICE_INSTALL_LOCK_WAIT_MS, label: "ADE service install lock" },
    );
  } catch (error) {
    if (!(error instanceof ExclusiveFileLockTimeoutError)) throw error;
    return {
      ok: false,
      serviceName,
      action,
      path: null,
      message: `${error.message} Another ADE service install or uninstall is still running; retry once it finishes.`,
    };
  }
}

async function installWindowsServiceImpl(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const serviceCommand = deps.command ?? resolveAdeServeCommand();
  const serviceName = resolvedServiceName(deps, serviceCommand);
  let userName: string;
  try {
    userName = deps.userName ?? resolveWindowsTaskUser(env);
  } catch (error) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: null,
      message: error instanceof Error ? error.message : "Unable to resolve current Windows user.",
    };
  }
  const taskName = resolveWindowsTaskName({ serviceName, userName });
  const runtimeEnv = { ...env, ...(serviceCommand.env ?? {}) };
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env: runtimeEnv, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  const logPath = `${launcherPath}.log`;
  const machineLayout = resolveMachineAdeLayout(runtimeEnv, "win32");
  // The name the new brain starts on, baked into the launcher, and the name
  // the brain running now answers on: an older brain may sit on the pipe name
  // an older ADE derived (see `resolveMachineEndpointNames`), and it must be
  // reached to be checked, stopped and reaped.
  const socketPath = machineLayout.socketPath;
  const runningSocketPath = resolveReachableMachineRuntimeSocketPath(runtimeEnv, "win32");
  // The supervisor loop doubles as this platform's wedge watchdog: it reads the
  // brain's heartbeat between wait slices and stops a brain that hangs while
  // staying alive. macOS gets the same protection from a separate
  // `com.ade.watchdog` launch agent, because launchd's KeepAlive only reacts to
  // an exit and has no loop to fold the check into.
  const heartbeatPath = path.win32.join(machineLayout.runtimeDir, BRAIN_HEARTBEAT_FILE);
  const wedgeBreadcrumbPath = path.win32.join(
    machineLayout.runtimeDir,
    BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  );
  // Baked into the launcher, not read there: the rendered script must compute
  // the same cross-session mutex name and the same child-session path no matter
  // which logon session runs it. The mutex is keyed by this channel's launcher
  // and the user's SID (a hash of the fallback identity when the SID is not
  // available), matching the identity the Run value name is hashed from.
  const adeDir = resolveWindowsAdeDir(runtimeEnv);
  const mutexUserKey = /^S-\d-\d+/i.test(userName) ? userName : shortHash(userName);
  const mutexName = `Global\\ade-supervisor-${shortHash(launcherPath)}-${mutexUserKey}`;
  const renderedLauncher = `\uFEFF${renderWindowsServiceLauncher(serviceCommand, {
    pidPath,
    logPath,
    brainOutputLogPath: resolveWindowsBrainOutputLogPath({ launcherPath }),
    heartbeatPath,
    wedgeBreadcrumbPath,
    adeDir,
    mutexName,
    socketPath,
    lastFailurePath: path.win32.join(machineLayout.runtimeDir, "last-failure.json"),
  })}`;
  let existingLauncher: string | null = null;
  try {
    existingLauncher = fs.readFileSync(launcherPath, "utf8");
  } catch {
    existingLauncher = null;
  }
  const launcherUnchanged = existingLauncher === renderedLauncher;
  // Resolved before anything is torn down: a host that will not hand over a
  // trusted conhost.exe fails here, with the old supervisor still running.
  let launcherCommand: string;
  try {
    launcherCommand = windowsLauncherCommand(launcherPath);
  } catch (error) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: error instanceof Error
        ? `Unable to resolve the Windows brain launcher command: ${error.message}`
        : "Unable to resolve the Windows brain launcher command.",
    };
  }
  try {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, renderedLauncher, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: error instanceof Error
        ? `Unable to write the Windows brain launcher: ${error.message}`
        : "Unable to write the Windows brain launcher.",
    };
  }
  const legacyRemoval = removeWindowsTaskIfPresent(
    run,
    TASK_NAME,
    "legacy ADE Runtime scheduled task",
    serviceCommand,
  );
  if (!legacyRemoval.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: legacyRemoval.message,
    };
  }
  const readPidRecord = deps.readPidRecord
    ?? ((target: string) => readWindowsServicePidRecord({ pidPath: target }));
  // launchd/systemd parity: an unchanged launcher whose supervisor and brain
  // are verifiably ours and already answer on the channel pipe is installed.
  // The desktop runs this install on every launch, and replacing that brain
  // ended every chat, agent and terminal running on this machine each time
  // ADE was opened. Re-register the Run value (idempotent) and leave it be.
  // Only a brain known to be always-on is kept. A session-bound one (Windows
  // ends it with the session that started it) or one whose record cannot say
  // (`sessionBound: null`) is replaced, retrying the always-on handover.
  const forceRestart = env.ADE_FORCE_RUNTIME_SERVICE_RESTART === "1";
  if (!forceRestart && launcherUnchanged && readPidRecord(pidPath)?.sessionBound === false) {
    const running = await waitForWindowsRuntimeReadiness({
      command: serviceCommand,
      launcherPath,
      pidPath,
      socketPath: runningSocketPath,
      spawnSync: run,
      readPidRecord,
      readinessProbe: deps.readinessProbe ?? defaultWindowsRuntimeReadiness,
      timeoutMs: 0,
      pollMs: 100,
      sleep: deps.sleep,
    });
    if (running.ready) {
      const registration = run(
        windowsRegCommand(),
        buildWindowsRunKeyAddArgs(taskName, launcherCommand),
        { encoding: "utf8", windowsHide: true },
      );
      const prune = registration.status === 0
        ? pruneWindowsRunValues(run, { serviceName, launcherPath, keepValueName: taskName })
        : null;
      if (prune?.ok) {
        return {
          ok: true,
          serviceName,
          action: "install",
          path: taskName,
          message: "ADE per-user startup entry is already installed and the channel brain is running.",
        };
      }
      // A registry failure falls through to the full install, which reports it.
    }
  }
  // launchd parity for the young-brain wait: an unchanged launcher whose
  // supervisor and brain are alive, started less than RUNTIME_SERVICE_YOUNG_BRAIN_MS
  // ago and never restarted, is a brain still coming up. Wait for it instead of
  // ending and replacing it — every Repair used to kill exactly that brain.
  const isAlive = deps.pidAlive ?? isPidAlive;
  const youngRecord = launcherUnchanged ? readPidRecord(pidPath) : null;
  if (
    youngRecord
    && youngRecord.restartCount === 0
    && youngRecord.runtimePid != null
    && youngRecord.runtimeStartedAtMs != null
    && Date.now() - youngRecord.runtimeStartedAtMs < RUNTIME_SERVICE_YOUNG_BRAIN_MS
    && isAlive(youngRecord.supervisorPid)
    && isAlive(youngRecord.runtimePid)
  ) {
    const youngReadiness = await waitForWindowsRuntimeReadiness({
      command: serviceCommand,
      launcherPath,
      pidPath,
      socketPath: runningSocketPath,
      spawnSync: run,
      readPidRecord,
      readinessProbe: deps.readinessProbe ?? defaultWindowsRuntimeReadiness,
      timeoutMs: deps.handoverTimeoutMs ?? WINDOWS_HANDOVER_TIMEOUT_MS,
      pollMs: deps.handoverPollMs ?? 100,
      sleep: deps.sleep,
    });
    if (youngReadiness.ready) {
      return {
        ok: true,
        serviceName,
        action: "install",
        path: taskName,
        message: "ADE per-user startup entry is already installed; the channel brain finished starting.",
      };
    }
    if (youngReadiness.supervised) {
      return {
        ok: true,
        starting: true,
        serviceName,
        action: "install",
        path: taskName,
        message: `ADE per-user startup entry is installed; the channel brain is still starting on ${runningSocketPath}: ${youngReadiness.diagnostic}`,
      };
    }
    // The young brain died while we waited: fall through and replace it.
  }
  // The scheduled task is read now and removed only after the startup entry has been
  // identified below, so a refusal leaves it in place.
  const currentTask = inspectWindowsTask(run, taskName, "existing ADE service scheduled task");
  if (!currentTask.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: currentTask.message,
    };
  }
  // Identify everything this install would stop before any registration is removed
  // or changed. A refusal returns here, with the existing service untouched.
  const startupPlan = await planWindowsStartupRemoval(run, {
    valueName: taskName,
    launcherPath,
    pidPath,
    brain: { socketPath: runningSocketPath, command: serviceCommand },
  });
  if (!startupPlan.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: startupPlan.message,
    };
  }
  if (currentTask.present) {
    const currentRemoval = endAndDeleteWindowsTask(
      run,
      taskName,
      "existing ADE service scheduled task",
      currentTask,
    );
    if (!currentRemoval.ok) {
      return {
        ok: false,
        serviceName,
        action: "install",
        path: taskName,
        message: currentRemoval.message,
      };
    }
  }
  const startupRemoval = await removeWindowsStartupEntry(
    run,
    { valueName: taskName, pidPath },
    startupPlan,
  );
  if (!startupRemoval.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: startupRemoval.message,
    };
  }
  // ADE-160: the Run value the current context computes a name for is only one
  // of the values that may point at this launcher. Delete every other one (a
  // different user identity hashed it, or it predates stable naming) before the
  // current value is registered below, so a later sign-in cannot find two.
  const runPrune = pruneWindowsRunValues(run, { serviceName, launcherPath });
  if (!runPrune.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: runPrune.message,
    };
  }
  // The PID record is advisory and last-writer-wins, so a second supervisor
  // started by another logon session is invisible to it. Find and stop every
  // supervisor whose command line names this launcher before starting another
  // one, or the new brain would fight the old supervisor's over the pipe.
  const predecessorStop = await stopWindowsPredecessors(run, startupPlan.predecessors);
  if (!predecessorStop.ok) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: predecessorStop.message,
    };
  }
  // launchd parity: the macOS install reaps stale same-channel serve processes
  // before loading the replacement, because a brain that outlived its
  // registration keeps the channel socket and the sync-host lock hostage. On
  // Windows this scan used to shell out to `ps -axo`, which does not exist
  // there, so it silently found nothing and the reap never happened.
  const staleScan = listStaleChannelServePids(run, {
    cliScriptPath: resolveAdeServeCliScriptPath(serviceCommand),
    primarySocketPath: runningSocketPath,
  }, "win32");
  // A stale brain is force-killed only once it is proven to be this channel's: it
  // must name the channel socket itself, or answer on that endpoint. Any other
  // stale candidate is left running and reported, not claimed as taken over.
  const staleMatch = {
    cliScriptPath: resolveAdeServeCliScriptPath(serviceCommand),
    primarySocketPath: runningSocketPath,
  };
  const unverifiedStalePids: number[] = [];
  for (const stalePid of staleScan.ok ? staleScan.pids : []) {
    const outcome = await stopWindowsBrainGracefully(run, {
      socketPath: runningSocketPath,
      runtimePid: stalePid,
      isExpectedProcess: channelServeIdentity(staleMatch),
    });
    if (outcome === "not-proven" || outcome === "failed") unverifiedStalePids.push(stalePid);
  }
  const registration = run(
    windowsRegCommand(),
    buildWindowsRunKeyAddArgs(taskName, launcherCommand),
    { encoding: "utf8", windowsHide: true },
  );
  if (registration.status !== 0) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: serviceManagerResultText(registration) || "Unable to create the ADE per-user startup entry.",
    };
  }
  const startFailure = startWindowsSupervisorDetached(run, launcherPath, taskName);
  if (startFailure) {
    run(windowsRegCommand(), buildWindowsRunKeyDeleteArgs(taskName), {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: `ADE per-user startup entry was installed, but the background service failed to start: ${startFailure}`,
    };
  }
  // A stale candidate that could not be proven is still running. Say so, rather than
  // claim the replacement took over from a clean slate. Every return below that
  // reports the replacement carries it, including the one that is still starting.
  const staleWarning = unverifiedStalePids.length > 0
    ? ` Left running ${unverifiedStalePids.length === 1 ? "1 ADE process" : `${unverifiedStalePids.length} ADE processes`} that could not be verified as this channel's brain (pid ${unverifiedStalePids.join(", ")}); they were not stopped.`
    : "";
  const readiness = await waitForWindowsRuntimeReadiness({
    command: serviceCommand,
    launcherPath,
    pidPath,
    socketPath,
    spawnSync: run,
    readPidRecord,
    readinessProbe: deps.readinessProbe ?? defaultWindowsRuntimeReadiness,
    // Shorter than the POSIX budget on purpose: the Windows install
    // already spends several PowerShell round-trips before this wait, and the
    // whole child is bounded by `RUNTIME_SERVICE_START_WAIT_MS` (90s). A
    // supervised brain that is not ready by then is reported as `starting`,
    // not as a failure.
    timeoutMs: deps.handoverTimeoutMs ?? WINDOWS_HANDOVER_TIMEOUT_MS,
    pollMs: deps.handoverPollMs ?? 100,
    sleep: deps.sleep,
  });
  if (!readiness.ready && readiness.supervised) {
    // Same contract as launchd: a supervised brain that has not answered yet
    // is still starting, not broken. The supervisor keeps it; the caller keeps
    // waiting for the endpoint.
    return {
      ok: true,
      starting: true,
      restarted: true,
      serviceName,
      action: "install",
      path: taskName,
      message:
        `ADE per-user startup entry installed; the channel brain is still starting on ${socketPath}: `
        + readiness.diagnostic
        + staleWarning,
    };
  }
  if (!readiness.ready) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      failureStep: "replacement_responsive",
      message:
        `ADE per-user startup entry was installed, but the channel brain did not become ready on ${socketPath}: `
        + readiness.diagnostic,
    };
  }
  // Ask the supervisor what it actually is, rather than trusting which launch
  // route reported success: a "successful" in-session launch is precisely the
  // case that used to be reported as a healthy always-on brain.
  const sessionBound = readPidRecord(pidPath)?.sessionBound === true;
  return {
    ok: true,
    restarted: true,
    serviceName,
    action: "install",
    path: taskName,
    message: (sessionBound
      ? `ADE per-user startup entry installed and the channel brain is ready, but it is bound to this session. ${WINDOWS_SESSION_BOUND_WARNING}`
      : "ADE per-user startup entry installed and channel brain is ready.") + staleWarning,
  };
}

/**
 * Async because the cooperative brain shutdown it performs is a socket round
 * trip. The synchronous spelling this replaced shelled out to `ade runtime stop`
 * purely to stay sync -- a full CLI cold start per teardown, and one that could
 * not verify the target pid before asking a brain to exit.
 */
export async function uninstallWindowsService(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  try {
    return await withWindowsServiceInstallLock(deps, "uninstall", () => uninstallWindowsServiceImpl(deps));
  } catch (error) {
    if (!isTrustedWindowsToolError(error)) throw error;
    return windowsToolFailureResult<ServiceManagerResult & { ok: false; message: string }>(error, {
      serviceName: resolvedServiceName(deps),
      action: "uninstall",
      path: null,
    });
  }
}

/** What an uninstall acts on, resolved once for the uninstall and for its read-only check. */
function resolveWindowsUninstallTargets(deps: WindowsServiceManagerDeps):
  | { ok: false; serviceName: string; message: string }
  | {
    ok: true;
    run: ServiceManagerSpawnSync;
    env: NodeJS.ProcessEnv;
    serviceCommand: AdeServiceCommand;
    serviceName: string;
    taskName: string;
    launcherPath: string;
    pidPath: string;
  } {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const serviceCommand = deps.command ?? resolveAdeServeCommand();
  const serviceName = resolvedServiceName(deps);
  let userName: string;
  try {
    userName = deps.userName ?? resolveWindowsTaskUser(env);
  } catch (error) {
    return {
      ok: false,
      serviceName,
      message: error instanceof Error ? error.message : "Unable to resolve current Windows user.",
    };
  }
  const taskName = resolveWindowsTaskName({ serviceName, userName });
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  return { ok: true, run, env, serviceCommand, serviceName, taskName, launcherPath, pidPath };
}

function planWindowsUninstallStartupRemoval(
  targets: Extract<ReturnType<typeof resolveWindowsUninstallTargets>, { ok: true }>,
): Promise<WindowsStartupPlan> {
  const { run, env, serviceCommand, taskName, launcherPath, pidPath } = targets;
  return planWindowsStartupRemoval(run, {
    valueName: taskName,
    launcherPath,
    pidPath,
    brain: {
      socketPath: resolveReachableMachineRuntimeSocketPath({ ...env, ...(serviceCommand.env ?? {}) }, "win32"),
      command: serviceCommand,
    },
  });
}

/**
 * Whether `uninstallWindowsService` would go ahead, decided by the same
 * identification and changing nothing. An update install asks this before it
 * tells anyone it is installing, so a refusal is reported as the reason
 * instead of surfacing minutes later as "the update didn't apply".
 */
export async function checkWindowsServiceRemovable(
  deps: WindowsServiceManagerDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const targets = resolveWindowsUninstallTargets(deps);
  if (!targets.ok) return { ok: false, message: targets.message };
  const plan = await planWindowsUninstallStartupRemoval(targets);
  return plan.ok ? { ok: true } : { ok: false, message: plan.message };
}

async function uninstallWindowsServiceImpl(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  const targets = resolveWindowsUninstallTargets(deps);
  if (!targets.ok) {
    return {
      ok: false,
      serviceName: targets.serviceName,
      action: "uninstall",
      path: null,
      message: targets.message,
    };
  }
  const { run, serviceCommand, serviceName, taskName, launcherPath, pidPath } = targets;
  // The scheduled tasks are read now and removed only after everything below has been
  // identified, so a refusal leaves them in place.
  const currentTask = inspectWindowsTask(run, taskName, "ADE service scheduled task");
  // Identify everything this uninstall would stop before any registration is removed
  // or changed. A refusal returns here, with the existing service untouched.
  const startupPlan = await planWindowsUninstallStartupRemoval(targets);
  if (!startupPlan.ok) {
    return {
      ok: false,
      serviceName,
      action: "uninstall",
      path: taskName,
      message: startupPlan.message,
    };
  }
  let currentRemoval: WindowsTaskRemovalResult = { ok: true, removed: false };
  if (!currentTask.ok) {
    currentRemoval = currentTask;
  } else if (currentTask.present) {
    currentRemoval = endAndDeleteWindowsTask(run, taskName, "ADE service scheduled task", currentTask);
  }
  const legacyRemoval = taskName === TASK_NAME
    ? { ok: true as const, removed: false }
    : removeWindowsTaskIfPresent(
      run,
      TASK_NAME,
      "legacy ADE Runtime scheduled task",
      serviceCommand,
    );
  const startupRemoval = await removeWindowsStartupEntry(
    run,
    { valueName: taskName, pidPath },
    startupPlan,
  );
  // ADE-160: uninstall removes EVERY Run value that belongs to this channel or
  // names this launcher, not just the one the current identity hashes to — an
  // SSH-run install may have left a second one under a different hash.
  const runPrune = pruneWindowsRunValues(run, { serviceName, launcherPath });
  // A supervisor whose command line names this launcher can outlive the value
  // that started it (last-writer-wins PID record, another logon session). Stop
  // every one so the removed startup entry cannot come straight back.
  const predecessorStop = await stopWindowsPredecessors(run, startupPlan.predecessors);
  const removalErrors = [currentRemoval, legacyRemoval, startupRemoval]
    .filter((result): result is Extract<WindowsTaskRemovalResult, { ok: false }> => !result.ok)
    .map((result) => result.message);
  if (!runPrune.ok) removalErrors.push(runPrune.message);
  if (!predecessorStop.ok) removalErrors.push(predecessorStop.message);
  if (removalErrors.length > 0) {
    return {
      ok: false,
      serviceName,
      action: "uninstall",
      path: taskName,
      message: removalErrors.join(" "),
    };
  }
  const brainOutputLogPath = resolveWindowsBrainOutputLogPath({ launcherPath });
  // `.1` is the supervisor's single rotated generation of the brain output log.
  for (const logFile of [`${launcherPath}.log`, brainOutputLogPath, `${brainOutputLogPath}.1`]) {
    try { fs.rmSync(logFile, { force: true }); } catch { /* advisory log */ }
  }
  try {
    fs.rmSync(launcherPath, { force: true });
  } catch (error) {
    return {
      ok: false,
      serviceName,
      action: "uninstall",
      path: launcherPath,
      message: `ADE startup entry was removed, but its launcher could not be deleted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    ok: true,
    serviceName,
    action: "uninstall",
    path: taskName,
    message: "ADE background service startup entry removed.",
  };
}

type WindowsLegacyTaskProbe =
  | { present: false }
  | { present: true; owned: boolean | null };

/**
 * Looks for the global pre-channel `ADE Runtime` task and decides whether it
 * belongs to this install. Install deliberately leaves a foreign legacy task
 * running, so status is the only place a user can learn that one exists.
 *
 * This is a supplementary diagnostic on an already-answered status, so a probe
 * failure degrades to "no legacy task detected" rather than failing the whole
 * status call.
 */
function probeGlobalLegacyTask(
  run: ServiceManagerSpawnSync,
  command: AdeServiceCommand,
): WindowsLegacyTaskProbe {
  const query = run(windowsPowerShellCommand(), buildWindowsQueryTaskArgs(TASK_NAME), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (query.status !== 0) return { present: false };
  const action = run(windowsPowerShellCommand(), buildWindowsQueryTaskActionArgs(TASK_NAME), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (action.status === TASK_NOT_FOUND_EXIT_CODE) return { present: false };
  // Present, but we cannot read its action: never claim it either way.
  if (action.status !== 0) return { present: true, owned: null };
  return { present: true, owned: isWindowsLegacyTaskOwnedByCommand(action.stdout, command) };
}

export function getWindowsServiceStatus(
  deps: Pick<
    WindowsServiceManagerDeps,
    | "command"
    | "env"
    | "launcherPath"
    | "pidPath"
    | "readinessProbe"
    | "readPidRecord"
    | "serviceName"
    | "spawnSync"
    | "userName"
  > = {},
): ServiceManagerStatusResult {
  try {
    return getWindowsServiceStatusImpl(deps);
  } catch (error) {
    if (!isTrustedWindowsToolError(error)) throw error;
    return windowsToolFailureResult<ServiceManagerStatusResult & { ok: false; message: string }>(error, {
      serviceName: resolvedServiceName(deps),
      action: "status",
      installed: null,
      running: null,
      path: null,
    });
  }
}

function getWindowsServiceStatusImpl(
  deps: Pick<
    WindowsServiceManagerDeps,
    | "command"
    | "env"
    | "launcherPath"
    | "pidPath"
    | "readinessProbe"
    | "readPidRecord"
    | "serviceName"
    | "spawnSync"
    | "userName"
  > = {},
): ServiceManagerStatusResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const command = deps.command ?? resolveAdeServeCommand();
  const serviceName = resolvedServiceName(deps, command);
  let userName: string;
  try {
    userName = deps.userName ?? resolveWindowsTaskUser(env);
  } catch (error) {
    return {
      ok: false,
      serviceName,
      action: "status",
      installed: null,
      running: null,
      path: null,
      message: error instanceof Error ? error.message : "Unable to resolve current Windows user.",
    };
  }
  const taskName = resolveWindowsTaskName({ serviceName, userName });
  const runtimeEnv = { ...env, ...(command.env ?? {}) };
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env: runtimeEnv, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  const taskResult = run(
    windowsPowerShellCommand(),
    buildWindowsQueryTaskArgs(taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (taskResult.status === 0) {
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: true,
      running: false,
      path: taskName,
      message:
        "A legacy ADE scheduled task for this channel is installed, but runtime readiness cannot be verified. Run `ade brain start` to migrate it to the per-user startup supervisor.",
    };
  }
  const startupResult = run(windowsRegCommand(), buildWindowsRunKeyQueryArgs(taskName), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (startupResult.status === 0) {
    const readPidRecord = deps.readPidRecord
      ?? ((target: string) => readWindowsServicePidRecord({ pidPath: target }));
    const supervisor = queryWindowsSupervisor({
      spawnSync: run,
      launcherPath,
      pidPath,
      readPidRecord,
    });
    if (supervisor.error) {
      return {
        ok: false,
        serviceName,
        action: "status",
        installed: true,
        running: null,
        path: taskName,
        message: supervisor.error,
      };
    }
    if (!supervisor.running || !supervisor.record) {
      return {
        ok: true,
        serviceName,
        action: "status",
        installed: true,
        running: false,
        path: taskName,
        message: supervisor.diagnostic
          ?? "ADE per-user startup entry is installed, but the supervisor is not running.",
      };
    }
    const socketPath = resolveReachableMachineRuntimeSocketPath(runtimeEnv, "win32");
    const readiness = (deps.readinessProbe ?? defaultWindowsRuntimeReadiness)({
      command,
      launcherPath,
      pidRecord: supervisor.record,
      socketPath,
      spawnSync: run,
    });
    const base = readiness.ready
      ? `ADE per-user channel brain is ready on ${socketPath}.`
      : readiness.diagnostic;
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: true,
      running: readiness.ready,
      path: taskName,
      // "Running" and "always-on" are the same thing on macOS and two different
      // things here, so a session-bound brain must not be reported as healthy
      // without saying which of the two it is.
      message: supervisor.record.sessionBound === true
        ? `${base} ${WINDOWS_SESSION_BOUND_WARNING}`
        : base,
    };
  }
  if (taskResult.status !== TASK_NOT_FOUND_EXIT_CODE) {
    return {
      ok: false,
      serviceName,
      action: "status",
      installed: null,
      running: null,
      path: taskName,
      message: serviceManagerResultText(taskResult) || "Unable to query the legacy ADE scheduled task.",
    };
  }
  if (startupResult.status !== REGISTRY_VALUE_NOT_FOUND_EXIT_CODE) {
    return {
      ok: false,
      serviceName,
      action: "status",
      installed: null,
      running: null,
      path: taskName,
      message: serviceManagerResultText(startupResult) || "Unable to query the ADE per-user startup entry.",
    };
  }
  const legacy = probeGlobalLegacyTask(run, command);
  if (legacy.present && legacy.owned === true) {
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: true,
      running: false,
      path: TASK_NAME,
      message:
        "A legacy ADE Runtime scheduled task from a pre-channel install belongs to this channel, but runtime readiness cannot be verified for it. Run `ade brain start` to migrate it to the per-user startup supervisor.",
    };
  }
  if (legacy.present) {
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: false,
      running: false,
      path: taskName,
      message: legacy.owned === false
        ? "ADE background service startup entry is not installed for this channel. A legacy ADE Runtime scheduled task belongs to a different ADE install and was left running. Run `ade brain start` to install this channel's startup entry, and uninstall the other ADE to clear its legacy task."
        : "ADE background service startup entry is not installed for this channel. A legacy ADE Runtime scheduled task is registered on this machine, but its owning install could not be determined, so it was left running. Run `ade brain start` to install this channel's startup entry.",
    };
  }
  return {
    ok: true,
    serviceName,
    action: "status",
    installed: false,
    running: false,
    path: taskName,
    message: "ADE background service startup entry is not installed.",
  };
}
