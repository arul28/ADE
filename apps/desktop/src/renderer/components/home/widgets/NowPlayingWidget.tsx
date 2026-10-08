import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { MusicNotes, Pause, Play, Repeat, RepeatOnce, Shuffle, SkipBack, SkipForward } from "@phosphor-icons/react";
import type { HomeNowPlayingCommand, HomeNowPlayingState } from "../../../../shared/types/homeWidgets";
import type { MusicRepeatMode } from "../../../../shared/types/music";
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
 * The source is whatever the computer plays. Main reads the OS media session
 * (Windows: the System Media Transport Controls; macOS: MediaRemote or
 * Music.app) only while this card is on screen. When ADE's own Music tab has a
 * song loaded, main hands the card to it (`source: "ade-music"`), and the card
 * then drives ADE's player directly: real seeking, shuffle and repeat. Another
 * app's session can only play, pause and skip, so seek, shuffle and repeat are
 * shown but off for it.
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
  /** Open where the music lives (ADE's Music tab), when it is ADE's own player. */
  onOpen?: () => void;
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
  const position = Math.min(durationMs || Number.POSITIVE_INFINITY, positionMs + (playing ? Math.max(0, now - updatedAt) : 0));
  const duration = durationMs / 1000;
  return <SeekLayout fraction={durationMs > 0 ? position / durationMs : 0} elapsed={position / 1000} duration={duration} />;
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
      <PlayerIconButton label={shuffle ? "Shuffle on" : "Shuffle"} on={shuffle} onClick={() => void musicActions.setShuffle(!shuffle)}>
        <Shuffle size={16} weight={shuffle ? "bold" : "regular"} />
      </PlayerIconButton>
    );
  }
  return (
    <PlayerIconButton
      label={repeat === 1 ? "Repeat one" : repeat === 2 ? "Repeat all" : "Repeat"}
      on={repeat !== 0}
      onClick={() => void musicActions.setRepeat(NEXT_REPEAT[repeat])}
    >
      {repeat === 1 ? <RepeatOnce size={16} weight="bold" /> : <Repeat size={16} weight={repeat ? "bold" : "regular"} />}
    </PlayerIconButton>
  );
}

function PlayerCard({ model, seek, still }: { model: CardModel; seek: React.ReactNode; still: boolean }) {
  const reduced = useMusicReducedMotion() || still;
  return (
    <motion.div
      className="ade-np2-player"
      initial={reduced ? false : { opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.3, ease: "easeInOut", delay: 0.1 }}
    >
      <div
        className={model.onOpen ? "ade-np2-cover is-link" : "ade-np2-cover"}
        role={model.onOpen ? "button" : undefined}
        tabIndex={model.onOpen ? 0 : undefined}
        title={model.onOpen ? "Open Music" : undefined}
        onClick={model.onOpen}
        onKeyDown={(event) => {
          if (model.onOpen && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            model.onOpen();
          }
        }}
      >
        {model.artwork ? (
          <motion.img
            key={model.artwork}
            src={model.artwork}
            alt=""
            draggable={false}
            initial={reduced ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: model.playing || reduced ? 1 : 0.94 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          />
        ) : (
          <span className="ade-np2-cover-empty"><MusicNotes size={30} /></span>
        )}
      </div>
      <div className="ade-np2-info">
        <h3 className="ade-np2-title" title={model.title}>{model.title}</h3>
        <span className="ade-np2-sub" title={model.subtitle}>{model.subtitle}</span>
      </div>
      {seek}
      <div className="ade-np2-controls">
        <div className="ade-np2-pill">
          {model.own ? <OwnModes which="shuffle" /> : (
            <PlayerIconButton label="Shuffle isn't available for this app" disabled onClick={() => {}}>
              <Shuffle size={16} />
            </PlayerIconButton>
          )}
          <PlayerIconButton label="Previous" disabled={!model.canPrevious} onClick={model.onPrevious}>
            <SkipBack size={16} weight="fill" />
          </PlayerIconButton>
          <PlayerIconButton label={model.playing ? "Pause" : "Play"} disabled={!model.canPlayPause} onClick={model.onToggle} className="ade-np2-play">
            {model.playing ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" />}
          </PlayerIconButton>
          <PlayerIconButton label="Next" disabled={!model.canNext} onClick={model.onNext}>
            <SkipForward size={16} weight="fill" />
          </PlayerIconButton>
          {model.own ? <OwnModes which="repeat" /> : (
            <PlayerIconButton label="Repeat isn't available for this app" disabled onClick={() => {}}>
              <Repeat size={16} />
            </PlayerIconButton>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** ADE's own player, straight from the Music store. */
function OwnPlayer({ still }: { still: boolean }) {
  const view = useMusicNowPlaying();
  const np = view.nowPlaying;
  if (!np) return null;
  const model: CardModel = {
    title: np.title,
    subtitle: np.artist,
    artwork: view.artworkUrl(220),
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
  return <PlayerCard model={model} seek={<OwnSeek />} still={still} />;
}

export default function NowPlayingWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const preview = useWidgetPreview();
  const span = useWidgetSpan(item);
  // A gallery preview shows the live state but must not hold the source open
  // after the gallery closes; it unsubscribes on unmount like the card does.
  const state = useNowPlaying(visible);
  const session = state?.session ?? null;
  const playing = session?.status === "playing";
  const send = (command: HomeNowPlayingCommand) => void window.ade?.home?.nowPlaying?.command(command);
  const still = !visible || preview;
  // ADE's own player wins whenever it has a song loaded (main hands the OS
  // source over the same way); reading the store directly also gives seeking.
  const music = useMusicNowPlaying();
  const own = state?.source === "ade-music" || Boolean(music.nowPlaying);
  const artwork = own ? (music.artworkUrl(220) ?? session?.artwork ?? null) : (session?.artwork ?? null);

  let body: React.ReactNode;
  if (!window.ade?.home?.nowPlaying) {
    body = <div className="ade-home-empty"><span>Available in the ADE desktop app.</span></div>;
  } else if (!state && !own) {
    body = <div className="ade-home-empty"><span>Listening…</span></div>;
  } else if (own) {
    body = <OwnPlayer still={still} />;
  } else if (!state || !state.available) {
    body = <div className="ade-home-empty"><MusicNotes size={18} aria-hidden /><span>{state?.error ?? "Now Playing is not available here."}</span></div>;
  } else if (!session) {
    body = (
      <div className="ade-np2-idle">
        <span className="ade-np2-cover-empty is-small"><MusicNotes size={22} /></span>
        <span className="ade-np2-title">Nothing playing</span>
        <span className="ade-np2-sub">Play music in ADE's Music tab or any app and it shows here.</span>

      </div>
    );
  } else {
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
    };
    body = (
      <PlayerCard
        model={model}
        still={still}
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
      data-playing={playing || undefined}
      data-still={still ? "true" : undefined}
    >
      {artwork ? <img className="ade-np2-backdrop" src={artwork} alt="" aria-hidden /> : null}
      {window.ade?.music ? (
        <button type="button" className="ade-np2-am" aria-label="Open Apple Music" title="Open Apple Music" onClick={musicActions.open}>
          <AppleMusicBadge height={24} />
        </button>
      ) : null}
      {body}
    </section>
  );
}
