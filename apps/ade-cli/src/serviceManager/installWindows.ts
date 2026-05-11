import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  renderWindowsCommand,
  resolveAdeServeCommand,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";

export const TASK_NAME = "ADE Runtime";

type WindowsServiceManagerDeps = {
  command?: AdeServiceCommand;
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

export function buildWindowsCreateTaskArgs(command: string, userName = resolveWindowsTaskUser()): string[] {
  return [
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    TASK_NAME,
    "/TR",
    command,
    "/RU",
    userName,
    "/IT",
    "/F",
  ];
}

export function buildWindowsRunTaskArgs(): string[] {
  return ["/Run", "/TN", TASK_NAME];
}

export function buildWindowsQueryTaskArgs(): string[] {
  return ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"];
}

export function buildWindowsDeleteTaskArgs(): string[] {
  return ["/Delete", "/TN", TASK_NAME, "/F"];
}

export function parseSchtasksListStatus(output: string): string | null {
  const match = /^\s*Status:\s*(.*?)\s*$/im.exec(output);
  return match?.[1] ?? null;
}

export function isSchtasksOutputRunning(output: string): boolean {
  return parseSchtasksListStatus(output)?.toLowerCase() === "running";
}

export function installWindowsService(deps: WindowsServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const command = renderWindowsCommand(deps.command ?? resolveAdeServeCommand());
  let userName: string;
  try {
    userName = deps.userName ?? resolveWindowsTaskUser();
  } catch (error) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: TASK_NAME,
      message: error instanceof Error ? error.message : "Unable to resolve current Windows user.",
    };
  }
  const result = run("schtasks.exe", buildWindowsCreateTaskArgs(command, userName), { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: TASK_NAME,
      message: serviceManagerResultText(result) || "schtasks create failed.",
    };
  }
  const start = run("schtasks.exe", buildWindowsRunTaskArgs(), { encoding: "utf8" });
  if (start.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: TASK_NAME,
      message: `ADE service scheduled task installed, but failed to start: ${serviceManagerResultText(start) || "schtasks run failed."}`,
    };
  }
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: TASK_NAME,
    message: "ADE service scheduled task installed and started.",
  };
}

export function uninstallWindowsService(deps: Pick<WindowsServiceManagerDeps, "spawnSync"> = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const result = run("schtasks.exe", buildWindowsDeleteTaskArgs(), { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "uninstall",
      path: TASK_NAME,
      message: serviceManagerResultText(result) || "schtasks delete failed.",
    };
  }
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "uninstall",
    path: TASK_NAME,
    message: "ADE service scheduled task removed.",
  };
}

export function getWindowsServiceStatus(): ServiceManagerStatusResult {
  const result = spawnSync("schtasks.exe", buildWindowsQueryTaskArgs(), { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "status",
      installed: false,
      running: false,
      path: TASK_NAME,
      message: serviceManagerResultText(result) || "ADE service scheduled task is not installed.",
    };
  }
  const running = isSchtasksOutputRunning(result.stdout);
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "status",
    installed: true,
    running,
    path: TASK_NAME,
    message: running
      ? "ADE service scheduled task is running."
      : "ADE service scheduled task is installed.",
  };
}
