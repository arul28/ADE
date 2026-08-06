import fs from "node:fs";
import path from "node:path";
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
 * How old a heartbeat may get before the brain counts as wedged.
 *
 * Six missed beats. Generous on purpose: a machine waking from sleep, a heavy
 * GC pause, or a laptop under swap pressure can all skip a beat or two, and the
 * penalty for a false positive is a SIGKILL of a live brain with active
 * sessions.
 */
export const BRAIN_HEARTBEAT_STALE_MS = 90_000;

export type BrainHeartbeat = {
  pid: number;
  /** Wall-clock ms of the beat. */
  ts: number;
  /** Monotonically increasing per brain process; only useful for logs. */
  seq: number;
  /** Wall-clock ms at which this brain process started writing beats. */
  startedAt: number;
};

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
  return {
    pid: Math.floor(pid),
    ts: Math.floor(ts),
    seq: Math.floor(seq),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : Math.floor(ts),
  };
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
   * Stale and the writer is alive: a wedge. Kill it so KeepAlive restarts it.
   *
   * Carries the record itself — the kill path needs the writer's `startedAt` to
   * check identity, and only this variant can guarantee a heartbeat was read.
   */
  | { action: "kill"; ageMs: number; pid: number; heartbeat: BrainHeartbeat };

/**
 * Pure staleness decision, so the platform-specific runners share one rule and
 * it can be tested without touching processes.
 */
export function evaluateBrainHeartbeat(args: {
  heartbeat: BrainHeartbeat | null;
  nowMs: number;
  staleAfterMs?: number;
  selfPid?: number;
  pidAlive: (pid: number) => boolean;
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
}): BrainHeartbeatHandle {
  const env = args.env ?? process.env;
  if (env.ADE_DISABLE_BRAIN_HEARTBEAT === "1") return () => {};
  const now = args.now ?? Date.now;
  const pid = args.pid ?? process.pid;
  const intervalMs = Math.max(1_000, args.intervalMs ?? BRAIN_HEARTBEAT_INTERVAL_MS);
  const startedAt = now();
  let seq = 0;
  let warnedOnce = false;
  const beat = (): void => {
    seq += 1;
    try {
      writeBrainHeartbeat(args.runtimeDir, { pid, ts: now(), seq, startedAt });
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
