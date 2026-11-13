/**
 * One Sentry issue when this machine's brain keeps restarting for no reason
 * ADE knows about, and nothing when it restarts for one.
 *
 * The brain watches itself, so a loop is reported with or without a desktop
 * window open (a machine driven only from a phone has none). Every service
 * brain records its start in `runtime/brain-starts.json` and, when it stops in
 * an orderly way (an update, the restart button, a shutdown request), marks
 * that start stopped; a brain another ADE process had to force down (a
 * reinstall, a stop past its grace) is marked by that process instead
 * (`brainStartsFile.ts`), with who did it. A start counts toward a loop when the brain before it
 * died without that mark, was the same build, and is gone; or when the build
 * goes back to one an earlier brain in the window already left (two installs
 * replacing each other, 2026-10-19). An update replacing the brain counts for
 * nothing. The report carries the service's state and logs
 * (`brainServiceDiagnostics.ts`) like every brain report, the desktop
 * app's logs, which say whether the app stopped or replaced the brain, and the
 * brain log on disk, which holds the last lines of the brains that died.
 *
 * Kept from spamming Sentry by construction:
 *   - a loop is at least `RESTART_LOOP_THRESHOLD` counted starts within
 *     `RESTART_LOOP_WINDOW_MS`;
 *   - a loop is one report, sent by the first brain that stays up for
 *     `LOOP_QUIET_MS`, or by whichever brain is up `LOOP_REPORT_MAX_DELAY_MS`
 *     after the loop was found, so its later restarts are in that report;
 *   - a machine reports at most once a day (`lastReportedAt` in the same file);
 *   - every report has one fingerprint per platform: one issue in Sentry,
 *     with a count of the machines it happened on.
 *
 * Every doubt resolves toward no report: two brains writing the file at once
 * can lose a start, a reused pid reads as alive, and a brain the computer
 * killed by restarting is not counted (it started before this boot).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureProblem, flushSentry, isSentryActive } from "../../../desktop/src/shared/sentry/capture";
import { registerSentryDiagnosticAttachment, type DiagnosticEvent } from "../../../desktop/src/shared/sentry/diagnostics";
import { isPidAlive } from "../serviceManager/common";
import { resolveWindowsServicePidPath } from "../serviceManager/installWindows";
import { readWindowsServicePidRecord } from "../serviceManager/windowsSupervisor";
import { BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE } from "../services/runtime/brainLoopWatchdog";
import { brainLogAttachment, desktopLogsAttachment } from "./brainServiceDiagnostics";
import {
  BRAIN_STARTS_FILE,
  readStartsFile,
  writeStartsFile,
  type BrainStart,
  type BrainStartCause,
  type BrainStartsState,
} from "./brainStartsFile";

const RESTART_LOOP_THRESHOLD = 3;
const RESTART_LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_QUIET_MS = 2 * 60_000;
const LOOP_REPORT_MAX_DELAY_MS = 5 * 60_000;
const RESTART_LOOP_REPORT_COOLDOWN_MS = 24 * 60 * 60_000;
const STARTS_KEPT = 20;
/** One issue per platform: the platform is appended. */
const RESTART_LOOP_FINGERPRINT = ["brain", "restart_loop"] as const;

/** This brain's own start, for `markBrainStoppedCleanly`. */
let current: { startsPath: string; pid: number; at: string } | null = null;
/**
 * This start completed a loop (whether or not it was reported already). Kept
 * on the process, not the module: `bootstrap` is also a bundle of its own, and
 * a copy of this module there must read what the brain's start recorded.
 */
const RESTART_LOOP_FLAG = Symbol.for("ade.brainRestartLoop.startInLoop");
type RestartLoopFlagHolder = { [RESTART_LOOP_FLAG]?: boolean };

/**
 * True when this brain's start is one more in a restart loop: at least
 * `RESTART_LOOP_THRESHOLD` counted starts within `RESTART_LOOP_WINDOW_MS`. The
 * brain then reopens nothing by itself after the stop (no agent CLI), so a
 * reopen cannot be what keeps it stopping. False where the watch does not run.
 */
export function brainStartIsInRestartLoop(): boolean {
  return (globalThis as RestartLoopFlagHolder)[RESTART_LOOP_FLAG] === true;
}

/**
 * Records this brain's start and, when it completes a loop, schedules the
 * report. Does nothing where Sentry is off (source checkouts, tests, opted-out
 * machines), so no file is written there either.
 */
export function startBrainRestartLoopWatch(options: { runtimeDir: string; build: string | null }): void {
  if (!isSentryActive()) return;
  const nowMs = Date.now();
  const startsPath = path.join(options.runtimeDir, BRAIN_STARTS_FILE);
  const previousState = readStartsFile(startsPath);
  const { state, loopFoundAtMs } = recordStart(previousState, {
    pid: process.pid,
    build: options.build,
    nowMs,
    cause: readStartCause(options.runtimeDir, previousState.starts.at(-1)),
  });
  (globalThis as RestartLoopFlagHolder)[RESTART_LOOP_FLAG] =
    countedStartsInWindow(state.starts, nowMs) >= RESTART_LOOP_THRESHOLD;
  current = { startsPath, pid: process.pid, at: new Date(nowMs).toISOString() };
  writeStartsFile(startsPath, state);
  if (loopFoundAtMs === null) return;
  registerSentryDiagnosticAttachment("desktop-logs", (event) => (isRestartLoopEvent(event) ? desktopLogsAttachment() : null));
  registerSentryDiagnosticAttachment("brain-log", (event) => (isRestartLoopEvent(event) ? brainLogAttachment() : null));
  // This brain sends the report if it lives long enough; if it dies first,
  // the next one finds `loopFoundAt` and takes over.
  const delayMs = Math.max(0, Math.min(LOOP_QUIET_MS, loopFoundAtMs + LOOP_REPORT_MAX_DELAY_MS - nowMs));
  setTimeout(() => sendLoopReport(startsPath), delayMs).unref();
}

function isRestartLoopEvent(event: DiagnosticEvent): boolean {
  return RESTART_LOOP_FINGERPRINT.every((part, index) => event.fingerprint?.[index] === part);
}

/** This brain is stopping in an orderly way: its start does not count as a crash for the next one. */
export function markBrainStoppedCleanly(): void {
  if (!current) return;
  const { startsPath, pid, at } = current;
  current = null;
  const state = readStartsFile(startsPath);
  const own = state.starts.find((start) => start.pid === pid && start.at === at);
  if (!own) return;
  own.stoppedAt = new Date().toISOString();
  writeStartsFile(startsPath, state);
}

/** The file with this start added, and when the loop waiting for a report was found (null: none). */
function recordStart(
  state: BrainStartsState,
  start: { pid: number; build: string | null; nowMs: number; cause: BrainStartCause },
): { state: BrainStartsState; loopFoundAtMs: number | null } {
  const { nowMs } = start;
  // A start "after" now means the clock went back; it counts for nothing.
  const inWindow = (entry: BrainStart): boolean => {
    const ageMs = nowMs - Date.parse(entry.at);
    return ageMs >= 0 && ageMs <= RESTART_LOOP_WINDOW_MS;
  };
  const previous = state.starts.at(-1);
  const buildFlipFlop = Boolean(
    start.build
      && previous
      && previous.build !== start.build
      && state.starts.slice(0, -1).some((entry) => inWindow(entry) && entry.build === start.build),
  );
  // A restart, sign-out or power cut kills the brain with no orderly stop.
  const bootMs = nowMs - os.uptime() * 1000;
  const previousCrashed = Boolean(
    previous
      && Date.parse(previous.at) >= bootMs
      && !previous.stoppedAt
      && previous.build === start.build
      && previous.pid !== start.pid
      && !isPidAlive(previous.pid),
  );
  const counted = Boolean(previous && inWindow(previous) && (buildFlipFlop || previousCrashed));
  const starts = [
    ...state.starts,
    { pid: start.pid, at: new Date(nowMs).toISOString(), build: start.build, counted, buildFlipFlop, cause: start.cause },
  ].slice(-STARTS_KEPT);

  // A pending loop is kept until some brain sends it, unless it is far older
  // than any brain could have taken to.
  const pendingMs = state.loopFoundAt ? Date.parse(state.loopFoundAt) : Number.NaN;
  let loopFoundAtMs: number | null =
    nowMs - pendingMs <= RESTART_LOOP_WINDOW_MS + LOOP_REPORT_MAX_DELAY_MS ? pendingMs : null;
  if (
    loopFoundAtMs === null
    && countedStartsInWindow(starts, nowMs) >= RESTART_LOOP_THRESHOLD
    && !reportedRecently(state, nowMs)
  ) {
    loopFoundAtMs = nowMs;
  }
  return {
    state: {
      starts,
      loopFoundAt: loopFoundAtMs === null ? null : new Date(loopFoundAtMs).toISOString(),
      lastReportedAt: state.lastReportedAt,
    },
    loopFoundAtMs,
  };
}

/**
 * Who started this brain and what ended the brain before it, as far as the
 * files on disk say. Read before this brain's own watchdog moves the wedge
 * breadcrumb aside. Never throws: a fact it cannot read is null.
 */
function readStartCause(runtimeDir: string, previous: BrainStart | undefined): BrainStartCause {
  const previousAtMs = previous ? Date.parse(previous.at) : Number.NaN;
  // Written after the previous brain started, so it is about that brain.
  const sincePrevious = (at: unknown): boolean =>
    typeof at === "string" && Number.isFinite(previousAtMs) && Date.parse(at) >= previousAtMs;
  const cause: BrainStartCause = {
    startedBy: "other",
    supervisorPid: null,
    supervisorRestartCount: null,
    previousExitCode: null,
    previousWedge: null,
    previousFailureCode: null,
  };
  try {
    if (process.platform === "win32") {
      const record = readWindowsServicePidRecord(resolveWindowsServicePidPath());
      if (record) {
        cause.supervisorPid = record.supervisorPid;
        if (record.supervisorPid === process.ppid) {
          cause.startedBy = "supervisor";
          cause.supervisorRestartCount = record.restartCount;
          cause.previousExitCode = record.lastExitCode;
        }
      }
    } else if (process.env.INVOCATION_ID) {
      cause.startedBy = "systemd";
    } else if (process.platform === "darwin" && process.ppid === 1) {
      cause.startedBy = "launchd";
    }
  } catch {
    // Unknown stays null.
  }
  const wedge = readJsonRecord(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE));
  // The brain's own watchdog names its pid; the Windows supervisor's kill
  // record has no pid, only its time.
  if (wedge && previous && (wedge.pid === previous.pid || (wedge.pid === undefined && sincePrevious(wedge.ts)))) {
    cause.previousWedge = typeof wedge.lastCommand === "string" ? wedge.lastCommand.slice(0, 80) : "unknown";
  }
  const failure = readJsonRecord(path.join(runtimeDir, "last-failure.json"));
  if (failure && typeof failure.code === "string" && sincePrevious(failure.at)) {
    cause.previousFailureCode = failure.code.slice(0, 80);
  }
  return cause;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function countedStartsInWindow(starts: readonly BrainStart[], nowMs: number): number {
  return starts.filter((entry) => {
    const ageMs = nowMs - Date.parse(entry.at);
    return entry.counted && ageMs >= 0 && ageMs <= RESTART_LOOP_WINDOW_MS;
  }).length;
}

function sendLoopReport(startsPath: string): void {
  const nowMs = Date.now();
  const state = readStartsFile(startsPath);
  const foundAt = state.loopFoundAt;
  // Another brain on this machine may have sent it meanwhile.
  if (!foundAt || reportedRecently(state, nowMs)) return;
  // Recorded before the report goes, so a report that throws cannot repeat.
  writeStartsFile(startsPath, { ...state, loopFoundAt: null, lastReportedAt: new Date(nowMs).toISOString() });
  const since = Date.parse(foundAt) - RESTART_LOOP_WINDOW_MS;
  const starts = state.starts.filter((start) => Date.parse(start.at) >= since);
  const counted = starts.filter((start) => start.counted);
  try {
    const supervisorPids = new Set(counted.map((start) => start.cause?.supervisorPid).filter((pid) => pid != null));
    captureProblem("The brain kept restarting", {
      level: "warning",
      fingerprint: [...RESTART_LOOP_FINGERPRINT, process.platform],
      tags: {
        "brain.restart_loop.flip_flop": counted.some((start) => start.buildFlipFlop),
        // What ended most of the counted brains, so the issue groups by cause.
        "brain.restart_loop.cause": mostCommon(counted.map(previousEndCause)),
        // More than one: a reinstall or a second supervisor (ADE-160) started brains in the loop.
        "brain.restart_loop.supervisors": supervisorPids.size,
      },
      // Flat: Sentry keeps three levels of `extra`, so a nested `cause` would arrive as "[Object]".
      extra: { restartCount: counted.length, foundAt, starts: starts.map(flattenStart) },
    });
    // A brain in a loop may not live long enough for the SDK's own send.
    void flushSentry(2_000);
  } catch (error) {
    process.stderr.write(`ADE brain could not report its restart loop: ${errorText(error)}
`);
  }
}

/** What ended the brain before `start`, as one word for the report's tag. */
function previousEndCause(start: BrainStart): string {
  const cause = start.cause;
  if (!cause) return "unknown";
  if (cause.previousWedge) return "wedge";
  if (cause.previousFailureCode) return "startup_failure";
  if (cause.previousExitCode != null) return `exit_${cause.previousExitCode}`;
  return "unknown";
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "unknown";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function flattenStart(start: BrainStart): Record<string, unknown> {
  const { cause, ...rest } = start;
  return { ...rest, ...(cause ?? {}), previousEnd: previousEndCause(start) };
}

function reportedRecently(state: BrainStartsState, nowMs: number): boolean {
  const ageMs = nowMs - (state.lastReportedAt ? Date.parse(state.lastReportedAt) : Number.NaN);
  // A report "after" now means the clock went back; it blocks nothing.
  return ageMs >= 0 && ageMs < RESTART_LOOP_REPORT_COOLDOWN_MS;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
