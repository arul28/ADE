/**
 * Terminal output flow control for the brain's client connections.
 *
 * Terminal output reaches a desktop as notifications on the same connection
 * as replies to its requests, in order. A macOS unix socket moves 8 KB per
 * round trip, so a flooding terminal can outrun it: the brain used to queue
 * 20+ MB of output in memory, and every reply waited seconds behind it (and a
 * client 64 MB behind is dropped). Replies cannot simply jump the queue: a
 * snapshot reply that overtakes older output would have that output painted
 * on top of it.
 *
 * So, like a real terminal, the brain stops reading the PTYs that are flooding
 * while a client is behind, and those programs block on their own output until
 * it catches up; quiet terminals keep flowing (ptyService decides which).
 * A connection holds the PTYs only while it drains: if it does not get back
 * under the low mark within MAX_HOLD_MS (a stuck or very slow client), it
 * releases and is ignored until it has caught up, so it can never freeze the
 * terminals. Such a client gets the old behavior: buffered output.
 */

// Measured on a 16 MB flood: 512K/128K left the socket idle between pauses and
// slowed the flood 2-4x; 2M/512K let replies wait behind up to 2 MB. 1M/256K
// kept flood time within noise with replies under ~0.5 s at p95.
/** Unread bytes on a connection past which it asks the busy PTYs to pause. */
const PTY_OUTPUT_HOLD_ABOVE_BYTES = 1024 * 1024;
/** Unread bytes under which a holding connection lets the PTYs read again. */
const PTY_OUTPUT_RELEASE_BELOW_BYTES = 256 * 1024;
/** Longest one connection may hold the PTYs before it counts as stalled. */
const PTY_OUTPUT_MAX_HOLD_MS = 1_500;
const HOLD_CHECK_INTERVAL_MS = 15;

type HoldListener = (held: boolean) => void;

const holders = new Set<object>();
const listeners = new Set<HoldListener>();

function setHolding(holder: object, holding: boolean): void {
  const wasHeld = holders.size > 0;
  if (holding) holders.add(holder);
  else holders.delete(holder);
  const held = holders.size > 0;
  if (held === wasHeld) return;
  for (const listener of listeners) {
    try {
      listener(held);
    } catch {
      // A listener failure must not leave the other PTYs paused.
    }
  }
}

/** Whether some connection is currently asking the PTYs to pause. */
export function isPtyOutputHeld(): boolean {
  return holders.size > 0;
}

/** Called with true when the first connection holds, false when the last releases. */
export function onPtyOutputHoldChange(listener: HoldListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type PtyOutputBacklogTracker = {
  /** Call after every write to the connection. */
  afterWrite(): void;
  /** Call when the connection closes. */
  close(): void;
};

/** One per client connection; `pendingBytes` reads its unread write backlog. */
export function trackPtyOutputBacklog(pendingBytes: () => number): PtyOutputBacklogTracker {
  const holder = {};
  let holding = false;
  let stalled = false;
  let closed = false;
  let heldSince = 0;
  let checkTimer: ReturnType<typeof setInterval> | null = null;

  const release = () => {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    if (!holding) return;
    holding = false;
    setHolding(holder, false);
  };

  // While holding, nothing new is written, so a timer watches the backlog
  // drain instead of waiting for the next write.
  const check = () => {
    const bytes = pendingBytes();
    if (bytes < PTY_OUTPUT_RELEASE_BELOW_BYTES) {
      release();
      return;
    }
    if (Date.now() - heldSince >= PTY_OUTPUT_MAX_HOLD_MS) {
      stalled = true;
      release();
    }
  };

  return {
    afterWrite() {
      if (closed || holding) return;
      const bytes = pendingBytes();
      if (stalled) {
        if (bytes < PTY_OUTPUT_RELEASE_BELOW_BYTES) stalled = false;
        return;
      }
      if (bytes <= PTY_OUTPUT_HOLD_ABOVE_BYTES) return;
      holding = true;
      heldSince = Date.now();
      setHolding(holder, true);
      checkTimer = setInterval(check, HOLD_CHECK_INTERVAL_MS);
      checkTimer.unref?.();
    },
    close() {
      closed = true;
      release();
    },
  };
}
