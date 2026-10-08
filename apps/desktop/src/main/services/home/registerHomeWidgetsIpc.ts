import { app, BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";

import { HOME_WIDGETS_IPC } from "../../../shared/types/homeWidgets";
import { createHomeWidgetsService, type HomeWidgetsService } from "./homeWidgetsService";

/**
 * Wires the home widgets' main-process service to IPC.
 *
 * Only ADE's own renderer may ask: the clipboard history and the kill action
 * are not for a page in the built-in browser or an agent-authored scene frame.
 */

function isAdeRenderer(event: IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  const raw = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(raw);
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    if (!app.isPackaged && url.origin === "http://localhost:5173") return true;
    return url.protocol === "file:" && /\/renderer\/index\.html$/.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export function registerHomeWidgetsIpc(args: {
  logger?: { warn: (event: string, data?: Record<string, unknown>) => void };
}): HomeWidgetsService {
  const service = createHomeWidgetsService({
    userDataDir: app.getPath("userData"),
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
      readBuffer: (format) => clipboard.readBuffer(format),
    },
    ownPids: () => app.getAppMetrics().map((metric) => metric.pid),
    broadcast: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
    },
    logger: args.logger,
  });

  const handle = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) => {
    ipcMain.handle(channel, async (event, ...rest) => {
      if (!isAdeRenderer(event)) throw new Error("Home widgets are only available to the ADE window.");
      return fn(...(rest as A));
    });
  };

  handle(HOME_WIDGETS_IPC.clipboardGetState, () => service.clipboard.getState());
  handle(HOME_WIDGETS_IPC.clipboardConfigure, (input: { enabled?: boolean; persist?: boolean }) => service.clipboard.configure(input ?? {}));
  handle(HOME_WIDGETS_IPC.clipboardClear, () => service.clipboard.clear());
  handle(HOME_WIDGETS_IPC.clipboardRemove, (id: string) => service.clipboard.remove(String(id)));
  handle(HOME_WIDGETS_IPC.clipboardCopy, (id: string) => service.clipboard.copy(String(id)));
  handle(HOME_WIDGETS_IPC.machineHealth, () => service.machine.health());
  handle(HOME_WIDGETS_IPC.machineListeners, () => service.machine.listeners());
  handle(HOME_WIDGETS_IPC.machineKill, (pid: number) => service.machine.kill(Number(pid)));
  handle(HOME_WIDGETS_IPC.weatherSearch, (query: string) => service.weather.search(String(query ?? "")));
  handle(HOME_WIDGETS_IPC.weatherGet, (input: { latitude: number; longitude: number }) => service.weather.get(input));

  // Clipboard capture resumes on launch when the widget was left on, without
  // waiting for the home page to mount. Off the boot path: a few seconds in,
  // and only a small file read.
  const resume = setTimeout(() => {
    void service.load().catch(() => {});
  }, 4_000);
  resume.unref?.();
  app.once("will-quit", () => service.dispose());

  return service;
}
