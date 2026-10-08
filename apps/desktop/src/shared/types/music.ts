/**
 * The Music feature's contract between the main process and the renderer.
 *
 * Apple Music plays in a separate player host (WebView2 on Windows; WKWebView
 * on macOS later) that the main process starts on demand and unloads when idle.
 * Catalog and library reads go straight from the main process to the Apple
 * Music API, so browsing never needs the host. See docs/features/music/README.md.
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
  stateEvent: "ade.music.state",
} as const;

/**
 * Where the feature stands, in the order a user meets it.
 * - `unsupported`: this platform has no player host yet (macOS today).
 * - `unavailable`: no developer token (signed out of ADE, the token service is
 *   down, or the host binary is missing). `message` says which.
 * - `ready`: catalog works. `authorized` says whether the library and playback do.
 */
export type MusicAvailability = "unsupported" | "unavailable" | "ready";

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
  /** Apple's template, with `{w}` and `{h}` placeholders. Use `musicArtworkUrl()`. */
  url: string;
  width: number | null;
  height: number | null;
  bgColor: string | null;
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
};

export type MusicRepeatMode = 0 | 1 | 2; // none, one, all

export type MusicState = {
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

export type MusicPage = {
  items: MusicItem[];
  /** Offset for the next page, or null at the end. */
  nextOffset: number | null;
  total: number | null;
};

export type MusicRecent = { containers: MusicItem[]; tracks: MusicItem[] };

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
  tracks: (args: { kind: "album" | "playlist"; id: string; library: boolean }) => Promise<MusicItem[]>;
  /** The like state of a song: true liked, false disliked, null neither. */
  rating: (args: { id: string; library: boolean }) => Promise<boolean | null>;
  setRating: (args: { id: string; library: boolean; liked: boolean | null }) => Promise<void>;
  onState: (cb: (state: MusicState) => void) => () => void;
};

/** An Apple artwork template at a pixel size (use 2x the CSS size). */
export function musicArtworkUrl(artwork: MusicArtwork | null | undefined, size: number): string | null {
  if (!artwork?.url) return null;
  const px = String(Math.max(16, Math.round(size)));
  return artwork.url.replace("{w}", px).replace("{h}", px).replace("{f}", "jpg").replace("{c}", "bb");
}

/** The playback position now, interpolated from the last report while playing. */
export function musicPositionNow(playback: MusicState["playback"], now = Date.now()): number {
  if (!playback.isPlaying) return playback.position;
  const advanced = playback.position + Math.max(0, now - playback.positionAt) / 1000;
  return playback.duration > 0 ? Math.min(playback.duration, advanced) : advanced;
}
