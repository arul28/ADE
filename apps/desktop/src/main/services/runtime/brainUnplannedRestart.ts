import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RestartCause } from "../../../shared/restartCause";
import { captureError } from "../../../shared/sentry/capture";
import { sanitizeUpdateRequestedBy, type UpdateRequestedBy } from "../../../shared/types/remoteRuntime";
import { computerBootedAtMs } from "../processes/processStartTime";
import { writeTextAtomic } from "../shared/utils";
import { deriveBrainRestartCause, type BrainRestartCauseFacts, type BrainStartFacts } from "./brainRestartCause";
import type { BrainStopIntent } from "./liveTurnProjects";

/**
 * Whether this brain started because the one before it on the same endpoint
 * stopped without an orderly stop (a crash, `kill -9`, an out-of-memory kill)
 * and the service manager (launchd, systemd, the Windows service) started it
 * again. The window shows one banner for it (`BrainRestartNotice`).
 *
 * `runtime/brain-run/<endpoint>.json` holds the running brain's pid, start
 * time and build. An orderly stop (an update, the restart button, a shutdown
 * request, the machine shutting down) marks it stopped; so does another ADE
 * process that forces a brain down on purpose (`markBrainRunStoppedBy`, from
 * `markBrainStoppedBy`). The next start reads it before it writes its own.
 * The previous brain stopped unplanned when its record is not marked, its pid
 * is gone, it started after this computer booted (a reboot is not a crash),
 * and it ran the same build (an update replaces the build).
 *
 * Unlike `brain-starts.json` (the restart-loop report), this record does not
 * depend on Sentry, so a machine that opted out of crash reports still gets
 * the banner. One file per endpoint, so a dev brain on its own socket never
 * reads the installed brain's record.
 *
 * This module also keeps `update-request.json`, the remote update a brain
 * accepted, so the next start can name who asked (`writeBrainUpdateRequest`).
 *
 * The holder lives on `globalThis`: the chat service is bundled more than once
 * (the brain and `bootstrap`), and each copy must count into the same fact.
 */
const RECORD_DIR = "brain-run";
/** Continuations counted after this are lazy recoveries, not this restart's. */
const COUNT_WINDOW_MS = 10 * 60_000;

export type BrainUnplannedRestart = {
  /** This brain's start: when the service came back. */
  ts: string;
  previousPid: number;
  /** Chats this brain told to continue after the restart. */
  chats: number;
  /** Agent CLI sessions this brain reopened after the restart. */
  cliSessions: number;
};

type BrainRunRecord = {
  pid: number;
  startedAt: string;
  build: string | null;
  stoppedAt?: string;
  stoppedBy?: string;
  /** The intent of an orderly stop (`noteBrainStopIntent`); absent on older records. */
  stopIntent?: BrainStopIntent;
};

type OwnRun = { filePath: string; pid: number; startedAt: string };

type Holder = {
  own: OwnRun | null;
  /** This brain's run after `markBrainRunStoppedCleanly`, for `addBrainRunStopIntent`. */
  stopped: OwnRun | null;
  restart: BrainUnplannedRestart | null;
  /** Why the previous brain on this endpoint ended (`brainRestartCause.ts`). */
  cause: RestartCause | null;
};

const HOLDER_KEY = Symbol.for("ade.brainUnplannedRestart");

function holder(): Holder {
  const scope = globalThis as { [HOLDER_KEY]?: Holder };
  let value = scope[HOLDER_KEY];
  if (!value) {
    value = { own: null, stopped: null, restart: null, cause: null };
    scope[HOLDER_KEY] = value;
  }
  return value;
}

export function brainRunEndpointKey(socketPath: string): string {
  return createHash("sha256").update(path.resolve(socketPath)).digest("hex").slice(0, 16);
}

function recordPath(runtimeDir: string, socketPath: string): string {
  return path.join(runtimeDir, RECORD_DIR, `${brainRunEndpointKey(socketPath)}.json`);
}

function isBrainRunRecord(value: unknown): value is BrainRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && typeof record.startedAt === "string"
    && Number.isFinite(Date.parse(record.startedAt))
    && (typeof record.build === "string" || record.build === null)
    && (record.stoppedAt === undefined || typeof record.stoppedAt === "string");
}

function readRecord(filePath: string): BrainRunRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isBrainRunRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(filePath: string, record: BrainRunRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(record));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * `kill(pid, 0)` sends nothing; the same on macOS, Linux and Windows. Only
 * ESRCH proves the process is gone: EPERM means it runs as another user, and
 * any other error is no proof, so its files stay with it.
 */
export function pidRuns(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Records this brain's start and answers whether the previous brain on the
 * endpoint stopped unplanned. Call once, after the brain owns its endpoint and
 * before anything is resumed. Never throws: without the record the banner is
 * simply not shown.
 */
export function recordBrainRunStart(args: {
  runtimeDir: string;
  socketPath: string;
  build: string | null;
  /**
   * False for a brain another process owns (an app started it): it reads the
   * previous record and marks it taken, but leaves no record of its own.
   */
  writeOwnRecord?: boolean;
  /** What this start read before anything rewrote it, to name why the previous brain ended (`brainRestartCause()`). */
  causeFacts?: BrainStartFacts;
  nowMs?: number;
}): BrainUnplannedRestart | null {
  const state = holder();
  const nowMs = args.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const filePath = recordPath(args.runtimeDir, args.socketPath);
  let restart: BrainUnplannedRestart | null = null;
  let cause: RestartCause | null = null;
  try {
    const previous = readRecord(filePath);
    const bootMs = computerBootedAtMs(nowMs);
    // A record with this brain's own pid from before the boot is another run:
    // the OS gave the pid out again.
    const previousIsOtherRun = previous != null
      && (previous.pid !== process.pid || Date.parse(previous.startedAt) < bootMs);
    if (previous && previousIsOtherRun && args.causeFacts) {
      const heartbeat = args.causeFacts.lastHeartbeat;
      cause = deriveBrainRestartCause({
        nowMs,
        bootMs,
        currentBuild: args.build,
        currentVersion: args.causeFacts.currentVersion,
        previous: {
          pid: previous.pid,
          startedAtMs: Date.parse(previous.startedAt),
          build: previous.build,
          stoppedAtMs: previous.stoppedAt ? Date.parse(previous.stoppedAt) : null,
          stoppedBy: previous.stoppedBy ?? null,
          stopIntent: previous.stopIntent === "accepted_update" || previous.stopIntent === "stop_for_good"
            ? previous.stopIntent
            : null,
        },
        lastHeartbeatMs: heartbeat && heartbeat.pid === previous.pid ? heartbeat.ts : null,
        wedge: args.causeFacts.wedge,
        memoryPressure: args.causeFacts.memoryPressure,
        updateRequest: args.causeFacts.updateRequest,
      });
    }
    if (
      previous
      && !previous.stoppedAt
      && previous.pid !== process.pid
      && Date.parse(previous.startedAt) >= bootMs
      && previous.build === args.build
      && !pidRuns(previous.pid)
    ) {
      restart = { ts: startedAt, previousPid: previous.pid, chats: 0, cliSessions: 0 };
    }
    if (args.writeOwnRecord === false) {
      // Taken: the next start must not report the same crash again.
      if (previous && !previous.stoppedAt && previous.pid !== process.pid && !pidRuns(previous.pid)) {
        writeRecord(filePath, { ...previous, stoppedAt: startedAt, stoppedBy: "next_brain_started" });
      }
    } else {
      writeRecord(filePath, { pid: process.pid, startedAt, build: args.build });
      state.own = { filePath, pid: process.pid, startedAt };
    }
  } catch (error) {
    process.stderr.write(`ADE brain could not save its run record: ${error instanceof Error ? error.message : String(error)}\n`);
    captureError(error, {
      level: "warning",
      tags: { area: "brain_restart" },
      fingerprint: ["brain_restart", "run_record_write_failed"],
    });
  }
  state.restart = restart;
  state.cause = cause;
  return restart;
}

/**
 * This brain stops in an orderly way: the next start is not an unplanned
 * restart. One small write, first in the stop, so a kill later in the stop
 * still leaves a clean-stop record.
 */
export function markBrainRunStoppedCleanly(by?: string): void {
  const state = holder();
  const own = state.own;
  if (!own) return;
  state.own = null;
  try {
    const record = readRecord(own.filePath);
    if (!record || record.pid !== own.pid || record.startedAt !== own.startedAt || record.stoppedAt) return;
    writeRecord(own.filePath, {
      ...record,
      stoppedAt: new Date().toISOString(),
      ...(by ? { stoppedBy: by } : {}),
    });
    state.stopped = own;
  } catch (error) {
    // The next start then reads a crash; the banner is the only effect.
    captureError(error, {
      level: "warning",
      tags: { area: "brain_restart" },
      fingerprint: ["brain_restart", "run_record_stop_failed"],
    });
  }
}

/**
 * Adds the intent of this brain's stop (`noteBrainStopIntent`) to its run
 * record, which `markBrainRunStoppedCleanly` already marked stopped, so the
 * next start can say an update ended it. A second small write: the stop is
 * recorded even when this one never happens. Never throws.
 */
export function addBrainRunStopIntent(intent: BrainStopIntent | null): void {
  const stopped = holder().stopped;
  if (!intent || !stopped) return;
  try {
    const record = readRecord(stopped.filePath);
    if (!record || record.pid !== stopped.pid || record.startedAt !== stopped.startedAt || !record.stoppedAt) return;
    if (record.stopIntent === intent) return;
    writeRecord(stopped.filePath, { ...record, stopIntent: intent });
  } catch {
    // The next start then names a plain service restart, not the update.
  }
}

/**
 * Another ADE process ended the brain with this pid on purpose (a forced stop,
 * a service reinstall): mark its record stopped, whichever endpoint it served.
 */
export function markBrainRunStoppedBy(pid: number, by: string, runtimeDir: string): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const dir = path.join(runtimeDir, RECORD_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(dir, name);
    const record = readRecord(filePath);
    if (!record || record.pid !== pid || record.stoppedAt) continue;
    try {
      writeRecord(filePath, { ...record, stoppedAt: new Date().toISOString(), stoppedBy: by });
    } catch {
      // Best effort, as for the restart-loop record.
    }
  }
}

/** The unplanned restart this brain started after, or null. A copy. */
export function brainUnplannedRestart(): BrainUnplannedRestart | null {
  const restart = holder().restart;
  return restart ? { ...restart } : null;
}

/**
 * Why the brain before this one on the endpoint ended, decided once at start;
 * null on a first start, or when the start read no facts. A copy.
 */
export function brainRestartCause(): RestartCause | null {
  const cause = holder().cause;
  return cause ? { ...cause } : null;
}

/**
 * A chat continued, or an agent CLI reopened, because of the restart. Ignored
 * when this brain did not start after an unplanned restart, and after the
 * first minutes (a project opened hours later recovers lazily; that is not
 * what the banner reports).
 */
export function noteRestartContinuation(kind: "chat" | "cli", count = 1): void {
  const restart = holder().restart;
  if (!restart || count <= 0) return;
  if (Date.now() - Date.parse(restart.ts) > COUNT_WINDOW_MS) return;
  if (kind === "chat") restart.chats += count;
  else restart.cliSessions += count;
}

const UPDATE_REQUEST_FILE = "update-request.json";

/**
 * This brain accepted a remote `machine.updateAndRestart`: keep who asked, so
 * the next start can name them. One small file in the machine's runtime
 * folder, replaced by each accepted request. Never throws.
 */
export function writeBrainUpdateRequest(
  runtimeDir: string,
  request: { targetVersion: string | null; requestedBy: UpdateRequestedBy | null },
  nowMs = Date.now(),
): void {
  try {
    writeTextAtomic(path.join(runtimeDir, UPDATE_REQUEST_FILE), JSON.stringify({
      version: 1,
      at: new Date(nowMs).toISOString(),
      targetVersion: request.targetVersion,
      requestedBy: request.requestedBy,
    }), { mode: 0o600 });
  } catch {
    // Without it the next start says "an update" and names nobody.
  }
}

/** The last accepted update request on this machine, or null. Never throws. */
export function readBrainUpdateRequest(runtimeDir: string): BrainRestartCauseFacts["updateRequest"] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeDir, UPDATE_REQUEST_FILE), "utf8")) as {
      at?: unknown;
      requestedBy?: unknown;
    };
    const atMs = typeof parsed?.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    if (!Number.isFinite(atMs)) return null;
    return { atMs, requestedBy: sanitizeUpdateRequestedBy(parsed.requestedBy) };
  } catch {
    return null;
  }
}
