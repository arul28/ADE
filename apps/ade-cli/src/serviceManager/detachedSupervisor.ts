import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  isCurrentProcessDescendantOfPid,
  isPidAlive,
  isStaleChannelServeCommandLine,
  resolveAdeServeCliScriptPath,
  resolveAdeServeCommand,
  RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS,
  shellQuote,
  terminatePidGracefullyAsync,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
  type ServiceManagerStatusResult,
} from "./common";
import {
  awaitServiceHandover,
  defaultResponsivenessProbe,
  type ResponsivenessProbe,
  serviceHandoverSleep,
} from "./serviceHandover";

/**
 * The brain's supervisor on a Linux machine with no usable service manager.
 *
 * Cloud boxes and containers (Agent37's gVisor and VM boxes, Docker, CI) run
 * with `tini` or a vendor init as PID 1 and no systemd, so `systemctl --user`
 * has no manager to talk to. `ade brain start` used to fail there with
 * "systemctl daemon-reload failed." and start nothing.
 *
 * In that case ADE supervises the brain itself: a small `sh` loop, started in
 * its own session so it outlives the command that started it, runs the same
 * command and environment the systemd unit would (role included), restarts the
 * brain when it exits the way `Restart=always` does, and writes the brain's
 * output to the same log files the unit uses, so diagnostics and log bounding
 * keep working. What it cannot do is come back after a reboot; the status
 * message says so.
 */

/** Written by `ade brain start`; read by status, stop and the main-pid lookup. */
export type DetachedSupervisorRecord = {
  supervisorPid: number;
  scriptPath: string;
  startedAt: string;
};

export type DetachedSupervisorDeps = {
  command?: AdeServiceCommand;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnSync?: ServiceManagerSpawnSync;
  responsivenessProbe?: ResponsivenessProbe;
  handoverTimeoutMs?: number;
  handoverPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** The note every fallback message carries, so a person knows what they are running. */
export const NO_SERVICE_MANAGER_NOTE =
  "This machine has no systemd user service manager, so ADE runs the brain as a supervised background process: "
  + "it restarts after a crash, but not after a reboot (run `ade brain start` again then).";

/** How long a brain gets to exit on SIGTERM before it is killed. */
const BRAIN_STOP_GRACE_MS = 10_000;

/** Environment a systemd user manager would hand its units; nothing caller-specific. */
const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

type ResolvedPaths = {
  adeHome: string;
  runtimeDir: string;
  socketPath: string;
  scriptPath: string;
  recordPath: string;
  brainPidPath: string;
};

function resolvePaths(command: AdeServiceCommand, env: NodeJS.ProcessEnv, homeDir: string): ResolvedPaths {
  const adeHome = command.env?.ADE_HOME?.trim() || env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  const runtimeDir = path.join(adeHome, "runtime");
  return {
    adeHome,
    runtimeDir,
    socketPath: path.join(adeHome, "sock", "ade.sock"),
    scriptPath: path.join(runtimeDir, "brain-supervisor.sh"),
    recordPath: path.join(runtimeDir, "brain-supervisor.json"),
    brainPidPath: path.join(runtimeDir, "brain-supervisor.brain.pid"),
  };
}

/** The ADE home a status or stop call is about, without resolving the serve command. */
function resolveAdeHomePaths(env: NodeJS.ProcessEnv, homeDir: string): ResolvedPaths {
  return resolvePaths({ command: "", args: [] }, env, homeDir);
}

/**
 * The supervisor script. Everything that defines the brain (command, role,
 * environment, log files) is in it, so "is the running supervisor current?"
 * is one string comparison, as it is for the systemd unit.
 */
export function renderDetachedSupervisorScript(command: AdeServiceCommand, paths: {
  runtimeDir: string;
  brainPidPath: string;
}): string {
  const exports = Object.entries(command.env ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const out = shellQuote(path.join(paths.runtimeDir, "systemd.out.log"));
  const err = shellQuote(path.join(paths.runtimeDir, "systemd.err.log"));
  const pidFile = shellQuote(paths.brainPidPath);
  const exec = [command.command, ...command.args].map(shellQuote).join(" ");
  return `#!/bin/sh
# ADE brain supervisor, written by \`ade brain start\` because this machine has
# no usable systemd user manager. It does what the systemd unit would: run the
# brain, and start it again when it exits. Stop it with \`ade brain stop\`.
${exports}
child=''
on_stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  rm -f ${pidFile}
  exit 0
}
trap on_stop TERM INT HUP
delay=1
while :; do
  started=$(date +%s)
  ${exec} </dev/null >>${out} 2>>${err} &
  child=$!
  echo "$child" >${pidFile}
  wait "$child"
  status=$?
  child=''
  rm -f ${pidFile}
  ran=$(( $(date +%s) - started ))
  # A brain that keeps dying straight away backs off to one start a minute,
  # as systemd's start limit would, instead of spinning.
  if [ "$ran" -ge 60 ]; then delay=2; else delay=$(( delay * 2 )); fi
  if [ "$delay" -gt 60 ]; then delay=60; fi
  echo "ADE supervisor: brain exited with status $status after \${ran}s; starting it again in \${delay}s." >>${err}
  sleep "$delay" &
  child=$!
  wait "$child"
  child=''
done
`;
}

function readRecord(recordPath: string): DetachedSupervisorRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as Partial<DetachedSupervisorRecord>;
    if (typeof parsed.supervisorPid !== "number" || parsed.supervisorPid <= 0) return null;
    if (typeof parsed.scriptPath !== "string" || !parsed.scriptPath) return null;
    return {
      supervisorPid: parsed.supervisorPid,
      scriptPath: parsed.scriptPath,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** `/proc/<pid>/cmdline` as one space-joined line, or null where there is no procfs. */
function readProcCommandLine(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

/**
 * The recorded supervisor pid, when it is still that supervisor. A pid can be
 * reused after a reboot or a kill; where procfs can say what runs under it,
 * the command line has to name the supervisor script.
 */
function liveSupervisorPid(record: DetachedSupervisorRecord | null): number | null {
  if (!record || !isPidAlive(record.supervisorPid)) return null;
  const commandLine = readProcCommandLine(record.supervisorPid);
  if (commandLine != null && !commandLine.includes(record.scriptPath)) return null;
  return record.supervisorPid;
}

function readBrainPid(brainPidPath: string): number | null {
  try {
    const pid = Number(fs.readFileSync(brainPidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The brain the supervisor is running right now, or null. The runtime-service
 * main-pid lookup answers with this when there is no systemd, so the brain
 * still knows it is the machine's supervised brain (sync-host takeover) and a
 * command running inside it is still refused a self-restart.
 */
export function readDetachedSupervisedBrainPid(
  deps: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): number | null {
  const paths = resolveAdeHomePaths(deps.env ?? process.env, deps.homeDir ?? os.homedir());
  if (liveSupervisorPid(readRecord(paths.recordPath)) == null) return null;
  return readBrainPid(paths.brainPidPath);
}

/** Whether a supervisor from an earlier `ade brain start` is still running. */
export function hasLiveDetachedSupervisor(
  deps: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): boolean {
  const paths = resolveAdeHomePaths(deps.env ?? process.env, deps.homeDir ?? os.homedir());
  return liveSupervisorPid(readRecord(paths.recordPath)) != null;
}

/**
 * Other brains serving this channel's machine socket: a brain an earlier
 * command started on its own (`spawnMachineRuntimeDaemon`), or one a person
 * started by hand. Left running they hold the socket, and the supervised
 * brain would only fail to bind it. The same predicate the launchd install
 * reaps with; read from procfs so it does not depend on `ps` being installed.
 */
function listUnsupervisedServePids(command: AdeServiceCommand, socketPath: string, exclude: number[]): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const skip = new Set([process.pid, ...exclude]);
  const match = { cliScriptPath: resolveAdeServeCliScriptPath(command), primarySocketPath: socketPath };
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (skip.has(pid)) continue;
    const commandLine = readProcCommandLine(pid);
    if (commandLine && isStaleChannelServeCommandLine(commandLine, match)) pids.push(pid);
  }
  return pids;
}

function selfMutationBlocked(
  action: "install" | "uninstall",
  targetPath: string,
  pids: Array<number | null>,
  env: NodeJS.ProcessEnv,
  run: ServiceManagerSpawnSync,
): ServiceManagerResult | null {
  if (env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION === "1") return null;
  const owner = pids.find((pid): pid is number => pid != null && isCurrentProcessDescendantOfPid({ targetPid: pid, run }));
  if (owner == null) return null;
  const verb = action === "install" ? "restart" : "stop";
  return {
    ok: false,
    selfMutationBlocked: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action,
    path: targetPath,
    message:
      `Refusing to ${verb} ADE brain from a command running inside that brain `
      + `(pid ${owner}). Run this from an external terminal, or set `
      + "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1 if you intentionally want to tear down active ADE sessions.",
  };
}

async function stopPids(supervisorPid: number | null, brainPid: number | null): Promise<void> {
  // The supervisor first: its trap passes the SIGTERM on to the brain and
  // waits for it, and a supervisor still running would start a new one.
  if (supervisorPid != null) {
    await terminatePidGracefullyAsync(supervisorPid, { platform: "linux", graceTimeoutMs: BRAIN_STOP_GRACE_MS });
  }
  if (brainPid != null && isPidAlive(brainPid)) {
    await terminatePidGracefullyAsync(brainPid, { platform: "linux", graceTimeoutMs: BRAIN_STOP_GRACE_MS });
  }
}

function baseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    const value = env[key];
    if (value != null && value !== "") base[key] = value;
  }
  return base;
}

function startSupervisor(paths: ResolvedPaths, env: NodeJS.ProcessEnv): number | null {
  const errFd = fs.openSync(path.join(paths.runtimeDir, "systemd.err.log"), "a");
  try {
    const child = spawn("/bin/sh", [paths.scriptPath], {
      detached: true,
      stdio: ["ignore", errFd, errFd],
      env: baseEnvironment(env),
    });
    child.once("error", () => {});
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(errFd);
  }
}

/**
 * `ade brain start` / restart where systemd cannot run the service. Replaces
 * any supervisor and unsupervised brain on the machine socket, starts a fresh
 * supervisor, and waits for its brain to answer with the same budget and the
 * same `starting` semantics as the systemd install.
 */
export async function installDetachedRuntimeService(
  deps: DetachedSupervisorDeps = {},
): Promise<ServiceManagerResult> {
  const env = deps.env ?? process.env;
  const run = deps.spawnSync ?? spawnSync;
  const command = deps.command ?? resolveAdeServeCommand();
  const paths = resolvePaths(command, env, deps.homeDir ?? os.homedir());
  const probe = deps.responsivenessProbe ?? defaultResponsivenessProbe;
  const sleep = deps.sleep ?? serviceHandoverSleep;
  const timeoutMs = Math.max(0, deps.handoverTimeoutMs ?? RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS);
  const pollMs = Math.max(10, deps.handoverPollMs ?? 100);
  const script = renderDetachedSupervisorScript(command, paths);

  const existingSupervisor = liveSupervisorPid(readRecord(paths.recordPath));
  const existingBrain = existingSupervisor != null ? readBrainPid(paths.brainPidPath) : null;
  const scriptUnchanged = (() => {
    try { return fs.readFileSync(paths.scriptPath, "utf8") === script; } catch { return false; }
  })();
  const forceRestart = env.ADE_FORCE_RUNTIME_SERVICE_RESTART === "1";

  if (
    !forceRestart
    && existingSupervisor != null
    && scriptUnchanged
    && probe({ socketPath: paths.socketPath, timeoutMs: 1_500, command })
  ) {
    return {
      ok: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: paths.scriptPath,
      message: `ADE brain is already running (pid ${existingBrain ?? "unknown"}). ${NO_SERVICE_MANAGER_NOTE}`,
    };
  }

  const strays = listUnsupervisedServePids(command, paths.socketPath, [existingSupervisor, existingBrain].filter((pid): pid is number => pid != null));
  const blocked = selfMutationBlocked("install", paths.scriptPath, [existingSupervisor, existingBrain, ...strays], env, run);
  if (blocked) return blocked;

  await stopPids(existingSupervisor, existingBrain);
  for (const pid of strays) {
    await terminatePidGracefullyAsync(pid, { platform: "linux", graceTimeoutMs: BRAIN_STOP_GRACE_MS });
  }

  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.writeFileSync(paths.scriptPath, script, { encoding: "utf8", mode: 0o700 });
  try { fs.rmSync(paths.brainPidPath, { force: true }); } catch {}
  const supervisorPid = startSupervisor(paths, env);
  if (supervisorPid == null) {
    return {
      ok: false,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: paths.scriptPath,
      message: `ADE could not start the brain supervisor (/bin/sh ${paths.scriptPath}). ${NO_SERVICE_MANAGER_NOTE}`,
    };
  }
  const record: DetachedSupervisorRecord = {
    supervisorPid,
    scriptPath: paths.scriptPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.recordPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });

  const handover = await awaitServiceHandover({
    readSupervisedPid: () => (isPidAlive(supervisorPid) ? readBrainPid(paths.brainPidPath) : null),
    isAlive: isPidAlive,
    probeResponsiveness: probe,
    socketPath: paths.socketPath,
    command,
    sleep,
    pollMs,
  }, existingBrain, timeoutMs);

  if (handover.replacementResponsive) {
    return {
      ok: true,
      restarted: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: paths.scriptPath,
      message: `ADE brain started (pid ${handover.replacementPid}). ${NO_SERVICE_MANAGER_NOTE}`,
    };
  }
  if (isPidAlive(supervisorPid)) {
    // Same contract as the systemd install: a supervised brain that is alive
    // but has not answered yet is starting, and the supervisor keeps it.
    return {
      ok: true,
      starting: true,
      restarted: true,
      serviceName: ADE_RUNTIME_SERVICE_NAME,
      action: "install",
      path: paths.scriptPath,
      message: `ADE brain is starting (supervisor pid ${supervisorPid}); it had not answered on ${paths.socketPath} after ${timeoutMs}ms. ${NO_SERVICE_MANAGER_NOTE}`,
    };
  }
  return {
    ok: false,
    failureStep: "replacement_responsive",
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "install",
    path: paths.scriptPath,
    message: `ADE brain supervisor exited before the brain answered on ${paths.socketPath}. See ${path.join(paths.runtimeDir, "systemd.err.log")}.`,
  };
}

/**
 * `ade brain stop`: the supervisor and its brain. Returns null when no
 * supervisor was ever started and `stopUnsupervised` is off (a systemd
 * machine cleaning up after itself). With `stopUnsupervised` (no systemd at
 * all) it also stops brains on the machine socket that nothing supervises,
 * since on such a machine those are the only brain there is.
 */
export async function uninstallDetachedRuntimeService(
  deps: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    spawnSync?: ServiceManagerSpawnSync;
    command?: AdeServiceCommand;
    stopUnsupervised?: boolean;
  } = {},
): Promise<ServiceManagerResult | null> {
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const paths = resolveAdeHomePaths(env, homeDir);
  const record = readRecord(paths.recordPath);
  if (!record && !deps.stopUnsupervised) return null;
  const supervisorPid = liveSupervisorPid(record);
  const brainPid = supervisorPid != null ? readBrainPid(paths.brainPidPath) : null;
  const strays = deps.stopUnsupervised
    ? (() => {
      const command = deps.command ?? resolveAdeServeCommand();
      const socketPath = resolvePaths(command, env, homeDir).socketPath;
      return listUnsupervisedServePids(command, socketPath, [supervisorPid, brainPid].filter((pid): pid is number => pid != null));
    })()
    : [];
  const blocked = selfMutationBlocked("uninstall", paths.scriptPath, [supervisorPid, brainPid, ...strays], env, deps.spawnSync ?? spawnSync);
  if (blocked) return blocked;
  await stopPids(supervisorPid, brainPid);
  for (const pid of strays) {
    await terminatePidGracefullyAsync(pid, { platform: "linux", graceTimeoutMs: BRAIN_STOP_GRACE_MS });
  }
  for (const file of [paths.recordPath, paths.brainPidPath]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  const stoppedAny = supervisorPid != null || brainPid != null || strays.length > 0;
  return {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "uninstall",
    path: paths.scriptPath,
    message: stoppedAny
      ? "ADE brain stopped. This machine has no systemd user service manager, so ADE ran it as a supervised background process."
      : "ADE brain was not running. This machine has no systemd user service manager, so there was no service to remove.",
  };
}

export function getDetachedRuntimeServiceStatus(
  deps: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): ServiceManagerStatusResult {
  const paths = resolveAdeHomePaths(deps.env ?? process.env, deps.homeDir ?? os.homedir());
  const supervisorPid = liveSupervisorPid(readRecord(paths.recordPath));
  const brainPid = supervisorPid != null ? readBrainPid(paths.brainPidPath) : null;
  const base = {
    ok: true,
    serviceName: ADE_RUNTIME_SERVICE_NAME,
    action: "status" as const,
    path: paths.scriptPath,
  };
  if (supervisorPid == null) {
    return {
      ...base,
      installed: false,
      running: false,
      message: "ADE brain is not supervised: this machine has no systemd user service manager. "
        + "Run `ade brain start` to start it as a supervised background process.",
    };
  }
  if (brainPid == null) {
    return {
      ...base,
      installed: true,
      running: false,
      message: `ADE brain supervisor (pid ${supervisorPid}) is between restarts of the brain. ${NO_SERVICE_MANAGER_NOTE}`,
    };
  }
  return {
    ...base,
    installed: true,
    running: true,
    message: `ADE brain is running as a supervised background process (pid ${brainPid}). ${NO_SERVICE_MANAGER_NOTE}`,
  };
}
