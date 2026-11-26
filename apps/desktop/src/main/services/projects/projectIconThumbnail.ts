import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";

import { resizeRgbaToLongEdgeSync } from "../chat/providerInlineImageCodec";
import { resolveProjectIcon, resolveProjectIconPath } from "./projectIconResolver";

const MOBILE_PROJECT_ICON_EDGE = 64;
const MOBILE_PROJECT_ICON_THUMBNAIL_CACHE_MAX = 64;
const SIPS_PATH = "/usr/bin/sips";
// The pure-JS PNG path decodes the whole image on the calling thread (a
// 1024 px app icon is ~75 ms, once per file change: the result is cached).
// Bound it so a larger image is skipped rather than holding the brain.
const PNG_THUMBNAIL_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const PNG_THUMBNAIL_MAX_SOURCE_PIXELS = 1024 * 1024;
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
    if (buffer.toString("latin1", 12, 16) !== "IHDR") return null;
    const headerPixels = buffer.readUInt32BE(16) * buffer.readUInt32BE(20);
    if (headerPixels <= 0 || headerPixels > PNG_THUMBNAIL_MAX_SOURCE_PIXELS) return null;
    // Interlaced: pngjs inflates those with no size limit, so a crafted icon
    // in a repository could exhaust memory. App icons are not interlaced.
    if (buffer.length < 29 || buffer[28] !== 0) return null;
    const source = PNG.sync.read(buffer);
    if (source.width <= 0 || source.height <= 0) return null;
    const resized = resizeRgbaToLongEdgeSync(
      { width: source.width, height: source.height, data: source.data, hasAlpha: true },
      edge,
    );
    const out = new PNG({ width: resized.width, height: resized.height });
    out.data = Buffer.from(resized.data.buffer, resized.data.byteOffset, resized.data.byteLength);
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
    // Only read/base64-encode the original after every thumbnail path fails.
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
