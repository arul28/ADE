/**
 * Re-read this surface when the reader can see it again.
 *
 * A keep-alive tab does not unmount when the rail moves, and
 * `document.visibilityState` tracks the ADE window, not the tab. Returning
 * from Linear's site backgrounds the window (visibility fires). Switching
 * from Settings back to Linear does not (the window never hid). The host
 * dispatches `ade-plugin-surface-revealed` for that second case — the same
 * name as `PLUGIN_WEBVIEW_SURFACE_REVEALED_EVENT` in the desktop bridge.
 */

import { useEffect, useRef } from "react";

/** Same string the desktop host dispatches into the guest. */
export const SURFACE_REVEALED_EVENT = "ade-plugin-surface-revealed";

/**
 * `onShown` runs when the ADE window comes forward or this guest is revealed.
 * `onFocus` runs on window focus; omit it to use `onShown` there too.
 *
 * Held in refs so a listener that closes over changing state does not
 * resubscribe every keystroke.
 */
export function useResumeWhenShown(onShown: () => void, onFocus?: () => void): void {
  const shown = useRef(onShown);
  shown.current = onShown;
  const focus = useRef(onFocus);
  focus.current = onFocus;

  useEffect(() => {
    const fireShown = () => shown.current();
    const fireFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      (focus.current ?? shown.current)();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") fireShown();
    };
    window.addEventListener("focus", fireFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(SURFACE_REVEALED_EVENT, fireShown);
    return () => {
      window.removeEventListener("focus", fireFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(SURFACE_REVEALED_EVENT, fireShown);
    };
  }, []);
}
