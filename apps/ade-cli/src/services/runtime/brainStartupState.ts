import {
  readPidElapsedMs,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
} from "../../serviceManager/common";
import type { WindowsSupervisorState } from "../../serviceManager/windowsSupervisor";

/**
 * The CLI's read of the desktop's `brain_starting` recovery state.
 *
 * A brain that does not answer on its socket is not automatically broken: when
 * the service is registered and its brain process is alive but younger than the
 * young-brain window, it is still coming up (first launch, cold disk, large
 * project database). The desktop reaches this verdict through its connection
 * pool (`ProjectRecoveryService.diagnose` -> `brain_starting`); the CLI has no
 * pool, so it asks the platform service manager the same two questions —
 * is the service registered and supervised, and how old is its brain — and
 * applies the same `RUNTIME_SERVICE_YOUNG_BRAIN_MS` bound.
 *
 * Time-bounded for the same reason the desktop's is: without the age check a
 * brain that wedged during boot would read as "starting" forever. And
 * crash-loop-vetoed for the reason the age check alone cannot cover: a
 * supervisor that respawns a dying brain every few seconds keeps producing a
 * young process forever, so youth stops being evidence of progress. This is
 * exactly the veto `awaitYoungBrainStart` already applies before `isYoungBrain`.
 */
export type BrainStartupState = {
  /** Registered, alive, young, and not crash-looping: waiting is the right move. */
  starting: boolean;
  /** Age of the service's brain process in ms, or null when unknown. */
  ageMs: number | null;
  serviceInstalled: boolean | null;
  serviceRunning: boolean | null;
};

/**
 * What a platform probe reports about the service behind a silent socket.
 * `supervised` is the platform's own answer to "is a supervisor we recognize
 * running a brain right now", which is NOT the same question as the status
 * command's `running` on Windows (there it means "the brain already answered",
 * which is false by construction everywhere this module is called).
 */
export type BrainStartupProbe = {
  installed: boolean | null;
  running: boolean | null;
  supervised: boolean;
  ageMs: number | null;
};

export type BrainStartupStateDeps = {
  getServiceStatus?: () => Promise<{ installed: boolean | null; running: boolean | null }>;
  getServiceMainPid?: () => Promise<number | null>;
  readBrainAgeMs?: (pid: number | null) => Promise<number | null>;
  /** Windows-only probe; ignored on the POSIX supervisors. */
  readWindowsStartupProbe?: () => Promise<BrainStartupProbe>;
  /** The `last-failure.json` crash-loop veto, scoped to this install's ADE home. */
  hasRecentCrashLoop?: () => Promise<boolean>;
  youngBrainMs?: number;
  platform?: NodeJS.Platform;
};

async function defaultGetServiceStatus(): Promise<{
  installed: boolean | null;
  running: boolean | null;
}> {
  const { getRuntimeServiceStatus } = await import("../../serviceManager");
  const status = getRuntimeServiceStatus();
  return { installed: status.installed, running: status.running };
}

async function defaultGetServiceMainPid(): Promise<number | null> {
  const { getRuntimeServiceMainPid } = await import("../../serviceManager");
  return getRuntimeServiceMainPid();
}

async function defaultReadBrainAgeMs(pid: number | null): Promise<number | null> {
  return pid == null ? null : readPidElapsedMs(pid);
}

/**
 * Windows has no launchd/systemd "the supervisor has a live child" answer, and
 * its `ServiceManagerStatusResult.running` means "the brain answered on the
 * pipe" — which is false by construction here. So this asks the supervisor
 * record directly, and gates youth on the same predicate the Windows installer
 * uses before it decides to wait for a booting brain instead of replacing it:
 * a first start (never restarted) whose runtime pid is still alive.
 */
export function describeWindowsStartupProbe(args: {
  supervisor: WindowsSupervisorState;
  isAlive: (pid: number) => boolean;
  nowMs?: number;
}): BrainStartupProbe {
  const { supervisor } = args;
  const record = supervisor.record;
  // Absent record means "we cannot tell": the HKCU Run entry can be registered
  // without a pid record, and this probe never reads that key. Report unknown
  // rather than claiming the service is not installed.
  const installed = supervisor.state === "error" || record == null ? null : true;
  if (!supervisor.running || !record) {
    return { installed, running: supervisor.running, supervised: false, ageMs: null };
  }
  const startedAtMs = record.runtimeStartedAtMs;
  const eligible = record.restartCount === 0
    && record.runtimePid != null
    && startedAtMs != null
    && args.isAlive(record.runtimePid);
  return {
    installed,
    running: supervisor.running,
    supervised: true,
    ageMs: eligible && startedAtMs != null
      ? Math.max(0, (args.nowMs ?? Date.now()) - startedAtMs)
      : null,
  };
}

async function defaultReadWindowsStartupProbe(): Promise<BrainStartupProbe> {
  const [
    { resolveWindowsServiceLauncherPath, resolveWindowsServicePidPath },
    { queryWindowsSupervisor },
    { isPidAlive },
    { spawnSync },
  ] = await Promise.all([
    import("../../serviceManager/installWindows"),
    import("../../serviceManager/windowsSupervisor"),
    import("../../serviceManager/common"),
    import("node:child_process"),
  ]);
  return describeWindowsStartupProbe({
    supervisor: queryWindowsSupervisor({
      spawnSync,
      launcherPath: resolveWindowsServiceLauncherPath(),
      pidPath: resolveWindowsServicePidPath(),
    }),
    isAlive: isPidAlive,
  });
}

async function defaultHasRecentCrashLoop(): Promise<boolean> {
  const [{ recentCrashLoopForAdeHome }, { resolveMachineAdeLayout }] = await Promise.all([
    import("../../serviceManager/serviceHandover"),
    import("../projects/machineLayout"),
  ]);
  return recentCrashLoopForAdeHome(resolveMachineAdeLayout().adeDir);
}

/**
 * Call this only when the brain did NOT answer — a responding brain is running,
 * never "starting".
 */
export async function readBrainStartupState(
  deps: BrainStartupStateDeps = {},
): Promise<BrainStartupState> {
  const youngBrainMs = deps.youngBrainMs ?? RUNTIME_SERVICE_YOUNG_BRAIN_MS;
  const platform = deps.platform ?? process.platform;
  let installed: boolean | null = null;
  let running: boolean | null = null;
  let ageMs: number | null = null;
  let supervised = false;
  try {
    if (platform === "win32") {
      const probe = await (deps.readWindowsStartupProbe ?? defaultReadWindowsStartupProbe)();
      installed = probe.installed;
      running = probe.running;
      supervised = probe.supervised;
      ageMs = probe.ageMs;
    } else {
      const status = await (deps.getServiceStatus ?? defaultGetServiceStatus)();
      installed = status.installed;
      running = status.running;
      // No registered service, or a registered one the supervisor is not
      // running: nothing is coming up, so this is a real failure and stays one.
      supervised = installed === true && running !== false;
      if (supervised) {
        const pid = await (deps.getServiceMainPid ?? defaultGetServiceMainPid)();
        ageMs = await (deps.readBrainAgeMs ?? defaultReadBrainAgeMs)(pid);
      }
    }
    if (supervised && ageMs != null && ageMs < youngBrainMs) {
      // A supervisor respawning a brain that dies produces a young process on
      // every loop, so the age bound alone never expires. The recorded failure
      // streak is the only thing that tells the two apart.
      if (await (deps.hasRecentCrashLoop ?? defaultHasRecentCrashLoop)()) {
        return { starting: false, ageMs, serviceInstalled: installed, serviceRunning: running };
      }
    }
  } catch {
    // Any probe failure fails closed to "not starting": reporting a brain as
    // starting when we cannot tell would hide a genuinely dead one.
    return { starting: false, ageMs: null, serviceInstalled: installed, serviceRunning: running };
  }
  return {
    starting: supervised && ageMs != null && ageMs < youngBrainMs,
    ageMs,
    serviceInstalled: installed,
    serviceRunning: running,
  };
}
