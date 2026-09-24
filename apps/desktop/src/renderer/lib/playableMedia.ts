/**
 * Chromium refuses a `<video>` whose declared type is `video/quicktime`
 * ("Unable to load URL due to content type"), even when the bytes are a
 * QuickTime file it can decode. A QuickTime movie uses the same box layout as
 * MP4, so the same bytes play when the type says `video/mp4`. `simctl io
 * recordVideo` and macOS screen recordings write `.mov`, so without this a
 * proof video plays on the phone (AVPlayer accepts QuickTime) and fails on
 * every desktop.
 *
 * Change the type only where a video plays. Stored metadata keeps the true type.
 */
const QUICKTIME_MIME = "video/quicktime";
const PLAYABLE_QUICKTIME_MIME = "video/mp4";

export function playableVideoMime(mime: string): string {
  return mime.trim().toLowerCase() === QUICKTIME_MIME ? PLAYABLE_QUICKTIME_MIME : mime;
}

/** The same data URL with a type Chromium plays. A host on an older build still sends `video/quicktime`. */
export function playableMediaDataUrl(url: string | null): string | null {
  if (!url) return url;
  const prefix = `data:${QUICKTIME_MIME}`;
  return url.slice(0, prefix.length).toLowerCase() === prefix
    ? `data:${PLAYABLE_QUICKTIME_MIME}${url.slice(prefix.length)}`
    : url;
}
