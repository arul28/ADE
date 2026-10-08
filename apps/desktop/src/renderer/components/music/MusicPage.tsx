import React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowClockwise,
  ArrowLeft,
  CaretRight,
  CircleNotch,
  ClockCounterClockwise,
  Disc,
  MagnifyingGlass,
  MusicNotes,
  MusicNotesSimple,
  Play,
  Playlist,
  Queue,
  Shuffle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import type { MusicItem, MusicLibraryKind, MusicQueue, MusicSearchResult, MusicSearchScope } from "../../../shared/types/music";
import { ChatSceneBackdrop } from "../personalChats/ChatSceneBackdrop";
import { MusicNowPlayingBar } from "./MusicNowPlayingBar";
import { MusicArtBackdrop, MusicPlayerCard } from "./MusicPlayer";
import {
  AppleMusicMark,
  CollectionTile,
  MusicArt,
  MusicEmpty,
  SONG_ROW_HEIGHT,
  SongRow,
} from "./musicParts";
import { friendlyMusicError, musicActions, useMusicLastError, useMusicState } from "./musicStore";
import { ConnectButton, ConnectHero, MusicSignedOutHome, SignInControls } from "./MusicWelcome";
import { MusicAccountArea } from "./MusicAccount";
import "./music.css";

type View =
  | { kind: "search" }
  | { kind: "recent" }
  | { kind: "queue" }
  | { kind: "library"; library: MusicLibraryKind }
  | { kind: "detail"; item: MusicItem; back: View };

const LIBRARY_LABELS: Record<MusicLibraryKind, string> = { playlists: "Playlists", albums: "Albums", songs: "Songs" };

/** Quick searches for the empty search page: a tap fills the field. */
const SEARCH_IDEAS = ["Deep focus", "Lo-fi beats", "Synthwave", "Jazz for work", "Film scores", "Ambient", "Classical piano", "Coding mix"];

/** Whether the Now Playing card is shown (on wide windows) or folded into the bar. */
const PLAYER_CARD_KEY = "ade.music.playerCard";
function usePlayerCardPreference(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = React.useState(() => {
    try {
      return window.localStorage.getItem(PLAYER_CARD_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const set = React.useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(PLAYER_CARD_KEY, next ? "shown" : "hidden");
    } catch {
      // Private storage is optional.
    }
  }, []);
  return [open, set];
}

/** The card needs this much page width; below it the bar takes over. */
const PLAYER_CARD_MIN_WIDTH = 1080;

/** True while the element is at least `minWidth` wide. One observer, no polling. */
function useWideEnough(ref: React.RefObject<HTMLElement | null>, minWidth: number): boolean {
  const [wide, setWide] = React.useState(true);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWide(el.clientWidth >= minWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setWide(width >= minWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, minWidth]);
  return wide;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return friendlyMusicError(raw) ?? "Something went wrong with Apple Music. Try again.";
}

/** Run an async read whenever `deps` change; keep the last result while the next loads. */
function useLoad<T>(load: (() => Promise<T>) | null, deps: React.DependencyList) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!load) return undefined;
    let live = true;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (!live) return;
        setData(value);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function MusicPage() {
  // Field selectors, not the whole state: the main process pushes once a second
  // while playing, and only the scrubber needs that.
  const hasState = useMusicState((s) => s !== null);
  const availability = useMusicState((s) => s?.availability ?? null);
  const message = useMusicState((s) => s?.message ?? null);
  const queueRevision = useMusicState((s) => s?.queueRevision ?? 0);
  const hostStatus = useMusicState((s) => s?.host.status ?? "stopped");
  const authorized = useMusicState((s) => Boolean(s?.authorized));
  const nowPlayingId = useMusicState((s) => s?.playback.nowPlaying?.id ?? null);
  const isPlaying = useMusicState((s) => Boolean(s?.playback.isPlaying));
  const lastError = useMusicLastError();
  const [view, setView] = React.useState<View>({ kind: "search" });
  const [cardOpen, setCardOpen] = usePlayerCardPreference();
  const pageRef = React.useRef<HTMLDivElement>(null);
  const wide = useWideEnough(pageRef, PLAYER_CARD_MIN_WIDTH);

  // Start the player while the user is looking at the tab, so the first play is
  // instant. The main process unloads it again after five idle minutes.
  React.useEffect(() => {
    if (authorized) musicActions.warm();
  }, [authorized]);

  // Space plays and pauses while the tab is in front and no field has focus.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select, [contenteditable='true']") || target.tagName === "BUTTON")) return;
      if (!nowPlayingId) return;
      event.preventDefault();
      void musicActions.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nowPlayingId]);

  const openDetail = (item: MusicItem) => {
    if (item.kind === "artist") {
      setView({ kind: "search" });
      setPendingSearch(item.title);
      return;
    }
    if (item.kind === "song") return;
    setView((current) => ({ kind: "detail", item, back: current.kind === "detail" ? current.back : current }));
  };
  const [pendingSearch, setPendingSearch] = React.useState<string | null>(null);

  const playContainer = (item: MusicItem, shuffle?: boolean) => {
    if (item.kind === "album" || item.kind === "playlist" || item.kind === "station") {
      void musicActions.playCollection(item.kind, item.id, 0, shuffle);
    } else if (item.kind === "song") {
      void musicActions.playItems([item.id]);
    }
  };

  if (!hasState) {
    return (
      <MusicFrame>
        <div className="ade-music-center"><CircleNotch size={20} className="animate-spin text-muted-fg" /></div>
      </MusicFrame>
    );
  }

  if (availability === "unsupported") {
    return (
      <MusicFrame>
        <div className="ade-music-center">
          <section className="ade-music-gate ade-chat-scene-plane" data-testid="music-unsupported">
            <span className="ade-music-gate-glyph"><MusicNotes size={30} weight="fill" /></span>
            <h1>Music on Mac is coming</h1>
            <p>{message ?? "Apple Music plays in ADE on Windows today."}</p>
            <AppleMusicMark />
          </section>
        </div>
      </MusicFrame>
    );
  }

  if (availability === "unavailable") {
    return (
      <MusicFrame>
        <div className="ade-music-center">
          <section className="ade-music-gate ade-chat-scene-plane" data-testid="music-unavailable">
            <span className="ade-music-gate-glyph is-muted"><WarningCircle size={30} weight="fill" /></span>
            <h1>Music isn't available right now</h1>
            <p>{message ?? "ADE couldn't reach its music service."}</p>
            <button type="button" className="kit-btn" onClick={() => void musicActions.refresh()}>
              <ArrowClockwise size={13} /> Try again
            </button>
          </section>
        </div>
      </MusicFrame>
    );
  }

  const main = (() => {
    switch (view.kind) {
      case "search":
        return (
          <SearchView
            authorized={authorized}
            pendingTerm={pendingSearch}
            onConsumePending={() => setPendingSearch(null)}
            nowPlayingId={nowPlayingId}
            isPlaying={isPlaying}
            onOpen={openDetail}
            onPlayContainer={playContainer}
          />
        );
      case "recent":
        return authorized ? (
          <RecentView nowPlayingId={nowPlayingId} isPlaying={isPlaying} onOpen={openDetail} onPlayContainer={playContainer} />
        ) : <div className="ade-music-scroll"><ConnectHero compact /></div>;
      case "queue":
        return <QueueView nowPlayingId={nowPlayingId} isPlaying={isPlaying} revision={queueRevision} hostStatus={hostStatus} />;
      case "library":
        return authorized ? (
          <LibraryView kind={view.library} nowPlayingId={nowPlayingId} isPlaying={isPlaying} onOpen={openDetail} onPlayContainer={playContainer} />
        ) : <div className="ade-music-scroll"><ConnectHero compact /></div>;
      case "detail":
        return (
          <DetailView
            item={view.item}
            onBack={() => setView(view.back)}
            nowPlayingId={nowPlayingId}
            isPlaying={isPlaying}
          />
        );
    }
  })();

  const isActive = (target: View) =>
    view.kind === target.kind && (target.kind !== "library" || (view.kind === "library" && view.library === target.library));

  const toggleQueue = () => setView((current) => (current.kind === "queue" ? { kind: "search" } : { kind: "queue" }));
  // One player form at a time, so only one scrubber ticks: the card on wide
  // pages (unless the user folded it away), the bar otherwise.
  const showCard = cardOpen && wide && Boolean(nowPlayingId);
  const showBar = !showCard && (Boolean(nowPlayingId) || hostStatus === "starting");

  return (
    <MusicFrame pageRef={pageRef}>
      <div className="ade-music-layout">
        <aside className="ade-music-rail ade-chat-scene-plane" aria-label="Music">
          <div className="ade-music-rail-head">
            <AppleMusicMark />
          </div>
          <nav className="ade-music-nav">
            <RailItem icon={<MagnifyingGlass size={15} />} label="Search" active={isActive({ kind: "search" })} onClick={() => setView({ kind: "search" })} />
            <RailItem icon={<ClockCounterClockwise size={15} />} label="Recently played" active={isActive({ kind: "recent" })} onClick={() => setView({ kind: "recent" })} />
            <RailItem icon={<Queue size={15} />} label="Up Next" active={isActive({ kind: "queue" })} onClick={() => setView({ kind: "queue" })} />
            <div className="ade-music-nav-label kit-eyebrow">Library</div>
            <RailItem icon={<Playlist size={15} />} label="Playlists" active={isActive({ kind: "library", library: "playlists" })} onClick={() => setView({ kind: "library", library: "playlists" })} />
            <RailItem icon={<Disc size={15} />} label="Albums" active={isActive({ kind: "library", library: "albums" })} onClick={() => setView({ kind: "library", library: "albums" })} />
            <RailItem icon={<MusicNotesSimple size={15} />} label="Songs" active={isActive({ kind: "library", library: "songs" })} onClick={() => setView({ kind: "library", library: "songs" })} />
          </nav>
          <div className="ade-music-rail-foot">
            {authorized ? (
              <MusicAccountArea />
            ) : (
              <>
                <ConnectButton compact />
                <div className="ade-music-rail-signin"><SignInControls compact /></div>
              </>
            )}
          </div>
        </aside>
        <main className="ade-music-main ade-chat-scene-plane" data-testid="music-main">
          {message || lastError ? (
            <div role="alert" className="ade-music-alert">
              <WarningCircle size={14} weight="fill" />
              <span className="min-w-0 flex-1 truncate">{lastError ?? friendlyMusicError(message)}</span>
              <button
                type="button"
                className="ade-music-alert-action"
                onClick={() => {
                  musicActions.clearError();
                  void musicActions.refresh();
                }}
              >
                <ArrowClockwise size={12} /> Try again
              </button>
              {lastError ? (
                <button type="button" className="kit-icon-btn" onClick={musicActions.clearError} aria-label="Dismiss"><X size={12} /></button>
              ) : null}
            </div>
          ) : null}
          {main}
        </main>
        {showCard ? (
          <MusicPlayerCard queueOpen={view.kind === "queue"} onToggleQueue={toggleQueue} onCollapse={() => setCardOpen(false)} />
        ) : null}
      </div>
      {showBar ? (
        <MusicNowPlayingBar
          queueOpen={view.kind === "queue"}
          onToggleQueue={toggleQueue}
          onExpand={!cardOpen && wide ? () => setCardOpen(true) : undefined}
        />
      ) : null}
    </MusicFrame>
  );
}

function MusicFrame({ children, pageRef }: { children: React.ReactNode; pageRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={pageRef} className="ade-chat-scene ade-music relative flex h-full min-h-0 flex-col text-fg" data-testid="music-page">
      <ChatSceneBackdrop />
      <div className="ade-music-frame">{children}</div>
    </div>
  );
}

function RailItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ade-music-nav-item" data-active={active ? "true" : undefined} aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ViewHeader({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: React.ReactNode }) {
  return (
    <header className="ade-music-view-head">
      <div className="min-w-0">
        {eyebrow ? <div className="kit-eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
      </div>
      {children}
    </header>
  );
}

type RowProps = { nowPlayingId: string | null; isPlaying: boolean };

function SearchView({
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
  const playSongs = (index: number) => void musicActions.playItems(songs.map((s) => s.id), index);

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
            <>
              <MusicEmpty icon={<MagnifyingGlass size={22} />} title="Search songs, albums, playlists and artists" hint="Results play straight from Apple Music." />
              <div className="ade-music-ideas" aria-label="Search ideas">
                {SEARCH_IDEAS.map((idea) => (
                  <button key={idea} type="button" className="ade-music-idea" onClick={() => setTerm(idea)}>
                    {idea}
                  </button>
                ))}
              </div>
            </>
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
                        current={item.id === nowPlayingId}
                        playing={isPlaying}
                        onPlay={() => void musicActions.playItems(items.map((s) => s.id), index)}
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
      current={item.id === nowPlayingId}
      playing={isPlaying}
      showAlbum={false}
      onPlay={() => onPlaySong(index)}
      onPlayNext={authorized ? () => void musicActions.playNext([item.id]) : undefined}
      onPlayLater={authorized ? () => void musicActions.playLater([item.id]) : undefined}
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

function TileSection({
  title,
  items,
  onOpen,
  onPlay,
  shelf = false,
}: {
  title: string;
  items: MusicItem[];
  onOpen: (item: MusicItem) => void;
  onPlay?: (item: MusicItem) => void;
  /** One scrolling row instead of a grid. */
  shelf?: boolean;
}) {
  return (
    <section className="ade-music-section">
      <h3 className="ade-music-section-title">{title}</h3>
      <div className={shelf ? "ade-music-tiles is-shelf" : "ade-music-tiles is-grid"}>
        {items.slice(0, 12).map((item) => (
          <CollectionTile key={`${item.kind}:${item.id}`} item={item} onOpen={() => onOpen(item)} onPlay={onPlay ? () => onPlay(item) : undefined} />
        ))}
      </div>
    </section>
  );
}

function RecentView({ nowPlayingId, isPlaying, onOpen, onPlayContainer }: RowProps & { onOpen: (item: MusicItem) => void; onPlayContainer: (item: MusicItem) => void }) {
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
                  current={item.id === nowPlayingId}
                  playing={isPlaying}
                  onPlay={() => void musicActions.playItems(tracks.map((t) => t.id), index)}
                  onPlayNext={() => void musicActions.playNext([item.id])}
                  onPlayLater={() => void musicActions.playLater([item.id])}
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
function LibraryView({
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

  const playSongsFrom = (index: number) => {
    // A queue of the next 300 songs: enough for hours, small enough to load fast.
    void musicActions.playItems(items.slice(index, index + 300).map((s) => s.id), 0);
  };

  return (
    <div className="ade-music-view" data-testid={`music-library-${kind}`}>
      <ViewHeader eyebrow="Library" title={LIBRARY_LABELS[kind]}>
        <span className="kit-num ade-music-count">{total !== null ? `${total.toLocaleString()} ${kind}` : loading ? "Loading…" : ""}</span>
        {kind === "songs" && items.length ? (
          <button
            type="button"
            className="ade-music-pill"
            onClick={() => void musicActions.playItems(items.slice(0, 300).map((s) => s.id), 0, true)}
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
                  current={item.id === nowPlayingId}
                  playing={isPlaying}
                  onPlay={() => playSongsFrom(row.index)}
                  onPlayNext={() => void musicActions.playNext([item.id])}
                  onPlayLater={() => void musicActions.playLater([item.id])}
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

function DetailView({ item, onBack, nowPlayingId, isPlaying }: RowProps & { item: MusicItem; onBack: () => void }) {
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
  const play = (index: number, shuffle?: boolean) => void musicActions.playCollection(kind, item.id, index, shuffle);

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
                current={track.id === nowPlayingId}
                playing={isPlaying}
                showArt={kind === "playlist"}
                showAlbum={kind === "playlist"}
                onPlay={() => play(row.index)}
                onPlayNext={() => void musicActions.playNext([track.id])}
                onPlayLater={() => void musicActions.playLater([track.id])}
                style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start - listTop}px)` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} hr ${minutes % 60} min`;
}

function QueueView({ nowPlayingId, isPlaying, revision, hostStatus }: RowProps & { revision: number; hostStatus: string }) {
  const { data, error } = useLoad<MusicQueue>(() => window.ade!.music!.queue(), [revision, nowPlayingId, hostStatus]);
  const position = data?.position ?? -1;
  const items = data?.items ?? [];
  const current = position >= 0 ? items[position] : undefined;
  const upcoming = position >= 0 ? items.slice(position + 1) : items;
  return (
    <div className="ade-music-view" data-testid="music-queue">
      <ViewHeader title="Up Next">
        {hostStatus === "suspended" ? <span className="kit-tag">Resumes where you left off</span> : null}
      </ViewHeader>
      <div className="ade-music-scroll">
        {error ? <MusicEmpty icon={<WarningCircle size={22} />} title="Couldn't read the queue" hint={error} /> : null}
        {!items.length && !error ? (
          <MusicEmpty icon={<Queue size={22} />} title="Nothing queued" hint="Play a song, album or playlist and what comes next shows here." />
        ) : null}
        {current ? (
          <section className="ade-music-section">
            <h3 className="kit-eyebrow">Now playing</h3>
            <div className="ade-music-songs" role="table">
              <SongRow item={current} index={position} current playing={isPlaying} onPlay={() => void musicActions.toggle()} />
            </div>
          </section>
        ) : null}
        {upcoming.length ? (
          <section className="ade-music-section">
            <h3 className="kit-eyebrow">
              Next <span className="kit-num">{upcoming.length}</span>
            </h3>
            <div className="ade-music-songs" role="table">
              {upcoming.slice(0, 200).map((item, i) => {
                const index = position + 1 + i;
                return (
                  <SongRow
                    key={`${item.id}:${index}`}
                    item={item}
                    index={i}
                    current={false}
                    playing={false}
                    onPlay={() => void musicActions.playAt(index)}
                  />
                );
              })}
            </div>
            {upcoming.length > 200 ? (
              <div className="ade-music-more kit-num">
                and {upcoming.length - 200} more <CaretRight size={11} />
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
