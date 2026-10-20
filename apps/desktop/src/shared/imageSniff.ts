/**
 * Image type detection from bytes, shared by every route that hands an image
 * back as a data URL or stages one: the desktop IPC handlers, the runtime
 * action registry, the CLI/sync host, and the provider workers.
 *
 * Bytes, not the file extension, decide: extension-only inference would let a
 * caller hand over any allow-listed file (text, binary) and get it back as a
 * base64 `image/png` data URL.
 */

/**
 * ISO-BMFF `ftyp` brands of HEIF still images and sequences, as libheif reads
 * them. `mif1` / `msf1` are the generic HEIF brands; the rest are HEVC-coded.
 */
const HEIC_FTYP_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const HEIF_FTYP_BRANDS = new Set(["mif1", "msf1"]);

/** How far into the file an SVG's root element is looked for. */
const SVG_SNIFF_BYTES = 1024;

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Return the MIME type of a supported image from its leading bytes, or null
 * when the bytes match no supported format.
 */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
    && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 4
    && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00)
      || (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A))) {
    return "image/tiff";
  }
  if (bytes.length >= 12 && asciiAt(bytes, 4, 8) === "ftyp") {
    const brand = asciiAt(bytes, 8, 12);
    if (HEIC_FTYP_BRANDS.has(brand)) return "image/heic";
    if (HEIF_FTYP_BRANDS.has(brand)) return "image/heif";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return "image/bmp";
  }
  if (bytes.length >= 4
    && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }
  // SVG/XML: scan a small prefix as text so leading whitespace, a BOM, or an
  // <?xml ... ?> declaration before <svg ...> are tolerated.
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.min(bytes.length, SVG_SNIFF_BYTES)));
  const stripped = head.replace(/^﻿/, "").trimStart();
  if ((/^<\?xml\b/i.test(stripped) && /<svg\b/i.test(head)) || /^<svg\b/i.test(stripped)) {
    return "image/svg+xml";
  }
  return null;
}
