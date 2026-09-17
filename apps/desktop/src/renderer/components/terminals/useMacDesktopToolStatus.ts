import { useEffect, useRef, useState } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";

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
 *     all push, so there is nothing left for an interval to discover.
 */

export type MacDesktopToolState = {
  display: MacDesktopDisplay | null;
  /** Windows actually sitting on this lane's display. */
  windowCount: number;
};

export function useMacDesktopToolStatus(args: {
  /** The Work pane is on screen and the machine is answering. */
  enabled: boolean;
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The host's capability, from `useMacDesktopSupport`. Null means "not yet". */
  supported: boolean | null;
}): MacDesktopToolState | null {
  const { enabled, laneId, runtimePin, supported } = args;
  const [state, setState] = useState<MacDesktopToolState | null>(null);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;

  useEffect(() => {
    // A host that cannot run this is never read from — the same rule the rest
    // of the pane's statuses follow, and the reason a Linux-hosted lane costs
    // nothing here.
    if (!enabled || !laneId || supported === false) {
      setState(null);
      return;
    }
    const api = window.ade.macDesktop;
    if (!api) return;
    let cancelled = false;

    const read = () => {
      void api
        .getStatus({ laneId }, pinRef.current)
        .then((status) => {
          if (cancelled) return;
          const display = status.display ?? null;
          setState({
            display,
            windowCount: display
              ? status.windows.filter((entry) => entry.onDisplayId === display.displayId).length
              : 0,
          });
        })
        .catch(() => {
          // An unreachable host is not "no screen": the card keeps whatever it
          // last knew rather than claiming the lane has nothing.
        });
    };

    read();
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
    };
  }, [enabled, laneId, runtimePinKey, supported]);

  return state;
}

/**
 * The card's one line.
 *
 * Exported and pure so the two states can be asserted without a machine.
 * "Start …" rather than "No screen": the card is a button, and the line under
 * a button should say what pressing it does.
 */
export function macDesktopStatusLineText(state: MacDesktopToolState | null): {
  line: string;
  live: boolean;
} {
  if (!state?.display) return { line: "Start Mac Desktop for this lane", live: false };
  return {
    line: state.windowCount > 0
      ? `Mac Desktop active · ${state.windowCount} ${state.windowCount === 1 ? "window" : "windows"}`
      : "Mac Desktop active",
    live: true,
  };
}
