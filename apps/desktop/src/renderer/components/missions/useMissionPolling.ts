import { useEffect, useRef, useCallback } from "react";

/**
 * Polling coordinator for the missions UI.
 *
 * Instead of each component running its own `setInterval`, they all register
 * their refresh callbacks here.  A single master timer (2 s tick) is shared
 * across the page; on each tick it checks which callbacks are due and
 * dispatches them.  This collapses 4+ independent intervals into one timer
 * and avoids IPC call storms.
 *
 * Usage:
 *   useMissionPolling(refreshMyData, 10_000, enabled);
 *
 * The hook handles:
 *  - Running the callback immediately on mount (or when it changes)
 *  - Firing the callback every `intervalMs` while `enabled` is true
 *  - Skipping ticks when the document is hidden (background tab)
 *  - Cleanup on unmount
 */

// ── Shared coordinator singleton ──────────────────────────────────────────

type Registration = {
  id: number;
  callback: () => void;
  intervalMs: number;
  lastFiredAt: number;
};

let nextId = 0;
const registrations = new Map<number, Registration>();
let masterTimer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 2_000; // Master tick interval

function startMaster() {
  if (masterTimer !== null) return;
  masterTimer = setInterval(() => {
    // Skip entirely when the page is backgrounded
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    const now = Date.now();
    for (const reg of registrations.values()) {
      if (now - reg.lastFiredAt >= reg.intervalMs) {
        reg.lastFiredAt = now;
        try {
          reg.callback();
        } catch {
          // Swallow errors from individual callbacks
        }
      }
    }
  }, TICK_MS);
}

function stopMasterIfEmpty() {
  if (registrations.size === 0 && masterTimer !== null) {
    clearInterval(masterTimer);
    masterTimer = null;
  }
}

function register(callback: () => void, intervalMs: number): number {
  const id = nextId++;
  registrations.set(id, {
    id,
    callback,
    intervalMs,
    lastFiredAt: Date.now(), // will fire after the first interval elapses
  });
  startMaster();
  return id;
}

function unregister(id: number) {
  registrations.delete(id);
  stopMasterIfEmpty();
}

function updateCallback(id: number, callback: () => void) {
  const reg = registrations.get(id);
  if (reg) {
    reg.callback = callback;
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

/**
 * Register a polling callback with the shared coordinator.
 *
 * @param callback  The function to call on each tick. Can be async (fires
 *                  fire-and-forget). Wrap with `useCallback` to avoid
 *                  unnecessary re-registrations.
 * @param intervalMs  How often (in ms) the callback should fire.
 * @param enabled  Pass false to temporarily suspend polling (e.g. when the
 *                 tab or panel is not visible). Default: true.
 */
export function useMissionPolling(
  callback: () => void,
  intervalMs: number,
  enabled = true,
): void {
  const regIdRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);

  // Keep callbackRef up-to-date so the coordinator always calls the latest version
  useEffect(() => {
    callbackRef.current = callback;
    if (regIdRef.current !== null) {
      updateCallback(regIdRef.current, () => callbackRef.current());
    }
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      // If we were registered, unregister
      if (regIdRef.current !== null) {
        unregister(regIdRef.current);
        regIdRef.current = null;
      }
      return;
    }

    // Register with the coordinator
    regIdRef.current = register(() => callbackRef.current(), intervalMs);

    return () => {
      if (regIdRef.current !== null) {
        unregister(regIdRef.current);
        regIdRef.current = null;
      }
    };
  }, [intervalMs, enabled]);
}

/**
 * Trigger an immediate out-of-band refresh for a specific registration.
 * Useful for event-driven refreshes (e.g. orchestrator events) that should
 * also reset the polling timer so we don't double-fire.
 *
 * Returns a stable `fireNow` function that invokes the callback immediately
 * and resets the last-fired timestamp.
 */
export function useMissionPollingImmediate(
  callback: () => void,
  intervalMs: number,
  enabled = true,
): { fireNow: () => void } {
  const regIdRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
    if (regIdRef.current !== null) {
      updateCallback(regIdRef.current, () => callbackRef.current());
    }
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      if (regIdRef.current !== null) {
        unregister(regIdRef.current);
        regIdRef.current = null;
      }
      return;
    }

    regIdRef.current = register(() => callbackRef.current(), intervalMs);

    return () => {
      if (regIdRef.current !== null) {
        unregister(regIdRef.current);
        regIdRef.current = null;
      }
    };
  }, [intervalMs, enabled]);

  const fireNow = useCallback(() => {
    // Call immediately
    try {
      callbackRef.current();
    } catch {
      // swallow
    }
    // Reset the timer so we don't double-fire
    if (regIdRef.current !== null) {
      const reg = registrations.get(regIdRef.current);
      if (reg) {
        reg.lastFiredAt = Date.now();
      }
    }
  }, []);

  return { fireNow };
}
