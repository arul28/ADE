import fs from "node:fs";

import type {
  MusicCommand,
  MusicCommandResult,
  MusicConnectResult,
  MusicItem,
  MusicLibraryKind,
  MusicNowPlaying,
  MusicPage,
  MusicPlaybackState,
  MusicQueue,
  MusicRecent,
  MusicRepeatMode,
  MusicSearchResult,
  MusicSearchScope,
  MusicState,
} from "../../../shared/types/music";
import { AppleMusicApiError, createAppleMusicApi } from "./appleMusicApi";
import { MusicTokenUnavailableError, type DeveloperTokenProvider } from "./musicDeveloperToken";
import { MusicHostError, startMusicHost, type MusicHost, type MusicHostEvent } from "./musicHostProcess";

/**
 * The Music feature in the main process.
 *
 * - Browsing goes through `appleMusicApi` and never needs the player host.
 * - Playing needs the host. It starts on demand (the Music tab opens, or a play
 *   command arrives) and is unloaded after `IDLE_UNLOAD_MS` without playback.
 *   Unloading keeps a snapshot (queue ids, index, second); the next play
 *   relaunches the host and continues the same song at the same second.
 * - The Music-User-Token lives in ADE's desktop credential store (the same
 *   machine store the API keys use). It is read once, kept in memory, and never
 *   logged.
 *
 * Nothing here blocks the main thread: the host is a child process on async
 * pipes, Apple calls are `fetch`, and the credential store is used through its
 * async methods.
 */

export const IDLE_UNLOAD_MS = 5 * 60_000;
export const MUSIC_USER_TOKEN_KEY = "music.appleMusic.userToken";
const AUTHORIZE_TIMEOUT_MS = 10 * 60_000;

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

type AsyncCredentialStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

type HostSnapshot = {
  ids: string[];
  index: number;
  position: number;
  shuffle: number;
  repeat: number;
  volume: number;
  nowPlaying: HostItem | null;
};

type HostItem = {
  id: string;
  type: string | null;
  title: string;
  artist: string;
  album: string;
  artwork: MusicNowPlaying["artwork"];
  durationMs: number | null;
  catalogId: string | null;
  isLibrary: boolean;
};

type HostState = {
  ready?: boolean;
  authorized?: boolean;
  state?: string;
  isPlaying?: boolean;
  time?: number;
  duration?: number;
  queuePosition?: number;
  queueLength?: number;
  shuffle?: number;
  repeat?: number;
  volume?: number;
  nowPlaying?: HostItem | null;
};

const PLAYBACK_STATES = new Set<MusicPlaybackState>([
  "none", "loading", "playing", "paused", "stopped", "ended", "seeking", "waiting", "stalled", "completed",
]);

const toNowPlaying = (item: HostItem | null | undefined): MusicNowPlaying | null =>
  item
    ? {
      id: item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artwork: item.artwork ?? null,
      durationMs: item.durationMs ?? null,
      library: item.isLibrary,
      catalogId: item.catalogId ?? null,
    }
    : null;

const toItem = (item: HostItem): MusicItem => ({
  id: item.id,
  kind: "song",
  title: item.title,
  subtitle: item.artist,
  album: item.album || null,
  artwork: item.artwork ?? null,
  durationMs: item.durationMs ?? null,
  library: item.isLibrary,
  catalogId: item.catalogId ?? null,
  trackCount: null,
  releaseYear: null,
  explicit: false,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type MusicService = ReturnType<typeof createMusicService>;

export function createMusicService(args: {
  /** Null when this platform has no player host (macOS today). */
  hostExecutable: string | null;
  isPackaged: boolean;
  userDataDir: string;
  appVersion: string;
  tokens: DeveloperTokenProvider;
  credentials: AsyncCredentialStore;
  broadcast: (state: MusicState) => void;
  logger?: Logger;
  idleUnloadMs?: number;
  fetchImpl?: typeof fetch;
}) {
  const idleUnloadMs = args.idleUnloadMs ?? IDLE_UNLOAD_MS;
  let userToken: string | null = null;
  let userTokenLoaded: Promise<void> | null = null;
  let host: MusicHost | null = null;
  let hostStarting: Promise<MusicHost> | null = null;
  let snapshot: HostSnapshot | null = null;
  let unloadTimer: NodeJS.Timeout | null = null;
  let busy = 0;
  let disposed = false;
  let broadcastTimer: NodeJS.Timeout | null = null;

  const state: MusicState = {
    availability: args.hostExecutable ? "ready" : "unsupported",
    message: args.hostExecutable ? null : "Music on Mac is coming. Apple Music plays in ADE on Windows today.",
    authorized: false,
    connecting: false,
    host: { status: "stopped", pid: null, unloadAt: null },
    playback: {
      state: "none",
      isPlaying: false,
      position: 0,
      positionAt: Date.now(),
      duration: 0,
      nowPlaying: null,
      queuePosition: -1,
      queueLength: 0,
      shuffle: false,
      repeat: 0,
      volume: 1,
    },
    queueRevision: 0,
  };

  const snapshotState = (): MusicState => JSON.parse(JSON.stringify(state)) as MusicState;

  // Coalesce bursts (MusicKit fires several events per transition) into one IPC message.
  const emit = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (!disposed) args.broadcast(snapshotState());
    }, 30);
  };

  const api = createAppleMusicApi({
    developerToken: async () => (await args.tokens.get()).token,
    userToken: () => userToken,
    onUserTokenRejected: () => {
      args.logger?.warn("music.user_token_rejected");
      void dropUserToken();
    },
    fetchImpl: args.fetchImpl,
  });

  const loadUserToken = () => {
    userTokenLoaded ??= (async () => {
      try {
        userToken = (await args.credentials.get(MUSIC_USER_TOKEN_KEY))?.trim() || null;
      } catch (error) {
        args.logger?.warn("music.user_token_read_failed", { error: errorMessage(error) });
        userToken = null;
      }
      state.authorized = Boolean(userToken);
      emit();
    })();
    return userTokenLoaded;
  };

  const dropUserToken = async () => {
    userToken = null;
    state.authorized = false;
    api.clearCache();
    emit();
    try {
      await args.credentials.delete(MUSIC_USER_TOKEN_KEY);
    } catch (error) {
      args.logger?.warn("music.user_token_delete_failed", { error: errorMessage(error) });
    }
  };

  const setUnavailable = (message: string) => {
    if (state.availability === "unsupported") return;
    state.availability = "unavailable";
    state.message = message;
    emit();
  };

  const checkAvailability = async (): Promise<void> => {
    if (!args.hostExecutable) return;
    if (!fs.existsSync(args.hostExecutable)) {
      setUnavailable(
        args.isPackaged
          ? "ADE's music player is missing from this install. Reinstall ADE."
          : "The music player isn't built. Run `npm run build:music-host:win` in apps/desktop.",
      );
      return;
    }
    try {
      await args.tokens.get();
      if (state.availability !== "ready") {
        state.availability = "ready";
        state.message = null;
        emit();
      }
    } catch (error) {
      setUnavailable(error instanceof MusicTokenUnavailableError ? error.message : "Music couldn't start.");
    }
  };

  const applyHostState = (s: HostState | null | undefined) => {
    if (!s || s.ready === false) return;
    const p = state.playback;
    if (typeof s.state === "string") p.state = PLAYBACK_STATES.has(s.state as MusicPlaybackState) ? (s.state as MusicPlaybackState) : "none";
    if (typeof s.isPlaying === "boolean") p.isPlaying = s.isPlaying;
    if (typeof s.time === "number") {
      p.position = s.time;
      p.positionAt = Date.now();
    }
    if (typeof s.duration === "number" && s.duration > 0) p.duration = s.duration;
    if (typeof s.queuePosition === "number") p.queuePosition = s.queuePosition;
    if (typeof s.queueLength === "number") p.queueLength = s.queueLength;
    if (typeof s.shuffle === "number") p.shuffle = s.shuffle === 1;
    if (typeof s.repeat === "number") p.repeat = (s.repeat === 1 || s.repeat === 2 ? s.repeat : 0) as MusicRepeatMode;
    if (typeof s.volume === "number") p.volume = s.volume;
    if (s.nowPlaying !== undefined) {
      const next = toNowPlaying(s.nowPlaying);
      // MusicKit clears nowPlayingItem between tracks; keep the last one until a new one lands.
      if (next || p.state === "none" || p.state === "stopped") p.nowPlaying = next;
      if (next && (!p.duration || p.duration <= 0) && next.durationMs) p.duration = next.durationMs / 1000;
    }
    if (typeof s.authorized === "boolean" && userToken) state.authorized = s.authorized;
    scheduleIdleUnload();
    emit();
  };

  const scheduleIdleUnload = () => {
    const shouldArm = host !== null && !state.playback.isPlaying && !state.connecting && busy === 0;
    if (!shouldArm) {
      if (unloadTimer) clearTimeout(unloadTimer);
      unloadTimer = null;
      state.host.unloadAt = null;
      return;
    }
    if (unloadTimer) return;
    state.host.unloadAt = Date.now() + idleUnloadMs;
    unloadTimer = setTimeout(() => {
      unloadTimer = null;
      state.host.unloadAt = null;
      void unload("idle");
    }, idleUnloadMs);
    unloadTimer.unref?.();
  };

  const onHostEvent = (event: MusicHostEvent) => {
    switch (event.event) {
      case "state":
        applyHostState(event.state as HostState);
        break;
      case "time": {
        const p = state.playback;
        if (typeof event.time === "number") {
          p.position = event.time;
          p.positionAt = Date.now();
        }
        if (typeof event.duration === "number" && event.duration > 0) p.duration = event.duration;
        if (typeof event.isPlaying === "boolean" && event.isPlaying !== p.isPlaying) {
          p.isPlaying = event.isPlaying;
          scheduleIdleUnload();
        }
        emit();
        break;
      }
      case "queueChanged":
        state.queueRevision += 1;
        emit();
        break;
      case "authorization":
        if (event.authorized === false && userToken) {
          args.logger?.info("music.unauthorized_by_player");
        }
        break;
      case "authWindow":
        args.logger?.info("music.auth_window", { state: event.state });
        break;
      case "playbackError":
        args.logger?.warn("music.playback_error", { error: String(event.error ?? "") });
        state.message = `Playback failed: ${String(event.error ?? "unknown error")}`;
        emit();
        break;
      case "loadFailed":
        state.message = "Couldn't load Apple's MusicKit. Check your connection.";
        emit();
        break;
      case "hostError":
        args.logger?.warn("music.host_error", { code: event.code, error: event.error });
        break;
      default:
        break;
    }
  };

  const waitForLoaded = (h: MusicHost) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new MusicHostError("Apple's MusicKit didn't load in time.", "load_timeout"));
      }, 30_000);
      const off = h.onEvent((event) => {
        if (event.event === "loaded") {
          clearTimeout(timer);
          off();
          resolve();
        } else if (event.event === "loadFailed") {
          clearTimeout(timer);
          off();
          reject(new MusicHostError("Couldn't load Apple's MusicKit. Check your connection.", "load_failed"));
        }
      });
    });

  const ensureHost = async (): Promise<MusicHost> => {
    if (host) return host;
    if (hostStarting) return hostStarting;
    if (!args.hostExecutable) throw new Error(state.message ?? "Music isn't available on this computer.");
    hostStarting = (async () => {
      await loadUserToken();
      await checkAvailability();
      if (state.availability !== "ready") throw new Error(state.message ?? "Music isn't available.");
      const developer = await args.tokens.get();
      state.host = { status: "starting", pid: null, unloadAt: null };
      emit();
      const startedAt = Date.now();
      const h = startMusicHost({
        executable: args.hostExecutable!,
        userDataDir: args.userDataDir,
        logger: args.logger,
        show: process.env.ADE_MUSIC_HOST_SHOW === "1",
      });
      const loaded = waitForLoaded(h);
      loaded.catch(() => {});
      h.onEvent(onHostEvent);
      h.onExit(({ code }) => {
        if (host !== h) return;
        host = null;
        if (unloadTimer) clearTimeout(unloadTimer);
        unloadTimer = null;
        state.connecting = false;
        state.playback.isPlaying = false;
        state.host = { status: snapshot ? "suspended" : code === 0 ? "stopped" : "failed", pid: null, unloadAt: null };
        if (code !== 0) state.message = "The music player closed unexpectedly. Press play to start it again.";
        emit();
      });
      try {
        await h.ready;
        await loaded;
        const configured = await h.request<HostState>("configure", {
          developerToken: developer.token,
          userToken: userToken ?? undefined,
          volume: state.playback.volume,
          appBuild: args.appVersion,
        });
        host = h;
        state.host = { status: "running", pid: h.pid, unloadAt: null };
        if (state.message?.startsWith("The music player closed")) state.message = null;
        args.logger?.info("music.host_started", { pid: h.pid, ms: Date.now() - startedAt });
        applyHostState(configured);
        return h;
      } catch (error) {
        await h.stop(1_000).catch(() => {});
        state.host = { status: snapshot ? "suspended" : "failed", pid: null, unloadAt: null };
        state.message = errorMessage(error);
        emit();
        throw error;
      }
    })();
    try {
      return await hostStarting;
    } finally {
      hostStarting = null;
    }
  };

  /** Snapshot the queue and stop the host. `idle`: the 5-minute unload. */
  const unload = async (reason: "idle" | "quit" | "disconnect") => {
    const h = host;
    if (!h) return;
    if (reason === "idle" && (state.playback.isPlaying || busy > 0 || state.connecting)) {
      scheduleIdleUnload();
      return;
    }
    try {
      const s = await h.request<HostSnapshot>("snapshot", {}, 5_000);
      snapshot = s && s.ids.length > 0 && s.index >= 0 ? s : null;
    } catch {
      // A player that won't answer has nothing worth keeping.
    }
    host = null;
    if (unloadTimer) clearTimeout(unloadTimer);
    unloadTimer = null;
    const t0 = Date.now();
    await h.stop();
    args.logger?.info("music.host_unloaded", { reason, ms: Date.now() - t0, kept: Boolean(snapshot) });
    state.playback.isPlaying = false;
    if (state.playback.state === "playing") state.playback.state = "paused";
    state.host = { status: snapshot ? "suspended" : "stopped", pid: null, unloadAt: null };
    emit();
  };

  /** A host that is running, with the unloaded queue put back if there was one. */
  const ensurePlayer = async (restore: boolean): Promise<MusicHost> => {
    const h = await ensureHost();
    if (restore && snapshot) {
      const s = snapshot;
      snapshot = null;
      try {
        await h.request("playItems", { ids: s.ids, index: s.index, position: s.position, play: false });
        if (s.repeat) await h.request("repeat", { mode: s.repeat });
        args.logger?.info("music.queue_restored", { items: s.ids.length, index: s.index, position: s.position });
      } catch (error) {
        args.logger?.warn("music.queue_restore_failed", { error: errorMessage(error) });
      }
    }
    return h;
  };

  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    busy += 1;
    scheduleIdleUnload();
    try {
      return await fn();
    } finally {
      busy -= 1;
      scheduleIdleUnload();
    }
  };

  const command = async (cmd: MusicCommand): Promise<MusicCommandResult> => {
    try {
      return await withBusy(async () => {
        const fresh = cmd.type === "playItems" || cmd.type === "playCollection";
        if (cmd.type === "pause" && !host) return { ok: true } as const;
        if (cmd.type === "volume" && !host) {
          state.playback.volume = Math.max(0, Math.min(1, cmd.value));
          emit();
          return { ok: true } as const;
        }
        // Before Connect, MusicKit plays catalog songs as 30-second previews.
        await loadUserToken();
        if (fresh) snapshot = null;
        const h = await ensurePlayer(!fresh);
        let result: HostState | undefined;
        switch (cmd.type) {
          case "toggle":
            result = await h.request<HostState>("toggle");
            break;
          case "play":
            result = await h.request<HostState>("resume");
            break;
          case "pause":
            result = await h.request<HostState>("pause");
            break;
          case "next":
            result = await h.request<HostState>("next");
            break;
          case "previous":
            result = await h.request<HostState>("prev");
            break;
          case "seek":
            result = await h.request<HostState>("seek", { position: cmd.position });
            break;
          case "volume":
            result = await h.request<HostState>("volume", { value: cmd.value });
            break;
          case "shuffle":
            result = await h.request<HostState>("shuffle", { mode: cmd.on ? 1 : 0 });
            break;
          case "repeat":
            result = await h.request<HostState>("repeat", { mode: cmd.mode });
            break;
          case "playAt":
            result = await h.request<HostState>("playAt", { index: cmd.index });
            break;
          case "playItems": {
            // Drop songs that left the catalog: one missing id fails the whole queue.
            const chosen = cmd.ids[cmd.index ?? 0];
            const ids = cmd.ids.length > 1 ? await api.availableSongIds(cmd.ids).catch(() => cmd.ids) : cmd.ids;
            if (!ids.length) throw new Error("NOT_FOUND");
            const index = chosen !== undefined && ids.includes(chosen) ? ids.indexOf(chosen) : Math.min(cmd.index ?? 0, ids.length - 1);
            result = await h.request<HostState>("playItems", {
              ids,
              index,
              shuffle: cmd.shuffle === undefined ? undefined : cmd.shuffle ? 1 : 0,
            }, 60_000);
            break;
          }
          case "playCollection":
            result = await h.request<HostState>("playCollection", {
              kind: cmd.kind,
              id: cmd.id,
              index: cmd.index ?? 0,
              shuffle: cmd.shuffle === undefined ? undefined : cmd.shuffle ? 1 : 0,
            }, 60_000);
            break;
          case "playNext":
            await h.request("playNext", { ids: cmd.ids });
            break;
          case "playLater":
            await h.request("playLater", { ids: cmd.ids });
            break;
        }
        if (state.message?.startsWith("Playback failed")) state.message = null;
        applyHostState(result);
        return { ok: true } as const;
      });
    } catch (error) {
      args.logger?.warn("music.command_failed", { type: cmd.type, error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
  };

  const connect = async (): Promise<MusicConnectResult> => {
    if (state.connecting) return { ok: false, error: "A sign-in window is already open." };
    state.connecting = true;
    emit();
    try {
      const h = await ensureHost();
      // MusicKit's promise can hang when the user closes Apple's window, so the
      // window closing (with no answer shortly after) also ends the wait.
      let offClosed: () => void = () => {};
      const closed = new Promise<{ cancelled: true }>((resolve) => {
        offClosed = h.onEvent((event) => {
          if (event.event === "authWindow" && event.state === "closed") {
            setTimeout(() => resolve({ cancelled: true }), 2_500);
          }
        });
      });
      const outcome = await Promise.race([
        h.request<{ userToken: string | null; authorized: boolean }>("authorize", {}, AUTHORIZE_TIMEOUT_MS),
        closed,
      ]).finally(() => offClosed());
      if ("cancelled" in outcome) return { ok: false, error: "Sign-in was closed before it finished.", cancelled: true };
      if (!outcome.userToken) return { ok: false, error: "Apple Music didn't return a sign-in." };
      userToken = outcome.userToken;
      userTokenLoaded = Promise.resolve();
      await args.credentials.set(MUSIC_USER_TOKEN_KEY, outcome.userToken);
      api.clearCache();
      state.authorized = true;
      state.message = null;
      args.logger?.info("music.connected");
      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      // MusicKit rejects with AUTHORIZATION_ERROR / "Unauthorized" when the user cancels.
      const cancelled = /cancel|unauthori|AUTHORIZATION_ERROR/i.test(message);
      return { ok: false, error: cancelled ? "Sign-in was cancelled." : message, cancelled };
    } finally {
      state.connecting = false;
      scheduleIdleUnload();
      emit();
    }
  };

  const disconnect = async () => {
    if (host) {
      try {
        await host.request("unauthorize", {}, 10_000);
      } catch {
        // The stored token goes regardless.
      }
    }
    snapshot = null;
    await unload("disconnect");
    await dropUserToken();
    state.playback = { ...state.playback, nowPlaying: null, isPlaying: false, state: "none", position: 0, duration: 0, queueLength: 0, queuePosition: -1 };
    state.host = { status: "stopped", pid: null, unloadAt: null };
    emit();
  };

  const browse = async <T>(fn: () => Promise<T>): Promise<T> => {
    await loadUserToken();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AppleMusicApiError || error instanceof MusicTokenUnavailableError) {
        if (error instanceof MusicTokenUnavailableError) setUnavailable(error.message);
        throw new Error(error.message);
      }
      throw error;
    }
  };

  const queue = async (): Promise<MusicQueue> => {
    if (!host) {
      if (snapshot?.nowPlaying) return { position: 0, items: [toItem(snapshot.nowPlaying)] };
      return { position: -1, items: [] };
    }
    const q = await host.request<{ position: number; items: HostItem[] }>("queue");
    return { position: q.position, items: q.items.map(toItem) };
  };

  return {
    getState: async (): Promise<MusicState> => {
      await loadUserToken();
      if (state.availability !== "unsupported" && state.host.status !== "running") await checkAvailability();
      return snapshotState();
    },
    warm: async () => {
      await loadUserToken();
      if (!userToken || !args.hostExecutable) return;
      try {
        await withBusy(() => ensurePlayer(false));
      } catch {
        // State carries the message.
      }
    },
    connect,
    disconnect,
    command,
    queue,
    search: (input: { term: string; scope: MusicSearchScope; limit?: number }): Promise<MusicSearchResult> =>
      browse(() => api.search(input)),
    library: (input: { kind: MusicLibraryKind; offset?: number; limit?: number }): Promise<MusicPage> =>
      browse(() => api.library(input)),
    recent: (): Promise<MusicRecent> => browse(() => api.recent()),
    tracks: (input: { kind: "album" | "playlist"; id: string; library: boolean }): Promise<MusicItem[]> =>
      browse(() => api.tracks(input)),
    rating: (input: { id: string; library: boolean }) => browse(() => api.rating(input)),
    charts: () => browse(() => api.charts()),
    account: () => browse(() => api.account()),
    /** The Music tab closed: pause and unload now; the snapshot resumes it later. */
    unloadPlayer: async () => {
      if (!host) return;
      try {
        if (state.playback.isPlaying) await host.request("pause", {}, 5_000);
      } catch {
        // Unloading stops it regardless.
      }
      state.playback.isPlaying = false;
      await unload("idle");
    },
    /** Bring Apple's sign-in window to the front (it can open behind ADE). */
    showSignIn: async () => {
      if (state.connecting) host?.send({ cmd: "showAuth" });
    },
    /** Close Apple's sign-in window; Connect then ends as cancelled. */
    cancelSignIn: async () => {
      if (state.connecting) host?.send({ cmd: "closeAuth" });
    },
    setRating: (input: { id: string; library: boolean; liked: boolean | null }) => browse(() => api.setRating(input)),
    /** For diagnostics and measurement: the host's pids. */
    hostPid: () => host?.pid ?? null,
    unloadNow: () => unload("idle"),
    dispose: async () => {
      disposed = true;
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (unloadTimer) clearTimeout(unloadTimer);
      const h = host;
      host = null;
      if (h) await h.stop(2_000);
    },
  };
}
