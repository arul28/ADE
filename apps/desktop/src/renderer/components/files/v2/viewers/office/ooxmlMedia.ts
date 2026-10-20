// The one OOXML media extension → MIME map both the Word and PowerPoint
// readers use, so a format added for one is never silently missing from the
// other.

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Formats an `<img>` decodes natively as a bitmap: no SVG, no TIFF. */
const BROWSER_RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "image/webp",
]);

/**
 * The MIME type for a package media part, from its extension, or null when
 * the format is not previewed. `browserRasterOnly` narrows it to the raster
 * formats an `<img>` decodes itself (the Word preview never renders
 * file-derived SVG).
 */
export function ooxmlMediaMimeType(
  path: string,
  options: { browserRasterOnly?: boolean } = {},
): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const mimeType = MEDIA_MIME_BY_EXTENSION[ext] ?? null;
  if (mimeType && options.browserRasterOnly && !BROWSER_RASTER_MIME_TYPES.has(mimeType)) return null;
  return mimeType;
}
