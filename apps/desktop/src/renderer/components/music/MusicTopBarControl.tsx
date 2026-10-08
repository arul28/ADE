import React from "react";
import { CircleNotch, MusicNotes, Pause, Play, SkipForward } from "@phosphor-icons/react";

import { musicActions, useMusicNowPlaying } from "./musicStore";
import { MusicArt } from "./musicParts";
import { MusicMiniProgress, PlayerIconButton } from "./MusicPlayer";
import { musicTabAvailable } from "./musicTab";
import "./music.css";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * The top bar's Music entry, on every tab.
 *
 * With something loaded it is a mini player in the Music tab's language:
 * round artwork, title and artist (opens the Music tab), play/pause and next as
 * round ghost buttons, and a hairline of progress along the bottom. Otherwise
 * it is one quiet music-note button that opens the Music tab.
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
      <PlayerIconButton
        size="sm"
        className="h-5 w-5"
        label={isPlaying ? "Pause" : "Play"}
        onClick={() => void musicActions.toggle()}
        testId="topbar-mini-toggle"
      >
        {busy ? <CircleNotch size={11} className="animate-spin" /> : isPlaying ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
      </PlayerIconButton>
      <PlayerIconButton size="sm" className="h-5 w-5" label="Next" onClick={() => void musicActions.next()}>
        <SkipForward size={11} weight="fill" />
      </PlayerIconButton>
      <MusicMiniProgress />
    </div>
  );
}
