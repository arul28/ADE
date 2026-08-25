import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  isPidAlive,
  processOutputRaw,
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
  awaitServiceHandover,
  awaitYoungBrainStart,
  defaultResponsivenessProbe,
  type HandoverWaitDeps,
  type PidElapsedMsLookup,
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

/** See `launchAgentPath` for why `serviceName` is a parameter. */
export function servicePath(
  homeDir = os.homedir(),
  serviceName: string = ADE_RUNTIME_SERVICE_NAME,
): string {
  return path.join(homeDir, ".config", "systemd", "user", `${serviceName}.service`);
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

/**
 * There is no Linux counterpart to the launchd `MaterializeDatalessFiles` key,
 * because there is nothing here for it to fix. The macOS failure it answers is
 * a VFS dataless placeholder: a file whose contents the kernel evicted and
 * refuses to download back for a process whose I/O policy forbids it, reported
 * as EDEADLK. Linux has no such VFS state. Cloud clients here either sync whole
 * files to local storage or expose them through a FUSE mount, and a FUSE mount
 * that cannot serve a read answers with EIO or ENOENT from the mount itself --
 * a failure the caller sees the same way whichever process reads it, so no
 * per-unit policy could change the outcome.
 */
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
  const properties = parseSystemdShowOutput(processOutputRaw(show));
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

  const handoverWait: HandoverWaitDeps = {
    readSupervisedPid: () => {
      const replacement = getSystemdUnitState(run, unitName);
      return replacement?.active === true ? replacement.mainPid : null;
    },
    isAlive,
    probeResponsiveness,
    socketPath,
    command,
    sleep,
    pollMs,
  };

  const young = await awaitYoungBrainStart({
    definitionUnchanged: unitUnchanged,
    supervisedPid: state?.mainPid,
    running: state?.active === true,
    adeHome,
    recentCrashLoop: deps.recentCrashLoop,
    run,
    pidElapsedMs,
    timeoutMs,
    wait: handoverWait,
  });
  if (young.kind === "responsive") {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: "ADE service systemd user service is already installed; its background service finished starting.",
    };
  }
  if (young.kind === "starting") {
    return {
      ok: true,
      starting: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: targetPath,
      message: `ADE service systemd user service is installed; the background service (pid ${young.pid}) is still starting.`,
    };
  }
  if (young.kind === "died") {
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

  // A fresh full budget: the young-brain wait above may have spent all of its
  // own, and the real handover is the one whose outcome decides whether this
  // install reports `starting` or a failure.
  const { predecessorGone, replacementPid, replacementResponsive } = await awaitServiceHandover(
    handoverWait,
    oldPid,
    timeoutMs,
  );
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
