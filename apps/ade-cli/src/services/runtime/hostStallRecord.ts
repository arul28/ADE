import os from "node:os";
import type { SyncHostStall } from "../../../../desktop/src/shared/types/sync";

/**
 * The brain's last freeze, kept so it can tell the devices that lost it.
 *
 * While this machine is frozen, a phone or another desktop cannot tell a
 * frozen brain from a dropped network: both look like silence. Only the brain
 * knows it froze, and it can only say so once it is running again. The loop
 * watchdog records each stall here; the sync handshake hands the latest one to
 * every device that connects in the next few minutes, which is exactly the
 * device that just reconnected after the freeze.
 */

/** Shorter stalls are too brief to drop a connection, so they are not news. */
export const HOST_STALL_REPORT_MIN_MS = 5_000;
/** A stall older than this no longer explains a reconnect. */
export const HOST_STALL_REPORT_WINDOW_MS = 5 * 60_000;

type RecordedStall = {
  durationMs: number;
  /** Wall clock on this machine; clients only ever see the age. */
  endedAtMs: number;
  loadAverage1m: number | null;
  cpuCount: number | null;
  restarted: boolean;
};

let lastStall: RecordedStall | null = null;

function cpuCount(): number | null {
  try {
    const count = typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
    return Number.isFinite(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

/** Windows always answers [0, 0, 0]: no load average there, not an idle one. */
function loadAverage1m(): number | null {
  if (process.platform === "win32") return null;
  try {
    const value = os.loadavg()[0];
    return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null;
  } catch {
    return null;
  }
}

export function recordHostStall(args: {
  durationMs: number;
  endedAtMs?: number;
  /** The watchdog killed the brain and this is the restarted one. */
  restarted?: boolean;
}): void {
  const durationMs = Math.round(args.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < HOST_STALL_REPORT_MIN_MS) return;
  const endedAtMs = args.endedAtMs ?? Date.now();
  if (!Number.isFinite(endedAtMs)) return;
  // The load right after a restart describes the fresh process, not the freeze.
  const restarted = args.restarted === true;
  lastStall = {
    durationMs,
    endedAtMs,
    loadAverage1m: restarted ? null : loadAverage1m(),
    cpuCount: cpuCount(),
    restarted,
  };
}

/** The last stall, if it ended within the report window; ages use this machine's clock. */
export function readRecentHostStall(nowMs = Date.now()): SyncHostStall | null {
  const stall = lastStall;
  if (!stall) return null;
  const agoMs = Math.max(0, nowMs - stall.endedAtMs);
  if (agoMs > HOST_STALL_REPORT_WINDOW_MS) return null;
  return {
    durationMs: stall.durationMs,
    agoMs,
    ...(stall.loadAverage1m != null ? { loadAverage1m: stall.loadAverage1m } : {}),
    ...(stall.cpuCount != null ? { cpuCount: stall.cpuCount } : {}),
    ...(stall.restarted ? { restarted: true } : {}),
  };
}
