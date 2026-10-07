/**
 * Each detected browser's own app icon, so the "Open in ▸" menu shows the
 * browser a person recognises rather than a generic glyph.
 *
 * Kept apart from `browserDetection`: reading an app's icon is a different
 * problem from finding out which apps exist, and the macOS half of it is a
 * binary container parser with its own failure modes.
 *
 * @module browsers/browserIcons
 */
import fs from "node:fs";
import path from "node:path";

import { macApplicationDirectories } from "./browserDetection";
import {
  isBrowserTargetPlatform,
  type BrowserTargetPlatform,
} from "../../../shared/browserTargets";

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

/**
 * Pull the smallest PNG an `.icns` holds that is still at least 32 px — enough
 * for a 16 px menu row on a retina display without shipping a 512 px image per
 * browser into the renderer. Returns null for a container with no usable PNG
 * element (legacy `ic04`/`ic05` entries are raw bitmaps we do not decode).
 *
 * The input is a file on disk, so every read is bounds-checked and a malformed
 * container ends in null rather than a throw.
 */
export function extractIconPngFromIcns(buffer: Buffer): Buffer | null {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "icns") return null;
  const declaredLength = buffer.readUInt32BE(4);
  const end = Math.min(declaredLength || buffer.length, buffer.length);
  let offset = 8;
  let best: { size: number; png: Buffer } | null = null;
  while (offset + 8 <= end) {
    const length = buffer.readUInt32BE(offset + 4);
    // `length < 8` would not advance the cursor; a length past the buffer is
    // truncated. Either way the container is untrustworthy from here on.
    if (length < 8 || offset + length > buffer.length) break;
    const elementType = buffer.toString("ascii", offset, offset + 4);
    const size = ICNS_PNG_ELEMENT_SIZES[elementType];
    const payload = buffer.subarray(offset + 8, offset + length);
    if (size !== undefined && payload.length > 8 && payload.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (size >= 32 && (!best || size < best.size)) best = { size, png: payload };
    }
    offset += length;
  }
  return best?.png ?? null;
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

function macAppIconDataUrl(appPath: string): string | null {
  const iconFile = resolveMacAppIconFile(appPath);
  if (!iconFile) return null;
  try {
    const { size } = fs.statSync(iconFile);
    if (size === 0 || size > MAX_ICNS_BYTES) return null;
    const png = extractIconPngFromIcns(fs.readFileSync(iconFile));
    return png ? `data:image/png;base64,${png.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** The shell icon for an executable, which on Windows IS the app's icon. */
async function windowsExecutableIcon(appPath: string): Promise<string | null> {
  try {
    // Lazy so this module still loads outside the desktop main process.
    const { app } = await import("electron");
    const image = await app.getFileIcon(appPath, { size: "small" });
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

export type BrowserIconDeps = {
  platform: BrowserTargetPlatform;
  /** Overridden in tests; the real one reads the shell's icon for the file. */
  executableIcon: (appPath: string) => Promise<string | null>;
};

const iconCache = new Map<string, string | null>();

/**
 * The app icon for a detected browser, as a data URL, or null.
 *
 * macOS reads the bundle's own `.icns`, deliberately: `app.getFileIcon` returns
 * the same generic application glyph for every app on this OS, which drew a
 * blank white square where Chrome's mark should be. Null is the better answer
 * than a glyph that is not the browser's, because the row then falls back to a
 * per-browser icon we control.
 *
 * Windows has the opposite answer — the shell icon for the executable *is* the
 * app's icon. Linux has no per-app icon this process can read, so it returns
 * null and takes the fallback glyph.
 */
export async function browserIconDataUrl(
  appPath: string | null,
  overrides: Partial<BrowserIconDeps> = {},
): Promise<string | null> {
  if (!appPath) return null;
  const platform =
    overrides.platform
    ?? (isBrowserTargetPlatform(process.platform) ? process.platform : null);
  // Keyed by platform too: how an icon is read is platform-specific, so a
  // caller that names a platform (tests) must not poison the answer a later
  // real call for the same path would get.
  const cacheKey = `${platform ?? "unknown"}\u0000${appPath}`;
  if (iconCache.has(cacheKey)) return iconCache.get(cacheKey) ?? null;
  const executableIcon = overrides.executableIcon ?? windowsExecutableIcon;
  let url: string | null = null;
  if (platform === "darwin") {
    url = macAppIconDataUrl(appPath);
  } else if (platform === "win32") {
    url = await executableIcon(appPath);
  }
  iconCache.set(cacheKey, url);
  return url;
}

/**
 * An installed app's icon by the name the transcript knows it by ("Xcode",
 * "Notes", "Google Chrome"), as a data URL, or null.
 *
 * The name comes from agent output, so it is only ever joined onto the fixed
 * application folders as `<name>.app`: a name with a path separator, `..`, or
 * an unreasonable length is refused outright. macOS only — Windows has no
 * name-to-executable map this process can trust, and Linux has no per-app
 * icon — so other systems answer null and the row draws its glyph.
 */
export async function appIconDataUrlByName(
  rawName: string,
  deps: { platform?: string; applicationDirectories?: readonly string[]; fileExists?: (candidate: string) => boolean } = {},
): Promise<string | null> {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > 80 || /[\\/\u0000]/.test(name) || name.includes("..")) return null;
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const cacheKey = `by-name\u0000${name.toLowerCase()}`;
  if (iconCache.has(cacheKey)) return iconCache.get(cacheKey) ?? null;
  const directories = deps.applicationDirectories ?? appSearchDirectories();
  const exists = deps.fileExists ?? ((candidate: string) => fs.existsSync(candidate));
  let url: string | null = null;
  for (const directory of directories) {
    const candidate = path.join(directory, `${name}.app`);
    if (!exists(candidate)) continue;
    url = await browserIconDataUrl(candidate, { platform: "darwin" });
    if (url) break;
  }
  iconCache.set(cacheKey, url);
  return url;
}

function appSearchDirectories(): string[] {
  const base = macApplicationDirectories(process.env);
  return [...base, "/Applications/Utilities", "/System/Applications/Utilities"];
}

export const _testing = {
  extractIconPngFromIcns,
  resolveMacAppIconFile,
  browserIconDataUrl,
};
