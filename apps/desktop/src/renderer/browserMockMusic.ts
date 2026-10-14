import { MUSIC_CAPABILITIES, MUSIC_SPOTIFY_REDIRECT_URI, type MusicBridge, type MusicProvider, type MusicState } from "../shared/types/music";

/** Signed-out UI preview only. This never signs in, opens Spotify or plays audio. */
export function createBrowserMockMusic(): MusicBridge {
  let provider: MusicProvider = "apple";
  let clientId: string | null = null;
  const listeners = new Set<(state: MusicState) => void>();
  const state = (): MusicState => ({
    provider,
    capabilities: MUSIC_CAPABILITIES[provider],
    availability: provider === "spotify" && !clientId ? "unavailable" : "ready",
    authorized: false,
    connecting: false,
    message: provider === "spotify" && !clientId ? "Add your Spotify app's Client ID to connect Spotify." : null,
    spotify: { configured: Boolean(clientId), clientId, redirectUri: MUSIC_SPOTIFY_REDIRECT_URI, device: null },
    host: { status: "stopped", pid: null, unloadAt: null },
    playback: { state: "none", isPlaying: false, position: 0, positionAt: 0, duration: 0, nowPlaying: null, queuePosition: -1, queueLength: 0, shuffle: false, repeat: 0, volume: 1 },
    queueRevision: 0,
  });
  const emit = () => { for (const listener of listeners) listener(state()); };
  const unavailable = async () => ({ ok: false as const, error: "Music sign-in and playback need the ADE desktop app. This is a browser preview." });
  return {
    getState: async () => state(),
    selectProvider: async (next) => { provider = next; emit(); return state(); },
    configureSpotify: async ({ clientId: next }) => {
      if (next && !/^[a-f\d]{32}$/i.test(next)) return { ok: false, error: "Enter a valid Spotify Client ID." };
      clientId = next; emit(); return { ok: true };
    },
    warm: async () => {},
    connect: unavailable,
    disconnect: async () => {},
    command: unavailable,
    queue: async () => ({ position: -1, items: [] }),
    search: async () => ({ songs: [], albums: [], playlists: [], artists: [] }),
    library: async () => ({ items: [], nextOffset: null, total: 0 }),
    recent: async () => ({ containers: [], tracks: [] }),
    tracks: async () => ({ items: [], nextOffset: null, total: 0 }),
    rating: async () => null,
    setRating: async () => {},
    charts: async () => ({ songs: [], albums: [], playlists: [] }),
    account: async () => ({ storefront: null }),
    unload: async () => {},
    showSignIn: async () => {},
    cancelSignIn: async () => {},
    devices: async () => [],
    transfer: unavailable,
    openSpotify: unavailable,
    onState: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
