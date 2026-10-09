/**
 * Each detected browser's own app icon, so the "Open in ▸" menu shows the
 * browser a person recognises rather than a generic glyph.
 *
 * Kept apart from `browserDetection`: reading an app's icon is a different
 * problem from finding out which apps exist. The macOS half reads the bundle's
 * `.icns` through `apps/macAppIconFile`.
 *
 * @module browsers/browserIcons
 */
import {
  isBrowserTargetPlatform,
  type BrowserTargetPlatform,
} from "../../../shared/browserTargets";
import { macAppIconDataUrl } from "../apps/macAppIconFile";

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
 * macOS reads the bundle's own `.icns` (see `macAppIconDataUrl` for why not
 * `app.getFileIcon`). Null is the better answer than a glyph that is not the
 * browser's, because the row then falls back to a per-browser icon we control.
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
