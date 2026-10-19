/**
 * Notices an update download that stopped receiving bytes.
 *
 * electron-updater arms its 60 s request timeout on a `socket` event that
 * Electron's `net` requests never emit, so a download whose connection goes
 * quiet never fails on its own: `downloadUpdate()` stays pending until ADE
 * restarts. The watchdog says when that happened; the caller cancels.
 *
 * Two things count as bytes arriving: a progress report (`noteProgress`), and
 * growth of the partial file on disk (`readPendingBytes`), because a server
 * that sends no Content-Length produces no progress reports at all. Once every
 * byte is in, the hash check, rename and (on Windows) signature check can take
 * a while without progress, so the watchdog stands down. A poll gap far longer
 * than the interval means the process was suspended (the Mac slept), not that
 * the connection stalled, so the window starts over.
 */

/** A poll gap this many times the interval means the process was suspended. */
const SUSPEND_GAP_FACTOR = 4;

export type DownloadStallWatchdog = {
  /** Bytes arrived. `complete` once the whole file is in. */
  noteProgress(complete: boolean): void;
  stop(): void;
};

export function startDownloadStallWatchdog(args: {
  stallMs: number;
  pollMs: number;
  nowMs: () => number;
  /** Bytes of the partial download on disk; null when unreadable. */
  readPendingBytes: () => number | null;
  /** Called once, when nothing arrived for `stallMs`. The watchdog has stopped. */
  onStall: (idleMs: number) => void;
  onSuspendGap?: (gapMs: number) => void;
}): DownloadStallWatchdog {
  let lastActivityAtMs = args.nowMs();
  let lastPollAtMs = lastActivityAtMs;
  let lastPendingBytes = args.readPendingBytes();
  let transferComplete = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  timer = setInterval(() => {
    const at = args.nowMs();
    const sinceLastPoll = at - lastPollAtMs;
    lastPollAtMs = at;
    if (transferComplete) return;
    const pendingBytes = args.readPendingBytes();
    if (pendingBytes != null && pendingBytes !== lastPendingBytes) {
      lastPendingBytes = pendingBytes;
      lastActivityAtMs = at;
      return;
    }
    if (sinceLastPoll > args.pollMs * SUSPEND_GAP_FACTOR) {
      args.onSuspendGap?.(sinceLastPoll);
      lastActivityAtMs = at;
      return;
    }
    const idleMs = at - lastActivityAtMs;
    if (idleMs < args.stallMs) return;
    stop();
    args.onStall(idleMs);
  }, args.pollMs);
  timer.unref?.();

  return {
    noteProgress(complete) {
      lastActivityAtMs = args.nowMs();
      transferComplete = complete;
    },
    stop,
  };
}
