import { AUDIO_EXTS, extensionOf, IMAGE_EXTS, VIDEO_EXTS } from "../files/v2/viewerRegistry";

export const INLINE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const INLINE_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
export const INLINE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export type InlineMediaKind = "image" | "audio" | "video" | "file";

/** Final extension of a path, ignoring a `?query` or `#fragment`. */
function mediaExtension(path: string): string {
  return extensionOf(path.split(/[?#]/, 1)[0] ?? path);
}

/**
 * Classify a local media path by its final extension, using the Files viewer's
 * sets so chat and Files agree. SVG renders through an `<img>`, which never runs
 * its scripts, so chat shows it inline as Files does.
 */
export function inlineMediaKind(path: string): InlineMediaKind {
  const extension = mediaExtension(path);
  if (IMAGE_EXTS.has(extension) || extension === "svg") return "image";
  if (VIDEO_EXTS.has(extension)) return "video";
  if (AUDIO_EXTS.has(extension)) return "audio";
  return "file";
}

/** Audio attachments use MIME when a `.webm` extension is ambiguous. */
export function isInlineAudioAttachment(path: string, mimeType?: string): boolean {
  return inlineMediaKind(path) === "audio"
    || (mediaExtension(path) === "webm" && mimeType?.toLowerCase().startsWith("audio/") === true);
}

const INLINE_MEDIA_MIMES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", weba: "audio/webm",
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  avi: "video/x-msvideo", mkv: "video/x-matroska",
};

/** Return a browser MIME type for a local media path. */
export function inlineMediaMime(path: string, mimeType?: string): string {
  if (mimeType?.trim() && /^(?:audio|video|image)\//i.test(mimeType)) return mimeType;
  return INLINE_MEDIA_MIMES[mediaExtension(path)] ?? "application/octet-stream";
}

/** Return the final path segment for a media label. */
export function inlineMediaFilename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
