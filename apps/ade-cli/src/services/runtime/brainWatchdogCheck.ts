import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomicJson";
import { readProcessStartTimeMs } from "../../../../desktop/src/main/services/processes/processStartTime";
import {
  BRAIN_HEARTBEAT_STALE_MS,
  BRAIN_WATCHER_CHECK_INTERVAL_MS,
  type BrainHeartbeat,
  type BrainHeartbeatSample,
  brainHeartbeatPath,
  evaluateBrainHeartbeat,
  readBrainHeartbeat,
} from "./brainHeartbeat";
import {
  BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  type BrainLoopWatchdogBreadcrumb,
} from "./brainLoopWatchdog";

/**
 * The one action an external watchdog is allowed to take.
 *
 * It does NOT restart anything. launchd `KeepAlive` (macOS) and the PowerShell
 * supervisor loop (Windows) already restart a brain that exits; the only thing
 * missing was a way to make a wedged brain exit. So this kills, and lets the
 * supervisor that already owns the lifecycle do the restarting. Anything else
 * would put a second thing in the business of starting brains.
 */
export const BRAIN_WATCHDOG_KILL_COMMAND = "external-watchdog";

export type BrainWatchdogCheckResult = {
  ok: true;
  action:
    | "absent"
    | "healthy"
    | "self"
    | "already_exited"
    | "machine_slept"
    | "stale_unconfirmed"
    | "killed"
    | "kill_failed";
  pid: number | null;
  ageMs: number | null;
  staleAfterMs: number;
  message: string;
};

/**
 * What one check remembers for the next one.
 *
 * The check is a fresh 60-second process, so its only memory is this file. It
 * carries the two facts a single sample cannot supply: WHEN the watcher last
 * ran (a run that is twelve minutes late means the machine slept, and the
 * brain's silence over that window proves nothing), and WHICH beat it last saw
 * stale (so a kill needs the same beat to be stale twice).
 */
export const BRAIN_WATCHDOG_CHECK_RECORD_FILE = "watchdog-check.json";

export type BrainWatchdogCheckRecord = {
  /** Wall-clock ms of the run that wrote this record. */
  ts: number;
  staleBeat: BrainHeartbeatSample | null;
};

export function brainWatchdogCheckRecordPath(runtimeDir: string): string {
  return path.join(runtimeDir, BRAIN_WATCHDOG_CHECK_RECORD_FILE);
}

export function readBrainWatchdogCheckRecord(runtimeDir: string): BrainWatchdogCheckRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(brainWatchdogCheckRecordPath(runtimeDir), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Partial<BrainWatchdogCheckRecord>;
  const ts = Number(record.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const beat = record.staleBeat;
  const beatPid = Number((beat as Partial<BrainHeartbeatSample> | null | undefined)?.pid);
  const beatTs = Number((beat as Partial<BrainHeartbeatSample> | null | undefined)?.ts);
  const staleBeat = Number.isInteger(beatPid) && beatPid > 0 && Number.isFinite(beatTs) && beatTs > 0
    ? { pid: Math.floor(beatPid), ts: Math.floor(beatTs) }
    : null;
  return { ts: Math.floor(ts), staleBeat };
}

export function writeBrainWatchdogCheckRecord(
  runtimeDir: string,
  record: BrainWatchdogCheckRecord,
): void {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(brainWatchdogCheckRecordPath(runtimeDir), record, String(process.pid));
  } catch {
    // A watcher that cannot write its record can never confirm a stale beat
    // twice, so it stops killing. That is the safe direction: an unwritable
    // runtime directory is not evidence that the brain is wedged.
  }
}

export function resolveBrainHeartbeatStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.ADE_BRAIN_HEARTBEAT_STALE_MS?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BRAIN_HEARTBEAT_STALE_MS;
  // Never let a misconfiguration make the watchdog trigger-happy: below the
  // beat interval it would fire on every ordinary gap.
  return Math.max(30_000, parsed);
}

/**
 * How far the OS-reported process start time may sit AFTER the first beat.
 *
 * Zero in theory -- a process cannot beat before it starts -- so this only
 * absorbs `ps` second-granularity rounding and a clock nudge between the two
 * readings. Mirrors the +/-2s window `syncHostSingleton` uses to bind its lock
 * to a process start time.
 */
export const BRAIN_IDENTITY_START_TOLERANCE_MS = 2_000;

/**
 * How far the process start time may sit BEFORE the first beat: the brain's own
 * boot, from `main()` to `startBrainHeartbeat`. Generous (5 minutes) because
 * overshooting only costs a delayed wedge kill, while undershooting would make
 * the watchdog spare a genuinely wedged brain that booted slowly.
 */
export const BRAIN_IDENTITY_MAX_BOOT_MS = 300_000;

/**
 * Whether the live pid is still the process that wrote this heartbeat.
 *
 * Without this the watchdog kills a bare pid. After a crash the heartbeat file
 * names a dead pid, and once the OS recycles that number the watchdog SIGKILLs
 * a completely unrelated process -- every 60s, forever. So a kill requires
 * positive identity: absent, unreadable, or mismatched all mean "not ours".
 */
export function brainProcessIdentityMatches(
  heartbeat: BrainHeartbeat,
  startedAtMs: number | null,
): boolean {
  if (startedAtMs == null) return false;
  const bootMs = heartbeat.startedAt - startedAtMs;
  return bootMs >= -BRAIN_IDENTITY_START_TOLERANCE_MS && bootMs <= BRAIN_IDENTITY_MAX_BOOT_MS;
}

/**
 * `isPidAlive` reports EPERM as alive, which is right for a caller stopping its
 * own child but wrong here: the brain runs as this user, so a pid this process
 * may not signal is by definition not the brain, and treating it as live would
 * feed a foreign pid straight into the kill path.
 */
function brainPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave the same breadcrumb the in-process loop watchdog leaves, so the next
 * brain start promotes it to `last-wedge.json`, logs `brain.recovered_from_wedge`,
 * and the existing `lastWedge` field on `runtime/info` surfaces it to clients.
 * A separate record would mean a second thing to plumb to every surface.
 */
function writeWedgeBreadcrumb(args: {
  runtimeDir: string;
  heartbeat: BrainHeartbeat;
  ageMs: number;
  staleAfterMs: number;
  now: () => number;
}): void {
  const breadcrumb: BrainLoopWatchdogBreadcrumb = {
    lastCommand: BRAIN_WATCHDOG_KILL_COMMAND,
    blockedMs: Math.max(0, Math.floor(args.ageMs)),
    ts: new Date(args.now()).toISOString(),
    thresholdMs: args.staleAfterMs,
    diagnosticReportPath: null,
  };
  try {
    writeJsonAtomic(
      path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE),
      breadcrumb,
      String(args.heartbeat.pid),
    );
  } catch {
    // A breadcrumb is a diagnostic. Failing to leave one must never stop the
    // kill that the breadcrumb is only there to explain.
  }
}

/**
 * One external liveness check. Safe to run on a timer from outside the brain.
 *
 * Deliberately conservative: an absent or unreadable heartbeat means "no
 * judgement available", never "wedged". A stale heartbeat owned by a live pid
 * is a wedge only when the watcher was itself running across the stale window
 * and already saw the same beat stale on its previous run -- a suspended
 * process and a wedged one leave the identical stale file, so one sample from a
 * watcher that may have been suspended too can never authorise a SIGKILL.
 */
export function runBrainWatchdogCheck(args: {
  runtimeDir: string;
  staleAfterMs?: number;
  checkIntervalMs?: number;
  now?: () => number;
  selfPid?: number;
  pidAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  platform?: NodeJS.Platform;
  /** Injectable so tests never have to inspect a real process. */
  /** Live pid's start time in ms; `null` means "could not tell" (no kill). */
  processIdentity?: (pid: number) => number | null;
  readHeartbeat?: (runtimeDir: string) => BrainHeartbeat | null;
  readCheckRecord?: (runtimeDir: string) => BrainWatchdogCheckRecord | null;
  writeCheckRecord?: (runtimeDir: string, record: BrainWatchdogCheckRecord) => void;
  writeBreadcrumb?: (breadcrumbArgs: {
    runtimeDir: string;
    heartbeat: BrainHeartbeat;
    ageMs: number;
    staleAfterMs: number;
    now: () => number;
  }) => void;
}): BrainWatchdogCheckResult {
  const now = args.now ?? Date.now;
  const nowMs = now();
  const staleAfterMs = args.staleAfterMs ?? resolveBrainHeartbeatStaleMs();
  const checkIntervalMs = args.checkIntervalMs ?? BRAIN_WATCHER_CHECK_INTERVAL_MS;
  const heartbeat = (args.readHeartbeat ?? readBrainHeartbeat)(args.runtimeDir);
  const previousRecord = (args.readCheckRecord ?? readBrainWatchdogCheckRecord)(args.runtimeDir);
  const writeCheckRecord = args.writeCheckRecord ?? writeBrainWatchdogCheckRecord;
  // Remember this run before judging anything. Every exit below has to leave the
  // stamp behind, and a `finally` cannot know which beat the verdict wants
  // remembered -- so the record is written here and refined once, at the single
  // point that learns a beat is stale.
  writeCheckRecord(args.runtimeDir, { ts: nowMs, staleBeat: null });
  const verdict = evaluateBrainHeartbeat({
    heartbeat,
    nowMs,
    staleAfterMs,
    selfPid: args.selfPid,
    pidAlive: args.pidAlive ?? brainPidAlive,
    watcherGapMs: previousRecord ? Math.max(0, nowMs - previousRecord.ts) : null,
    checkIntervalMs,
    previousStaleBeat: previousRecord?.staleBeat ?? null,
  });

  if (verdict.action === "absent") {
    return {
      ok: true,
      action: "absent",
      pid: null,
      ageMs: null,
      staleAfterMs,
      message: "No brain heartbeat to check.",
    };
  }
  if (verdict.action === "self") {
    return {
      ok: true,
      action: "self",
      pid: verdict.pid,
      ageMs: null,
      staleAfterMs,
      message: "The heartbeat belongs to this process.",
    };
  }
  if (verdict.action === "healthy") {
    return {
      ok: true,
      action: "healthy",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is alive — last beat ${verdict.ageMs}ms ago.`,
    };
  }
  if (verdict.action === "already_exited") {
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} already exited — the service supervisor owns the restart.`,
    };
  }
  if (verdict.action === "machine_slept") {
    return {
      ok: true,
      action: "machine_slept",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `This check last ran ${verdict.watcherGapMs}ms ago, so the machine was asleep — brain pid ${verdict.pid} was suspended with it, not wedged.`,
    };
  }
  if (verdict.action === "stale_unconfirmed") {
    // Remember the exact beat, so the next run can tell "still the same silence"
    // from "beating again". This is the only place a stale beat is learned.
    writeCheckRecord(args.runtimeDir, {
      ts: nowMs,
      staleBeat: { pid: verdict.heartbeat.pid, ts: verdict.heartbeat.ts },
    });
    return {
      ok: true,
      action: "stale_unconfirmed",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} has not beaten for ${verdict.ageMs}ms — waiting for the next check to confirm before stopping it.`,
    };
  }

  // Stale plus a live pid is only a wedge if that pid is still the process that
  // wrote the beat. On win32 nothing here can establish that -- and nothing has
  // to, because the supervisor loop stops its own wedged child through the
  // handle it already holds -- so this checker never kills there.
  const platform = args.platform ?? process.platform;
  const identity = platform === "win32"
    ? null
    : (args.processIdentity ?? ((pid: number) => readProcessStartTimeMs(pid, platform)))(
      verdict.pid,
    );
  // "Could not read the identity" and "read it, and it is someone else" are
  // different facts. Only the second is evidence, and only evidence may delete
  // the heartbeat -- deleting the beat of a live wedged brain erases the wedge
  // for good, and the next check would find nothing to judge.
  const identityRead = identity != null;
  if (!identityRead) {
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: platform === "win32"
        ? `Brain pid ${verdict.pid} stopped beating — the Windows supervisor owns the restart.`
        : `Brain pid ${verdict.pid} stopped beating, but there is no way to tell whether it is still the brain — left it alone.`,
    };
  }
  if (!brainProcessIdentityMatches(verdict.heartbeat, identity)) {
    // The heartbeat outlived its writer. Remove it: left in place it names a
    // recycled pid forever, and every later check would re-run this same probe
    // against a process that has nothing to do with ADE.
    try { fs.unlinkSync(brainHeartbeatPath(args.runtimeDir)); } catch { /* already gone */ }
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is no longer the brain that wrote this heartbeat — cleared the stale record instead of stopping it.`,
    };
  }

  // Wedged. Breadcrumb first, so the record survives even if the kill races.
  (args.writeBreadcrumb ?? writeWedgeBreadcrumb)({
    runtimeDir: args.runtimeDir,
    heartbeat: verdict.heartbeat,
    ageMs: verdict.ageMs,
    staleAfterMs,
    now,
  });
  const kill = args.kill ?? ((pid: number) => {
    // SIGKILL, not SIGTERM: a process whose event loop is dead cannot run a
    // signal handler, so anything catchable would simply be ignored and leave
    // the brain squatting the socket for another hour.
    process.kill(pid, "SIGKILL");
  });
  try {
    kill(verdict.pid);
  } catch (error) {
    return {
      ok: true,
      action: "kill_failed",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is stuck but could not be stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    ok: true,
    action: "killed",
    pid: verdict.pid,
    ageMs: verdict.ageMs,
    staleAfterMs,
    message: `Brain pid ${verdict.pid} stopped responding for ${verdict.ageMs}ms — stopped it so the service restarts.`,
  };
}
