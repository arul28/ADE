import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProjectIcon, resolveProjectIconPath } from "./projectIconResolver";

const MOBILE_PROJECT_ICON_EDGE = 64;
const MOBILE_PROJECT_ICON_THUMBNAIL_CACHE_MAX = 64;
const SIPS_PATH = "/usr/bin/sips";
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
): string | null {
  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, "ade-project-icon-"));
    const outputPath = path.join(dir, "icon.png");
    rasterizeWithSips(sourcePath, outputPath, MOBILE_PROJECT_ICON_EDGE);
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

  const value = boundedThumbnailDataUrl(
    nativeImagePngDataUrl(sourcePath, options.nativeImage)
    ?? sipsPngDataUrl(
      sourcePath,
      options.rasterizeWithSips ?? defaultSipsRasterizer,
      options.tmpRoot ?? os.tmpdir(),
    )
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
