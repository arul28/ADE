import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  renderWindowsCommand,
  renderWindowsServiceLauncher,
  resolveAdeServeCommand,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";
import { resolveMachineAdeDir } from "../services/projects/machineLayout";

export const TASK_NAME = "ADE Runtime";
export const WINDOWS_POWERSHELL_COMMAND = "powershell.exe";
export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const TASK_NOT_FOUND_EXIT_CODE = 3;
const REGISTRY_VALUE_NOT_FOUND_EXIT_CODE = 1;

export type WindowsServicePidRecord = {
  supervisorPid: number;
  runtimePid: number;
};

type WindowsServiceManagerDeps = {
  command?: AdeServiceCommand;
  env?: NodeJS.ProcessEnv;
  launcherPath?: string;
  pidPath?: string;
  serviceName?: string;
  spawnSync?: ServiceManagerSpawnSync;
  userName?: string;
};

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
  const serviceName = args.serviceName ?? ADE_RUNTIME_SERVICE_NAME;
  const userName = args.userName ?? resolveWindowsTaskUser();
  const identity = `${serviceName.trim().toLowerCase()}\0${userName.trim().toLowerCase()}`;
  return `${TASK_NAME} (${serviceChannelLabel(serviceName)}-${shortHash(identity)})`;
}

export function resolveWindowsServiceLauncherPath(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
} = {}): string {
  const env = args.env ?? process.env;
  const serviceName = args.serviceName ?? ADE_RUNTIME_SERVICE_NAME;
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

export function readWindowsServicePidRecord(args: {
  env?: NodeJS.ProcessEnv;
  serviceName?: string;
  pidPath?: string;
} = {}): WindowsServicePidRecord | null {
  const pidPath = args.pidPath ?? resolveWindowsServicePidPath(args);
  try {
    const parsed = JSON.parse(fs.readFileSync(pidPath, "utf8")) as Partial<WindowsServicePidRecord>;
    const supervisorPid = Number(parsed.supervisorPid);
    const runtimePid = Number(parsed.runtimePid);
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) return null;
    if (!Number.isInteger(runtimePid) || runtimePid <= 0) return null;
    return { supervisorPid, runtimePid };
  } catch {
    return null;
  }
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
  const startCommand = [
    `$process = Start-Process -FilePath ${powerShellSingleQuotedLiteral(WINDOWS_POWERSHELL_COMMAND)}`,
    `-ArgumentList @(${childArgs.map(powerShellSingleQuotedLiteral).join(", ")})`,
    "-WindowStyle Hidden -PassThru",
  ].join(" ");
  const command = `${startCommand}; [Console]::Out.Write($process.Id)`;
  return ["-NoProfile", "-NonInteractive", "-Command", command];
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
): WindowsTaskRemovalResult {
  const query = run(
    WINDOWS_POWERSHELL_COMMAND,
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
  if (isWindowsTaskStateRunning(query.stdout)) {
    const end = run("schtasks.exe", buildWindowsEndTaskArgs(taskName), {
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
  const remove = run("schtasks.exe", buildWindowsDeleteTaskArgs(taskName), {
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
    command: WINDOWS_POWERSHELL_COMMAND,
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

function queryWindowsSupervisor(
  run: ServiceManagerSpawnSync,
  launcherPath: string,
  pidPath: string,
): { running: boolean; pid: number | null; error: string | null } {
  const record = readWindowsServicePidRecord({ pidPath });
  if (!record) return { running: false, pid: null, error: null };
  const result = run(
    WINDOWS_POWERSHELL_COMMAND,
    buildWindowsSupervisorQueryArgs(record.supervisorPid, launcherPath),
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status === 0) {
    return { running: true, pid: record.supervisorPid, error: null };
  }
  if (result.status === 3 || result.status === 4) {
    try { fs.rmSync(pidPath, { force: true }); } catch { /* advisory record */ }
    return { running: false, pid: null, error: null };
  }
  return {
    running: false,
    pid: null,
    error: serviceManagerResultText(result) || "Unable to inspect the ADE startup process.",
  };
}

function removeWindowsRunEntryIfPresent(
  run: ServiceManagerSpawnSync,
  valueName: string,
  launcherPath: string,
  pidPath: string,
): WindowsTaskRemovalResult {
  const query = run("reg.exe", buildWindowsRunKeyQueryArgs(valueName), {
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

  const supervisor = queryWindowsSupervisor(run, launcherPath, pidPath);
  if (supervisor.error) return { ok: false, message: supervisor.error };
  if (supervisor.running && supervisor.pid) {
    const stop = run("taskkill.exe", ["/PID", String(supervisor.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (stop.status !== 0) {
      const recheck = queryWindowsSupervisor(run, launcherPath, pidPath);
      if (recheck.running || recheck.error) {
        return {
          ok: false,
          message: `Unable to stop the ADE startup process: ${serviceManagerResultText(stop) || recheck.error || "taskkill failed."}`,
        };
      }
    }
  }

  if (installed) {
    const remove = run("reg.exe", buildWindowsRunKeyDeleteArgs(valueName), {
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

export function installWindowsService(deps: WindowsServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const serviceName = deps.serviceName ?? ADE_RUNTIME_SERVICE_NAME;
  const serviceCommand = deps.command ?? resolveAdeServeCommand();
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
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  try {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, `\uFEFF${renderWindowsServiceLauncher(serviceCommand, { pidPath })}`, {
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
  const startupRemoval = removeWindowsRunEntryIfPresent(
    run,
    taskName,
    launcherPath,
    pidPath,
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
  const command = windowsLauncherCommand(launcherPath);
  const registration = run(
    "reg.exe",
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
  const start = run(WINDOWS_POWERSHELL_COMMAND, buildWindowsStartLauncherArgs(launcherPath), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (start.status !== 0) {
    run("reg.exe", buildWindowsRunKeyDeleteArgs(taskName), {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: `ADE per-user startup entry was installed, but the background service failed to start: ${serviceManagerResultText(start) || "PowerShell launch failed."}`,
    };
  }
  return {
    ok: true,
    serviceName,
    action: "install",
    path: taskName,
    message: "ADE per-user startup entry installed and background service started.",
  };
}

export function uninstallWindowsService(deps: WindowsServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const serviceName = deps.serviceName ?? ADE_RUNTIME_SERVICE_NAME;
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
    );
  const startupRemoval = removeWindowsRunEntryIfPresent(
    run,
    taskName,
    launcherPath,
    pidPath,
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

export function getWindowsServiceStatus(
  deps: Pick<WindowsServiceManagerDeps, "env" | "launcherPath" | "pidPath" | "serviceName" | "spawnSync" | "userName"> = {},
): ServiceManagerStatusResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const serviceName = deps.serviceName ?? ADE_RUNTIME_SERVICE_NAME;
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
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env, serviceName });
  const pidPath = deps.pidPath ?? `${launcherPath}.pid.json`;
  const taskResult = run(
    WINDOWS_POWERSHELL_COMMAND,
    buildWindowsQueryTaskArgs(taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (taskResult.status === 0) {
    const running = isWindowsTaskStateRunning(taskResult.stdout);
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: true,
      running,
      path: taskName,
      message: running
        ? "ADE service scheduled task is running."
        : "ADE service scheduled task is installed.",
    };
  }
  const startupResult = run("reg.exe", buildWindowsRunKeyQueryArgs(taskName), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (startupResult.status === 0) {
    const supervisor = queryWindowsSupervisor(run, launcherPath, pidPath);
    return {
      ok: supervisor.error == null,
      serviceName,
      action: "status",
      installed: true,
      running: supervisor.error ? null : supervisor.running,
      path: taskName,
      message: supervisor.error
        ?? (supervisor.running
          ? "ADE per-user background service is running."
          : "ADE per-user startup entry is installed, but the background service is not running."),
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
