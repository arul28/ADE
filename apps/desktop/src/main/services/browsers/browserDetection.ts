/**
 * Which browsers are installed on this machine, and where.
 *
 * Detection exists for two callers: the "Open in ▸" menu, which needs a real
 * app icon per row, and the launcher, which on Windows has to name an absolute
 * executable because the browser is usually not on `PATH`.
 *
 * Everything platform-shaped is injected so the whole matrix is testable for
 * all three operating systems from any one of them, the same way
 * `services/editors/editorDetection` does it.
 *
 * @module browsers/browserDetection
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  BROWSER_TARGETS,
  type BrowserTarget,
  type BrowserTargetDefinition,
  type BrowserTargetPlatform,
} from "../../../shared/browserTargets";

/** The machine's answer for one browser: installed, and where its app lives. */
export type DetectedBrowser = {
  id: BrowserTarget;
  label: string;
  /**
   * Absolute path to the app bundle (macOS) or executable (Windows/Linux), or
   * null when the browser is installed but its path could not be resolved —
   * `open -Ra` says yes while no candidate directory matched, e.g. a browser
   * launched from a disk image. It can still be opened by name.
   */
  appPath: string | null;
};

function runToCompletion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 1_500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true, env });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, timeoutMs);
    } catch {
      finish(false);
    }
  });
}

/**
 * macOS keeps some apps outside `/Applications` — Safari in particular ships in
 * the system volume's cryptex — so the search covers the standard homes before
 * falling back to Launch Services.
 */
function macApplicationDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim();
  return [
    "/Applications",
    "/System/Applications",
    "/System/Volumes/Preboot/Cryptexes/App/System/Applications",
    ...(home ? [path.join(home, "Applications")] : []),
  ];
}

/** `{{ProgramFiles}}/Google/Chrome/Application/chrome.exe` → a real path. */
export function expandWindowsBrowserExecutable(
  template: string,
  env: NodeJS.ProcessEnv,
): string {
  const substitutions: ReadonlyArray<[string, string]> = [
    ["{{ProgramFiles}}", env.ProgramFiles ?? "C:\\Program Files"],
    ["{{ProgramFilesX86}}", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"],
    ["{{LocalAppData}}", env.LOCALAPPDATA ?? ""],
  ];
  let resolved = template;
  for (const [token, value] of substitutions) {
    resolved = resolved.split(token).join(value);
  }
  // These are Windows paths by construction; do not let a POSIX host's
  // `path.sep` decide the separator.
  return resolved.split("/").join("\\");
}

export type BrowserDetectionDeps = {
  platform: BrowserTargetPlatform;
  env: NodeJS.ProcessEnv;
  fileExists: (candidate: string) => boolean;
  commandSucceeds: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<boolean>;
};

function defaultDeps(): BrowserDetectionDeps {
  return {
    platform: process.platform as BrowserTargetPlatform,
    env: process.env,
    fileExists: (candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    },
    commandSucceeds: (command, args, env) => runToCompletion(command, args, env),
  };
}

/**
 * How to launch each detected browser, recorded where detection found it:
 * macOS launches by bundle name (`open -a`), Windows by absolute executable,
 * Linux by the `PATH` name `which` just confirmed. A browser that was seen but
 * could not be resolved keeps no entry, and the launcher refuses it.
 */
let launchCommands = new Map<BrowserTarget, string>();

/** The command detection resolved for `target`, or null when none was found. */
export function resolveDetectedBrowserCommand(target: BrowserTarget): string | null {
  return launchCommands.get(target) ?? null;
}

async function detectOne(
  definition: BrowserTargetDefinition,
  deps: BrowserDetectionDeps,
  found: Map<BrowserTarget, string>,
): Promise<DetectedBrowser | null> {
  const { platform, env } = deps;
  if (!definition.platforms.includes(platform)) return null;

  if (platform === "darwin") {
    if (!definition.macAppName) return null;
    for (const directory of macApplicationDirectories(env)) {
      const candidate = path.join(directory, `${definition.macAppName}.app`);
      if (deps.fileExists(candidate)) {
        found.set(definition.id, candidate);
        return { id: definition.id, label: definition.label, appPath: candidate };
      }
    }
    // Somewhere we did not look (a browser run from /Volumes, a relocated
    // install). Launch Services still knows how to open it by name.
    const known = await deps.commandSucceeds("open", ["-Ra", definition.macAppName], env);
    if (!known) return null;
    found.set(definition.id, definition.macAppName);
    return { id: definition.id, label: definition.label, appPath: null };
  }

  if (platform === "win32") {
    for (const template of definition.winExecutables ?? []) {
      const candidate = expandWindowsBrowserExecutable(template, env);
      if (deps.fileExists(candidate)) {
        found.set(definition.id, candidate);
        return { id: definition.id, label: definition.label, appPath: candidate };
      }
    }
    return null;
  }

  for (const command of definition.linuxCommands ?? []) {
    if (await deps.commandSucceeds("which", [command], env)) {
      // `which` proved it is on PATH; the bare name is what we launch.
      found.set(definition.id, command);
      return { id: definition.id, label: definition.label, appPath: command };
    }
  }
  return null;
}

/**
 * Detect every installed browser, in catalog order. Concurrent, because each
 * probe can burn its own timeout and an "Open in" menu must not wait on them
 * one at a time.
 */
export async function detectBrowsers(
  overrides: Partial<BrowserDetectionDeps> = {},
): Promise<DetectedBrowser[]> {
  const deps = { ...defaultDeps(), ...overrides };
  // Resolve into a fresh map and swap it in whole, so a detection that starts
  // while a menu from the previous one is still open can never leave the
  // launcher reading a half-filled map.
  const found = new Map<BrowserTarget, string>();
  const results = await Promise.all(
    BROWSER_TARGETS.map((definition) => detectOne(definition, deps, found)),
  );
  launchCommands = found;
  return results.filter((entry): entry is DetectedBrowser => entry !== null);
}

/* ── Icons ────────────────────────────────────────────────────────────────── */

/** How long a detection answer is reused. Long enough to make reopening the
 * menu free, short enough that a browser installed while ADE runs shows up
 * without a restart. */
const DETECTION_TTL_MS = 30_000;

let cached: { at: number; value: Promise<DetectedBrowser[]> } | null = null;

/** The detected browsers, re-probing at most once per {@link DETECTION_TTL_MS}. */
export function detectBrowsersCached(): Promise<DetectedBrowser[]> {
  const now = Date.now();
  if (cached && now - cached.at < DETECTION_TTL_MS) return cached.value;
  const value = detectBrowsers().catch((error) => {
    // A failed probe must not be cached as the answer for the next 30 s.
    cached = null;
    throw error;
  });
  cached = { at: now, value };
  return value;
}

const iconCache = new Map<string, string | null>();

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
 */
export function extractIconPngFromIcns(buffer: Buffer): Buffer | null {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "icns") return null;
  const declaredLength = buffer.readUInt32BE(4);
  const end = Math.min(declaredLength || buffer.length, buffer.length);
  let offset = 8;
  let best: { size: number; png: Buffer } | null = null;
  while (offset + 8 <= end) {
    const length = buffer.readUInt32BE(offset + 4);
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

/**
 * The app icon for a detected browser, as a data URL, or null.
 *
 * macOS reads the bundle's own `.icns`, deliberately: `app.getFileIcon` returns
 * the same generic application glyph for every app on this OS, which drew a
 * blank white square where Chrome's mark should be. Null is the better answer
 * than a glyph that is not the browser's, because the row then falls back to a
 * per-browser icon we control.
 *
 * Windows has the opposite answer — the shell icon for the executable IS the
 * app's icon — so it keeps `getFileIcon`. Electron is imported lazily so this
 * module stays loadable, and testable, outside the desktop main process.
 */
export async function browserIconDataUrl(appPath: string | null): Promise<string | null> {
  if (!appPath) return null;
  if (iconCache.has(appPath)) return iconCache.get(appPath) ?? null;
  let url: string | null = null;
  if (process.platform === "darwin") {
    url = macAppIconDataUrl(appPath);
  } else if (process.platform === "win32") {
    try {
      const { app } = await import("electron");
      const image = await app.getFileIcon(appPath, { size: "small" });
      url = image.isEmpty() ? null : image.toDataURL();
    } catch {
      url = null;
    }
  }
  iconCache.set(appPath, url);
  return url;
}

export const _testing = {
  detectBrowsers,
  expandWindowsBrowserExecutable,
  macApplicationDirectories,
  extractIconPngFromIcns,
  resolveMacAppIconFile,
};
