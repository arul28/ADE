import os from "node:os";

import type {
  MusicCommand,
  MusicCommandResult,
  MusicConnectResult,
  MusicDevice,
  MusicItem,
  MusicLibraryKind,
  MusicNowPlaying,
  MusicPage,
  MusicQueue,
  MusicRecent,
  MusicRepeatMode,
  MusicSearchResult,
  MusicState,
} from "../../../shared/types/music";
import { MUSIC_SPOTIFY_NOT_CONFIGURED, musicPositionNow } from "../../../shared/types/music";
import {
  createSpotifyApi,
  SPOTIFY_NO_DEVICE_MESSAGE,
  SpotifyApiError,
  spotifyDevice,
  spotifyTrackItem,
  type SpotifyPlayer,
} from "./spotifyApi";
import {
  normalizeSpotifyClientId,
  refreshSpotifyTokens,
  SpotifyAuthError,
  startSpotifySignIn,
  type SpotifySignIn,
  type SpotifyTokens,
} from "./spotifyAuth";

/**
 * Spotify in the main process, as a Spotify Connect remote.
 *
 * Spotify's audio never runs in ADE. The user's Spotify app (or a phone, a
 * speaker) plays, and ADE reads and drives it over the Web API: browsing,
 * the queue, transport, devices. That needs Spotify Premium and no DRM, so it
 * works the same on macOS and Windows.
 *
 * - Sign-in is PKCE in the default browser (`spotifyAuth.ts`) with the
 *   user's own Client ID. The refresh token is kept in `credentials` (this
 *   app's safeStorage file); the access token stays in memory.
 * - Spotify sends no events, so ADE polls `GET /me/player`, and only while the
 *   Music tab is open on Spotify (`engage`): at the end of the playing track
 *   and at least every 15 s while playing, every 30 s otherwise, and once
 *   shortly after each command (Connect applies commands a moment later).
 *   Polling stops when the tab closes, the provider changes or Spotify signs
 *   out. A 429 pauses every call for the time Spotify asks.
 * - When a play finds no active device, ADE picks one (the device it last
 *   used, this computer's Spotify app, or the only one) and transfers to it.
 * - Two generations keep late answers from undoing newer facts. `sessionGen`
 *   moves on every sign-in and sign-out, so a session read, token refresh or
 *   Connect that finishes after a sign-out cannot bring the session back;
 *   `watchGen` moves when watching starts or stops, so a poll that lands after
 *   the tab closed cannot put the song back. Credential writes run one after
 *   another, so a sign-out's delete always lands after an earlier save.
 */

export const SPOTIFY_CREDENTIAL_KEY = "music.spotify.session";
const POLL_PLAYING_MS = 15_000;
const POLL_IDLE_MS = 30_000;
const POLL_AFTER_COMMAND_MS = 400;
/** Renderers interpolate the position; a poll within this of it is not news. */
const POSITION_DRIFT_S = 1.25;
const OPEN_SPOTIFY_WAIT_MS = 15_000;
const MAX_QUEUE_URIS = 100;

type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

type AsyncCredentialStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

/** What is stored: the refresh token, tied to the Client ID it was issued for. */
type StoredSession = { clientId: string; refreshToken: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const REPEAT_FROM_SPOTIFY: Record<string, MusicRepeatMode> = { off: 0, track: 1, context: 2 };
const REPEAT_TO_SPOTIFY = ["off", "track", "context"] as const;

const toNowPlaying = (item: MusicItem | null): MusicNowPlaying | null =>
  item
    ? {
      id: item.id,
      title: item.title,
      artist: item.subtitle,
      album: item.album ?? "",
      artwork: item.artwork,
      durationMs: item.durationMs,
      library: false,
      catalogId: item.catalogId,
      externalUrl: item.externalUrl ?? null,
    }
    : null;

export type SpotifyService = ReturnType<typeof createSpotifyService>;

export function createSpotifyService(args: {
  credentials: AsyncCredentialStore;
  clientId: () => string | null;
  /** Open a URL in the default browser (the consent page). */
  openExternal: (url: string) => Promise<void>;
  /** Start the Spotify desktop app; rejects when it is not installed. */
  launchSpotifyApp: () => Promise<void>;
  broadcast: (state: MusicState) => void;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}) {
  let tokens: SpotifyTokens | null = null;
  let session: StoredSession | null = null;
  let sessionLoaded: Promise<void> | null = null;
  let refreshing: Promise<SpotifyTokens | null> | null = null;
  let signIn: SpotifySignIn | null = null;
  let engaged = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let polling: Promise<void> | null = null;
  let lastDeviceId: string | null = null;
  let lastTrackId: string | null = null;
  let disposed = false;
  let broadcastTimer: NodeJS.Timeout | null = null;
  let lastBroadcast = "";
  let sessionGen = 0;
  let watchGen = 0;
  let persisting: Promise<unknown> = Promise.resolve();
  /** Credential writes and deletes, strictly in the order they were asked for. */
  const persist = (write: () => Promise<void>): Promise<void> => {
    const next = persisting.then(write, write);
    persisting = next.catch(() => {});
    return next;
  };

  const state: MusicState = {
    availability: "ready",
    message: null,
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
  let device: MusicDevice | null = null;

  const emit = () => {
    if (broadcastTimer || disposed) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (disposed) return;
      const json = JSON.stringify({ state, device });
      if (json === lastBroadcast) return;
      lastBroadcast = json;
      args.broadcast(JSON.parse(JSON.stringify(state)) as MusicState);
    }, 30);
  };

  const syncAvailability = () => {
    if (normalizeSpotifyClientId(args.clientId())) {
      if (state.availability !== "ready" || state.message === MUSIC_SPOTIFY_NOT_CONFIGURED) {
        state.availability = "ready";
        if (state.message === MUSIC_SPOTIFY_NOT_CONFIGURED) state.message = null;
      }
    } else {
      state.availability = "unavailable";
      state.message = MUSIC_SPOTIFY_NOT_CONFIGURED;
    }
  };

  const loadSession = () => {
    sessionLoaded ??= (async () => {
      const gen = sessionGen;
      let stored: StoredSession | null = null;
      try {
        const raw = await args.credentials.get(SPOTIFY_CREDENTIAL_KEY);
        const parsed = raw ? (JSON.parse(raw) as Partial<StoredSession>) : null;
        stored = parsed?.clientId && parsed.refreshToken ? { clientId: parsed.clientId, refreshToken: parsed.refreshToken } : null;
      } catch (error) {
        args.logger?.warn("music.spotify.session_read_failed", { error: errorMessage(error) });
      }
      // A sign-in or sign-out while this read was in flight is newer than the file.
      if (gen !== sessionGen) return;
      // A session from another Client ID cannot refresh with this one.
      session = stored && stored.clientId === normalizeSpotifyClientId(args.clientId()) ? stored : null;
      state.authorized = Boolean(session);
      syncAvailability();
      emit();
    })();
    return sessionLoaded;
  };

  const resetPlayback = () => {
    state.playback = {
      ...state.playback,
      state: "none",
      isPlaying: false,
      position: 0,
      positionAt: Date.now(),
      duration: 0,
      nowPlaying: null,
      queuePosition: -1,
      queueLength: 0,
    };
    device = null;
    lastTrackId = null;
  };

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  /**
   * Forget the session in memory now, then delete it from disk. `strict` (an
   * explicit Disconnect) rethrows a failed delete: the file would sign Spotify
   * back in on the next start, so the user must hear that it failed.
   */
  const dropSession = async (message: string | null, options?: { strict?: boolean }) => {
    sessionGen += 1;
    watchGen += 1;
    tokens = null;
    session = null;
    sessionLoaded = Promise.resolve();
    state.authorized = false;
    if (message) state.message = message;
    stopPolling();
    state.host = { status: "stopped", pid: null, unloadAt: null };
    resetPlayback();
    api.clearCache();
    emit();
    try {
      await persist(() => args.credentials.delete(SPOTIFY_CREDENTIAL_KEY));
    } catch (error) {
      // The store's own error (a file system message); the token is never in it.
      args.logger?.warn("music.spotify.session_delete_failed", { error: errorMessage(error) });
      if (options?.strict) {
        throw new Error("ADE disconnected Spotify for now but couldn't delete the saved sign-in, so Spotify may reconnect when ADE restarts. Try Disconnect again.");
      }
    }
  };

  /** A valid access token, refreshed once per expiry no matter how many callers ask. */
  const accessToken = async (options?: { forceRefresh?: boolean }): Promise<string | null> => {
    await loadSession();
    if (!session) return null;
    if (tokens && !options?.forceRefresh && Date.now() < tokens.expiresAt) return tokens.accessToken;
    refreshing ??= (async () => {
      const current = session;
      if (!current) return null;
      try {
        const next = await refreshSpotifyTokens({ clientId: current.clientId, refreshToken: current.refreshToken, fetchImpl: args.fetchImpl });
        // A sign-out or a new sign-in while this was in flight wins.
        if (session !== current) return null;
        tokens = next;
        // Spotify may rotate the refresh token; the old one stops working, so keep the new one.
        if (next.refreshToken !== current.refreshToken) {
          const rotated = { clientId: current.clientId, refreshToken: next.refreshToken };
          session = rotated;
          await persist(async () => {
            if (session === rotated) await args.credentials.set(SPOTIFY_CREDENTIAL_KEY, JSON.stringify(rotated));
          });
        }
        return next;
      } catch (error) {
        // Only the session this refresh was for may be dropped; a newer sign-in stays.
        if (session !== current) return null;
        if (error instanceof SpotifyAuthError && error.code === "invalid_grant") {
          args.logger?.warn("music.spotify.refresh_rejected");
          await dropSession("Spotify needs you to connect again.");
          return null;
        }
        throw error;
      }
    })().finally(() => {
      refreshing = null;
    });
    return (await refreshing)?.accessToken ?? null;
  };

  const api = createSpotifyApi({ accessToken, fetchImpl: args.fetchImpl });

  const reanchor = (seconds: number, force: boolean): boolean => {
    const p = state.playback;
    if (!force && Math.abs(musicPositionNow(p) - seconds) <= POSITION_DRIFT_S) return false;
    p.position = seconds;
    p.positionAt = Date.now();
    return true;
  };

  const applyPlayer = (player: SpotifyPlayer | undefined) => {
    const p = state.playback;
    const prevPlaying = p.isPlaying;
    const prevState = p.state;
    if (!player || !player.device) {
      resetPlayback();
      state.playback.state = "none";
      emit();
      return;
    }
    device = spotifyDevice(player.device);
    if (device) lastDeviceId = device.id;
    const item = spotifyTrackItem(player.item ?? null);
    p.isPlaying = Boolean(player.is_playing);
    p.state = p.isPlaying ? "playing" : item ? "paused" : "stopped";
    p.shuffle = Boolean(player.shuffle_state);
    p.repeat = REPEAT_FROM_SPOTIFY[player.repeat_state ?? "off"] ?? 0;
    if (device?.volume !== null && device?.volume !== undefined) p.volume = device.volume;
    const trackChanged = (item?.id ?? null) !== lastTrackId;
    if (trackChanged) {
      lastTrackId = item?.id ?? null;
      p.nowPlaying = toNowPlaying(item);
      state.queueRevision += 1;
    }
    p.duration = item?.durationMs ? item.durationMs / 1000 : 0;
    p.queuePosition = item ? 0 : -1;
    p.queueLength = Math.max(p.queueLength, item ? 1 : 0);
    reanchor((player.progress_ms ?? 0) / 1000, trackChanged || p.isPlaying !== prevPlaying || p.state !== prevState);
    emit();
  };

  const nextPollDelay = (): number => {
    const p = state.playback;
    if (!p.isPlaying) return POLL_IDLE_MS;
    // Catch the next song when this one ends instead of 15 s later.
    const remaining = p.duration > 0 ? (p.duration - musicPositionNow(p)) * 1000 + 800 : POLL_PLAYING_MS;
    return Math.max(1_000, Math.min(POLL_PLAYING_MS, remaining));
  };

  const schedulePoll = (delayMs: number) => {
    stopPolling();
    if (disposed || !engaged || !state.authorized) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll();
    }, delayMs);
    pollTimer.unref?.();
  };

  const poll = (): Promise<void> => {
    polling ??= (async () => {
      const gen = watchGen;
      let delay = POLL_IDLE_MS;
      try {
        const player = await api.playbackState();
        // Watching stopped (tab closed, sign-out, switch) while this was in flight.
        if (gen !== watchGen) return;
        applyPlayer(player);
        if (state.message?.startsWith("Spotify is rate limiting") || state.message?.startsWith("Couldn't reach Spotify")) state.message = null;
        delay = nextPollDelay();
      } catch (error) {
        if (gen !== watchGen) return;
        if (error instanceof SpotifyApiError) {
          if (error.reason === "UNAUTHORIZED") {
            await dropSession("Spotify needs you to connect again.");
            return;
          }
          if (error.reason === "RATE_LIMITED") delay = Math.max(POLL_IDLE_MS, (error.retryAfter ?? 30) * 1000);
          if (error.reason === "RATE_LIMITED" || error.reason === "NETWORK") {
            state.message = error.message;
            emit();
          }
        }
        args.logger?.warn("music.spotify.poll_failed", { error: errorMessage(error) });
      } finally {
        polling = null;
      }
      if (gen === watchGen) schedulePoll(delay);
    })();
    return polling;
  };

  /** Start polling (the Music tab is open on Spotify). */
  const engage = () => {
    if (!state.authorized) return;
    const wasEngaged = engaged;
    if (!wasEngaged) watchGen += 1;
    engaged = true;
    state.host = { status: "running", pid: null, unloadAt: null };
    if (!wasEngaged || !pollTimer) void poll();
  };

  const disengage = () => {
    watchGen += 1;
    engaged = false;
    stopPolling();
    state.host = { status: "stopped", pid: null, unloadAt: null };
    // Spotify keeps playing; ADE just stops watching it. Clearing the song
    // hands Now Playing back to the OS session, which still sees the app.
    resetPlayback();
    emit();
  };

  // ---- Devices ----------------------------------------------------------------

  const hostName = os.hostname().replace(/\.local$/i, "").toLowerCase();

  /** The device a play without one should go to, or null to ask the user. */
  const pickDevice = (devices: MusicDevice[]): MusicDevice | null => {
    const usable = devices.filter((d) => !d.isRestricted);
    return (
      usable.find((d) => d.isActive) ??
      usable.find((d) => d.id === lastDeviceId) ??
      usable.find((d) => d.type === "Computer" && d.name.toLowerCase().startsWith(hostName)) ??
      (usable.length === 1 ? usable[0]! : null) ??
      null
    );
  };

  /**
   * Run a player call; when Spotify has no active device, move playback to the
   * one `pickDevice` chooses and try once more.
   */
  const withDevice = async (run: (deviceId?: string) => Promise<void>, play: boolean): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof SpotifyApiError) || error.reason !== "NO_ACTIVE_DEVICE") throw error;
      const target = pickDevice(await api.devices());
      if (!target) throw new Error(SPOTIFY_NO_DEVICE_MESSAGE);
      lastDeviceId = target.id;
      if (play) {
        await run(target.id);
      } else {
        await api.transfer(target.id, false);
        await run();
      }
    }
  };

  // ---- Commands ---------------------------------------------------------------

  const repeatAfterCommand = () => {
    if (!engaged) watchGen += 1;
    engaged = true;
    state.host = { status: "running", pid: null, unloadAt: null };
    schedulePoll(POLL_AFTER_COMMAND_MS);
  };

  const command = async (cmd: MusicCommand): Promise<MusicCommandResult> => {
    try {
      await loadSession();
      if (!state.authorized) throw new Error(state.availability === "ready" ? "Connect Spotify to play songs." : MUSIC_SPOTIFY_NOT_CONFIGURED);
      const p = state.playback;
      // Where the song is now, so a command that does not move it (volume,
      // shuffle, pause) keeps it there instead of falling back to the last poll.
      const carried = musicPositionNow(p);
      let newTrack = false;
      switch (cmd.type) {
        case "toggle":
          if (p.isPlaying) await api.pause();
          else await withDevice((deviceId) => api.play({ deviceId }), true);
          p.isPlaying = !p.isPlaying;
          break;
        case "play":
          await withDevice((deviceId) => api.play({ deviceId }), true);
          p.isPlaying = true;
          break;
        case "pause":
          if (!p.isPlaying && !engaged) return { ok: true };
          await api.pause();
          p.isPlaying = false;
          break;
        case "next":
          await withDevice(() => api.next(), false);
          newTrack = true;
          break;
        case "previous":
          // Like every player: a few seconds in, "previous" restarts the song.
          if (carried > 3) await api.seek(0);
          else await withDevice(() => api.previous(), false);
          newTrack = true;
          break;
        case "seek":
          await api.seek(cmd.position * 1000);
          reanchor(Math.max(0, cmd.position), true);
          break;
        case "volume": {
          if (device && !device.supportsVolume) throw new Error("This Spotify device doesn't allow volume control from ADE.");
          const value = Math.max(0, Math.min(1, cmd.value));
          await api.volume(value);
          p.volume = value;
          break;
        }
        case "shuffle":
          await withDevice(() => api.shuffle(cmd.on), false);
          p.shuffle = cmd.on;
          break;
        case "repeat":
          await withDevice(() => api.repeat(REPEAT_TO_SPOTIFY[cmd.mode] ?? "off"), false);
          p.repeat = cmd.mode;
          break;
        case "playAt":
          throw new Error("Spotify can't jump to a song in Up Next.");
        case "playItems": {
          const uris = cmd.ids.filter((id) => id.startsWith("spotify:"));
          if (!uris.length) throw new Error("Spotify couldn't find that.");
          let index = Math.min(Math.max(cmd.index ?? 0, 0), uris.length - 1);
          if (cmd.shuffle && cmd.index === undefined) index = Math.floor(Math.random() * uris.length);
          // Spotify takes a bounded list of URIs: keep a window that starts at the chosen song.
          const start = uris.length > MAX_QUEUE_URIS ? Math.max(0, Math.min(index, uris.length - MAX_QUEUE_URIS)) : 0;
          const window = uris.slice(start, start + MAX_QUEUE_URIS);
          await withDevice((deviceId) => api.play({ deviceId, uris: window, offset: index - start }), true);
          if (cmd.shuffle !== undefined) {
            await api.shuffle(cmd.shuffle);
            p.shuffle = cmd.shuffle;
          }
          p.isPlaying = true;
          p.queueLength = window.length;
          newTrack = true;
          break;
        }
        case "playCollection": {
          if (cmd.kind === "station") throw new Error("Spotify has no stations.");
          if (cmd.shuffle) {
            // Shuffle first and give no offset, so Spotify starts at a random
            // song of the album or playlist instead of its first.
            await withDevice(() => api.shuffle(true), false);
            await withDevice((deviceId) => api.play({ deviceId, contextUri: cmd.id }), true);
          } else {
            await withDevice((deviceId) => api.play({ deviceId, contextUri: cmd.id, offset: cmd.index ?? 0 }), true);
            if (cmd.shuffle === false) await api.shuffle(false);
          }
          if (cmd.shuffle !== undefined) p.shuffle = cmd.shuffle;
          p.isPlaying = true;
          newTrack = true;
          break;
        }
        case "playNext":
        case "playLater":
          // Spotify has one "Add to queue": after what is already queued, before the rest of the album or playlist.
          for (const id of cmd.ids.filter((value) => value.startsWith("spotify:")).slice(0, 50)) {
            await withDevice(() => api.addToQueue(id), false);
          }
          state.queueRevision += 1;
          break;
      }
      if (state.message === SPOTIFY_NO_DEVICE_MESSAGE || state.message?.startsWith("Spotify Premium")) state.message = null;
      p.state = p.isPlaying ? "playing" : p.nowPlaying ? "paused" : p.state;
      if (cmd.type !== "seek") {
        p.position = newTrack ? 0 : carried;
        p.positionAt = Date.now();
      }
      repeatAfterCommand();
      emit();
      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      args.logger?.warn("music.spotify.command_failed", { type: cmd.type, error: message });
      if (error instanceof SpotifyApiError && error.reason === "UNAUTHORIZED") await dropSession("Spotify needs you to connect again.");
      return { ok: false, error: message };
    }
  };

  // ---- Connect ----------------------------------------------------------------

  const connect = async (): Promise<MusicConnectResult> => {
    if (state.connecting) return { ok: false, error: "A sign-in is already open in your browser." };
    const clientId = normalizeSpotifyClientId(args.clientId());
    if (!clientId) return { ok: false, error: MUSIC_SPOTIFY_NOT_CONFIGURED };
    state.connecting = true;
    emit();
    let own: SpotifySignIn | null = null;
    const superseded = (): MusicConnectResult => ({ ok: false, error: "Sign-in was cancelled.", cancelled: true });
    try {
      await loadSession();
      const gen = sessionGen;
      own = await startSpotifySignIn({ clientId, fetchImpl: args.fetchImpl });
      signIn = own;
      await args.openExternal(own.authorizeUrl);
      const next = await own.result;
      // Signed out, or the Client ID changed, while the browser was open.
      if (gen !== sessionGen || normalizeSpotifyClientId(args.clientId()) !== clientId) return superseded();
      const fresh: StoredSession = { clientId, refreshToken: next.refreshToken };
      sessionGen += 1;
      const mine = sessionGen;
      tokens = next;
      session = fresh;
      sessionLoaded = Promise.resolve();
      api.clearCache();
      // A Development Mode app refuses accounts missing from its allow list;
      // find that out now rather than on the first click.
      try {
        await api.me();
      } catch (error) {
        if (mine !== sessionGen) return superseded();
        sessionGen += 1;
        tokens = null;
        session = null;
        if (error instanceof SpotifyApiError && error.status === 403) {
          return {
            ok: false,
            error: "Spotify refused this account. In your Spotify app's dashboard, add it under User Management, then connect again.",
          };
        }
        throw error;
      }
      if (mine !== sessionGen) return superseded();
      // Queued behind any earlier delete; a sign-out after this queues its delete behind it.
      await persist(async () => {
        if (session === fresh) await args.credentials.set(SPOTIFY_CREDENTIAL_KEY, JSON.stringify(fresh));
      });
      if (mine !== sessionGen) return superseded();
      state.authorized = true;
      state.message = null;
      args.logger?.info("music.spotify.connected");
      if (engaged) void poll();
      return { ok: true };
    } catch (error) {
      if (error instanceof SpotifyAuthError && (error.code === "cancelled" || error.code === "denied")) {
        return { ok: false, error: "Sign-in was cancelled.", cancelled: true };
      }
      return { ok: false, error: errorMessage(error) };
    } finally {
      own?.cancel();
      if (signIn === own) signIn = null;
      state.connecting = false;
      emit();
    }
  };

  const openSpotify = async (): Promise<MusicCommandResult> => {
    try {
      await loadSession();
      if (!state.authorized) throw new Error("Connect Spotify first.");
      const before = new Set((await api.devices().catch(() => [] as MusicDevice[])).map((d) => d.id));
      try {
        await args.launchSpotifyApp();
      } catch {
        throw new Error("Spotify isn't installed on this computer. Get it from spotify.com/download, or pick another device.");
      }
      const deadline = Date.now() + OPEN_SPOTIFY_WAIT_MS;
      while (Date.now() < deadline && !disposed) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const devices = await api.devices().catch(() => [] as MusicDevice[]);
        const local =
          devices.find((d) => d.type === "Computer" && !before.has(d.id) && !d.isRestricted) ??
          devices.find((d) => d.type === "Computer" && d.name.toLowerCase().startsWith(hostName) && !d.isRestricted);
        if (local) {
          if (!local.isActive) await api.transfer(local.id, false);
          lastDeviceId = local.id;
          repeatAfterCommand();
          return { ok: true };
        }
      }
      throw new Error("Spotify opened but didn't show up as a device yet. Sign in to the Spotify app, then try again.");
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  const browse = async <T>(fn: () => Promise<T>): Promise<T> => {
    await loadSession();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SpotifyApiError && error.reason === "UNAUTHORIZED" && state.authorized) {
        await dropSession("Spotify needs you to connect again.");
      }
      throw new Error(errorMessage(error));
    }
  };

  const queue = async (): Promise<MusicQueue> => {
    await loadSession();
    if (!state.authorized) return { position: -1, items: [] };
    const body = await browse(() => api.queue());
    const current = spotifyTrackItem(body.currently_playing ?? null);
    const upcoming = (body.queue ?? []).map((track) => spotifyTrackItem(track)).filter((item): item is MusicItem => item !== null);
    const items = current ? [current, ...upcoming] : upcoming;
    if (state.playback.queueLength !== items.length) {
      state.playback.queueLength = items.length;
      emit();
    }
    return { position: current ? 0 : -1, items };
  };

  return {
    getState: async (): Promise<MusicState> => {
      await loadSession();
      syncAvailability();
      return JSON.parse(JSON.stringify(state)) as MusicState;
    },
    /** The device playback is on, for `MusicState.spotify.device`. */
    currentDevice: (): MusicDevice | null => device,
    /** The Music tab opened (or this provider was selected while it is open): start watching Spotify. */
    warm: async () => {
      await loadSession();
      engage();
    },
    connect,
    disconnect: async () => {
      signIn?.cancel();
      signIn = null;
      try {
        // Spotify has no token revocation endpoint; access is removed at spotify.com/account/apps.
        await dropSession(null, { strict: true });
      } finally {
        state.message = null;
        syncAvailability();
        emit();
      }
    },
    command,
    queue,
    search: (input: { term: string; limit?: number }): Promise<MusicSearchResult> => browse(() => api.search(input)),
    library: (input: { kind: MusicLibraryKind; offset?: number; limit?: number }): Promise<MusicPage> =>
      browse(() => api.library(input)),
    recent: (): Promise<MusicRecent> => browse(() => api.recent()),
    tracks: (input: { kind: "album" | "playlist"; id: string; offset?: number; limit?: number }): Promise<MusicPage> =>
      browse(() => api.tracks(input)),
    rating: (input: { id: string }): Promise<boolean | null> =>
      browse(async () => ((await api.saved(input.id)) ? true : null)),
    setRating: (input: { id: string; liked: boolean | null }): Promise<void> =>
      browse(() => api.setSaved(input.id, input.liked === true)),
    devices: (): Promise<MusicDevice[]> => browse(() => api.devices()),
    transfer: async (input: { deviceId: string; play?: boolean }): Promise<MusicCommandResult> => {
      try {
        await browse(() => api.transfer(input.deviceId, input.play !== false));
        lastDeviceId = input.deviceId;
        repeatAfterCommand();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    openSpotify,
    /** The Music tab closed or the provider changed: stop polling. Spotify keeps playing. */
    unloadPlayer: async () => {
      disengage();
    },
    /**
     * Pause before switching to another provider. Throws when Spotify may still
     * be playing; "no active device" means nothing plays, so that is fine.
     */
    pauseForSwitch: async () => {
      await loadSession();
      if (state.authorized) {
        try {
          // Ask Spotify, not the last poll: it may have started playing since.
          const player = await api.playbackState();
          if (player?.is_playing) await api.pause();
        } catch (error) {
          if (!(error instanceof SpotifyApiError && error.reason === "NO_ACTIVE_DEVICE")) throw new Error(errorMessage(error));
        }
      }
      disengage();
    },
    /** Open the consent page again (the browser tab was closed or lost). */
    showSignIn: async () => {
      if (signIn) await args.openExternal(signIn.authorizeUrl).catch(() => {});
    },
    cancelSignIn: async () => {
      signIn?.cancel();
    },
    /** The Client ID changed: a session from the old one cannot be refreshed. */
    clientIdChanged: async () => {
      signIn?.cancel();
      signIn = null;
      await loadSession();
      if (session?.clientId !== normalizeSpotifyClientId(args.clientId())) await dropSession(null);
      state.message = null;
      syncAvailability();
      emit();
    },
    dispose: () => {
      disposed = true;
      stopPolling();
      signIn?.cancel();
      if (broadcastTimer) clearTimeout(broadcastTimer);
    },
  };
}
