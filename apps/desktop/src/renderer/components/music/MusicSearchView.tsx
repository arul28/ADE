import React from "react";
import { CircleNotch, MagnifyingGlass, Play, WarningCircle, X } from "@phosphor-icons/react";

import type { MusicItem, MusicSearchResult, MusicSearchScope } from "../../../shared/types/music";
import { MusicArt, MusicEmpty, SongRow } from "./musicParts";
import { isNowPlayingItem, queueActions, queueFromList } from "./musicQueue";
import { TileSection, useLoad, type RowProps } from "./musicViewParts";
import { MusicSignedOutHome } from "./MusicWelcome";

/** Quick searches for the empty search page: a tap fills the field. */
const SEARCH_IDEAS = ["Deep focus", "Lo-fi beats", "Synthwave", "Jazz for work", "Film scores", "Ambient", "Classical piano", "Coding mix"];

export function SearchView({
  authorized,
  pendingTerm,
  onConsumePending,
  nowPlayingId,
  isPlaying,
  onOpen,
  onPlayContainer,
}: RowProps & {
  authorized: boolean;
  pendingTerm: string | null;
  onConsumePending: () => void;
  onOpen: (item: MusicItem) => void;
  onPlayContainer: (item: MusicItem, shuffle?: boolean) => void;
}) {
  const [term, setTerm] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [scope, setScope] = React.useState<MusicSearchScope>("catalog");
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (pendingTerm) {
      setTerm(pendingTerm);
      setDebounced(pendingTerm);
      setScope("catalog");
      onConsumePending();
    }
  }, [pendingTerm, onConsumePending]);
  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(term.trim()), 280);
    return () => window.clearTimeout(id);
  }, [term]);
  React.useEffect(() => inputRef.current?.focus(), []);
  const effectiveScope: MusicSearchScope = authorized ? scope : "catalog";
  const { data, error, loading } = useLoad<MusicSearchResult>(
    debounced ? () => window.ade!.music!.search({ term: debounced, scope: effectiveScope, limit: 20 }) : null,
    [debounced, effectiveScope],
  );
  const results = debounced ? data : null;
  const songs = results?.songs ?? [];
  // Library-scope results are library songs: queue them by catalog id.
  const playSongs = (index: number) => queueFromList(songs, index);

  return (
    <div className="ade-music-view" data-testid="music-search">
      <div className="ade-music-search">
        <label className="ade-music-search-field">
          <MagnifyingGlass size={16} />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={effectiveScope === "library" ? "Search your library" : "Search Apple Music"}
            aria-label="Search"
            data-testid="music-search-input"
          />
          {loading ? <CircleNotch size={14} className="animate-spin text-muted-fg" /> : null}
          {term ? (
            <button type="button" className="kit-icon-btn" onClick={() => setTerm("")} aria-label="Clear search"><X size={12} /></button>
          ) : null}
        </label>
        <div className="kit-seg" data-case="sentence" role="tablist">
          <button type="button" role="tab" aria-selected={effectiveScope === "catalog"} onClick={() => setScope("catalog")}>Apple Music</button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveScope === "library"}
            onClick={() => setScope("library")}
            disabled={!authorized}
            title={authorized ? undefined : "Connect Apple Music to search your library"}
          >
            Library
          </button>
        </div>
      </div>
      <div className="ade-music-scroll">
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title="Search failed" hint={error} /> : null}
        {!debounced ? (
          authorized ? (
            <div className="ade-music-search-start">
              <MusicEmpty icon={<MagnifyingGlass size={22} />} title="Search songs, albums, playlists and artists" hint="Results play straight from Apple Music." />
              <div className="ade-music-ideas-label">Try</div>
              <div className="ade-music-ideas" aria-label="Search ideas">
                {SEARCH_IDEAS.map((idea) => (
                  <button key={idea} type="button" className="ade-music-idea" onClick={() => setTerm(idea)}>
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MusicSignedOutHome
              renderSongs={(items) => (
                <section className="ade-music-section">
                  <h3 className="ade-music-section-title">
                    Popular songs <span className="kit-tag">30-second previews</span>
                  </h3>
                  <div className="ade-music-songs" role="table">
                    {items.map((item, index) => (
                      <SongRow
                        key={item.id}
                        item={item}
                        index={index}
                        current={isNowPlayingItem(item, nowPlayingId)}
                        playing={isPlaying}
                        onPlay={() => queueFromList(items, index)}
                      />
                    ))}
                  </div>
                </section>
              )}
              renderAlbums={(items) => (
                <TileSection title="Popular albums" items={items} onOpen={onOpen} onPlay={onPlayContainer} />
              )}
            />
          )
        ) : null}
        {debounced && loading && !results ? <SearchSkeleton /> : null}
        {results && !error && songs.length + results.albums.length + results.playlists.length + results.artists.length === 0 && !loading ? (
          <MusicEmpty
            icon={<MagnifyingGlass size={22} />}
            title={`Nothing found for “${debounced}”`}
            hint={effectiveScope === "library" ? "Try Apple Music instead of your library." : "Check the spelling, or try an artist or album name."}
          />
        ) : null}
        {results && songs.length + results.albums.length + results.playlists.length + results.artists.length > 0 ? (
          <SearchResults
            term={debounced}
            results={results}
            authorized={authorized}
            nowPlayingId={nowPlayingId}
            isPlaying={isPlaying}
            onOpen={onOpen}
            onPlayContainer={onPlayContainer}
            onPlaySong={playSongs}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The best single match: an artist named exactly that, an album with it in the title, else the first song. */
function pickTopResult(term: string, results: MusicSearchResult): MusicItem | null {
  const t = term.trim().toLowerCase();
  const artist = results.artists.find((a) => a.title.toLowerCase() === t);
  if (artist) return artist;
  const album = results.albums.find((a) => a.title.toLowerCase().includes(t));
  if (album) return album;
  return results.songs[0] ?? results.albums[0] ?? results.artists[0] ?? results.playlists[0] ?? null;
}

const KIND_LABEL: Record<MusicItem["kind"], string> = { song: "Song", album: "Album", playlist: "Playlist", artist: "Artist", station: "Station" };

function SearchResults({
  term,
  results,
  authorized,
  nowPlayingId,
  isPlaying,
  onOpen,
  onPlayContainer,
  onPlaySong,
}: RowProps & {
  term: string;
  results: MusicSearchResult;
  authorized: boolean;
  onOpen: (item: MusicItem) => void;
  onPlayContainer: (item: MusicItem, shuffle?: boolean) => void;
  onPlaySong: (index: number) => void;
}) {
  const top = pickTopResult(term, results);
  // The top result is not repeated in the shelves below it.
  const artists = results.artists.filter((a) => a.id !== top?.id);
  const songs = results.songs;
  const firstSongs = songs.slice(0, 5);
  const moreSongs = songs.slice(5, 15);
  const playTop = () => {
    if (!top) return;
    if (top.kind === "song") onPlaySong(Math.max(0, songs.findIndex((s) => s.id === top.id)));
    else if (top.kind !== "artist") onPlayContainer(top);
  };
  const songRow = (item: MusicItem, index: number) => (
    <SongRow
      key={item.id}
      item={item}
      index={index}
      current={isNowPlayingItem(item, nowPlayingId)}
      playing={isPlaying}
      showAlbum={false}
      onPlay={() => onPlaySong(index)}
      {...(authorized ? queueActions(item) : {})}
    />
  );
  return (
    <div className="ade-music-results">
      <div className="ade-music-results-top">
        {top ? (
          <section className="ade-music-section">
            <h3 className="ade-music-section-title">Top result</h3>
            <div
              className={`ade-music-top-result${top.kind === "artist" ? " is-artist" : ""}`}
              style={top.artwork?.bgColor ? ({ "--music-tint": `#${top.artwork.bgColor}` } as React.CSSProperties) : undefined}
            >
              <button type="button" className="ade-music-top-open" onClick={() => (top.kind === "song" ? playTop() : onOpen(top))}>
                <MusicArt artwork={top.artwork} size={104} round={top.kind === "artist"} eager className="ade-music-top-art" />
                <span className="ade-music-top-title">{top.title}</span>
                <span className="ade-music-top-sub">
                  <span className="kit-tag">{KIND_LABEL[top.kind]}</span>
                  {top.kind !== "artist" ? <span className="truncate">{top.subtitle}</span> : null}
                </span>
              </button>
              {top.kind !== "artist" ? (
                <button type="button" className="ade-music-top-play" onClick={playTop} aria-label={`Play ${top.title}`} title="Play">
                  <Play size={18} weight="fill" />
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
        {firstSongs.length ? (
          <section className="ade-music-section ade-music-results-songs">
            <h3 className="ade-music-section-title">Songs</h3>
            <div className="ade-music-songs" role="table">
              {firstSongs.map(songRow)}
            </div>
          </section>
        ) : null}
      </div>
      {artists.length ? <TileSection title="Artists" items={artists.slice(0, 10)} onOpen={onOpen} shelf /> : null}
      {results.albums.length ? <TileSection title="Albums" items={results.albums} onOpen={onOpen} onPlay={onPlayContainer} shelf /> : null}
      {moreSongs.length ? (
        <section className="ade-music-section">
          <h3 className="ade-music-section-title">More songs</h3>
          <div className="ade-music-songs" role="table">
            {moreSongs.map((item, i) => songRow(item, i + 5))}
          </div>
        </section>
      ) : null}
      {results.playlists.length ? <TileSection title="Playlists" items={results.playlists} onOpen={onOpen} onPlay={onPlayContainer} shelf /> : null}
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div className="ade-music-skeleton" aria-label="Searching" role="status">
      <div className="ade-music-results-top">
        <div className="ade-music-section">
          <i className="is-heading" />
          <i className="is-top" />
        </div>
        <div className="ade-music-section">
          <i className="is-heading" />
          {[0, 1, 2, 3, 4].map((n) => <i key={n} className="is-row" />)}
        </div>
      </div>
      <div className="ade-music-section">
        <i className="is-heading" />
        <div className="ade-music-skeleton-tiles">{[0, 1, 2, 3, 4, 5].map((n) => <i key={n} className="is-tile" />)}</div>
      </div>
    </div>
  );
}
