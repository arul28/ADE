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
  SignOut,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import type { MusicItem, MusicLibraryKind, MusicQueue, MusicSearchResult, MusicSearchScope } from "../../../shared/types/music";
import { ChatSceneBackdrop } from "../personalChats/ChatSceneBackdrop";
import { MusicNowPlayingBar } from "./MusicNowPlayingBar";
import {
  AppleMusicMark,
  CollectionTile,
  MusicArt,
  MusicEmpty,
  SONG_ROW_HEIGHT,
  SongRow,
} from "./musicParts";
import { formatMusicTime, musicActions, useMusicLastError, useMusicState } from "./musicStore";
import "./music.css";

type View =
  | { kind: "search" }
  | { kind: "recent" }
  | { kind: "queue" }
  | { kind: "library"; library: MusicLibraryKind }
  | { kind: "detail"; item: MusicItem; back: View };

const LIBRARY_LABELS: Record<MusicLibraryKind, string> = { playlists: "Playlists", albums: "Albums", songs: "Songs" };

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // IPC wraps a main-process throw as "Error invoking remote method '…': Error: <message>".
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
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
  const state = useMusicState((s) => s);
  const lastError = useMusicLastError();
  const [view, setView] = React.useState<View>({ kind: "search" });
  const authorized = Boolean(state?.authorized);
  const nowPlayingId = state?.playback.nowPlaying?.id ?? null;
  const isPlaying = Boolean(state?.playback.isPlaying);

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

  if (!state) {
    return (
      <MusicFrame>
        <div className="ade-music-center"><CircleNotch size={20} className="animate-spin text-muted-fg" /></div>
      </MusicFrame>
    );
  }

  if (state.availability === "unsupported") {
    return (
      <MusicFrame>
        <div className="ade-music-center">
          <section className="ade-music-gate ade-chat-scene-plane" data-testid="music-unsupported">
            <span className="ade-music-gate-glyph"><MusicNotes size={30} weight="fill" /></span>
            <h1>Music on Mac is coming</h1>
            <p>{state.message ?? "Apple Music plays in ADE on Windows today."}</p>
            <AppleMusicMark />
          </section>
        </div>
      </MusicFrame>
    );
  }

  if (state.availability === "unavailable") {
    return (
      <MusicFrame>
        <div className="ade-music-center">
          <section className="ade-music-gate ade-chat-scene-plane" data-testid="music-unavailable">
            <span className="ade-music-gate-glyph is-muted"><WarningCircle size={30} weight="fill" /></span>
            <h1>Music isn't available right now</h1>
            <p>{state.message ?? "ADE couldn't reach its music service."}</p>
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
        ) : <ConnectHero />;
      case "queue":
        return <QueueView nowPlayingId={nowPlayingId} isPlaying={isPlaying} revision={state.queueRevision} hostStatus={state.host.status} />;
      case "library":
        return authorized ? (
          <LibraryView kind={view.library} nowPlayingId={nowPlayingId} isPlaying={isPlaying} onOpen={openDetail} onPlayContainer={playContainer} />
        ) : <ConnectHero />;
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

  return (
    <MusicFrame>
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
              <button type="button" className="ade-music-account" onClick={() => void musicActions.disconnect()} title="Disconnect Apple Music from ADE">
                <span className="kit-dot" data-state="ok" />
                <span className="min-w-0 flex-1 truncate">Connected</span>
                <SignOut size={13} />
              </button>
            ) : (
              <ConnectButton compact />
            )}
          </div>
        </aside>
        <main className="ade-music-main ade-chat-scene-plane" data-testid="music-main">
          {state.message || lastError ? (
            <div role="alert" className="ade-music-alert">
              <WarningCircle size={14} weight="fill" />
              <span className="min-w-0 flex-1 truncate" title={lastError ?? state.message ?? undefined}>{lastError ?? state.message}</span>
              {lastError ? (
                <button type="button" className="kit-icon-btn" onClick={musicActions.clearError} aria-label="Dismiss"><X size={12} /></button>
              ) : null}
            </div>
          ) : null}
          {main}
        </main>
      </div>
      <MusicNowPlayingBar
        queueOpen={view.kind === "queue"}
        onToggleQueue={() => setView((current) => (current.kind === "queue" ? { kind: "search" } : { kind: "queue" }))}
      />
    </MusicFrame>
  );
}

function MusicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="ade-chat-scene ade-music relative flex h-full min-h-0 flex-col text-fg" data-testid="music-page">
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

function ConnectButton({ compact = false }: { compact?: boolean }) {
  const connecting = useMusicState((s) => Boolean(s?.connecting));
  const hostStarting = useMusicState((s) => s?.host.status === "starting");
  const busy = connecting || hostStarting;
  return (
    <button
      type="button"
      className={compact ? "ade-music-connect is-compact" : "ade-music-connect"}
      onClick={() => void musicActions.connect()}
      disabled={busy}
      data-testid="music-connect"
    >
      {busy ? <CircleNotch size={14} className="animate-spin" /> : <MusicNotes size={14} weight="fill" />}
      {connecting ? "Waiting for Apple…" : hostStarting ? "Starting…" : "Connect Apple Music"}
    </button>
  );
}

function ConnectHero() {
  const connecting = useMusicState((s) => Boolean(s?.connecting));
  return (
    <div className="ade-music-connect-hero" data-testid="music-connect-hero">
      <span className="ade-music-connect-glyph"><MusicNotes size={34} weight="fill" /></span>
      <h1>Your music, inside ADE</h1>
      <p>Connect your Apple Music account to play songs, your library and playlists. Playback needs an Apple Music subscription.</p>
      <ConnectButton />
      {connecting ? <p className="ade-music-connect-note">Finish signing in to Apple in its own window. It may be behind ADE.</p> : null}
    </div>
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
            <MusicEmpty icon={<MagnifyingGlass size={22} />} title="Search songs, albums, playlists and artists" hint="Results play straight from Apple Music." />
          ) : (
            <ConnectHero />
          )
        ) : null}
        {results && !error && songs.length + results.albums.length + results.playlists.length + results.artists.length === 0 && !loading ? (
          <MusicEmpty icon={<MagnifyingGlass size={22} />} title={`Nothing found for “${debounced}”`} />
        ) : null}
        {songs.length ? (
          <section className="ade-music-section">
            <h3 className="kit-eyebrow">Songs</h3>
            <div className="ade-music-songs" role="table">
              {songs.slice(0, 10).map((item, index) => (
                <SongRow
                  key={item.id}
                  item={item}
                  index={index}
                  current={item.id === nowPlayingId}
                  playing={isPlaying}
                  onPlay={() => playSongs(index)}
                  onPlayNext={authorized ? () => void musicActions.playNext([item.id]) : undefined}
                  onPlayLater={authorized ? () => void musicActions.playLater([item.id]) : undefined}
                />
              ))}
            </div>
          </section>
        ) : null}
        {results?.artists.length ? (
          <TileSection title="Artists" items={results.artists.slice(0, 8)} onOpen={onOpen} />
        ) : null}
        {results?.albums.length ? (
          <TileSection title="Albums" items={results.albums} onOpen={onOpen} onPlay={authorized ? onPlayContainer : undefined} />
        ) : null}
        {results?.playlists.length ? (
          <TileSection title="Playlists" items={results.playlists} onOpen={onOpen} onPlay={authorized ? onPlayContainer : undefined} />
        ) : null}
      </div>
    </div>
  );
}

function TileSection({
  title,
  items,
  onOpen,
  onPlay,
}: {
  title: string;
  items: MusicItem[];
  onOpen: (item: MusicItem) => void;
  onPlay?: (item: MusicItem) => void;
}) {
  return (
    <section className="ade-music-section">
      <h3 className="kit-eyebrow">{title}</h3>
      <div className="ade-music-tiles is-grid">
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
            <h3 className="kit-eyebrow">Songs</h3>
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
      <div className="ade-music-scroll" ref={scrollRef}>
        <button type="button" className="ade-music-back" onClick={onBack}>
          <ArrowLeft size={13} /> Back
        </button>
        <header className="ade-music-hero">
          <MusicArt artwork={item.artwork} size={184} eager className="ade-music-hero-art" />
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
