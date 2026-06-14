import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProjectIcon } from "./projectIconResolver";

const MOBILE_PROJECT_ICON_EDGE = 64;
const MOBILE_PROJECT_ICON_THUMBNAIL_CACHE_MAX = 64;
const SIPS_PATH = "/usr/bin/sips";

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
    timeout: 5_000,
  });
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
  let icon: ReturnType<typeof resolveProjectIcon>;
  try {
    icon = resolveProjectIcon(projectRoot);
  } catch {
    return null;
  }
  if (!icon.sourcePath) return null;

  const signature = fileSignature(icon.sourcePath);
  const cacheKey = thumbnailCacheKey(icon.sourcePath, options);
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

  const value =
    nativeImagePngDataUrl(icon.sourcePath, options.nativeImage)
    ?? sipsPngDataUrl(
      icon.sourcePath,
      options.rasterizeWithSips ?? defaultSipsRasterizer,
      options.tmpRoot ?? os.tmpdir(),
    )
    ?? (icon.mimeType === "image/png" ? icon.dataUrl : null);

  setThumbnailCache(cacheKey, { ...signature, value });
  return value;
}
