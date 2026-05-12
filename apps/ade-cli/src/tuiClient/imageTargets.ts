import path from "node:path";

const IMAGE_FILE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i;

export function isImageFilePath(filePath: string): boolean {
  return IMAGE_FILE_EXTENSION_RE.test(filePath);
}

export function normalizeOpenableImageTarget(rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (!target || /^data:/i.test(target)) return null;
  if (isHttpUrl(target)) return target;
  if (!path.isAbsolute(target)) return null;
  if (!isImageFilePath(target)) return null;
  return target;
}

function isHttpUrl(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
