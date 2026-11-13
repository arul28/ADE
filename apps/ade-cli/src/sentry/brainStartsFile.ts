/**
 * `runtime/brain-starts.json`, the record `brainRestartLoop.ts` keeps of every
 * service brain's start and orderly stop. Its own module, with nothing but the
 * file behind it, so the service manager can mark a brain it stopped without
 * importing the Sentry side (which imports the service manager).
 */
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../services/runtime/atomicJson";
import { lastFailurePathForMachine } from "../../../desktop/src/main/services/runtime/lastFailureStore";
import { markBrainRunStoppedBy } from "../../../desktop/src/main/services/runtime/brainUnplannedRestart";

export const BRAIN_STARTS_FILE = "brain-starts.json";

/** Why another ADE process ended a brain on purpose. */
export type BrainStopper = "forced_stop" | "service_reinstall";

export type BrainStart = {
  pid: number;
  at: string;
  /** Version and bundle identity; a different value is a different build. */
  build: string | null;
  stoppedAt?: string;
  /**
   * Another ADE process ended it on purpose (`markBrainStoppedBy`): a forced
   * stop after a shutdown request, or a service reinstall. Absent when the
   * brain stopped itself or nobody knows.
   */
  stoppedBy?: BrainStopper | string;
  /** Counts toward a loop (see `brainRestartLoop.ts`). */
  counted: boolean;
  buildFlipFlop: boolean;
  /**
   * Who started this brain and what it found about the brain before it.
   * Absent on starts recorded before this field existed.
   */
  cause?: BrainStartCause;
};

/**
 * The facts a start can read about its own start and about the brain before
 * it. A restart-loop report lists them for each start, so the report says
 * what ended each brain, not only that brains died. Every field is null when
 * the start could not read it.
 */
export type BrainStartCause = {
  /** The process that started this brain. */
  startedBy: "supervisor" | "launchd" | "systemd" | "other";
  /** Windows: the supervisor that started this brain. A new pid means a reinstall or a second supervisor. */
  supervisorPid: number | null;
  /** Windows: how many times in a row that supervisor restarted a brain that lived less than a minute. */
  supervisorRestartCount: number | null;
  /**
   * Windows: the exit code of the brain this supervisor ran before. 1 with no
   * last output line is a kill from outside (taskkill or a Node kill), -1 is a
   * .NET kill, and an exit with output is the brain's own failure.
   */
  previousExitCode: number | null;
  /** The previous brain was killed for being wedged; the value is the command it was stuck in ("external-watchdog" for the supervisor's kill). */
  previousWedge: string | null;
  /** The previous brain recorded a startup failure with this code before it ended. */
  previousFailureCode: string | null;
};

export type BrainStartsState = {
  starts: BrainStart[];
  /** A loop waiting for its report. */
  loopFoundAt: string | null;
  lastReportedAt: string | null;
};

/**
 * A brain another ADE process just killed on purpose (`by` says how). A killed
 * brain cannot mark itself, and on Windows every forced stop reads as exit
 * code -1, so the next start counted it as a crash: a reinstall or a forced
 * stop looked like a restart loop (ADE-BRAIN-69). Marks the newest start of
 * `pid` that is not marked yet; a pid with no start here (a supervisor, a
 * brain from before the record) changes nothing.
 */
export function markBrainStoppedBy(
  pid: number,
  by: BrainStopper,
  runtimeDir: string = path.dirname(lastFailurePathForMachine()),
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  // The run record behind the restart banner, which is kept with or without Sentry.
  markBrainRunStoppedBy(pid, by, runtimeDir);
  const startsPath = path.join(runtimeDir, BRAIN_STARTS_FILE);
  if (!fs.existsSync(startsPath)) return;
  const state = readStartsFile(startsPath);
  const own = [...state.starts].reverse().find((start) => start.pid === pid);
  if (!own || own.stoppedAt) return;
  own.stoppedAt = new Date().toISOString();
  own.stoppedBy = by;
  writeStartsFile(startsPath, state);
}

export function readStartsFile(filePath: string): BrainStartsState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const starts = Array.isArray(parsed.starts) ? parsed.starts.filter(isBrainStart).map(withValidCause) : [];
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

const BRAIN_STARTED_BY: ReadonlySet<string> = new Set<BrainStartCause["startedBy"]>(["supervisor", "launchd", "systemd", "other"]);

const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === "number";
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";

function isBrainStartCause(value: unknown): value is BrainStartCause {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cause = value as Record<string, unknown>;
  return typeof cause.startedBy === "string"
    && BRAIN_STARTED_BY.has(cause.startedBy)
    && isNumberOrNull(cause.supervisorPid)
    && isNumberOrNull(cause.supervisorRestartCount)
    && isNumberOrNull(cause.previousExitCode)
    && isStringOrNull(cause.previousWedge)
    && isStringOrNull(cause.previousFailureCode);
}

/** A hand-edited or older file's `cause` that is not one is dropped; the start itself is kept. */
function withValidCause(start: BrainStart): BrainStart {
  if (start.cause === undefined || isBrainStartCause(start.cause)) return start;
  const { cause: _invalid, ...rest } = start;
  return rest;
}

function isBrainStart(value: unknown): value is BrainStart {
  if (!value || typeof value !== "object") return false;
  const start = value as Record<string, unknown>;
  return typeof start.pid === "number"
    && typeof start.at === "string"
    && Number.isFinite(Date.parse(start.at))
    && (typeof start.build === "string" || start.build === null)
    && (start.stoppedAt === undefined || typeof start.stoppedAt === "string")
    && (start.stoppedBy === undefined || typeof start.stoppedBy === "string")
    && typeof start.counted === "boolean"
    && typeof start.buildFlipFlop === "boolean";
}

export function writeStartsFile(filePath: string, state: BrainStartsState): void {
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
