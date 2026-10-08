import type { WebContents, WebFrameMain } from "electron";

import type { HomeNowPlayingCommand, HomeNowPlayingSession } from "../../../shared/types/homeWidgets";
import { cleanTabTitle, siteSourceName } from "./nowPlayingSources";
import { sniffFaviconMime } from "../chat/sourceFaviconService";

/**
 * Now Playing sessions from ADE's built-in browser tabs (YouTube, YouTube
 * Music, SoundCloud, Spotify, Twitch…).
 *
 * Event-driven: every browser tab gets a few listeners (`media-started-playing`,
 * `media-paused`, `audio-state-changed`, title and navigation), and a tab is
 * read only when one fires. Reading runs one short script in the tab: the
 * page's `navigator.mediaSession` metadata, its playing media element and,
 * through the browser-media preload hook (`preload/browserMedia.ts`), the media
 * session actions the page registered. Only the one tab the widget shows is
 * re-read, at most once a second, and only while a widget is on screen.
 *
 * Controls press the page's own media session handlers when it has them
 * (play, pause, next, previous) and otherwise play or pause the media element.
 * Next and previous exist only where the page registered them.
 */

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

type PageArtwork = { src: string; sizes: string };
type PageIcon = { href: string; sizes: string; apple: boolean };
type PageRead = {
  title: string;
  artist: string;
  album: string;
  artwork: PageArtwork[];
  playbackState: string;
  actions: string[];
  icons: PageIcon[];
  docTitle: string;
  media: { paused: boolean; muted: boolean; currentTime: number; duration: number } | null;
};

type Entry = {
  wc: WebContents;
  session: HomeNowPlayingSession | null;
  timer: NodeJS.Timeout | null;
  reading: boolean;
  again: boolean;
  artworkUrl: string | null;
  artworkData: string | null;
  lastPlayingAt: number;
};

const READ_SCRIPT = `(() => {
  const q = {};
  try { window.dispatchEvent(new CustomEvent("__ade_media_query", { detail: q })); } catch {}
  const actions = Array.isArray(q.actions) ? q.actions.map(String) : [];
  const list = Array.from(document.querySelectorAll("video, audio"));
  if (q.element && !list.includes(q.element)) list.unshift(q.element);
  let el = null, best = -1;
  for (const c of list) {
    const d = Number.isFinite(c.duration) ? c.duration : (c.duration === Infinity ? 86400 : 0);
    const s = (!c.paused && !c.ended ? 1e7 : 0) + (c === q.element ? 1e6 : 0) + (c.currentTime > 0 ? 1e5 : 0) + Math.min(d, 86400);
    if (s > best) { best = s; el = c; }
  }
  const ms = navigator.mediaSession;
  const md = ms && ms.metadata;
  const artwork = md && md.artwork ? Array.from(md.artwork).slice(0, 12).map((a) => ({ src: String(a.src || ""), sizes: String(a.sizes || "") })) : [];
  const icons = Array.from(document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i]'))
    .slice(0, 16).map((l) => ({ href: l.href, sizes: l.getAttribute("sizes") || "", apple: /apple/i.test(l.rel) }));
  return {
    title: md ? String(md.title || "") : "",
    artist: md ? String(md.artist || "") : "",
    album: md ? String(md.album || "") : "",
    artwork,
    playbackState: ms ? String(ms.playbackState || "none") : "none",
    actions,
    icons,
    docTitle: String(document.title || ""),
    media: el ? {
      paused: el.paused || el.ended,
      muted: el.muted || el.volume === 0,
      currentTime: Number(el.currentTime) || 0,
      duration: Number.isFinite(el.duration) ? el.duration : (el.duration === Infinity ? -1 : 0),
    } : null,
  };
})()`;

/**
 * Presses a control in the page; resolves to whether this frame had anything
 * to press. Play and pause go to the media element when the page has one
 * (YouTube's own media session "play" does nothing during an ad, for one);
 * next and previous, and play or pause on a page with no element, press the
 * page's media session handlers.
 */
function commandScript(command: "play" | "pause" | "next" | "previous"): string {
  const action = command === "next" ? "nexttrack" : command === "previous" ? "previoustrack" : command;
  return `(() => {
  const q = {};
  try { window.dispatchEvent(new CustomEvent("__ade_media_query", { detail: q })); } catch {}
  const press = (action) => {
    if (!Array.isArray(q.actions) || !q.actions.includes(action)) return false;
    const d = { action };
    try { window.dispatchEvent(new CustomEvent("__ade_media_action", { detail: d })); } catch {}
    return d.handled === true;
  };
  const action = ${JSON.stringify(action)};
  if (action !== "play" && action !== "pause") return press(action);
  const list = Array.from(document.querySelectorAll("video, audio"));
  if (q.element && !list.includes(q.element)) list.unshift(q.element);
  if (action === "pause") {
    const playing = list.filter((c) => !c.paused && !c.ended);
    playing.forEach((c) => c.pause());
    return playing.length > 0 || press("pause");
  }
  const target = q.element || list.find((c) => c.currentTime > 0) || list[0];
  if (!target) return press("play");
  const p = target.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
  return true;
})()`;
}

const text = (value: unknown, max = 1024): string => (typeof value === "string" ? value.slice(0, max) : "");
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * The read script runs in the page's own world, so a hostile page can replace
 * anything it touches (`String`, `Array.from`, the media session) and hand
 * back any shape. Nothing from it is used before it is rebuilt here from
 * plain strings, finite numbers and booleans.
 */
function coercePageRead(value: unknown): PageRead | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const media = raw.media && typeof raw.media === "object" ? record(raw.media) : null;
  return {
    title: text(raw.title),
    artist: text(raw.artist),
    album: text(raw.album),
    artwork: list(raw.artwork, 12).map((item) => ({ src: text(record(item).src, 4096), sizes: text(record(item).sizes, 256) })),
    playbackState: text(raw.playbackState, 32),
    actions: list(raw.actions, 32).filter((action): action is string => typeof action === "string").map((action) => action.slice(0, 64)),
    icons: list(raw.icons, 16).map((item) => ({ href: text(record(item).href, 4096), sizes: text(record(item).sizes, 256), apple: record(item).apple === true })),
    docTitle: text(raw.docTitle),
    media: media
      ? { paused: media.paused !== false, muted: media.muted === true, currentTime: Math.max(0, finite(media.currentTime)), duration: finite(media.duration) }
      : null,
  };
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const POLL_MS = 1_000;
/** A read whose position is off from the running clock by more than this is news. */
const DRIFT_MS = 1_500;
/** Media shorter than this with no media session is a looping preview or a sound effect. */
const MIN_PLAIN_MEDIA_SECONDS = 10;
const ICON_CACHE_LIMIT = 32;

function parseSize(sizes: string): number {
  let best = 0;
  for (const token of sizes.split(/\s+/)) {
    if (token.toLowerCase() === "any") return 4096;
    const match = /^(\d+)x(\d+)$/i.exec(token);
    if (match) best = Math.max(best, Math.min(Number(match[1]), Number(match[2])));
  }
  return best;
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The largest artwork, up to 1024px (YouTube offers several thumbnails). */
function pickArtwork(artwork: PageArtwork[]): string | null {
  let best: { url: string; size: number } | null = null;
  for (const item of artwork) {
    const url = httpUrl(item.src);
    if (!url) continue;
    const size = parseSize(item.sizes) || 1;
    const score = size > 1024 ? 1024 - (size - 1024) / 1000 : size;
    if (!best || score > best.size) best = { url, size: score };
  }
  return best?.url ?? null;
}

/** The largest icon the page declares (an apple-touch-icon is usually 180px). */
function pickIcon(icons: PageIcon[], pageUrl: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const icon of icons) {
    const url = httpUrl(icon.href);
    if (!url) continue;
    const declared = parseSize(icon.sizes);
    const svg = /\.svg(\?|$)/i.test(url);
    const score = svg ? 512 : declared || (icon.apple ? 180 : 16);
    if (!best || score > best.score) best = { url, score };
  }
  if (best) return best.url;
  try {
    return new URL("/favicon.ico", pageUrl).toString();
  } catch {
    return null;
  }
}

/** An image through the tab's own session (its cookies, its proxy), as a data URL. */
async function fetchImageDataUrl(wc: WebContents, url: string): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await wc.session.fetch(url, { signal: controller.signal, credentials: "include", redirect: "follow" });
    if (!response.ok) return null;
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    // A server that names a type other than an image (an HTML error page for
    // /favicon.ico) is not an image. No type, or a generic one, is decided by
    // the bytes.
    const untyped = mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream";
    if (!mime.startsWith("image/") && !untyped) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const type = mime.startsWith("image/") ? mime : sniffFaviconMime(bytes);
    if (!type) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Main frame first, then a few subframes (an embedded player). */
function framesOf(wc: WebContents): WebFrameMain[] {
  const main = wc.mainFrame;
  if (!main) return [];
  const rest = main.framesInSubtree.filter((frame) => frame !== main).slice(0, 8);
  return [main, ...rest];
}

function sameSession(a: HomeNowPlayingSession, b: HomeNowPlayingSession): boolean {
  return a.title === b.title && a.artist === b.artist && a.album === b.album && a.status === b.status
    && a.durationMs === b.durationMs && a.canPlay === b.canPlay && a.canPause === b.canPause
    && a.canNext === b.canNext && a.canPrevious === b.canPrevious && a.artwork === b.artwork
    && a.appIcon === b.appIcon && a.app === b.app && a.browserTabId === b.browserTabId;
}

function expectedPosition(session: HomeNowPlayingSession, now: number): number {
  return session.positionMs + (session.status === "playing" ? Math.max(0, now - session.updatedAt) : 0);
}

export function createBrowserMediaSessions(args: {
  /** Where a tab lives: its id when it is a tab of the Browser top tab, else null. */
  browserTabIdFor: (wc: WebContents) => string | null;
  /** Let a hidden tab keep its sound (a person pressed play on it). */
  allowBackgroundAudio: (wc: WebContents) => void;
  onChange: () => void;
  logger?: Logger;
}) {
  const entries = new Map<number, Entry>();
  const watched = new WeakSet<WebContents>();
  const icons = new Map<string, Promise<string | null>>();
  let pollTarget: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const iconFor = (wc: WebContents, url: string): Promise<string | null> => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.resolve(null);
    }
    const key = `${origin}|${url}`;
    const cached = icons.get(key);
    if (cached) return cached;
    const pending = fetchImageDataUrl(wc, url);
    icons.set(key, pending);
    if (icons.size > ICON_CACHE_LIMIT) icons.delete(icons.keys().next().value!);
    void pending.then((value) => {
      // A failed fetch is retried on a later read rather than cached.
      if (!value && icons.get(key) === pending) icons.delete(key);
    });
    return pending;
  };

  const readFrame = async (frame: WebFrameMain): Promise<PageRead | null> => {
    try {
      return coercePageRead(await frame.executeJavaScript(READ_SCRIPT, false));
    } catch {
      // A frame that navigated or crashed mid-read.
      return null;
    }
  };

  /** The page, and the player from an embedded frame when the page itself has none. */
  const readPage = async (wc: WebContents): Promise<PageRead | null> => {
    const [main, ...subframes] = framesOf(wc);
    if (!main) return null;
    const page = await readFrame(main);
    if (page?.media) return page;
    for (const frame of subframes) {
      const inner = await readFrame(frame);
      if (!inner?.media) continue;
      if (!page) return inner;
      return {
        ...inner,
        title: page.title || inner.title,
        artist: page.title ? page.artist : inner.artist,
        album: page.title ? page.album : inner.album,
        artwork: page.artwork.length ? page.artwork : inner.artwork,
        actions: Array.from(new Set([...page.actions, ...inner.actions])),
        icons: page.icons,
        docTitle: page.docTitle,
      };
    }
    return page;
  };

  const toSession = async (entry: Entry, read: PageRead): Promise<HomeNowPlayingSession | null> => {
    const { wc } = entry;
    const media = read.media;
    const hasMetadata = Boolean(read.title || read.artist);
    // A muted autoplay preview or a short clip with no media session is not "now playing".
    const plainMedia = media && !media.muted && (media.duration === -1 || media.duration >= MIN_PLAIN_MEDIA_SECONDS);
    if (!hasMetadata && !plainMedia) return null;
    const pageUrl = wc.getURL();
    const site = siteSourceName(pageUrl);
    const playing = media ? !media.paused : read.playbackState === "playing";
    const has = (action: string) => read.actions.includes(action);

    const artworkUrl = pickArtwork(read.artwork);
    if (artworkUrl !== entry.artworkUrl) {
      entry.artworkUrl = artworkUrl;
      entry.artworkData = artworkUrl ? await fetchImageDataUrl(wc, artworkUrl) : null;
    }
    const iconUrl = pickIcon(read.icons, pageUrl);
    const appIcon = iconUrl ? await iconFor(wc, iconUrl) : null;
    const now = Date.now();
    if (playing) entry.lastPlayingAt = now;
    return {
      id: `tab:${wc.id}`,
      kind: "browser",
      app: site,
      appIcon,
      title: read.title || cleanTabTitle(read.docTitle || wc.getTitle(), site) || site || "Untitled",
      artist: read.artist || (read.title ? "" : site ?? ""),
      album: read.album,
      status: playing ? "playing" : "paused",
      positionMs: media ? Math.round(media.currentTime * 1000) : 0,
      durationMs: media && media.duration > 0 ? Math.round(media.duration * 1000) : 0,
      updatedAt: now,
      canPlay: Boolean(media) || has("play"),
      canPause: Boolean(media) || has("pause"),
      canNext: has("nexttrack"),
      canPrevious: has("previoustrack"),
      artwork: entry.artworkData,
      browserTabId: args.browserTabIdFor(wc),
    };
  };

  const refresh = async (entry: Entry) => {
    if (entry.reading) {
      entry.again = true;
      return;
    }
    entry.reading = true;
    try {
      do {
        entry.again = false;
        if (entry.wc.isDestroyed()) return;
        const read = await readPage(entry.wc);
        if (entry.wc.isDestroyed() || entries.get(entry.wc.id) !== entry) return;
        const next = read ? await toSession(entry, read) : null;
        const previous = entry.session;
        if (!next) {
          if (previous) {
            entry.session = null;
            args.onChange();
          }
          continue;
        }
        const now = Date.now();
        if (previous && sameSession(previous, next) && Math.abs(expectedPosition(previous, now) - next.positionMs) < DRIFT_MS) continue;
        entry.session = next;
        args.onChange();
      } while (entry.again);
    } finally {
      entry.reading = false;
    }
  };

  const schedule = (wc: WebContents, delayMs: number) => {
    if (wc.isDestroyed()) return;
    let entry = entries.get(wc.id);
    if (!entry) {
      entry = { wc, session: null, timer: null, reading: false, again: false, artworkUrl: null, artworkData: null, lastPlayingAt: 0 };
      entries.set(wc.id, entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    const target = entry;
    target.timer = setTimeout(() => {
      target.timer = null;
      void refresh(target);
    }, delayMs);
  };

  const drop = (wc: WebContents) => {
    const entry = entries.get(wc.id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entries.delete(wc.id);
    if (entry.session) args.onChange();
  };

  const stopPoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    /** Start listening to a browser tab. Idempotent; costs a few listeners, no reads. */
    watch(wc: WebContents) {
      if (watched.has(wc) || wc.isDestroyed()) return;
      watched.add(wc);
      const id = wc.id;
      wc.on("media-started-playing", () => schedule(wc, 150));
      wc.on("media-paused", () => schedule(wc, 150));
      wc.on("audio-state-changed", () => {
        if (entries.has(id)) schedule(wc, 150);
      });
      wc.on("page-title-updated", () => {
        if (entries.get(id)?.session) schedule(wc, 400);
      });
      wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
        if (isMainFrame && entries.get(id)?.session) schedule(wc, 600);
      });
      // A new document: whatever played is gone.
      wc.on("did-navigate", () => drop(wc));
      wc.once("destroyed", () => drop(wc));
    },
    /** Every tab with something loaded, freshest first. */
    sessions(): Array<HomeNowPlayingSession & { lastPlayingAt: number }> {
      const list: Array<HomeNowPlayingSession & { lastPlayingAt: number }> = [];
      for (const entry of entries.values()) {
        if (entry.session && !entry.wc.isDestroyed()) list.push({ ...entry.session, lastPlayingAt: entry.lastPlayingAt });
      }
      return list.sort((a, b) => b.lastPlayingAt - a.lastPlayingAt);
    },
    async command(sessionId: string, command: HomeNowPlayingCommand) {
      const id = Number(sessionId.replace(/^tab:/, ""));
      const entry = entries.get(id);
      if (!entry || entry.wc.isDestroyed()) return;
      const verb = command === "toggle" ? (entry.session?.status === "playing" ? "pause" : "play") : command;
      // Pressing play on a tab nobody is looking at is a person asking to hear it.
      if (verb === "play") args.allowBackgroundAudio(entry.wc);
      for (const frame of framesOf(entry.wc)) {
        try {
          if (await frame.executeJavaScript(commandScript(verb), true)) break;
        } catch {
          // Try the next frame.
        }
      }
      schedule(entry.wc, 200);
    },
    /**
     * Re-read this tab once a second while a widget is on screen and it plays
     * (title changes, seeks, the next video); null stops.
     */
    setPollTarget(sessionId: string | null) {
      const id = sessionId?.startsWith("tab:") ? Number(sessionId.slice(4)) : null;
      if (id === pollTarget) return;
      pollTarget = id;
      stopPoll();
      if (id == null) return;
      pollTimer = setInterval(() => {
        const entry = pollTarget == null ? null : entries.get(pollTarget);
        if (!entry || entry.wc.isDestroyed()) {
          stopPoll();
          pollTarget = null;
          return;
        }
        void refresh(entry);
      }, POLL_MS);
      pollTimer.unref?.();
    },
    dispose() {
      stopPoll();
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      entries.clear();
    },
  };
}

export type BrowserMediaSessions = ReturnType<typeof createBrowserMediaSessions>;
