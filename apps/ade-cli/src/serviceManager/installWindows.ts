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
const TASK_NOT_FOUND_EXIT_CODE = 3;

type WindowsServiceManagerDeps = {
  command?: AdeServiceCommand;
  env?: NodeJS.ProcessEnv;
  launcherPath?: string;
  serviceName?: string;
  spawnSync?: ServiceManagerSpawnSync;
  userName?: string;
};

export function resolveWindowsTaskUser(env: NodeJS.ProcessEnv = process.env): string {
  const username = env.USERNAME?.trim() || os.userInfo().username.trim();
  if (!username) {
    throw new Error("Unable to resolve current Windows user for scheduled task registration.");
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
  try {
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, `\uFEFF${renderWindowsServiceLauncher(serviceCommand)}`, {
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
  const command = windowsLauncherCommand(launcherPath);
  const result = run(
    "schtasks.exe",
    buildWindowsCreateTaskArgs(command, userName, taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: serviceManagerResultText(result) || "schtasks create failed.",
    };
  }
  const start = run("schtasks.exe", buildWindowsRunTaskArgs(taskName), {
    encoding: "utf8",
    windowsHide: true,
  });
  if (start.status !== 0) {
    return {
      ok: false,
      serviceName,
      action: "install",
      path: taskName,
      message: `ADE service scheduled task installed, but failed to start: ${serviceManagerResultText(start) || "schtasks run failed."}`,
    };
  }
  return {
    ok: true,
    serviceName,
    action: "install",
    path: taskName,
    message: "ADE service scheduled task installed and started.",
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
  const removalErrors = [currentRemoval, legacyRemoval]
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
  const launcherPath = deps.launcherPath ?? resolveWindowsServiceLauncherPath({ env, serviceName });
  try {
    fs.rmSync(launcherPath, { force: true });
  } catch {
    // The scheduled task is already gone. A stale inert launcher can be
    // replaced or removed by the next install/uninstall attempt.
  }
  return {
    ok: true,
    serviceName,
    action: "uninstall",
    path: taskName,
    message: "ADE service scheduled task removed.",
  };
}

export function getWindowsServiceStatus(
  deps: Pick<WindowsServiceManagerDeps, "env" | "serviceName" | "spawnSync" | "userName"> = {},
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
  const result = run(
    WINDOWS_POWERSHELL_COMMAND,
    buildWindowsQueryTaskArgs(taskName),
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status === TASK_NOT_FOUND_EXIT_CODE) {
    return {
      ok: true,
      serviceName,
      action: "status",
      installed: false,
      running: false,
      path: taskName,
      message: serviceManagerResultText(result) || "ADE service scheduled task is not installed.",
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      serviceName,
      action: "status",
      installed: null,
      running: null,
      path: taskName,
      message: serviceManagerResultText(result) || "Unable to query the ADE service scheduled task.",
    };
  }
  const running = isWindowsTaskStateRunning(result.stdout);
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
