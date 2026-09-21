/**
 * Snapshot plumbing for a frozen scene.
 *
 * Separate from `sceneDocumentStore` because it shares nothing with it: the
 * store serves live documents to the `ade-scene:` scheme, while these two
 * functions bound what a capture may contain and what may come back from one.
 * Both sit between the renderer and Electron and are deliberately free of it,
 * so the arithmetic is unit testable without a browser process.
 */

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
