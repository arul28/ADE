import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import {
  type AdeServiceCommand,
  cmdQuote,
  renderWindowsCommand,
  resolveAdeServeCommand,
  resolveRuntimeServiceName,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";
import { resolveMachineAdeDir, resolveMachineAdeLayout } from "../services/projects/machineLayout";
import {
  defaultWindowsRuntimeReadiness,
  queryWindowsSupervisor,
  readWindowsServicePidRecord as readWindowsSupervisorPidRecord,
  renderWindowsServiceLauncher,
  waitForWindowsRuntimeReadiness,
  WINDOWS_POWERSHELL_COMMAND,
  type WindowsRuntimeReadinessProbe,
  type WindowsServicePidRecord,
} from "./windowsSupervisor";

export {
  buildWindowsRuntimeQueryArgs,
  buildWindowsSupervisorQueryArgs,
  renderWindowsServiceLauncher,
  WINDOWS_POWERSHELL_COMMAND,
  type WindowsServicePidRecord,
} from "./windowsSupervisor";

export const TASK_NAME = "ADE Runtime";
export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const TASK_NOT_FOUND_EXIT_CODE = 3;
const REGISTRY_VALUE_NOT_FOUND_EXIT_CODE = 1;
export const WINDOWS_REG_COMMAND = resolveTrustedWindowsTool("reg");
export const WINDOWS_SCHTASKS_COMMAND = resolveTrustedWindowsTool("schtasks");
export const WINDOWS_TASKKILL_COMMAND = resolveTrustedWindowsTool("taskkill");

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
  const childCommandLine = childArgs.map(cmdQuote).join(" ");
  const command = [
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    `$startInfo.FileName = ${powerShellSingleQuotedLiteral(WINDOWS_POWERSHELL_COMMAND)}`,
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
    const end = run(WINDOWS_SCHTASKS_COMMAND, buildWindowsEndTaskArgs(taskName), {
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
  const remove = run(WINDOWS_SCHTASKS_COMMAND, buildWindowsDeleteTaskArgs(taskName), {
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

function removeWindowsRunEntryIfPresent(
  run: ServiceManagerSpawnSync,
  valueName: string,
  launcherPath: string,
  pidPath: string,
): WindowsTaskRemovalResult {
  const query = run(WINDOWS_REG_COMMAND, buildWindowsRunKeyQueryArgs(valueName), {
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
    const stop = run(WINDOWS_TASKKILL_COMMAND, ["/PID", String(supervisor.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
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
    const remove = run(WINDOWS_REG_COMMAND, buildWindowsRunKeyDeleteArgs(valueName), {
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
  const socketPath = resolveMachineAdeLayout(runtimeEnv, "win32").socketPath;
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
    WINDOWS_REG_COMMAND,
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
    run(WINDOWS_REG_COMMAND, buildWindowsRunKeyDeleteArgs(taskName), {
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
  const readiness = await waitForWindowsRuntimeReadiness({
    command: serviceCommand,
    launcherPath,
    pidPath,
    socketPath,
    spawnSync: run,
    readPidRecord: deps.readPidRecord
      ?? ((target) => readWindowsServicePidRecord({ pidPath: target })),
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
  return {
    ok: true,
    serviceName,
    action: "install",
    path: taskName,
    message: "ADE per-user startup entry installed and channel brain is ready.",
  };
}

export function uninstallWindowsService(deps: WindowsServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
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
    WINDOWS_POWERSHELL_COMMAND,
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
        "A legacy ADE Scheduled Task is installed, but runtime readiness cannot be verified. Run `ade brain start` to migrate it to the per-user startup supervisor.",
    };
  }
  const startupResult = run(WINDOWS_REG_COMMAND, buildWindowsRunKeyQueryArgs(taskName), {
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
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: true,
      running: readiness.ready,
      path: taskName,
      message: readiness.ready
        ? `ADE per-user channel brain is ready on ${socketPath}.`
        : readiness.diagnostic,
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
