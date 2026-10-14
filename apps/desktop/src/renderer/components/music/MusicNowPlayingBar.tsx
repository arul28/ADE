import React from "react";
import { CaretUp, Queue } from "@phosphor-icons/react";

import { MusicArt } from "./musicParts";
import { MusicArtBackdrop, MusicLikeButton, MusicSeek, MusicTransport, MusicVolume, PlayerIconButton } from "./MusicPlayer";
import { useMusicState } from "./musicStore";

/**
 * The Music tab's bottom player: the compact form of the Now Playing card, shown
 * while the card is hidden or the window is too narrow for it. Artwork and
 * title, love, the transport pill over the scrubber, Up Next and volume.
 */
export function MusicNowPlayingBar({
  queueOpen,
  onToggleQueue,
  onExpand,
}: {
  queueOpen: boolean;
  onToggleQueue: () => void;
  /** Show the Now Playing card instead (absent when there is no room for it). */
  onExpand?: () => void;
}) {
  const nowPlaying = useMusicState((s) => s?.playback.nowPlaying ?? null);
  const hostStarting = useMusicState((s) => s?.host.status === "starting");
  const authorized = useMusicState((s) => Boolean(s?.authorized));
  const disabled = !authorized || !nowPlaying;

  return (
    <footer className="ade-music-bar ade-chat-scene-plane" data-testid="music-now-playing-bar">
      <MusicArtBackdrop artwork={nowPlaying?.artwork} className="is-bar" />
      <div className="ade-music-bar-now">
        <button
          type="button"
          className="ade-music-bar-art"
          onClick={onExpand ?? onToggleQueue}
          title={onExpand ? "Show player" : "Up Next"}
          disabled={!nowPlaying}
        >
          <MusicArt artwork={nowPlaying?.artwork} size={52} eager />
        </button>
        <div className="ade-music-bar-titles">
          <div className="ade-music-bar-title" title={nowPlaying?.title}>
            {nowPlaying?.title ?? (hostStarting ? "Starting the player" : "Not playing")}
          </div>
          <div className="ade-music-bar-artist" title={nowPlaying ? `${nowPlaying.artist} — ${nowPlaying.album}` : undefined}>
            {nowPlaying ? `${nowPlaying.artist}${nowPlaying.album ? ` — ${nowPlaying.album}` : ""}` : "Pick something to play"}
          </div>
        </div>
        <MusicLikeButton size="sm" />
      </div>

      <div className="ade-music-bar-center">
        <MusicTransport disabled={disabled} />
        <div className="ade-music-bar-seek">
          <MusicSeek layout="inline" disabled={disabled} />
        </div>
      </div>

      <div className="ade-music-bar-side">
        <PlayerIconButton size="sm" label="Up Next" on={queueOpen} onClick={onToggleQueue}>
          <Queue size={15} />
        </PlayerIconButton>
        <MusicVolume className="ade-music-bar-volume" />
        {onExpand && nowPlaying ? (
          <PlayerIconButton size="sm" label="Show player" onClick={onExpand} className="ade-music-bar-expand">
            <CaretUp size={14} weight="bold" />
          </PlayerIconButton>
        ) : null}
      </div>
    </footer>
  );
}
