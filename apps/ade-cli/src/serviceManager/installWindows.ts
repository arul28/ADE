import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveTrustedWindowsTool,
  TrustedWindowsToolError,
  type TrustedWindowsTool,
} from "../lib/trustedWindowsTools";
import {
  type AdeServiceCommand,
  cmdQuote,
  isPidAlive,
  listStaleChannelServePids,
  renderWindowsCommand,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  resolveRuntimeServiceName,
  serviceManagerResultText,
  terminatePidGracefullyAsync,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";
import { resolveMachineAdeDir, resolveMachineAdeLayout } from "../services/projects/machineLayout";
import { BRAIN_HEARTBEAT_FILE } from "../services/runtime/brainHeartbeat";
import { BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE } from "../services/runtime/brainLoopWatchdog";
import {
  defaultWindowsRuntimeReadiness,
  queryWindowsSupervisor,
  readWindowsServicePidRecord as readWindowsSupervisorPidRecord,
  renderWindowsServiceLauncher,
  waitForWindowsRuntimeReadiness,
  windowsPowerShellCommand,
  type WindowsRuntimeReadinessProbe,
  type WindowsServicePidRecord,
} from "./windowsSupervisor";

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

export function windowsTaskkillCommand(): string {
  return trustedTool("taskkill");
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

export function resolveWindowsTaskUser(env: NodeJS.ProcessEnv = process.env): string {
  const username = env.USERNAME?.trim() || os.userInfo().username.trim();
  if (!username) {
    throw new Error("Unable to resolve the current Windows user for background-service registration.");
  }
  const domain = env.USERDOMAIN?.trim();
  if (domain && !username.includes("\\")) {
    return `${domain}\\${username}`;
  }
  return username;
}

function serviceChannelLabel(serviceName: string): string {
  const normalized = serviceName.trim().toLowerCase();
  if (normalized === "com.ade.runtime") return "stable";
  if (normalized.endsWith(".alpha")) return "alpha";
  if (normalized.endsWith(".beta")) return "beta";
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

export function resolveWindowsServiceLauncherPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
} = {}): string {
  const env = args.env ?? process.env;
  const serviceName = args.serviceName ?? resolveRuntimeServiceName(env);
  const adeDir = path.win32.resolve(env.ADE_HOME?.trim() || resolveMachineAdeDir(env));
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

function powerShellSingleQuotedLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Windows scheduled task names cannot contain NUL bytes.");
  }
  return `'${value.replace(/'/g, "''")}'`;
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
 */
export function buildWindowsStartTaskArgs(
  launcherPath: string,
  startTaskName: string,
): string[] {
  const launcherArguments = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    cmdQuote(launcherPath),
  ].join(" ");
  const nameLiteral = powerShellSingleQuotedLiteral(startTaskName);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${powerShellSingleQuotedLiteral(windowsPowerShellCommand())} -Argument ${powerShellSingleQuotedLiteral(launcherArguments)}`,
    // Far-future one-shot trigger: the task only ever runs because we start it.
    "$trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddDays(3650))",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
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

function removeWindowsTaskIfPresent(
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
): WindowsTaskRemovalResult {
  const query = run(
    windowsPowerShellCommand(),
    buildWindowsQueryTaskArgs(taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (query.status === TASK_NOT_FOUND_EXIT_CODE) {
    return { ok: true, removed: false };
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
      return { ok: true, removed: false };
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
      return { ok: true, removed: false };
    }
  }
  if (isWindowsTaskStateRunning(query.stdout)) {
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

function windowsLauncherCommand(launcherPath: string): string {
  return renderWindowsCommand({
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
  });
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
 * stale supervisor record cannot talk down an unrelated brain. This wrapper only
 * supplies the Windows tools: `taskkill` through the same injected `spawnSync`
 * and memoized trusted-tool lookup the rest of this file uses, so tests observe
 * the escalation instead of really killing a pid.
 *
 * The supervisor must already be gone when this runs, or it would simply
 * restart the brain we just stopped.
 */
async function stopWindowsBrainGracefully(
  run: ServiceManagerSpawnSync,
  args: { socketPath: string; runtimePid: number },
): Promise<void> {
  await terminatePidGracefullyAsync(args.runtimePid, {
    platform: "win32",
    runtimeSocketPath: args.socketPath,
    forceKill: (pid) => {
      run(windowsTaskkillCommand(), ["/PID", String(pid), "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
    },
  });
}

async function removeWindowsRunEntryIfPresent(
  run: ServiceManagerSpawnSync,
  valueName: string,
  launcherPath: string,
  pidPath: string,
  /**
   * Present whenever the caller can name the brain's endpoint. Without it there
   * is no cooperative channel and the supervisor tree is force-killed as before.
   */
  brain?: { socketPath: string },
): Promise<WindowsTaskRemovalResult> {
  const query = run(windowsRegCommand(), buildWindowsRunKeyQueryArgs(valueName), {
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

  const supervisor = queryWindowsSupervisor({ spawnSync: run, launcherPath, pidPath });
  if (supervisor.error) return { ok: false, message: supervisor.error };
  if (supervisor.running && supervisor.pid) {
    // The brain is the supervisor's child, so `/T` would kill it here. Take the
    // supervisor alone first -- it is a stateless restart loop with nothing to
    // flush -- and only then talk the brain down. Without this ordering the
    // supervisor would relaunch the brain the moment it exited.
    const runtimePid = brain ? supervisor.record?.runtimePid ?? null : null;
    const stop = run(
      windowsTaskkillCommand(),
      runtimePid == null
        ? ["/PID", String(supervisor.pid), "/T", "/F"]
        : ["/PID", String(supervisor.pid), "/F"],
      { encoding: "utf8", windowsHide: true },
    );
    if (runtimePid != null && brain && isPidAlive(runtimePid)) {
      await stopWindowsBrainGracefully(run, {
        socketPath: brain.socketPath,
        runtimePid,
      });
    }
    if (stop.status !== 0) {
      const recheck = queryWindowsSupervisor({ spawnSync: run, launcherPath, pidPath });
      if (recheck.running || recheck.error) {
        return {
          ok: false,
          message: `Unable to stop the ADE startup process: ${serviceManagerResultText(stop) || recheck.error || "taskkill failed."}`,
        };
      }
    }
  }

  if (installed) {
    const remove = run(windowsRegCommand(), buildWindowsRunKeyDeleteArgs(valueName), {
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
  try { fs.rmSync(pidPath, { force: true }); } catch { /* advisory record */ }
  return { ok: true, removed: installed || supervisor.running };
}

export async function installWindowsService(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  try {
    return await installWindowsServiceImpl(deps);
  } catch (error) {
    if (!isTrustedWindowsToolError(error)) throw error;
    return windowsToolFailureResult<ServiceManagerResult & { ok: false; message: string }>(error, {
      serviceName: resolvedServiceName(deps),
      action: "install",
      path: null,
    });
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
  const socketPath = machineLayout.socketPath;
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
  try {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, `\uFEFF${renderWindowsServiceLauncher(serviceCommand, {
      pidPath,
      logPath,
      heartbeatPath,
      wedgeBreadcrumbPath,
    })}`, {
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
  const currentRemoval = removeWindowsTaskIfPresent(
    run,
    taskName,
    "existing ADE service scheduled task",
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
  const startupRemoval = await removeWindowsRunEntryIfPresent(
    run,
    taskName,
    launcherPath,
    pidPath,
    { socketPath },
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
  // launchd parity: the macOS install reaps stale same-channel serve processes
  // before loading the replacement, because a brain that outlived its
  // registration keeps the channel socket and the sync-host lock hostage. On
  // Windows this scan used to shell out to `ps -axo`, which does not exist
  // there, so it silently found nothing and the reap never happened.
  const staleScan = listStaleChannelServePids(run, {
    cliScriptPath: resolveAdeServeCliScriptPath(serviceCommand),
    primarySocketPath: socketPath,
  }, "win32");
  for (const stalePid of staleScan.ok ? staleScan.pids : []) {
    await stopWindowsBrainGracefully(run, { socketPath, runtimePid: stalePid });
  }
  const command = windowsLauncherCommand(launcherPath);
  const registration = run(
    windowsRegCommand(),
    buildWindowsRunKeyAddArgs(taskName, command),
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
  const readPidRecord = deps.readPidRecord
    ?? ((target: string) => readWindowsServicePidRecord({ pidPath: target }));
  const readiness = await waitForWindowsRuntimeReadiness({
    command: serviceCommand,
    launcherPath,
    pidPath,
    socketPath,
    spawnSync: run,
    readPidRecord,
    readinessProbe: deps.readinessProbe ?? defaultWindowsRuntimeReadiness,
    timeoutMs: deps.handoverTimeoutMs ?? 15_000,
    pollMs: deps.handoverPollMs ?? 100,
    sleep: deps.sleep,
  });
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
    serviceName,
    action: "install",
    path: taskName,
    message: sessionBound
      ? `ADE per-user startup entry installed and the channel brain is ready, but it is bound to this session. ${WINDOWS_SESSION_BOUND_WARNING}`
      : "ADE per-user startup entry installed and channel brain is ready.",
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
    return await uninstallWindowsServiceImpl(deps);
  } catch (error) {
    if (!isTrustedWindowsToolError(error)) throw error;
    return windowsToolFailureResult<ServiceManagerResult & { ok: false; message: string }>(error, {
      serviceName: resolvedServiceName(deps),
      action: "uninstall",
      path: null,
    });
  }
}

async function uninstallWindowsServiceImpl(
  deps: WindowsServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
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
      action: "uninstall",
      path: null,
      message: error instanceof Error ? error.message : "Unable to resolve current Windows user.",
    };
  }
  const taskName = resolveWindowsTaskName({ serviceName, userName });
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  const currentRemoval = removeWindowsTaskIfPresent(
    run,
    taskName,
    "ADE service scheduled task",
  );
  const legacyRemoval = taskName === TASK_NAME
    ? { ok: true as const, removed: false }
    : removeWindowsTaskIfPresent(
      run,
      TASK_NAME,
      "legacy ADE Runtime scheduled task",
      serviceCommand,
    );
  const startupRemoval = await removeWindowsRunEntryIfPresent(
    run,
    taskName,
    launcherPath,
    pidPath,
    {
      socketPath: resolveMachineAdeLayout({ ...env, ...(serviceCommand.env ?? {}) }, "win32").socketPath,
    },
  );
  const removalErrors = [currentRemoval, legacyRemoval, startupRemoval]
    .filter((result): result is Extract<WindowsTaskRemovalResult, { ok: false }> => !result.ok)
    .map((result) => result.message);
  if (removalErrors.length > 0) {
    return {
      ok: false,
      serviceName,
      action: "uninstall",
      path: taskName,
      message: removalErrors.join(" "),
    };
  }
  try { fs.rmSync(`${launcherPath}.log`, { force: true }); } catch { /* advisory log */ }
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
    const socketPath = resolveMachineAdeLayout(runtimeEnv, "win32").socketPath;
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
