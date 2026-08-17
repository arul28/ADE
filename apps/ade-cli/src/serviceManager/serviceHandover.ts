import { spawnSync } from "node:child_process";
import {
  type AdeServiceCommand,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
  type ServiceManagerSpawnSync,
} from "./common";
import {
  LAST_FAILURE_CRASH_LOOP_WINDOW_MS,
  readLastFailure,
} from "../../../desktop/src/main/services/runtime/lastFailureStore";

/**
 * Handover primitives shared by every platform installer (launchd, systemd,
 * Windows). They were born inside `installLaunchd.ts`; systemd needs the exact
 * same semantics, and two copies of "is this brain young enough to wait for"
 * would drift the moment one of them is tuned.
 */

export type ResponsivenessProbe = (args: {
  socketPath: string;
  timeoutMs: number;
  command: AdeServiceCommand;
}) => boolean;

export type PidElapsedMsLookup = (
  pid: number,
  run: ServiceManagerSpawnSync,
) => number | null;

export async function serviceHandoverSleep(ms: number): Promise<void> {
  // Awaited lifecycle delays must stay referenced: in a standalone CLI the
  // handover polling can be the only pending work, and an unref'd timer lets
  // the process exit mid-repair (before SIGKILL escalation / service load).
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function runtimeStatusArgs(command: AdeServiceCommand, socketPath: string): string[] {
  const args = [...command.args];
  const serveIndex = args.lastIndexOf("serve");
  if (serveIndex >= 0) {
    args.splice(serveIndex, 1, "runtime", "status");
  } else {
    args.push("runtime", "status");
  }
  args.push("--socket", socketPath, "--timeout", "1500", "--text");
  return args;
}

/**
 * The probe is a whole `ade runtime status` child process: Node/Electron
 * start-up plus loading the CLI bundle BEFORE it can even dial the socket. Its
 * kill timeout therefore has to be the socket wait plus a start-up allowance;
 * when the two were equal, a machine where the CLI took longer than the socket
 * budget to start killed every probe before it could answer, and a perfectly
 * healthy brain read as "never responsive".
 */
export const RESPONSIVENESS_PROBE_STARTUP_ALLOWANCE_MS = 8_000;

/**
 * How often the handover wait spends a probe child. Each probe is a full CLI
 * process; on the slow machines this wait exists for, probing every poll tick
 * would compete with the very brain it is waiting on.
 */
export const RESPONSIVENESS_PROBE_INTERVAL_MS = 750;

export const defaultResponsivenessProbe: ResponsivenessProbe = (args) => {
  const env = {
    ...process.env,
    ...(args.command.env ?? {}),
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
  };
  const result = spawnSync(
    args.command.command,
    runtimeStatusArgs(args.command, args.socketPath),
    {
      encoding: "utf8",
      env,
      timeout: args.timeoutMs + RESPONSIVENESS_PROBE_STARTUP_ALLOWANCE_MS,
      stdio: "ignore",
    },
  );
  return result.status === 0 && !result.error;
};

/**
 * A fresh failure streak recorded by the brain itself (`last-failure.json`,
 * the same record project recovery and the startup backoff read). Two or more
 * failures inside the crash-loop window means the supervisor is respawning a
 * brain that dies, and its youth is not a reason to wait for it.
 *
 * Scoped to the ADE home this install is FOR, not the installer's own: a
 * desktop on one channel installing another channel's service would otherwise
 * read the wrong `last-failure.json`.
 */
export function recentCrashLoopForAdeHome(adeHome: string): boolean {
  const report = readLastFailure({ kind: "machine", env: { ADE_HOME: adeHome } });
  if (!report || report.count < 2) return false;
  const firstAt = Date.parse(report.firstAt);
  return Number.isFinite(firstAt) && Date.now() - firstAt <= LAST_FAILURE_CRASH_LOOP_WINDOW_MS;
}

/**
 * A running service child that is younger than the young-brain window and not
 * answering yet is presumed to still be starting. Unknown age (the age lookup
 * failed) counts as NOT young, so a wedged brain is never mistaken for a
 * booting one — this fails toward restarting, never toward waiting forever.
 */
export function isYoungBrain(
  pid: number | null | undefined,
  run: ServiceManagerSpawnSync,
  elapsedMs: PidElapsedMsLookup,
): boolean {
  if (!pid) return false;
  const elapsed = elapsedMs(pid, run);
  return elapsed != null && elapsed < RUNTIME_SERVICE_YOUNG_BRAIN_MS;
}
