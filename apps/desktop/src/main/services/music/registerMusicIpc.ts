import path from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";

import { parseTrustedAccountDirectoryBaseUrl } from "../../../shared/accountDirectory";
import { MUSIC_IPC, type MusicCommand, type MusicLibraryKind, type MusicSearchScope } from "../../../shared/types/music";
import { createDeveloperTokenProvider } from "./musicDeveloperToken";
import { resolveMusicHostExecutable } from "../native/nativeHelperPaths";
import { getNowPlayingService } from "../home/registerHomeWidgetsIpc";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";
import { createMusicService, type MusicService } from "./musicService";
import { createMusicNowPlayingBridge } from "./musicNowPlayingBridge";

/**
 * Wires the Music service to IPC (`window.ade.music`).
 *
 * Only ADE's own renderer may call it: a page in the built-in browser or an
 * agent-authored scene frame must not drive the user's Apple Music account.
 */

const KINDS = new Set<MusicLibraryKind>(["playlists", "albums", "songs"]);

export function registerMusicIpc(args: {
  credentials: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  directoryBaseUrl: () => string | null;
  getAccountToken: () => Promise<string | null>;
  logger?: {
    info: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
  };
  /** How a Connect ended, for product analytics (`docs/logging.md`, the dev home). */
  onConnectOutcome?: (outcome: "completed" | "cancelled" | "failed") => void;
}): MusicService {
  const tokens = createDeveloperTokenProvider({
    isPackaged: app.isPackaged,
    directoryBaseUrl: () => {
      const raw = args.directoryBaseUrl();
      return raw ? parseTrustedAccountDirectoryBaseUrl(raw) : null;
    },
    getAccountToken: args.getAccountToken,
    logger: args.logger,
  });
  // The home page's Now Playing widget follows ADE's player while it has a track.
  const onNowPlayingState = createMusicNowPlayingBridge({
    nowPlaying: getNowPlayingService,
    command: (command) => service.command(command),
  });
  const service: MusicService = createMusicService({
    hostExecutable: resolveMusicHostExecutable({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    isPackaged: app.isPackaged,
    userDataDir: path.join(app.getPath("userData"), "music-player"),
    appVersion: app.getVersion(),
    tokens,
    credentials: args.credentials,
    broadcast: (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(MUSIC_IPC.stateEvent, state);
      }
      onNowPlayingState(state);
    },
    logger: args.logger,
  });

  const handle = <A extends unknown[], R>(channel: string, fn: (...a: A) => Promise<R>) => {
    ipcMain.handle(channel, async (event, ...rest) => {
      if (!isTrustedAdeRendererSender(event)) throw new Error("Music is only available to the ADE window.");
      return fn(...(rest as A));
    });
  };

  const str = (value: unknown) => (typeof value === "string" ? value : String(value ?? ""));
  handle(MUSIC_IPC.getState, () => service.getState());
  handle(MUSIC_IPC.warm, () => service.warm());
  handle(MUSIC_IPC.connect, async () => {
    const result = await service.connect();
    args.onConnectOutcome?.(result.ok ? "completed" : result.cancelled ? "cancelled" : "failed");
    return result;
  });
  handle(MUSIC_IPC.disconnect, () => service.disconnect());
  handle(MUSIC_IPC.command, (command: MusicCommand) => service.command(command));
  handle(MUSIC_IPC.queue, () => service.queue());
  handle(MUSIC_IPC.search, (input: { term: string; scope: MusicSearchScope; limit?: number }) =>
    service.search({ term: str(input?.term), scope: input?.scope === "library" ? "library" : "catalog", limit: input?.limit }));
  handle(MUSIC_IPC.library, (input: { kind: MusicLibraryKind; offset?: number; limit?: number }) =>
    service.library({ kind: KINDS.has(input?.kind) ? input.kind : "playlists", offset: input?.offset, limit: input?.limit }));
  handle(MUSIC_IPC.recent, () => service.recent());
  handle(MUSIC_IPC.charts, () => service.charts());
  handle(MUSIC_IPC.account, () => service.account());
  handle(MUSIC_IPC.unload, () => service.unloadPlayer());
  handle(MUSIC_IPC.showSignIn, () => service.showSignIn());
  handle(MUSIC_IPC.cancelSignIn, () => service.cancelSignIn());
  handle(MUSIC_IPC.tracks, (input: { kind: "album" | "playlist"; id: string; library: boolean }) =>
    service.tracks({ kind: input?.kind === "album" ? "album" : "playlist", id: str(input?.id), library: Boolean(input?.library) }));
  handle(MUSIC_IPC.rating, (input: { id: string; library: boolean }) =>
    service.rating({ id: str(input?.id), library: Boolean(input?.library) }));
  handle(MUSIC_IPC.setRating, (input: { id: string; library: boolean; liked: boolean | null }) =>
    service.setRating({ id: str(input?.id), library: Boolean(input?.library), liked: input?.liked === null ? null : Boolean(input?.liked) }));

  // The player host must never outlive ADE.
  app.once("will-quit", () => {
    void service.dispose();
  });
  return service;
}
