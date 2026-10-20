// The one OOXML media extension → MIME map both the Word and PowerPoint
// readers use, so a format added for one is never silently missing from the
// other. Only formats an `<img>` can draw are listed: a TIFF picture is
// counted as not shown rather than handed to an element that cannot decode it.

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
};

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
  if (mimeType === "image/svg+xml" && options.browserRasterOnly) return null;
  return mimeType;
}
