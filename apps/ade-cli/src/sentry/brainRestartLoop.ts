/**
 * One Sentry issue when this machine's brain keeps restarting for no reason
 * ADE knows about, and nothing when it restarts for one.
 *
 * The brain watches itself, so a loop is reported with or without a desktop
 * window open (a machine driven only from a phone has none). Every brain
 * records its start in `runtime/brain-starts.json` and, when it stops in an
 * orderly way (an update, the restart button, a shutdown request), marks that
 * start stopped. A start counts toward a loop when the brain before it died
 * without that mark, was the same build, and is gone; or when the build goes
 * back to one an earlier brain in the window already left (two installs
 * replacing each other, 2026-10-19). An update replacing the brain counts
 * for nothing. The report carries the service's state and logs
 * (`brainServiceDiagnostics.ts`) like every brain report.
 *
 * Kept from spamming Sentry by construction:
 *   - a loop is at least `RESTART_LOOP_THRESHOLD` counted starts within
 *     `RESTART_LOOP_WINDOW_MS`;
 *   - a loop is one report, sent by the first brain that stays up for
 *     `LOOP_QUIET_MS`, or by whichever brain is up `LOOP_REPORT_MAX_DELAY_MS`
 *     after the loop was found, so its later restarts are in that report;
 *   - a machine reports at most once a day, recorded on disk in
 *     `runtime/sentry-brain-restart-loop.json`;
 *   - every report has one fingerprint per platform: one issue in Sentry,
 *     with a count of the machines it happened on.
 */
import fs from "node:fs";
import path from "node:path";
import { captureProblem, flushSentry, isSentryActive } from "../../../desktop/src/shared/sentry/capture";
import { writeJsonAtomic } from "../services/runtime/atomicJson";
import { isProcessAlive } from "./brainServiceDiagnostics";

export const RESTART_LOOP_THRESHOLD = 3;
export const RESTART_LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_QUIET_MS = 2 * 60_000;
const LOOP_REPORT_MAX_DELAY_MS = 5 * 60_000;
export const RESTART_LOOP_REPORT_COOLDOWN_MS = 24 * 60 * 60_000;
const STARTS_KEPT = 20;
const REPORTED_STARTS_LIMIT = 20;

export const BRAIN_STARTS_FILE = "brain-starts.json";
export const RESTART_LOOP_REPORT_FILE = "sentry-brain-restart-loop.json";

export type BrainStart = {
  pid: number;
  at: string;
  /** Version and bundle identity; a different value is a different build. */
  build: string | null;
  stoppedAt?: string;
  /** Counts toward a loop (see the file comment). */
  counted: boolean;
  buildFlipFlop: boolean;
};

type BrainStartsFile = { starts: BrainStart[]; loopFoundAt?: string | null };

export type BrainRestartLoopReport = { foundAt: string; starts: BrainStart[] };

export type BrainRestartLoopDeps = {
  runtimeDir: string;
  build: string | null;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  report?: (loop: BrainRestartLoopReport) => void;
};

/** This brain's own start, for `markBrainStoppedCleanly`. */
let current: { runtimeDir: string; pid: number; now: () => number; at: string } | null = null;

/**
 * Records this brain's start and, when it completes a loop, schedules the
 * report. Does nothing where Sentry is off (source checkouts, tests, opted-out
 * machines), so no file is written there either.
 */
export function startBrainRestartLoopWatch(deps: BrainRestartLoopDeps): void {
  if (!isSentryActive()) return;
  const resolved = {
    runtimeDir: deps.runtimeDir,
    build: deps.build,
    pid: deps.pid ?? process.pid,
    now: deps.now ?? Date.now,
    isAlive: deps.isAlive ?? isProcessAlive,
    report: deps.report,
  };
  const nowMs = resolved.now();
  const at = new Date(nowMs).toISOString();
  current = { runtimeDir: resolved.runtimeDir, pid: resolved.pid, now: resolved.now, at };
  const startsPath = path.join(resolved.runtimeDir, BRAIN_STARTS_FILE);
  const state = readStartsFile(startsPath);
  const inWindow = (start: BrainStart): boolean => nowMs - Date.parse(start.at) <= RESTART_LOOP_WINDOW_MS;
  const previous = state.starts[state.starts.length - 1];
  const buildFlipFlop = Boolean(
    resolved.build
      && previous
      && previous.build !== resolved.build
      && state.starts.slice(0, -1).some((start) => inWindow(start) && start.build === resolved.build),
  );
  const previousCrashed = Boolean(
    previous
      && !previous.stoppedAt
      && previous.build === resolved.build
      && previous.pid !== resolved.pid
      && !resolved.isAlive(previous.pid),
  );
  const counted = Boolean(previous && inWindow(previous) && (buildFlipFlop || previousCrashed));
  state.starts = [...state.starts, { pid: resolved.pid, at, build: resolved.build, counted, buildFlipFlop }].slice(-STARTS_KEPT);

  let loopFoundAtMs = state.loopFoundAt ? Date.parse(state.loopFoundAt) : Number.NaN;
  if (!(nowMs - loopFoundAtMs <= RESTART_LOOP_WINDOW_MS + LOOP_REPORT_MAX_DELAY_MS)) loopFoundAtMs = Number.NaN;
  if (
    Number.isNaN(loopFoundAtMs)
    && state.starts.filter((start) => start.counted && inWindow(start)).length >= RESTART_LOOP_THRESHOLD
    && !reportedRecently(resolved.runtimeDir, nowMs)
  ) {
    loopFoundAtMs = nowMs;
  }
  state.loopFoundAt = Number.isNaN(loopFoundAtMs) ? null : new Date(loopFoundAtMs).toISOString();
  writeStartsFile(startsPath, state);
  if (Number.isNaN(loopFoundAtMs)) return;

  // This brain sends the report if it lives long enough; if it dies first,
  // the next one finds `loopFoundAt` and takes over.
  const delayMs = Math.max(0, Math.min(LOOP_QUIET_MS, loopFoundAtMs + LOOP_REPORT_MAX_DELAY_MS - nowMs));
  const timer = setTimeout(() => sendLoopReport(resolved), delayMs);
  timer.unref?.();
}

/** This brain is stopping in an orderly way: its start does not count as a crash for the next one. */
export function markBrainStoppedCleanly(): void {
  if (!current) return;
  const { runtimeDir, pid, now, at } = current;
  current = null;
  const startsPath = path.join(runtimeDir, BRAIN_STARTS_FILE);
  const state = readStartsFile(startsPath);
  const own = state.starts.find((start) => start.pid === pid && start.at === at);
  if (!own) return;
  own.stoppedAt = new Date(now()).toISOString();
  writeStartsFile(startsPath, state);
}

function sendLoopReport(deps: { runtimeDir: string; now: () => number; report?: (loop: BrainRestartLoopReport) => void }): void {
  const nowMs = deps.now();
  const startsPath = path.join(deps.runtimeDir, BRAIN_STARTS_FILE);
  const state = readStartsFile(startsPath);
  if (!state.loopFoundAt) return;
  const foundAt = state.loopFoundAt;
  state.loopFoundAt = null;
  writeStartsFile(startsPath, state);
  // Another brain on this machine may have sent it meanwhile.
  if (reportedRecently(deps.runtimeDir, nowMs)) return;
  // Recorded before the report goes, so a report that throws cannot repeat.
  writeReportedAt(deps.runtimeDir, nowMs);
  const since = Date.parse(foundAt) - RESTART_LOOP_WINDOW_MS;
  const starts = state.starts.filter((start) => Date.parse(start.at) >= since).slice(-REPORTED_STARTS_LIMIT);
  try {
    (deps.report ?? reportBrainRestartLoop)({ foundAt, starts });
  } catch {
    // Reporting is best effort.
  }
}

/** The issue. Its contexts and files come from the diagnostics every brain report carries. */
function reportBrainRestartLoop(loop: BrainRestartLoopReport): void {
  const counted = loop.starts.filter((start) => start.counted);
  captureProblem("The brain kept restarting", {
    level: "warning",
    fingerprint: ["brain", "restart_loop", process.platform],
    tags: { "brain.restart_loop.flip_flop": counted.some((start) => start.buildFlipFlop) },
    extra: { restartCount: counted.length, foundAt: loop.foundAt, starts: loop.starts },
  });
  // A brain in a loop may not live long enough for the SDK's own send.
  void flushSentry(2_000);
}

function readStartsFile(filePath: string): BrainStartsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BrainStartsFile>;
    const starts = Array.isArray(parsed.starts)
      ? parsed.starts.filter((start): start is BrainStart =>
        Boolean(start) && typeof start.pid === "number" && typeof start.at === "string" && Number.isFinite(Date.parse(start.at)))
      : [];
    return { starts, loopFoundAt: typeof parsed.loopFoundAt === "string" ? parsed.loopFoundAt : null };
  } catch {
    return { starts: [] };
  }
}

function writeStartsFile(filePath: string, state: BrainStartsFile): void {
  try {
    writeJsonAtomic(filePath, state, `${process.pid}`);
  } catch {
    // Without the record a loop goes unreported; the brain itself is unaffected.
  }
}

function reportedRecently(runtimeDir: string, nowMs: number): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeDir, RESTART_LOOP_REPORT_FILE), "utf8")) as { lastReportedAt?: unknown };
    const atMs = typeof parsed.lastReportedAt === "string" ? Date.parse(parsed.lastReportedAt) : Number.NaN;
    return Number.isFinite(atMs) && nowMs - atMs < RESTART_LOOP_REPORT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function writeReportedAt(runtimeDir: string, nowMs: number): void {
  try {
    writeJsonAtomic(path.join(runtimeDir, RESTART_LOOP_REPORT_FILE), { lastReportedAt: new Date(nowMs).toISOString() }, `${process.pid}`);
  } catch {
    // Without the file the next loop may report again a day early; never worse.
  }
}
