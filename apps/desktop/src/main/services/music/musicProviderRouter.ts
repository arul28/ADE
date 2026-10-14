import fs from "node:fs";
import path from "node:path";

import type {
  MusicCommand,
  MusicCommandResult,
  MusicConfigureSpotifyResult,
  MusicDevice,
  MusicLibraryKind,
  MusicProvider,
  MusicSearchScope,
  MusicState,
} from "../../../shared/types/music";
import { MUSIC_SPOTIFY_REDIRECT_URI } from "../../../shared/types/music";
import type { MusicService } from "./musicService";
import { normalizeSpotifyClientId } from "./spotifyAuth";
import type { SpotifyService } from "./spotifyService";

/**
 * One `window.ade.music` for two providers. Every call goes to the selected
 * provider, and only its state reaches the renderer, decorated with what the
 * picker and the setup page need (`provider`, `capabilities`, `providers`,
 * `spotify`).
 *
 * The choice and the Spotify Client ID are plain settings in
 * `<userData>/music-player/music-settings.json`: neither is a secret (a PKCE
 * client has no secret). Switching pauses the provider that is playing, so
 * two never play at once.
 */

type Settings = { provider: MusicProvider; spotifyClientId: string | null };

const SETTINGS_FILE = "music-settings.json";

function createMusicSettings(dir: string, logger?: { warn: (event: string, data?: Record<string, unknown>) => void }) {
  const file = path.join(dir, SETTINGS_FILE);
  let value: Settings = { provider: "apple", spotifyClientId: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Settings>;
    value = {
      provider: parsed.provider === "spotify" ? "spotify" : "apple",
      spotifyClientId: normalizeSpotifyClientId(parsed.spotifyClientId),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger?.warn("music.settings_unreadable", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    get: (): Settings => value,
    /** Persist, then remember: a write that fails leaves the old value in force. */
    set: (next: Partial<Settings>) => {
      const merged = { ...value, ...next };
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
      fs.renameSync(tmp, file);
      value = merged;
    },
  };
}

export type MusicSettingsStore = ReturnType<typeof createMusicSettings>;
export { createMusicSettings };

export type MusicRouter = ReturnType<typeof createMusicRouter>;

export function createMusicRouter(args: {
  apple: MusicService;
  spotify: SpotifyService;
  settings: MusicSettingsStore;
  broadcast: (state: MusicState) => void;
  logger?: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
}) {
  const latest: Record<MusicProvider, MusicState | null> = { apple: null, spotify: null };
  /** The Music tab is open (it called `warm` and has not called `unload` since). */
  let tabOpen = false;
  let switching: Promise<void> | null = null;

  const selected = (): MusicProvider => args.settings.get().provider;

  const decorate = (provider: MusicProvider, state: MusicState): MusicState => {
    const clientId = args.settings.get().spotifyClientId;
    return {
      ...state,
      provider,
      spotify: {
        configured: Boolean(clientId),
        clientId,
        redirectUri: MUSIC_SPOTIFY_REDIRECT_URI,
        device: provider === "spotify" ? args.spotify.currentDevice() : null,
      },
    };
  };

  const push = () => {
    const provider = selected();
    const state = latest[provider];
    if (state) args.broadcast(decorate(provider, state));
  };

  /** Each provider's own broadcasts land here; only the selected one's reach the renderer. */
  const onProviderState = (provider: MusicProvider, state: MusicState) => {
    latest[provider] = state;
    if (provider === selected()) push();
  };

  /** What both services do alike; the calls that differ are routed by hand below. */
  type SharedCalls = Pick<MusicService & SpotifyService, "warm" | "connect" | "disconnect" | "command" | "queue" | "library" | "recent" | "showSignIn" | "cancelSignIn">;
  const current = (): SharedCalls => (selected() === "apple" ? args.apple : args.spotify);

  const getState = async (): Promise<MusicState> => {
    const provider = selected();
    const state = provider === "apple" ? await args.apple.getState() : await args.spotify.getState();
    latest[provider] = state;
    return decorate(provider, state);
  };

  const selectProvider = async (provider: MusicProvider): Promise<MusicState> => {
    if (switching) await switching;
    if (provider !== selected()) {
      const previous = selected();
      switching = (async () => {
        // A sign-in still open for the old provider must not finish unseen.
        await (previous === "apple" ? args.apple.cancelSignIn() : args.spotify.cancelSignIn()).catch(() => {});
        // Two players never play at once: pause (and for Apple, unload) the old
        // one. Apple's unload always stops its host; a Spotify pause that fails
        // (other than "no device") keeps Spotify selected and says why.
        try {
          if (previous === "apple") await args.apple.unloadPlayer();
          else await args.spotify.pauseForSwitch();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          args.logger?.warn("music.provider_pause_failed", { provider: previous, error: message });
          const name = previous === "apple" ? "Apple Music" : "Spotify";
          throw new Error(`ADE couldn't pause ${name}, so it stayed on ${name}: ${message}`);
        }
        args.settings.set({ provider });
        args.logger?.info("music.provider_selected", { provider });
        if (tabOpen) await (provider === "apple" ? args.apple.warm() : args.spotify.warm());
      })();
      try {
        await switching;
      } finally {
        switching = null;
      }
    }
    const state = await getState();
    args.broadcast(state);
    return state;
  };

  const configureSpotify = async (input: { clientId: string | null }): Promise<MusicConfigureSpotifyResult> => {
    const raw = input.clientId?.trim() ?? "";
    const clientId = raw ? normalizeSpotifyClientId(raw) : null;
    if (raw && !clientId) {
      return { ok: false, error: "That isn't a Spotify Client ID. Copy the 32-character Client ID from your app's page on developer.spotify.com." };
    }
    if (clientId === args.settings.get().spotifyClientId) return { ok: true };
    try {
      args.settings.set({ spotifyClientId: clientId });
    } catch (error) {
      return { ok: false, error: `ADE couldn't save the Client ID: ${error instanceof Error ? error.message : String(error)}` };
    }
    await args.spotify.clientIdChanged();
    latest.spotify = await args.spotify.getState();
    push();
    return { ok: true };
  };

  const notSpotify = (): MusicCommandResult => ({ ok: false, error: "Choosing a device works with Spotify." });

  return {
    onAppleState: (state: MusicState) => onProviderState("apple", state),
    onSpotifyState: (state: MusicState) => onProviderState("spotify", state),
    /** The selected provider. */
    provider: selected,
    getState,
    selectProvider,
    configureSpotify,
    warm: async () => {
      tabOpen = true;
      if (switching) await switching;
      return current().warm();
    },
    connect: () => current().connect(),
    disconnect: () => current().disconnect(),
    command: (command: MusicCommand) => current().command(command),
    queue: () => current().queue(),
    search: (input: { term: string; scope: MusicSearchScope; limit?: number }) => {
      if (selected() === "apple") return args.apple.search(input);
      // Spotify has no library search.
      if (input.scope === "library") return Promise.resolve({ songs: [], albums: [], playlists: [], artists: [] });
      return args.spotify.search(input);
    },
    library: (input: { kind: MusicLibraryKind; offset?: number; limit?: number }) => current().library(input),
    recent: () => current().recent(),
    tracks: (input: { kind: "album" | "playlist"; id: string; library: boolean; offset?: number; limit?: number }) =>
      selected() === "apple" ? args.apple.tracks(input) : args.spotify.tracks(input),
    rating: (input: { id: string; library: boolean }) =>
      selected() === "apple" ? args.apple.rating(input) : args.spotify.rating(input),
    setRating: (input: { id: string; library: boolean; liked: boolean | null }) =>
      selected() === "apple" ? args.apple.setRating(input) : args.spotify.setRating(input),
    charts: () =>
      selected() === "apple" ? args.apple.charts() : Promise.resolve({ songs: [], albums: [], playlists: [] }),
    account: () => (selected() === "apple" ? args.apple.account() : Promise.resolve({ storefront: null })),
    unload: async () => {
      tabOpen = false;
      return selected() === "apple" ? args.apple.unloadPlayer() : args.spotify.unloadPlayer();
    },
    showSignIn: () => current().showSignIn(),
    cancelSignIn: () => current().cancelSignIn(),
    devices: (): Promise<MusicDevice[]> => (selected() === "spotify" ? args.spotify.devices() : Promise.resolve([])),
    transfer: (input: { deviceId: string; play?: boolean }) =>
      selected() === "spotify" ? args.spotify.transfer(input) : Promise.resolve(notSpotify()),
    dispose: async () => {
      args.spotify.dispose();
      await args.apple.dispose();
    },
  };
}
