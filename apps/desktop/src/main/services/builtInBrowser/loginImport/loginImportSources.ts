/**
 * Which browsers and profiles this machine can offer logins from, and — just as
 * important — which it cannot, with a reason worth showing a human.
 *
 * Every path decision takes its platform, home directory, and environment from
 * an injected context rather than reading `process` directly, so the whole
 * matrix is testable for all three operating systems from any one of them.
 *
 * @module loginImport/loginImportSources
 */
import fs from "node:fs";
import path from "node:path";

import type {
  BrowserLoginImportCapabilities,
  BrowserLoginImportCapability,
  BrowserLoginImportEngine,
  BrowserLoginImportPlatform,
} from "../../../../shared/types/builtInBrowserLoginImport";

export type LoginImportPathContext = {
  platform: NodeJS.Platform;
  home: string;
  /** `%APPDATA%` — where Firefox keeps its profiles on Windows. */
  appData?: string | null;
  /** `%LOCALAPPDATA%` — where Chromium forks keep theirs on Windows. */
  localAppData?: string | null;
};

/**
 * The one reason ADE must state plainly rather than paper over. Chrome 127+
 * wraps the cookie key with App-Bound Encryption, which is tied to the
 * browser's own code identity: no other process can unwrap it, so this is a
 * ceiling, not a bug to fix later.
 */
export const WINDOWS_CHROMIUM_UNSUPPORTED_REASON =
  "Chrome's app-bound encryption blocks import on Windows";

export type BrowserDefinition = {
  id: string;
  name: string;
  engine: BrowserLoginImportEngine;
  /** Platforms the browser ships on at all. */
  platforms: NodeJS.Platform[];
  /** Platforms ADE can actually read from, with the reason for the others. */
  unsupportedOn?: Partial<Record<NodeJS.Platform, string>>;
  keychainService?: string;
  keychainAccount?: string;
  linuxSecretApplication?: string;
  userDataDirectory: (context: LoginImportPathContext) => string | undefined;
};

const macApplicationSupport = (context: LoginImportPathContext, ...segments: string[]): string =>
  path.join(context.home, "Library", "Application Support", ...segments);

type ChromiumSourceInput = {
  id: string;
  name: string;
  keychainService: string;
  keychainAccount: string;
  macSegments: string[];
  linuxSegments?: string[];
  /** Only Helium has one: every other fork is app-bound on Windows. */
  windowsSegments?: string[];
  linuxSecretApplication?: string;
};

function chromiumSource(input: ChromiumSourceInput): BrowserDefinition {
  const platforms: NodeJS.Platform[] = ["darwin"];
  if (input.linuxSegments) platforms.push("linux");
  platforms.push("win32");
  return {
    id: input.id,
    name: input.name,
    engine: "chromium",
    platforms,
    unsupportedOn: {
      ...(input.windowsSegments ? {} : { win32: WINDOWS_CHROMIUM_UNSUPPORTED_REASON }),
      ...(input.linuxSegments ? {} : { linux: `${input.name} has no Linux build ADE can import from.` }),
    },
    keychainService: input.keychainService,
    keychainAccount: input.keychainAccount,
    linuxSecretApplication: input.linuxSecretApplication,
    userDataDirectory: (context) => {
      if (context.platform === "darwin") return macApplicationSupport(context, ...input.macSegments);
      if (context.platform === "win32") {
        return input.windowsSegments && context.localAppData
          ? path.join(context.localAppData, ...input.windowsSegments)
          : undefined;
      }
      if (context.platform === "linux") {
        return input.linuxSegments ? path.join(context.home, ".config", ...input.linuxSegments) : undefined;
      }
      return undefined;
    },
  };
}

/**
 * Every browser ADE knows about. Order is the order the picker shows them in.
 */
export const LOGIN_IMPORT_BROWSERS: BrowserDefinition[] = [
  chromiumSource({
    id: "chrome",
    name: "Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macSegments: ["Google", "Chrome"],
    linuxSegments: ["google-chrome"],
    linuxSecretApplication: "chrome",
  }),
  chromiumSource({
    id: "chromium",
    name: "Chromium",
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
    macSegments: ["Chromium"],
    linuxSegments: ["chromium"],
    linuxSecretApplication: "chromium",
  }),
  chromiumSource({
    id: "brave",
    name: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSegments: ["BraveSoftware", "Brave-Browser"],
    linuxSecretApplication: "brave",
  }),
  chromiumSource({
    id: "edge",
    name: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macSegments: ["Microsoft Edge"],
    linuxSegments: ["microsoft-edge"],
    linuxSecretApplication: "msedge",
  }),
  // Arc has no Linux build.
  chromiumSource({
    id: "arc",
    name: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macSegments: ["Arc", "User Data"],
  }),
  chromiumSource({
    id: "vivaldi",
    name: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
    macSegments: ["Vivaldi"],
    linuxSegments: ["vivaldi"],
    linuxSecretApplication: "vivaldi",
  }),
  chromiumSource({
    id: "opera",
    name: "Opera",
    keychainService: "Opera Safe Storage",
    keychainAccount: "Opera",
    macSegments: ["com.operasoftware.Opera"],
    linuxSegments: ["opera"],
    linuxSecretApplication: "opera",
  }),
  // Helium is the one Chromium fork that still uses the legacy DPAPI-wrapped
  // key on Windows, so it is importable there. Its keychain identity is the
  // outlier ("Helium Storage Key"), and on Linux it kept Chromium's libsecret
  // application name.
  chromiumSource({
    id: "helium",
    name: "Helium",
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
    macSegments: ["net.imput.helium"],
    linuxSegments: ["net.imput.helium"],
    windowsSegments: ["imput", "Helium", "User Data"],
    linuxSecretApplication: "chromium",
  }),
  {
    id: "safari",
    name: "Safari",
    engine: "safari",
    platforms: ["darwin"],
    unsupportedOn: {
      win32: "Safari is macOS only.",
      linux: "Safari is macOS only.",
    },
    // The default jar lives here; named profiles use WebKit data stores.
    userDataDirectory: (context) =>
      context.platform === "darwin"
        ? path.join(context.home, "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies")
        : undefined,
  },
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    platforms: ["darwin", "win32", "linux"],
    userDataDirectory: (context) => {
      if (context.platform === "darwin") return macApplicationSupport(context, "Firefox");
      if (context.platform === "win32") {
        return context.appData ? path.join(context.appData, "Mozilla", "Firefox") : undefined;
      }
      if (context.platform === "linux") return path.join(context.home, ".mozilla", "firefox");
      return undefined;
    },
  },
];

export function toImportPlatform(platform: NodeJS.Platform): BrowserLoginImportPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "other";
}

/** Why (or whether) one browser can be imported from on this platform. */
export function describeBrowserCapability(
  definition: BrowserDefinition,
  platform: NodeJS.Platform,
): BrowserLoginImportCapability {
  const base = {
    browserId: definition.id,
    browserName: definition.name,
    engine: definition.engine,
  };
  if (toImportPlatform(platform) === "other") {
    return { ...base, supported: false, reason: "ADE can't import logins on this platform." };
  }
  const named = definition.unsupportedOn?.[platform];
  if (named) return { ...base, supported: false, reason: named };
  if (!definition.platforms.includes(platform)) {
    return { ...base, supported: false, reason: `${definition.name} has no build on this platform.` };
  }
  return { ...base, supported: true, reason: null };
}

/** The full per-OS support matrix, independent of what is actually installed. */
export function describeLoginImportCapabilities(
  platform: NodeJS.Platform,
): BrowserLoginImportCapabilities {
  const browsers = LOGIN_IMPORT_BROWSERS.map((definition) =>
    describeBrowserCapability(definition, platform));
  return {
    platform: toImportPlatform(platform),
    anySupported: browsers.some((browser) => browser.supported),
    browsers,
  };
}

/**
 * Chromium's `Local State` is user-writable, so a profile key from it is
 * untrusted input: `..` or a separator would escape the user-data directory.
 */
export function isSafeProfileDirectory(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") return false;
  return !/[/\\\0]/.test(name);
}

export type DiscoveredProfile = {
  /** Stable within a browser; used to build the source id. */
  id: string;
  name: string;
  /** Absolute path to the jar this profile's cookies live in. */
  cookieDatabasePath: string;
};

const isFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Where a profile's jar may live, most current first. Chromium 96 moved the
 * live jar into `Network/`; a root-level `Cookies` is either a pre-96 install or
 * a leftover from before the move, and importing the leftover would snapshot a
 * stale database.
 */
export function cookieDatabaseCandidatePaths(
  engine: BrowserLoginImportEngine,
  profilePath: string,
): string[] {
  if (engine === "firefox") return [path.join(profilePath, "cookies.sqlite")];
  if (engine === "safari") return [path.join(profilePath, "Cookies.binarycookies")];
  return [path.join(profilePath, "Network", "Cookies"), path.join(profilePath, "Cookies")];
}

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at a
 * default profile but do not describe one, so only `[ProfileN]` blocks count.
 */
export function parseFirefoxProfilesIni(
  contents: string,
): Array<{ name: string; relativePath: string; isRelative: boolean }> {
  const profiles: Array<{ name: string; relativePath: string; isRelative: boolean }> = [];
  let section: string | null = null;
  let current: { name?: string; path?: string; isRelative: boolean } | null = null;

  const flush = (): void => {
    if (section && /^Profile\d+$/.test(section) && current?.path) {
      profiles.push({
        name: current.name?.trim() || current.path,
        relativePath: current.path,
        isRelative: current.isRelative,
      });
    }
    current = null;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      flush();
      section = header[1] ?? null;
      current = { isRelative: true };
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") current.name = value;
    else if (key === "path") current.path = value;
    else if (key === "isrelative") current.isRelative = value !== "0";
  }
  flush();
  return profiles;
}

function discoverFirefoxProfiles(root: string): DiscoveredProfile[] {
  const profiles: DiscoveredProfile[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, profilePath: string): void => {
    const jar = path.join(profilePath, "cookies.sqlite");
    if (seen.has(jar) || !isFile(jar)) return;
    seen.add(jar);
    profiles.push({ id, name, cookieDatabasePath: jar });
  };

  try {
    const ini = fs.readFileSync(path.join(root, "profiles.ini"), "utf8");
    for (const entry of parseFirefoxProfilesIni(ini)) {
      const profilePath = entry.isRelative ? path.join(root, entry.relativePath) : entry.relativePath;
      add(entry.relativePath, entry.name, profilePath);
    }
  } catch {
    // A stale or missing profiles.ini falls through to the directory scan.
  }

  if (profiles.length === 0) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        add(entry.name, entry.name, path.join(root, entry.name));
      }
    } catch {
      // No readable root means no Firefox profiles; the caller reports that.
    }
  }
  return profiles;
}

function discoverChromiumProfiles(root: string): DiscoveredProfile[] {
  const names = new Set<string>();
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    for (const key of Object.keys(localState.profile?.info_cache ?? {})) {
      if (isSafeProfileDirectory(key)) names.add(key);
    }
  } catch {
    // A fresh or unreadable install still has a Default profile to try.
  }
  if (names.size === 0) names.add("Default");

  const displayNames = new Map<string, string>();
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    for (const [key, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      if (typeof info?.name === "string" && info.name.trim().length > 0) {
        displayNames.set(key, info.name.trim());
      }
    }
  } catch {
    // Display names are cosmetic; the directory name is a fine fallback.
  }

  const profiles: DiscoveredProfile[] = [];
  for (const name of names) {
    const profilePath = path.join(root, name);
    const jar = cookieDatabaseCandidatePaths("chromium", profilePath).find(isFile);
    if (!jar) continue;
    profiles.push({ id: name, name: displayNames.get(name) ?? name, cookieDatabasePath: jar });
  }
  return profiles;
}

function discoverSafariProfiles(context: LoginImportPathContext, root: string): DiscoveredProfile[] {
  const profiles: DiscoveredProfile[] = [];
  const defaultJar = path.join(root, "Cookies.binarycookies");
  // Safari's jar is inside a TCC-protected container: `stat` answers even
  // without Full Disk Access, which is exactly what lets the listing find it
  // and then report the missing grant instead of "not installed".
  if (fs.existsSync(defaultJar)) {
    profiles.push({ id: "default", name: "Default", cookieDatabasePath: defaultJar });
  }
  // Named profiles keep their cookies in per-profile WebKit data stores.
  const dataStoreRoot = path.join(context.home, "Library", "WebKit", "WebsiteDataStore");
  try {
    for (const entry of fs.readdirSync(dataStoreRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jar = path.join(dataStoreRoot, entry.name, "Cookies", "Cookies.binarycookies");
      if (!fs.existsSync(jar)) continue;
      profiles.push({
        id: entry.name,
        name: `Profile ${entry.name.slice(0, 8)}`,
        cookieDatabasePath: jar,
      });
    }
  } catch {
    // No per-profile data stores is the common case.
  }
  return profiles;
}

/** Profiles present on disk for one browser, or `[]` when it is not installed. */
export function discoverProfiles(
  definition: BrowserDefinition,
  context: LoginImportPathContext,
): DiscoveredProfile[] {
  const root = definition.userDataDirectory(context);
  if (!root) return [];
  if (definition.engine === "firefox") return discoverFirefoxProfiles(root);
  if (definition.engine === "safari") return discoverSafariProfiles(context, root);
  return discoverChromiumProfiles(root);
}

/** `<browserId>:<profileId>` — the only source handle that crosses IPC. */
export function makeSourceId(browserId: string, profileId: string): string {
  return `${browserId}:${profileId}`;
}
