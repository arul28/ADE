import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useNavigate } from "react-router-dom";
import { ArrowSquareOut, Globe, MusicNotes, Pause, Play, Repeat, RepeatOnce, Shuffle, SkipBack, SkipForward } from "@phosphor-icons/react";
import type { HomeNowPlayingCommand, HomeNowPlayingSession, HomeNowPlayingState } from "../../../../shared/types/homeWidgets";
import type { MusicRepeatMode } from "../../../../shared/types/music";
import { showTabInBrowserTab } from "../../browser/browserTab";
import { MusicSlider, PlayerIconButton, useMusicReducedMotion } from "../../music/MusicPlayer";
import { AppleMusicBadge } from "../../music/musicParts";
import { formatMusicTime, musicActions, useMusicNowPlaying, useMusicPosition, useMusicState } from "../../music/musicStore";
import { useWidgetPreview, useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../../music/music.css";
import "../homeWidgets.css";
import "./NowPlayingWidget.css";

/**
 * Now Playing, in the Music player's language: a frosted card with the cover
 * big and rounded, the title, a spring-filled scrubber with times, and a pill
 * of round ghost buttons (shuffle, back, play/pause, forward, repeat).
 *
 * The source is whatever plays, merged by main (`nowPlayingService.ts`):
 * ADE's own Music tab, a built-in browser tab playing media (YouTube,
 * SoundCloud…), or another app through the OS media session. Main picks the
 * best one (a playing ADE player, then a playing tab, then a playing app, then
 * the most recent paused) and lists the rest; a small switcher in the card's
 * top row shows another. That row names the source with its own icon (the
 * app's icon, the site's favicon); ADE's own player is named by the Apple
 * Music badge instead. Main reads the sources only while this card is on
 * screen.
 *
 * The cover keeps its own shape: album art is square, a video's thumbnail is
 * 16:9. It is drawn whole (contain) over a blurred copy of itself, so nothing
 * is cropped and the box never shows bars. A short or wide card lays out
 * sideways: the cover on the left at full height, the rest beside it.
 *
 * ADE's player is driven directly: real seeking, shuffle and repeat. A tab or
 * an app shows only the controls it has: play and pause, and next and
 * previous where the page or app offers them. A browser tab's cover (and its
 * open button) jumps to that tab in the Browser top tab.
 */

function useNowPlaying(active: boolean): HomeNowPlayingState | null {
  const [state, setState] = useState<HomeNowPlayingState | null>(null);
  useEffect(() => {
    const bridge = window.ade?.home?.nowPlaying;
    if (!active || !bridge) return undefined;
    let cancelled = false;
    const off = bridge.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void bridge.subscribe().then((next) => {
      if (!cancelled) setState(next);
    }).catch(() => {
      if (!cancelled) setState({ available: false, session: null, source: null, error: "Now Playing is unavailable." });
    });
    return () => {
      cancelled = true;
      off();
      void bridge.unsubscribe().catch(() => {});
    };
  }, [active]);
  return state;
}

/**
 * The cover's shape, read from the image itself once it loads: "wide" for a
 * video thumbnail (16:9, 4:3), "square" for album art and anything else.
 * Cached per source, so a re-render or a switch back costs nothing.
 */
const ART_SHAPE = new Map<string, "square" | "wide">();
function useArtShape(src: string | null): "square" | "wide" {
  const [shape, setShape] = useState<"square" | "wide">(() => (src ? ART_SHAPE.get(src) ?? "square" : "square"));
  useEffect(() => {
    if (!src) {
      setShape("square");
      return undefined;
    }
    const known = ART_SHAPE.get(src);
    if (known) {
      setShape(known);
      return undefined;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      const ratio = image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 1;
      const next = ratio >= 1.2 ? "wide" : "square";
      if (ART_SHAPE.size > 64) ART_SHAPE.clear();
      ART_SHAPE.set(src, next);
      if (!cancelled) setShape(next);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return shape;
}

const NEXT_REPEAT: Record<MusicRepeatMode, MusicRepeatMode> = { 0: 2, 2: 1, 1: 0 };

type CardModel = {
  title: string;
  subtitle: string;
  artwork: string | null;
  playing: boolean;
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Seek, shuffle and repeat: ADE's own player only. */
  own: boolean;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  /** Open where the music lives (ADE's Music tab, or the browser tab). */
  onOpen?: () => void;
  openLabel?: string;
  /** A browser tab: the open button shows in the controls too. */
  openButton?: boolean;
  /** Shown big on the cover when the source shares no artwork. */
  fallbackIcon?: string | null;
};

/** The scrubber and times for ADE's own player (real seeking). */
function OwnSeek() {
  const position = useMusicPosition(500);
  const duration = useMusicState((s) => s?.playback.duration ?? 0);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;
  return (
    <SeekLayout
      fraction={duration > 0 ? shown / duration : 0}
      elapsed={shown}
      duration={duration}
      onInput={(v) => setScrub(v * duration)}
      onCommit={(v) => {
        setScrub(v * duration);
        void musicActions.seek(v * duration).finally(() => setScrub(null));
      }}
    />
  );
}

/** The read-only scrubber for another app's session, run forward while playing. */
function SessionSeek({ positionMs, durationMs, updatedAt, playing, ticking }: { positionMs: number; durationMs: number; updatedAt: number; playing: boolean; ticking: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing || !ticking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [playing, ticking]);
  // A live stream or a page that shares no duration has nothing to scrub.
  if (!(durationMs > 0)) return null;
  const position = Math.min(durationMs, positionMs + (playing ? Math.max(0, now - updatedAt) : 0));
  return <SeekLayout fraction={position / durationMs} elapsed={position / 1000} duration={durationMs / 1000} />;
}

function SeekLayout({
  fraction,
  elapsed,
  duration,
  onInput,
  onCommit,
}: {
  fraction: number;
  elapsed: number;
  duration: number;
  onInput?: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  const disabled = !onCommit || duration <= 0;
  return (
    <div className="ade-np2-seek">
      <MusicSlider
        value={fraction}
        onInput={onInput ?? (() => {})}
        onCommit={onCommit ?? (() => {})}
        disabled={disabled}
        label="Seek"
        valueText={`${formatMusicTime(elapsed)} of ${formatMusicTime(duration)}`}
        step={duration > 0 ? Math.min(0.1, 5 / duration) : 0.02}
      />
      <div className="ade-np2-times kit-num">
        <span>{formatMusicTime(elapsed)}</span>
        <span>{duration > 0 ? formatMusicTime(duration) : "--:--"}</span>
      </div>
    </div>
  );
}

function OwnModes({ which }: { which: "shuffle" | "repeat" }) {
  const shuffle = useMusicState((s) => Boolean(s?.playback.shuffle));
  const repeat = useMusicState((s) => s?.playback.repeat ?? 0);
  if (which === "shuffle") {
    return (
      <PlayerIconButton className="ade-np2-mode" label={shuffle ? "Shuffle on" : "Shuffle"} on={shuffle} onClick={() => void musicActions.setShuffle(!shuffle)}>
        <Shuffle size={16} weight={shuffle ? "bold" : "regular"} />
      </PlayerIconButton>
    );
  }
  return (
    <PlayerIconButton
      className="ade-np2-mode"
      label={repeat === 1 ? "Repeat one" : repeat === 2 ? "Repeat all" : "Repeat"}
      on={repeat !== 0}
      onClick={() => void musicActions.setRepeat(NEXT_REPEAT[repeat])}
    >
      {repeat === 1 ? <RepeatOnce size={16} weight="bold" /> : <Repeat size={16} weight={repeat ? "bold" : "regular"} />}
    </PlayerIconButton>
  );
}

function Cover({ model, reduced }: { model: CardModel; reduced: boolean }) {
  return (
    <div
      className={model.onOpen ? "ade-np2-cover is-link" : "ade-np2-cover"}
      role={model.onOpen ? "button" : undefined}
      tabIndex={model.onOpen ? 0 : undefined}
      title={model.onOpen ? model.openLabel ?? "Open Music" : undefined}
      aria-label={model.onOpen ? model.openLabel ?? "Open Music" : undefined}
      onClick={model.onOpen}
      onKeyDown={(event) => {
        if (model.onOpen && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          model.onOpen();
        }
      }}
    >
      {model.artwork ? (
        <>
          <img className="ade-np2-cover-fill" src={model.artwork} alt="" aria-hidden draggable={false} />
          <motion.img
            key={model.artwork}
            className="ade-np2-cover-img"
            src={model.artwork}
            alt=""
            draggable={false}
            initial={reduced ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: model.playing || reduced ? 1 : 0.94 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          />
        </>
      ) : model.fallbackIcon ? (
        <span className="ade-np2-cover-empty is-icon"><img src={model.fallbackIcon} alt="" draggable={false} /></span>
      ) : (
        <span className="ade-np2-cover-empty"><MusicNotes size={30} /></span>
      )}
    </div>
  );
}

function PlayerCard({ model, seek, still, top }: { model: CardModel; seek: React.ReactNode; still: boolean; top: React.ReactNode }) {
  const reduced = useMusicReducedMotion() || still;
  return (
    <motion.div
      className="ade-np2-player"
      initial={reduced ? false : { opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.3, ease: "easeInOut", delay: 0.1 }}
    >
      <Cover model={model} reduced={reduced} />
      <div className="ade-np2-meta">
        {top}
        <div className="ade-np2-main">
          <div className="ade-np2-info">
            <h3 className="ade-np2-title" title={model.title}>{model.title}</h3>
            {model.subtitle ? <span className="ade-np2-sub" title={model.subtitle}>{model.subtitle}</span> : null}
          </div>
          {seek}
          <div className="ade-np2-controls">
            <div className="ade-np2-pill">
              {model.own ? <OwnModes which="shuffle" /> : null}
              {model.own || model.canPrevious ? (
                <PlayerIconButton label="Previous" disabled={!model.canPrevious} onClick={model.onPrevious}>
                  <SkipBack size={16} weight="fill" />
                </PlayerIconButton>
              ) : null}
              <PlayerIconButton label={model.playing ? "Pause" : "Play"} disabled={!model.canPlayPause} onClick={model.onToggle} className="ade-np2-play">
                {model.playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
              </PlayerIconButton>
              {model.own || model.canNext ? (
                <PlayerIconButton label="Next" disabled={!model.canNext} onClick={model.onNext}>
                  <SkipForward size={16} weight="fill" />
                </PlayerIconButton>
              ) : null}
              {model.own ? <OwnModes which="repeat" /> : null}
              {model.openButton && model.onOpen ? (
                <PlayerIconButton label={model.openLabel ?? "Open"} onClick={model.onOpen}>
                  <ArrowSquareOut size={16} />
                </PlayerIconButton>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/** A source's icon: its own (app icon, favicon), or a note. */
function SourceIcon({ session, size }: { session: HomeNowPlayingSession; size: number }) {
  if (session.appIcon) return <img className="ade-np2-src-icon" src={session.appIcon} alt="" width={size} height={size} draggable={false} />;
  return <MusicNotes className="ade-np2-src-icon" size={size} weight="fill" aria-hidden />;
}

/**
 * The top row: which source this is, by its own icon and name, then the
 * other sources as small icons to switch to; the Apple Music badge on the
 * right when ADE's own player is the one shown.
 */
function TopRow({ current, sessions, appleMusic }: { current: HomeNowPlayingSession | null; sessions: HomeNowPlayingSession[]; appleMusic: boolean }) {
  const others = sessions.filter((entry) => entry.id !== current?.id && !(current === null && entry.kind === "ade-music")).slice(0, 3);
  const showCurrent = current !== null && current.kind !== "ade-music";
  if (!showCurrent && others.length === 0 && !appleMusic) return null;
  const select = (id: string) => void window.ade?.home?.nowPlaying?.select(id).catch(() => {});
  return (
    <div className="ade-np2-top">
      <div className="ade-np2-sources">
        {showCurrent ? (
          <span className="ade-np2-src is-current" title={current.app ?? undefined}>
            <SourceIcon session={current} size={14} />
            {current.app ? <span className="ade-np2-src-name">{current.app}</span> : null}
            {current.status === "playing" ? <i className="ade-np2-src-live is-inline" aria-label="Playing" /> : null}
          </span>
        ) : null}
        {others.map((entry) => {
          const name = entry.kind === "ade-music" ? "Apple Music" : entry.app ?? "Another app";
          const label = `Show ${name}${entry.title ? `: ${entry.title}` : ""}`;
          return (
            <button key={entry.id} type="button" className="ade-np2-src is-other" title={label} aria-label={label} onClick={() => select(entry.id)}>
              <SourceIcon session={entry} size={14} />
              {entry.status === "playing" ? <i className="ade-np2-src-live" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {appleMusic ? (
        <button type="button" className="ade-np2-am" aria-label="Open Apple Music" title="Open Apple Music" onClick={musicActions.open}>
          <AppleMusicBadge height={22} />
        </button>
      ) : null}
    </div>
  );
}

/** Nothing plays: say where music comes from, with the two ways to start some. */
function IdleState({ onBrowser }: { onBrowser: () => void }) {
  return (
    <div className="ade-np2-idle">
      <span className="ade-np2-idle-art" aria-hidden><MusicNotes size={26} weight="fill" /></span>
      <div className="ade-np2-idle-text">
        <span className="ade-np2-idle-title">Nothing playing</span>
        <span className="ade-np2-idle-sub">Apple Music, a browser tab or any app on this computer shows up here.</span>
        <div className="ade-np2-idle-actions">
          {window.ade?.music ? (
            <button type="button" className="ade-np2-am" aria-label="Open Apple Music" title="Open Apple Music" onClick={musicActions.open}>
              <AppleMusicBadge height={28} />
            </button>
          ) : null}
          <button type="button" className="kit-btn ade-np2-idle-btn" onClick={onBrowser}>
            <Globe size={13} aria-hidden />
            Browser
          </button>
        </div>
      </div>
    </div>
  );
}

/** ADE's own player, straight from the Music store. */
function OwnPlayer({ still, top }: { still: boolean; top: React.ReactNode }) {
  const view = useMusicNowPlaying();
  const np = view.nowPlaying;
  if (!np) return null;
  const model: CardModel = {
    title: np.title,
    subtitle: np.artist,
    artwork: view.artworkUrl(320),
    playing: view.isPlaying,
    canPlayPause: true,
    canNext: true,
    canPrevious: true,
    own: true,
    onToggle: () => void musicActions.toggle(),
    onNext: () => void musicActions.next(),
    onPrevious: () => void musicActions.previous(),
    onOpen: musicActions.open,
  };
  return <PlayerCard model={model} seek={<OwnSeek />} still={still} top={top} />;
}

export default function NowPlayingWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const preview = useWidgetPreview();
  const span = useWidgetSpan(item);
  const navigate = useNavigate();
  // A gallery preview shows the live state but must not hold the source open
  // after the gallery closes; it unsubscribes on unmount like the card does.
  const state = useNowPlaying(visible);
  const session = state?.session ?? null;
  const sessions = state?.sessions ?? [];
  const playing = session?.status === "playing";
  const send = (command: HomeNowPlayingCommand) => void window.ade?.home?.nowPlaying?.command(command, session?.id);
  const still = !visible || preview;
  // ADE's own player is read straight from the Music store, which also gives
  // seeking. It wins while it plays (main ranks it first the same way) unless
  // the user picked another source; before main has answered, or with nothing
  // else loaded, a loaded song shows at once.
  const music = useMusicNowPlaying();
  const own = session?.kind === "ade-music"
    || (Boolean(music.nowPlaying) && ((music.isPlaying && !state?.picked) || !session));
  const artwork = own ? (music.artworkUrl(320) ?? session?.artwork ?? null) : (session?.artwork ?? null);
  const shape = useArtShape(artwork);
  // A source with no cover tints the card with its own icon (YouTube red, Spotify green).
  const backdrop = artwork ?? (own ? null : session?.appIcon ?? null);
  const hasBridge = Boolean(window.ade?.home?.nowPlaying);
  const top = hasBridge ? <TopRow current={own ? null : session} sessions={sessions} appleMusic={own && Boolean(window.ade?.music)} /> : null;

  let body: React.ReactNode;
  let idle = false;
  if (!hasBridge) {
    body = <div className="ade-home-empty"><span>Available in the ADE desktop app.</span></div>;
  } else if (!state && !own) {
    body = <div className="ade-home-empty"><span>Listening…</span></div>;
  } else if (own && music.nowPlaying) {
    body = <OwnPlayer still={still} top={top} />;
  } else if (!state || !state.available) {
    body = <div className="ade-home-empty"><MusicNotes size={18} aria-hidden /><span>{state?.error ?? "Now Playing is not available here."}</span></div>;
  } else if (!session) {
    idle = true;
    body = <IdleState onBrowser={() => navigate("/browser")} />;
  } else {
    const tabId = session.kind === "browser" ? session.browserTabId ?? null : null;
    const model: CardModel = {
      title: session.title || "Untitled",
      subtitle: session.artist || session.app || "",
      artwork,
      playing,
      canPlayPause: playing ? session.canPause : session.canPlay,
      canNext: session.canNext,
      canPrevious: session.canPrevious,
      own: false,
      onToggle: () => send(playing ? "pause" : "play"),
      onNext: () => send("next"),
      onPrevious: () => send("previous"),
      onOpen: tabId ? () => void showTabInBrowserTab(tabId, navigate) : undefined,
      openLabel: tabId ? `Show ${session.app ?? "this tab"} in the browser` : undefined,
      openButton: Boolean(tabId),
      fallbackIcon: session.appIcon,
    };
    body = (
      <PlayerCard
        model={model}
        still={still}
        top={top}
        seek={<SessionSeek positionMs={session.positionMs} durationMs={session.durationMs} updatedAt={session.updatedAt} playing={playing} ticking={visible && !preview} />}
      />
    );
  }

  return (
    <section
      className="kit-card ade-home-card ade-np2"
      aria-label="Now playing"
      data-size={item.size}
      data-wide={span.w >= 2 || undefined}
      data-art={shape}
      data-idle={idle || undefined}
      data-playing={playing || undefined}
      data-still={still ? "true" : undefined}
    >
      {backdrop && !idle ? <img className="ade-np2-backdrop" src={backdrop} alt="" aria-hidden /> : null}
      {body}
    </section>
  );
}
