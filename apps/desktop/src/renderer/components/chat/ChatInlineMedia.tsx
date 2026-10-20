import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  CircleNotch,
  File,
  FilmStrip,
  Image as ImageIcon,
  Pause,
  Play,
  SpeakerHigh,
  SpeakerSlash,
} from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { createPinnedFilesApi } from "../files/v2/pinnedFilesApi";
import { streamFileBytes } from "../files/v2/streamBytes";
import { cn } from "../ui/cn";
import { resolveWorkspaceMediaTarget } from "./chatWorkspacePaths";
import {
  inlineMediaFilename,
  inlineMediaKind,
  inlineMediaMime,
  INLINE_AUDIO_MAX_BYTES,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_VIDEO_MAX_BYTES,
  type InlineMediaKind,
} from "./chatInlineMediaUtils";

type MediaTarget = {
  workspaceId: string;
  relativePath: string;
};
type Resolution = MediaTarget | null;

/** Players that may be sounding; starting one pauses the rest. */
const activeAudioPlayers = new Set<HTMLAudioElement>();
const PLAYBACK_RATES = [1, 1.5, 2] as const;
const MEDIA_CHIP_CLASS = cn(
  "inline-flex max-w-full items-center gap-2 rounded-lg border border-(color:--chat-ink)/[0.1]",
  "bg-(color:--chat-ink)/[0.04] px-2.5 text-xs",
);

/** Render one local markdown media reference after it approaches the viewport. */
export function ChatInlineMedia({
  src,
  alt = "",
  pin,
  laneId,
  onOpen,
}: {
  src: string;
  alt?: string;
  pin: OpenProjectBinding | null;
  laneId: string | null;
  onOpen: (path: string) => void;
}) {
  const { ref, near } = useNearViewport<HTMLSpanElement>();
  const kind = inlineMediaKind(src);
  const name = inlineMediaFilename(src);
  const [target, setTarget] = useState<Resolution>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    setTarget(null);
    setResolved(false);
    void resolveWorkspaceMediaTarget({ path: src, pin, laneId })
      .then(async (next) => {
        if (cancelled) return;
        if (next) {
          await createPinnedFilesApi(pin).readFileRange({
            workspaceId: next.workspaceId,
            path: next.relativePath,
            offset: 0,
            length: 1,
          });
        }
        setTarget(next);
        setResolved(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn(`[chat-media] couldn't resolve ${src}`, error);
        setTarget(null);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
    // Pin identity is intentionally the machine key: recreated bindings for the
    // same machine must not restart resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, src, pin?.key, laneId]);

  const open = useCallback(() => onOpen(src), [onOpen, src]);
  if (!near || !resolved) {
    return (
      <span
        ref={ref}
        className="my-3 block h-10 w-56 max-w-full animate-pulse rounded-lg bg-(color:--chat-ink)/[0.06]"
      />
    );
  }
  if (!target) {
    return (
      <span ref={ref} className="my-3 block">
        <MediaFileChip name={name} kind={kind} unavailable onOpen={open} />
      </span>
    );
  }

  return (
    <span ref={ref} className="my-3 block min-w-0 max-w-full">
      {kind === "image" ? (
        <InlineImage target={target} pin={pin} name={name} alt={alt} onOpen={open} />
      ) : null}
      {kind === "audio" ? (
        <ChatInlineAudio
          name={name}
          target={target}
          pin={pin}
          onOpen={open}
        />
      ) : null}
      {kind === "video" ? (
        <InlineVideo target={target} pin={pin} name={name} onOpen={open} />
      ) : null}
      {kind === "file" ? <MediaFileChip name={name} kind={kind} onOpen={open} /> : null}
    </span>
  );
}

/** Inline player for a sent audio attachment or markdown audio reference. */
export function ChatInlineAudio({
  name,
  attachmentPath,
  target: providedTarget,
  mimeType,
  pin,
  laneId = null,
  onOpen,
}: {
  name: string;
  attachmentPath?: string;
  target?: MediaTarget;
  mimeType?: string;
  pin: OpenProjectBinding | null;
  laneId?: string | null;
  onOpen: () => void;
}) {
  const { ref, near } = useNearViewport<HTMLSpanElement>();
  const [resolvedTarget, setResolvedTarget] = useState<Resolution>(providedTarget ?? null);
  const [resolved, setResolved] = useState(Boolean(providedTarget));

  useEffect(() => {
    if (providedTarget || !near || !attachmentPath) return;
    let cancelled = false;
    setResolvedTarget(null);
    setResolved(false);
    void resolveWorkspaceMediaTarget({ path: attachmentPath, pin, laneId })
      .then((next) => {
        if (cancelled) return;
        setResolvedTarget(next);
        setResolved(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn(`[chat-media] couldn't resolve ${attachmentPath}`, error);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
    // Pin identity is intentionally the machine key; recreated bindings for the
    // same machine must not restart resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providedTarget, near, attachmentPath, pin?.key, laneId]);

  if (!near || !resolved) {
    return (
      <span
        ref={ref}
        className="block h-11 w-full max-w-[460px] animate-pulse rounded-lg bg-(color:--chat-ink)/[0.06]"
      />
    );
  }
  if (!resolvedTarget) {
    return (
      <span ref={ref} className="block">
        <MediaFileChip name={name} kind="audio" unavailable onOpen={onOpen} />
      </span>
    );
  }
  return (
    <span ref={ref} className="block">
      <AudioPlayer
        key={pin?.key ?? "bound"}
        name={name}
        mimeType={mimeType}
        target={resolvedTarget}
        pin={pin}
        onOpen={onOpen}
      />
    </span>
  );
}

function InlineImage({
  target,
  pin,
  name,
  alt,
  onOpen,
}: {
  target: MediaTarget;
  pin: OpenProjectBinding | null;
  name: string;
  alt: string;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void streamFileBytes(
      createPinnedFilesApi(pin),
      target.workspaceId,
      target.relativePath,
      { maxBytes: INLINE_IMAGE_MAX_BYTES },
    ).then((bytes) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: inlineMediaMime(name) }));
      setUrl(objectUrl);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.warn(`[chat-media] couldn't load image ${target.relativePath}`, error);
      setFailed(true);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // PinnedFilesApi is cached by pin.key, so object identity is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.workspaceId, target.relativePath, name, pin?.key]);

  if (failed) return <MediaFileChip name={name} kind="image" onOpen={onOpen} />;
  if (!url) {
    return <span className="block h-36 w-56 max-w-full animate-pulse rounded-xl bg-(color:--chat-ink)/[0.06]" />;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded-xl text-left"
      aria-label={`Open ${name} in Files`}
    >
      <img src={url} alt={alt || name} className="max-h-[360px] max-w-full rounded-xl object-contain" />
    </button>
  );
}

function InlineVideo({
  target,
  pin,
  name,
  onOpen,
}: {
  target: MediaTarget;
  pin: OpenProjectBinding | null;
  name: string;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoplayRef = useRef(false);
  const mountedRef = useMountedRef();

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  useEffect(() => {
    if (!url || !autoplayRef.current) return;
    autoplayRef.current = false;
    // Streaming crosses an async IPC boundary, which can outlive the browser's
    // transient user activation. Keep native controls available when Chromium
    // declines this autoplay attempt.
    void videoRef.current?.play().catch(() => {});
  }, [url]);

  const play = async () => {
    setFailed(false);
    setLoading(true);
    // Dropping the previous attempt's URL revokes it through the effect above.
    setUrl(null);
    try {
      const bytes = await streamFileBytes(
        createPinnedFilesApi(pin),
        target.workspaceId,
        target.relativePath,
        { maxBytes: INLINE_VIDEO_MAX_BYTES },
      );
      // An unmounted row has no effect left to revoke the URL; never create it.
      if (!mountedRef.current) return;
      autoplayRef.current = true;
      setUrl(URL.createObjectURL(new Blob([bytes], { type: inlineMediaMime(name) })));
    } catch (error) {
      if (!mountedRef.current) return;
      console.warn(`[chat-media] couldn't load video ${target.relativePath}`, error);
      setFailed(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  return (
    <span className="block">
      {failed ? (
        <MediaChip className="py-2 text-(color:--chat-ink)/75">
          <span className="min-w-0 truncate">Couldn’t load {name}</span>
          <button
            type="button"
            onClick={() => void play()}
            className="shrink-0 underline underline-offset-2"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 underline underline-offset-2"
          >
            Open in Files
          </button>
        </MediaChip>
      ) : null}
      {!url && !failed ? (
        <MediaChip className="gap-3 rounded-xl p-2.5 text-(color:--chat-ink)/80">
          <FilmStrip size={22} className="shrink-0 opacity-65" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>{name}</span>
          <button
            type="button"
            onClick={() => void play()}
            disabled={loading}
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-full",
              "bg-(color:--chat-ink)/[0.08] hover:bg-(color:--chat-ink)/[0.13] disabled:opacity-55",
            )}
            aria-label={`Play ${name}`}
          >
            {loading ? <CircleNotch size={15} className="animate-spin" /> : <Play size={15} weight="fill" />}
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 text-[10px] underline underline-offset-2"
          >
            Open in Files
          </button>
        </MediaChip>
      ) : null}
      <video
        ref={videoRef}
        hidden={!url || failed}
        src={url ?? undefined}
        controls
        preload="metadata"
        className="max-h-[360px] max-w-full rounded-xl"
        aria-label={name}
        onError={() => {
          if (videoRef.current?.src) setFailed(true);
        }}
      />
    </span>
  );
}

/** The bordered pill every inline media fallback and prompt shares. */
function MediaChip({
  className,
  title,
  onClick,
  children,
}: {
  className?: string;
  title?: string;
  /** Renders the chip itself as a button. */
  onClick?: () => void;
  children: ReactNode;
}) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cn(MEDIA_CHIP_CLASS, className)}>
        {children}
      </button>
    );
  }
  return <span title={title} className={cn(MEDIA_CHIP_CLASS, className)}>{children}</span>;
}

function MediaFileChip({
  name,
  kind,
  unavailable = false,
  onOpen,
}: {
  name: string;
  kind: InlineMediaKind;
  unavailable?: boolean;
  onOpen: () => void;
}) {
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? FilmStrip : File;
  return (
    <MediaChip
      onClick={onOpen}
      title={unavailable ? `${name} — Not available on this machine` : `Open ${name} in Files`}
      className="py-2 text-left text-(color:--chat-ink)/78 transition-colors hover:bg-(color:--chat-ink)/[0.08]"
    >
      <Icon size={15} className="shrink-0 opacity-65" aria-hidden />
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span
        className={cn(
          "shrink-0 text-[10px]",
          unavailable ? "text-(color:--chat-ink)/45" : "text-(color:--chat-ink)/55",
        )}
      >
        {unavailable ? "Not available on this machine" : "Open in Files"}
      </span>
    </MediaChip>
  );
}

/** Pause every other inline player and forget players no longer in the page. */
function claimAudioFocus(audio: HTMLAudioElement) {
  for (const player of activeAudioPlayers) {
    if (!player.isConnected) activeAudioPlayers.delete(player);
    else if (player !== audio) player.pause();
  }
  activeAudioPlayers.add(audio);
}

function AudioPlayer({
  name,
  mimeType,
  target,
  pin,
  onOpen,
}: {
  name: string;
  mimeType?: string;
  target: MediaTarget;
  pin: OpenProjectBinding | null;
  onOpen: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingLoadRef = useRef<Promise<HTMLAudioElement | null> | null>(null);
  const mountedRef = useMountedRef();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rateIndex, setRateIndex] = useState(0);

  const load = useCallback((retry = false): Promise<HTMLAudioElement | null> => {
    const audio = audioRef.current;
    if (!audio) return Promise.resolve(null);
    if (!retry && url && audio.src === url) return Promise.resolve(audio);
    if (pendingLoadRef.current) return pendingLoadRef.current;

    if (retry && url) {
      // Dropping the URL revokes it through the effect below.
      audio.removeAttribute("src");
      audio.load();
      setUrl(null);
    }
    setLoading(true);
    setFailed(false);
    setTooLarge(false);
    const request = streamFileBytes(
      createPinnedFilesApi(pin),
      target.workspaceId,
      target.relativePath,
      { maxBytes: INLINE_AUDIO_MAX_BYTES },
    ).then((bytes) => {
      // An unmounted row has no effect left to revoke the URL; never create it.
      if (!mountedRef.current) return null;
      const nextUrl = URL.createObjectURL(new Blob([bytes], { type: inlineMediaMime(name, mimeType) }));
      audio.src = nextUrl;
      setUrl(nextUrl);
      return audio;
    }).catch((error: unknown) => {
      if (!mountedRef.current) return null;
      if (error instanceof Error && /too large/i.test(error.message)) {
        setTooLarge(true);
      } else {
        console.warn(`[chat-media] couldn't load audio ${target.relativePath}`, error);
        setFailed(true);
      }
      return null;
    }).finally(() => {
      pendingLoadRef.current = null;
      if (mountedRef.current) setLoading(false);
    });
    pendingLoadRef.current = request;
    return request;
    // PinnedFilesApi is cached by pin.key, so object identity is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, pin?.key, target.workspaceId, target.relativePath, name, mimeType]);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  useEffect(() => {
    // The element stays mounted for the player's whole life, so capture it now:
    // React clears the ref before this cleanup runs.
    const audio = audioRef.current;
    return () => {
      if (audio) activeAudioPlayers.delete(audio);
    };
  }, []);

  const play = async (retry = false) => {
    const audio = await load(retry);
    if (!audio) return;
    claimAudioFocus(audio);
    audio.playbackRate = PLAYBACK_RATES[rateIndex]!;
    await audio.play().catch(() => setFailed(true));
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (audio && !audio.paused) {
      audio.pause();
      return;
    }
    void play();
  };

  const formatTime = (seconds: number) => (
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
  );
  const playedPercent = duration ? Math.min(100, (current / duration) * 100) : 0;
  const bufferedPercent = duration
    ? Math.max(playedPercent, Math.min(100, (buffered / duration) * 100))
    : 0;
  const seekStyle = {
    background: `linear-gradient(to right, var(--chat-accent) 0%, var(--chat-accent) ${playedPercent}%, `
      + `color-mix(in srgb, var(--chat-accent) 32%, transparent) ${playedPercent}%, `
      + `color-mix(in srgb, var(--chat-accent) 32%, transparent) ${bufferedPercent}%, `
      + `color-mix(in srgb, var(--chat-ink) 12%, transparent) ${bufferedPercent}%, `
      + "color-mix(in srgb, var(--chat-ink) 12%, transparent) 100%)",
  };

  // The <audio> element stays mounted in every branch: Retry reloads into it,
  // and the active-player registry holds on to it.
  const audioElement = (
    <audio
      ref={audioRef}
      hidden
      preload="none"
      onPlay={() => {
        const audio = audioRef.current;
        if (!audio) return;
        claimAudioFocus(audio);
        setPlaying(true);
      }}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onError={() => {
        if (audioRef.current?.src) setFailed(true);
      }}
      onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
      onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
      onProgress={(event) => {
        const media = event.currentTarget;
        if (media.buffered.length) setBuffered(media.buffered.end(media.buffered.length - 1));
      }}
    />
  );

  if (tooLarge || failed) {
    return (
      <>
        {audioElement}
        <MediaChip className="min-h-11 text-(color:--chat-ink)/72">
          <span className="min-w-0 truncate">
            {tooLarge ? "Too large to play inline" : "Couldn’t play audio"}
          </span>
          {failed ? (
            <button
              type="button"
              className="rounded p-1 hover:bg-(color:--chat-ink)/[0.08]"
              onClick={() => void play(true)}
              aria-label="Retry audio"
            >
              <ArrowClockwise size={14} />
            </button>
          ) : null}
          <button type="button" onClick={onOpen} className="shrink-0 underline underline-offset-2">Open in Files</button>
        </MediaChip>
      </>
    );
  }

  return (
    <>
      {audioElement}
      <span
        className={cn(
          "flex h-11 w-full max-w-[520px] min-w-0 items-center gap-2 rounded-lg border",
          "border-(color:--chat-ink)/[0.1] bg-(color:--chat-ink)/[0.04] px-2 text-(color:--chat-ink)/82",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={loading}
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-full",
            "hover:bg-(color:--chat-ink)/[0.09] disabled:opacity-45",
          )}
          aria-label={playing ? "Pause audio" : "Play audio"}
        >
          {loading ? (
            <CircleNotch size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} weight="fill" />
          ) : (
            <Play size={14} weight="fill" />
          )}
        </button>
        <input
          aria-label="Seek audio"
          type="range"
          min={0}
          max={Math.max(duration, 0)}
          step="0.1"
          value={Math.min(current, duration || current)}
          onChange={(event) => {
            const audio = audioRef.current;
            if (audio) {
              audio.currentTime = Number(event.target.value);
              setCurrent(audio.currentTime);
            }
          }}
          style={seekStyle}
          className={cn(
            "h-1.5 min-w-8 flex-1 appearance-none rounded-full bg-transparent",
            "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full",
            "[&::-webkit-slider-thumb]:-mt-0.5 [&::-webkit-slider-thumb]:h-2.5",
            "[&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-(color:--chat-accent)",
            "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full",
            "[&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5",
            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
            "[&::-moz-range-thumb]:bg-(color:--chat-accent)",
          )}
        />
        <span className="shrink-0 text-[10px] tabular-nums text-(color:--chat-ink)/56">
          {formatTime(current)} / {duration > 0 ? formatTime(duration) : "–:––"}
        </span>
        <span
          className="hidden min-w-0 max-w-[100px] truncate text-[10px] text-(color:--chat-ink)/65 sm:block"
          title={name}
        >
          {name}
        </span>
        <button
          type="button"
          onClick={() => {
            const nextMuted = !muted;
            setMuted(nextMuted);
            if (audioRef.current) audioRef.current.muted = nextMuted;
          }}
          aria-label={muted ? "Unmute audio" : "Mute audio"}
          className="grid h-7 w-7 shrink-0 place-items-center rounded hover:bg-(color:--chat-ink)/[0.09]"
        >
          {muted ? <SpeakerSlash size={14} /> : <SpeakerHigh size={14} />}
        </button>
        <button
          type="button"
          onClick={() => {
            const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
            setRateIndex(nextIndex);
            if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_RATES[nextIndex]!;
          }}
          aria-label={`Playback speed ${PLAYBACK_RATES[rateIndex]} times`}
          className="shrink-0 rounded px-1 text-[10px] tabular-nums hover:bg-(color:--chat-ink)/[0.08]"
        >
          {PLAYBACK_RATES[rateIndex]}×
        </button>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${name} in Files`}
          title="Open in Files"
          className={cn(
            "shrink-0 rounded px-1.5 py-1 text-[10px] text-(color:--chat-ink)/60",
            "hover:bg-(color:--chat-ink)/[0.08]",
          )}
        >
          Open
        </button>
      </span>
    </>
  );
}

/** Tracks whether the component is still mounted, for work that outlives it. */
function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin: "320px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, near };
}
