import { randomUUID } from "node:crypto";

import { SCENE_CONTENT_SECURITY_POLICY } from "../../../shared/chatScene";

/**
 * Backing store for the `ade-scene:` scheme.
 *
 * A scene is agent-authored HTML. It is served from memory and never from
 * disk: `prepare()` keeps the document under a random id and hands back
 * `ade-scene://view/<id>`, and the protocol handler can only ever answer with a
 * document that was put here first. There is no path in the URL to sanitize, no
 * jail to get wrong, and nothing on the filesystem the scheme can reach — which
 * is the entire reason it works this way rather than writing a temp file.
 *
 * Everything below is deliberately free of Electron: the handler in `main.ts`
 * is a three-line adapter over `respond()`, so the interesting logic is unit
 * testable without booting a browser process.
 */

export const SCENE_PROTOCOL_SCHEME = "ade-scene";

/**
 * A long chat can prepare a scene per streamed revision, so the map has to be
 * bounded. 64 documents at the 96 KB source cap is a few megabytes worst case,
 * and the only cost of evicting one is that a frame which reloads an ancient
 * scene gets a 404 instead of a re-render.
 */
export const SCENE_STORE_CAPACITY = 64;

/** What the protocol handler should send. Plain data so tests never need `Response`. */
export type SceneResponseDescriptor = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export type PreparedScene = {
  id: string;
  url: string;
};

export type SceneDocumentStore = {
  /** Store a document and return the URL a frame can load it from. */
  put(html: string): PreparedScene;
  get(id: string): string | null;
  respond(requestUrl: string): SceneResponseDescriptor;
  size(): number;
  clear(): void;
};

const NOT_FOUND: SceneResponseDescriptor = {
  status: 404,
  body: "Not found",
  headers: { "Content-Type": "text/plain; charset=utf-8" },
};

/**
 * Pull the id out of `ade-scene://view/<id>`.
 *
 * The scheme is registered as non-standard, so Chromium hands the URL through
 * mostly untouched; both the authority form and the `ade-scene:///view/<id>`
 * form are accepted because which one survives depends on how the URL was
 * written, not on anything the caller controls. Anything else is rejected
 * rather than guessed at.
 */
export function parseSceneRequestId(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCENE_PROTOCOL_SCHEME}:`) return null;

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    // A malformed percent-escape throws; an id that cannot be decoded is not an
    // id we ever minted.
    return null;
  }

  if (url.hostname === "view") return segments.length === 1 ? segments[0]! : null;
  if (!url.hostname && segments.length === 2 && segments[0] === "view") return segments[1]!;
  return null;
}

export function createSceneDocumentStore(options: {
  capacity?: number;
  /** Injectable only so tests can assert eviction order deterministically. */
  makeId?: () => string;
} = {}): SceneDocumentStore {
  const capacity = Math.max(1, Math.floor(options.capacity ?? SCENE_STORE_CAPACITY));
  const makeId = options.makeId ?? (() => randomUUID().replace(/-/g, ""));
  // Insertion-ordered, so the first key is always the oldest document.
  const documents = new Map<string, string>();

  const put = (html: string): PreparedScene => {
    const id = makeId();
    // Re-inserting a colliding id would keep its original position in the map
    // and make it evict out of order; delete first so insertion order is real.
    documents.delete(id);
    documents.set(id, String(html ?? ""));
    while (documents.size > capacity) {
      const oldest = documents.keys().next();
      if (oldest.done) break;
      documents.delete(oldest.value);
    }
    return { id, url: `${SCENE_PROTOCOL_SCHEME}://view/${id}` };
  };

  const get = (id: string): string | null => documents.get(id) ?? null;

  const respond = (requestUrl: string): SceneResponseDescriptor => {
    const id = parseSceneRequestId(requestUrl);
    if (!id) return NOT_FOUND;
    const html = documents.get(id);
    if (html === undefined) return NOT_FOUND;
    return {
      status: 200,
      body: html,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Sent as a header as well as the in-document meta tag. Neither half is
        // load bearing alone: the meta survives a blob fallback, the header
        // survives a document whose <head> was mangled.
        "Content-Security-Policy": SCENE_CONTENT_SECURITY_POLICY,
        "Referrer-Policy": "no-referrer",
      },
    };
  };

  return {
    put,
    get,
    respond,
    size: () => documents.size,
    clear: () => documents.clear(),
  };
}

/**
 * The one store the app uses. Both the `ade-scene:` handler (main.ts) and the
 * `scene.prepare` IPC (registerIpc.ts) run in the main process, so a module
 * singleton is the whole wiring.
 */
export const sceneDocumentStore = createSceneDocumentStore();

export type SceneCaptureRect = { x: number; y: number; width: number; height: number };

/**
 * Clamp a renderer-supplied rect to the window's content box.
 *
 * The renderer measures with `getBoundingClientRect()`, which can report a
 * scrolled-out or fractional rect; `capturePage` with a rect that leaves the
 * page resolves an empty image. Returns null when nothing capturable is left.
 *
 * INTERSECTION, not a shift. Clamping the origin on its own while keeping the
 * size froze a scene that had scrolled above the viewport as a picture of
 * whatever was at the top of the window: `{y: -300, height: 400}` became
 * `{y: 0, height: 400}` — a rect the same size as the scene, in a place the
 * scene was not. Intersecting keeps only the part that is genuinely on screen,
 * and answers null when that is nothing.
 */
export function clampSceneCaptureRect(
  rect: SceneCaptureRect | null | undefined,
  content: { width: number; height: number },
): SceneCaptureRect | null {
  if (!rect) return null;
  const maxWidth = Math.floor(content.width);
  const maxHeight = Math.floor(content.height);
  if (!Number.isFinite(maxWidth) || !Number.isFinite(maxHeight) || maxWidth < 1 || maxHeight < 1) {
    return null;
  }
  const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : NaN);
  const rawX = numeric(rect.x);
  const rawY = numeric(rect.y);
  const rawWidth = numeric(rect.width);
  const rawHeight = numeric(rect.height);
  if ([rawX, rawY, rawWidth, rawHeight].some((value) => Number.isNaN(value))) return null;

  const left = Math.round(rawX);
  const top = Math.round(rawY);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(maxWidth, left + Math.round(rawWidth));
  const y1 = Math.min(maxHeight, top + Math.round(rawHeight));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 1 || height < 1) return null;
  return { x: x0, y: y0, width, height };
}

/** Largest PNG we will turn back into bytes for the proof drawer (~8 MB decoded). */
const MAX_SCENE_PNG_BYTES = 12_000_000;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * Decode the PNG data URL the renderer hands back from `snapshot()`.
 *
 * Only `image/png` is accepted, because that is the only thing `snapshot()`
 * produces; anything else arriving here means the payload did not come from the
 * path we think it did.
 */
export function decodeScenePngDataUrl(dataUrl: string | null | undefined): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return null;
  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!base64.length) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_SCENE_PNG_BYTES) return null;
  // PNG magic; a base64 blob that decodes to something else is not a snapshot.
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return bytes;
}
