/**
 * Which of the user's own Chromium browsers on this machine have remote
 * debugging turned on — found WITHOUT connecting to anything.
 *
 * A browser with remote debugging on writes `DevToolsActivePort` into its
 * user-data directory: the port on the first line, the browser-level
 * WebSocket path on the second. Reading that file is the whole check.
 * Connecting to the port is what makes Chrome ask the user "Allow remote
 * debugging?", so a status read must never do it; only `attach` connects.
 *
 * Paths are resolved from an injected platform/env/home so the three-OS
 * matrix is the same code everywhere. Windows and Linux are first-class:
 * `%LOCALAPPDATA%\<vendor>\User Data` and `$XDG_CONFIG_HOME` (or
 * `~/.config`).
 *
 * @module userBrowser/userBrowserDiscovery
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const USER_BROWSER_IDS = ["chrome", "edge", "brave", "arc", "helium", "chromium"] as const;

export type UserBrowserId = (typeof USER_BROWSER_IDS)[number];

export function isUserBrowserId(value: unknown): value is UserBrowserId {
  return typeof value === "string" && (USER_BROWSER_IDS as readonly string[]).includes(value);
}

type UserBrowserDefinition = {
  id: UserBrowserId;
  label: string;
  /** The URL scheme the browser's own pages use (`chrome://`, `edge://`). */
  scheme: "chrome" | "edge" | "brave";
  /** Under `~/Library/Application Support`. */
  macSegments: readonly string[];
  /** Under `%LOCALAPPDATA%`; absent when the browser has no Windows build. */
  windowsSegments?: readonly string[];
  /** Under `$XDG_CONFIG_HOME` (default `~/.config`); absent with no Linux build. */
  linuxSegments?: readonly string[];
};

/**
 * Order is the tie-break when two browsers wrote their port file at the same
 * moment; the newest file wins otherwise.
 */
const USER_BROWSER_DEFINITIONS: readonly UserBrowserDefinition[] = [
  {
    id: "chrome",
    label: "Google Chrome",
    scheme: "chrome",
    macSegments: ["Google", "Chrome"],
    windowsSegments: ["Google", "Chrome", "User Data"],
    linuxSegments: ["google-chrome"],
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    scheme: "edge",
    macSegments: ["Microsoft Edge"],
    windowsSegments: ["Microsoft", "Edge", "User Data"],
    linuxSegments: ["microsoft-edge"],
  },
  {
    id: "brave",
    label: "Brave",
    scheme: "brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
    windowsSegments: ["BraveSoftware", "Brave-Browser", "User Data"],
    linuxSegments: ["BraveSoftware", "Brave-Browser"],
  },
  {
    id: "arc",
    label: "Arc",
    scheme: "chrome",
    macSegments: ["Arc", "User Data"],
    // Arc for Windows is an MSIX package; its profile lives in the package's
    // redirected local cache. Arc has no Linux build.
    windowsSegments: ["Packages", "TheBrowserCompany.Arc_ttt1ap7aakyb4", "LocalCache", "Local", "Arc", "User Data"],
  },
  {
    id: "helium",
    label: "Helium",
    scheme: "chrome",
    macSegments: ["net.imput.helium"],
    windowsSegments: ["imput", "Helium", "User Data"],
    linuxSegments: ["net.imput.helium"],
  },
  {
    id: "chromium",
    label: "Chromium",
    scheme: "chrome",
    macSegments: ["Chromium"],
    windowsSegments: ["Chromium", "User Data"],
    linuxSegments: ["chromium"],
  },
];

export function userBrowserLabel(id: UserBrowserId): string {
  return USER_BROWSER_DEFINITIONS.find((entry) => entry.id === id)?.label ?? id;
}

/** The page where the user turns remote debugging on, in that browser's own scheme. */
export function userBrowserInspectUrl(id: UserBrowserId): string {
  const scheme = USER_BROWSER_DEFINITIONS.find((entry) => entry.id === id)?.scheme ?? "chrome";
  return `${scheme}://inspect/#remote-debugging`;
}

export type UserBrowserPathContext = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
};

function defaultPathContext(): UserBrowserPathContext {
  return { platform: process.platform, home: os.homedir(), env: process.env };
}

/** The browser's user-data directory on this OS, or null when it has no build here. */
export function userBrowserDataDirectory(id: UserBrowserId, context: UserBrowserPathContext): string | null {
  const definition = USER_BROWSER_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) return null;
  if (context.platform === "darwin") {
    return path.join(context.home, "Library", "Application Support", ...definition.macSegments);
  }
  if (context.platform === "win32") {
    const localAppData = context.env.LOCALAPPDATA?.trim();
    // No fallback: a relative `\Google\...` would resolve against the current
    // drive root and could "find" a file nobody meant.
    if (!definition.windowsSegments || !localAppData) return null;
    return path.win32.join(localAppData, ...definition.windowsSegments);
  }
  if (context.platform === "linux") {
    if (!definition.linuxSegments) return null;
    const xdg = context.env.XDG_CONFIG_HOME?.trim();
    const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(context.home, ".config");
    return path.join(base, ...definition.linuxSegments);
  }
  return null;
}

/** What a browser's `DevToolsActivePort` file says, when it says something usable. */
export type DevToolsActivePort = {
  port: number;
  /** The browser-level WebSocket path, e.g. `/devtools/browser/<uuid>`. */
  browserPath: string;
  /** When the browser wrote the file (its mtime). */
  writtenAt: Date;
};

/** Parse the two-line file. Anything malformed reads as "remote debugging is off". */
export function parseDevToolsActivePort(text: string, writtenAt: Date): DevToolsActivePort | null {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number.parseInt(portLine?.trim() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const browserPath = pathLine?.trim() ?? "";
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath)) return null;
  return { port, browserPath, writtenAt };
}

function readDevToolsActivePort(userDataDir: string): DevToolsActivePort | null {
  const filePath = path.join(userDataDir, "DevToolsActivePort");
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 4_096) return null;
    return parseDevToolsActivePort(fs.readFileSync(filePath, "utf8"), stat.mtime);
  } catch {
    return null;
  }
}

function directoryExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export type DiscoveredUserBrowser = {
  id: UserBrowserId;
  label: string;
  userDataDir: string;
  /** The profile directory exists, so the browser has run on this machine. */
  installed: boolean;
  /** Present when remote debugging is on (the port file exists and parses). */
  debugging: DevToolsActivePort | null;
  inspectUrl: string;
};

/**
 * Every supported browser this OS has a profile path for, newest
 * `DevToolsActivePort` first. Reads files only — never opens a socket.
 *
 * `userDataDir` checks one profile directory instead of the defaults (a
 * browser started with `--user-data-dir`); `browser` then names which
 * browser it is, and otherwise filters the defaults.
 */
export function discoverUserBrowsers(
  options: { browser?: UserBrowserId | null; userDataDir?: string | null } = {},
  context: UserBrowserPathContext = defaultPathContext(),
): DiscoveredUserBrowser[] {
  const explicitDir = options.userDataDir?.trim() || null;
  if (explicitDir) {
    const id = options.browser ?? "chrome";
    const resolved = path.resolve(explicitDir);
    return [{
      id,
      label: userBrowserLabel(id),
      userDataDir: resolved,
      installed: directoryExists(resolved),
      debugging: readDevToolsActivePort(resolved),
      inspectUrl: userBrowserInspectUrl(id),
    }];
  }
  const found: DiscoveredUserBrowser[] = [];
  for (const definition of USER_BROWSER_DEFINITIONS) {
    if (options.browser && definition.id !== options.browser) continue;
    const userDataDir = userBrowserDataDirectory(definition.id, context);
    if (!userDataDir) continue;
    const installed = directoryExists(userDataDir);
    found.push({
      id: definition.id,
      label: definition.label,
      userDataDir,
      installed,
      debugging: installed ? readDevToolsActivePort(userDataDir) : null,
      inspectUrl: userBrowserInspectUrl(definition.id),
    });
  }
  // Stable sort: newest port file first; browsers without one keep catalog order.
  return found.sort((left, right) => {
    const leftAt = left.debugging?.writtenAt.getTime() ?? -1;
    const rightAt = right.debugging?.writtenAt.getTime() ?? -1;
    return rightAt - leftAt;
  });
}
