import { useEffect, useState } from "react";
import { create } from "zustand";

import {
  musicArtworkUrl,
  musicPositionNow,
  type MusicCommand,
  type MusicCommandResult,
  type MusicConnectResult,
  type MusicNowPlaying,
  type MusicRepeatMode,
  type MusicState,
} from "../../../shared/types/music";
import { isWebClientMode } from "../../lib/webClientMode";

/**
 * The renderer's one view of Apple Music. Every surface reads it: the Music tab,
 * the top-bar mini player, and the home page's Now Playing widget.
 *
 * - `useMusicState(selector)`: the live `MusicState` (null until the first read).
 * - `useMusicNowPlaying()`: just what a compact player needs.
 * - `useMusicPosition()`: the playback second, ticking while playing.
 * - `musicActions`: transport, queue, Connect, and `open()` for the Music tab.
 *
 * One IPC subscription serves every component, opened the first time any of
 * them mounts. The main process pushes state on change and once a second while
 * playing; the position hook interpolates between pushes.
 */

type Store = {
  state: MusicState | null;
  lastError: string | null;
  /** Love state per rating id, shared by every Love button. */
  likes: Record<string, boolean | null>;
};

const useMusicStore = create<Store>(() => ({ state: null, lastError: null, likes: {} }));

/** The last state the main process sent. `state` is this, unless a dev preview is on. */
let realState: MusicState | null = null;

function sameNowPlaying(a: MusicNowPlaying | null, b: MusicNowPlaying | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.durationMs === b.durationMs &&
    a.library === b.library &&
    a.catalogId === b.catalogId &&
    a.artwork?.url === b.artwork?.url &&
    a.artwork?.bgColor === b.artwork?.bgColor
  );
}

/**
 * Keep the previous objects for the parts that did not change. The main process
 * pushes a fresh state once a second while playing; reusing `nowPlaying` and
 * `host` keeps selectors on them stable, so only position readers re-render.
 */
function share(prev: MusicState | null, next: MusicState | null): MusicState | null {
  if (!prev || !next) return next;
  const nowPlaying = sameNowPlaying(prev.playback.nowPlaying, next.playback.nowPlaying)
    ? prev.playback.nowPlaying
    : next.playback.nowPlaying;
  const host =
    prev.host.status === next.host.status && prev.host.pid === next.host.pid && prev.host.unloadAt === next.host.unloadAt
      ? prev.host
      : next.host;
  if (nowPlaying === next.playback.nowPlaying && host === next.host) return next;
  return { ...next, host, playback: { ...next.playback, nowPlaying } };
}

function publish(): void {
  const next = devPreview ? previewState(realState, devPreview) : realState;
  useMusicStore.setState((s) => ({ state: share(s.state, next) }));
}

let subscribed = false;
function ensureSubscription(): void {
  if (subscribed) return;
  const bridge = musicBridge();
  if (!bridge) return;
  subscribed = true;
  bridge.onState((state) => {
    realState = state;
    publish();
  });
  void bridge.getState().then(
    (state) => {
      // An event that arrived first is newer than this read.
      if (realState) return;
      realState = state;
      publish();
    },
    () => {},
  );
  if (import.meta.env.DEV) installDevPreview();
}

function musicBridge() {
  if (typeof window === "undefined" || isWebClientMode()) return null;
  return window.ade?.music ?? null;
}

/** Music exists in this window (desktop app with the bridge). */
export function musicAvailable(): boolean {
  return musicBridge() !== null;
}

export function useMusicState<T>(selector: (state: MusicState | null) => T): T {
  useEffect(ensureSubscription, []);
  return useMusicStore((s) => selector(s.state));
}

export function useMusicLastError(): string | null {
  return useMusicStore((s) => s.lastError);
}

export type MusicNowPlayingView = {
  /** False on platforms or windows without Music. */
  available: boolean;
  nowPlaying: MusicNowPlaying | null;
  isPlaying: boolean;
  /** The player is loading or buffering. */
  busy: boolean;
  duration: number;
  /** Artwork URL at a CSS pixel size (2x is applied for you). */
  artworkUrl: (cssPx: number) => string | null;
};

export function useMusicNowPlaying(): MusicNowPlayingView {
  // Primitive selectors: a once-a-second position push does not re-render callers.
  const hasState = useMusicState((s) => s !== null);
  const supported = useMusicState((s) => s?.availability !== "unsupported");
  const nowPlaying = useMusicState((s) => s?.playback.nowPlaying ?? null);
  const isPlaying = useMusicState((s) => Boolean(s?.playback.isPlaying));
  const playbackState = useMusicState((s) => s?.playback.state ?? "none");
  const duration = useMusicState((s) => s?.playback.duration ?? 0);
  return {
    available: hasState && supported && musicAvailable(),
    nowPlaying,
    isPlaying,
    busy: playbackState === "loading" || playbackState === "waiting" || playbackState === "stalled",
    duration,
    artworkUrl: (cssPx: number) => musicArtworkUrl(nowPlaying?.artwork, cssPx * 2),
  };
}

/** The playback position in seconds, re-rendering every `intervalMs` while playing. */
export function useMusicPosition(intervalMs = 500): number {
  const playback = useMusicState((s) => s?.playback ?? null);
  const [, setTick] = useState(0);
  const playing = Boolean(playback?.isPlaying);
  useEffect(() => {
    if (!playing) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [playing, intervalMs]);
  return playback ? musicPositionNow(playback) : 0;
}

/**
 * Plain words for a Music failure. Raw exception text (IPC wrappers, Electron
 * internals, HTTP codes) never reaches the Music UI: known causes get their own
 * sentence and anything else a generic one.
 */
export function friendlyMusicError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  const rules: Array<[RegExp, string]> = [
    [/safeStorage|decrypt|ciphertext|credential/i, "ADE couldn't read your saved Apple Music sign-in. Connect again to fix it."],
    [/cancel/i, "Sign-in was cancelled."],
    [/already open/i, "The Apple sign-in window is already open."],
    [/closed before it finished/i, "The Apple sign-in window was closed before it finished."],
    [/connect again|401/i, "Apple Music needs you to connect again."],
    [/subscription|403/i, "Playing full songs needs an Apple Music subscription."],
    [/connect apple music to play/i, "Connect Apple Music to play songs."],
    [/connect apple music to see/i, "Connect Apple Music to see your library."],
    [/rate limit|429/i, "Apple Music is busy right now. Try again in a minute."],
    [/timed? ?out|timeout|took too long|didn't load in time/i, "Apple Music took too long to answer. Try again."],
    [/reach|network|fetch failed|ENOTFOUND|ECONN|offline|connection/i, "Couldn't reach Apple Music. Check your connection and try again."],
    [/musickit/i, "Couldn't load Apple's music player. Check your connection and try again."],
    [/couldn't find|404/i, "Apple Music couldn't find that."],
  ];
  for (const [pattern, message] of rules) if (pattern.test(text)) return message;
  // Already a sentence written for people (the main process writes these).
  const looksRaw = /Error|exception|\bat \S+ \(|[{}<>]|_[A-Z]{3,}|^[A-Z_]{4,}/.test(text) || text.length > 140;
  return looksRaw ? "Something went wrong with Apple Music. Try again." : text;
}

async function run(command: MusicCommand): Promise<MusicCommandResult> {
  if (devPreview) return applyPreviewCommand(command);
  const bridge = musicBridge();
  if (!bridge) return { ok: false, error: "Music isn't available in this window." };
  const result = await bridge.command(command).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  useMusicStore.setState({ lastError: result.ok ? null : friendlyMusicError(result.error) });
  return result;
}

/** Navigation hook for `musicActions.open`, set by the app shell. */
let openMusicTab: (() => void) | null = null;
export function setMusicTabOpener(opener: (() => void) | null): void {
  openMusicTab = opener;
}

export const musicActions = {
  toggle: () => run({ type: "toggle" }),
  play: () => run({ type: "play" }),
  pause: () => run({ type: "pause" }),
  next: () => run({ type: "next" }),
  previous: () => run({ type: "previous" }),
  seek: (position: number) => run({ type: "seek", position }),
  setVolume: (value: number) => run({ type: "volume", value }),
  setShuffle: (on: boolean) => run({ type: "shuffle", on }),
  setRepeat: (mode: MusicRepeatMode) => run({ type: "repeat", mode }),
  playAt: (index: number) => run({ type: "playAt", index }),
  playItems: (ids: string[], index = 0, shuffle?: boolean) => run({ type: "playItems", ids, index, shuffle }),
  playCollection: (kind: "album" | "playlist" | "station", id: string, index = 0, shuffle?: boolean) =>
    run({ type: "playCollection", kind, id, index, shuffle }),
  playNext: (ids: string[]) => run({ type: "playNext", ids }),
  playLater: (ids: string[]) => run({ type: "playLater", ids }),
  connect: async (): Promise<MusicConnectResult> => {
    const bridge = musicBridge();
    if (!bridge) return { ok: false, error: "Music isn't available in this window." };
    const result = await bridge.connect().catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      cancelled: false,
    }));
    useMusicStore.setState({ lastError: result.ok || result.cancelled ? null : friendlyMusicError(result.error) });
    return result;
  },
  /** Bring Apple's sign-in window to the front (it can open behind ADE). */
  showSignIn: () => {
    void musicBridge()?.showSignIn().catch(() => {});
  },
  /** Close Apple's sign-in window, which cancels Connect. */
  cancelSignIn: () => {
    void musicBridge()?.cancelSignIn().catch(() => {});
  },
  /** Music closed (the tab): pause and unload the player, keeping the queue to resume. */
  unload: () => {
    void musicBridge()?.unload().catch(() => {});
  },
  disconnect: async () => {
    await musicBridge()?.disconnect();
  },
  /** Start the player ahead of a play. Cheap when it is already running. */
  warm: () => {
    void musicBridge()?.warm();
  },
  /** Show the Music tab. */
  open: () => {
    openMusicTab?.();
  },
  clearError: () => useMusicStore.setState({ lastError: null }),
  /** Re-read the state (re-checks availability after a sign-in or a fixed connection). */
  refresh: async () => {
    const bridge = musicBridge();
    if (!bridge) return;
    realState = await bridge.getState();
    publish();
  },
};

export type MusicLikeView = {
  /** True liked, false disliked, null neither (or not read yet). */
  liked: boolean | null;
  /** A song is loaded and Apple Music is connected. */
  canLike: boolean;
  toggle: () => void;
};

/** The Love state of the song that is playing, read from Apple once per song and toggled in place. */
export function useMusicLike(): MusicLikeView {
  const nowPlaying = useMusicState((s) => s?.playback.nowPlaying ?? null);
  const authorized = useMusicState((s) => Boolean(s?.authorized));
  const ratingId = nowPlaying ? (nowPlaying.catalogId ?? nowPlaying.id) : null;
  const ratingLibrary = Boolean(nowPlaying && !nowPlaying.catalogId && nowPlaying.library);
  const liked = useMusicStore((s) => (ratingId ? (s.likes[ratingId] ?? null) : null));
  useEffect(() => {
    if (ratingId && authorized) loadLike(ratingId, ratingLibrary);
  }, [authorized, ratingId, ratingLibrary]);
  return {
    liked,
    canLike: Boolean(ratingId && authorized),
    toggle: () => {
      if (!ratingId) return;
      const before = liked;
      const next = liked === true ? null : true;
      setLike(ratingId, next);
      if (devPreview) return;
      musicBridge()
        ?.setRating({ id: ratingId, library: ratingLibrary, liked: next })
        .catch(() => setLike(ratingId, before));
    },
  };
}

function setLike(id: string, liked: boolean | null): void {
  useMusicStore.setState((s) => ({ likes: { ...s.likes, [id]: liked } }));
}

const likeReads = new Set<string>();
function loadLike(id: string, library: boolean): void {
  if (likeReads.has(id) || devPreview) return;
  likeReads.add(id);
  musicBridge()
    ?.rating({ id, library })
    .then(
      (value) => {
        if (!(id in useMusicStore.getState().likes)) setLike(id, value);
      },
      () => likeReads.delete(id),
    );
}

/* ---------- Dev-only player preview ----------
 * Playback needs an Apple Music sign-in, so a dev build can render the player
 * with a catalog song's metadata without playing anything:
 *   window.__adeMusicPreview("Clair de Lune")   // remembered in localStorage "ade.music.devPreview"
 *   window.__adeMusicPreview(null)              // back to the real state
 * Transport commands then act on the preview locally. `import.meta.env.DEV` is
 * false in a packaged build, so the install call is compiled out and none of
 * this runs there.
 */

type MusicPreview = { playback: MusicState["playback"] };
let devPreview: MusicPreview | null = null;
const DEV_PREVIEW_KEY = "ade.music.devPreview";

function previewState(base: MusicState | null, preview: MusicPreview): MusicState {
  return {
    availability: "ready",
    message: null,
    connecting: false,
    queueRevision: 0,
    ...base,
    authorized: true,
    host: { status: "running", pid: null, unloadAt: null },
    playback: preview.playback,
  };
}

function applyPreviewCommand(command: MusicCommand): MusicCommandResult {
  if (!devPreview) return { ok: true };
  const now = Date.now();
  const playback = devPreview.playback;
  const position = musicPositionNow(playback, now);
  const set = (patch: Partial<MusicState["playback"]>) => {
    devPreview = { playback: { ...playback, position, positionAt: now, ...patch } };
    publish();
  };
  switch (command.type) {
    case "toggle":
      set({ isPlaying: !playback.isPlaying, state: playback.isPlaying ? "paused" : "playing" });
      break;
    case "play":
      set({ isPlaying: true, state: "playing" });
      break;
    case "pause":
      set({ isPlaying: false, state: "paused" });
      break;
    case "seek":
      set({ position: Math.max(0, Math.min(playback.duration, command.position)) });
      break;
    case "volume":
      set({ volume: Math.max(0, Math.min(1, command.value)) });
      break;
    case "shuffle":
      set({ shuffle: command.on });
      break;
    case "repeat":
      set({ repeat: command.mode });
      break;
    case "previous":
      set({ position: 0 });
      break;
    default:
      break;
  }
  return { ok: true };
}

async function startDevPreview(term: string | null): Promise<string> {
  if (!term) {
    devPreview = null;
    window.localStorage.removeItem(DEV_PREVIEW_KEY);
    publish();
    return "preview off";
  }
  const bridge = musicBridge();
  if (!bridge) return "no music bridge";
  const result = await bridge.search({ term, scope: "catalog", limit: 5 });
  const song = result.songs[0];
  if (!song) return `no catalog song for "${term}"`;
  window.localStorage.setItem(DEV_PREVIEW_KEY, term);
  const duration = song.durationMs ? song.durationMs / 1000 : 210;
  devPreview = {
    playback: {
      state: "playing",
      isPlaying: true,
      position: Math.min(duration * 0.38, duration - 5),
      positionAt: Date.now(),
      duration,
      nowPlaying: {
        id: song.id,
        title: song.title,
        artist: song.subtitle,
        album: song.album ?? "",
        artwork: song.artwork,
        durationMs: song.durationMs,
        library: false,
        catalogId: song.id,
      },
      queuePosition: 0,
      queueLength: 12,
      shuffle: false,
      repeat: 0,
      volume: 0.72,
    },
  };
  publish();
  return `previewing ${song.title} - ${song.subtitle}`;
}

function installDevPreview(): void {
  (window as unknown as { __adeMusicPreview?: typeof startDevPreview }).__adeMusicPreview = startDevPreview;
  const saved = window.localStorage.getItem(DEV_PREVIEW_KEY);
  if (saved) void startDevPreview(saved).catch(() => {});
}

export function formatMusicTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
