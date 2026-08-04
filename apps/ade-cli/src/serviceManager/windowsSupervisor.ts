import fs from "node:fs";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import {
  type AdeServiceCommand,
  cmdQuote,
  serviceManagerResultText,
  type ServiceManagerSpawnSync,
} from "./common";

/**
 * Trusted `powershell.exe`, resolved on first use and then memoized.
 *
 * This used to be a module-scope `const`. `resolveTrustedWindowsTool` throws on
 * win32 when `\\?\GLOBALROOT\SystemRoot\System32` cannot be resolved (hardened
 * System32 ACLs, Server Core, EDR blocking GLOBALROOT), and this module is
 * pulled in transitively from the brain's startup path
 * (`sharedSyncListener` -> `serviceManager/index` -> `installWindows`), so that
 * throw killed the ENTIRE CLI at module load -- including commands that never
 * touch the service manager. Resolving lazily confines the failure to the code
 * paths that actually need the tool, where it is reported as a
 * `ServiceManagerResult` instead of an unhandled throw.
 */
let windowsPowerShellCommandCache: string | null = null;

export function windowsPowerShellCommand(): string {
  windowsPowerShellCommandCache ??= resolveTrustedWindowsTool("powershell");
  return windowsPowerShellCommandCache;
}

export type WindowsServicePidRecord = {
  supervisorPid: number;
  runtimePid: number | null;
  runtimeStartedAtMs: number | null;
  restartCount: number;
  lastExitCode: number | null;
  lastExitAt: string | null;
  nextRestartAt: string | null;
  lastLaunchError: string | null;
  /**
   * Ground truth, measured by the supervisor about itself: `true` when it is
   * running inside a job object that carries
   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, meaning Windows will terminate it the
   * moment the session that started it goes away.
   *
   * This is recorded by the supervisor rather than inferred from which launch
   * route the installer used, because the two can disagree: a supervisor that
   * had to fall back to an in-session launch today is started job-free by
   * `explorer.exe` at the next sign-in, and a record of the installer's intent
   * would keep warning about a brain that is no longer session-bound. `null`
   * means the probe could not run, and is never reported as a guarantee either
   * way.
   */
  sessionBound: boolean | null;
};

export type WindowsRuntimeReadiness = {
  ready: boolean;
  diagnostic: string;
};

export type WindowsRuntimeReadinessProbe = (args: {
  command: AdeServiceCommand;
  launcherPath: string;
  pidRecord: WindowsServicePidRecord;
  socketPath: string;
  spawnSync: ServiceManagerSpawnSync;
}) => WindowsRuntimeReadiness;

export type WindowsSupervisorState =
  | {
      state: "running";
      running: true;
      pid: number;
      record: WindowsServicePidRecord;
      error: null;
      diagnostic: null;
    }
  | {
      state: "stopped";
      running: false;
      pid: null;
      record: WindowsServicePidRecord | null;
      error: null;
      diagnostic: string;
    }
  | {
      state: "error";
      running: false;
      pid: null;
      record: WindowsServicePidRecord;
      error: string;
      diagnostic: null;
    };

function powerShellSingleQuotedLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("PowerShell values cannot contain NUL bytes.");
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderWindowsServiceLauncher(
  command: AdeServiceCommand,
  options: {
    pidPath: string;
    /**
     * launchd gives macOS `StandardOutPath`/`StandardErrorPath` for free, so a
     * brain that dies leaves a trace on disk. The Windows supervisor is spawned
     * detached with a hidden window and no redirection, so until this log
     * existed every supervisor death -- graceful or externally terminated --
     * was completely invisible. Optional so existing callers keep working.
     */
    logPath?: string;
    initialRestartDelayMs?: number;
    maxRestartDelayMs?: number;
    healthyRuntimeMs?: number;
  },
): string {
  const environment = Object.entries(command.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const environmentLines = environment.map(([key, value]) => {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new Error(`Invalid Windows service environment variable name: ${JSON.stringify(key)}.`);
    }
    return `[System.Environment]::SetEnvironmentVariable(${powerShellSingleQuotedLiteral(key)}, ${powerShellSingleQuotedLiteral(value)}, 'Process')`;
  });
  const commandLine = command.args.map(cmdQuote).join(" ");
  const logLines = options.logPath
    ? [
      `$logPath = ${powerShellSingleQuotedLiteral(options.logPath)}`,
      "function Write-SupervisorLog([string]$message) {",
      "  try {",
      "    $stamp = [DateTimeOffset]::UtcNow.ToString('o')",
      "    [IO.File]::AppendAllText($logPath, \"$stamp supervisor=$PID $message`r`n\", [Text.Encoding]::UTF8)",
      "  } catch { }",
      "}",
    ]
    : ["function Write-SupervisorLog([string]$message) { }"];
  const processLines = [
    `$pidPath = ${powerShellSingleQuotedLiteral(options.pidPath)}`,
    ...logLines,
    `$initialRestartDelayMs = ${Math.max(100, Math.floor(options.initialRestartDelayMs ?? 1_000))}`,
    `$maxRestartDelayMs = ${Math.max(100, Math.floor(options.maxRestartDelayMs ?? 30_000))}`,
    `$healthyRuntimeMs = ${Math.max(1_000, Math.floor(options.healthyRuntimeMs ?? 60_000))}`,
    "$restartCount = 0",
    "$lastExitCode = $null",
    "$lastExitAt = $null",
    "$nextRestartAt = $null",
    "$lastLaunchError = $null",
    // Whether this supervisor dies with the session that started it is not
    // something the installer can know -- the same launcher is also run by
    // `explorer.exe` at sign-in, where it is job-free. So the supervisor
    // measures it about itself and publishes the answer, and `brain status`
    // reports what is actually true right now rather than what the installer
    // hoped for. `QueryInformationJobObject(NULL, ...)` is documented to use
    // "the job associated with the calling process", so no handle is needed.
    "$sessionBound = $null",
    "try {",
    "  Add-Type -Namespace AdeSupervisor -Name JobApi -MemberDefinition @'",
    "[DllImport(\"kernel32.dll\", SetLastError=true)]",
    "public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);",
    "[DllImport(\"kernel32.dll\", SetLastError=true)]",
    "public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);",
    "[DllImport(\"kernel32.dll\")]",
    "public static extern IntPtr GetCurrentProcess();",
    "'@",
    "  $inJob = $false",
    "  [void][AdeSupervisor.JobApi]::IsProcessInJob([AdeSupervisor.JobApi]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)",
    "  if (-not $inJob) {",
    // No job at all: the Win32_Process.Create handover, which Windows
    // documents as producing a child that is not associated with the job.
    "    $sessionBound = $false",
    "  } else {",
    // sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION); LimitFlags sits at offset
    // 16 in both bitnesses because the two preceding fields are LARGE_INTEGERs.
    "    $jobInfoSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }",
    "    $jobInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal($jobInfoSize)",
    "    try {",
    // JobObjectExtendedLimitInformation = 9, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000.
    "      if ([AdeSupervisor.JobApi]::QueryInformationJobObject([IntPtr]::Zero, 9, $jobInfo, $jobInfoSize, [IntPtr]::Zero)) {",
    "        $sessionBound = [bool]([Runtime.InteropServices.Marshal]::ReadInt32($jobInfo, 16) -band 0x2000)",
    "      }",
    "    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($jobInfo) }",
    "  }",
    "} catch { $sessionBound = $null }",
    "function Write-PidRecord([Nullable[int]]$runtimePid, [Nullable[long]]$runtimeStartedAtMs) {",
    "  $record = [ordered]@{",
    "    supervisorPid = $PID",
    "    runtimePid = $runtimePid",
    "    runtimeStartedAtMs = $runtimeStartedAtMs",
    "    restartCount = $restartCount",
    "    lastExitCode = $lastExitCode",
    "    lastExitAt = $lastExitAt",
    "    nextRestartAt = $nextRestartAt",
    "    lastLaunchError = $lastLaunchError",
    "    sessionBound = $sessionBound",
    "  }",
    // UTF8, not ASCII: `lastLaunchError` carries a .NET exception message, which
    // Windows localizes. Under ASCII every non-ASCII character became `?`, so
    // the one diagnostic a non-English user most needs was the one thing that
    // arrived unreadable. `readWindowsServicePidRecord` already reads utf8, and
    // the JSON stayed valid either way -- this only affects legibility.
    // No BOM: [Text.Encoding]::UTF8 here is the parameterless property, so
    // PowerShell 5.1 would prefix one; UTF8Encoding($false) keeps JSON.parse happy.
    "  [IO.File]::WriteAllText($pidPath, ($record | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))",
    "}",
    "Write-SupervisorLog \"supervisor started sessionBound=$sessionBound\"",
    "if ($sessionBound -eq $true) { Write-SupervisorLog 'WARNING: this supervisor is inside a kill-on-job-close job object; Windows will terminate it with the session that started it.' }",
    "try {",
    "  while ($true) {",
    "    $runtimeStartedAt = [DateTimeOffset]::UtcNow",
    "    try {",
    "      $process = [System.Diagnostics.Process]::Start($startInfo)",
    "      if ($null -eq $process) { throw 'Windows failed to start the ADE brain process.' }",
    "      $lastLaunchError = $null",
    "      $nextRestartAt = $null",
    "      Write-PidRecord -runtimePid $process.Id -runtimeStartedAtMs $runtimeStartedAt.ToUnixTimeMilliseconds()",
    "      Write-SupervisorLog \"brain started pid=$($process.Id) restartCount=$restartCount\"",
    "      $process.WaitForExit()",
    "      $lastExitCode = $process.ExitCode",
    "      $lastExitAt = [DateTimeOffset]::UtcNow.ToString('o')",
    "      $runtimeLifetimeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $runtimeStartedAt.ToUnixTimeMilliseconds()",
    "      Write-SupervisorLog \"brain exited pid=$($process.Id) exitCode=$lastExitCode lifetimeMs=$runtimeLifetimeMs\"",
    "      if ($runtimeLifetimeMs -ge $healthyRuntimeMs) { $restartCount = 0 } else { $restartCount += 1 }",
    "    } catch {",
    "      $lastExitCode = $null",
    "      $lastExitAt = [DateTimeOffset]::UtcNow.ToString('o')",
    "      $lastLaunchError = [string]$_.Exception.Message",
    "      if ($lastLaunchError.Length -gt 512) { $lastLaunchError = $lastLaunchError.Substring(0, 512) }",
    "      $restartCount += 1",
    "      Write-SupervisorLog \"brain launch failed: $lastLaunchError\"",
    "    }",
    "    $exponent = [Math]::Min([Math]::Max($restartCount - 1, 0), 20)",
    "    $restartDelayMs = [Math]::Min($maxRestartDelayMs, $initialRestartDelayMs * [Math]::Pow(2, $exponent))",
    "    $nextRestartAt = [DateTimeOffset]::UtcNow.AddMilliseconds($restartDelayMs).ToString('o')",
    "    Write-PidRecord -runtimePid $null -runtimeStartedAtMs $null",
    "    Write-SupervisorLog \"restarting in ${restartDelayMs}ms (nextRestartAt=$nextRestartAt)\"",
    "    Start-Sleep -Milliseconds ([int]$restartDelayMs)",
    "  }",
    "} catch {",
    // Any terminating error outside the inner try (a failed pid-record write,
    // a broken Start-Sleep) used to unwind straight through `finally` and take
    // the always-on brain down with no trace at all.
    "  Write-SupervisorLog \"supervisor loop aborted: $($_.Exception.Message)\"",
    "  throw",
    "} finally {",
    "  Write-SupervisorLog 'supervisor exiting; clearing pid record'",
    "  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue",
    "}",
  ];

  return [
    "$ErrorActionPreference = 'Stop'",
    ...environmentLines,
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    `$startInfo.FileName = ${powerShellSingleQuotedLiteral(command.command)}`,
    `$startInfo.Arguments = ${powerShellSingleQuotedLiteral(commandLine)}`,
    "$startInfo.UseShellExecute = $false",
    "$startInfo.CreateNoWindow = $true",
    "$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
    ...processLines,
    "",
  ].join("\r\n");
}

export function readWindowsServicePidRecord(pidPath: string): WindowsServicePidRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidPath, "utf8")) as Partial<WindowsServicePidRecord>;
    const supervisorPid = Number(parsed.supervisorPid);
    const runtimePid = parsed.runtimePid == null ? null : Number(parsed.runtimePid);
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) return null;
    if (runtimePid != null && (!Number.isInteger(runtimePid) || runtimePid <= 0)) return null;
    const runtimeStartedAtMs = parsed.runtimeStartedAtMs == null
      ? null
      : Number(parsed.runtimeStartedAtMs);
    if (runtimeStartedAtMs != null && (!Number.isFinite(runtimeStartedAtMs) || runtimeStartedAtMs <= 0)) {
      return null;
    }
    const restartCount = Number(parsed.restartCount ?? 0);
    if (!Number.isInteger(restartCount) || restartCount < 0) return null;
    const lastExitCode = parsed.lastExitCode == null ? null : Number(parsed.lastExitCode);
    if (lastExitCode != null && !Number.isInteger(lastExitCode)) return null;
    const boundedText = (value: unknown): string | null =>
      typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : null;
    return {
      supervisorPid,
      runtimePid,
      runtimeStartedAtMs,
      restartCount,
      lastExitCode,
      lastExitAt: boundedText(parsed.lastExitAt),
      nextRestartAt: boundedText(parsed.nextRestartAt),
      lastLaunchError: boundedText(parsed.lastLaunchError),
      // Absent in records written by an older supervisor, and absent when the
      // probe itself failed. Both mean "unknown", never "safe".
      sessionBound: typeof parsed.sessionBound === "boolean" ? parsed.sessionBound : null,
    };
  } catch {
    return null;
  }
}

export function buildWindowsSupervisorQueryArgs(pid: number, launcherPath: string): string[] {
  const launcherLiteral = powerShellSingleQuotedLiteral(launcherPath);
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-CimInstance Win32_Process -Filter ${powerShellSingleQuotedLiteral(`ProcessId = ${pid}`)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $process) { exit 3 }",
    "$commandLine = [string]$process.CommandLine",
    `$matchesLauncher = $commandLine.IndexOf(${launcherLiteral}, [StringComparison]::OrdinalIgnoreCase) -ge 0`,
    "if (-not $matchesLauncher -or $process.Name -notmatch '^powershell(?:\\.exe)?$') { exit 4 }",
    "[Console]::Out.Write($process.ProcessId)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

export function buildWindowsRuntimeQueryArgs(pid: number, command: AdeServiceCommand): string[] {
  const expectedExecutable = powerShellSingleQuotedLiteral(path.win32.resolve(command.command));
  const expectedEntry = command.args[0]
    ? powerShellSingleQuotedLiteral(command.args[0])
    : "$null";
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-CimInstance Win32_Process -Filter ${powerShellSingleQuotedLiteral(`ProcessId = ${pid}`)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $process) { exit 3 }",
    "$commandLine = [string]$process.CommandLine",
    `$matchesExecutable = [string]::Equals([string]$process.ExecutablePath, ${expectedExecutable}, [StringComparison]::OrdinalIgnoreCase)`,
    expectedEntry === "$null"
      ? "$matchesEntry = $true"
      : `$matchesEntry = $commandLine.IndexOf(${expectedEntry}, [StringComparison]::OrdinalIgnoreCase) -ge 0`,
    // Windows quotes spawned arguments, so a live brain's command line ends
    // `... "cli.cjs" "serve"` -- the verb is wrapped in quotes, not delimited by
    // whitespace. Requiring a bare whitespace boundary made this predicate
    // always false on Windows, so every readiness probe reported a healthy
    // runtime as stale. Optional quotes accept both spellings without matching
    // a different verb (`serveless`) or a different subcommand.
    "$matchesServe = $commandLine -match '(?:^|\\s)\"?serve\"?(?:\\s|$)'",
    "if (-not $matchesExecutable -or -not $matchesEntry -or -not $matchesServe) { exit 4 }",
    "[Console]::Out.Write($process.ProcessId)",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

function runtimeSubcommandArgs(
  command: AdeServiceCommand,
  subcommand: string,
  socketPath: string,
  timeoutMs: number,
): string[] {
  const args = [...command.args];
  const serveIndex = args.lastIndexOf("serve");
  if (serveIndex >= 0) args.splice(serveIndex, 1, "runtime", subcommand);
  else args.push("runtime", subcommand);
  args.push("--socket", socketPath, "--timeout", String(Math.floor(timeoutMs)), "--json");
  return args;
}

function runtimeStatusArgs(command: AdeServiceCommand, socketPath: string): string[] {
  return runtimeSubcommandArgs(command, "status", socketPath, 1_500);
}

// Cooperative brain shutdown does NOT go through a packaged-CLI `runtime stop`
// subprocess. `common.terminatePidGracefullyAsync` speaks the same JSON-RPC
// `shutdown` method in-process, and unlike a subprocess it can verify over
// `runtime/info` that the endpoint is served by the pid it is about to stop --
// which a `--socket`-addressed subprocess cannot do at all.

export const defaultWindowsRuntimeReadiness: WindowsRuntimeReadinessProbe = (args) => {
  const { pidRecord, spawnSync: run } = args;
  const supervisor = run(
    windowsPowerShellCommand(),
    buildWindowsSupervisorQueryArgs(pidRecord.supervisorPid, args.launcherPath),
    { encoding: "utf8", windowsHide: true },
  );
  if (supervisor.status !== 0) {
    return {
      ready: false,
      diagnostic: supervisor.status === 3 || supervisor.status === 4
        ? `Supervisor PID ${pidRecord.supervisorPid} is stale or belongs to another process.`
        : serviceManagerResultText(supervisor) || `Unable to inspect supervisor PID ${pidRecord.supervisorPid}.`,
    };
  }
  if (pidRecord.runtimePid == null) {
    const restart = pidRecord.nextRestartAt ? `; restart scheduled for ${pidRecord.nextRestartAt}` : "";
    const launchError = pidRecord.lastLaunchError ? ` Last launch error: ${pidRecord.lastLaunchError}.` : "";
    return {
      ready: false,
      diagnostic: `Supervisor PID ${pidRecord.supervisorPid} is running, but the ADE brain is between restart attempts${restart}.${launchError}`,
    };
  }
  const runtime = run(
    windowsPowerShellCommand(),
    buildWindowsRuntimeQueryArgs(pidRecord.runtimePid, args.command),
    { encoding: "utf8", windowsHide: true },
  );
  if (runtime.status !== 0) {
    return {
      ready: false,
      diagnostic: runtime.status === 3 || runtime.status === 4
        ? `Runtime PID ${pidRecord.runtimePid} is stale or does not match this channel executable.`
        : serviceManagerResultText(runtime) || `Unable to inspect runtime PID ${pidRecord.runtimePid}.`,
    };
  }
  const status = run(args.command.command, runtimeStatusArgs(args.command, args.socketPath), {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(args.command.env ?? {}),
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    },
    timeout: 2_000,
    windowsHide: true,
  });
  if (status.status !== 0) {
    return {
      ready: false,
      diagnostic: serviceManagerResultText(status)
        || `Runtime PID ${pidRecord.runtimePid} has not initialized on ${args.socketPath}.`,
    };
  }
  try {
    const payload = JSON.parse(String(status.stdout ?? "")) as {
      ok?: unknown;
      running?: unknown;
      pid?: unknown;
    };
    if (payload.ok === true && payload.running === true && Number(payload.pid) === pidRecord.runtimePid) {
      return { ready: true, diagnostic: `Runtime PID ${pidRecord.runtimePid} is ready.` };
    }
    return {
      ready: false,
      diagnostic: `Runtime endpoint responded with PID ${String(payload.pid ?? "unknown")}; expected ${pidRecord.runtimePid}.`,
    };
  } catch {
    return {
      ready: false,
      diagnostic: `Runtime PID ${pidRecord.runtimePid} returned an invalid readiness payload.`,
    };
  }
};

export function queryWindowsSupervisor(args: {
  spawnSync: ServiceManagerSpawnSync;
  launcherPath: string;
  pidPath: string;
  readPidRecord?: (pidPath: string) => WindowsServicePidRecord | null;
}): WindowsSupervisorState {
  const record = (args.readPidRecord ?? readWindowsServicePidRecord)(args.pidPath);
  if (!record) {
    return {
      state: "stopped",
      running: false,
      pid: null,
      record: null,
      error: null,
      diagnostic: "The startup entry has no valid PID record yet.",
    };
  }
  const result = args.spawnSync(
    windowsPowerShellCommand(),
    buildWindowsSupervisorQueryArgs(record.supervisorPid, args.launcherPath),
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status === 0) {
    return {
      state: "running",
      running: true,
      pid: record.supervisorPid,
      record,
      error: null,
      diagnostic: null,
    };
  }
  if (result.status === 3 || result.status === 4) {
    try { fs.rmSync(args.pidPath, { force: true }); } catch { /* advisory record */ }
    return {
      state: "stopped",
      running: false,
      pid: null,
      record,
      error: null,
      diagnostic: `Cleared stale supervisor PID record ${record.supervisorPid}.`,
    };
  }
  return {
    state: "error",
    running: false,
    pid: null,
    record,
    error: serviceManagerResultText(result) || "Unable to inspect the ADE startup process.",
    diagnostic: null,
  };
}

export async function waitForWindowsRuntimeReadiness(args: {
  command: AdeServiceCommand;
  launcherPath: string;
  pidPath: string;
  socketPath: string;
  spawnSync: ServiceManagerSpawnSync;
  readPidRecord?: (pidPath: string) => WindowsServicePidRecord | null;
  readinessProbe?: WindowsRuntimeReadinessProbe;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WindowsRuntimeReadiness> {
  const deadline = Date.now() + Math.max(0, args.timeoutMs);
  const readPidRecord = args.readPidRecord ?? readWindowsServicePidRecord;
  const readinessProbe = args.readinessProbe ?? defaultWindowsRuntimeReadiness;
  const sleep = args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let diagnostic = "The Windows brain supervisor did not publish a PID record.";
  do {
    const pidRecord = readPidRecord(args.pidPath);
    if (pidRecord) {
      const result = readinessProbe({
        command: args.command,
        launcherPath: args.launcherPath,
        pidRecord,
        socketPath: args.socketPath,
        spawnSync: args.spawnSync,
      });
      if (result.ready) return result;
      diagnostic = result.diagnostic;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(Math.max(10, args.pollMs), remaining));
  } while (Date.now() <= deadline);
  return { ready: false, diagnostic };
}
