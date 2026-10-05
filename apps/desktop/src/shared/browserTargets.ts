/**
 * The browsers ADE can hand a URL to, and how to find each one on disk.
 *
 * This is the "open this link in another browser" catalog, deliberately kept
 * separate from `builtInBrowser/loginImport/loginImportSources`: importing
 * cookies is about a browser's *profile directory* and its keychain, while
 * opening a link is about the *application* and the command that launches it.
 * The two share ids and names so the same browser reads the same way wherever
 * ADE names it, and nothing else.
 */

export type BrowserTargetPlatform = "darwin" | "win32" | "linux";

/**
 * Declared rather than derived from {@link BROWSER_TARGETS}: the catalog's
 * entries are typed by it, so deriving it back from them is a cycle. Adding a
 * browser means adding its id here and its entry below — the two are checked
 * against each other by `isBrowserTarget`/`browserTargetDefinition` callers.
 */
export type BrowserTarget =
  | "chrome"
  | "safari"
  | "firefox"
  | "edge"
  | "brave"
  | "arc"
  | "chromium"
  | "vivaldi"
  | "opera"
  | "zen";

export type BrowserTargetDefinition = {
  id: BrowserTarget;
  label: string;
  /** Systems the browser ships on at all. */
  platforms: readonly BrowserTargetPlatform[];
  /**
   * macOS: the bundle name Launch Services knows. `open -a "<name>" <url>` is
   * how the browser is launched, whether or not a path was found for its icon.
   */
  macAppName?: string;
  /**
   * Windows: candidate executables, with `{{ProgramFiles}}`,
   * `{{ProgramFilesX86}}` and `{{LocalAppData}}` standing in for the real
   * directories. Checked in order; the first that exists is launched.
   */
  winExecutables?: readonly string[];
  /** Linux: executable names tried on `PATH`, in order. */
  linuxCommands?: readonly string[];
};

/**
 * Every browser ADE offers. Order is the order the menu shows them in —
 * roughly by how often they are someone's default.
 */
export const BROWSER_TARGETS: readonly BrowserTargetDefinition[] = [
  {
    id: "chrome",
    label: "Google Chrome",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Google Chrome",
    winExecutables: [
      "{{ProgramFiles}}/Google/Chrome/Application/chrome.exe",
      "{{ProgramFilesX86}}/Google/Chrome/Application/chrome.exe",
      "{{LocalAppData}}/Google/Chrome/Application/chrome.exe",
    ],
    linuxCommands: ["google-chrome", "google-chrome-stable"],
  },
  {
    id: "safari",
    label: "Safari",
    platforms: ["darwin"],
    macAppName: "Safari",
  },
  {
    id: "firefox",
    label: "Firefox",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Firefox",
    winExecutables: [
      "{{ProgramFiles}}/Mozilla Firefox/firefox.exe",
      "{{ProgramFilesX86}}/Mozilla Firefox/firefox.exe",
    ],
    linuxCommands: ["firefox"],
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Microsoft Edge",
    winExecutables: [
      "{{ProgramFilesX86}}/Microsoft/Edge/Application/msedge.exe",
      "{{ProgramFiles}}/Microsoft/Edge/Application/msedge.exe",
    ],
    linuxCommands: ["microsoft-edge", "microsoft-edge-stable"],
  },
  {
    id: "brave",
    label: "Brave Browser",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Brave Browser",
    winExecutables: [
      "{{ProgramFiles}}/BraveSoftware/Brave-Browser/Application/brave.exe",
      "{{ProgramFilesX86}}/BraveSoftware/Brave-Browser/Application/brave.exe",
      "{{LocalAppData}}/BraveSoftware/Brave-Browser/Application/brave.exe",
    ],
    linuxCommands: ["brave-browser", "brave"],
  },
  {
    id: "arc",
    label: "Arc",
    platforms: ["darwin", "win32"],
    macAppName: "Arc",
    winExecutables: ["{{LocalAppData}}/Programs/Arc/Arc.exe"],
  },
  {
    id: "chromium",
    label: "Chromium",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Chromium",
    winExecutables: [
      "{{LocalAppData}}/Chromium/Application/chrome.exe",
      "{{ProgramFiles}}/Chromium/Application/chrome.exe",
    ],
    linuxCommands: ["chromium", "chromium-browser"],
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Vivaldi",
    winExecutables: [
      "{{LocalAppData}}/Vivaldi/Application/vivaldi.exe",
      "{{ProgramFiles}}/Vivaldi/Application/vivaldi.exe",
    ],
    linuxCommands: ["vivaldi", "vivaldi-stable"],
  },
  {
    id: "opera",
    label: "Opera",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Opera",
    winExecutables: ["{{LocalAppData}}/Programs/Opera/opera.exe"],
    linuxCommands: ["opera"],
  },
  {
    id: "zen",
    label: "Zen Browser",
    platforms: ["darwin", "win32", "linux"],
    macAppName: "Zen Browser",
    winExecutables: ["{{ProgramFiles}}/Zen Browser/zen.exe"],
    linuxCommands: ["zen-browser", "zen"],
  },
];

export function browserTargetDefinition(target: BrowserTarget) {
  return BROWSER_TARGETS.find((entry) => entry.id === target) ?? null;
}

/** True when `value` names one of the browsers in the catalog. */
export function isBrowserTarget(value: unknown): value is BrowserTarget {
  return typeof value === "string" && BROWSER_TARGETS.some((entry) => entry.id === value);
}

/**
 * One detected browser, as the renderer's menu needs it: what to show, and the
 * app icon to show it with (a data URL, or null when the OS would not hand one
 * over — the row then falls back to a generic glyph).
 */
export type InstalledBrowser = {
  id: BrowserTarget;
  label: string;
  iconDataUrl: string | null;
};
