import type { PluginWebviewPlacement } from "../../../../shared/plugins/webviewBridge";

/**
 * Every plugin guest this window is drawing right now, by `guestKey`.
 *
 * The relay is addressed by `guestKey` and nothing else. Main knows which
 * `webContents` asked; it does not know — and must not be told — which React
 * component put that guest on screen. So `surface.close` arrives as "the guest
 * numbered 42 wants to be closed", and something in the renderer has to be able
 * to turn that number into the popover, picker or overlay that owns it.
 *
 * This is that something: a flat module-level map, written by
 * {@link registerPluginWebviewGuest} from inside `PluginWebviewHost` when a
 * guest reaches `dom-ready`, and read by the relay. A store rather than React
 * state because the reader is a plain IPC callback, the same reason the popover
 * and prompt stores exist.
 *
 * ## Why the close function is carried rather than looked up
 *
 * A placement alone cannot answer `surface.close`. Two popovers cannot both be
 * open — but a popover and a settings-section page can, and "close the popover"
 * would then close the wrong one. The record carries the exact callback the
 * component that mounted this guest wants run, so the relay never has to reason
 * about which host is on screen.
 *
 * ## What a missing record means
 *
 * That the guest is gone, or was never ready. Both are answered the same way:
 * the verb is refused with a sentence, never dropped. A page whose promise
 * hangs is the failure mode the whole relay contract exists to prevent.
 */
export type PluginWebviewGuestRecord = {
  /** `pluginWebviewGuestKey(webContentsId)`, read off the element itself. */
  guestKey: string;
  pluginId: string;
  /** The manifest surface this guest draws. Null for a guest with no surface. */
  surfaceId: string | null;
  placement: PluginWebviewPlacement;
  /**
   * Take this guest's surface down.
   *
   * Absent for a placement that has no "close" — a tab, a pane, a drawer tab —
   * which is what makes `surface.close` a documented no-op there rather than a
   * refusal. The page asked for something reasonable and got the honest answer.
   */
  close?: (() => void) | undefined;
};

const guests = new Map<string, PluginWebviewGuestRecord>();

/** Register a live guest; returns the unregister function. */
export function registerPluginWebviewGuest(record: PluginWebviewGuestRecord): () => void {
  guests.set(record.guestKey, record);
  return () => {
    // Compared by identity rather than deleted outright: a guest that was
    // replaced (a reload recreated the element and Chromium reused the id)
    // must not have its live record removed by the old element's cleanup.
    if (guests.get(record.guestKey) === record) guests.delete(record.guestKey);
  };
}

/** The guest behind a relayed request, or null when it is already gone. */
export function getPluginWebviewGuest(guestKey: string): PluginWebviewGuestRecord | null {
  return guests.get(guestKey) ?? null;
}

/**
 * Close the surface that owns a guest.
 *
 * Three outcomes, and the caller needs all three apart: `"closed"` ran the
 * host's own dismissal, `"no-op"` found the guest in a placement that cannot
 * close (a tab), and `"unknown"` found no guest at all. Only the last is a
 * refusal the page should see.
 */
export function closePluginWebviewGuest(guestKey: string): "closed" | "no-op" | "unknown" {
  const record = guests.get(guestKey);
  if (!record) return "unknown";
  if (!record.close) return "no-op";
  record.close();
  return "closed";
}

/** Test seam: forget every registration. */
export function resetPluginWebviewGuests(): void {
  guests.clear();
}
