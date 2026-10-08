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
 * Once `attach` has connected, the same module picks the tab: it lists the
 * browser's page targets and probes which one the user is looking at.
 *
 * @module userBrowser/userBrowserDiscovery
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { USER_BROWSER_IDS, type UserBrowserId } from "../../../shared/userBrowserLabels";
import { isRecord, stringOrNull } from "../../../shared/agentObservationNormalizers";
import type { CdpClient } from "../shared/cdpClient";
import { withTimeout } from "../shared/withTimeout";

export type { UserBrowserId };

/** An attach failure whose message is written for the agent to act on. */
export class UserBrowserAttachError extends Error {}

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

// ── Picking the tab (after `attach` connected) ──────────────────────────────

/** One visibility probe per tab while picking the tab the user is looking at. */
const TAB_PROBE_TIMEOUT_MS = 1_500;
const MAX_PROBED_TABS = 40;

export type UserBrowserPageTarget = { targetId: string; title: string; url: string };

function quoteTitle(title: string): string {
  const trimmed = title.trim() || "(untitled)";
  return `"${trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed}"`;
}

export function describeTab(tab: { title: string; url: string }): string {
  return `${quoteTitle(tab.title)} (${tab.url})`;
}

function tabList(tabs: readonly UserBrowserPageTarget[]): string {
  return tabs.slice(0, 15).map((tab) => `  - ${describeTab(tab)}`).join("\n")
    + (tabs.length > 15 ? `\n  - …and ${tabs.length - 15} more` : "");
}

async function listPageTargets(client: CdpClient): Promise<UserBrowserPageTarget[]> {
  const response = await client.send<{ targetInfos?: unknown[] }>("Target.getTargets");
  const infos = Array.isArray(response?.targetInfos) ? response.targetInfos : [];
  return infos
    .filter(isRecord)
    .filter((info) => info.type === "page")
    .map((info) => ({
      targetId: stringOrNull(info.targetId) ?? "",
      title: typeof info.title === "string" ? info.title : "",
      url: typeof info.url === "string" ? info.url : "",
    }))
    .filter((tab) => tab.targetId && !tab.url.startsWith("devtools://"));
}

/**
 * Attach to a tab for a probe. When the browser answers only after the probe
 * gave up, the late session is detached then, so a slow tab cannot leave a
 * debugger session behind on the user's page.
 */
async function attachForProbe(client: CdpClient, targetId: string): Promise<string | null> {
  const pending = client.send<{ sessionId?: string }>("Target.attachToTarget", { targetId, flatten: true });
  const attached = await withTimeout(pending, TAB_PROBE_TIMEOUT_MS);
  if (attached) return stringOrNull(attached.sessionId);
  void pending.then(
    (late) => {
      const sessionId = stringOrNull(late?.sessionId);
      if (sessionId && !client.isClosed()) {
        void withTimeout(client.send("Target.detachFromTarget", { sessionId }), TAB_PROBE_TIMEOUT_MS);
      }
    },
    () => {},
  );
  return null;
}

/** Which tabs are on screen, and which one has focus. Best effort per tab. */
async function probeVisibility(
  client: CdpClient,
  tabs: readonly UserBrowserPageTarget[],
): Promise<Map<string, { visible: boolean; focused: boolean }>> {
  const probes = await Promise.all(tabs.slice(0, MAX_PROBED_TABS).map(async (tab) => {
    const sessionId = await attachForProbe(client, tab.targetId);
    if (!sessionId) return [tab.targetId, { visible: false, focused: false }] as const;
    const evaluated = await withTimeout(
      client.session(sessionId).send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "({ visible: document.visibilityState === 'visible', focused: document.hasFocus() })",
        returnByValue: true,
      }),
      TAB_PROBE_TIMEOUT_MS,
    );
    void withTimeout(client.send("Target.detachFromTarget", { sessionId }), TAB_PROBE_TIMEOUT_MS);
    const value = isRecord(evaluated?.result?.value) ? evaluated.result.value : {};
    return [tab.targetId, { visible: value.visible === true, focused: value.focused === true }] as const;
  }));
  return new Map(probes);
}

/**
 * The tab `query` names (a title or URL substring), or the one the user is
 * looking at. Throws with the candidate list when it cannot tell.
 */
export async function chooseUserBrowserTab(
  client: CdpClient,
  query: string | null,
  browserLabel: string,
): Promise<{ tab: UserBrowserPageTarget; visible: boolean }> {
  const tabs = await listPageTargets(client);
  if (!tabs.length) {
    throw new UserBrowserAttachError(`${browserLabel} has no open tabs to attach to.`);
  }
  if (query) {
    const needle = query.toLowerCase();
    const matches = tabs.filter((tab) =>
      tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle));
    const exact = matches.filter((tab) => tab.title.trim().toLowerCase() === needle);
    const picked = matches.length === 1 ? matches[0] : exact.length === 1 ? exact[0] : null;
    if (picked) {
      const visibility = await probeVisibility(client, [picked]);
      return { tab: picked, visible: visibility.get(picked.targetId)?.visible ?? false };
    }
    if (!matches.length) {
      throw new UserBrowserAttachError(
        `No ${browserLabel} tab matches "${query}". Open tabs:\n${tabList(tabs)}\nPass --tab with part of one title or URL.`,
      );
    }
    throw new UserBrowserAttachError(
      `${matches.length} ${browserLabel} tabs match "${query}":\n${tabList(matches)}\nPass --tab with more of the title or URL.`,
    );
  }
  const visibility = await probeVisibility(client, tabs);
  const focused = tabs.filter((tab) => visibility.get(tab.targetId)?.focused);
  const visible = tabs.filter((tab) => visibility.get(tab.targetId)?.visible);
  const picked = focused.length === 1
    ? focused[0]
    : visible.length === 1
      ? visible[0]
      : tabs.length === 1
        ? tabs[0]
        : null;
  if (picked) return { tab: picked, visible: visibility.get(picked.targetId)?.visible ?? false };
  const plausible = visible.length ? visible : tabs;
  throw new UserBrowserAttachError(
    `${browserLabel} has ${plausible.length} tabs that could be the one the user means:\n${tabList(plausible)}\nAsk the user which one, then pass --tab with part of its title or URL.`,
  );
}
