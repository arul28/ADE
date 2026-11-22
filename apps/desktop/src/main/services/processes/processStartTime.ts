import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/** A start time read twice can differ by rounding (`lstart` has whole seconds); a second is generous. */
export const PROCESS_START_TIME_TOLERANCE_MS = 1_000;

/**
 * OS-reported start time of a live pid, in epoch milliseconds, or null when the
 * platform cannot tell.
 *
 * POSIX only: Windows has no `ps`, so every caller there falls back to whatever
 * weaker evidence it has. Callers that identify a process by pid number need
 * this: the OS recycles pid numbers, so "is this pid alive?" is not enough to
 * prove the same process is still running.
 *
 * `lstart` renders in the process locale -- a de_DE or fr_FR host prints
 * "Mi 6 Aug ..." or "mer. 6 août ...", which `Date.parse` rejects -- so the
 * locale is pinned to C. Without that pin the probe returns null on every
 * non-English machine.
 */
export function readProcessStartTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (platform === "win32") return null;
  let raw = "";
  try {
    raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(Math.floor(pid))], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      // A missing pid makes `ps` complain on stderr, which would otherwise land
      // in the launch agent's log once a minute for a process that is gone.
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch {
    // No such process, or `ps` is unavailable. Both mean "no identity".
    return null;
  }
  // `ps` pads the day of month ("Aug  6"); Date.parse rejects the double space.
  const startedAtMs = Date.parse(raw.trim().replace(/\s+/g, " "));
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

/**
 * {@link readProcessStartTimeMs} for several pids in one `ps`, without
 * blocking the event loop: a periodic sweep that checks a handful of
 * processes spawns once, not once per pid. A pid that is gone (or every pid,
 * on Windows) is absent from the answer.
 */
export function readProcessStartTimesMs(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, number>> {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (platform === "win32" || wanted.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "pid=,lstart=", "-p", wanted.join(",")],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
      // `ps` exits 1 when one of the pids is gone; the rest are still printed.
      (_error, stdout) => {
        const times = new Map<number, number>();
        for (const line of String(stdout ?? "").split("\n")) {
          const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
          if (!match) continue;
          const startedAtMs = Date.parse(match[2]!.replace(/\s+/g, " "));
          if (Number.isFinite(startedAtMs)) times.set(Number(match[1]), startedAtMs);
        }
        resolve(times);
      },
    );
  });
}

/**
 * A reader of start times for one pass over many records: it asks the OS
 * once for each pid and keeps the answer (also "cannot tell"). Make a new
 * reader for each pass; an answer must not outlive it.
 */
export function processStartTimeReader(): (pid: number) => number | null {
  const known = new Map<number, number | null>();
  return (pid) => {
    if (!known.has(pid)) known.set(pid, readProcessStartTimeMs(pid));
    return known.get(pid) ?? null;
  };
}

/**
 * When this computer booted, in epoch ms, from `os.uptime()`. With Windows
 * Fast Startup, "Shut down" hibernates the kernel and keeps `os.uptime()`
 * counting, so a restart across it reads as a service restart, not a
 * computer restart.
 */
export function computerBootedAtMs(nowMs = Date.now()): number {
  return nowMs - os.uptime() * 1000;
}

/**
 * A clock step, a coarse file time or a slow write never decides that a
 * record's writer is gone: both rules below need a gap at least this large.
 */
const RECORD_WRITER_GAP_MS = 60_000;

/**
 * The latest time a file was written or renamed into place (epoch ms), or
 * NaN when it cannot be read. A rename keeps `mtime` and moves `ctime`, so a
 * claimed file reads as claimed at its rename.
 */
export function fileRecordTimeMs(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return Math.max(stat.mtimeMs, stat.ctimeMs);
  } catch {
    return Number.NaN;
  }
}

/**
 * A record under this process's own pid is this run's when it was written at
 * or after this process started (60 s gap). An older one is from an earlier
 * process that had the same pid (often the brain before a reboot): its writer
 * is gone. A record time that cannot be read counts as this run's, the safe
 * side.
 */
export function recordIsOwn(writtenAtMs: number): boolean {
  if (!Number.isFinite(writtenAtMs)) return true;
  return writtenAtMs >= Date.now() - process.uptime() * 1000 - RECORD_WRITER_GAP_MS;
}

/**
 * Whether the process that wrote (or last renamed) a record under `pid` at
 * `writtenAtMs` no longer runs. The OS reuses pid numbers, so a running pid
 * alone does not prove the writer still runs:
 *
 * - The pid is this process's own: gone only when the record is from before
 *   this process started (`recordIsOwn`).
 * - The pid does not run (`pidRuns`): gone.
 * - The process that has the pid now started after the record was written:
 *   another process got the pid, so the writer is gone.
 * - Its start time cannot be read (Windows, a failed `ps`): gone only when
 *   this computer booted clearly after the record was written and the record
 *   time is not in the future.
 * - Otherwise, and for a record time that cannot be read, the writer runs.
 *   A live writer never reads as gone.
 *
 * `startTimeOf` reads the start time (one blocking `ps`). A caller that
 * checks many records in one pass gives `processStartTimeReader()`, so that
 * each pid costs one `ps`.
 */
export function recordWriterGone(
  pid: number,
  writtenAtMs: number,
  pidRuns: (pid: number) => boolean,
  nowMs = Date.now(),
  startTimeOf: (pid: number) => number | null = readProcessStartTimeMs,
): boolean {
  if (pid === process.pid) return !recordIsOwn(writtenAtMs);
  if (!pidRuns(pid)) return true;
  if (!Number.isFinite(writtenAtMs)) return false;
  const startedAtMs = startTimeOf(pid);
  if (startedAtMs != null) return startedAtMs - writtenAtMs > RECORD_WRITER_GAP_MS;
  return writtenAtMs <= nowMs && computerBootedAtMs(nowMs) - writtenAtMs > RECORD_WRITER_GAP_MS;
}
