import { useEffect, useMemo, useRef } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_STOP_WAIT_MS,
  macDesktopPendingStop,
  macDesktopStatusKey,
  publishMacDesktopStatus,
  publishMacDesktopUnconfirmed,
  subscribeMacDesktopRuntimeChanges,
  useMacDesktopStatusEntry,
  withMacDesktopTimeout,
  type MacDesktopStatusEntry,
} from "../chat/macDesktopStatusStore";

/**
 * What the Mac Desktop picker card says about THIS lane.
 *
 * Every other tool's card reports something measured — "Not booted" and then a
 * device name for the simulator, "3 tabs · agent" for the browser — and Mac
 * Desktop was the one card still printing its catalogue hint ("A private screen
 * per lane") whether the lane had a screen up or not. The card is where you
 * decide whether to open the tool, and "this lane has a screen with two windows
 * on it" is the fact that decision needs.
 *
 * Not a poller, and it must never become one. Two reads and one subscription:
 *
 *   * `useMacDesktopSupport` already answers "can this host do it at all",
 *     cached per machine for the life of the renderer;
 *   * one `getStatus({ laneId })` when the pane opens on a lane — the same
 *     read the panel itself makes, which does not start a display or a driver
 *     (it answers from the ownership registry, and lists windows only if a
 *     backend is already up);
 *   * the service's own `mac-desktop` events, which is how the line moves
 *     afterwards. A display created, destroyed, or a window parked or released
 *     all push, so there is nothing left for an interval to discover;
 *   * one more read when the window comes back into focus, because an event
 *     the host never sent (a display that died with its helper) cannot move
 *     the line.
 *
 * Every read lands in `macDesktopStatusStore`, which the pane writes too, and
 * the line is drawn from there. A failed read marks the entry unconfirmed, and
 * an unconfirmed entry never reads as "active".
 */

export type MacDesktopToolState = {
  display: MacDesktopDisplay | null;
  /** Windows actually sitting on this lane's display. */
  windowCount: number;
  /**
   * False when the newest read failed. The card then says the host is not
   * answering rather than repeating a screen it can no longer vouch for.
   * Absent means confirmed, for callers that build a state by hand.
   */
  confirmed?: boolean;
};

/** The card's state from one store entry. */
export function macDesktopToolStateFromEntry(entry: MacDesktopStatusEntry | null): MacDesktopToolState | null {
  if (!entry) return null;
  const display = entry.status?.display ?? null;
  return {
    display,
    windowCount: display && entry.status
      ? entry.status.windows.filter((window) => window.onDisplayId === display.displayId).length
      : 0,
    confirmed: entry.confirmed,
  };
}

/** Coming back to the window re-reads the card, at most this often. */
const MAC_DESKTOP_CARD_REVALIDATE_MIN_MS = 3_000;

export function useMacDesktopToolStatus(args: {
  /** The Work pane is on screen and the machine is answering. */
  enabled: boolean;
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The host's capability, from `useMacDesktopSupport`. Null means "not yet". */
  supported: boolean | null;
}): MacDesktopToolState | null {
  const { enabled, laneId, runtimePin, supported } = args;
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  const active = enabled && Boolean(laneId) && supported !== false;
  // The pane writes the same entry, so the card and the pane cannot disagree.
  const storeKey = active && laneId ? macDesktopStatusKey(laneId, runtimePin) : null;
  const entry = useMacDesktopStatusEntry(storeKey);
  const state = useMemo(() => (active ? macDesktopToolStateFromEntry(entry) : null), [active, entry]);

  useEffect(() => {
    // A host that cannot run this is never read from — the same rule the rest
    // of the pane's statuses follow, and the reason a Linux-hosted lane costs
    // nothing here.
    if (!storeKey || !laneId) return;
    const api = window.ade.macDesktop;
    if (!api) return;
    let cancelled = false;
    let seq = 0;

    const read = () => {
      const mine = ++seq;
      // A stop still in flight is waited for, as the pane does: the host keeps
      // listing the display until the stop lands, and the card would say
      // "active" about a screen that is going.
      const pendingStop = macDesktopPendingStop(storeKey);
      const settled = pendingStop
        ? withMacDesktopTimeout(pendingStop, MAC_DESKTOP_STOP_WAIT_MS).catch(() => undefined)
        : Promise.resolve();
      void settled
        .then(() => withMacDesktopTimeout(api.getStatus({ laneId }, pinRef.current)))
        .then((status) => {
          if (cancelled || mine !== seq) return;
          publishMacDesktopStatus(storeKey, { status, confirmed: true });
        })
        .catch(() => {
          // An unreachable host is not "no screen", and it is not a live screen
          // either: the entry keeps what it last knew, marked unconfirmed.
          if (cancelled || mine !== seq) return;
          publishMacDesktopUnconfirmed(storeKey);
        });
    };

    read();
    let last = Date.now();
    const revalidate = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < MAC_DESKTOP_CARD_REVALIDATE_MIN_MS) return;
      last = now;
      read();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    // A restarted brain sends no `display-destroyed` for what died with the old one.
    const disposeRuntime = subscribeMacDesktopRuntimeChanges(revalidate);
    // The event only ever says "something changed"; the count and the display
    // come back from the one read, so the two can never disagree.
    const dispose = api.onEvent?.((event) => {
      switch (event.type) {
        case "display-created":
          if (event.display.laneId !== laneId) return;
          break;
        case "display-destroyed":
        case "windows-changed":
          if (event.laneId !== laneId) return;
          break;
        default:
          return;
      }
      read();
    }, pinRef.current) ?? null;
    return () => {
      cancelled = true;
      dispose?.();
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      disposeRuntime();
    };
  }, [laneId, runtimePinKey, storeKey]);

  return state;
}

/**
 * The card's one line.
 *
 * Exported and pure so the two states can be asserted without a machine.
 * "Off" in the pane's own words: the card opens the pane, and the pane shows
 * the Off card with its Start button. Opening it never starts a display.
 */
export function macDesktopStatusLineText(state: MacDesktopToolState | null): {
  line: string;
  live: boolean;
} {
  // Never "active" on the strength of a read that failed: that is how the card
  // kept saying "active · 1 window" about a display that was gone.
  if (state && state.confirmed === false) return { line: "Mac Desktop is not answering", live: false };
  if (!state?.display) return { line: "Mac Desktop is off", live: false };
  return {
    line: state.windowCount > 0
      ? `Mac Desktop active · ${state.windowCount} ${state.windowCount === 1 ? "window" : "windows"}`
      : "Mac Desktop active",
    live: true,
  };
}
