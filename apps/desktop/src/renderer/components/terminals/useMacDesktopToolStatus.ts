import { useEffect, useMemo, useRef } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import {
  desktopSeatKind,
  type MacDesktopDisplay,
  type WindowsDesktopOperationKind,
} from "../../../shared/types/macDesktop";
import { reduceMacDesktopStatus, windowsDesktopOperationFor } from "../chat/useMacDesktopStatus";
import { desktopToolProductName, type DesktopWorkTool } from "./workTools";
import {
  MAC_DESKTOP_STOP_WAIT_MS,
  macDesktopPendingStop,
  macDesktopStatusKey,
  publishMacDesktopStatus,
  publishMacDesktopUnconfirmed,
  readMacDesktopStatusEntry,
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
  /** A Windows sign-in or setup running on the host, so the card is not "off". */
  windowsOperation?: WindowsDesktopOperationKind | null;
};

/** The card's state from one store entry. */
export function macDesktopToolStateFromEntry(
  entry: MacDesktopStatusEntry | null,
  laneId?: string | null,
): MacDesktopToolState | null {
  if (!entry) return null;
  const display = entry.status?.display ?? null;
  const state: MacDesktopToolState = {
    display,
    windowCount: display && entry.status
      ? entry.status.windows.filter((window) => window.onDisplayId === display.displayId).length
      : 0,
    confirmed: entry.confirmed,
  };
  // Host-wide setup steps count for every lane; a private start only for its own.
  const windowsOperation = windowsDesktopOperationFor(entry.status?.windowsDesktop, laneId)?.kind ?? null;
  return windowsOperation ? { ...state, windowsOperation } : state;
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
  const state = useMemo(() => (active ? macDesktopToolStateFromEntry(entry, laneId) : null), [active, entry, laneId]);

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
        case "windows-desktop-changed": {
          // Host-wide and carries the whole Windows status: applied by the
          // pane's own reducer, no read, so a sign-in's phases cost nothing here.
          const current = readMacDesktopStatusEntry(storeKey);
          const next = reduceMacDesktopStatus(current?.status ?? null, event, laneId);
          if (current && next && next !== current.status) {
            publishMacDesktopStatus(storeKey, { status: next, confirmed: current.confirmed });
          }
          return;
        }
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
export function macDesktopStatusLineText(
  state: MacDesktopToolState | null,
  desktopTool: DesktopWorkTool = "mac-desktop",
): {
  line: string;
  live: boolean;
} {
  const desktopName = desktopToolProductName(desktopTool);
  // Never "active" on the strength of a read that failed: that is how the card
  // kept saying "active · 1 window" about a display that was gone.
  if (state && state.confirmed === false) return { line: `${desktopName} is not answering`, live: false };
  if (state?.windowsOperation && !state.display) {
    return { line: windowsOperationLine(state.windowsOperation), live: true };
  }
  if (!state?.display) return { line: `${desktopName} is off`, live: false };
  // A Windows seat says which one: the private screen or the user's own desktop.
  // Only a Windows display carries a seat mode, so one names its host.
  const seat = desktopSeatKind({
    platform: desktopTool === "windows-desktop" || state.display.seatMode ? "win32" : "darwin",
    display: state.display,
  });
  const name = seat === "windows-shared" ? "Main desktop" : seat === "windows-private" ? "Private screen" : desktopName;
  return {
    line: state.windowCount > 0
      ? `${name} active · ${state.windowCount} ${state.windowCount === 1 ? "window" : "windows"}`
      : `${name} active`,
    live: true,
  };
}

function windowsOperationLine(kind: WindowsDesktopOperationKind): string {
  switch (kind) {
    case "setup":
      return "Setting up on the Windows PC…";
    case "save_password":
      return "Saving your Windows password…";
    case "forget_password":
      return "Forgetting the saved password…";
    case "start_private":
      return "Starting your private screen…";
  }
}
