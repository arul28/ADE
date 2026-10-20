/** Image formats ADE safely displays through a browser image element. */
export const INLINE_IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg",
]);
/** Audio filename extensions supported by the compact chat player. */
export const INLINE_AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "weba",
]);
/** Video filename extensions supported by the inline video viewer. */
export const INLINE_VIDEO_EXTENSIONS = new Set([
  "mp4", "mov", "webm", "m4v", "ogv", "avi",
]);
export const INLINE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const INLINE_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
export const INLINE_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export type InlineMediaKind = "image" | "audio" | "video" | "file";

/** Classify a local media path by its final extension. */
export function inlineMediaKind(path: string): InlineMediaKind {
  const extension = path.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
  if (INLINE_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (INLINE_VIDEO_EXTENSIONS.has(extension)) return "video";
  if (INLINE_AUDIO_EXTENSIONS.has(extension)) return "audio";
  return "file";
}

/** Audio attachments use MIME when a `.webm` extension is ambiguous. */
export function isInlineAudioAttachment(path: string, mimeType?: string): boolean {
  const extension = path.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
  return inlineMediaKind(path) === "audio"
    || (extension === "webm" && mimeType?.toLowerCase().startsWith("audio/") === true);
}

/** Return a browser MIME type for a local media path. */
export function inlineMediaMime(path: string, mimeType?: string): string {
  if (mimeType?.trim() && /^(?:audio|video|image)\//i.test(mimeType)) return mimeType;
  const extension = path.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase() ?? "";
  const mimes: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav",
    m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg",
    opus: "audio/ogg", weba: "audio/webm", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
    m4v: "video/mp4", ogv: "video/ogg", avi: "video/x-msvideo",
  };
  return mimes[extension] ?? "application/octet-stream";
}

/** Return the final path segment for a media label. */
export function inlineMediaFilename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
