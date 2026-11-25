import {
  MAX_PROVIDER_INLINE_IMAGE_BYTES,
  MAX_PROVIDER_INLINE_IMAGE_EDGE_PX,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";
import { sniffImageMimeType } from "../../../shared/imageSniff";
import { captureError } from "../../../shared/sentry/capture";
import { getImageAttachmentMediaType } from "../../../shared/types/chat";
import { gifDimensions, imageDimensions, webpDimensions, type ImageDimensions } from "../shared/imageDimensions";
import type { Logger } from "../logging/logger";
import {
  MAX_DECODE_PIXELS,
  encodeDisplayCopy,
  fitDecodableImage,
  type CodecDisplayResult,
  type CodecFitResult,
} from "./providerInlineImageCodec";
import { encodeDisplayCopyOffThread, fitDecodableImageOffThread } from "./providerInlineImageWorkerPool";

/**
 * Fits an image to what a model provider accepts inline, so an attachment can
 * never be the reason a turn dies.
 *
 * A Retina screenshot is 3024 px wide and often 5–7 MB as PNG. Claude Code
 * refuses anything over 5 MB of base64 and ends the turn with
 * `terminal_reason: "image_error"`, so the user's message looks like it
 * crashed the agent. Images inside the limits pass through untouched; larger
 * PNG and JPEG images are decoded, downscaled to the size the model looks at
 * anyway, and re-encoded. Anything that still does not fit becomes a path hint.
 *
 * The codecs are pure JavaScript (pngjs, jpeg-js) on purpose: this runs in the
 * Node brain, the Electron main process and the SDK worker processes, on
 * macOS, Windows and Linux, with no native module to ship or rebuild. The
 * header checks run here; the decode and re-encode run on a worker thread
 * (`providerInlineImageWorkerPool.ts`), or in-process when none can start.
 */

export type ProviderInlineImageFit =
  | {
    kind: "inline";
    data: Buffer;
    mediaType: string;
    /** Set when the bytes were re-encoded; absent for a pass-through. */
    resized?: {
      from: { bytes: number; width: number; height: number };
      to: { bytes: number; width: number; height: number };
    };
  }
  | { kind: "omit"; reason: string };

/** Image formats every provider path may safely send as image bytes. */
export const PROVIDER_IMAGE_BYTE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Canonical form of a declared image MIME type: lower case, parameters
 * dropped, and the common non-standard `image/jpg` spelled `image/jpeg` (the
 * only spelling providers accept). Null for anything that is not `image/*`.
 */
export function normalizeImageMediaType(mediaType: string | null | undefined): string | null {
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!normalized.startsWith("image/")) return null;
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

/**
 * The image type an attachment is sent as: the sender's MIME when it gave one,
 * else the one its path's extension names. Null when neither names an image.
 */
export function declaredImageMediaType(filePath: string, declared?: string | null): string | null {
  return normalizeImageMediaType(declared)
    ?? getImageAttachmentMediaType(filePath.split(/[?#]/u, 1)[0] ?? "");
}

/** Return whether a provider accepts this MIME type as image bytes. */
export function isProviderImageByteMediaType(mediaType: string): boolean {
  const normalized = normalizeImageMediaType(mediaType);
  return normalized !== null && PROVIDER_IMAGE_BYTE_MEDIA_TYPES.has(normalized);
}

export type FitImageOptions = {
  /** Names the provider in the log line, e.g. `claude` or `opencode`. */
  provider?: string;
  logger?: Pick<Logger, "info" | "warn">;
};

/**
 * Fits one image and logs what happened: a resize at info, an omission at warn.
 * Every inlining caller reports the same way, so none of them logs on its own.
 */
export async function fitImageForProviderInline(
  bytes: Buffer,
  mediaType: string,
  options?: FitImageOptions,
): Promise<ProviderInlineImageFit> {
  const { fit, offThread } = await fitImage(bytes, mediaType);
  if (fit.kind === "omit") {
    options?.logger?.warn("agent_chat.inline_image_omitted", {
      provider: options?.provider,
      bytes: bytes.byteLength,
      reason: fit.reason,
    });
  } else if (fit.resized) {
    options?.logger?.info("agent_chat.inline_image_resized", {
      provider: options?.provider,
      ...fit.resized,
      offThread,
    });
  }
  return fit;
}

/** A fit, and whether a worker thread ran the codec (for the log line). */
type FitOutcome = { fit: ProviderInlineImageFit; offThread: boolean };

const inProcess = (fit: ProviderInlineImageFit): FitOutcome => ({ fit, offThread: false });

async function fitImage(bytes: Buffer, declaredMediaType: string): Promise<FitOutcome> {
  const mediaType = normalizeImageMediaType(declaredMediaType);
  if (!mediaType || !PROVIDER_IMAGE_BYTE_MEDIA_TYPES.has(mediaType)) {
    return inProcess({ kind: "omit", reason: `unsupported image MIME type ${declaredMediaType}` });
  }
  const dims = imageDimensions(bytes) ?? gifOrWebpDimensions(bytes);
  const longEdge = dims ? Math.max(dims.width, dims.height) : 0;
  if (bytes.byteLength <= MAX_PROVIDER_INLINE_IMAGE_BYTES && longEdge <= MAX_PROVIDER_INLINE_IMAGE_EDGE_PX) {
    return inProcess({ kind: "inline", data: bytes, mediaType });
  }

  const describe = (): string => {
    const size = formatAttachmentSize(bytes.byteLength);
    return dims ? `${size}, ${dims.width}×${dims.height} px` : size;
  };
  // The bytes pick the codec, not the declared type: a PNG labelled image/jpeg
  // must not reach the JPEG decoder. The declared type is only a fallback.
  const actualMediaType = sniffImageMimeType(bytes) ?? mediaType;
  const isPng = actualMediaType === "image/png";
  const isJpeg = actualMediaType === "image/jpeg";
  if (!dims || (!isPng && !isJpeg)) {
    return inProcess({
      kind: "omit",
      reason: `${describe()}, over the ${formatAttachmentSize(MAX_PROVIDER_INLINE_IMAGE_BYTES)} / ${MAX_PROVIDER_INLINE_IMAGE_EDGE_PX} px inline limit and not a PNG or JPEG ADE can resize`,
    });
  }
  if (dims.width * dims.height > MAX_DECODE_PIXELS) {
    return inProcess({ kind: "omit", reason: `${describe()}, too large to resize` });
  }
  // pngjs inflates an interlaced image whole, with no size cap, so it is not
  // decoded. IHDR's interlace method is the byte at offset 28.
  if (isPng && bytes[28] === 1) {
    return inProcess({ kind: "omit", reason: `${describe()}, an interlaced PNG ADE does not resize` });
  }

  try {
    const { fitted, offThread } = await fitDecodable(bytes, isPng);
    if (fitted.kind === "too-big") {
      return { fit: { kind: "omit", reason: `${describe()}, could not be resized under the ${formatAttachmentSize(MAX_PROVIDER_INLINE_IMAGE_BYTES)} inline limit` }, offThread };
    }
    return {
      fit: {
        kind: "inline",
        data: fitted.data,
        mediaType: fitted.mediaType,
        resized: {
          from: { bytes: bytes.byteLength, width: dims.width, height: dims.height },
          to: { bytes: fitted.data.byteLength, width: fitted.width, height: fitted.height },
        },
      },
      offThread,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return inProcess({ kind: "omit", reason: `${describe()}, could not be resized (${message})` });
  }
}

/** The decode and re-encode, on a worker when one runs; a codec failure throws either way. */
async function fitDecodable(bytes: Buffer, isPng: boolean): Promise<{ fitted: CodecFitResult; offThread: boolean }> {
  const worker = await fitDecodableImageOffThread(bytes, isPng);
  if (!worker) return { fitted: await fitDecodableImage(bytes, isPng, yieldToEventLoop), offThread: false };
  if (!worker.ok) throw worker.error;
  return { fitted: worker.result, offThread: true };
}

/**
 * A smaller copy of a PNG or JPEG for showing on another computer: at most
 * `maxEdgePx` on its long edge, JPEG at `quality`. Null when no smaller copy
 * helps or is safe: not a PNG or JPEG ADE decodes, too many pixels, an
 * interlaced PNG, a picture with transparency (JPEG has none), or a copy that
 * saves less than a fifth of the bytes. The caller then shows the original.
 */
export async function encodeDisplayImage(
  bytes: Buffer,
  maxEdgePx: number,
  quality: number,
): Promise<{ data: Buffer; mediaType: "image/jpeg"; width: number; height: number } | null> {
  const mediaType = sniffImageMimeType(bytes);
  const isPng = mediaType === "image/png";
  if (!isPng && mediaType !== "image/jpeg") return null;
  const dims = imageDimensions(bytes);
  if (!dims || dims.width * dims.height > MAX_DECODE_PIXELS) return null;
  // Already within the edge: the original is shown as it is, never re-encoded.
  if (Math.max(dims.width, dims.height) <= maxEdgePx) return null;
  if (isPng && bytes[28] === 1) return null;
  try {
    const copy = await displayCopy(bytes, isPng, maxEdgePx, quality);
    if (!copy) return null;
    return { data: copy.data, mediaType: "image/jpeg", width: copy.width, height: copy.height };
  } catch (error) {
    // The copy is only a faster way to show the picture; the original is
    // served instead. Reported, so a codec that fails on real pictures is
    // visible rather than just quietly slow.
    captureError(error, { fingerprint: ["artifact-display-copy", "encode"] });
    return null;
  }
}

async function displayCopy(bytes: Buffer, isPng: boolean, maxEdgePx: number, quality: number): Promise<CodecDisplayResult> {
  const offThread = await encodeDisplayCopyOffThread(bytes, isPng, maxEdgePx, quality);
  if (!offThread) return encodeDisplayCopy(bytes, isPng, maxEdgePx, quality, yieldToEventLoop);
  if (!offThread.ok) throw offThread.error;
  return offThread.result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Dimensions from a GIF or WebP header. The shared `imageDimensions` reads only
 * PNG and JPEG; these two are read here so their size limits still apply.
 */
function gifOrWebpDimensions(bytes: Buffer): ImageDimensions | null {
  return gifDimensions(bytes) ?? webpDimensions(bytes);
}
