import React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowClockwise, CircleNotch, ClockCounterClockwise, MusicNotesSimple, Shuffle, WarningCircle } from "@phosphor-icons/react";

import type { MusicItem, MusicLibraryKind } from "../../../shared/types/music";
import { CollectionTile, MusicEmpty, SONG_ROW_HEIGHT, SongRow } from "./musicParts";
import { isNowPlayingItem, queueActions, queueFromList } from "./musicQueue";
import { errorText, TileSection, useLoad, ViewHeader, type RowProps } from "./musicViewParts";

const LIBRARY_LABELS: Record<MusicLibraryKind, string> = { playlists: "Playlists", albums: "Albums", songs: "Songs" };

/** What the account played recently, anywhere: containers to jump back into and songs. */
export function RecentView({ nowPlayingId, isPlaying, onOpen, onPlayContainer }: RowProps & { onOpen: (item: MusicItem) => void; onPlayContainer: (item: MusicItem) => void }) {
  const { data, error, loading, reload } = useLoad(() => window.ade!.music!.recent(), []);
  const tracks = data?.tracks ?? [];
  return (
    <div className="ade-music-view" data-testid="music-recent">
      <ViewHeader title="Recently played">
        <button type="button" className="kit-icon-btn" onClick={reload} aria-label="Refresh" title="Refresh">
          {loading ? <CircleNotch size={14} className="animate-spin" /> : <ArrowClockwise size={14} />}
        </button>
      </ViewHeader>
      <div className="ade-music-scroll">
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title="Couldn't load recently played" hint={error} /> : null}
        {data && !data.containers.length && !tracks.length ? (
          <MusicEmpty icon={<ClockCounterClockwise size={22} />} title="Nothing played yet" hint="What you play anywhere with Apple Music shows up here." />
        ) : null}
        {data?.containers.length ? <TileSection title="Jump back in" items={data.containers} onOpen={onOpen} onPlay={onPlayContainer} /> : null}
        {tracks.length ? (
          <section className="ade-music-section">
            <h3 className="ade-music-section-title">Songs</h3>
            <div className="ade-music-songs" role="table">
              {tracks.map((item, index) => (
                <SongRow
                  key={`${item.id}:${index}`}
                  item={item}
                  index={index}
                  current={isNowPlayingItem(item, nowPlayingId)}
                  playing={isPlaying}
                  onPlay={() => queueFromList(tracks, index)}
                  {...queueActions(item)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Library playlists and albums as a tile grid, songs as a virtual list; pages load as you scroll. */
export function LibraryView({
  kind,
  nowPlayingId,
  isPlaying,
  onOpen,
  onPlayContainer,
}: RowProps & { kind: MusicLibraryKind; onOpen: (item: MusicItem) => void; onPlayContainer: (item: MusicItem) => void }) {
  const [items, setItems] = React.useState<MusicItem[]>([]);
  const [next, setNext] = React.useState<number | null>(0);
  const [total, setTotal] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const loadingRef = React.useRef(false);
  const [loading, setLoading] = React.useState(false);
  const generation = React.useRef(0);

  const loadMore = React.useCallback(async () => {
    if (loadingRef.current || next === null) return;
    loadingRef.current = true;
    setLoading(true);
    const gen = generation.current;
    try {
      const page = await window.ade!.music!.library({ kind, offset: next, limit: 100 });
      if (gen !== generation.current) return;
      setItems((prev) => [...prev, ...page.items]);
      setNext(page.nextOffset);
      if (page.total !== null) setTotal(page.total);
    } catch (err) {
      if (gen === generation.current) setError(errorText(err));
    } finally {
      if (gen === generation.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [kind, next]);

  React.useEffect(() => {
    generation.current += 1;
    loadingRef.current = false;
    setItems([]);
    setNext(0);
    setTotal(null);
    setError(null);
  }, [kind]);
  React.useEffect(() => {
    if (items.length === 0 && next === 0 && !error) void loadMore();
  }, [items.length, next, error, loadMore]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
  };

  const virtual = useVirtualizer({
    count: kind === "songs" ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SONG_ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="ade-music-view" data-testid={`music-library-${kind}`}>
      <ViewHeader eyebrow="Library" title={LIBRARY_LABELS[kind]}>
        <span className="kit-num ade-music-count">{total !== null ? `${total.toLocaleString()} ${kind}` : loading ? "Loading…" : ""}</span>
        {kind === "songs" && items.length ? (
          <button
            type="button"
            className="ade-music-pill"
            onClick={() => queueFromList(items, 0, true)}
          >
            <Shuffle size={13} /> Shuffle
          </button>
        ) : null}
      </ViewHeader>
      <div className="ade-music-scroll" ref={scrollRef} onScroll={onScroll}>
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title={`Couldn't load your ${kind}`} hint={error} /> : null}
        {!error && !loading && items.length === 0 ? (
          <MusicEmpty icon={<MusicNotesSimple size={22} />} title={`No ${kind} in your library yet`} />
        ) : null}
        {kind === "songs" ? (
          <div className="ade-music-songs" role="table" style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((row) => {
              const item = items[row.index]!;
              return (
                <SongRow
                  key={item.id}
                  item={item}
                  index={row.index}
                  current={isNowPlayingItem(item, nowPlayingId)}
                  playing={isPlaying}
                  onPlay={() => queueFromList(items, row.index)}
                  {...queueActions(item)}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}
                />
              );
            })}
          </div>
        ) : (
          <div className="ade-music-tiles is-grid">
            {items.map((item) => (
              <CollectionTile key={item.id} item={item} onOpen={() => onOpen(item)} onPlay={() => onPlayContainer(item)} />
            ))}
          </div>
        )}
        {loading && items.length ? <div className="ade-music-more"><CircleNotch size={14} className="animate-spin" /></div> : null}
      </div>
    </div>
  );
}
