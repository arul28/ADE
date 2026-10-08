import React from "react";
import {
  CircleNotch,
  Heart,
  Pause,
  Play,
  Queue,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
} from "@phosphor-icons/react";

import type { MusicRepeatMode } from "../../../shared/types/music";
import { formatMusicTime, musicActions, useMusicPosition, useMusicState } from "./musicStore";
import { MusicArt } from "./musicParts";

/**
 * The Music tab's player bar: artwork and title, like, transport, the scrubber,
 * the queue toggle and volume. Everything it shows comes from `MusicState`.
 */
export function MusicNowPlayingBar({ queueOpen, onToggleQueue }: { queueOpen: boolean; onToggleQueue: () => void }) {
  const playback = useMusicState((s) => s?.playback ?? null);
  const hostStatus = useMusicState((s) => s?.host.status ?? "stopped");
  const authorized = useMusicState((s) => Boolean(s?.authorized));
  const position = useMusicPosition(250);
  const nowPlaying = playback?.nowPlaying ?? null;
  const duration = playback?.duration ?? 0;
  const isPlaying = Boolean(playback?.isPlaying);
  const busy = hostStatus === "starting" || playback?.state === "loading" || playback?.state === "waiting";
  const disabled = !authorized || !nowPlaying;

  const [scrub, setScrub] = React.useState<number | null>(null);
  const shown = scrub ?? position;

  const [liked, setLiked] = React.useState<boolean | null>(null);
  const ratingId = nowPlaying ? (nowPlaying.catalogId ?? nowPlaying.id) : null;
  const ratingLibrary = Boolean(nowPlaying && !nowPlaying.catalogId && nowPlaying.library);
  React.useEffect(() => {
    setLiked(null);
    if (!ratingId || !authorized) return;
    let live = true;
    window.ade?.music?.rating({ id: ratingId, library: ratingLibrary }).then(
      (value) => {
        if (live) setLiked(value);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [authorized, ratingId, ratingLibrary]);
  const toggleLike = () => {
    if (!ratingId) return;
    const next = liked === true ? null : true;
    setLiked(next);
    window.ade?.music?.setRating({ id: ratingId, library: ratingLibrary, liked: next }).catch(() => setLiked(liked));
  };

  const repeat = playback?.repeat ?? 0;
  const nextRepeat: MusicRepeatMode = repeat === 0 ? 2 : repeat === 2 ? 1 : 0;
  const volume = playback?.volume ?? 1;
  const [volumeDraft, setVolumeDraft] = React.useState<number | null>(null);
  const shownVolume = volumeDraft ?? volume;
  const lastVolume = React.useRef(volume > 0 ? volume : 0.6);
  if (volume > 0) lastVolume.current = volume;
  const VolumeIcon = shownVolume === 0 ? SpeakerX : shownVolume < 0.5 ? SpeakerLow : SpeakerHigh;

  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  return (
    <footer className="ade-music-bar ade-chat-scene-plane" data-testid="music-now-playing-bar">
      <div className="ade-music-bar-now">
        <button type="button" className="ade-music-bar-art" onClick={onToggleQueue} title="Up Next" disabled={!nowPlaying}>
          <MusicArt artwork={nowPlaying?.artwork} size={52} eager />
        </button>
        <div className="ade-music-bar-titles">
          <div className="ade-music-bar-title" title={nowPlaying?.title}>
            {nowPlaying?.title ?? (hostStatus === "starting" ? "Starting the player" : "Not playing")}
          </div>
          <div className="ade-music-bar-artist" title={nowPlaying ? `${nowPlaying.artist} — ${nowPlaying.album}` : undefined}>
            {nowPlaying ? `${nowPlaying.artist}${nowPlaying.album ? ` — ${nowPlaying.album}` : ""}` : "Pick something to play"}
          </div>
        </div>
        {nowPlaying && authorized ? (
          <button
            type="button"
            className="kit-icon-btn ade-music-like"
            data-on={liked === true ? "true" : undefined}
            onClick={toggleLike}
            title={liked ? "Remove love" : "Love"}
            aria-pressed={liked === true}
            aria-label="Love"
          >
            <Heart size={16} weight={liked ? "fill" : "regular"} />
          </button>
        ) : null}
      </div>

      <div className="ade-music-bar-center">
        <div className="ade-music-transport">
          <button
            type="button"
            className="kit-icon-btn"
            data-on={playback?.shuffle ? "true" : undefined}
            aria-pressed={Boolean(playback?.shuffle)}
            onClick={() => void musicActions.setShuffle(!playback?.shuffle)}
            disabled={disabled}
            title={playback?.shuffle ? "Shuffle on" : "Shuffle"}
            aria-label="Shuffle"
          >
            <Shuffle size={16} />
          </button>
          <button type="button" className="kit-icon-btn" onClick={() => void musicActions.previous()} disabled={disabled} title="Previous" aria-label="Previous">
            <SkipBack size={18} weight="fill" />
          </button>
          <button
            type="button"
            className="ade-music-play"
            onClick={() => void musicActions.toggle()}
            disabled={disabled}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
            data-testid="music-play-toggle"
          >
            {busy ? <CircleNotch size={18} className="animate-spin" /> : isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
          </button>
          <button type="button" className="kit-icon-btn" onClick={() => void musicActions.next()} disabled={disabled} title="Next" aria-label="Next">
            <SkipForward size={18} weight="fill" />
          </button>
          <button
            type="button"
            className="kit-icon-btn"
            data-on={repeat ? "true" : undefined}
            aria-pressed={repeat !== 0}
            onClick={() => void musicActions.setRepeat(nextRepeat)}
            disabled={disabled}
            title={repeat === 1 ? "Repeat one" : repeat === 2 ? "Repeat all" : "Repeat"}
            aria-label="Repeat"
          >
            {repeat === 1 ? <RepeatOnce size={16} /> : <Repeat size={16} />}
          </button>
        </div>
        <div className="ade-music-scrub">
          <span className="kit-num">{formatMusicTime(shown)}</span>
          <input
            type="range"
            className="ade-music-range"
            min={0}
            max={Math.max(1, duration)}
            step={1}
            value={Math.min(shown, Math.max(1, duration))}
            disabled={disabled || duration <= 0}
            style={{ "--fill": `${pct}%` } as React.CSSProperties}
            onChange={(event) => setScrub(Number(event.target.value))}
            onPointerUp={() => {
              if (scrub !== null) void musicActions.seek(scrub).finally(() => setScrub(null));
            }}
            onKeyUp={() => {
              if (scrub !== null) void musicActions.seek(scrub).finally(() => setScrub(null));
            }}
            aria-label="Seek"
          />
          <span className="kit-num">{duration > 0 ? `-${formatMusicTime(Math.max(0, duration - shown))}` : "0:00"}</span>
        </div>
      </div>

      <div className="ade-music-bar-side">
        <button
          type="button"
          className="kit-icon-btn"
          data-on={queueOpen ? "true" : undefined}
          aria-pressed={queueOpen}
          onClick={onToggleQueue}
          title="Up Next"
          aria-label="Up Next"
        >
          <Queue size={16} />
        </button>
        <button
          type="button"
          className="kit-icon-btn"
          onClick={() => void musicActions.setVolume(volume > 0 ? 0 : lastVolume.current)}
          title={volume > 0 ? "Mute" : "Unmute"}
          aria-label={volume > 0 ? "Mute" : "Unmute"}
        >
          <VolumeIcon size={16} />
        </button>
        <input
          type="range"
          className="ade-music-range ade-music-volume"
          min={0}
          max={1}
          step={0.01}
          value={shownVolume}
          style={{ "--fill": `${shownVolume * 100}%` } as React.CSSProperties}
          onChange={(event) => {
            const value = Number(event.target.value);
            setVolumeDraft(value);
            void musicActions.setVolume(value);
          }}
          onPointerUp={() => setVolumeDraft(null)}
          aria-label="Volume"
        />
      </div>
    </footer>
  );
}
