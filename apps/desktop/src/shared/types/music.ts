/**
 * The Music feature's contract between the main process and the renderer.
 *
 * Two providers sit behind one bridge; the main process routes every call to
 * the selected one (`selectProvider`) and pushes only its state.
 * - Apple Music plays in a separate player host (WebView2 on Windows,
 *   WKWebView on macOS) that the main process starts on demand and unloads
 *   when idle. Catalog and library reads go straight from the main process to
 *   the Apple Music API, so browsing never needs the host.
 * - Spotify does not play inside ADE. ADE drives a Spotify Connect device (the
 *   Spotify app on this computer, a phone, a speaker) through the Web API, so
 *   it needs Spotify Premium and a running Spotify device, and nothing DRM
 *   runs here. Item ids are Spotify URIs (`spotify:track:…`).
 * See docs/features/music/README.md.
 */

export const MUSIC_IPC = {
  getState: "ade.music.getState",
  warm: "ade.music.warm",
  connect: "ade.music.connect",
  disconnect: "ade.music.disconnect",
  command: "ade.music.command",
  queue: "ade.music.queue",
  search: "ade.music.search",
  library: "ade.music.library",
  recent: "ade.music.recent",
  tracks: "ade.music.tracks",
  rating: "ade.music.rating",
  setRating: "ade.music.setRating",
  charts: "ade.music.charts",
  account: "ade.music.account",
  unload: "ade.music.unload",
  showSignIn: "ade.music.showSignIn",
  cancelSignIn: "ade.music.cancelSignIn",
  selectProvider: "ade.music.selectProvider",
  configureSpotify: "ade.music.configureSpotify",
  devices: "ade.music.devices",
  transfer: "ade.music.transfer",
  openSpotify: "ade.music.openSpotify",
  stateEvent: "ade.music.state",
} as const;

export type MusicProvider = "apple" | "spotify";

export const MUSIC_PROVIDERS: readonly MusicProvider[] = ["apple", "spotify"];

/**
 * What the selected provider can do. The UI hides what a provider cannot do
 * instead of showing a control that fails.
 */
export type MusicCapabilities = {
  /** `charts()` returns popular items. Spotify: false (no charts API). */
  charts: boolean;
  /** Search and album/playlist pages work before Connect. Spotify: false. */
  catalogBeforeConnect: boolean;
  /** Playback works before Connect (Apple: 30-second previews). */
  previewsBeforeConnect: boolean;
  /** `scope: "library"` search. Spotify: false (no library search API). */
  librarySearch: boolean;
  /** `playNext` and `playLater` are distinct. Spotify has one "Add to queue" (use `playLater`). */
  playNext: boolean;
  /** `playAt` jumps within the Up Next list. Spotify: false. */
  playAt: boolean;
  /** `setRating` with `liked: false` (dislike). Spotify: false (save / remove only). */
  dislike: boolean;
  /** Playback runs on another device that `devices()` and `transfer()` choose. */
  devices: boolean;
  /** Connect opens a sign-in window ADE can bring forward (`showSignIn`). Spotify signs in in the default browser. */
  signInWindow: boolean;
  /** Repeat one / all and shuffle. */
  repeat: boolean;
  shuffle: boolean;
};

export const MUSIC_CAPABILITIES: Record<MusicProvider, MusicCapabilities> = {
  apple: {
    charts: true,
    catalogBeforeConnect: true,
    previewsBeforeConnect: true,
    librarySearch: true,
    playNext: true,
    playAt: true,
    dislike: true,
    devices: false,
    signInWindow: true,
    repeat: true,
    shuffle: true,
  },
  spotify: {
    charts: false,
    catalogBeforeConnect: false,
    previewsBeforeConnect: false,
    librarySearch: false,
    playNext: false,
    playAt: false,
    dislike: false,
    devices: true,
    signInWindow: false,
    repeat: true,
    shuffle: true,
  },
};

/** One provider's standing, for the provider picker. */
export type MusicProviderSummary = {
  availability: MusicAvailability;
  authorized: boolean;
  message: string | null;
};

/** A Spotify Connect device, as `GET /me/player/devices` lists it. */
export type MusicDevice = {
  id: string;
  name: string;
  /** Spotify's type: "Computer", "Smartphone", "Speaker", "TV", … */
  type: string;
  isActive: boolean;
  /** Spotify refuses commands to this device (some restricted devices). */
  isRestricted: boolean;
  /** 0..1, or null when the device does not report or allow volume. */
  volume: number | null;
  supportsVolume: boolean;
};

/** Spotify's own part of `MusicState` (present whenever the state carries `provider`). */
export type MusicSpotifyState = {
  /** A Spotify app Client ID is set (the user's own app from developer.spotify.com). */
  configured: boolean;
  clientId: string | null;
  /**
   * The redirect URI to register in that Spotify app, exactly. ADE listens on
   * this loopback address with a port chosen per sign-in, which Spotify allows
   * for 127.0.0.1 when the URI is registered without a port.
   */
  redirectUri: string;
  /** The device playback runs on, when Spotify reports one. */
  device: MusicDevice | null;
};

/** The redirect URI to register in the Spotify app (no port: ADE picks one per sign-in). */
export const MUSIC_SPOTIFY_REDIRECT_URI = "http://127.0.0.1/spotify/callback";

export type MusicConfigureSpotifyResult = { ok: true } | { ok: false; error: string };

/**
 * Where the feature stands, in the order a user meets it.
 * - `unsupported`: this platform has no player host (Apple Music off Windows and macOS).
 * - `unavailable`: no developer token (signed out of ADE, the token service is
 *   down, or the host binary is missing). `message` says which.
 * - `ready`: catalog works. `authorized` says whether the library and playback do.
 */
export type MusicAvailability = "unsupported" | "unavailable" | "ready";

/** The state's `message` when Spotify needs a Client ID before Connect. */
export const MUSIC_SPOTIFY_NOT_CONFIGURED = "Add your Spotify app's Client ID to connect Spotify.";

/** The player host's own lifecycle. `suspended` = unloaded with a track kept to resume. */
export type MusicHostStatus = "stopped" | "starting" | "running" | "suspended" | "failed";

export type MusicPlaybackState =
  | "none"
  | "loading"
  | "playing"
  | "paused"
  | "stopped"
  | "ended"
  | "seeking"
  | "waiting"
  | "stalled"
  | "completed";

export type MusicItemKind = "song" | "album" | "playlist" | "artist" | "station";

export type MusicArtwork = {
  /** Apple's template, with `{w}` and `{h}` placeholders; for Spotify the largest image. Use `musicArtworkUrl()`. */
  url: string;
  width: number | null;
  height: number | null;
  bgColor: string | null;
  /** Fixed-size images (Spotify), any order. `musicArtworkUrl()` picks the smallest that covers the size. */
  sizes?: Array<{ url: string; width: number | null }>;
};

export type MusicItem = {
  /** The id to play: a catalog id or a library id (`i.…`, `l.…`, `p.…`). */
  id: string;
  kind: MusicItemKind;
  title: string;
  /** Artist for songs and albums, curator or "Playlist" for playlists. */
  subtitle: string;
  album: string | null;
  artwork: MusicArtwork | null;
  durationMs: number | null;
  /** True for an item from the user's library. */
  library: boolean;
  /** The catalog id behind a library item, when Apple provides it. Ratings use it. */
  catalogId: string | null;
  trackCount: number | null;
  releaseYear: number | null;
  explicit: boolean;
  /**
   * The item's page on the provider's site (Spotify: open.spotify.com). Spotify
   * requires its metadata and artwork to link back there; show "Open in Spotify".
   */
  externalUrl?: string | null;
};

export type MusicNowPlaying = {
  id: string;
  title: string;
  artist: string;
  album: string;
  artwork: MusicArtwork | null;
  durationMs: number | null;
  library: boolean;
  catalogId: string | null;
  externalUrl?: string | null;
};

export type MusicRepeatMode = 0 | 1 | 2; // none, one, all

export type MusicState = {
  /** The provider this state describes (the selected one). Absent means Apple Music. */
  provider?: MusicProvider;
  /** What the selected provider can do. Absent means Apple Music's. */
  capabilities?: MusicCapabilities;
  /** Every provider's standing, for the picker. */
  providers?: Record<MusicProvider, MusicProviderSummary>;
  /** Spotify's setup and device; present when the state carries `provider`. */
  spotify?: MusicSpotifyState;
  availability: MusicAvailability;
  /** Why the feature is unavailable or what last failed, in plain words. */
  message: string | null;
  /** The user connected Apple Music (a Music-User-Token is stored). */
  authorized: boolean;
  /** A Connect Apple Music sign-in window is open. */
  connecting: boolean;
  host: {
    status: MusicHostStatus;
    pid: number | null;
    /** When the idle unload fires, epoch ms; null while playing or stopped. */
    unloadAt: number | null;
  };
  playback: {
    state: MusicPlaybackState;
    isPlaying: boolean;
    /** Seconds at `positionAt`. Interpolate with `musicPositionNow()` while playing. */
    position: number;
    positionAt: number;
    duration: number;
    nowPlaying: MusicNowPlaying | null;
    queuePosition: number;
    queueLength: number;
    shuffle: boolean;
    repeat: MusicRepeatMode;
    volume: number;
  };
  /** Bumps whenever the queue's items or position change, so views refetch. */
  queueRevision: number;
};

export type MusicCommand =
  | { type: "toggle" }
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; position: number }
  | { type: "volume"; value: number }
  | { type: "shuffle"; on: boolean }
  | { type: "repeat"; mode: MusicRepeatMode }
  | { type: "playAt"; index: number }
  /** Play these songs as the new queue, starting at `index`. */
  | { type: "playItems"; ids: string[]; index?: number; shuffle?: boolean }
  /** Play an album, playlist or station by id, starting at track `index`. */
  | { type: "playCollection"; kind: "album" | "playlist" | "station"; id: string; index?: number; shuffle?: boolean }
  | { type: "playNext"; ids: string[] }
  | { type: "playLater"; ids: string[] };

export type MusicCommandResult = { ok: true } | { ok: false; error: string };

export type MusicQueue = { position: number; items: MusicItem[] };

export type MusicSearchScope = "catalog" | "library";

export type MusicSearchResult = {
  songs: MusicItem[];
  albums: MusicItem[];
  playlists: MusicItem[];
  artists: MusicItem[];
};

export type MusicLibraryKind = "playlists" | "albums" | "songs";

/** A collection (album or playlist) is read up to this many songs, 100 per page. */
export const MUSIC_MAX_COLLECTION_TRACKS = 2_000;

export type MusicPage = {
  items: MusicItem[];
  /** Offset for the next page, or null at the end. */
  nextOffset: number | null;
  total: number | null;
};

export type MusicRecent = { containers: MusicItem[]; tracks: MusicItem[] };

/** Popular catalog items for the storefront; needs only the developer token. */
export type MusicCharts = { songs: MusicItem[]; albums: MusicItem[]; playlists: MusicItem[] };

/** The connected account, as far as Apple's API says. */
export type MusicAccount = { storefront: { id: string; name: string | null } | null };

export type MusicConnectResult = { ok: true } | { ok: false; error: string; cancelled?: boolean };

/** What `window.ade.music` exposes to the renderer. */
export type MusicBridge = {
  getState: () => Promise<MusicState>;
  /** Start the player host ahead of a play (the Music tab calls this on open). */
  warm: () => Promise<void>;
  connect: () => Promise<MusicConnectResult>;
  disconnect: () => Promise<void>;
  command: (command: MusicCommand) => Promise<MusicCommandResult>;
  queue: () => Promise<MusicQueue>;
  search: (args: { term: string; scope: MusicSearchScope; limit?: number }) => Promise<MusicSearchResult>;
  library: (args: { kind: MusicLibraryKind; offset?: number; limit?: number }) => Promise<MusicPage>;
  recent: () => Promise<MusicRecent>;
  /** One page of an album's or playlist's songs (`limit` up to 100); read on with `nextOffset`. */
  tracks: (args: { kind: "album" | "playlist"; id: string; library: boolean; offset?: number; limit?: number }) => Promise<MusicPage>;
  /** The like state of a song: true liked, false disliked, null neither. */
  rating: (args: { id: string; library: boolean }) => Promise<boolean | null>;
  setRating: (args: { id: string; library: boolean; liked: boolean | null }) => Promise<void>;
  /** Popular albums, playlists and songs (works before Connect). */
  charts: () => Promise<MusicCharts>;
  /** The connected account's storefront (region); null fields before Connect. */
  account: () => Promise<MusicAccount>;
  /** Stop playback and unload the player now, keeping the queue to resume. */
  unload: () => Promise<void>;
  /** Bring Apple's sign-in window to the front while Connect waits. */
  showSignIn: () => Promise<void>;
  /** Close Apple's sign-in window, which ends Connect as cancelled. */
  cancelSignIn: () => Promise<void>;
  /** Switch provider: pauses the one playing, remembers the choice, resolves with the new state. */
  selectProvider: (provider: MusicProvider) => Promise<MusicState>;
  /** Set (or clear with null) the Spotify app Client ID. Changing it signs Spotify out. */
  configureSpotify: (args: { clientId: string | null }) => Promise<MusicConfigureSpotifyResult>;
  /** Spotify Connect devices; empty for Apple Music. */
  devices: () => Promise<MusicDevice[]>;
  /** Move Spotify playback to a device (`play` keeps it playing there, default true). */
  transfer: (args: { deviceId: string; play?: boolean }) => Promise<MusicCommandResult>;
  /** Start the Spotify app on this computer and wait for it to appear as a device. */
  openSpotify: () => Promise<MusicCommandResult>;
  onState: (cb: (state: MusicState) => void) => () => void;
};

/** An Apple artwork template at a pixel size (use 2x the CSS size). */
export function musicArtworkUrl(artwork: MusicArtwork | null | undefined, size: number): string | null {
  if (!artwork?.url) return null;
  if (artwork.sizes?.length) {
    const sized = [...artwork.sizes].sort((a, b) => (a.width ?? Infinity) - (b.width ?? Infinity));
    return (sized.find((image) => (image.width ?? Infinity) >= size) ?? sized[sized.length - 1]!).url;
  }
  const px = String(Math.max(16, Math.round(size)));
  return artwork.url.replace("{w}", px).replace("{h}", px).replace("{f}", "jpg").replace("{c}", "bb");
}

/** The playback position now, interpolated from the last report while playing. */
export function musicPositionNow(playback: MusicState["playback"], now = Date.now()): number {
  if (!playback.isPlaying) return playback.position;
  const advanced = playback.position + Math.max(0, now - playback.positionAt) / 1000;
  return playback.duration > 0 ? Math.min(playback.duration, advanced) : advanced;
}
