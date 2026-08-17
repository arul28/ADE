import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  isPidAlive,
  readPidElapsedMs,
  renderCommand,
  resolveAdeServeCommand,
  RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS,
  serviceManagerResultText,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";
import {
  defaultResponsivenessProbe,
  isYoungBrain,
  type PidElapsedMsLookup,
  recentCrashLoopForAdeHome,
  RESPONSIVENESS_PROBE_INTERVAL_MS,
  type ResponsivenessProbe,
  serviceHandoverSleep,
} from "./serviceHandover";

type SystemdServiceManagerDeps = {
  command?: AdeServiceCommand;
  spawnSync?: ServiceManagerSpawnSync;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults on. Repair-only callers may skip the preflight RPC probe. */
  probeResponsiveness?: boolean;
  responsivenessProbe?: ResponsivenessProbe;
  handoverTimeoutMs?: number;
  handoverPollMs?: number;
  handoverPidAlive?: (pid: number) => boolean;
  /** Age of a live service pid; tests inject it, production asks `ps`. */
  pidElapsedMs?: PidElapsedMsLookup;
  /** Whether the brain has recorded a fresh streak of startup failures; tests inject it. */
  recentCrashLoop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export function servicePath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".config", "systemd", "user", `${ADE_RUNTIME_SERVICE_NAME}.service`);
}

function serviceUnitName(): string {
  return path.basename(servicePath());
}

function escapeSystemdQuotedValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%");
}

export function renderSystemdEnvironment(key: string, value: string): string {
  return `Environment="${key}=${escapeSystemdQuotedValue(value)}"`;
}

export function renderSystemdUnit(command: AdeServiceCommand): string {
  const envLines = Object.entries(command.env ?? {})
    .map(([key, value]) => renderSystemdEnvironment(key, value))
    .join("\n");
  return `[Unit]
Description=ADE runtime service

[Service]
Type=simple
ExecStart=${renderCommand(command)}
Restart=always
RestartSec=2
${envLines}

[Install]
WantedBy=default.target
`;
}

export type SystemdUnitState = { active: boolean; mainPid: number | null };

/**
 * Parses `systemctl show`'s `KEY=value` output. Values are taken verbatim after
 * the first `=`; systemd never wraps these two properties.
 */
export function parseSystemdShowOutput(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return properties;
}

/**
 * One `systemctl show` round trip for both properties the handover needs.
 * `null` means the query itself failed (no systemd user bus, unit unknown to
 * this systemd) — distinct from "known and inactive", which is `active:false`.
 */
export function getSystemdUnitState(
  run: ServiceManagerSpawnSync,
  unitName = serviceUnitName(),
): SystemdUnitState | null {
  const show = run(
    "systemctl",
    ["--user", "show", unitName, "-p", "ActiveState", "-p", "MainPID"],
    { encoding: "utf8" },
  );
  if (show.status !== 0) return null;
  const output = typeof show.stdout === "string"
    ? show.stdout
    : Buffer.isBuffer(show.stdout) ? show.stdout.toString("utf8") : "";
  const properties = parseSystemdShowOutput(output);
  const activeState = properties.get("ActiveState");
  if (activeState == null) return null;
  const rawPid = Number(properties.get("MainPID") ?? "0");
  const mainPid = Number.isFinite(rawPid) && rawPid > 0 ? Math.floor(rawPid) : null;
  // `activating` is systemd's own "still coming up" and must not be read as
  // dead: restarting a unit in that state is exactly the booting-brain kill
  // this whole change exists to stop.
  return { active: activeState === "active" || activeState === "activating", mainPid };
}

function handoverFailure(
  targetPath: string,
  failureStep: NonNullable<ServiceManagerResult["failureStep"]>,
  message: string,
): ServiceManagerResult {
  return {
    ok: false,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: targetPath,
    failureStep,
    message,
  };
}

/**
 * Linux parity with the launchd installer. Headless brains, `install.sh`
 * installs and remote runtimes all land here, and before this they got the
 * pre-#1102 behaviour: write the unit, `enable --now`, `restart`, report
 * success the instant systemd accepted the restart — no proof the replacement
 * ever answered, and no way to tell a caller "installed, still starting".
 * A remote bootstrap then dialled a socket that was not up yet and read a
 * healthy-but-slow brain as a broken one.
 */
export async function installSystemdService(
  deps: SystemdServiceManagerDeps = {},
): Promise<ServiceManagerResult> {
  const run = deps.spawnSync ?? spawnSync;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const targetPath = servicePath(homeDir);
  const command = deps.command ?? resolveAdeServeCommand();
  const adeHome = command.env?.ADE_HOME?.trim() || env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  const socketPath = path.join(adeHome, "sock", "ade.sock");
  const unitName = serviceUnitName();
  const probeResponsiveness = deps.responsivenessProbe ?? defaultResponsivenessProbe;
  const isAlive = deps.handoverPidAlive ?? isPidAlive;
  const sleep = deps.sleep ?? serviceHandoverSleep;
  const timeoutMs = Math.max(0, deps.handoverTimeoutMs ?? RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS);
  const pollMs = Math.max(10, deps.handoverPollMs ?? 100);
  const pidElapsedMs = deps.pidElapsedMs ?? readPidElapsedMs;

  const unit = renderSystemdUnit(command);
  const existingUnit = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;
  const unitUnchanged = existingUnit === unit;
  const forceRestart = env.ADE_FORCE_RUNTIME_SERVICE_RESTART === "1";

  let state = getSystemdUnitState(run, unitName);

  // The unit is current and systemd already has a live, answering child.
  // Restarting it would only interrupt a working brain.
  if (!forceRestart && unitUnchanged && state?.active === true) {
    if (
      deps.probeResponsiveness === false
      || probeResponsiveness({ socketPath, timeoutMs: 1_500, command })
    ) {
      return {
        ok: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: targetPath,
        message: "ADE service systemd user service is already installed and running.",
      };
    }
  }

  // One budget for the whole install, so a young-brain wait that gives up and
  // the real handover after it cannot together exceed the caller's timeout.
  const installDeadline = Date.now() + timeoutMs;
  const awaitHandover = async (oldPid: number | null): Promise<{
    predecessorGone: boolean;
    replacementPid: number | null;
    replacementResponsive: boolean;
  }> => {
    let predecessorGone = oldPid == null || !isAlive(oldPid);
    let replacementPid: number | null = null;
    let replacementResponsive = false;
    let lastProbeAt = 0;
    do {
      predecessorGone = oldPid == null || !isAlive(oldPid);
      const replacement = getSystemdUnitState(run, unitName);
      replacementPid = replacement?.active === true ? replacement.mainPid : null;
      const replacementDiffers = replacementPid != null && replacementPid !== oldPid;
      // Each probe is a full CLI child process; poll systemd cheaply and spend
      // a probe only at the slower cadence.
      if (
        predecessorGone
        && replacementDiffers
        && Date.now() - lastProbeAt >= RESPONSIVENESS_PROBE_INTERVAL_MS
      ) {
        lastProbeAt = Date.now();
        replacementResponsive = probeResponsiveness({
          socketPath,
          timeoutMs: Math.min(1_500, Math.max(1, installDeadline - Date.now())),
          command,
        });
        if (replacementResponsive) break;
      }
      if (Date.now() >= installDeadline) break;
      await sleep(Math.min(pollMs, Math.max(1, installDeadline - Date.now())));
    } while (Date.now() <= installDeadline);
    return { predecessorGone, replacementPid, replacementResponsive };
  };

  // A live child behind an unchanged unit that is simply not answering yet and
  // is young is still starting — first launch, cold disk, big project
  // database. Restarting it only resets its clock. A brain that keeps dying is
  // always "young" (systemd just respawned it, `Restart=always`), so a
  // recorded failure streak vetoes the wait.
  const crashLooping = deps.recentCrashLoop
    ? deps.recentCrashLoop()
    : recentCrashLoopForAdeHome(adeHome);
  if (
    unitUnchanged
    && state?.active === true
    && !crashLooping
    && isYoungBrain(state.mainPid, run, pidElapsedMs)
  ) {
    const young = await awaitHandover(null);
    if (young.replacementResponsive) {
      return {
        ok: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: targetPath,
        message: "ADE service systemd user service is already installed; its background service finished starting.",
      };
    }
    if (young.replacementPid != null && isAlive(young.replacementPid)) {
      return {
        ok: true,
        starting: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: targetPath,
        message: `ADE service systemd user service is installed; the background service (pid ${young.replacementPid}) is still starting.`,
      };
    }
    // The young child died while we waited: fall through and (re)start it.
    state = getSystemdUnitState(run, unitName);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, unit, "utf8");
  const reload = run("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (reload.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: serviceManagerResultText(reload) || "systemctl daemon-reload failed.",
    };
  }
  const enable = run("systemctl", ["--user", "enable", "--now", unitName], { encoding: "utf8" });
  if (enable.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: serviceManagerResultText(enable) || "systemctl enable --now failed.",
    };
  }
  const oldPid = state?.mainPid ?? null;
  const restart = run("systemctl", ["--user", "restart", unitName], { encoding: "utf8" });
  if (restart.status !== 0) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: serviceManagerResultText(restart) || "systemctl restart failed.",
    };
  }

  const { predecessorGone, replacementPid, replacementResponsive } = await awaitHandover(oldPid);
  if (!predecessorGone) {
    return handoverFailure(
      targetPath,
      "predecessor_exit",
      `ADE service handover failed because predecessor pid ${oldPid} is still alive.`,
    );
  }
  if (replacementPid == null || replacementPid === oldPid) {
    return handoverFailure(
      targetPath,
      "replacement_pid",
      `ADE service handover failed because systemd did not report a distinct replacement pid (old ${oldPid ?? "none"}, new ${replacementPid ?? "none"}).`,
    );
  }
  if (!replacementResponsive) {
    if (isAlive(replacementPid)) {
      // systemd owns a live replacement that has not answered yet. A slow
      // start, not a failed install: the supervisor keeps the child and the
      // caller keeps waiting for the endpoint.
      return {
        ok: true,
        starting: true,
        restarted: true,
        serviceName: ADE_RUNTIME_SERVICE_NAME,
        action: "install",
        path: targetPath,
        message: `ADE service systemd user service installed; the background service (pid ${replacementPid}) is still starting after ${timeoutMs}ms.`,
      };
    }
    return handoverFailure(
      targetPath,
      "replacement_responsive",
      `ADE service handover failed because replacement pid ${replacementPid} did not initialize over ${socketPath} within ${timeoutMs}ms.`,
    );
  }
  return {
    ok: true,
    restarted: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: targetPath,
    message: "ADE service systemd user service installed.",
  };
}

export function uninstallSystemdService(): ServiceManagerResult {
  const targetPath = servicePath();
  spawnSync("systemctl", ["--user", "disable", "--now", serviceUnitName()], { stdio: "ignore" });
  try { fs.unlinkSync(targetPath); } catch {}
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "uninstall",
    path: targetPath,
    message: "ADE service systemd user service removed.",
  };
}

export function getSystemdServiceStatus(): ServiceManagerStatusResult {
  const targetPath = servicePath();
  const unitName = serviceUnitName();
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", unitName], { encoding: "utf8" });
  const active = spawnSync("systemctl", ["--user", "is-active", unitName], { encoding: "utf8" });
  const installed = fs.existsSync(targetPath) || enabled.status === 0;
  if (!installed) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "status",
      installed: false,
      running: false,
      path: targetPath,
      message: "ADE service systemd user service is not installed.",
    };
  }

  const running = active.status === 0;
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "status",
    installed: true,
    running,
    path: targetPath,
    message: running
      ? "ADE service systemd user service is running."
      : serviceManagerResultText(active) || "ADE service systemd user service is installed but not running.",
  };
}
