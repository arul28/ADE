import { BrowserWindow } from "electron";

/** Every open window, skipping one that is closing right now (it misses one update; the next read has it). */
export function sendToAllWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // A window closing mid-send.
    }
  }
}
