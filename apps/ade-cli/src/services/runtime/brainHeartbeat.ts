import fs from "node:fs";
import path from "node:path";
import { SUSPEND_GAP_THRESHOLD_MS } from "../power/suspendGapDetector";
import { writeJsonAtomic } from "./atomicJson";

// Re-exported from its old home so existing importers keep working.
export { writeJsonAtomic };

/**
 * External liveness proof for the brain.
 *
 * `brainLoopWatchdog` already watches the event loop from a worker thread, but
 * that watchdog lives INSIDE the process it guards: if the worker never starts,
 * dies, or the whole process is wedged in a way that also stalls the worker's
 * timer, nothing outside the process can tell a wedged brain from a busy one.
 * launchd's `KeepAlive` only reacts to an EXIT, so a brain that hangs while
 * staying alive is invisible to the supervisor -- which is exactly the
 * 2026-08-05 incident: 2h14m of zero output, all remote access dead, and
 * KeepAlive never fired because the process never left.
 *
 * So the brain publishes a heartbeat file that an EXTERNAL checker reads. The
 * file's `ts` only advances if the brain's event loop is actually turning, so a
 * stale file plus a live pid is a wedge by definition.
 */

export const BRAIN_HEARTBEAT_FILE = "heartbeat.json";

/** How often the brain refreshes the heartbeat. */
export const BRAIN_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How old a heartbeat may get before the brain counts as STALE.
 *
 * Six missed beats. Stale is not the same as wedged: a suspended process writes
 * nothing, so sleep produces exactly the same stale file as a wedge. Age alone
 * therefore never authorises a kill. Two further conditions do that, and both
 * live in `evaluateBrainHeartbeat`:
 *
 * - the watcher must have been running itself across the stale window
 *   (`watcherGapMs`), so a machine that slept through the window is excused;
 * - the same beat must have been seen stale by the PREVIOUS check
 *   (`previousStaleBeat`), so one anomalous sample — an App Nap throttle, a
 *   laptop thrashing on swap — costs a delayed kill instead of a live brain.
 */
export const BRAIN_HEARTBEAT_STALE_MS = 90_000;

/**
 * How often the external watcher checks. macOS: the `com.ade.watchdog` launch
 * agent's `StartInterval`. Windows: the supervisor's wait slice, which polls
 * faster; it passes its own value.
 */
export const BRAIN_WATCHER_CHECK_INTERVAL_MS = 60_000;

/**
 * How late the watcher's own run may be before the machine counts as having
 * been suspended.
 *
 * The watcher cannot ask a suspended brain anything, so it measures the one
 * thing it can: itself. A 60-second timer that last ran 12 minutes ago was not
 * running either, and the brain's silence over that window proves nothing.
 */
export function brainWatcherSuspendFloorMs(args: {
  staleAfterMs?: number;
  checkIntervalMs?: number;
}): number {
  const staleAfterMs = args.staleAfterMs ?? BRAIN_HEARTBEAT_STALE_MS;
  const checkIntervalMs = args.checkIntervalMs ?? BRAIN_WATCHER_CHECK_INTERVAL_MS;
  // `*3` here against `brainLoopWatchdog`'s `*4` because the two count
  // different beats. This one counts the watcher's own once-a-minute runs, so
  // three of them is a three-minute gap no timer jitter explains; the loop
  // watchdog counts its 1-second in-process beat, where four is only a floor
  // under a 30-60s stall threshold that dominates it anyway.
  return Math.max(staleAfterMs, checkIntervalMs * 3);
}

export type BrainHeartbeat = {
  pid: number;
  /** Wall-clock ms of the beat. */
  ts: number;
  /** Monotonically increasing per brain process; only useful for logs. */
  seq: number;
  /** Wall-clock ms at which this brain process started writing beats. */
  startedAt: number;
  /**
   * How long this beat was overdue, when it was late enough to mean the whole
   * process was not running. Diagnostics only — a stale file cannot describe
   * the suspension that is still going on — but it puts "this machine sleeps"
   * in front of the next person who reads a report.
   */
  suspendGapMs?: number;
};

/** The identity of one beat, as the watcher remembers it between runs. */
export type BrainHeartbeatSample = { pid: number; ts: number };

export function brainHeartbeatPath(runtimeDir: string): string {
  return path.join(runtimeDir, BRAIN_HEARTBEAT_FILE);
}

export function parseBrainHeartbeat(text: string): BrainHeartbeat | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Partial<BrainHeartbeat>;
  const pid = Number(record.pid);
  const ts = Number(record.ts);
  const seq = Number(record.seq);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (!Number.isFinite(seq) || seq < 0) return null;
  const startedAt = Number(record.startedAt);
  const heartbeat: BrainHeartbeat = {
    pid: Math.floor(pid),
    ts: Math.floor(ts),
    seq: Math.floor(seq),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : Math.floor(ts),
  };
  const suspendGapMs = Number(record.suspendGapMs);
  if (Number.isFinite(suspendGapMs) && suspendGapMs > 0) {
    heartbeat.suspendGapMs = Math.floor(suspendGapMs);
  }
  return heartbeat;
}

export function readBrainHeartbeat(runtimeDir: string): BrainHeartbeat | null {
  try {
    return parseBrainHeartbeat(fs.readFileSync(brainHeartbeatPath(runtimeDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeBrainHeartbeat(runtimeDir: string, heartbeat: BrainHeartbeat): void {
  writeJsonAtomic(brainHeartbeatPath(runtimeDir), heartbeat, `${heartbeat.pid}.${heartbeat.seq}`);
}

export type BrainHeartbeatVerdict =
  /** No readable heartbeat: nothing to judge, and nothing to kill. */
  | { action: "absent" }
  /** Fresh enough. */
  | { action: "healthy"; ageMs: number; pid: number }
  /** The checker is the brain, or the heartbeat is this very process. */
  | { action: "self"; pid: number }
  /** Stale, but the writer already exited -- the supervisor owns the restart. */
  | { action: "already_exited"; ageMs: number; pid: number }
  /**
   * Stale, but the watcher itself was not running across the stale window: the
   * machine was suspended, and a suspended brain writes nothing. Nothing to
   * judge, and nothing to kill.
   */
  | { action: "machine_slept"; ageMs: number; pid: number; watcherGapMs: number }
  /**
   * Stale, alive, and this is the FIRST check to see this beat stale. One
   * sample cannot tell a wedge from a process the OS stopped scheduling, so the
   * caller records the beat and lets the next check decide.
   */
  | { action: "stale_unconfirmed"; ageMs: number; pid: number; heartbeat: BrainHeartbeat }
  /**
   * Stale and the writer is alive: a wedge. Kill it so KeepAlive restarts it.
   *
   * Carries the record itself — the kill path needs the writer's `startedAt` to
   * check identity, and only this variant can guarantee a heartbeat was read.
   */
  | { action: "kill"; ageMs: number; pid: number; heartbeat: BrainHeartbeat };

/**
 * Pure staleness decision, so the platform-specific runners share one rule and
 * it can be tested without touching processes.
 *
 * A kill needs three facts, not one: the beat is stale, the watcher was awake
 * to see it go stale, and a previous check already saw this same beat stale.
 * Both extra facts come from the caller's own memory of its last run, because a
 * suspended brain cannot report anything about the window it was suspended in.
 */
export function evaluateBrainHeartbeat(args: {
  heartbeat: BrainHeartbeat | null;
  nowMs: number;
  staleAfterMs?: number;
  selfPid?: number;
  pidAlive: (pid: number) => boolean;
  /**
   * How long since the watcher's own previous run. `null` (or absent) means
   * "no previous run to compare against", which cannot excuse anything.
   */
  watcherGapMs?: number | null;
  /** The watcher's normal cadence, used to size the suspension floor. */
  checkIntervalMs?: number;
  /** The beat the watcher saw stale on its previous run, if any. */
  previousStaleBeat?: BrainHeartbeatSample | null;
}): BrainHeartbeatVerdict {
  const heartbeat = args.heartbeat;
  if (!heartbeat) return { action: "absent" };
  const selfPid = args.selfPid ?? process.pid;
  if (heartbeat.pid === selfPid) return { action: "self", pid: heartbeat.pid };
  const ageMs = args.nowMs - heartbeat.ts;
  // A beat from the future is a clock step, never a wedge -- however far ahead.
  if (ageMs < 0) return { action: "healthy", ageMs: 0, pid: heartbeat.pid };
  const staleAfterMs = args.staleAfterMs ?? BRAIN_HEARTBEAT_STALE_MS;
  if (ageMs <= staleAfterMs) return { action: "healthy", ageMs, pid: heartbeat.pid };
  if (!args.pidAlive(heartbeat.pid)) {
    return { action: "already_exited", ageMs, pid: heartbeat.pid };
  }
  // The watcher's own lateness is the only sleep evidence that needs nothing
  // from the process under suspicion. A gap that is at least as long as the
  // beat's age explains the whole silence; a brain that went quiet days before
  // a ten-minute nap is not explained by it, and still dies.
  const watcherGapMs = args.watcherGapMs ?? null;
  if (
    watcherGapMs !== null
    && watcherGapMs >= brainWatcherSuspendFloorMs({
      staleAfterMs,
      checkIntervalMs: args.checkIntervalMs,
    })
    && ageMs <= watcherGapMs + staleAfterMs
  ) {
    return { action: "machine_slept", ageMs, pid: heartbeat.pid, watcherGapMs };
  }
  // Second strike. The previous check must have seen THIS beat (same writer,
  // same timestamp) already stale. A brain the OS merely stopped scheduling
  // beats again long before the next check, so it never reaches this branch; a
  // wedged one is still sitting on the same beat, and dies one cadence later
  // than it used to.
  const previous = args.previousStaleBeat ?? null;
  if (!previous || previous.pid !== heartbeat.pid || previous.ts !== heartbeat.ts) {
    return { action: "stale_unconfirmed", ageMs, pid: heartbeat.pid, heartbeat };
  }
  return { action: "kill", ageMs, pid: heartbeat.pid, heartbeat };
}

export type BrainHeartbeatHandle = () => void;

/**
 * Start publishing the heartbeat.
 *
 * The timer is `unref`'d -- the brain's own listeners keep the process alive,
 * and a referenced timer here would keep a CLI that merely imported this module
 * from exiting. It fires on a plain `setInterval`, so it runs while the brain is
 * completely idle: an idle brain is exactly the case a wedge would otherwise
 * hide in.
 */
export function startBrainHeartbeat(args: {
  runtimeDir: string;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
  pid?: number;
  warn?: (event: string, meta: Record<string, unknown>) => void;
  /**
   * Info-level sink. A machine that slept is a normal fact about a laptop, so
   * it must not enter the log at the same level as a failure.
   */
  info?: (event: string, meta: Record<string, unknown>) => void;
}): BrainHeartbeatHandle {
  const env = args.env ?? process.env;
  if (env.ADE_DISABLE_BRAIN_HEARTBEAT === "1") return () => {};
  const now = args.now ?? Date.now;
  const pid = args.pid ?? process.pid;
  const intervalMs = Math.max(1_000, args.intervalMs ?? BRAIN_HEARTBEAT_INTERVAL_MS);
  const startedAt = now();
  let seq = 0;
  let warnedOnce = false;
  // What the previous beat expected the next one to happen at. A beat that
  // arrives minutes late proves this process was not running, which is the same
  // signal `suspendGapDetector` gives the rest of the brain — recorded here so
  // that the first beat after a wake says so on disk.
  let expectedAt: number | null = null;
  const beat = (): void => {
    seq += 1;
    const ts = now();
    const overdueBy = expectedAt === null ? 0 : ts - expectedAt;
    expectedAt = ts + intervalMs;
    const record: BrainHeartbeat = { pid, ts, seq, startedAt };
    if (overdueBy >= SUSPEND_GAP_THRESHOLD_MS) {
      record.suspendGapMs = Math.floor(overdueBy + intervalMs);
      // Falls back to `warn` so the fact survives when no info sink is wired,
      // matching `brainLoopWatchdog`.
      (args.info ?? args.warn)?.("brain.suspend_gap", { source: "heartbeat", gapMs: record.suspendGapMs });
    }
    try {
      writeBrainHeartbeat(args.runtimeDir, record);
    } catch (error) {
      // Report once. A heartbeat that cannot be written degrades to "absent",
      // which the checker treats as "nothing to judge" -- never as a wedge.
      if (!warnedOnce) {
        warnedOnce = true;
        args.warn?.("brain.heartbeat_write_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try { fs.unlinkSync(brainHeartbeatPath(args.runtimeDir)); } catch { /* best effort */ }
  };
}
