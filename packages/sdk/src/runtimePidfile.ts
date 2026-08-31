import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "./errors.js";
import { endpointComparisonKey } from "./socketPath.js";
import { resolveTrustedWindowsTool } from "./windowsSystemTools.js";

const execFileAsync = promisify(execFile);

/**
 * Records which runtime process owns a given ADE home, at `<home>/runtime.pid`.
 *
 * Two problems, one file:
 *
 *  1. **Reclaim.** A host that dies without unwinding leaves its runtime alive
 *     (POSIX reparents orphans to init rather than killing them). The engine's
 *     parent-death watchdog ends that runtime within a few seconds, but a new
 *     `createAdeChat` on the same home can start inside that window and race a
 *     dying process for the same socket. Reading the pidfile lets the new client
 *     end the old runtime deterministically instead of hoping about timing.
 *
 *  2. **Diagnosis.** "Which process is holding this home" is otherwise
 *     unanswerable without matching process names, which is exactly the
 *     kill-by-pattern hazard this file exists to avoid.
 *
 * PID REUSE is the sharp edge. A pid recorded hours ago may now belong to some
 * unrelated process — the user's editor. Killing it would be catastrophic and
 * completely silent. So a recorded pid is never trusted on its own: the record
 * carries the socket path and a start token, and `reclaimStaleRuntime` only
 * kills a process it has corroborated. When in doubt it does nothing, because
 * leaking one runtime is recoverable and killing the wrong process is not.
 */

export type RuntimePidRecord = {
  version: 1;
  pid: number;
  /** Endpoint this runtime was told to listen on. */
  socketPath: string;
  /** The pid of the host that spawned it — this process, when we wrote it. */
  parentPid: number;
  startedAt: string;
};

export const RUNTIME_PIDFILE_NAME = "runtime.pid";

export function runtimePidfilePath(home: string): string {
  return path.join(path.resolve(home), RUNTIME_PIDFILE_NAME);
}

export async function writeRuntimePidfile(
  home: string,
  record: Omit<RuntimePidRecord, "version">,
): Promise<void> {
  const target = runtimePidfilePath(home);
  const payload: RuntimePidRecord = { version: 1, ...record };
  // Atomic, matching ThreadStore: a crash mid-write must not leave a truncated
  // file that a later reclaim would misparse into a bogus pid.
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temp, target);
}

export async function readRuntimePidfile(home: string): Promise<RuntimePidRecord | null> {
  try {
    const raw = await fs.promises.readFile(runtimePidfilePath(home), "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimePidRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
    // A non-positive pid is rejected here rather than downstream: on POSIX it
    // addresses a process GROUP, and this value flows into process.kill.
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof parsed.socketPath !== "string" || !parsed.socketPath.length) return null;
    return {
      version: 1,
      pid,
      socketPath: parsed.socketPath,
      parentPid: typeof parsed.parentPid === "number" ? parsed.parentPid : 0,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    // Absent (the normal first-run case) or unreadable: nothing to reclaim.
    return null;
  }
}

export async function removeRuntimePidfile(home: string): Promise<void> {
  try {
    await fs.promises.rm(runtimePidfilePath(home), { force: true });
  } catch {
    // Best-effort during teardown.
  }
}

export type ReclaimOutcome =
  /** No pidfile, or it named a process that is already gone. */
  | { action: "none"; reason: string }
  /** A live runtime answered on the socket; the caller should attach, not spawn. */
  | { action: "reused"; pid: number }
  /** The recorded process was corroborated and killed. */
  | { action: "killed"; pid: number }
  /** A process exists but we could not prove it is ours; deliberately untouched. */
  | { action: "left"; pid: number; reason: string };

export type ReclaimOptions = {
  home: string;
  /** Endpoint the new client intends to use. */
  socketPath: string;
  logger?: (line: string) => void;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Proves a live runtime owns the endpoint. Resolves true when it answered. */
  probeEndpoint?: (socketPath: string) => Promise<boolean>;
  /** Grace between SIGTERM and SIGKILL. */
  terminateGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When the OS says the process with this pid started. Null when it cannot be
   * determined — which is treated as "cannot corroborate", never as "safe".
   */
  processStartedAt?: (pid: number) => Promise<Date | null>;
};

/**
 * How much earlier than the pidfile timestamp a genuine runtime may have
 * started. Our runtime starts a beat BEFORE its pidfile is written (the file
 * lands only after a successful connect), so a small negative skew is normal;
 * minutes of it are not.
 */
const START_TIME_TOLERANCE_MS = 120_000;

const DEFAULT_TERMINATE_GRACE_MS = 3_000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — alive, and
    // emphatically not ours to kill.
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/**
 * Ends a leftover runtime for this home, if one can be positively identified.
 *
 * Order matters. The endpoint is probed FIRST: a runtime that still answers is
 * a working runtime, and the right move is to reuse it rather than kill a
 * healthy process and pay a cold boot. Only a recorded pid that is alive but
 * whose endpoint is dead is a candidate for termination — that is the orphan
 * signature (process up, socket unusable or being torn down).
 *
 * Corroboration against pid reuse:
 *  - the record must name the same endpoint this client is about to use;
 *  - the process must be signalable by us (EPERM ⇒ someone else's, leave it).
 * A recycled pid belonging to an unrelated process fails the first check
 * whenever the home differs, and homes are per-app. This is not a proof, so the
 * bias throughout is toward leaving a process alone.
 */
export async function reclaimStaleRuntime(options: ReclaimOptions): Promise<ReclaimOutcome> {
  const {
    home,
    socketPath,
    logger = () => {},
    isAlive = defaultIsAlive,
    kill = (pid, signal) => process.kill(pid, signal),
    probeEndpoint,
    terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
    sleep = defaultSleep,
  } = options;

  const record = await readRuntimePidfile(home);
  if (!record) return { action: "none", reason: "no pidfile" };

  if (record.pid === process.pid) {
    // Only reachable if a host reuses a home its own previous incarnation
    // wrote. Killing ourselves would be a spectacular own goal.
    return { action: "left", pid: record.pid, reason: "pidfile names this process" };
  }

  if (endpointComparisonKey(record.socketPath) !== endpointComparisonKey(socketPath)) {
    // The record is for a different endpoint, so we cannot claim the process is
    // ours. Under pid reuse this is exactly the check that saves an innocent
    // process from being killed.
    return {
      action: "left",
      pid: record.pid,
      reason: `pidfile names a different endpoint (${record.socketPath})`,
    };
  }

  if (!isAlive(record.pid)) {
    await removeRuntimePidfile(home);
    return { action: "none", reason: "recorded process is already gone" };
  }

  if (probeEndpoint) {
    let answered = false;
    try {
      answered = await probeEndpoint(socketPath);
    } catch {
      answered = false;
    }
    if (answered) {
      // Answering is necessary but NOT sufficient. The runtime's watchdog polls
      // its recorded parent and exits a few seconds after that parent dies, so a
      // runtime whose owner is already gone is answering right now and doomed
      // regardless — reusing it hands the caller a connection that drops
      // moments later, with no way to tell why. Only adopt a runtime whose
      // owner is this process or still alive.
      const ownerAlive = record.parentPid === process.pid || isAlive(record.parentPid);
      if (ownerAlive) {
        logger(`ade sdk: reusing the runtime already listening on ${socketPath} (pid ${record.pid})`);
        return { action: "reused", pid: record.pid };
      }
      logger(
        `ade sdk: the runtime on ${socketPath} (pid ${record.pid}) is answering but its owner ` +
          `(pid ${record.parentPid}) is gone, so its watchdog is about to end it; reclaiming instead of adopting`,
      );
    }
  }

  // LAST AND STRONGEST CORROBORATION, immediately before the first signal.
  //
  // Everything above proves the RECORD is ours. None of it proves the PID still
  // is. The dangerous sequence: host is SIGKILLed, so the pidfile is never
  // removed; the orphan is reaped by the engine watchdog; days pass; the OS
  // recycles that pid to the user's editor. Endpoint matches (it is our own
  // home), the process is alive, and nothing answers the socket — every check
  // above passes and we SIGTERM, then SIGKILL, an innocent process. Silently.
  //
  // A process that started before our record was written cannot be the process
  // our record describes. If the start time cannot be read at all we decline to
  // kill: an unverified pid stays alive, because a leaked runtime is recoverable
  // and killing the wrong process is not.
  const startedAt = Date.parse(record.startedAt);
  const processStart = await readProcessStart(record.pid, options.processStartedAt);
  if (!processStart) {
    return {
      action: "left",
      pid: record.pid,
      reason: "could not read the process start time to confirm the pid was not recycled",
    };
  }
  if (Number.isFinite(startedAt) && processStart.getTime() < startedAt - START_TIME_TOLERANCE_MS) {
    await removeRuntimePidfile(home);
    return {
      action: "left",
      pid: record.pid,
      reason: `pid ${record.pid} predates the pidfile (started ${processStart.toISOString()}, recorded ${record.startedAt}) — it was recycled to another process`,
    };
  }

  logger(
    `ade sdk: reclaiming a stale ADE runtime for this home (pid ${record.pid}, ${socketPath})`,
  );
  try {
    kill(record.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") {
      await removeRuntimePidfile(home);
      return { action: "none", reason: "recorded process exited before signalling" };
    }
    // EPERM: it exists but is not ours. Never escalate to SIGKILL on a process
    // we have just been told we do not own.
    return {
      action: "left",
      pid: record.pid,
      reason: `cannot signal the recorded process: ${errorMessage(error)}`,
    };
  }

  const deadline = Date.now() + Math.max(0, terminateGraceMs);
  while (Date.now() < deadline) {
    if (!isAlive(record.pid)) {
      await removeRuntimePidfile(home);
      return { action: "killed", pid: record.pid };
    }
    await sleep(50);
  }

  try {
    kill(record.pid, "SIGKILL");
  } catch {
    // Raced us to exit; the outcome below is the same either way.
  }
  await removeRuntimePidfile(home);
  return { action: "killed", pid: record.pid };
}

async function readProcessStart(
  pid: number,
  override?: (pid: number) => Promise<Date | null>,
): Promise<Date | null> {
  if (override) {
    try {
      return await override(pid);
    } catch {
      return null;
    }
  }
  return await defaultProcessStartedAt(pid);
}

/**
 * When the OS says a process started. Returns null on any doubt — the caller
 * treats null as "do not kill".
 */
export async function defaultProcessStartedAt(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<Date | null> {
  try {
    if (platform === "win32") {
      // CIM avoids the deprecated wmic. Round-trips as a sortable string so no
      // locale parsing is involved.
      //
      // Resolution throws rather than falling back to PATH, and the catch below
      // turns that into `null` — "could not read the start time", which the
      // caller treats as "do not kill". An environment that can hide System32
      // must not also get to nominate the process we corroborate against.
      const { stdout } = await execFileAsync(
        resolveTrustedWindowsTool("powershell"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { timeout: 10_000, windowsHide: true },
      );
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? new Date(parsed) : null;
    }
    // `etime` is elapsed wall time, which sidesteps the locale-dependent
    // formatting of `lstart`. Format: [[dd-]hh:]mm:ss
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "etime="], {
      timeout: 10_000,
    });
    const elapsedMs = parseElapsedTime(stdout.trim());
    return elapsedMs == null ? null : new Date(Date.now() - elapsedMs);
  } catch {
    // No such process, ps unavailable, or output we do not understand.
    return null;
  }
}

/** Parses `ps -o etime=` ([[dd-]hh:]mm:ss) into milliseconds. */
export function parseElapsedTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days ?? 0) * 86_400 +
      Number(hours ?? 0) * 3_600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
