import { execFileSync } from "node:child_process";

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
