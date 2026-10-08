import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, webContents, type IpcMainInvokeEvent, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import { HOME_WIDGETS_IPC, type HomeShareResult } from "../../../shared/types/homeWidgets";
import { createHomeWidgetsService, type HomeWidgetsService } from "./homeWidgetsService";
import {
  allowBuiltInBrowserBackgroundAudio,
  isBuiltInBrowserWebContents,
  onBuiltInBrowserWebContents,
} from "../builtInBrowser/builtInBrowserService";
import { createBrowserMediaSessions } from "./browserMediaSessions";
import { createNowPlayingService, type NowPlayingService } from "./nowPlayingService";

let nowPlaying: NowPlayingService | null = null;

/**
 * ADE in an OS media session: its AppUserModelId and bundle id
 * (`ADE_WINDOWS_APP_USER_MODEL_ID`, any channel) and the Music tab's player host.
 */
const OWN_MEDIA_APP_PATTERN = /^com\.ade\.desktop(\.|$)|ade-music-host/i;

/**
 * The Now Playing source, for an in-app player (the Music tab) to take over
 * with `setOverride`. Null until the home widgets are registered.
 */
export function getNowPlayingService(): NowPlayingService | null {
  return nowPlaying;
}

/**
 * Adds the built-in browser's tabs to Now Playing: a tab playing media
 * (YouTube, SoundCloud, Spotify…) becomes a source. `browserTabIdFor` names a
 * tab of the Browser top tab, which the widget can jump to; other tabs (a
 * project's browser panel) show without the jump.
 */
export function connectBrowserToNowPlaying(args: { browserTabIdFor: (wc: WebContents) => string | null }): void {
  const service = nowPlaying;
  if (!service) return;
  const media = createBrowserMediaSessions({
    browserTabIdFor: args.browserTabIdFor,
    allowBackgroundAudio: allowBuiltInBrowserBackgroundAudio,
    onChange: () => service.notifyChanged(),
  });
  onBuiltInBrowserWebContents((wc) => media.watch(wc));
  // Tabs restored before this ran.
  for (const wc of webContents.getAllWebContents()) {
    if (isBuiltInBrowserWebContents(wc)) media.watch(wc);
  }
  service.setBrowserSource(media);
}

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

  // Now Playing: a source runs only while some window's widget is subscribed.
  const playing = createNowPlayingService({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    logger: args.logger,
    // ADE's own media sessions (its windows' browser tabs and the Music tab's
    // player host) come in directly; the OS copies of them are skipped.
    isOwnApp: (appId) => OWN_MEDIA_APP_PATTERN.test(appId),
    getAppIcon: async (appPath) => {
      const icon = await app.getFileIcon(appPath, { size: "large" });
      return icon.isEmpty() ? null : icon.toDataURL();
    },
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(HOME_WIDGETS_IPC.nowPlayingChanged, state);
      }
    },
  });
  nowPlaying = playing;
  const watched = new Set<number>();
  ipcMain.handle(HOME_WIDGETS_IPC.nowPlayingSubscribe, async (event) => {
    if (!isAdeRenderer(event)) throw new Error("Home widgets are only available to the ADE window.");
    const id = event.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      // A window that closes or reloads without unsubscribing still lets go.
      const release = () => {
        watched.delete(id);
        playing.unsubscribe(id);
      };
      event.sender.once("destroyed", release);
      event.sender.once("did-navigate", release);
    }
    return playing.subscribe(id);
  });
  ipcMain.handle(HOME_WIDGETS_IPC.nowPlayingUnsubscribe, async (event) => {
    if (!isAdeRenderer(event)) throw new Error("Home widgets are only available to the ADE window.");
    playing.unsubscribe(event.sender.id);
  });
  handle(HOME_WIDGETS_IPC.nowPlayingCommand, async (command: string, sessionId?: unknown) => {
    const target = typeof sessionId === "string" && sessionId.length <= 512 ? sessionId : null;
    if (command === "play" || command === "pause" || command === "toggle" || command === "next" || command === "previous") await playing.command(command, target);
  });
  handle(HOME_WIDGETS_IPC.nowPlayingSelect, async (sessionId: unknown) => {
    playing.select(typeof sessionId === "string" && sessionId.length <= 512 ? sessionId : null);
  });

  // Share cards: the renderer draws the PNG; main only copies or saves it.
  const PNG_PREFIX = "data:image/png;base64,";
  const MAX_PNG_BYTES = 12 * 1024 * 1024;
  const decodePng = (value: unknown): Buffer | null => {
    if (typeof value !== "string" || !value.startsWith(PNG_PREFIX)) return null;
    const bytes = Buffer.from(value.slice(PNG_PREFIX.length), "base64");
    return bytes.length > 0 && bytes.length <= MAX_PNG_BYTES ? bytes : null;
  };
  handle(HOME_WIDGETS_IPC.shareCopyImage, async (pngDataUrl: string): Promise<HomeShareResult> => {
    const bytes = decodePng(pngDataUrl);
    if (!bytes) return { ok: false, error: "Not a PNG image." };
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return { ok: false, error: "The image could not be read." };
    clipboard.writeImage(image);
    return { ok: true };
  });
  ipcMain.handle(HOME_WIDGETS_IPC.shareSaveImage, async (event, input: { pngDataUrl?: string; fileName?: string }): Promise<HomeShareResult> => {
    if (!isAdeRenderer(event)) throw new Error("Home widgets are only available to the ADE window.");
    const bytes = decodePng(input?.pngDataUrl);
    if (!bytes) return { ok: false, error: "Not a PNG image." };
    const safeName = String(input?.fileName ?? "ade-shipped.png").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120) || "ade-shipped.png";
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: "Save image",
      defaultPath: path.join(app.getPath("downloads"), safeName.endsWith(".png") ? safeName : `${safeName}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    };
    const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    await fs.writeFile(choice.filePath, bytes);
    return { ok: true, path: choice.filePath };
  });

  // Clipboard capture resumes on launch when the widget was left on, without
  // waiting for the home page to mount. Off the boot path: a few seconds in,
  // and only a small file read.
  const resume = setTimeout(() => {
    void service.load().catch(() => {});
  }, 4_000);
  resume.unref?.();
  app.once("will-quit", () => {
    service.dispose();
    playing.dispose();
  });

  return service;
}
