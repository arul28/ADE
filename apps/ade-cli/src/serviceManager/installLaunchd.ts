import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  isCurrentProcessDescendantOfPid,
  listStaleChannelServePids,
  readPidElapsedMs,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
  terminatePidGracefully,
  terminatePidGracefullyAsync,
  type TerminatePidDeps,
} from "./common";
import {
  installLaunchdWatchdogAgent,
  uninstallLaunchdWatchdogAgent,
} from "./installLaunchdWatchdog";
import {
  defaultResponsivenessProbe,
  isYoungBrain,
  recentCrashLoopForAdeHome,
  RESPONSIVENESS_PROBE_INTERVAL_MS,
  serviceHandoverSleep,
} from "./serviceHandover";
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
  currentPid?: number;
  parentPid?: (pid: number) => number | null;
  /** Defaults on. Repair-only callers may skip the preflight RPC probe. */
  probeResponsiveness?: boolean;
  responsivenessProbe?: (args: {
    socketPath: string;
    timeoutMs: number;
    command: AdeServiceCommand;
  }) => boolean;
  handoverTimeoutMs?: number;
  handoverPollMs?: number;
  handoverPidAlive?: (pid: number) => boolean;
  /** Age of a live service pid; tests inject it, production asks `ps`. */
  pidElapsedMs?: (pid: number, run: ServiceManagerSpawnSync) => number | null;
  /** Whether the brain has recorded a fresh streak of startup failures; tests inject it. */
  recentCrashLoop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

type LaunchdServiceUninstallDeps = {
  spawnSync?: ServiceManagerSpawnSync;
  homeDir?: string;
  terminateDeps?: TerminatePidDeps;
  env?: NodeJS.ProcessEnv;
  currentPid?: number;
  parentPid?: (pid: number) => number | null;
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

function shouldAllowSelfServiceMutation(env: NodeJS.ProcessEnv): boolean {
  return env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION === "1";
}

function selfServiceMutationBlockedResult(args: {
  action: "install" | "uninstall";
  servicePath: string;
  servicePid: number;
}): ServiceManagerResult {
  const verb = args.action === "install" ? "restart" : "stop";
  return {
    ok: false,
    selfMutationBlocked: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: args.action,
    path: args.servicePath,
    message:
      `Refusing to ${verb} ADE brain from a command running inside that brain ` +
      `(pid ${args.servicePid}). Run this from an external terminal, or set ` +
      "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1 if you intentionally want to tear down active ADE sessions.",
  };
}

function selfServiceMutationBlock(args: {
  action: "install" | "uninstall";
  loadedPid: number | null | undefined;
  servicePath: string;
  run: ServiceManagerSpawnSync;
  env: NodeJS.ProcessEnv;
  currentPid?: number;
  parentPid?: (pid: number) => number | null;
}): ServiceManagerResult | null {
  const servicePid = args.loadedPid ?? null;
  if (!servicePid || shouldAllowSelfServiceMutation(args.env)) return null;
  if (!isCurrentProcessDescendantOfPid({
    targetPid: servicePid,
    run: args.run,
    currentPid: args.currentPid,
    parentPid: args.parentPid,
  })) {
    return null;
  }
  return selfServiceMutationBlockedResult({
    action: args.action,
    servicePath: args.servicePath,
    servicePid,
  });
}

/**
 * `ThrottleInterval` is stated explicitly rather than left to launchd's default
 * (which is also 10s) because this service's crash-loop window is a real,
 * observed failure: while `/Applications/ADE.app` is being swapped the brain can
 * be restarted onto half-written files and die instantly -- the
 * `Cannot find module '/serve'` loop. The floor is what turns that into a slow,
 * self-healing retry instead of a hot spin, so it should not silently inherit
 * whatever a future launchd decides the default is.
 */
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
  <key>ThrottleInterval</key>
  <integer>10</integer>
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `terminatePidGracefully*` now dispatches on platform, because Windows has no
 * catchable SIGTERM and needs a cooperative RPC shutdown instead. This file is
 * the launchd manager: everything it terminates is a macOS process, so pin the
 * POSIX branch rather than letting `process.platform` decide -- otherwise the
 * cross-platform unit tests for this module take the win32 path when they run
 * on a Windows host.
 */
function launchdTerminateDeps(deps: TerminatePidDeps | undefined): TerminatePidDeps {
  return { ...deps, platform: deps?.platform ?? "darwin" };
}

function handoverFailure(
  servicePath: string,
  failureStep: NonNullable<ServiceManagerResult["failureStep"]>,
  message: string,
): ServiceManagerResult {
  return {
    ok: false,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: servicePath,
    failureStep,
    message,
  };
}

export function getLaunchdServiceMainPid(
  run: ServiceManagerSpawnSync = spawnSync,
): number | null {
  return getLoadedLaunchdState(run)?.pid ?? null;
}

export async function installLaunchdService(
  deps: LaunchdServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const servicePath = launchAgentPath(homeDir);
  const command = deps.command ?? resolveAdeServeCommand();
  const adeHome = command.env?.ADE_HOME?.trim() || env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  const socketPath = path.join(adeHome, "sock", "ade.sock");
  const probeResponsiveness = deps.responsivenessProbe ?? defaultResponsivenessProbe;
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  const plist = renderLaunchdPlist(command, homeDir);
  fs.mkdirSync(path.join(adeHome, "runtime"), { recursive: true });
  const existingPlist = fs.existsSync(servicePath)
    ? fs.readFileSync(servicePath, "utf8")
    : null;
  const plistUnchanged = existingPlist === plist;
  const forceRestart = env.ADE_FORCE_RUNTIME_SERVICE_RESTART === "1";
  let loaded = getLoadedLaunchdState(run);
  if (!forceRestart && plistUnchanged && loaded?.running === true) {
    if (
      deps.probeResponsiveness === false
      || probeResponsiveness({ socketPath, timeoutMs: 1_500, command })
    ) {
      // Arm the watchdog even on the no-op path. Otherwise every machine that
      // was already running when this shipped -- which is all of them -- would
      // keep taking the early return and never get one.
      installLaunchdWatchdogAgent({ command, homeDir, spawnSync: run });
      return {
        ok: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: "ADE service launchd service is already installed and running.",
      };
    }
  }
  const isAlive = deps.handoverPidAlive ?? deps.terminateDeps?.pidAlive ?? pidAlive;
  const sleep = deps.sleep ?? serviceHandoverSleep;
  const timeoutMs = Math.max(0, deps.handoverTimeoutMs ?? RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS);
  const pollMs = Math.max(10, deps.handoverPollMs ?? 100);
  const pidElapsedMs = deps.pidElapsedMs ?? readPidElapsedMs;

  /**
   * Waits for a distinct replacement child to answer on the socket. Shared by
   * the young-brain wait (no predecessor to outlive) and the real handover.
   */
  // One budget for the whole install: a young-brain wait that gives up and a
  // real handover after it share this deadline, so the desktop's child timeout
  // can be sized against a known worst case.
  const installDeadline = Date.now() + timeoutMs;
  const awaitHandover = async (oldPid: number | null): Promise<{
    predecessorGone: boolean;
    replacementPid: number | null;
    replacementResponsive: boolean;
  }> => {
    const deadline = installDeadline;
    let predecessorGone = oldPid == null || !isAlive(oldPid);
    let replacementPid: number | null = null;
    let replacementResponsive = false;
    let lastProbeAt = 0;
    do {
      predecessorGone = oldPid == null || !isAlive(oldPid);
      const replacement = getLoadedLaunchdState(run);
      replacementPid = replacement?.running === true ? replacement.pid : null;
      const replacementDiffers = replacementPid != null && replacementPid !== oldPid;
      // Each probe is a full CLI child process; on the slow machines this wait
      // exists for, running one every poll tick would compete with the very
      // brain it is waiting on. Poll launchd cheaply, probe at a slower cadence.
      if (
        predecessorGone
        && replacementDiffers
        && Date.now() - lastProbeAt >= RESPONSIVENESS_PROBE_INTERVAL_MS
      ) {
        lastProbeAt = Date.now();
        replacementResponsive = probeResponsiveness({
          socketPath,
          timeoutMs: Math.min(1_500, Math.max(1, deadline - Date.now())),
          command,
        });
        if (replacementResponsive) break;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return { predecessorGone, replacementPid, replacementResponsive };
  };

  // The service definition is current and launchd has a live child that is
  // simply not answering yet. If that child is young it is still starting —
  // first launch, cold disk, big project database — and restarting it (which
  // is what a forced install would do next) only resets its clock. Wait for it
  // instead. This is what keeps a Repair click from killing the very brain
  // that was seconds from being ready.
  // A brain that keeps dying is always "young" (launchd just respawned it), so
  // the recorded failure streak vetoes the wait: that brain needs the restart
  // and the crash-loop diagnosis, not more patience.
  const crashLooping = deps.recentCrashLoop
    ? deps.recentCrashLoop()
    : recentCrashLoopForAdeHome(adeHome);
  if (
    plistUnchanged
    && loaded?.running === true
    && !crashLooping
    && isYoungBrain(loaded.pid, run, pidElapsedMs)
  ) {
    const young = await awaitHandover(null);
    if (young.replacementResponsive) {
      installLaunchdWatchdogAgent({ command, homeDir, spawnSync: run });
      return {
        ok: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: "ADE service launchd service is already installed; its background service finished starting.",
      };
    }
    if (young.replacementPid != null && isAlive(young.replacementPid)) {
      installLaunchdWatchdogAgent({ command, homeDir, spawnSync: run });
      return {
        ok: true,
        starting: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: `ADE service launchd service is installed; the background service (pid ${young.replacementPid}) is still starting.`,
      };
    }
    // The young child died while we waited: fall through and (re)start it.
    loaded = getLoadedLaunchdState(run);
  }
  const selfBlock = selfServiceMutationBlock({
    action: "install",
    loadedPid: loaded?.pid,
    servicePath,
    run,
    env,
    currentPid: deps.currentPid,
    parentPid: deps.parentPid,
  });
  if (selfBlock) return selfBlock;

  // From here on the service is being (re)started, so this install is the
  // channel's lifecycle authority. Same-channel brains holding the mobile
  // sync singleton are stale siblings of the service being installed and are
  // reaped; a brain from another channel keeps sync ownership and fails the
  // install so a beta update can never tear down the stable host.
  const conflict = detectSyncHostSingletonConflict(deps.syncHostSingletonDeps);
  if (conflict) {
    const ownEnv = command.env ? { ...env, ...command.env } : env;
    if (!isSameChannelSyncHostOwner(conflict.owner, ownEnv)) {
      // Keep the channel-owned launch-agent definition current even while a
      // different channel owns the machine-wide mobile-sync singleton. Older
      // Beta builds could leave com.ade.runtime.beta pointing into ADE.app;
      // refusing before writing preserved that mismatch forever and made the
      // desktop attach to an app-owned no-sync brain on every launch.
      if (!plistUnchanged) {
        fs.writeFileSync(servicePath, plist, "utf8");
        if (loaded?.running === true) {
          run("launchctl", ["unload", servicePath], { stdio: "ignore" });
          await terminatePidGracefullyAsync(loaded.pid, launchdTerminateDeps(deps.terminateDeps));
        }
      }
      return {
        ok: false,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: `${formatSyncHostSingletonConflictMessage(conflict)} The ${ADE_RUNTIME_SERVICE_NAME} launch agent was updated for this ADE channel and will start when mobile sync is available.`,
      };
    }
    await terminatePidGracefullyAsync(conflict.owner.pid, launchdTerminateDeps(deps.terminateDeps));
  }

  if (!plistUnchanged) {
    fs.writeFileSync(servicePath, plist, "utf8");
  }
  run("launchctl", ["unload", servicePath], { stdio: "ignore" });
  // launchctl unload does not reliably terminate a wedged child, and an
  // orphaned brain keeps the channel socket and sync lock hostage. Reap the
  // previous service child plus any stale same-channel serve processes
  // before loading the replacement.
  await terminatePidGracefullyAsync(loaded?.pid ?? null, launchdTerminateDeps(deps.terminateDeps));
  // A failed scan is not "nothing to reap"; on macOS `ps` is part of the base
  // system, so a failure here means the host is broken in a way this install
  // cannot repair. Reaping nothing preserves the pre-existing behaviour.
  const staleScan = listStaleChannelServePids(run, {
    cliScriptPath: resolveAdeServeCliScriptPath(command),
    primarySocketPath: socketPath,
    excludePids: loaded?.pid ? [loaded.pid] : [],
  }, "darwin");
  for (const pid of staleScan.ok ? staleScan.pids : []) {
    await terminatePidGracefullyAsync(pid, launchdTerminateDeps(deps.terminateDeps));
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
  const oldPid = loaded?.pid ?? null;
  const { predecessorGone, replacementPid, replacementResponsive } = await awaitHandover(oldPid);

  if (!predecessorGone) {
    return handoverFailure(
      servicePath,
      "predecessor_exit",
      `ADE service handover failed because predecessor pid ${oldPid} is still alive.`,
    );
  }
  if (replacementPid == null || replacementPid === oldPid) {
    return handoverFailure(
      servicePath,
      "replacement_pid",
      `ADE service handover failed because launchd did not report a distinct replacement pid (old ${oldPid ?? "none"}, new ${replacementPid ?? "none"}).`,
    );
  }
  if (!replacementResponsive) {
    // `replacementPid != null` first: `isAlive` is injectable, and a test (or
    // a future caller) that answers `true` unconditionally must not turn "no
    // replacement at all" into a `starting` result the caller waits on.
    if (replacementPid != null && isAlive(replacementPid)) {
      // launchd owns a live replacement that has not answered yet. That is a
      // slow start, not a failed install; the supervisor keeps the child and
      // the caller keeps waiting for the endpoint. Reporting this as a failure
      // was what made every slow machine read as a broken one.
      installLaunchdWatchdogAgent({ command, homeDir, spawnSync: run });
      return {
        ok: true,
        starting: true,
        restarted: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: servicePath,
        message: `ADE service launchd service installed; the background service (pid ${replacementPid}) is still starting after ${timeoutMs}ms.`,
      };
    }
    return handoverFailure(
      servicePath,
      "replacement_responsive",
      `ADE service handover failed because replacement pid ${replacementPid} did not initialize over ${socketPath} within ${timeoutMs}ms.`,
    );
  }
  // Best effort, and deliberately after the brain is proven healthy: the
  // watchdog is a safety net around a working brain, never a precondition for
  // one. A machine that cannot install it still gets a brain.
  const watchdog = installLaunchdWatchdogAgent({
    command,
    homeDir,
    spawnSync: run,
  });
  return {
    ok: true,
    restarted: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: servicePath,
    message: watchdog.installed
      ? "ADE service launchd service installed."
      : `ADE service launchd service installed. ${watchdog.message}`,
  };
}

export function uninstallLaunchdService(deps: LaunchdServiceUninstallDeps = {}): ServiceManagerResult {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const servicePath = launchAgentPath(deps.homeDir);
  const loaded = getLoadedLaunchdState(run);
  const selfBlock = selfServiceMutationBlock({
    action: "uninstall",
    loadedPid: loaded?.pid,
    servicePath,
    run,
    env,
    currentPid: deps.currentPid,
    parentPid: deps.parentPid,
  });
  if (selfBlock) return selfBlock;
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  run("launchctl", ["bootout", `gui/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { stdio: "ignore" });
  run("launchctl", ["bootout", `user/${uid}/${ADE_RUNTIME_SERVICE_NAME}`], { stdio: "ignore" });
  run("launchctl", ["unload", servicePath], { stdio: "ignore" });
  terminatePidGracefully(loaded?.pid ?? null, launchdTerminateDeps(deps.terminateDeps));
  // Remove the watchdog with the brain it guards. Left behind, it would keep
  // waking every minute to read a heartbeat file nobody writes.
  uninstallLaunchdWatchdogAgent({ homeDir: deps.homeDir, spawnSync: run });
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
