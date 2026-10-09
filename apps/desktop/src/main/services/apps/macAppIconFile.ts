/**
 * Reads a macOS app bundle's own icon out of its `.icns` file.
 *
 * A leaf module on purpose: Home widgets, the browser menu and the app-name
 * icons all need it, and none of them should pull each other in to get it.
 *
 * @module apps/macAppIconFile
 */
import fs from "node:fs";
import path from "node:path";

/** PNG signature; an `.icns` element is either a PNG or a legacy raw bitmap. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Pixel size of each `.icns` element type that carries PNG data. */
const ICNS_PNG_ELEMENT_SIZES: Readonly<Record<string, number>> = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 128,
  ic14: 256,
};

/** An `.icns` big enough to be a real icon, small enough not to be a payload. */
const MAX_ICNS_BYTES = 8 * 1024 * 1024;

/** The smallest icon, in pixels, worth drawing: a 16 px row on a retina display. */
const ICON_MIN_PX = 32;

/**
 * Pull the smallest PNG an `.icns` holds that is at least `minPx` (32 by
 * default), so a 16 px menu row on a retina display does not ship a 512 px
 * image per app into the renderer. When none is that large, the largest one of
 * at least 32 px. Null when none. Legacy `ic04`/`ic05` entries are raw bitmaps
 * we do not decode, so they never count.
 *
 * The input is a file on disk, so every read is bounds-checked and a malformed
 * container ends in null rather than a throw.
 */
export function extractIconPngFromIcns(buffer: Buffer, minPx = ICON_MIN_PX): Buffer | null {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "icns") return null;
  const declaredLength = buffer.readUInt32BE(4);
  const end = Math.min(declaredLength || buffer.length, buffer.length);
  let offset = 8;
  let best: { size: number; png: Buffer } | null = null;
  let largest: { size: number; png: Buffer } | null = null;
  while (offset + 8 <= end) {
    const length = buffer.readUInt32BE(offset + 4);
    // `length < 8` would not advance the cursor; a length past the buffer is
    // truncated. Either way the container is untrustworthy from here on.
    if (length < 8 || offset + length > buffer.length) break;
    const elementType = buffer.toString("ascii", offset, offset + 4);
    const size = ICNS_PNG_ELEMENT_SIZES[elementType];
    const payload = buffer.subarray(offset + 8, offset + length);
    if (size !== undefined && payload.length > 8 && payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (size >= minPx && (!best || size < best.size)) best = { size, png: payload };
      if (size >= ICON_MIN_PX && (!largest || size > largest.size)) largest = { size, png: payload };
    }
    offset += length;
  }
  return (best ?? largest)?.png ?? null;
}

/**
 * The bundle's own icon file.
 *
 * macOS puts an app's icon in `Contents/Resources`, named by `CFBundleIconFile`
 * — so the name is not fixed (`Google Chrome.app` ships `app.icns`, `Safari.app`
 * ships `AppIconUpdated.icns`). Rather than parse a binary plist, prefer the
 * names apps actually use and fall back to the largest `.icns` present.
 */
export function resolveMacAppIconFile(appPath: string): string | null {
  const resources = path.join(appPath, "Contents", "Resources");
  let entries: string[];
  try {
    entries = fs.readdirSync(resources);
  } catch {
    return null;
  }
  const candidates = entries.filter((entry) => entry.toLowerCase().endsWith(".icns"));
  if (candidates.length === 0) return null;
  const appName = path.basename(appPath).replace(/\.app$/i, "");
  const preferred = [
    "app.icns",
    `${appName}.icns`,
    ...candidates.filter((entry) => /^appicon/i.test(entry)).sort(),
  ];
  for (const name of preferred) {
    const match = candidates.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (match) return path.join(resources, match);
  }
  // Several unrelated .icns (document types, legacy variants): the biggest one
  // is the application icon.
  let largest: { path: string; size: number } | null = null;
  for (const entry of candidates) {
    const full = path.join(resources, entry);
    try {
      const { size } = fs.statSync(full);
      if (!largest || size > largest.size) largest = { path: full, size };
    } catch {
      // Unreadable entry: ignore it.
    }
  }
  return largest?.path ?? null;
}

/**
 * A macOS app bundle's own icon as a PNG data URL, or null.
 *
 * Reads the bundle's `.icns` rather than Electron's `app.getFileIcon`. On macOS
 * that call returns a generic glyph for many apps, and at `size: "large"` it
 * hit a CHECK on a Chromium thread-pool worker (Electron 41.5 on macOS 27) that
 * took the whole app down. This is the one place that rationale is written;
 * callers point here instead of repeating it.
 */
export function macAppIconDataUrl(appPath: string, minPx = ICON_MIN_PX): string | null {
  const iconFile = resolveMacAppIconFile(appPath);
  if (!iconFile) return null;
  try {
    const { size } = fs.statSync(iconFile);
    if (size === 0 || size > MAX_ICNS_BYTES) return null;
    const png = extractIconPngFromIcns(fs.readFileSync(iconFile), minPx);
    return png ? `data:image/png;base64,${png.toString("base64")}` : null;
  } catch {
    return null;
  }
}
