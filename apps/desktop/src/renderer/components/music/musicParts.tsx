import React from "react";
import { MusicNotesSimple, Pause, Play, Queue, ListPlus } from "@phosphor-icons/react";

import { musicArtworkUrl, type MusicArtwork, type MusicItem } from "../../../shared/types/music";
import { formatMusicTime } from "./musicStore";

/**
 * Artwork sizes are snapped to a few steps so the same picture is requested at
 * the same URL everywhere it appears; Chromium's HTTP cache then serves repeat
 * views (mzstatic sends long-lived cache headers).
 */
const ART_STEPS = [64, 128, 256, 400, 600];
function snapArt(px: number): number {
  return ART_STEPS.find((step) => step >= px) ?? ART_STEPS[ART_STEPS.length - 1]!;
}

export function MusicArt({
  artwork,
  size,
  round = false,
  className,
  eager = false,
}: {
  artwork: MusicArtwork | null | undefined;
  /** CSS pixels. */
  size: number;
  round?: boolean;
  className?: string;
  eager?: boolean;
}) {
  const url = musicArtworkUrl(artwork, snapArt(size * 2));
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const bg = artwork?.bgColor ? `#${artwork.bgColor}` : undefined;
  return (
    <span
      className={`ade-music-art${round ? " is-round" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, background: bg }}
      aria-hidden
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <MusicNotesSimple size={Math.max(12, Math.round(size * 0.38))} weight="fill" />
      )}
    </span>
  );
}

/** Apple's identity guidelines ask for "Apple Music" attribution near the content. */
export function AppleMusicMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`ade-music-mark${compact ? " is-compact" : ""}`} title="Music from Apple Music">
      <span className="ade-music-mark-glyph" aria-hidden>
        <MusicNotesSimple size={compact ? 10 : 12} weight="fill" />
      </span>
      <span className="ade-music-mark-label">Apple Music</span>
    </span>
  );
}

/** Three bars that bounce while the row's song plays (CSS steps, cheap). */
export function NowPlayingBars({ playing }: { playing: boolean }) {
  return (
    <span className={`ade-music-bars${playing ? " is-playing" : ""}`} aria-label={playing ? "Playing" : "Paused"}>
      <i />
      <i />
      <i />
    </span>
  );
}

export const SONG_ROW_HEIGHT = 48;

export function SongRow({
  item,
  index,
  current,
  playing,
  showAlbum = true,
  showArt = true,
  onPlay,
  onPlayNext,
  onPlayLater,
  style,
}: {
  item: MusicItem;
  index: number;
  current: boolean;
  playing: boolean;
  showAlbum?: boolean;
  showArt?: boolean;
  onPlay: () => void;
  onPlayNext?: () => void;
  onPlayLater?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="row"
      className={`ade-music-song${current ? " is-current" : ""}`}
      style={style}
      onDoubleClick={onPlay}
      data-testid="music-song-row"
    >
      <button type="button" className="ade-music-song-lead" onClick={onPlay} aria-label={`Play ${item.title}`}>
        <span className="ade-music-song-index kit-num">
          {current ? <NowPlayingBars playing={playing} /> : index + 1}
        </span>
        <span className="ade-music-song-play">{current && playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}</span>
      </button>
      {showArt ? <MusicArt artwork={item.artwork} size={34} /> : null}
      <span className="ade-music-song-titles">
        <span className="ade-music-song-title">
          {item.title}
          {item.explicit ? <span className="ade-music-explicit" title="Explicit">E</span> : null}
        </span>
        <span className="ade-music-song-artist">{item.subtitle}</span>
      </span>
      {showAlbum ? <span className="ade-music-song-album">{item.album ?? ""}</span> : null}
      <span className="ade-music-song-actions">
        {onPlayNext ? (
          <button type="button" className="kit-icon-btn" onClick={onPlayNext} title="Play next" aria-label="Play next">
            <Queue size={14} />
          </button>
        ) : null}
        {onPlayLater ? (
          <button type="button" className="kit-icon-btn" onClick={onPlayLater} title="Add to Up Next" aria-label="Add to Up Next">
            <ListPlus size={14} />
          </button>
        ) : null}
      </span>
      <span className="ade-music-song-time kit-num">{item.durationMs ? formatMusicTime(item.durationMs / 1000) : ""}</span>
    </div>
  );
}

export function CollectionTile({
  item,
  onOpen,
  onPlay,
}: {
  item: MusicItem;
  onOpen: () => void;
  onPlay?: () => void;
}) {
  const round = item.kind === "artist";
  return (
    <div className={`ade-music-tile${round ? " is-artist" : ""}`} data-testid="music-tile">
      <button type="button" className="ade-music-tile-art" onClick={onOpen} aria-label={`Open ${item.title}`}>
        <MusicArt artwork={item.artwork} size={168} round={round} className="ade-music-tile-img" />
        {onPlay ? (
          <span
            role="button"
            tabIndex={-1}
            className="ade-music-tile-play"
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
            aria-label={`Play ${item.title}`}
          >
            <Play size={16} weight="fill" />
          </span>
        ) : null}
      </button>
      <button type="button" className="ade-music-tile-text" onClick={onOpen}>
        <span className="ade-music-tile-title">{item.title}</span>
        <span className="ade-music-tile-sub">
          {item.subtitle}
          {item.releaseYear && item.kind === "album" ? ` · ${item.releaseYear}` : ""}
        </span>
      </button>
    </div>
  );
}

export function MusicEmpty({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="ade-music-empty">
      <span className="ade-music-empty-icon">{icon}</span>
      <div className="ade-music-empty-title">{title}</div>
      {hint ? <div className="ade-music-empty-hint">{hint}</div> : null}
      {children}
    </div>
  );
}
