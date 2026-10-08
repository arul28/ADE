import React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, CircleNotch, Play, Shuffle, WarningCircle } from "@phosphor-icons/react";

import type { MusicItem } from "../../../shared/types/music";
import { MusicArtBackdrop } from "./MusicPlayer";
import { MusicArt, MusicEmpty, SONG_ROW_HEIGHT, SongRow } from "./musicParts";
import { isNowPlayingItem, queueActions, queueFromList } from "./musicQueue";
import { musicActions } from "./musicStore";
import { useLoad, type RowProps } from "./musicViewParts";

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} hr ${minutes % 60} min`;
}

/** An album or playlist: its hero and every song, virtualized. */
export function DetailView({ item, onBack, nowPlayingId, isPlaying }: RowProps & { item: MusicItem; onBack: () => void }) {
  const kind = item.kind === "album" ? "album" : "playlist";
  const { data, error, loading } = useLoad(() => window.ade!.music!.tracks({ kind, id: item.id, library: item.library }), [item.id, kind, item.library]);
  const tracks = data ?? [];
  const totalMs = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // The hero scrolls with the list, so rows are placed relative to where the list starts.
  const [listTop, setListTop] = React.useState(0);
  React.useLayoutEffect(() => setListTop(listRef.current?.offsetTop ?? 0), [tracks.length, error, loading]);
  const virtual = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SONG_ROW_HEIGHT,
    overscan: 12,
    scrollMargin: listTop,
  });
  const play = (index: number, shuffle?: boolean) => {
    // Handing MusicKit the playlist id loads only its first page of songs, so a
    // click further down (or shuffle) never reaches the rest. Queue from the
    // full list this page already read instead.
    if (tracks.length) queueFromList(tracks, index, shuffle);
    else void musicActions.playCollection(kind, item.id, index, shuffle);
  };

  return (
    <div className="ade-music-view" data-testid="music-detail">
      <MusicArtBackdrop artwork={item.artwork} className="is-hero" />
      <div className="ade-music-scroll" ref={scrollRef}>
        <button type="button" className="ade-music-back" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </button>
        <header className="ade-music-hero">
          <MusicArt artwork={item.artwork} size={208} eager className="ade-music-hero-art" />
          <div className="ade-music-hero-text">
            <div className="kit-eyebrow">{item.library ? `Library ${kind}` : kind}</div>
            <h1>{item.title}</h1>
            <div className="ade-music-hero-sub">{item.subtitle}</div>
            <div className="ade-music-hero-meta kit-num">
              {[
                item.releaseYear ? String(item.releaseYear) : null,
                tracks.length ? `${tracks.length} songs` : null,
                totalMs ? formatDuration(totalMs) : null,
              ].filter(Boolean).join(" · ")}
            </div>
            <div className="ade-music-hero-actions">
              <button type="button" className="ade-music-connect" onClick={() => play(0)} disabled={!tracks.length && !loading}>
                <Play size={14} weight="fill" /> Play
              </button>
              <button type="button" className="ade-music-pill" onClick={() => play(0, true)}>
                <Shuffle size={13} /> Shuffle
              </button>
            </div>
          </div>
        </header>
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title="Couldn't load the songs" hint={error} /> : null}
        {loading && !tracks.length ? <div className="ade-music-more"><CircleNotch size={16} className="animate-spin" /></div> : null}
        <div ref={listRef} className="ade-music-songs" role="table" style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((row) => {
            const track = tracks[row.index]!;
            return (
              <SongRow
                key={`${track.id}:${row.index}`}
                item={track}
                index={row.index}
                current={isNowPlayingItem(track, nowPlayingId)}
                playing={isPlaying}
                showArt={kind === "playlist"}
                showAlbum={kind === "playlist"}
                onPlay={() => play(row.index)}
                {...queueActions(track)}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start - listTop}px)` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
