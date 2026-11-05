import type { ChildProcess } from "node:child_process";
import { ANDROID_CRASH_STACK_MAX_CHARS, type AndroidAppCrash, type AndroidLogLine } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { runAdb, spawnAdb } from "./adb";
import { logcatArgs, parseLogcatDump, parseLogcatLine } from "./androidLogcat";

/*
 * The crash pin's source (plan §5, P2): one `adb logcat -b crash` per booted
 * lane emulator, read as it comes. The crash buffer holds only crash lines
 * (uncaught exceptions from `AndroidRuntime`, native crash dumps from
 * `DEBUG`), so the reader is idle until an app crashes.
 *
 * - The watch starts from the lane status: a lane that reads as booted gets
 *   one, including an emulator a new brain re-adopted. The buffer's old
 *   crashes are skipped (the last line's time is the start cursor).
 * - It ends with the emulator (adb exits when the device goes), on `stop`,
 *   and on dispose. A watch that ended starts again on the next booted read,
 *   at most once per `RETRY_GAP_MS`.
 * - Only the lane's app counts (`isLaneCrash`).
 */

/** No new line of a crash for this long: the crash is complete. */
const CRASH_QUIET_MS = 250;
/** The shortest gap between two watch starts for one lane. */
const RETRY_GAP_MS = 10_000;
/** The most lines one crash keeps. */
const CRASH_MAX_LINES = 160;

/** Packages that are part of Android: never "the lane's app" when ADE installed none. */
function isSystemPackage(name: string): boolean {
  return name === "android" || name === "system_server" || name.startsWith("com.android.") || name.startsWith("com.google.android.");
}

/** Does this crash belong to the lane's app? */
export function isLaneCrash(crash: Pick<AndroidAppCrash, "packageName">, lanePackages: readonly string[]): boolean {
  if (lanePackages.length > 0) return crash.packageName !== null && lanePackages.includes(crash.packageName);
  return crash.packageName !== null && !isSystemPackage(crash.packageName);
}

/** The first line of a crash: `FATAL EXCEPTION` (Java) or the `*** ***` banner (native). */
function crashStart(line: AndroidLogLine): AndroidAppCrash["kind"] | null {
  if (line.tag === "AndroidRuntime" && line.message.startsWith("FATAL EXCEPTION")) return "java";
  if (line.tag === "DEBUG" && /^\*\*\* \*\*\* \*\*\*/u.test(line.message)) return "native";
  return null;
}

/** One crash's lines (one writer: the same tag and pid), as the pin's record. */
export function crashFromLines(lines: readonly AndroidLogLine[]): AndroidAppCrash | null {
  const first = lines[0];
  const kind = first ? crashStart(first) : null;
  if (!first || !kind) return null;
  let packageName: string | null = null;
  let pid: number | null = null;
  let summary = "";
  if (kind === "java") {
    // `Process: com.example.app, PID: 4321`, then the exception line.
    for (const [index, line] of lines.entries()) {
      const process = /^Process:\s*([^,\s]+),\s*PID:\s*(\d+)/u.exec(line.message);
      if (!process) continue;
      packageName = process[1] ?? null;
      pid = Number(process[2]);
      summary = lines[index + 1]?.message.trim() ?? "";
      break;
    }
    if (pid === null) pid = first.pid;
  } else {
    // `pid: 4321, tid: 4321, name: example.app  >>> com.example.app <<<`, then the signal.
    for (const line of lines) {
      const process = /pid:\s*(\d+),.*>>>\s*(\S+)\s*<<</u.exec(line.message);
      if (process && pid === null) {
        pid = Number(process[1]);
        packageName = process[2] ?? null;
        continue;
      }
      if (!summary && /^signal\s+\d+/u.test(line.message.trim())) summary = line.message.trim();
    }
  }
  // A process name can carry a `:service` suffix; the package is before it.
  if (packageName) packageName = packageName.split(":")[0] || null;
  const text = lines.slice(0, CRASH_MAX_LINES).map((line) => line.message).join("\n");
  return {
    id: `${first.time}:${pid ?? first.pid}`,
    packageName,
    pid,
    time: first.time,
    kind,
    summary: summary || (kind === "java" ? "The app stopped with an uncaught exception." : "The app stopped in native code."),
    stack: text.length > ANDROID_CRASH_STACK_MAX_CHARS ? `${text.slice(0, ANDROID_CRASH_STACK_MAX_CHARS)}\n…` : text,
  };
}

/**
 * Splits a stream of crash-buffer lines into crashes. Lines of one crash come
 * from one writer (tag and pid); a new start line or a quiet gap ends it.
 */
export function createCrashAssembler(options: {
  onCrash: (crash: AndroidAppCrash) => void;
  quietMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const quietMs = options.quietMs ?? CRASH_QUIET_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const open = new Map<string, { lines: AndroidLogLine[]; timer: unknown }>();

  const flush = (key: string) => {
    const entry = open.get(key);
    if (!entry) return;
    open.delete(key);
    clearTimer(entry.timer);
    const crash = crashFromLines(entry.lines);
    if (crash) options.onCrash(crash);
  };

  return {
    push(line: AndroidLogLine): void {
      const key = `${line.tag}:${line.pid}`;
      if (crashStart(line)) flush(key);
      const entry = open.get(key);
      if (!entry) {
        // A line that does not start a crash, with no crash open: a fragment. Drop it.
        if (!crashStart(line)) return;
        open.set(key, { lines: [line], timer: setTimer(() => flush(key), quietMs) });
        return;
      }
      if (entry.lines.length < CRASH_MAX_LINES) entry.lines.push(line);
      clearTimer(entry.timer);
      entry.timer = setTimer(() => flush(key), quietMs);
    },
    /** Ends every open crash now (the reader ended). */
    flushAll(): void {
      for (const key of [...open.keys()]) flush(key);
    },
  };
}

type LaneWatch = {
  serial: string;
  child: ChildProcess | null;
  ended: boolean;
};

export function createAndroidCrashWatch(deps: {
  /** The packages ADE installed for the lane (`adeInstalledPackages`). */
  lanePackages: (laneId: string) => readonly string[];
  onCrash: (laneId: string, crash: AndroidAppCrash) => void;
  logger?: Logger | null;
  signal: AbortSignal;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const watches = new Map<string, LaneWatch>();
  const latest = new Map<string, AndroidAppCrash>();
  /** When each lane's watch last started, so a watch that keeps ending does not respawn adb on every read. */
  const lastStart = new Map<string, number>();

  const end = (laneId: string, watch: LaneWatch) => {
    watch.ended = true;
    try {
      watch.child?.kill();
    } catch {
      // Already gone.
    }
    watch.child = null;
    if (watches.get(laneId) === watch) watches.delete(laneId);
  };

  const begin = async (laneId: string, watch: LaneWatch, adbPath: string) => {
    // The buffer's newest line is the start: crashes from before this watch are old news.
    const dump = await runAdb(adbPath, logcatArgs({ crashBuffer: true }), {
      serial: watch.serial,
      timeoutMs: 10_000,
      signal: deps.signal,
      allowFailure: true,
    });
    if (watch.ended) return;
    const since = parseLogcatDump(dump.stdout.toString("utf8")).at(-1)?.time ?? null;
    const assembler = createCrashAssembler({
      onCrash: (crash) => {
        if (watch.ended || (since !== null && Number(crash.time) <= Number(since))) return;
        if (!isLaneCrash(crash, deps.lanePackages(laneId))) return;
        latest.set(laneId, crash);
        deps.logger?.info("android.app_crashed", { laneId, kind: crash.kind, packageName: crash.packageName });
        deps.onCrash(laneId, crash);
      },
    });
    const child = spawnAdb(adbPath, logcatArgs({ crashBuffer: true, follow: true, since }), { serial: watch.serial });
    watch.child = child;
    let rest = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const text = rest + chunk;
      const parts = text.split(/\r?\n/u);
      rest = parts.pop() ?? "";
      for (const raw of parts) {
        const line = parseLogcatLine(raw);
        if (line) assembler.push(line);
      }
    });
    child.stderr?.resume();
    child.once("error", (error) => {
      deps.logger?.warn("android.crash_watch_failed", { laneId, error: getErrorMessage(error) });
      end(laneId, watch);
    });
    child.once("close", () => {
      assembler.flushAll();
      end(laneId, watch);
    });
  };

  return {
    /** The lane reads as booted on `serial`: watch it, once. */
    ensure(laneId: string, target: { serial: string; adbPath: string }): void {
      if (deps.signal.aborted) return;
      const current = watches.get(laneId);
      if (current && current.serial === target.serial) return;
      if (current) end(laneId, current);
      const last = lastStart.get(laneId) ?? 0;
      if (now() - last < RETRY_GAP_MS) return;
      lastStart.set(laneId, now());
      const watch: LaneWatch = { serial: target.serial, child: null, ended: false };
      watches.set(laneId, watch);
      void begin(laneId, watch, target.adbPath).catch((error: unknown) => {
        deps.logger?.warn("android.crash_watch_failed", { laneId, error: getErrorMessage(error) });
        end(laneId, watch);
      });
    },
    /** The lane's last crash while its emulator runs. */
    latest(laneId: string): AndroidAppCrash | null {
      return latest.get(laneId) ?? null;
    },
    /** The emulator stopped or the lane let it go: the watch and the pin end. */
    stop(laneId: string): void {
      const watch = watches.get(laneId);
      if (watch) end(laneId, watch);
      latest.delete(laneId);
      lastStart.delete(laneId);
    },
    dispose(): void {
      for (const [laneId, watch] of [...watches]) end(laneId, watch);
      latest.clear();
      lastStart.clear();
    },
  };
}
