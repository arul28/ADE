// Transcript-side chip enrichment — the other half of the composer's pill.
//
// The composer already asks the runtime for a page title and favicon
// (`createSmartLinkChipNode` → `window.ade.agentChat.resolveSmartLinkPreview`)
// and redraws its chip when the answer lands. The transcript did not, so the
// SAME link read "Release notes · ADE" with a favicon while you were typing it
// and reverted to `https://…` the moment you pressed enter.
//
// This module is the renderer-side cache that lets the transcript reuse that
// exact route without hammering it. It is deliberately NOT a React context:
// a transcript renders hundreds of chips, and a context would re-render every
// one of them whenever any single preview resolved. Instead each chip
// subscribes itself, and only the chips whose URL changed re-read the store.
//
// Three properties the transcript depends on:
//
//   - **One request per URL.** Two hundred messages quoting one link issue one
//     IPC call; concurrent askers share the in-flight promise.
//   - **Never throws.** A failed preview is cached as "nothing to add", so the
//     pill keeps its raw label and nothing retries in a loop.
//   - **Project-scoped.** The runtime service deliberately keeps authenticated
//     provider titles (Linear, GitHub) OUT of its process-global URL cache,
//     because those titles were read with one project's credentials. A cache
//     here keyed only by URL would reintroduce exactly that leak across a
//     project switch, so the key carries the active project's state key. Public
//     generic pages are cached by the runtime anyway; scoping them again here
//     costs one extra fetch per project and keeps one rule instead of two.

import { useEffect, useSyncExternalStore } from "react";

import type { Chip } from "../../../shared/chips";
import { selectActiveProjectStateKey, useAppStore } from "../../state/appStore";

export type ChipPreview = {
  /** Enriched page/issue title, or null when the fetch added nothing. */
  title: string | null;
  /** Sanitized, bounded favicon the runtime already validated. */
  iconDataUrl: string | null;
  /**
   * The page's og:image URL — a pointer only. The hover card fetches its bytes
   * on open (`useChipPreviewImage`); the pill itself never shows it.
   */
  imageUrl: string | null;
};

/** Cached "we asked and there was nothing to show" — stops the retry loop. */
const EMPTY_PREVIEW: ChipPreview = { title: null, iconDataUrl: null, imageUrl: null };

/** Bounded like the runtime's own cache; a long session must not grow forever. */
const MAX_ENTRIES = 256;
/**
 * The same ceiling for requests still awaiting an answer.
 *
 * An in-flight entry normally clears itself the moment its promise settles, and
 * the request body catches everything, so the only way one survives is an IPC
 * that never settles at all — a runtime that goes away mid-call over a relay.
 * Refusing to start request 257 costs nothing: the chip simply keeps the raw
 * label it is already showing, which is this module's documented degradation.
 */
const MAX_IN_FLIGHT = 256;
/** The runtime caps icons at 64 KiB; base64 inflates by 4/3, plus the header. */
const MAX_ICON_DATA_URL_LENGTH = 96 * 1024;

const resolvedByKey = new Map<string, ChipPreview>();
const inFlightByKey = new Map<string, Promise<ChipPreview>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function remember(key: string, value: ChipPreview): ChipPreview {
  // Delete-then-set keeps Map iteration order as an LRU list, so the eviction
  // below drops the least recently written entry.
  resolvedByKey.delete(key);
  resolvedByKey.set(key, value);
  while (resolvedByKey.size > MAX_ENTRIES) {
    const oldest = resolvedByKey.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    resolvedByKey.delete(oldest);
  }
  return value;
}

export function chipPreviewKey(url: string, scope: string): string {
  return `${scope}\n${url}`;
}

/**
 * The URL whose preview would improve this chip's pill, or null when it must
 * never be fetched.
 *
 * Only http(s) links reach the network: an `ade://` deeplink, an `@`-mention, a
 * file, and a folder are all resolved locally and have nothing to fetch. Of the
 * link kinds only `web_page` (title + favicon) and `linear_issue` (title, when
 * the runtime has a Linear connection) gain anything — a GitHub pill already
 * reads `owner/repo#123`, and its title belongs in the hover card, not in place
 * of the number.
 */
export function chipPreviewUrl(chip: Chip): string | null {
  if (chip.source.origin !== "url") return null;
  if (chip.kind !== "web_page" && chip.kind !== "linear_issue") return null;
  const url = chip.source.url;
  return /^https?:\/\//i.test(url) ? url : null;
}

function sanitizeIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ICON_DATA_URL_LENGTH) return null;
  // Defense in depth. The runtime already allow-lists the mime type and bounds
  // the body; this only guarantees the renderer never assigns an `img.src` that
  // is not an inline image, whatever a future transport does upstream.
  return /^data:image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : null;
}

function sanitizeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function sanitizeTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 180) : null;
}

/**
 * Resolve (or join the in-flight resolution of) one chip preview.
 *
 * Always fulfils: callers render a pill, not an error state, so a rejection has
 * nowhere to go. A failure is cached as `EMPTY_PREVIEW` for the rest of the
 * session rather than retried on every scroll.
 */
export function requestChipPreview(url: string, scope = ""): Promise<ChipPreview> {
  const key = chipPreviewKey(url, scope);
  const cached = resolvedByKey.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = inFlightByKey.get(key);
  if (existing) return existing;
  if (inFlightByKey.size >= MAX_IN_FLIGHT) return Promise.resolve(EMPTY_PREVIEW);

  const request = (async (): Promise<ChipPreview> => {
    let value = EMPTY_PREVIEW;
    try {
      // The composer's exact route. Optional all the way down: the webclient
      // adapter and older preloads may not expose it, and a missing method must
      // leave the raw label alone rather than throw into a render.
      const preview = await window.ade?.agentChat?.resolveSmartLinkPreview?.({ url });
      const title = sanitizeTitle(preview?.title);
      const iconDataUrl = sanitizeIconDataUrl(preview?.iconDataUrl);
      const imageUrl = sanitizeImageUrl(preview?.imageUrl);
      if (title || iconDataUrl || imageUrl) value = { title, iconDataUrl, imageUrl };
    } catch {
      value = EMPTY_PREVIEW;
    }
    remember(key, value);
    inFlightByKey.delete(key);
    emit();
    return value;
  })();

  inFlightByKey.set(key, request);
  return request;
}

/**
 * Subscribe one chip to its preview. Returns null until the answer lands, which
 * is what keeps the first paint synchronous: the pill draws its raw label, then
 * swaps in the title and favicon in place.
 */
export function useChipPreview(url: string | null): ChipPreview | null {
  // The project tab's scope is the CORRECT one here, and the only one available:
  // `resolveSmartLinkPreview` takes no pin (see preload — it is a plain
  // `callProjectRuntimeActionOr` on the "chat" domain), so the fetch always runs
  // on the tab's bound runtime. The cache must describe the runtime that
  // actually served it. A chat-scoped key would claim a per-machine answer this
  // route does not give. Contrast the hover card, which reads per-machine data
  // and therefore goes through `useChatRuntimeScope`.
  //
  // The CONTEXTUAL store, not the root one: a chat pane renders inside its
  // project's own store, and `useAppStore.getState()` would read the root's
  // (empty) project instead — scoping every preview to the same wrong bucket.
  // `useAppStore(selector)` reads that contextual store AND subscribes to it;
  // a one-shot `getState()` would not. A project switch keeps the chat pane
  // mounted, so a memoized transcript can carry a chip across it — and without
  // the subscription the chip's key would stay pinned to the old project and
  // keep showing its title and favicon.
  const scope = useAppStore(selectActiveProjectStateKey) ?? "";
  const key = url ? chipPreviewKey(url, scope) : null;
  const preview = useSyncExternalStore(
    subscribe,
    () => (key ? resolvedByKey.get(key) ?? null : null),
    () => null,
  );

  useEffect(() => {
    if (!url) return;
    void requestChipPreview(url, scope);
  }, [url, scope]);

  return preview;
}

// ---------------------------------------------------------------------------
// Preview images (og:image) for the link hover card.
//
// Fetched only when a card opens, never when a chip renders: a transcript of
// two hundred links must cost zero image reads until one is hovered. Keyed by
// image URL alone — the runtime only ever fetches PUBLIC hosts for it, with no
// credentials, so unlike titles the answer cannot differ per project.

export type ChipPreviewImage =
  | { status: "loading"; dataUrl: null }
  | { status: "ready"; dataUrl: string }
  | { status: "failed"; dataUrl: null };

const IMAGE_LOADING: ChipPreviewImage = { status: "loading", dataUrl: null };
const IMAGE_FAILED: ChipPreviewImage = { status: "failed", dataUrl: null };
/** The runtime caps images at 256 KiB; base64 inflates by 4/3, plus the header. */
const MAX_IMAGE_DATA_URL_LENGTH = 352 * 1024;
/** A renderer-side byte budget; the runtime keeps its own, larger cache. */
const MAX_IMAGE_CACHE_CHARS = 4 * 1024 * 1024;
const MAX_IMAGE_ENTRIES = 64;

const imagesByUrl = new Map<string, ChipPreviewImage>();
const imagesInFlight = new Map<string, Promise<ChipPreviewImage>>();
let imageCacheChars = 0;

function forgetImage(url: string): void {
  const entry = imagesByUrl.get(url);
  if (!entry) return;
  imageCacheChars -= entry.dataUrl?.length ?? 0;
  imagesByUrl.delete(url);
}

function rememberImage(url: string, value: ChipPreviewImage): ChipPreviewImage {
  forgetImage(url);
  imagesByUrl.set(url, value);
  imageCacheChars += value.dataUrl?.length ?? 0;
  while ((imageCacheChars > MAX_IMAGE_CACHE_CHARS || imagesByUrl.size > MAX_IMAGE_ENTRIES) && imagesByUrl.size > 1) {
    const oldest = imagesByUrl.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    forgetImage(oldest);
  }
  return value;
}

function sanitizeImageDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  // Bitmap types only (never SVG), whatever a future transport does upstream.
  return /^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

/** Resolve (or join) one preview image. Always fulfils; a miss is cached. */
export function requestChipPreviewImage(imageUrl: string): Promise<ChipPreviewImage> {
  const cached = imagesByUrl.get(imageUrl);
  if (cached) return Promise.resolve(cached);
  const existing = imagesInFlight.get(imageUrl);
  if (existing) return existing;

  const request = (async (): Promise<ChipPreviewImage> => {
    let value: ChipPreviewImage = IMAGE_FAILED;
    try {
      const result = await window.ade?.agentChat?.resolveSmartLinkImage?.({ url: imageUrl });
      const dataUrl = sanitizeImageDataUrl(result?.dataUrl);
      if (dataUrl) value = { status: "ready", dataUrl };
    } catch {
      value = IMAGE_FAILED;
    }
    rememberImage(imageUrl, value);
    imagesInFlight.delete(imageUrl);
    emit();
    return value;
  })();

  imagesInFlight.set(imageUrl, request);
  return request;
}

/**
 * Subscribe a hover card to one preview image. Pass null while the card is
 * closed: nothing is requested until it is non-null.
 */
export function useChipPreviewImage(imageUrl: string | null): ChipPreviewImage | null {
  const image = useSyncExternalStore(
    subscribe,
    () => (imageUrl ? imagesByUrl.get(imageUrl) ?? IMAGE_LOADING : null),
    () => null,
  );

  useEffect(() => {
    if (!imageUrl) return;
    void requestChipPreviewImage(imageUrl);
  }, [imageUrl]);

  return image;
}

export function resetChipPreviewCacheForTesting(): void {
  resolvedByKey.clear();
  inFlightByKey.clear();
  imagesByUrl.clear();
  imagesInFlight.clear();
  imageCacheChars = 0;
}
