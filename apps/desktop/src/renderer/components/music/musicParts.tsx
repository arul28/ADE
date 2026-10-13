import React from "react";
import { MusicNotesSimple, Pause, Play, Queue, ListPlus } from "@phosphor-icons/react";

import { musicArtworkUrl, type MusicArtwork, type MusicItem } from "../../../shared/types/music";
import { formatMusicTime } from "./musicStore";
import appleMusicBadgeUrl from "./assets/listen-on-apple-music-badge.svg";

/**
 * Artwork sizes are snapped to a few steps so the same picture is requested at
 * the same URL everywhere it appears; Chromium's HTTP cache then serves repeat
 * views (mzstatic sends long-lived cache headers).
 */
const ART_STEPS = [64, 128, 256, 400, 600];
function snapArt(px: number): number {
  return ART_STEPS.find((step) => step >= px) ?? ART_STEPS[ART_STEPS.length - 1]!;
}

export function MusicArt({
  artwork,
  size,
  round = false,
  className,
  eager = false,
}: {
  artwork: MusicArtwork | null | undefined;
  /** CSS pixels. */
  size: number;
  round?: boolean;
  className?: string;
  eager?: boolean;
}) {
  const url = musicArtworkUrl(artwork, snapArt(size * 2));
  // Keyed to the URL rather than reset in an effect: a blocked image fails
  // before an effect runs, and the reset then showed a broken-image icon.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const failed = failedUrl !== null && failedUrl === url;
  const bg = artwork?.bgColor ? `#${artwork.bgColor}` : undefined;
  return (
    <span
      className={`ade-music-art${round ? " is-round" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, background: bg }}
      aria-hidden
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <MusicNotesSimple size={Math.max(12, Math.round(size * 0.38))} weight="fill" />
      )}
    </span>
  );
}

/**
 * The Music tab's own mark: ADE's neutral glyph and the word "Music". It is
 * deliberately not an Apple Music icon look-alike; Apple's identity guidelines
 * allow only their official, unmodified artwork (see `AppleMusicBadge`).
 */
export function AppleMusicMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`ade-music-mark${compact ? " is-compact" : ""}`} title="Music from Apple Music">
      <span className="ade-music-mark-glyph" aria-hidden>
        <MusicNotesSimple size={compact ? 10 : 13} weight="bold" />
      </span>
      <span className="ade-music-mark-label">Apple Music</span>
    </span>
  );
}

/**
 * The Apple Music app icon as it looks on an iPhone: the red-to-pink rounded
 * square with a white beamed eighth note. Drawn here as an SVG, not Apple's
 * file; for strict brand compliance swap in the icon from Apple Music
 * Marketing Tools (tools.applemediaservices.com) at the same size.
 */
export function AppleMusicAppIcon({ size = 16, className }: { size?: number; className?: string }) {
  const id = `amg-${React.useId().replace(/:/g, "")}`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="50" y1="100" x2="50" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FA233B" />
          <stop offset="1" stopColor="#FB5C74" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22.5" fill={`url(#${id})`} />
      <g fill="#fff">
        {/* Beam, slanting up to the right, then the two stems and their heads. */}
        <path d="M38.2 25.6 L71.6 18.4 C72.9 18.1 74 19 74 20.4 V27.2 L38.2 34.9 Z" />
        <rect x="38.2" y="27" width="4.4" height="42.5" rx="1.2" />
        <rect x="69.6" y="20" width="4.4" height="42.5" rx="1.2" />
        <ellipse cx="32.4" cy="69.6" rx="9.6" ry="7.4" transform="rotate(-18 32.4 69.6)" />
        <ellipse cx="63.8" cy="62.6" rx="9.6" ry="7.4" transform="rotate(-18 63.8 62.6)" />
      </g>
    </svg>
  );
}

/** Apple's official "Listen on Apple Music" badge, unmodified, as attribution. */
export function AppleMusicBadge({ height = 28, className }: { height?: number; className?: string }) {
  return (
    <img
      className={`ade-music-badge${className ? ` ${className}` : ""}`}
      src={appleMusicBadgeUrl}
      alt="Listen on Apple Music"
      height={height}
      style={{ height, width: "auto" }}
      draggable={false}
    />
  );
}

/** Three bars that bounce while the row's song plays (CSS steps, cheap). */
export function NowPlayingBars({ playing }: { playing: boolean }) {
  return (
    <span className={`ade-music-bars${playing ? " is-playing" : ""}`} aria-label={playing ? "Playing" : "Paused"}>
      <i />
      <i />
      <i />
    </span>
  );
}

export const SONG_ROW_HEIGHT = 48;

export function SongRow({
  item,
  index,
  current,
  playing,
  showAlbum = true,
  showArt = true,
  onPlay,
  onPlayNext,
  onPlayLater,
  style,
}: {
  item: MusicItem;
  index: number;
  current: boolean;
  playing: boolean;
  showAlbum?: boolean;
  showArt?: boolean;
  onPlay: () => void;
  onPlayNext?: () => void;
  onPlayLater?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="row"
      className={`ade-music-song${current ? " is-current" : ""}`}
      style={style}
      onDoubleClick={onPlay}
      data-testid="music-song-row"
    >
      <button type="button" className="ade-music-song-lead" onClick={onPlay} aria-label={`Play ${item.title}`}>
        <span className="ade-music-song-index kit-num">
          {current ? <NowPlayingBars playing={playing} /> : index + 1}
        </span>
        <span className="ade-music-song-play">{current && playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}</span>
      </button>
      {showArt ? <MusicArt artwork={item.artwork} size={34} /> : null}
      <span className="ade-music-song-titles">
        <span className="ade-music-song-title">
          {item.title}
          {item.explicit ? <span className="ade-music-explicit" title="Explicit">E</span> : null}
        </span>
        <span className="ade-music-song-artist">{item.subtitle}</span>
      </span>
      {showAlbum ? <span className="ade-music-song-album">{item.album ?? ""}</span> : null}
      <span className="ade-music-song-actions">
        {onPlayNext ? (
          <button type="button" className="kit-icon-btn" onClick={onPlayNext} title="Play next" aria-label="Play next">
            <Queue size={14} />
          </button>
        ) : null}
        {onPlayLater ? (
          <button type="button" className="kit-icon-btn" onClick={onPlayLater} title="Add to Up Next" aria-label="Add to Up Next">
            <ListPlus size={14} />
          </button>
        ) : null}
      </span>
      <span className="ade-music-song-time kit-num">{item.durationMs ? formatMusicTime(item.durationMs / 1000) : ""}</span>
    </div>
  );
}

/* ---------- Covers for playlists Apple sends without artwork ----------
 * Like the Music app, such a playlist shows its first four songs' covers in a
 * 2x2 grid: four Apple artwork URLs at the cell's pixel size, laid out by CSS.
 * The four songs come from one `tracks` read with limit 4, made only once the
 * tile is on screen (and the window is visible), at most four at a time, and
 * kept in a bounded LRU here (the main process also caches it for 60 s).
 */
/**
 * Artwork the renderer can show. Art the user uploaded (a playlist cover, an
 * uploaded song) is served from `*.blobstore.apple.com`, which the renderer's
 * CSP blocks; a playlist with such a cover gets the four-song cover instead.
 */
export function loadableArtwork(artwork: MusicArtwork | null | undefined): artwork is MusicArtwork {
  return Boolean(artwork?.url) && !/^https:\/\/[^/]+\.blobstore\.apple\.com\//i.test(artwork!.url);
}

const COVER_CACHE_MAX = 300;
const COVER_CONCURRENCY = 4;
const coverCache = new Map<string, MusicArtwork[]>();
let coverRunning = 0;
const coverQueue: Array<() => void> = [];

function coverKey(item: MusicItem): string {
  return `${item.library ? "l" : "c"}:${item.id}`;
}

function rememberCover(key: string, arts: MusicArtwork[]): void {
  coverCache.delete(key);
  coverCache.set(key, arts);
  if (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value as string);
}

function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/** The distinct covers of a playlist's first four songs; null when it was no longer wanted. */
function loadCover(item: MusicItem, wanted: () => boolean): Promise<MusicArtwork[] | null> {
  const key = coverKey(item);
  const hit = coverCache.get(key);
  if (hit) {
    rememberCover(key, hit);
    return Promise.resolve(hit);
  }
  return new Promise((resolve) => {
    const run = async () => {
      if (!wanted()) {
        resolve(null);
        return;
      }
      coverRunning += 1;
      try {
        await whenVisible();
        if (!wanted()) {
          resolve(null);
          return;
        }
        const page = await window.ade!.music!.tracks({ kind: "playlist", id: item.id, library: item.library, offset: 0, limit: 4 });
        const arts = coverArts(page.items);
        rememberCover(key, arts);
        resolve(arts);
      } catch {
        resolve(null);
      } finally {
        coverRunning -= 1;
        coverQueue.shift()?.();
      }
    };
    if (coverRunning < COVER_CONCURRENCY) void run();
    else coverQueue.push(() => void run());
  });
}

/** The distinct, loadable covers of a collection's first four songs. */
export function coverArts(tracks: readonly MusicItem[]): MusicArtwork[] {
  const seen = new Set<string>();
  const arts: MusicArtwork[] = [];
  for (const track of tracks.slice(0, 4)) {
    if (loadableArtwork(track.artwork) && !seen.has(track.artwork.url)) {
      seen.add(track.artwork.url);
      arts.push(track.artwork);
    }
  }
  return arts;
}

/** Device pixels for a square of `cssPx`, rounded up to 32 so nearby sizes share a URL. */
function coverPixels(cssPx: number): number {
  const dpr = typeof window === "undefined" ? 2 : window.devicePixelRatio || 1;
  return Math.max(64, Math.ceil((cssPx * dpr) / 32) * 32);
}

function PlaylistCoverArt({ item }: { item: MusicItem }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const key = coverKey(item);
  const [cover, setCover] = React.useState<{ arts: MusicArtwork[]; tilePx: number } | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    let wanted = true;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((e) => e.isIntersecting);
        if (!entry) return;
        io.disconnect();
        const tilePx = entry.boundingClientRect.width || 168;
        void loadCover(item, () => wanted).then((arts) => {
          if (wanted && arts && arts.length) setCover({ arts, tilePx });
        });
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      wanted = false;
      io.disconnect();
    };
    // `item` is read once per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <MusicCoverArt ref={ref} arts={cover?.arts ?? []} size={168} displayPx={cover?.tilePx ?? 168} className="ade-music-tile-img" />;
}

/** Up to four covers: a 2x2 grid of four, one cover, or the note glyph. */
export const MusicCoverArt = React.forwardRef<
  HTMLSpanElement,
  { arts: MusicArtwork[]; size: number; displayPx?: number; className?: string; eager?: boolean }
>(function MusicCoverArt({ arts: given, size, displayPx = size, className, eager = false }, ref) {
  const [failed, setFailed] = React.useState(false);
  const arts = failed ? [] : given;
  const mosaic = arts.length >= 4;
  const loading = eager ? "eager" : "lazy";
  return (
    <span
      ref={ref}
      className={`ade-music-art${className ? ` ${className}` : ""}${mosaic ? " ade-music-cover-grid" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {mosaic ? (
        arts.slice(0, 4).map((art) => (
          <img key={art.url} src={musicArtworkUrl(art, coverPixels(displayPx / 2)) ?? undefined} alt="" loading={loading} decoding="async" draggable={false} onError={() => setFailed(true)} />
        ))
      ) : arts.length ? (
        <img src={musicArtworkUrl(arts[0], coverPixels(displayPx)) ?? undefined} alt="" loading={loading} decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <MusicNotesSimple size={Math.round(size * 0.38)} weight="fill" />
      )}
    </span>
  );
});

export function CollectionTile({
  item,
  onOpen,
  onPlay,
}: {
  item: MusicItem;
  onOpen: () => void;
  onPlay?: () => void;
}) {
  const round = item.kind === "artist";
  return (
    <div className={`ade-music-tile${round ? " is-artist" : ""}`} data-testid="music-tile">
      <button type="button" className="ade-music-tile-art" onClick={onOpen} aria-label={`Open ${item.title}`}>
        {item.kind === "playlist" && !loadableArtwork(item.artwork) ? (
          <PlaylistCoverArt item={item} />
        ) : (
          <MusicArt artwork={item.artwork} size={168} round={round} className="ade-music-tile-img" />
        )}
        {onPlay ? (
          <span
            role="button"
            tabIndex={-1}
            className="ade-music-tile-play"
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
            aria-label={`Play ${item.title}`}
          >
            <Play size={16} weight="fill" />
          </span>
        ) : null}
      </button>
      <button type="button" className="ade-music-tile-text" onClick={onOpen}>
        <span className="ade-music-tile-title">{item.title}</span>
        <span className="ade-music-tile-sub">
          {item.subtitle}
          {item.releaseYear && item.kind === "album" ? ` · ${item.releaseYear}` : ""}
        </span>
      </button>
    </div>
  );
}

export function MusicEmpty({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="ade-music-empty">
      <span className="ade-music-empty-icon">{icon}</span>
      <div className="ade-music-empty-title">{title}</div>
      {hint ? <div className="ade-music-empty-hint">{hint}</div> : null}
      {children}
    </div>
  );
}
