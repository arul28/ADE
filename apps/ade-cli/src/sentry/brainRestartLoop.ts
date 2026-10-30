/**
 * One Sentry issue when this machine's brain keeps restarting for no reason
 * ADE knows about, and nothing when it restarts for one.
 *
 * The brain watches itself, so a loop is reported with or without a desktop
 * window open (a machine driven only from a phone has none). Every service
 * brain records its start in `runtime/brain-starts.json` and, when it stops in
 * an orderly way (an update, the restart button, a shutdown request), marks
 * that start stopped. A start counts toward a loop when the brain before it
 * died without that mark, was the same build, and is gone; or when the build
 * goes back to one an earlier brain in the window already left (two installs
 * replacing each other, 2026-10-19). An update replacing the brain counts for
 * nothing. The report carries the service's state and logs
 * (`brainServiceDiagnostics.ts`) like every brain report.
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
import { isPidAlive } from "../serviceManager/common";
import { writeJsonAtomic } from "../services/runtime/atomicJson";

const RESTART_LOOP_THRESHOLD = 3;
const RESTART_LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_QUIET_MS = 2 * 60_000;
const LOOP_REPORT_MAX_DELAY_MS = 5 * 60_000;
const RESTART_LOOP_REPORT_COOLDOWN_MS = 24 * 60 * 60_000;
const STARTS_KEPT = 20;
const BRAIN_STARTS_FILE = "brain-starts.json";

type BrainStart = {
  pid: number;
  at: string;
  /** Version and bundle identity; a different value is a different build. */
  build: string | null;
  stoppedAt?: string;
  /** Counts toward a loop (see the file comment). */
  counted: boolean;
  buildFlipFlop: boolean;
};

type BrainStartsState = {
  starts: BrainStart[];
  /** A loop waiting for its report. */
  loopFoundAt: string | null;
  lastReportedAt: string | null;
};

/** This brain's own start, for `markBrainStoppedCleanly`. */
let current: { startsPath: string; pid: number; at: string } | null = null;

/**
 * Records this brain's start and, when it completes a loop, schedules the
 * report. Does nothing where Sentry is off (source checkouts, tests, opted-out
 * machines), so no file is written there either.
 */
export function startBrainRestartLoopWatch(options: { runtimeDir: string; build: string | null }): void {
  if (!isSentryActive()) return;
  const nowMs = Date.now();
  const startsPath = path.join(options.runtimeDir, BRAIN_STARTS_FILE);
  const { state, loopFoundAtMs } = recordStart(readStartsFile(startsPath), {
    pid: process.pid,
    build: options.build,
    nowMs,
  });
  current = { startsPath, pid: process.pid, at: new Date(nowMs).toISOString() };
  writeStartsFile(startsPath, state);
  if (loopFoundAtMs === null) return;
  // This brain sends the report if it lives long enough; if it dies first,
  // the next one finds `loopFoundAt` and takes over.
  const delayMs = Math.max(0, Math.min(LOOP_QUIET_MS, loopFoundAtMs + LOOP_REPORT_MAX_DELAY_MS - nowMs));
  setTimeout(() => sendLoopReport(startsPath), delayMs).unref();
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
  start: { pid: number; build: string | null; nowMs: number },
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
    { pid: start.pid, at: new Date(nowMs).toISOString(), build: start.build, counted, buildFlipFlop },
  ].slice(-STARTS_KEPT);

  // A pending loop is kept until some brain sends it, unless it is far older
  // than any brain could have taken to.
  const pendingMs = state.loopFoundAt ? Date.parse(state.loopFoundAt) : Number.NaN;
  let loopFoundAtMs: number | null =
    nowMs - pendingMs <= RESTART_LOOP_WINDOW_MS + LOOP_REPORT_MAX_DELAY_MS ? pendingMs : null;
  if (
    loopFoundAtMs === null
    && starts.filter((entry) => entry.counted && inWindow(entry)).length >= RESTART_LOOP_THRESHOLD
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
    captureProblem("The brain kept restarting", {
      level: "warning",
      fingerprint: ["brain", "restart_loop", process.platform],
      tags: { "brain.restart_loop.flip_flop": counted.some((start) => start.buildFlipFlop) },
      extra: { restartCount: counted.length, foundAt, starts },
    });
    // A brain in a loop may not live long enough for the SDK's own send.
    void flushSentry(2_000);
  } catch (error) {
    process.stderr.write(`ADE brain could not report its restart loop: ${errorText(error)}
`);
  }
}

function reportedRecently(state: BrainStartsState, nowMs: number): boolean {
  const ageMs = nowMs - (state.lastReportedAt ? Date.parse(state.lastReportedAt) : Number.NaN);
  // A report "after" now means the clock went back; it blocks nothing.
  return ageMs >= 0 && ageMs < RESTART_LOOP_REPORT_COOLDOWN_MS;
}

function readStartsFile(filePath: string): BrainStartsState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const starts = Array.isArray(parsed.starts) ? parsed.starts.filter(isBrainStart) : [];
    return {
      starts,
      loopFoundAt: typeof parsed.loopFoundAt === "string" ? parsed.loopFoundAt : null,
      lastReportedAt: typeof parsed.lastReportedAt === "string" ? parsed.lastReportedAt : null,
    };
  } catch (error) {
    // Absent is the first start on this machine; anything else starts over.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`ADE brain is starting its restart record over: ${errorText(error)}
`);
    }
    return { starts: [], loopFoundAt: null, lastReportedAt: null };
  }
}

function isBrainStart(value: unknown): value is BrainStart {
  if (!value || typeof value !== "object") return false;
  const start = value as Record<string, unknown>;
  return typeof start.pid === "number"
    && typeof start.at === "string"
    && Number.isFinite(Date.parse(start.at))
    && (typeof start.build === "string" || start.build === null)
    && (start.stoppedAt === undefined || typeof start.stoppedAt === "string")
    && typeof start.counted === "boolean"
    && typeof start.buildFlipFlop === "boolean";
}

function writeStartsFile(filePath: string, state: BrainStartsState): void {
  try {
    writeJsonAtomic(filePath, state, `${process.pid}`);
  } catch (error) {
    // Without the record a loop goes unreported; the brain itself is unaffected.
    process.stderr.write(`ADE brain could not save its restart record: ${errorText(error)}
`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
