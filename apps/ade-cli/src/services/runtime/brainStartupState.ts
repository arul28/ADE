import {
  readPidElapsedMs,
  RUNTIME_SERVICE_YOUNG_BRAIN_MS,
} from "../../serviceManager/common";

/**
 * The CLI's read of the desktop's `brain_starting` recovery state.
 *
 * A brain that does not answer on its socket is not automatically broken: when
 * the service is registered and its brain process is alive but younger than the
 * young-brain window, it is still coming up (first launch, cold disk, large
 * project database). The desktop reaches this verdict through its connection
 * pool (`ProjectRecoveryService.diagnose` -> `brain_starting`); the CLI has no
 * pool, so it asks the platform service manager the same two questions —
 * is the service registered and running, and how old is its brain — and applies
 * the same `RUNTIME_SERVICE_YOUNG_BRAIN_MS` bound.
 *
 * Time-bounded for the same reason the desktop's is: without the age check a
 * brain that wedged during boot would read as "starting" forever.
 */
export type BrainStartupState = {
  /** Registered, alive, and young: waiting is the right move, not repairing. */
  starting: boolean;
  /** Age of the service's brain process in ms, or null when unknown. */
  ageMs: number | null;
  serviceInstalled: boolean | null;
  serviceRunning: boolean | null;
};

export type BrainStartupStateDeps = {
  getServiceStatus?: () => Promise<{ installed: boolean | null; running: boolean | null }>;
  getServiceMainPid?: () => Promise<number | null>;
  readBrainAgeMs?: (pid: number | null) => Promise<number | null>;
  youngBrainMs?: number;
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

/**
 * Windows has no `ps -o etime=`, but its supervisor already records when it
 * launched the brain it is watching, which is the same measurement.
 */
async function defaultReadBrainAgeMs(pid: number | null): Promise<number | null> {
  if (process.platform === "win32") {
    const { readWindowsServicePidRecord } = await import("../../serviceManager/installWindows");
    const startedAtMs = readWindowsServicePidRecord()?.runtimeStartedAtMs ?? null;
    if (startedAtMs == null || !Number.isFinite(startedAtMs)) return null;
    return Math.max(0, Date.now() - startedAtMs);
  }
  return pid == null ? null : readPidElapsedMs(pid);
}

/**
 * Call this only when the brain did NOT answer — a responding brain is running,
 * never "starting".
 */
export async function readBrainStartupState(
  deps: BrainStartupStateDeps = {},
): Promise<BrainStartupState> {
  const youngBrainMs = deps.youngBrainMs ?? RUNTIME_SERVICE_YOUNG_BRAIN_MS;
  let installed: boolean | null = null;
  let running: boolean | null = null;
  let ageMs: number | null = null;
  try {
    const status = await (deps.getServiceStatus ?? defaultGetServiceStatus)();
    installed = status.installed;
    running = status.running;
    // No registered service, or a registered one the supervisor is not running:
    // nothing is coming up, so this is a real failure and stays one.
    if (installed === true && running !== false) {
      const pid = await (deps.getServiceMainPid ?? defaultGetServiceMainPid)();
      ageMs = await (deps.readBrainAgeMs ?? defaultReadBrainAgeMs)(pid);
    }
  } catch {
    // Any probe failure fails closed to "not starting": reporting a brain as
    // starting when we cannot tell would hide a genuinely dead one.
    return { starting: false, ageMs: null, serviceInstalled: installed, serviceRunning: running };
  }
  return {
    starting: installed === true && running !== false && ageMs != null && ageMs < youngBrainMs,
    ageMs,
    serviceInstalled: installed,
    serviceRunning: running,
  };
}
