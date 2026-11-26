import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";

import { resolveProjectIcon, resolveProjectIconPath } from "./projectIconResolver";

const MOBILE_PROJECT_ICON_EDGE = 64;
const MOBILE_PROJECT_ICON_THUMBNAIL_CACHE_MAX = 64;
const SIPS_PATH = "/usr/bin/sips";
// The pure-JS PNG path decodes the whole image on the calling thread (a
// 1024 px app icon is ~75 ms, once per file change: the result is cached).
// Bound it so a huge image is skipped rather than freezing the brain.
const PNG_THUMBNAIL_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const PNG_THUMBNAIL_MAX_SOURCE_PIXELS = 2048 * 2048;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES = 128 * 1024;
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

type NativeImageInstanceLike = {
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality: "best" }): {
    toDataURL(): string;
  };
};

type NativeImageModuleLike = {
  createFromPath(filePath: string): NativeImageInstanceLike;
};

type SipsRasterizer = (sourcePath: string, outputPath: string, edge: number) => void;

type ThumbnailCacheEntry = {
  mtimeMs: number;
  size: number;
  value: string | null;
};

type ResolveMobileProjectIconDataUrlOptions = {
  nativeImage?: NativeImageModuleLike;
  rasterizeWithSips?: SipsRasterizer;
  tmpRoot?: string;
  resolvedSourcePath?: string;
};

const thumbnailCache = new Map<string, ThumbnailCacheEntry>();

function fileSignature(filePath: string): { mtimeMs: number; size: number } {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile()
      ? { mtimeMs: stat.mtimeMs, size: stat.size }
      : { mtimeMs: -1, size: -1 };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

function setThumbnailCache(key: string, entry: ThumbnailCacheEntry): void {
  if (thumbnailCache.has(key)) {
    thumbnailCache.delete(key);
  } else if (thumbnailCache.size >= MOBILE_PROJECT_ICON_THUMBNAIL_CACHE_MAX) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (oldestKey !== undefined) thumbnailCache.delete(oldestKey);
  }
  thumbnailCache.set(key, entry);
}

function thumbnailCacheKey(
  sourcePath: string,
  options: ResolveMobileProjectIconDataUrlOptions,
): string {
  const context = options.nativeImage ? "native" : "headless";
  return `${context}:${sourcePath}`;
}

function defaultSipsRasterizer(sourcePath: string, outputPath: string, edge: number): void {
  execFileSync(SIPS_PATH, [
    "-Z",
    String(edge),
    "-s",
    "format",
    "png",
    sourcePath,
    "--out",
    outputPath,
  ], {
    stdio: "ignore",
    timeout: 500,
  });
}

function boundedThumbnailDataUrl(value: string | null): string | null {
  if (!value || !IMAGE_DATA_URL_RE.test(value)) return null;
  return Buffer.byteLength(value, "utf8") <= PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES
    ? value
    : null;
}

function nativeImagePngDataUrl(
  sourcePath: string,
  nativeImage: NativeImageModuleLike | undefined,
): string | null {
  if (!nativeImage) return null;
  try {
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) return null;
    return image.resize({
      width: MOBILE_PROJECT_ICON_EDGE,
      height: MOBILE_PROJECT_ICON_EDGE,
      quality: "best",
    }).toDataURL();
  } catch {
    return null;
  }
}

function sipsPngDataUrl(
  sourcePath: string,
  rasterizeWithSips: SipsRasterizer,
  tmpRoot: string,
  edge = MOBILE_PROJECT_ICON_EDGE,
): string | null {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, "ade-project-icon-"));
    const outputPath = path.join(dir, "icon.png");
    rasterizeWithSips(sourcePath, outputPath, edge);
    const data = fs.readFileSync(outputPath);
    return data.length > 0
      ? `data:image/png;base64,${data.toString("base64")}`
      : null;
  } catch {
    return null;
  } finally {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * A PNG thumbnail without Electron or `sips`: the headless brain on Windows
 * and Linux. PNG sources only (what ADE detects for most repos); the box
 * average keeps edges smooth at the small sizes the phone shows.
 */
function pngjsThumbnailDataUrl(sourcePath: string, edge = MOBILE_PROJECT_ICON_EDGE): string | null {
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > PNG_THUMBNAIL_MAX_SOURCE_BYTES) return null;
    const buffer = fs.readFileSync(sourcePath);
    // The signature, then IHDR (always the first chunk): its size is read
    // before decoding, so an image over the limit costs nothing.
    if (buffer.length < 24 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    const headerPixels = buffer.readUInt32BE(16) * buffer.readUInt32BE(20);
    if (headerPixels <= 0 || headerPixels > PNG_THUMBNAIL_MAX_SOURCE_PIXELS) return null;
    const source = PNG.sync.read(buffer);
    const { width, height } = source;
    if (width <= 0 || height <= 0) return null;
    const scale = Math.min(1, edge / Math.max(width, height));
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    const out = new PNG({ width: outWidth, height: outHeight });
    for (let y = 0; y < outHeight; y += 1) {
      const y0 = Math.floor((y * height) / outHeight);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));
      for (let x = 0; x < outWidth; x += 1) {
        const x0 = Math.floor((x * width) / outWidth);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));
        // Alpha-weighted, so transparent pixels never darken the edges.
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let sy = y0; sy < y1; sy += 1) {
          let index = (sy * width + x0) * 4;
          for (let sx = x0; sx < x1; sx += 1) {
            const alpha = source.data[index + 3]!;
            r += source.data[index]! * alpha;
            g += source.data[index + 1]! * alpha;
            b += source.data[index + 2]! * alpha;
            a += alpha;
            count += 1;
            index += 4;
          }
        }
        const target = (y * outWidth + x) * 4;
        out.data[target] = a > 0 ? Math.round(r / a) : 0;
        out.data[target + 1] = a > 0 ? Math.round(g / a) : 0;
        out.data[target + 2] = a > 0 ? Math.round(b / a) : 0;
        out.data[target + 3] = Math.round(a / count);
      }
    }
    return `data:image/png;base64,${PNG.sync.write(out).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * A PNG of the image at most `edge` pixels on its long side, through macOS
 * `sips` (it keeps the aspect ratio). Null on any other platform or failure.
 */
export function rasterizeProjectIconPngWithSips(sourcePath: string, edge: number): string | null {
  if (process.platform !== "darwin") return null;
  return sipsPngDataUrl(sourcePath, defaultSipsRasterizer, os.tmpdir(), edge);
}

export function resolveMobileProjectIconDataUrl(
  projectRoot: string,
  options: ResolveMobileProjectIconDataUrlOptions = {},
): string | null {
  let sourcePath: string | null;
  try {
    sourcePath = options.resolvedSourcePath ?? resolveProjectIconPath(projectRoot);
  } catch {
    return null;
  }
  if (!sourcePath) return null;

  const signature = fileSignature(sourcePath);
  const cacheKey = thumbnailCacheKey(sourcePath, options);
  const cached = thumbnailCache.get(cacheKey);
  if (
    cached
    && cached.mtimeMs === signature.mtimeMs
    && cached.size === signature.size
  ) {
    thumbnailCache.delete(cacheKey);
    thumbnailCache.set(cacheKey, cached);
    return cached.value;
  }

  // `sips` exists only on macOS: elsewhere the default would spawn a missing
  // binary on every cache miss, so it is skipped unless one is supplied.
  const rasterizeWithSips = options.rasterizeWithSips
    ?? (process.platform === "darwin" ? defaultSipsRasterizer : null);
  const value = boundedThumbnailDataUrl(
    nativeImagePngDataUrl(sourcePath, options.nativeImage)
    ?? (rasterizeWithSips
      ? sipsPngDataUrl(sourcePath, rasterizeWithSips, options.tmpRoot ?? os.tmpdir())
      : null)
    // The headless brain on Windows and Linux has neither: shrink a PNG in JS.
    ?? pngjsThumbnailDataUrl(sourcePath)
    // Only read/base64-encode the original after both thumbnail paths fail.
    // The common native/sips paths therefore never retain a multi-megabyte
    // source image merely to return its tiny thumbnail.
    ?? (() => {
      const icon = resolveProjectIcon(projectRoot);
      return icon.mimeType === "image/png" ? icon.dataUrl : null;
    })(),
  );

  setThumbnailCache(cacheKey, { ...signature, value });
  return value;
}
