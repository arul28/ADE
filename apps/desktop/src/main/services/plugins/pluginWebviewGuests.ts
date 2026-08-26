/**
 * Which `<webview>` guests are plugin pages, and whose.
 *
 * The bridge answers every call against the plugin id the HOST knows, never one
 * the page sends. That id is established once, in `will-attach-webview`, where
 * the source URL is still the one the host approved — so it has to be written
 * down somewhere the IPC handler can read it later, keyed by the only identity
 * an `ipcMain` event carries: `event.sender.id`.
 *
 * A module-level registry rather than a field on some service, for the same
 * reason `pluginEvents.ts` is one: the writer is `main.ts`'s window layer and
 * the readers are the IPC handler and the change-push path, and threading a
 * handle between them would mean widening three constructors to carry a Map.
 *
 * Deliberately Electron-free. A guest is recorded as ids plus a `send`
 * function, so the push path can reach a guest without importing `webContents`
 * and both halves are testable without a browser.
 */

import type { PluginWebviewContext } from "../../../shared/plugins/webviewBridge";

export type PluginWebviewGuest = {
  /** `webContents.id` of the guest itself. The IPC sender identity. */
  webContentsId: number;
  pluginId: string;
  /** The window hosting the guest, for the calls that need a project scope. */
  hostWindowId: number | null;
  /**
   * The subject the host attached this guest to, captured from its source URL at
   * attach and never from anything the page later does. Null for a full tab or
   * pane webview, which belongs to no chat, lane or PR. See
   * `shared/plugins/webviewBridge.ts` — this is what the handshake reports back
   * as `adePlugin.context`, and it is what makes the subject unforgeable.
   */
  context: PluginWebviewContext | null;
  /** Push one frame to the guest. A destroyed guest must make this a no-op. */
  send: (channel: string, payload: unknown) => void;
};

const guests = new Map<number, PluginWebviewGuest>();

/** Record a guest. Returns the function that forgets it. */
export function registerPluginWebviewGuest(guest: PluginWebviewGuest): () => void {
  guests.set(guest.webContentsId, guest);
  return () => {
    // Compared by identity: a webContents id is reused after the original is
    // destroyed, and a late teardown must not evict the guest that took it.
    if (guests.get(guest.webContentsId) === guest) guests.delete(guest.webContentsId);
  };
}

export function getPluginWebviewGuest(webContentsId: number): PluginWebviewGuest | null {
  return guests.get(webContentsId) ?? null;
}

export function listPluginWebviewGuests(pluginId: string): PluginWebviewGuest[] {
  return [...guests.values()].filter((guest) => guest.pluginId === pluginId);
}

/** Test seam. Production has no reason to forget live guests. */
export function resetPluginWebviewGuestsForTests(): void {
  guests.clear();
}
