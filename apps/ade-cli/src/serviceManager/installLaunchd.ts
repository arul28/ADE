import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  listStaleChannelServePids,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
  terminatePidGracefully,
  type TerminatePidDeps,
} from "./common";
import {
  detectSyncHostSingletonConflict,
  formatSyncHostSingletonConflictMessage,
  isSameChannelSyncHostOwner,
  type SyncHostSingletonDeps,
} from "../services/sync/syncHostSingleton";

type LaunchdServiceManagerDeps = {
  command?: AdeServiceCommand;
  spawnSync?: ServiceManagerSpawnSync;
  homeDir?: string;
  syncHostSingletonDeps?: SyncHostSingletonDeps;
  terminateDeps?: TerminatePidDeps;
  env?: NodeJS.ProcessEnv;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistArray(values: string[]): string {
  return [
    "<array>",
    ...values.map((value) => `  <string>${escapeXml(value)}</string>`),
    "</array>",
  ].join("\n");
}

function launchdPrintOutputText(result: ReturnType<ServiceManagerSpawnSync>): string {
  if (typeof result.stdout === "string") return result.stdout;
  if (Buffer.isBuffer(result.stdout)) return result.stdout.toString("utf8");
  return "";
}

export function launchAgentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${ADE_RUNTIME_SERVICE_NAME}.plist`);
}

export function isLaunchdPrintRunning(output: string): boolean {
  return /\bstate\s*=\s*running\b/i.test(output);
}

export function parseLaunchdPrintPid(output: string): number | null {
  const match = output.match(/\bpid\s*=\s*(\d+)\b/i);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : null;
}

export function renderLaunchdPlist(command: AdeServiceCommand, homeDir = os.homedir()): string {
  const envEntries = Object.entries(command.env ?? {});
  const adeHome = command.env?.ADE_HOME?.trim() || process.env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  const runtimeLogDir = path.join(adeHome, "runtime");
  const envBlock = envEntries.length
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...envEntries.flatMap(([key, value]) => [
          `    <key>${escapeXml(key)}</key>`,
          `    <string>${escapeXml(value)}</string>`,
        ]),
        "  </dict>",
      ].join("\n")
    : "";
  const sections = [
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ADE_RUNTIME_SERVICE_NAME}</string>
  <key>ProgramArguments</key>
${plistArray([command.command, ...command.args]).split("\n").map((line) => `  ${line}`).join("\n")}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(runtimeLogDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(runtimeLogDir, "launchd.err.log"))}</string>`,
    envBlock,
    `</dict>
</plist>
`,
  ].filter(Boolean);
  return sections.join("\n");
}

function getLoadedLaunchdState(
  run: ServiceManagerSpawnSync,
): { running: boolean; pid: number | null } | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  let print = run("launchctl", ["print", `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { encoding: "utf8" });
  if (print.status !== 0) {
    const userPrint = run("launchctl", ["print", `user/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { encoding: "utf8" });
    if (userPrint.status === 0) {
      print = userPrint;
    }
  }
  if (print.status !== 0) return null;
  const output = launchdPrintOutputText(print);
  return {
    running: isLaunchdPrintRunning(output),
    pid: parseLaunchdPrintPid(output),
  };
}

export function getLaunchdServiceMainPid(
  run: ServiceManagerSpawnSync = spawnSync,
): number | null {
  return getLoadedLaunchdState(run)?.pid ?? null;
}

export function installLaunchdService(deps: LaunchdServiceManagerDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const servicePath = launchAgentPath(homeDir);
  const command = deps.command ?? resolveAdeServeCommand();
  const adeHome = command.env?.ADE_HOME?.trim() || env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  const plist = renderLaunchdPlist(command, homeDir);
  fs.mkdirSync(path.join(adeHome, "runtime"), { recursive: true });
  const existingPlist = fs.existsSync(servicePath)
    ? fs.readFileSync(servicePath, "utf8")
    : null;
  const plistUnchanged = existingPlist === plist;
  const loaded = getLoadedLaunchdState(run);
  if (plistUnchanged && loaded?.running === true) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
      message: "ADE service launchd service is already installed and running.",
    };
  }

  // From here on the service is being (re)started, so this install is the
  // channel's lifecycle authority. Same-channel brains holding the mobile
  // sync singleton are stale siblings of the service being installed and are
  // reaped; a brain from another channel keeps sync ownership and fails the
  // install so a beta update can never tear down the stable host.
  const conflict = detectSyncHostSingletonConflict(deps.syncHostSingletonDeps);
  if (conflict) {
    const ownEnv = command.env ? { ...env, ...command.env } : env;
    if (!isSameChannelSyncHostOwner(conflict.owner, ownEnv)) {
      return {
        ok: false,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: formatSyncHostSingletonConflictMessage(conflict),
      };
    }
    terminatePidGracefully(conflict.owner.pid, deps.terminateDeps);
  }

  if (!plistUnchanged) {
    fs.writeFileSync(servicePath, plist, "utf8");
  }
  run("launchctl", ["unload", servicePath], { stdio: "ignore" });
  // launchctl unload does not reliably terminate a wedged child, and an
  // orphaned brain keeps the channel socket and sync lock hostage. Reap the
  // previous service child plus any stale same-channel serve processes
  // before loading the replacement.
  terminatePidGracefully(loaded?.pid ?? null, deps.terminateDeps);
  const stalePids = listStaleChannelServePids(run, {
    cliScriptPath: resolveAdeServeCliScriptPath(command),
    primarySocketPath: path.join(adeHome, "sock", "ade.sock"),
    excludePids: loaded?.pid ? [loaded.pid] : [],
  });
  for (const pid of stalePids) {
    terminatePidGracefully(pid, deps.terminateDeps);
  }
  const load = run("launchctl", ["load", servicePath], { encoding: "utf8" });
  if (load.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: servicePath,
      message: serviceManagerResultText(load) || "launchctl load failed.",
    };
  }
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: servicePath,
    message: "ADE service launchd service installed.",
  };
}

export function uninstallLaunchdService(): ServiceManagerResult {
  const servicePath = launchAgentPath();
  const loaded = getLoadedLaunchdState(spawnSync);
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { stdio: "ignore" });
  spawnSync("launchctl", ["bootout", `user/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { stdio: "ignore" });
  spawnSync("launchctl", ["unload", servicePath], { stdio: "ignore" });
  terminatePidGracefully(loaded?.pid ?? null);
  try { fs.unlinkSync(servicePath); } catch {}
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "uninstall",
    path: servicePath,
    message: "ADE service launchd service removed.",
  };
}

export function getLaunchdServiceStatus(): ServiceManagerStatusResult {
  const servicePath = launchAgentPath();
  if (!fs.existsSync(servicePath)) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "status",
      installed: false,
      running: false,
      path: servicePath,
      message: "ADE service launchd service is not installed.",
    };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  let print = spawnSync("launchctl", ["print", `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { encoding: "utf8" });
  if (print.status !== 0) {
    const userPrint = spawnSync("launchctl", ["print", `user/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { encoding: "utf8" });
    if (userPrint.status === 0) {
      print = userPrint;
    }
  }
  if (print.status !== 0) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "status",
      installed: true,
      running: false,
      path: servicePath,
      message: serviceManagerResultText(print) || "ADE service launchd service is installed but not loaded.",
    };
  }

  const running = isLaunchdPrintRunning(print.stdout);
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "status",
    installed: true,
    running,
    path: servicePath,
    message: running
      ? "ADE service launchd service is running."
      : "ADE service launchd service is loaded but not running.",
  };
}
