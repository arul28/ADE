/**
 * Where ADE's native helper binaries live.
 *
 * The native helpers are produced by the build into the same
 * `resources/native` directory and copied by the same `extraResources` entry,
 * so where they are is one question with one answer, and it is answered here
 * rather than inside each helper's client.
 *
 * Kept out of the helper clients because the Mac Desktop service runs in the
 * ADE runtime daemon as well as in Electron main, and importing a spawner with
 * its own process state to ask where a file is was a dependency neither side
 * wanted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAssociatedAppBundleId } from "../../../../../ade-cli/src/serviceManager/common";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";

/** The name of the Mac Desktop helper in `resources/native`. */
const MAC_DESKTOP_DRIVER_BINARY = "ade-desktop-driver";

/** The Windows Desktop helper, beside the capture helper. */
const WINDOWS_DESKTOP_DRIVER_BINARY = "ade-desktop-driver.exe";

/** True only for a regular file this process is allowed to execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True for anything on disk: the test the Electron resource layouts use. */
function existsOnDisk(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

type DesktopDriverResolution = {
  /** This process's platform; the helper exists only on `supportedPlatform`. */
  platform?: NodeJS.Platform;
  supportedPlatform: NodeJS.Platform;
  /** The helper's file name inside a `native` directory. */
  binaryName: string;
  /** The environment variable a developer override comes from. */
  overrideEnv: string;
  /** The debug event logged when that override names nothing usable. */
  overrideIgnoredEvent: string;
  /**
   * A path an Electron layout puts the helper at, answered as the installation
   * without a search: the packaged build's own file, or the dev app's.
   */
  fixedPath?: string | null;
  /** Host-specific candidates tried before the shared upward search. */
  extraCandidates?: readonly string[];
  /**
   * Candidates tried after the upward search: the standalone brain's runtime
   * archive and the installed ADE app (see `standaloneNativeHelperCandidates`).
   */
  fallbackCandidates?: readonly string[];
  /** Ask Spotlight for the installed app when no candidate is usable (macOS). */
  spotlight?: boolean;
  /** Names searched upward from this module, in order (the daemon case). */
  searchNames?: readonly string[];
  /** What counts as a usable helper in the search. */
  accept: (candidate: string) => boolean;
  /**
   * The override's own test where it is stricter than the search: a developer
   * override that cannot run is ignored, while a packaged file is still named
   * even when the tree is not built. Defaults to `accept`.
   */
  acceptOverride?: (candidate: string) => boolean;
  env?: NodeJS.ProcessEnv;
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
};

/**
 * The one resolver behind the desktop-helper exports.
 *
 * It owns the order every helper uses — platform gate, developer override, the
 * Electron layout, then the upward search from this module — and each caller
 * supplies only its own facts: the platform it runs on, the binary name, its
 * candidates, and the predicate that decides what counts as usable. The
 * predicate stays per caller so moving a resolver here never quietly makes one
 * host's search stricter than it was.
 */
function resolveDesktopDriverBinary(input: DesktopDriverResolution): string | null {
  if ((input.platform ?? process.platform) !== input.supportedPlatform) return null;
  const env = input.env ?? process.env;
  const override = env[input.overrideEnv]?.trim();
  if (override) {
    if ((input.acceptOverride ?? input.accept)(override)) return override;
    input.logger?.debug(input.overrideIgnoredEvent, { path: override });
  }
  if (input.fixedPath) return input.fixedPath;
  const candidates = dedupePaths([
    ...(input.extraCandidates ?? []),
    ...(input.searchNames ?? [input.binaryName]).flatMap((name) => daemonNativeCandidates(name)),
    ...(input.fallbackCandidates ?? []),
  ]);
  const searched = input.spotlight
    ? withSpotlightFallback(input.binaryName, candidates, input.accept, env, input.platform ?? process.platform)
    : candidates;
  return pickNativeHelper(input.binaryName, searched, input.accept) ?? searched[0] ?? null;
}

/**
 * The first candidate `accept` takes, remembering every path it looked at so a
 * "missing" message can name them (`describeNativeHelperSearch`).
 */
function pickNativeHelper(
  binaryName: string,
  candidates: readonly string[],
  accept: (candidate: string) => boolean,
): string | null {
  const found = candidates.find((candidate) => accept(candidate)) ?? null;
  lastSearchByBinary.set(binaryName, { candidates: [...candidates], found });
  return found;
}

function dedupePaths(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

/** The most recent search per helper name, for the "missing" messages. */
const lastSearchByBinary = new Map<string, { candidates: string[]; found: string | null }>();

/**
 * One sentence naming every place the last search for this helper looked,
 * or null when it found the helper or never ran. `binaryPathOrName` is the
 * path a resolver returned (its basename is the helper's name) or the name.
 */
export function describeNativeHelperSearch(binaryPathOrName: string | null | undefined): string | null {
  const name = binaryPathOrName ? path.basename(binaryPathOrName) : "";
  const search = name ? lastSearchByBinary.get(name) : undefined;
  if (!search || search.found || search.candidates.length === 0) return null;
  return formatNativeHelperSearch(name, search.candidates);
}

/**
 * "ADE looked for <name> in: <dir>, <dir>, …." over the folders of
 * `candidates`, in search order. Swift build folders of a source checkout
 * are counted rather than listed: there are a dozen per root and none of
 * them is where an installed ADE keeps its helpers.
 */
export function formatNativeHelperSearch(name: string, candidates: readonly string[]): string {
  const isDevBuild = (candidate: string) => /[\\/]\.build[\\/]/.test(candidate);
  const dirs = dedupePaths(candidates.filter((candidate) => !isDevBuild(candidate)).map((candidate) => path.dirname(candidate)));
  const devBuilds = candidates.filter(isDevBuild).length;
  const tail = devBuilds > 0 ? ` (and ${devBuilds} Swift build paths of a source checkout)` : "";
  return `ADE looked for ${name} in: ${dirs.join(", ")}${tail}.`;
}

/** The record a packaged ADE app leaves so a standalone brain can find it. */
export const DESKTOP_APP_RECORD_FILE = "desktop-app.json";

type DesktopAppRecord = {
  platform: NodeJS.Platform;
  /** `.../ADE.app` on macOS; the install directory on Windows. */
  appPath: string;
  /** The app's resources directory (`Contents/Resources`, `resources`). */
  resourcesPath: string;
  version: string | null;
};

function desktopAppRecordPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveMachineAdeDir(env), "runtime", DESKTOP_APP_RECORD_FILE);
}

let desktopAppRecordWritten = false;

/** This app's version, read from Electron when running inside it; null in the brain and the CLI. */
function runningElectronAppVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { app?: { getVersion?: () => string } };
    const version = electron.app?.getVersion?.();
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Record where this packaged app lives, once per process, in the channel's
 * ADE home (`runtime/desktop-app.json`). A standalone brain (`~/.ade/bin/ade
 * serve`, installed by `ade brain update`) has no app resources of its own,
 * so this is how it finds the app's signed helpers wherever the app was
 * installed. Rewritten only when it changed; never throws.
 */
export function recordInstalledDesktopApp(input: {
  isPackaged: boolean;
  resourcesPath: string | null | undefined;
  version?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): void {
  // Never from a test run: it would write the developer's real ADE home.
  if (desktopAppRecordWritten || !input.isPackaged || !input.resourcesPath || process.env.VITEST) return;
  desktopAppRecordWritten = true;
  const platform = input.platform ?? process.platform;
  const resourcesPath = path.resolve(input.resourcesPath);
  // macOS: <App>.app/Contents/Resources. Windows: <install dir>/resources.
  const appPath = platform === "darwin" ? path.dirname(path.dirname(resourcesPath)) : path.dirname(resourcesPath);
  const version = input.version === undefined ? runningElectronAppVersion() : input.version;
  const record: DesktopAppRecord = { platform, appPath, resourcesPath, version: version?.trim() || null };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const target = desktopAppRecordPath(input.env ?? process.env);
    try {
      if (fs.readFileSync(target, "utf8") === body) return;
    } catch {
      // Not written yet.
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, "utf8");
    fs.renameSync(temporary, target);
  } catch {
    // Best effort: the brain still searches the usual install locations.
  }
}

function readDesktopAppRecord(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DesktopAppRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopAppRecordPath(env), "utf8")) as Partial<DesktopAppRecord>;
    if (parsed.platform !== platform || typeof parsed.resourcesPath !== "string" || !parsed.resourcesPath) return null;
    return {
      platform,
      appPath: typeof parsed.appPath === "string" ? parsed.appPath : path.dirname(parsed.resourcesPath),
      resourcesPath: parsed.resourcesPath,
      version: typeof parsed.version === "string" ? parsed.version : null,
    };
  } catch {
    return null;
  }
}

/** The app names this channel installs as: `ADE`, `ADE Beta`, `ADE Alpha`. */
export function installedDesktopAppNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  const explicit = env.ADE_DESKTOP_APP_NAME?.trim();
  if (explicit && !/[\\/]/.test(explicit)) names.push(explicit.replace(/\.(?:app|exe)$/i, ""));
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  names.push(channel === "alpha" ? "ADE Alpha" : channel === "beta" ? "ADE Beta" : "ADE");
  return dedupePaths(names);
}

type BundleInfo = { id: string | null; version: string | null };

/** Bundle facts already read, by Info.plist path and mtime: status polls resolve helpers often. */
const bundleInfoCache = new Map<string, { mtimeMs: number; info: BundleInfo }>();

function plistString(raw: string, key: string): string | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`, "i").exec(raw);
  return match?.[1]?.trim() || null;
}

/** The bundle id and short version of an app bundle, when its Info.plist is XML. Null when it has none. */
function readBundleInfo(appPath: string): BundleInfo | null {
  const plist = path.join(appPath, "Contents", "Info.plist");
  try {
    const { mtimeMs } = fs.statSync(plist);
    const cached = bundleInfoCache.get(plist);
    if (cached && cached.mtimeMs === mtimeMs) return cached.info;
    const raw = fs.readFileSync(plist, "utf8");
    const info = { id: plistString(raw, "CFBundleIdentifier"), version: plistString(raw, "CFBundleShortVersionString") };
    bundleInfoCache.set(plist, { mtimeMs, info });
    return info;
  } catch {
    return null;
  }
}

/** The CFBundleIdentifier of an app bundle, when its Info.plist is XML. */
function readBundleIdentifier(appPath: string): string | null {
  return readBundleInfo(appPath)?.id ?? null;
}

/**
 * Spotlight's answer for the channel's bundle id. A found app is kept for the
 * process; "not found" expires after a few minutes, so an ADE.app installed
 * after the brain started is found without restarting it.
 */
const spotlightAppByBundleId = new Map<string, { path: string | null; at: number }>();
const SPOTLIGHT_MISS_TTL_MS = 5 * 60_000;

function spotlightAppPath(bundleId: string): string | null {
  const cached = spotlightAppByBundleId.get(bundleId);
  if (cached && (cached.path !== null || Date.now() - cached.at < SPOTLIGHT_MISS_TTL_MS)) return cached.path;
  let found: string | null = null;
  try {
    const result = spawnSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    found = String(result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith(".app") && readBundleIdentifier(line) === bundleId) ?? null;
  } catch {
    found = null;
  }
  spotlightAppByBundleId.set(bundleId, { path: found, at: Date.now() });
  return found;
}

/**
 * The channel's app bundles on this Mac, best first: the one the desktop
 * recorded, then /Applications and ~/Applications. A bundle whose XML
 * Info.plist names another channel's bundle id is skipped.
 */
function macDesktopAppPaths(env: NodeJS.ProcessEnv, homeDir: string, record: DesktopAppRecord | null): string[] {
  const bundleId = resolveAssociatedAppBundleId(env);
  return dedupePaths([
    ...(record ? [record.appPath] : []),
    ...installedDesktopAppNames(env).flatMap((name) => [
      path.join("/Applications", `${name}.app`),
      path.join(homeDir, "Applications", `${name}.app`),
    ]),
  ]).filter((appPath) => {
    const id = readBundleIdentifier(appPath);
    return id === null || id === bundleId;
  });
}

/**
 * The `native` directories of the ADE app installed on this machine, best
 * first. On macOS: the app the desktop recorded (`recordInstalledDesktopApp`),
 * then the channel's app in /Applications and ~/Applications. A bundle whose
 * XML Info.plist names a different bundle id than this channel's
 * (`resolveAssociatedAppBundleId`, the id the service plist associates) is
 * skipped. On Windows: the recorded install, then `%LOCALAPPDATA%\Programs`
 * and `%ProgramFiles%`. Linux has no desktop app.
 */
export function installedDesktopAppNativeDirs(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): string[] {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  const record = readDesktopAppRecord(env, platform);
  if (platform === "darwin") {
    return macDesktopAppPaths(env, homeDir, record)
      .map((appPath) => path.join(appPath, "Contents", "Resources", "native"));
  }
  if (platform === "win32") {
    const win = path.win32;
    const roots: string[] = record ? [record.resourcesPath] : [];
    for (const name of installedDesktopAppNames(env)) {
      if (env.LOCALAPPDATA?.trim()) roots.push(win.join(env.LOCALAPPDATA.trim(), "Programs", name, "resources"));
      if (env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()) {
        roots.push(win.join((env.ProgramFiles ?? env.PROGRAMFILES ?? "").trim(), name, "resources"));
      }
    }
    return dedupePaths(roots).map((root) => win.join(root, "native"));
  }
  return [];
}

/**
 * The version of the ADE app installed on this machine, so a brain can report
 * it beside its own: after `ade brain update` the brain runs a newer version
 * than the app, and other devices must not read the brain's as the app's.
 * macOS reads the bundle's Info.plist (the recorded app first, then the
 * channel's app in /Applications and ~/Applications), so an app updated since
 * it last ran still reads right, app running or not. Windows uses the version
 * the app recorded, while that install is still there. Null when no app is
 * installed (Linux, a headless server) or its version cannot be read.
 */
export function readInstalledDesktopAppVersion(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): string | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const record = readDesktopAppRecord(env, platform);
  if (platform === "darwin") {
    for (const appPath of macDesktopAppPaths(env, input.homeDir ?? os.homedir(), record)) {
      const info = readBundleInfo(appPath);
      if (!info) continue;
      const recorded = record && path.resolve(record.appPath) === path.resolve(appPath) ? record.version : null;
      return info.version ?? recorded?.trim() ?? null;
    }
    return null;
  }
  if (platform === "win32") {
    if (!record?.version?.trim()) return null;
    try {
      return fs.statSync(record.resourcesPath).isDirectory() ? record.version.trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Where a standalone brain finds a native helper it has no `resources` for,
 * after the usual search: the runtime archive `ade brain update` installs
 * (`<ADE_RUNTIME_ROOT>/native/<name>`) and the installed ADE app. `prefer`
 * picks the order:
 *
 * - `app` for the Mac Desktop driver: macOS ties Screen Recording and
 *   Accessibility grants to the binary's code signature and path, so the
 *   app's own signed copy is the one the user granted.
 * - `runtime` for the rest (sim helper, `ade-media`): the archive ships the
 *   brain's own build, so its protocol matches the brain's.
 *
 * `spotlight` adds the app Spotlight finds by bundle id when nothing in the
 * usual places has the helper (macOS only; a miss is asked again after five minutes).
 */
export function standaloneNativeHelperCandidates(input: {
  binaryName: string;
  prefer: "app" | "runtime";
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string[] {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const join = platform === "win32" ? path.win32.join : path.join;
  const runtimeRoots = dedupePaths([
    env.ADE_RUNTIME_ROOT?.trim() ?? "",
    env.ADE_RESOLVED_RUNTIME_ROOT?.trim() ?? "",
  ]);
  const runtime = runtimeRoots.map((root) => join(root, "native", input.binaryName));
  const app = installedDesktopAppNativeDirs({ platform, env, homeDir: input.homeDir })
    .map((dir) => join(dir, input.binaryName));
  return dedupePaths(input.prefer === "app" ? [...app, ...runtime] : [...runtime, ...app]);
}

/** The Spotlight fallback for `standaloneNativeHelperCandidates`, macOS only. */
function spotlightNativeHelperCandidate(binaryName: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== "darwin" || env.VITEST) return null;
  const appPath = spotlightAppPath(resolveAssociatedAppBundleId(env));
  return appPath ? path.join(appPath, "Contents", "Resources", "native", binaryName) : null;
}

/**
 * `candidates`, then (only when none is usable) the app Spotlight finds by
 * the channel's bundle id. Keeps the Spotlight query off every lookup that
 * already succeeds.
 */
export function withSpotlightFallback(
  binaryName: string,
  candidates: readonly string[],
  accept: (candidate: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (candidates.some((candidate) => accept(candidate))) return [...candidates];
  const spotlight = spotlightNativeHelperCandidate(binaryName, env, platform);
  return spotlight ? dedupePaths([...candidates, spotlight]) : [...candidates];
}

/**
 * The Windows Desktop native helper.
 *
 * The same search as `resolveMacDesktopDriverBinary`, for the same reasons, but
 * gated to win32 and looking for the `.exe`. `ADE_WINDOWS_DESKTOP_DRIVER_PATH`
 * is the developer override, honored only when it names a real file. Returns
 * `null` off win32 rather than throwing.
 */
export function resolveWindowsDesktopDriverBinary(input: {
  isPackaged?: boolean;
  resourcesPath?: string | null;
  appPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
} = {}): string | null {
  return resolveDesktopDriverBinary({
    ...input,
    supportedPlatform: "win32",
    binaryName: WINDOWS_DESKTOP_DRIVER_BINARY,
    overrideEnv: "ADE_WINDOWS_DESKTOP_DRIVER_PATH",
    overrideIgnoredEvent: "windows_desktop.driver_path_override_ignored",
    // A standalone Windows brain (`ade.exe serve`) has no resources of its
    // own: the installed app's driver, then the runtime archive.
    fallbackCandidates: (input.platform ?? process.platform) === "win32"
      ? standaloneNativeHelperCandidates({ binaryName: WINDOWS_DESKTOP_DRIVER_BINARY, prefer: "app", platform: "win32", env: input.env })
      : [],
    fixedPath: input.isPackaged && input.resourcesPath
      ? path.join(input.resourcesPath, "native", WINDOWS_DESKTOP_DRIVER_BINARY)
      : input.appPath
        ? path.join(input.appPath, "resources", "native", WINDOWS_DESKTOP_DRIVER_BINARY)
        : null,
    accept: existsOnDisk,
  });
}

/**
 * The Linux lane-screen helper (`native/ADEDesktopDriverLinux`, Rust).
 *
 * A Linux host runs the headless brain only, so there is no Electron
 * `resources` directory: the helper ships in the brain's native runtime
 * archive (`<ADE_RUNTIME_ROOT>/native/ade-desktop-driver`) and is otherwise
 * found the way the daemon finds every helper. `ADE_LINUX_DESKTOP_DRIVER_PATH`
 * is the developer override, honored only when it names an executable file.
 * Returns `null` off Linux rather than throwing.
 */
export function resolveLinuxDesktopDriverBinary(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
} = {}): string | null {
  const env = input.env ?? process.env;
  const runtimeRoot = env.ADE_RUNTIME_ROOT?.trim();
  // A source checkout builds into `resources/native/linux-<arch>/` (see
  // scripts/build-linux-desktop-driver.mjs); the runtime archive flattens it.
  const archDir = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
  return resolveDesktopDriverBinary({
    ...input,
    supportedPlatform: "linux",
    binaryName: MAC_DESKTOP_DRIVER_BINARY,
    overrideEnv: "ADE_LINUX_DESKTOP_DRIVER_PATH",
    overrideIgnoredEvent: "linux_desktop.driver_path_override_ignored",
    extraCandidates: runtimeRoot ? [path.join(runtimeRoot, "native", MAC_DESKTOP_DRIVER_BINARY)] : [],
    searchNames: [MAC_DESKTOP_DRIVER_BINARY, path.join(archDir, MAC_DESKTOP_DRIVER_BINARY)],
    accept: isExecutableFile,
  });
}

/**
 * The Mac Desktop native helper, resolved in `resources/native`.
 *
 * Every native binary is materialized into the same `resources/native`
 * directory and copied by the same `extraResources` entry, so one file means a
 * packaging change is one edit. Every input is optional
 * because this service runs in the ADE runtime daemon as well as in Electron
 * main, and the daemon has no `app.getAppPath()`.
 *
 * Returns `null` off macOS rather than throwing: `getStatus` answers on every
 * platform, and a resolver that threw would turn "this host cannot host a
 * display" into a crash on a machine that was only ever going to view one.
 */
export function resolveMacDesktopDriverBinary(input: {
  /** Absent in the ADE runtime daemon, which has no Electron `app`. */
  isPackaged?: boolean;
  resourcesPath?: string | null;
  appPath?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam and the reason `logOverrideIgnored` exists. */
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
} = {}): string | null {
  return resolveDesktopDriverBinary({
    ...input,
    supportedPlatform: "darwin",
    binaryName: MAC_DESKTOP_DRIVER_BINARY,
    overrideEnv: "ADE_MAC_DESKTOP_DRIVER_PATH",
    overrideIgnoredEvent: "mac_desktop.driver_path_override_ignored",
    // A standalone brain (`~/.ade/bin/ade serve`) has no resources of its
    // own. The installed app's signed driver comes first: its Screen
    // Recording and Accessibility grants belong to that exact binary.
    fallbackCandidates: (input.platform ?? process.platform) === "darwin"
      ? standaloneNativeHelperCandidates({ binaryName: MAC_DESKTOP_DRIVER_BINARY, prefer: "app", platform: "darwin", env: input.env })
      : [],
    spotlight: true,
    fixedPath: input.isPackaged && input.resourcesPath
      ? path.join(input.resourcesPath, "native", MAC_DESKTOP_DRIVER_BINARY)
      : input.appPath
        ? path.join(input.appPath, "resources", "native", MAC_DESKTOP_DRIVER_BINARY)
        : null,
    accept: existsOnDisk,
    // A developer override that cannot be executed is ignored (the health card
    // then reports the real installation); the search keeps its historical
    // `exists` predicate so nothing gets stricter as a side effect.
    acceptOverride: isExecutableFile,
  });
}

/** The demo-video engine, built into the same `resources/native` directory. */
const ADE_MEDIA_BINARY = "ade-media";

/**
 * The `ade-media` demo engine (analyze + render), or `null` when this host
 * cannot run it.
 *
 * Searched the way the Mac Desktop driver is — packaged resources, the dev
 * app's `resources/native`, then upward from this module for the brain, which
 * has no Electron `app` — but unlike the driver it answers `null` rather than
 * a missing path: a demo with no engine is filed as its raw recording, and the
 * caller needs a yes/no to choose the other engine, not a path to report.
 * `ADE_MEDIA_PATH` overrides the search when it names an executable file.
 */
export function resolveAdeMediaBinary(input: {
  logger?: { debug: (event: string, detail?: Record<string, unknown>) => void } | null;
} = {}): string | null {
  if (process.platform !== "darwin") return null;
  const override = process.env.ADE_MEDIA_PATH?.trim();
  if (override) {
    if (isExecutableFile(override)) return override;
    input.logger?.debug("demo_video.ade_media_path_override_ignored", { path: override });
  }
  const candidates = dedupePaths([
    ...daemonNativeCandidates(ADE_MEDIA_BINARY),
    ...standaloneNativeHelperCandidates({ binaryName: ADE_MEDIA_BINARY, prefer: "runtime" }),
  ]);
  return pickNativeHelper(ADE_MEDIA_BINARY, withSpotlightFallback(ADE_MEDIA_BINARY, candidates, isExecutableFile), isExecutableFile);
}

/**
 * The Apple Music player host, which ships as a directory with its player
 * page: `ade-music-host.exe` on Windows (`native/ADEMusicHostWin`, WebView2),
 * `ade-music-host` on macOS (`native/ADEMusicHostMac`, WKWebView). `null`
 * elsewhere, where Music has no host. `ADE_MUSIC_HOST_PATH` is the developer
 * override, honored only when it names a real file.
 */
export function resolveMusicHostExecutable(input: {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") return null;
  const override = (input.env ?? process.env).ADE_MUSIC_HOST_PATH?.trim();
  if (override && fs.existsSync(override)) return override;
  const name = platform === "win32" ? "ade-music-host.exe" : "ade-music-host";
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "ade-music-host", name)
    : path.join(input.appPath, "resources", "native", "ade-music-host", name);
}

/**
 * The Windows Now Playing helper (`native/ADENowPlayingWin`), or `null` when
 * this is not Windows or the helper is not on disk (an unbuilt dev tree), so
 * the widget can say it is missing instead of failing to spawn.
 */
export function resolveNowPlayingHelperBinary(input: {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string | null {
  if ((input.platform ?? process.platform) !== "win32") return null;
  const name = "ade-now-playing.exe";
  const candidates = input.isPackaged
    ? [path.join(input.resourcesPath, "native", name)]
    : [path.join(input.appPath, "resources", "native", name), path.join(input.appPath, "apps", "desktop", "resources", "native", name)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Where a native helper sits when there is no Electron `app` to ask (the
 * runtime daemon) or when Electron main runs it: the process's resources
 * directory, then every `resources/native` walking up from this module.
 */
function daemonNativeCandidates(binary: string): string[] {
  const candidates: string[] = [];
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (processResourcesPath) candidates.push(path.join(processResourcesPath, "native", binary));
  let current = typeof __dirname === "string" ? __dirname : process.cwd();
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(path.join(current, "resources", "native", binary));
    candidates.push(path.join(current, "apps", "desktop", "resources", "native", binary));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Beside the executable: a brain at `~/.ade/bin/ade` (SSH bootstrap uploads
  // its helpers to `~/.ade/bin/resources/native`). In a Node SEA `__dirname`
  // is usually that directory already; this keeps it when it is not.
  candidates.push(path.join(path.dirname(process.execPath), "resources", "native", binary));
  return dedupePaths(candidates);
}

/** How a packaged app was signed, as `MacDesktopSigningState` spells it. */
export type AdeSigningState = "adhoc" | "identity" | "unknown";

/** The marker UNIT-K writes beside the app's resources: `adhoc` or `identity`. */
const ADE_SIGNING_MARKER_PATH = ["ade-cli", "signing"] as const;

/**
 * Reads the build's signing identity from the marker the packaging step writes.
 *
 * The marker sits at `Contents/Resources/ade-cli/signing`. Electron main can
 * name that directory directly, but the runtime daemon has no `app`, so the
 * candidates are assembled the same way the driver binary is: the resources
 * directory derived from the binary, `process.resourcesPath` when it exists,
 * and every `Resources` directory above `process.execPath` and this module.
 * A packaged app with no marker anywhere is treated as ad-hoc — the safe
 * reading, because it is exactly the case where macOS drops the grant and the
 * user needs to be told. An unpackaged dev build is always `identity`: telling
 * a developer to re-add the grant on every rebuild is noise about a build that
 * never shipped.
 */
export function resolveAdeSigningState(input: {
  platform?: NodeJS.Platform;
  /** Electron's `process.resourcesPath`; gives the marker directly. */
  resourcesPath?: string | null;
  /** Electron's `app.isPackaged`. Inferred from the candidates when absent. */
  isPackaged?: boolean;
  /** Test seam; defaults to `resolveMacDesktopDriverBinary`. */
  driverBinaryPath?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): AdeSigningState {
  if ((input.platform ?? process.platform) !== "darwin") return "unknown";
  const binary = input.driverBinaryPath !== undefined
    ? input.driverBinaryPath
    : resolveMacDesktopDriverBinary({ platform: input.platform, env: input.env });

  const resourcesDirs: string[] = [];
  const addResources = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && !resourcesDirs.includes(trimmed)) resourcesDirs.push(trimmed);
  };
  addResources(input.resourcesPath);
  if (binary) addResources(path.dirname(path.dirname(binary)));
  addResources((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath);
  // A packaged app is `.../ADE.app/Contents/Resources`; walking up from the
  // executable (main's own or this daemon's) finds it whether or not Electron
  // ever told this process where its resources live.
  const starts = [process.execPath, typeof __dirname === "string" ? __dirname : null];
  for (const start of starts) {
    if (!start) continue;
    let current = path.dirname(start);
    for (let depth = 0; depth < 12; depth += 1) {
      addResources(path.join(current, "Resources"));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const packaged = input.isPackaged ?? resourcesDirs.some(
    (dir) => dir.includes(`${path.sep}.app${path.sep}Contents${path.sep}`),
  );
  if (!packaged) return "identity";

  for (const dir of resourcesDirs) {
    const markerPath = path.join(dir, ...ADE_SIGNING_MARKER_PATH);
    try {
      const contents = fs.readFileSync(markerPath, "utf8").trim();
      if (contents === "identity") return "identity";
      if (contents === "adhoc") return "adhoc";
      return "unknown";
    } catch {
      // Not this directory; try the next candidate.
    }
  }
  // Packaged and no marker anywhere: the grant is not durable, so say so.
  return "adhoc";
}
