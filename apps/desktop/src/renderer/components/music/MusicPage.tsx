import React from "react";
import {
  ArrowClockwise,
  CircleNotch,
  ClockCounterClockwise,
  Disc,
  MagnifyingGlass,
  MusicNotes,
  MusicNotesSimple,
  Playlist,
  Queue,
  WarningCircle,
} from "@phosphor-icons/react";

import type { MusicItem, MusicLibraryKind } from "../../../shared/types/music";
import { Banner } from "../ui/notice/Banner";
import { ChatSceneBackdrop } from "../personalChats/ChatSceneBackdrop";
import { MusicNowPlayingBar } from "./MusicNowPlayingBar";
import { MusicPlayerCard } from "./MusicPlayer";
import { AppleMusicMark } from "./musicParts";
import { queueableId } from "./musicQueue";
import { friendlyMusicError, musicActions, useMusicLastError, useMusicState } from "./musicStore";
import { ConnectButton, ConnectHero, SignInControls } from "./MusicWelcome";
import { MusicAccountArea } from "./MusicAccount";
import { DetailView } from "./MusicDetailView";
import { LibraryView, RecentView } from "./MusicLibraryView";
import { QueueView } from "./MusicQueueView";
import { SearchView } from "./MusicSearchView";
import "./music.css";

type View =
  | { kind: "search" }
  | { kind: "recent" }
  | { kind: "queue" }
  | { kind: "library"; library: MusicLibraryKind }
  | { kind: "detail"; item: MusicItem; back: View };

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
      void musicActions.playItems([queueableId(item) ?? item.id]);
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
            <Banner
              layout="inline"
              style={{ margin: "10px 14px 0", flex: "none" }}
              model={{
                id: "music-alert",
                tone: "warning",
                title: lastError ?? friendlyMusicError(message) ?? message ?? "",
                actions: [{
                  label: "Try again",
                  onClick: () => {
                    musicActions.clearError();
                    void musicActions.refresh();
                  },
                }],
                dismiss: lastError ? { onDismiss: musicActions.clearError } : false,
              }}
            />
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
