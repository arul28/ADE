import React from "react";
import { CircleNotch, MusicNotes, Pause, Play, SkipForward } from "@phosphor-icons/react";

import { musicActions, useMusicNowPlaying } from "./musicStore";
import { MusicArt } from "./musicParts";
import { musicTabAvailable } from "./musicTab";
import "./music.css";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * The top bar's Music entry, on every tab.
 *
 * With something loaded it is a mini player: artwork, title and artist (opens
 * the Music tab), play/pause and next. Otherwise it is one quiet music-note
 * button that opens the Music tab.
 */
export function MusicTopBarControl({ shortcutLabel, active }: { shortcutLabel?: string; active?: boolean }) {
  const view = useMusicNowPlaying();
  if (!musicTabAvailable() || !view.available) return null;
  const { nowPlaying, isPlaying, busy } = view;

  if (!nowPlaying) {
    return (
      <button
        type="button"
        className="ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md"
        data-variant="ghost"
        data-active={active ? "true" : undefined}
        aria-label="Music"
        title={shortcutLabel ? `Music (${shortcutLabel})` : "Music"}
        style={noDrag}
        onClick={musicActions.open}
        data-testid="topbar-music"
      >
        <MusicNotes size={14} weight={active ? "fill" : "regular"} />
      </button>
    );
  }

  return (
    <div className={`ade-mini-player${isPlaying ? " is-playing" : ""}`} style={noDrag} data-testid="topbar-mini-player">
      <button
        type="button"
        className="ade-mini-player-open"
        onClick={musicActions.open}
        title={`${nowPlaying.title} — ${nowPlaying.artist}${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
      >
        <MusicArt artwork={nowPlaying.artwork} size={18} eager />
        <span className="ade-mini-player-text">
          {nowPlaying.title}
          <span> · {nowPlaying.artist}</span>
        </span>
      </button>
      <button
        type="button"
        className="ade-mini-player-btn"
        onClick={() => void musicActions.toggle()}
        aria-label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        data-testid="topbar-mini-toggle"
      >
        {busy ? <CircleNotch size={11} className="animate-spin" /> : isPlaying ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
      </button>
      <button type="button" className="ade-mini-player-btn" onClick={() => void musicActions.next()} aria-label="Next" title="Next">
        <SkipForward size={11} weight="fill" />
      </button>
    </div>
  );
}
