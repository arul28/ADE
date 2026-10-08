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

type Store = { state: MusicState | null; lastError: string | null };

const useMusicStore = create<Store>(() => ({ state: null, lastError: null }));

let subscribed = false;
function ensureSubscription(): void {
  if (subscribed) return;
  const bridge = musicBridge();
  if (!bridge) return;
  subscribed = true;
  bridge.onState((state) => useMusicStore.setState({ state }));
  void bridge.getState().then(
    (state) => {
      // An event that arrived first is newer than this read.
      if (!useMusicStore.getState().state) useMusicStore.setState({ state });
    },
    () => {},
  );
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
  const state = useMusicState((s) => s);
  const playback = state?.playback;
  const nowPlaying = playback?.nowPlaying ?? null;
  return {
    available: Boolean(state && state.availability !== "unsupported") && musicAvailable(),
    nowPlaying,
    isPlaying: Boolean(playback?.isPlaying),
    busy: playback?.state === "loading" || playback?.state === "waiting" || playback?.state === "stalled",
    duration: playback?.duration ?? 0,
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

async function run(command: MusicCommand): Promise<MusicCommandResult> {
  const bridge = musicBridge();
  if (!bridge) return { ok: false, error: "Music isn't available in this window." };
  const result = await bridge.command(command).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  useMusicStore.setState({ lastError: result.ok ? null : result.error });
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
    const result = await bridge.connect();
    useMusicStore.setState({ lastError: result.ok || result.cancelled ? null : result.error });
    return result;
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
    useMusicStore.setState({ state: await bridge.getState() });
  },
};

export function formatMusicTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
