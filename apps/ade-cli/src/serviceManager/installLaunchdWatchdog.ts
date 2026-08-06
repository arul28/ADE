import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  type ServiceManagerSpawnSync,
} from "./common";

/**
 * A second, tiny launch agent whose only job is to notice a wedged brain.
 *
 * The brain's own service (`com.ade.runtime`) has `KeepAlive=true`, which only
 * reacts to an exit. A brain that hangs while staying alive is therefore
 * invisible to launchd -- the 2026-08-05 incident. This agent runs every
 * `StartInterval` seconds, reads the brain's heartbeat file, and SIGKILLs a
 * brain that has stopped beating. KeepAlive then does the restart, so the
 * watchdog never starts anything itself and cannot become a competing
 * supervisor.
 *
 * It is a separate agent rather than a thread inside the brain because the
 * whole point is to survive the brain being wedged.
 */

export const ADE_WATCHDOG_START_INTERVAL_SECONDS = 60;

/**
 * `com.ade.runtime` -> `com.ade.watchdog`, `com.ade.runtime.beta` ->
 * `com.ade.watchdog.beta`. Channels must not share a watchdog: each has its own
 * ADE home, heartbeat file, and brain.
 */
export function resolveWatchdogServiceName(
  runtimeServiceName: string = ADE_RUNTIME_SERVICE_NAME,
): string {
  const trimmed = runtimeServiceName.trim() || "com.ade.runtime";
  return trimmed.includes("runtime")
    ? trimmed.replace("runtime", "watchdog")
    : `${trimmed}.watchdog`;
}

export function watchdogLaunchAgentPath(
  homeDir = os.homedir(),
  runtimeServiceName: string = ADE_RUNTIME_SERVICE_NAME,
): string {
  return path.join(
    homeDir,
    "Library",
    "LaunchAgents",
    `${resolveWatchdogServiceName(runtimeServiceName)}.plist`,
  );
}

/**
 * The brain's own command with `serve` swapped for `runtime watchdog-check`, so
 * the watchdog always runs the exact binary the brain was installed from. A
 * separate script would be one more thing that can go stale across an update.
 */
export function watchdogCommand(command: AdeServiceCommand): AdeServiceCommand {
  const args = [...command.args];
  const serveIndex = args.lastIndexOf("serve");
  if (serveIndex >= 0) {
    args.splice(serveIndex, 1, "runtime", "watchdog-check");
  } else {
    args.push("runtime", "watchdog-check");
  }
  return {
    command: command.command,
    args,
    env: {
      ...(command.env ?? {}),
      // The check must never take a lifecycle action of its own. Its only
      // authority is "kill a pid that stopped beating".
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderWatchdogLaunchdPlist(args: {
  command: AdeServiceCommand;
  homeDir?: string;
  runtimeServiceName?: string;
  startIntervalSeconds?: number;
}): string {
  const homeDir = args.homeDir ?? os.homedir();
  const label = resolveWatchdogServiceName(args.runtimeServiceName ?? ADE_RUNTIME_SERVICE_NAME);
  const command = watchdogCommand(args.command);
  const adeHome =
    command.env?.ADE_HOME?.trim()
    || process.env.ADE_HOME?.trim()
    || path.join(homeDir, ".ade");
  const runtimeLogDir = path.join(adeHome, "runtime");
  const startInterval = Math.max(
    15,
    Math.floor(args.startIntervalSeconds ?? ADE_WATCHDOG_START_INTERVAL_SECONDS),
  );
  const programArguments = [command.command, ...command.args]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  const envEntries = Object.entries(command.env ?? {});
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
  return [
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>StartInterval</key>
  <integer>${startInterval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(runtimeLogDir, "watchdog.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(runtimeLogDir, "watchdog.err.log"))}</string>`,
    envBlock,
    `</dict>
</plist>
`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type WatchdogInstallOutcome = {
  installed: boolean;
  path: string;
  message: string;
};

/**
 * Best effort by design: the watchdog is a safety net around the brain, so
 * failing to install it must never fail the brain's own install. The caller
 * logs the outcome and moves on.
 */
export function installLaunchdWatchdogAgent(deps: {
  command: AdeServiceCommand;
  homeDir?: string;
  spawnSync?: ServiceManagerSpawnSync;
  runtimeServiceName?: string;
  startIntervalSeconds?: number;
}): WatchdogInstallOutcome {
  const run = deps.spawnSync ?? spawnSync;
  const homeDir = deps.homeDir ?? os.homedir();
  const runtimeServiceName = deps.runtimeServiceName ?? ADE_RUNTIME_SERVICE_NAME;
  const servicePath = watchdogLaunchAgentPath(homeDir, runtimeServiceName);
  const plist = renderWatchdogLaunchdPlist({
    command: deps.command,
    homeDir,
    runtimeServiceName,
    startIntervalSeconds: deps.startIntervalSeconds,
  });
  try {
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    const existing = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, "utf8") : null;
    if (existing !== plist) {
      fs.writeFileSync(servicePath, plist, "utf8");
    }
    // Reload unconditionally: an unchanged plist can still be unloaded (after a
    // logout, a manual `launchctl unload`, or a failed previous install), and
    // `load` on an already-loaded agent is a no-op error we ignore.
    run("launchctl", ["unload", servicePath], { stdio: "ignore" });
    const load = run("launchctl", ["load", servicePath], { encoding: "utf8" });
    if (load.status !== 0) {
      return {
        installed: false,
        path: servicePath,
        message: "The ADE watchdog agent could not be loaded.",
      };
    }
    return {
      installed: true,
      path: servicePath,
      message: "ADE watchdog agent installed.",
    };
  } catch (error) {
    return {
      installed: false,
      path: servicePath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function uninstallLaunchdWatchdogAgent(deps: {
  homeDir?: string;
  spawnSync?: ServiceManagerSpawnSync;
  runtimeServiceName?: string;
} = {}): WatchdogInstallOutcome {
  const run = deps.spawnSync ?? spawnSync;
  const homeDir = deps.homeDir ?? os.homedir();
  const runtimeServiceName = deps.runtimeServiceName ?? ADE_RUNTIME_SERVICE_NAME;
  const servicePath = watchdogLaunchAgentPath(homeDir, runtimeServiceName);
  const label = resolveWatchdogServiceName(runtimeServiceName);
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  run("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
  run("launchctl", ["unload", servicePath], { stdio: "ignore" });
  try {
    fs.unlinkSync(servicePath);
  } catch {
    // Already absent, which is the desired end state.
  }
  return {
    installed: false,
    path: servicePath,
    message: "ADE watchdog agent removed.",
  };
}
