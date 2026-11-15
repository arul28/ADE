import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";

/**
 * How long a machine that dropped still counts as connected while it
 * reconnects, counted from when the page is in front. The sync client keeps
 * its cached state and holds commands until the connection is restored.
 */
const RECONNECT_HOLD_MS = 30_000;

/** Sync client states of a connection that dropped and is coming back on its own. */
const RECONNECTING_CLIENT_STATES: ReadonlySet<string> = new Set([
  // Closed; it dials again as soon as the page is in front.
  "disconnected",
  "connecting",
  "reconnecting",
  "restoring",
]);

/**
 * Keeps a machine that was connected reading as connected while its
 * connection comes back.
 *
 * A browser that suspends a background tab (Safari does, even for a window
 * that only lost focus) comes back with a dead socket: the client notices,
 * closes it and dials again. The connection reads "connecting" meanwhile, and
 * every page that asks whether the tab's machine is online
 * (`useTabCopyPin` and friends) took that as offline: Work dropped the open
 * chat and its whole list for "No computer connected", until the reconnect a
 * second later brought it back as a fresh page. Held, the pages keep their
 * state and re-sync quietly when the connection is back.
 *
 * Only a reconnect is held, never a first connect or a refusal, and only for
 * RECONNECT_HOLD_MS of time in front: a machine that stays unreachable still
 * turns offline, with its Connect action. Time in the background does not
 * count, since the client does not dial while the page is hidden.
 */
export function createReconnectHold(
  clientState: (targetId: string) => string | null,
  onExpire: () => void,
): {
  apply: (snapshot: RemoteRuntimeConnectionSnapshot) => RemoteRuntimeConnectionSnapshot;
  dispose: () => void;
} {
  const wasConnected = new Set<string>();
  /**
   * Each held machine's time left, and since when that time has been running
   * (null while the page is hidden). A hold spends its time only in front, and
   * once spent it is gone until the machine connects again.
   */
  const holds = new Map<string, { leftMs: number; runningSince: number | null }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const timeLeft = (hold: { leftMs: number; runningSince: number | null }, now: number) =>
    hold.runningSince == null ? hold.leftMs : hold.leftMs - (now - hold.runningSince);
  const onVisibility = () => {
    if (holds.size === 0) return;
    const now = Date.now();
    const nowHidden = hidden();
    for (const hold of holds.values()) {
      // Hidden: bank the time left and stop the clock. In front: start it.
      if (nowHidden) {
        hold.leftMs = timeLeft(hold, now);
        hold.runningSince = null;
      } else if (hold.runningSince == null) {
        hold.runningSince = now;
      }
    }
    if (!nowHidden) onExpire();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = Number.isFinite(delayMs)
      ? setTimeout(() => {
        timer = null;
        onExpire();
      }, Math.max(0, delayMs) + 50)
      : null;
  };
  return {
    apply(snapshot) {
      const now = Date.now();
      let nextExpiryMs = Number.POSITIVE_INFINITY;
      let held = false;
      const present = new Set<string>();
      const connections = snapshot.connections.map((connection) => {
        const targetId = connection.target.id;
        present.add(targetId);
        if (connection.state === "connected") {
          wasConnected.add(targetId);
          holds.delete(targetId);
          return connection;
        }
        const state = clientState(targetId);
        if (connection.state === "parked" || !wasConnected.has(targetId) || !state || !RECONNECTING_CLIENT_STATES.has(state)) {
          // Parked, failed (sign-in, refused) or never connected: nothing to hold.
          wasConnected.delete(targetId);
          holds.delete(targetId);
          return connection;
        }
        let hold = holds.get(targetId);
        if (!hold) {
          hold = { leftMs: RECONNECT_HOLD_MS, runningSince: hidden() ? null : now };
          holds.set(targetId, hold);
        }
        const leftMs = timeLeft(hold, now);
        if (leftMs <= 0) {
          // Spent: the machine reads as it is, and is not held again until it
          // has connected again.
          wasConnected.delete(targetId);
          holds.delete(targetId);
          return connection;
        }
        if (hold.runningSince != null) nextExpiryMs = Math.min(nextExpiryMs, leftMs);
        held = true;
        return { ...connection, state: "connected" as const };
      });
      for (const targetId of [...wasConnected]) {
        if (!present.has(targetId)) wasConnected.delete(targetId);
      }
      for (const targetId of [...holds.keys()]) {
        if (!present.has(targetId)) holds.delete(targetId);
      }
      schedule(nextExpiryMs);
      if (!held) return snapshot;
      return {
        ...snapshot,
        connections,
        connectedCount: connections.filter((entry) => entry.state === "connected").length,
      };
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
