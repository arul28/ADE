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

export const BRAIN_STARTS_FILE = "brain-starts.json";

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
  stoppedBy?: string;
  /** Counts toward a loop (see `brainRestartLoop.ts`). */
  counted: boolean;
  buildFlipFlop: boolean;
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
export function markBrainStoppedBy(pid: number, by: string, runtimeDir: string = path.dirname(lastFailurePathForMachine())): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
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
