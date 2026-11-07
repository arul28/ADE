import { execFile, execFileSync } from "node:child_process";

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
