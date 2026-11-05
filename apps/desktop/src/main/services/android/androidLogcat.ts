import type { AndroidLogLevel, AndroidLogLine } from "../../../shared/types/androidEmulator";

/*
 * Logcat for the lane's emulator: the argument list and the line parser.
 *
 * `ade android log` makes one bounded read (`logcat -d`). P2's Logs drawer
 * streams the same lines: it spawns `adb logcat` with `logcatArgs(…, {
 * follow: true })` (`spawnAdb`) and feeds each line to `parseLogcatLine`. So
 * the read and the stream filter and parse in one way.
 *
 * Every read uses `-v epoch`: each line starts with epoch seconds and
 * milliseconds, which is also the cursor format `-t` takes back. So a reader
 * passes the last line's time as `since` and gets only newer lines, with no
 * clock or time-zone guess on the host.
 *
 * Pure. Node built-ins and relative imports only, so it runs under `tsx`.
 */

const LEVEL_LETTERS: Record<AndroidLogLevel, AndroidLogLine["level"]> = {
  verbose: "V",
  debug: "D",
  info: "I",
  warn: "W",
  error: "E",
  fatal: "F",
};

/** A `since` cursor: epoch seconds with up to nine decimals (`1730000000.123`). */
export function isLogcatCursor(value: string): boolean {
  return /^\d{9,11}(\.\d{1,9})?$/u.test(value.trim());
}

/**
 * The logcat arguments (after `adb -s <serial>`) for one read or stream.
 * `pid` narrows to one process (`--pid`); `uid` to one app's processes
 * (`--uid`, Android 11 and later), which also catches lines from a process
 * that already died, such as a crash.
 */
export function logcatArgs(options: {
  level?: AndroidLogLevel | null;
  since?: string | null;
  pid?: number | null;
  uid?: number | null;
  /** Stream new lines instead of dumping the buffer and exiting. */
  follow?: boolean;
  /** P2 crash pin: read the crash buffer (`-b crash`) instead of the main ones. */
  crashBuffer?: boolean;
}): string[] {
  const args = ["logcat", "-v", "epoch"];
  if (options.crashBuffer) args.push("-b", "crash");
  if (!options.follow) args.push("-d");
  if (options.since) {
    // `-t <time>` implies `-d`; `-T <time>` keeps following.
    args.push(options.follow ? "-T" : "-t", options.since.trim());
  }
  if (typeof options.pid === "number" && options.pid > 0) args.push(`--pid=${options.pid}`);
  else if (typeof options.uid === "number" && options.uid >= 0) args.push(`--uid=${options.uid}`);
  args.push(`*:${LEVEL_LETTERS[options.level ?? "verbose"]}`);
  return args;
}

/**
 * One `-v epoch` line, or null for anything else (the `--------- beginning of
 * main` dividers, a wrapped continuation):
 * `  1730000000.123  1234  1250 I ActivityManager: Start proc …`.
 */
export function parseLogcatLine(line: string): AndroidLogLine | null {
  const match = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:\s?(.*)$/u.exec(line);
  if (!match) return null;
  return {
    time: match[1]!,
    pid: Number(match[2]),
    tid: Number(match[3]),
    level: match[4] as AndroidLogLine["level"],
    tag: match[5]!,
    message: match[6]!,
  };
}

/**
 * Every line of a dump, keeping only `pids` when given (a package with several
 * processes), and only lines after `since`: logcat's `-t <time>` includes the
 * line at that exact time, which the caller already has.
 */
export function parseLogcatDump(
  text: string,
  options: { pids?: readonly number[] | null; since?: string | null } = {},
): AndroidLogLine[] {
  const pids = options.pids?.length ? new Set(options.pids) : null;
  const since = options.since && isLogcatCursor(options.since) ? Number(options.since) : null;
  const out: AndroidLogLine[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = parseLogcatLine(raw);
    if (!line) continue;
    if (pids && !pids.has(line.pid)) continue;
    if (since !== null && Number(line.time) <= since) continue;
    out.push(line);
  }
  return out;
}

/** The pids `pidof` printed (space separated); empty when the app does not run. */
export function parsePidof(text: string): number[] {
  return text
    .trim()
    .split(/\s+/u)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** The uid of `pm list packages -U <package>` (`package:com.example uid:10123`), or null. */
export function parsePackageUid(text: string, packageName: string): number | null {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^package:(\S+)\s+uid:(\d+)/u.exec(line.trim());
    if (match && match[1] === packageName) return Number(match[2]);
  }
  return null;
}
