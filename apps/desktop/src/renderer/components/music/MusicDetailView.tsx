import React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowClockwise, ArrowLeft, CircleNotch, Play, Shuffle, WarningCircle } from "@phosphor-icons/react";

import { MUSIC_MAX_COLLECTION_TRACKS, type MusicItem } from "../../../shared/types/music";
import { Banner } from "../ui/notice/Banner";
import { MusicArtBackdrop } from "./MusicPlayer";
import { MusicArt, MusicCoverArt, MusicEmpty, SONG_ROW_HEIGHT, SongRow, coverArts, loadableArtwork } from "./musicParts";
import { isNowPlayingItem, queueActions, queueFromList } from "./musicQueue";
import { musicActions } from "./musicStore";
import { errorText, type RowProps } from "./musicViewParts";

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} hr ${minutes % 60} min`;
}

/** Pages read at once after the first; Apple's per-token rate limit is generous at this size. */
const PAGE_READS_AT_ONCE = 4;
const PAGE_SIZE = 100;

/**
 * A collection's songs, 100 per page. The first page shows at once; when Apple
 * says how many songs there are, the rest are read four pages at a time and
 * appended strictly in order (a page that lands early waits for the one before
 * it), otherwise one after another. A 1,800-song playlist has rows after one
 * request instead of nineteen. Leaving the view (or opening another collection)
 * starts no further reads.
 */
function useCollectionTracks(kind: "album" | "playlist", id: string, library: boolean) {
  const [tracks, setTracks] = React.useState<MusicItem[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    // `live` ends with the view; `failed` ends the reads after an error.
    let live = true;
    let failed = false;
    const going = () => live && !failed;
    setTracks([]);
    setError(null);
    setLoading(true);
    const read = (offset: number) => window.ade!.music!.tracks({ kind, id, library, offset, limit: PAGE_SIZE });
    const append = (items: MusicItem[]) => {
      if (items.length) setTracks((prev) => (prev.length ? prev.concat(items) : items));
    };
    void (async () => {
      try {
        const first = await read(0);
        if (!live) return;
        append(first.items);
        if (!first.items.length || first.nextOffset === null) return;
        if (first.total === null) {
          // Unknown length: one page after another.
          let offset: number | null = first.nextOffset;
          while (going() && offset !== null) {
            const page = await read(offset);
            if (!going()) return;
            append(page.items);
            offset = page.items.length ? page.nextOffset : null;
          }
          return;
        }
        const offsets: number[] = [];
        for (let o = first.nextOffset; o < Math.min(first.total, MUSIC_MAX_COLLECTION_TRACKS); o += PAGE_SIZE) offsets.push(o);
        const landed = new Map<number, MusicItem[]>();
        let nextToShow = 0;
        let cursor = 0;
        const worker = async () => {
          while (going() && cursor < offsets.length) {
            const index = cursor++;
            const page = await read(offsets[index]!);
            if (!going()) return;
            landed.set(index, page.items);
            const ready: MusicItem[] = [];
            while (landed.has(nextToShow)) {
              ready.push(...landed.get(nextToShow)!);
              landed.delete(nextToShow);
              nextToShow += 1;
            }
            append(ready);
          }
        };
        await Promise.all(Array.from({ length: Math.min(PAGE_READS_AT_ONCE, offsets.length) }, worker));
      } catch (err) {
        if (going()) setError(errorText(err));
        failed = true;
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [kind, id, library, attempt]);
  // Reads the collection again from the start; pages read in the last minute
  // come from the main process's cache.
  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { tracks, error, loading, retry };
}

/** An album or playlist: its hero and every song, virtualized. */
export function DetailView({ item, onBack, nowPlayingId, isPlaying }: RowProps & { item: MusicItem; onBack: () => void }) {
  const kind = item.kind === "album" ? "album" : "playlist";
  const { tracks, error, loading, retry } = useCollectionTracks(kind, item.id, item.library);
  const totalMs = React.useMemo(() => tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0), [tracks]);
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
  const start = (index: number, shuffle?: boolean) => {
    // Handing MusicKit the playlist id loads only its first page of songs, so a
    // click further down (or shuffle) never reaches the rest. Queue from the
    // songs this page has read (all of them once the last page is in).
    if (tracks.length) queueFromList(tracks, index, shuffle);
    else void musicActions.playCollection(kind, item.id, index, shuffle);
  };
  // Shuffle pressed while pages are still arriving waits for the last one, so
  // it draws from the whole collection and not only the songs read so far.
  // Held per collection, and dropped when anything else is played first.
  const [shuffleWaitingFor, setShuffleWaitingFor] = React.useState<string | null>(null);
  const shuffleWaiting = shuffleWaitingFor === item.id;
  const play = (index: number, shuffle?: boolean) => {
    if (shuffle && loading && tracks.length) {
      setShuffleWaitingFor(item.id);
      return;
    }
    setShuffleWaitingFor(null);
    start(index, shuffle);
  };
  React.useEffect(() => {
    if (!shuffleWaiting || loading) return;
    setShuffleWaitingFor(null);
    start(0, true);
    // Runs once, when the last page lands (or the reads stop on an error).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuffleWaiting, loading]);

  return (
    <div className="ade-music-view" data-testid="music-detail">
      <MusicArtBackdrop artwork={item.artwork} className="is-hero" />
      <div className="ade-music-scroll" ref={scrollRef}>
        <button type="button" className="ade-music-back" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </button>
        <header className="ade-music-hero">
          {kind === "playlist" && !loadableArtwork(item.artwork) ? (
            // Like its tile: the first four songs' covers, from the songs already read.
            <MusicCoverArt arts={coverArts(tracks)} size={208} eager className="ade-music-hero-art" />
          ) : (
            <MusicArt artwork={item.artwork} size={208} eager className="ade-music-hero-art" />
          )}
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
              <button type="button" className="ade-music-pill" onClick={() => play(0, true)} disabled={shuffleWaiting} aria-busy={shuffleWaiting}>
                {shuffleWaiting ? <CircleNotch size={13} className="animate-spin" /> : <Shuffle size={13} />} Shuffle
              </button>
            </div>
          </div>
        </header>
        {error && !tracks.length ? (
          <MusicEmpty icon={<WarningCircle size={22} />} title="Couldn't load the songs" hint={error}>
            <button type="button" className="kit-btn" onClick={retry}>
              <ArrowClockwise size={13} /> Try again
            </button>
          </MusicEmpty>
        ) : null}
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
        {error && tracks.length ? (
          <Banner
            layout="inline"
            model={{
              id: "music-tracks-partial",
              tone: "warning",
              title: "Couldn't load the rest of the songs",
              detail: error,
              actions: [{ label: "Try again", onClick: retry }],
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
