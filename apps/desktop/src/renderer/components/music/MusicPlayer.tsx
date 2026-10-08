import React from "react";
import { AnimatePresence, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import {
  CaretDown,
  CircleNotch,
  Heart,
  Pause,
  Play,
  Queue,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerLow,
  SpeakerX,
} from "@phosphor-icons/react";

import { musicArtworkUrl, type MusicArtwork, type MusicRepeatMode } from "../../../shared/types/music";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { AppleMusicMark, MusicArt } from "./musicParts";
import { formatMusicTime, musicActions, useMusicLike, useMusicPosition, useMusicState } from "./musicStore";

/**
 * The player's shared parts, in one visual language across the Music tab's
 * focal card, its bottom bar and the top-bar mini player: a thin spring-filled
 * scrubber, a pill of round ghost buttons that grow on hover and press, and the
 * song's own artwork as a blurred tint behind it.
 *
 * Position ticks re-render only `MusicSeek` and `MusicMiniProgress`, never a
 * whole card. Motion follows ADE's Reduce motion setting and the OS one.
 */

/** Reduce motion: the OS preference or ADE's own (`html[data-motion="reduced"]`). */
export function useMusicReducedMotion(): boolean {
  const os = useReducedMotion();
  return Boolean(os) || (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced");
}

const MotionButton = motion.create(Button);

type IconButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A toggle that is on (shuffle, repeat, like): tinted and pressed. */
  on?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  children: React.ReactNode;
  testId?: string;
};

const ICON_BUTTON_SIZE = { sm: "h-6 w-6", md: "h-8 w-8", lg: "h-9 w-9" } as const;

/** A round ghost icon button that grows on hover and shrinks on press. */
export function PlayerIconButton({ label, onClick, disabled, on, size = "md", className, children, testId }: IconButtonProps) {
  const reduced = useMusicReducedMotion();
  return (
    <MotionButton
      type="button"
      variant="ghost"
      casing="sentence"
      className={cn(
        "ade-music-ibtn shrink-0 rounded-full p-0",
        ICON_BUTTON_SIZE[size],
        on && "is-on",
        className,
      )}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={on === undefined ? undefined : on}
      data-testid={testId}
      whileHover={reduced || disabled ? undefined : { scale: 1.1 }}
      whileTap={reduced || disabled ? undefined : { scale: 0.9 }}
      transition={{ type: "spring", stiffness: 500, damping: 28 }}
    >
      {children}
    </MotionButton>
  );
}

/* ---------- Slider ---------- */

type SliderProps = {
  /** 0..1 */
  value: number;
  /** While the pointer drags or a key steps. */
  onInput: (value: number) => void;
  /** On release (pointer up, key up). */
  onCommit: (value: number) => void;
  disabled?: boolean;
  label: string;
  /** Screen-reader text for the value, e.g. "1:02 of 3:45". */
  valueText?: string;
  /** Keyboard step as a fraction of the track. */
  step?: number;
  className?: string;
  testId?: string;
};

/**
 * A thin track filled to `value` with a spring. Click or drag anywhere on it
 * (the pointer is captured, so a drag can leave the track); arrows, Page keys,
 * Home and End step it. The fill and the thumb move by transform only.
 */
export function MusicSlider({ value, onInput, onCommit, disabled, label, valueText, step = 0.02, className, testId }: SliderProps) {
  const reduced = useMusicReducedMotion();
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const [active, setActive] = React.useState(false);
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const spring = useSpring(clamped, { stiffness: 300, damping: 30, mass: 0.6 });
  React.useEffect(() => {
    // Playback creeps forward a hair per tick: step it, so a playing track costs
    // one paint per tick instead of a spring running every frame. A real jump
    // (a seek, a new song, a skip) springs.
    const small = Math.abs(clamped - spring.get()) < 0.02;
    if (reduced || dragging.current || small) spring.jump(clamped);
    else spring.set(clamped);
  }, [clamped, reduced, spring]);
  const thumbX = useTransform(spring, (v) => `${v * 100}%`);

  const fractionAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return clamped;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragging.current = true;
    setActive(true);
    const next = fractionAt(event.clientX);
    spring.jump(next);
    onInput(next);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const next = fractionAt(event.clientX);
    spring.jump(next);
    onInput(next);
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    onCommit(fractionAt(event.clientX));
  };

  const stepped = React.useRef<number | null>(null);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const base = stepped.current ?? clamped;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = base + step;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = base - step;
    else if (event.key === "PageUp") next = base + step * 5;
    else if (event.key === "PageDown") next = base - step * 5;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    if (next === null) return;
    event.preventDefault();
    next = Math.min(1, Math.max(0, next));
    stepped.current = next;
    onInput(next);
  };
  const onKeyUp = () => {
    if (stepped.current === null) return;
    const next = stepped.current;
    stepped.current = null;
    onCommit(next);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      className={cn("ade-music-slider", active && "is-active", disabled && "is-disabled", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      data-testid={testId}
    >
      <span className="ade-music-slider-track">
        <motion.span className="ade-music-slider-fill" style={{ scaleX: spring }} />
      </span>
      <motion.span className="ade-music-slider-thumb-rail" style={{ x: thumbX }}>
        <span className="ade-music-slider-thumb" />
      </motion.span>
    </div>
  );
}

/* ---------- Seek ---------- */

/**
 * The scrubber and its times. The only part of a player that re-renders on the
 * position tick. `layout="stacked"` puts the times under the track (the card);
 * `"inline"` puts them on either side (the bar).
 */
export function MusicSeek({ layout = "stacked", disabled = false }: { layout?: "stacked" | "inline"; disabled?: boolean }) {
  const position = useMusicPosition(500);
  const duration = useMusicState((s) => s?.playback.duration ?? 0);
  const [scrub, setScrub] = React.useState<number | null>(null);
  const shown = scrub ?? position;
  const off = disabled || duration <= 0;
  const fraction = duration > 0 ? shown / duration : 0;
  const seekTo = (value: number) => {
    const seconds = value * duration;
    setScrub(seconds);
    void musicActions.seek(seconds).finally(() => setScrub(null));
  };
  const slider = (
    <MusicSlider
      value={fraction}
      onInput={(v) => setScrub(v * duration)}
      onCommit={seekTo}
      disabled={off}
      label="Seek"
      valueText={`${formatMusicTime(shown)} of ${formatMusicTime(duration)}`}
      step={duration > 0 ? Math.min(0.1, 5 / duration) : 0.02}
      testId="music-seek"
    />
  );
  const elapsed = <span className="kit-num">{formatMusicTime(shown)}</span>;
  const remaining = <span className="kit-num">{duration > 0 ? `-${formatMusicTime(Math.max(0, duration - shown))}` : "0:00"}</span>;
  if (layout === "inline") {
    return (
      <div className="ade-music-seek is-inline">
        {elapsed}
        {slider}
        {remaining}
      </div>
    );
  }
  return (
    <div className="ade-music-seek">
      {slider}
      <div className="ade-music-seek-times">
        {elapsed}
        {remaining}
      </div>
    </div>
  );
}

/** A 2px progress line for the top-bar mini player (one render a second). */
export function MusicMiniProgress() {
  const position = useMusicPosition(1000);
  const duration = useMusicState((s) => s?.playback.duration ?? 0);
  const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <span className="ade-mini-player-progress" aria-hidden>
      <span style={{ transform: `scaleX(${fraction})` }} />
    </span>
  );
}

/* ---------- Transport ---------- */

const NEXT_REPEAT: Record<MusicRepeatMode, MusicRepeatMode> = { 0: 2, 2: 1, 1: 0 };

/** Shuffle, back, play/pause, forward, repeat, in a soft pill. */
export function MusicTransport({ size = "md", disabled = false }: { size?: "md" | "lg"; disabled?: boolean }) {
  const reduced = useMusicReducedMotion();
  const isPlaying = useMusicState((s) => Boolean(s?.playback.isPlaying));
  const shuffle = useMusicState((s) => Boolean(s?.playback.shuffle));
  const repeat = useMusicState((s) => s?.playback.repeat ?? 0);
  const busy = useMusicState(
    (s) => s?.host.status === "starting" || s?.playback.state === "loading" || s?.playback.state === "waiting",
  );
  const glyph = size === "lg" ? 20 : 17;
  return (
    <div className={cn("ade-music-transport", size === "lg" && "is-lg")}>
      <PlayerIconButton
        label={shuffle ? "Shuffle on" : "Shuffle"}
        on={shuffle}
        disabled={disabled}
        onClick={() => void musicActions.setShuffle(!shuffle)}
      >
        <Shuffle size={glyph - 2} weight={shuffle ? "bold" : "regular"} />
      </PlayerIconButton>
      <PlayerIconButton label="Previous" disabled={disabled} onClick={() => void musicActions.previous()}>
        <SkipBack size={glyph} weight="fill" />
      </PlayerIconButton>
      <MotionButton
        type="button"
        variant="ghost"
        casing="sentence"
        className={cn("ade-music-play rounded-full p-0", size === "lg" ? "h-12 w-12" : "h-9 w-9")}
        onClick={() => void musicActions.toggle()}
        disabled={disabled}
        aria-label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        data-testid="music-play-toggle"
        whileHover={reduced || disabled ? undefined : { scale: 1.08 }}
        whileTap={reduced || disabled ? undefined : { scale: 0.9 }}
        transition={{ type: "spring", stiffness: 500, damping: 28 }}
      >
        {busy ? (
          <CircleNotch size={glyph} className="animate-spin" />
        ) : isPlaying ? (
          <Pause size={glyph + 2} weight="fill" />
        ) : (
          <Play size={glyph + 2} weight="fill" className="translate-x-[1px]" />
        )}
      </MotionButton>
      <PlayerIconButton label="Next" disabled={disabled} onClick={() => void musicActions.next()}>
        <SkipForward size={glyph} weight="fill" />
      </PlayerIconButton>
      <PlayerIconButton
        label={repeat === 1 ? "Repeat one" : repeat === 2 ? "Repeat all" : "Repeat"}
        on={repeat !== 0}
        disabled={disabled}
        onClick={() => void musicActions.setRepeat(NEXT_REPEAT[repeat])}
      >
        {repeat === 1 ? <RepeatOnce size={glyph - 2} weight="bold" /> : <Repeat size={glyph - 2} weight={repeat ? "bold" : "regular"} />}
      </PlayerIconButton>
    </div>
  );
}

/* ---------- Volume and like ---------- */

export function MusicVolume({ className }: { className?: string }) {
  const volume = useMusicState((s) => s?.playback.volume ?? 1);
  const [draft, setDraft] = React.useState<number | null>(null);
  const shown = draft ?? volume;
  const lastAudible = React.useRef(volume > 0 ? volume : 0.6);
  if (volume > 0) lastAudible.current = volume;
  const Icon = shown === 0 ? SpeakerX : shown < 0.5 ? SpeakerLow : SpeakerHigh;
  return (
    <div className={cn("ade-music-volume", className)}>
      <PlayerIconButton
        size="sm"
        label={volume > 0 ? "Mute" : "Unmute"}
        onClick={() => void musicActions.setVolume(volume > 0 ? 0 : lastAudible.current)}
      >
        <Icon size={15} />
      </PlayerIconButton>
      <MusicSlider
        value={shown}
        onInput={(v) => {
          setDraft(v);
          void musicActions.setVolume(v);
        }}
        onCommit={(v) => {
          void musicActions.setVolume(v).finally(() => setDraft(null));
        }}
        label="Volume"
        valueText={`${Math.round(shown * 100)}%`}
        step={0.05}
        testId="music-volume"
      />
    </div>
  );
}

export function MusicLikeButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { liked, canLike, toggle } = useMusicLike();
  if (!canLike) return null;
  return (
    <PlayerIconButton size={size} label={liked ? "Remove love" : "Love"} on={liked === true} onClick={toggle} className="ade-music-like">
      <Heart size={size === "sm" ? 15 : 17} weight={liked ? "fill" : "regular"} />
    </PlayerIconButton>
  );
}

/* ---------- Artwork backdrop ---------- */

/**
 * The song's artwork, tiny and blurred, as a tint behind a player. A 96px image
 * scaled up is already soft, so the blur stays cheap; it sits on a plane that
 * never scrolls. Cross-fades when the song changes.
 */
export function MusicArtBackdrop({ artwork, className }: { artwork: MusicArtwork | null | undefined; className?: string }) {
  const reduced = useMusicReducedMotion();
  const url = musicArtworkUrl(artwork, 96);
  const tint = artwork?.bgColor ? `#${artwork.bgColor}` : undefined;
  return (
    <div className={cn("ade-music-backdrop", className)} aria-hidden style={tint ? ({ "--music-tint": tint } as React.CSSProperties) : undefined}>
      <AnimatePresence initial={false}>
        {url ? (
          <motion.img
            key={url}
            src={url}
            alt=""
            draggable={false}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.6 }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* ---------- The focal card ---------- */

/**
 * The Music tab's Now Playing card: big artwork that settles back while paused,
 * title and artist, the scrubber, the transport pill, volume, Up Next.
 */
export function MusicPlayerCard({
  queueOpen,
  onToggleQueue,
  onCollapse,
}: {
  queueOpen: boolean;
  onToggleQueue: () => void;
  onCollapse: () => void;
}) {
  const reduced = useMusicReducedMotion();
  const nowPlaying = useMusicState((s) => s?.playback.nowPlaying ?? null);
  const isPlaying = useMusicState((s) => Boolean(s?.playback.isPlaying));
  const queuePosition = useMusicState((s) => s?.playback.queuePosition ?? -1);
  const queueLength = useMusicState((s) => s?.playback.queueLength ?? 0);
  const suspended = useMusicState((s) => s?.host.status === "suspended");
  if (!nowPlaying) return null;
  return (
    <motion.aside
      className="ade-music-player ade-chat-scene-plane"
      aria-label="Now playing"
      data-testid="music-player-card"
      initial={reduced ? false : { opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ type: "spring", duration: 0.45, bounce: 0.1, delay: 0.05 }}
    >
      <MusicArtBackdrop artwork={nowPlaying.artwork} />
      <div className="ade-music-player-inner">
        <header className="ade-music-player-head">
          <span className="kit-eyebrow">{suspended ? "Paused · resumes here" : "Now playing"}</span>
          {queueLength > 1 && queuePosition >= 0 ? (
            <span className="kit-num ade-music-player-count">
              {queuePosition + 1} of {queueLength}
            </span>
          ) : null}
          <PlayerIconButton size="sm" label="Hide player" onClick={onCollapse} className="ml-auto">
            <CaretDown size={14} weight="bold" />
          </PlayerIconButton>
        </header>

        <div className="ade-music-player-art-wrap">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={nowPlaying.id}
              className="ade-music-player-art"
              initial={reduced ? false : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: isPlaying || reduced ? 1 : 0.9 }}
              exit={reduced ? undefined : { opacity: 0, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 260, damping: 26 }}
            >
              <MusicArt artwork={nowPlaying.artwork} size={360} eager className="ade-music-player-img" />
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="ade-music-player-titles">
          <div className="min-w-0 flex-1">
            <div className="ade-music-player-title" title={nowPlaying.title}>
              {nowPlaying.title}
            </div>
            <div className="ade-music-player-artist" title={nowPlaying.artist}>
              {nowPlaying.artist}
            </div>
            {nowPlaying.album ? (
              <div className="ade-music-player-album" title={nowPlaying.album}>
                {nowPlaying.album}
              </div>
            ) : null}
          </div>
          <MusicLikeButton />
        </div>

        <MusicSeek />

        <div className="ade-music-player-controls">
          <MusicTransport size="lg" />
        </div>

        <div className="ade-music-player-foot">
          <MusicVolume className="flex-1" />
          <PlayerIconButton size="sm" label="Up Next" on={queueOpen} onClick={onToggleQueue}>
            <Queue size={15} />
          </PlayerIconButton>
        </div>
        <div className="ade-music-player-mark">
          <AppleMusicMark compact />
        </div>
      </div>
    </motion.aside>
  );
}
