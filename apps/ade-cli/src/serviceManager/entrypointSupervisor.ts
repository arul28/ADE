import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADE_RUNTIME_SERVICE_NAME,
  type AdeServiceCommand,
  isCurrentProcessDescendantOfPid,
  isPidAlive,
  isSameServeSocketPath,
  RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS,
  serveSocketArgument,
  terminatePidGracefullyAsync,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
} from "./common";
import { hasLiveDetachedSupervisor, uninstallDetachedRuntimeService } from "./detachedSupervisor";
import {
  awaitServiceHandover,
  defaultResponsivenessProbe,
  type ResponsivenessProbe,
  serviceHandoverSleep,
} from "./serviceHandover";

/**
 * A brain whose supervisor is the machine's own entrypoint: ADE's Agent 37
 * template runs `ade serve` in a loop as the container's main process
 * (`infra/agent37/template/ade-entrypoint.sh`), and that loop is what survives
 * an Agent 37 sleep.
 *
 * Such a machine has no systemd, so a restart used to start ADE's own
 * supervisor (detachedSupervisor.ts) beside the loop. The loop's brain kept the
 * socket, every brain the new supervisor started exited with "socket already
 * in use", and the old brain still answered, so the restart read as done: an
 * update on the box said "Restarting on <version>…" and never finished
 * (2026-11-06, D7).
 *
 * Here a restart stops the brain on the socket and waits for the loop to start
 * the next one, which runs the newest `ade` on the machine. A brain started by
 * an older template's loop (which always runs the image's `ade`) is refused
 * plainly: an update there cannot take effect.
 */

/** Set by the template's entrypoint for the brain it runs (and so for every update helper the brain starts). */
export const ENTRYPOINT_SUPERVISOR_ENV = "ADE_BRAIN_SUPERVISOR";

/** The entrypoint every ADE Agent 37 template runs; an older one runs it without the env above. */
const TEMPLATE_ENTRYPOINT = "ade-entrypoint.sh";

/** How long a brain gets to exit on SIGTERM before it is killed. */
const BRAIN_STOP_GRACE_MS = 10_000;

/**
 * How long a restart waits for the loop to start the next brain. After a
 * brain that ran less than a minute, the loop waits up to 60 s before the
 * next start (ade-entrypoint.sh), so a crash-looping box needs that wait plus
 * the start itself.
 */
const ENTRYPOINT_HANDOVER_TIMEOUT_MS = 90_000;

export type EntrypointSupervisorDeps = {
  command: AdeServiceCommand;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  spawnSync?: ServiceManagerSpawnSync;
  responsivenessProbe?: ResponsivenessProbe;
  handoverTimeoutMs?: number;
  handoverPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function readCommandLine(procRoot: string, pid: number): string | null {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

function readParentPid(procRoot: string, pid: number): number | null {
  try {
    // The command name (field 2) is in parentheses and may hold spaces; ppid follows it.
    const stat = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function readExecutable(procRoot: string, pid: number): string | null {
  try {
    return fs.realpathSync(path.join(procRoot, String(pid), "exe"));
  } catch {
    return null;
  }
}

/** Whether a process runs with the entrypoint's mark in its environment. */
function hasSupervisorMark(procRoot: string, pid: number): boolean {
  try {
    return fs.readFileSync(path.join(procRoot, String(pid), "environ"), "utf8")
      .split("\0")
      .includes(`${ENTRYPOINT_SUPERVISOR_ENV}=entrypoint`);
  } catch {
    return false;
  }
}

/** Every `ade … serve --socket <socketPath>` on the machine, whatever binary runs it. */
function servePidsOnSocket(procRoot: string, socketPath: string, exclude: ReadonlySet<number>): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (exclude.has(pid)) continue;
    const line = readCommandLine(procRoot, pid);
    if (!line || !/(?:^|\s)serve(?:\s|$)/.test(line)) continue;
    const socket = serveSocketArgument(line);
    if (socket && isSameServeSocketPath(socket, socketPath)) pids.push(pid);
  }
  return pids;
}

function result(ok: boolean, scriptPath: string | null, message: string, extra: Partial<ServiceManagerResult> = {}): ServiceManagerResult {
  return { ok, serviceName: ADE_RUNTIME_SERVICE_NAME, action: "install", path: scriptPath, message, ...extra };
}

/**
 * The restart for a brain the machine's entrypoint supervises, or null when
 * the entrypoint does not supervise the brain here (the caller then supervises
 * it itself).
 */
export async function restartEntrypointSupervisedBrain(deps: EntrypointSupervisorDeps): Promise<ServiceManagerResult | null> {
  const env = deps.env ?? process.env;
  const procRoot = "/proc";
  const homeDir = deps.homeDir ?? os.homedir();
  const adeHome = deps.command.env?.ADE_HOME?.trim() || env.ADE_HOME?.trim() || path.join(homeDir, ".ade");
  const socketPath = path.join(adeHome, "sock", "ade.sock");
  const self = new Set([process.pid]);
  const running = servePidsOnSocket(procRoot, socketPath, self);
  // The brain's helpers inherit the mark; a command run another way (Agent 37
  // exec) reads it from the brain the loop started.
  const marked = env[ENTRYPOINT_SUPERVISOR_ENV]?.trim() === "entrypoint"
    || running.some((pid) => hasSupervisorMark(procRoot, pid));
  const underTemplateLoop = running.some((pid) => {
    const parent = readParentPid(procRoot, pid);
    return parent != null && (readCommandLine(procRoot, parent) ?? "").includes(TEMPLATE_ENTRYPOINT);
  });
  if (!marked && !underTemplateLoop) return null;
  const entrypoint = `/usr/local/bin/${TEMPLATE_ENTRYPOINT}`;
  if (!marked) {
    // An older template's loop starts the image's `ade` every time, so a
    // restart here would only bring the old version back, and a second
    // supervisor would fight the loop for the socket.
    return result(
      false,
      entrypoint,
      "This machine was made from an older ADE machine template, whose start script always runs the ADE it was built with, "
        + "so an update can't take effect on it. Make a new machine (ade agent37 create) to get the current version; "
        + "ade chat move carries a lane's work to it. A copy keeps the old template.",
      { failureStep: "entrypoint_too_old" },
    );
  }

  const run = deps.spawnSync;
  if (env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION !== "1") {
    const owner = running.find((pid) => isCurrentProcessDescendantOfPid({ targetPid: pid, ...(run ? { run } : {}) }));
    if (owner != null) {
      return result(false, entrypoint,
        `Refusing to restart ADE brain from a command running inside that brain (pid ${owner}). Run this from an external terminal, `
        + "or set ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1 if you intentionally want to tear down active ADE sessions.",
        { selfMutationBlocked: true });
    }
  }

  // A supervisor an earlier, broken restart started beside the loop would
  // fight it for the socket.
  if (hasLiveDetachedSupervisor({ env, homeDir })) {
    await uninstallDetachedRuntimeService({ env: { ...env, ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1" }, homeDir });
  }
  for (const pid of running) {
    await terminatePidGracefullyAsync(pid, { platform: "linux", graceTimeoutMs: BRAIN_STOP_GRACE_MS });
  }

  const gone = new Set([...self, ...running]);
  const timeoutMs = Math.max(0, deps.handoverTimeoutMs ?? Math.max(RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS, ENTRYPOINT_HANDOVER_TIMEOUT_MS));
  const handover = await awaitServiceHandover({
    readSupervisedPid: () => servePidsOnSocket(procRoot, socketPath, gone)[0] ?? null,
    isAlive: isPidAlive,
    probeResponsiveness: deps.responsivenessProbe ?? defaultResponsivenessProbe,
    socketPath,
    command: deps.command,
    sleep: deps.sleep ?? serviceHandoverSleep,
    pollMs: Math.max(10, deps.handoverPollMs ?? 100),
  }, running[0] ?? null, timeoutMs);
  const pid = handover.replacementPid;
  if (pid == null) {
    return result(false, entrypoint, `ADE brain stopped, but the machine's start script did not start it again within ${Math.round(timeoutMs / 1000)}s.`, {
      failureStep: "replacement_pid",
    });
  }
  // The loop runs the newest `ade` on the machine. Anything else means this
  // update is not the one that came back.
  const want = (() => {
    try { return fs.realpathSync(deps.command.command); } catch { return deps.command.command; }
  })();
  const exe = readExecutable(procRoot, pid);
  if (exe && exe !== want) {
    return result(false, entrypoint, `ADE brain restarted, but the machine's start script ran ${exe} rather than ${want}.`, {
      failureStep: "replacement_pid",
    });
  }
  if (!handover.replacementResponsive) {
    return result(true, entrypoint, `ADE brain is starting (pid ${pid}); it had not answered on ${socketPath} after ${timeoutMs}ms.`, {
      starting: true,
      restarted: true,
    });
  }
  return result(true, entrypoint, `ADE brain restarted (pid ${pid}) by the machine's start script.`, { restarted: true });
}
