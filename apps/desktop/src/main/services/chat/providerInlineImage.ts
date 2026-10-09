import { PNG } from "pngjs";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import {
  MAX_PROVIDER_INLINE_IMAGE_BYTES,
  MAX_PROVIDER_INLINE_IMAGE_EDGE_PX,
  PROVIDER_INLINE_IMAGE_TARGET_EDGE_PX,
  formatAttachmentSize,
} from "../../../shared/chatAttachmentLimits";
import { imageDimensions, type ImageDimensions } from "../shared/imageDimensions";
import type { Logger } from "../logging/logger";

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
 * macOS, Windows and Linux, with no native module to ship or rebuild.
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

/**
 * Largest image ADE will decode to downscale: 25 MP is about 100 MB of RGBA. A
 * 6K display capture is ~20 MP, so those still fit; anything bigger is omitted.
 */
const MAX_DECODE_PIXELS = 25_000_000;
/** Smallest long edge worth sending; below this the hint is more useful. */
const MIN_FITTED_EDGE_PX = 512;
const JPEG_QUALITIES = [85, 70] as const;

type Rgba = { width: number; height: number; data: Uint8Array; hasAlpha: boolean };

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
  const fit = await fitImage(bytes, mediaType);
  if (fit.kind === "omit") {
    options?.logger?.warn("agent_chat.inline_image_omitted", {
      provider: options?.provider,
      bytes: bytes.byteLength,
      reason: fit.reason,
    });
  } else if (fit.resized) {
    options?.logger?.info("agent_chat.inline_image_resized", { provider: options?.provider, ...fit.resized });
  }
  return fit;
}

async function fitImage(bytes: Buffer, mediaType: string): Promise<ProviderInlineImageFit> {
  const dims = imageDimensions(bytes) ?? gifOrWebpDimensions(bytes);
  const longEdge = dims ? Math.max(dims.width, dims.height) : 0;
  if (bytes.byteLength <= MAX_PROVIDER_INLINE_IMAGE_BYTES && longEdge <= MAX_PROVIDER_INLINE_IMAGE_EDGE_PX) {
    return { kind: "inline", data: bytes, mediaType };
  }

  const describe = (): string => {
    const size = formatAttachmentSize(bytes.byteLength);
    return dims ? `${size}, ${dims.width}×${dims.height} px` : size;
  };
  // The bytes pick the codec, not the declared type: a PNG labelled image/jpeg
  // must not reach the JPEG decoder. The declared type is only a fallback.
  const actualMediaType = sniffImageMediaType(bytes) ?? mediaType;
  const isPng = actualMediaType === "image/png";
  const isJpeg = actualMediaType === "image/jpeg";
  if (!dims || (!isPng && !isJpeg)) {
    return {
      kind: "omit",
      reason: `${describe()}, over the ${formatAttachmentSize(MAX_PROVIDER_INLINE_IMAGE_BYTES)} / ${MAX_PROVIDER_INLINE_IMAGE_EDGE_PX} px inline limit and not a PNG or JPEG ADE can resize`,
    };
  }
  if (dims.width * dims.height > MAX_DECODE_PIXELS) {
    return { kind: "omit", reason: `${describe()}, too large to resize` };
  }
  // pngjs inflates an interlaced image whole, with no size cap, so it is not
  // decoded. IHDR's interlace method is the byte at offset 28.
  if (isPng && bytes[28] === 1) {
    return { kind: "omit", reason: `${describe()}, an interlaced PNG ADE does not resize` };
  }

  try {
    // Yield once before the synchronous decode so queued I/O gets a turn.
    await yieldToEventLoop();
    const decoded = isPng ? decodePng(bytes) : decodeJpegRgba(bytes);
    let edge = Math.min(PROVIDER_INLINE_IMAGE_TARGET_EDGE_PX, Math.max(decoded.width, decoded.height));
    // The starting edge is always tried, even below MIN_FITTED_EDGE_PX, so a
    // small PNG bloated by metadata is re-encoded instead of omitted. Only the
    // further shrinking stops at the floor.
    for (;;) {
      const scaled = await resizeToLongEdge(decoded, edge);
      for (const candidate of encodeCandidates(scaled, isPng)) {
        // Each encode is synchronous and can run for tens of milliseconds on a
        // large image, so the loop yields before each one.
        await yieldToEventLoop();
        const encoded = candidate();
        if (encoded.data.byteLength <= MAX_PROVIDER_INLINE_IMAGE_BYTES) {
          return {
            kind: "inline",
            data: encoded.data,
            mediaType: encoded.mediaType,
            resized: {
              from: { bytes: bytes.byteLength, width: dims.width, height: dims.height },
              to: { bytes: encoded.data.byteLength, width: scaled.width, height: scaled.height },
            },
          };
        }
      }
      edge = Math.floor(edge * 0.75);
      if (edge < MIN_FITTED_EDGE_PX) break;
    }
    return { kind: "omit", reason: `${describe()}, could not be resized under the ${formatAttachmentSize(MAX_PROVIDER_INLINE_IMAGE_BYTES)} inline limit` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "omit", reason: `${describe()}, could not be resized (${message})` };
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The codec the bytes actually are, from their magic number; null for anything else. */
function sniffImageMediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/**
 * Dimensions from a GIF or WebP header. The shared `imageDimensions` reads only
 * PNG and JPEG; these two are read here so their size limits still apply.
 */
function gifOrWebpDimensions(bytes: Buffer): ImageDimensions | null {
  return gifDimensions(bytes) ?? webpDimensions(bytes);
}

/** Logical screen size, little-endian at bytes 6 and 8. */
function gifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const signature = bytes.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** Canvas size from the first chunk: VP8 (lossy), VP8L (lossless) or VP8X. */
function webpDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 25) return null;
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (bytes.length < 30) return null;
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8X") {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function decodePng(bytes: Buffer): Rgba {
  const png = PNG.sync.read(bytes);
  // macOS screenshots carry an alpha channel that is opaque everywhere; writing
  // them back as RGB saves a quarter of the raw bytes.
  return { width: png.width, height: png.height, data: png.data, hasAlpha: png.alpha && hasTransparency(png.data) };
}

function hasTransparency(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}

function decodeJpegRgba(bytes: Buffer): Rgba {
  const decoded = decodeJpeg(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAX_DECODE_PIXELS / 1_000_000,
    maxMemoryUsageInMB: 1024,
  });
  const rgba: Rgba = { width: decoded.width, height: decoded.height, data: decoded.data, hasAlpha: false };
  // jpeg-js ignores EXIF, and the re-encoded JPEG carries none, so a phone
  // photo would arrive sideways unless the orientation is baked into pixels.
  return applyExifOrientation(rgba, jpegExifOrientation(bytes));
}

/**
 * PNG keeps screenshot text crisp, so a PNG source tries PNG first. JPEG is
 * the fallback for photos, where PNG at the same size stays too big.
 */
function encodeCandidates(
  image: Rgba,
  sourceIsPng: boolean,
): Array<() => { data: Buffer; mediaType: string }> {
  const candidates: Array<() => { data: Buffer; mediaType: string }> = [];
  if (sourceIsPng) {
    candidates.push(() => ({ data: encodePng(image), mediaType: "image/png" }));
  }
  for (const quality of JPEG_QUALITIES) {
    candidates.push(() => ({ data: encodeJpegRgba(image, quality), mediaType: "image/jpeg" }));
  }
  return candidates;
}

function encodePng(image: Rgba): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, {
    colorType: image.hasAlpha ? 6 : 2,
    inputColorType: 6,
    inputHasAlpha: true,
    deflateLevel: 6,
  });
}

function encodeJpegRgba(image: Rgba, quality: number): Buffer {
  // JPEG has no alpha: composite onto white, or transparent pixels turn black.
  const data = image.hasAlpha ? flattenOntoWhite(image.data) : image.data;
  return encodeJpeg({ width: image.width, height: image.height, data }, quality).data;
}

function flattenOntoWhite(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255;
    const bg = 255 * (1 - a);
    out[i] = Math.round(src[i]! * a + bg);
    out[i + 1] = Math.round(src[i + 1]! * a + bg);
    out[i + 2] = Math.round(src[i + 2]! * a + bg);
    out[i + 3] = 255;
  }
  return out;
}

type AxisWeights = { start: number; weights: Float64Array };

/** Area-average weights mapping `srcSize` samples onto `dstSize` samples. */
function axisWeights(srcSize: number, dstSize: number): AxisWeights[] {
  const scale = srcSize / dstSize;
  const out: AxisWeights[] = [];
  for (let i = 0; i < dstSize; i += 1) {
    const from = i * scale;
    const to = Math.min(srcSize, (i + 1) * scale);
    const start = Math.floor(from);
    const end = Math.min(srcSize, Math.ceil(to));
    const weights = new Float64Array(Math.max(1, end - start));
    for (let j = start; j < end; j += 1) {
      weights[j - start] = (Math.min(j + 1, to) - Math.max(j, from)) / scale;
    }
    out.push({ start, weights });
  }
  return out;
}

/**
 * Box-filter downscale with premultiplied alpha. Never upscales. Works one
 * output row at a time, so memory beyond the output stays at two float rows.
 * Yields every 64 rows so one large resize does not hold the event loop.
 */
async function resizeToLongEdge(image: Rgba, longEdge: number): Promise<Rgba> {
  const scale = longEdge / Math.max(image.width, image.height);
  if (scale >= 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const xw = axisWeights(image.width, width);
  const yw = axisWeights(image.height, height);
  const src = image.data;
  const out = new Uint8Array(width * height * 4);
  const row = new Float64Array(width * 4);
  const acc = new Float64Array(width * 4);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) await yieldToEventLoop();
    acc.fill(0);
    const { start: sy0, weights: wy } = yw[y]!;
    for (let k = 0; k < wy.length; k += 1) {
      const rowWeight = wy[k]!;
      if (rowWeight <= 0) continue;
      const rowOffset = (sy0 + k) * image.width * 4;
      for (let x = 0; x < width; x += 1) {
        const { start: sx0, weights: wx } = xw[x]!;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let m = 0; m < wx.length; m += 1) {
          const p = rowOffset + (sx0 + m) * 4;
          const w = wx[m]! * src[p + 3]!;
          r += src[p]! * w;
          g += src[p + 1]! * w;
          b += src[p + 2]! * w;
          a += w;
        }
        row[x * 4] = r;
        row[x * 4 + 1] = g;
        row[x * 4 + 2] = b;
        row[x * 4 + 3] = a;
      }
      for (let i = 0; i < row.length; i += 1) acc[i] += row[i]! * rowWeight;
    }
    const outOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const a = acc[x * 4 + 3]!;
      const o = outOffset + x * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(acc[x * 4]! / a));
        out[o + 1] = Math.min(255, Math.round(acc[x * 4 + 1]! / a));
        out[o + 2] = Math.min(255, Math.round(acc[x * 4 + 2]! / a));
      }
      out[o + 3] = Math.min(255, Math.round(a));
    }
  }
  return { width, height, data: out, hasAlpha: image.hasAlpha };
}

/** EXIF orientation (1–8) from a JPEG's APP1 segment; 1 when absent. */
function jpegExifOrientation(bytes: Buffer): number {
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) break;
    const segment = offset + 4;
    if (marker === 0xe1 && segment + 14 <= bytes.length && bytes.toString("latin1", segment, segment + 6) === "Exif\0\0") {
      const tiff = segment + 6;
      const little = bytes.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
      const u32 = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > bytes.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

/** Bakes an EXIF orientation into the pixels so the image displays upright. */
function applyExifOrientation(image: Rgba, orientation: number): Rgba {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data: src } = image;
  const swap = orientation >= 5;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; break; // 8
      }
      const s = (y * w + x) * 4;
      const d = (dy * outW + dx) * 4;
      out[d] = src[s]!;
      out[d + 1] = src[s + 1]!;
      out[d + 2] = src[s + 2]!;
      out[d + 3] = src[s + 3]!;
    }
  }
  return { width: outW, height: outH, data: out, hasAlpha: image.hasAlpha };
}
