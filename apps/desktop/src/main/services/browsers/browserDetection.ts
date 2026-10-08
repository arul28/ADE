/**
 * Which browsers are installed on this machine, and where.
 *
 * Detection exists for two callers: the launcher, which on Windows has to name
 * an absolute executable because the browser is usually not on `PATH`, and the
 * "Open in ▸" menu, which lists what was found (its icons come from
 * `browserIcons`, a separate concern).
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
  isBrowserTargetPlatform,
  type BrowserTarget,
  type BrowserTargetEntry,
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
export function macApplicationDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim();
  return [
    "/Applications",
    "/System/Applications",
    "/System/Volumes/Preboot/Cryptexes/App/System/Applications",
    ...(home ? [path.join(home, "Applications")] : []),
  ];
}

/**
 * `{{ProgramFiles}}/Google/Chrome/Application/chrome.exe` → a real path, or
 * null when the template needs an environment value this machine does not have.
 *
 * Null rather than an empty substitution on purpose: `{{LocalAppData}}` with no
 * value would leave a drive-rooted relative path (`\Google\Chrome\...`), and
 * `fs.existsSync` resolves that against the current drive root — a file sitting
 * there would be "detected" and then launched. Program Files keeps its real
 * default, because that is an absolute path either way.
 */
function expandWindowsBrowserExecutable(
  template: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const substitutions: ReadonlyArray<[string, string | undefined]> = [
    ["{{ProgramFiles}}", env.ProgramFiles ?? "C:\\Program Files"],
    ["{{ProgramFilesX86}}", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"],
    ["{{LocalAppData}}", env.LOCALAPPDATA],
  ];
  let resolved = template;
  for (const [token, value] of substitutions) {
    if (!resolved.includes(token)) continue;
    if (!value) return null;
    resolved = resolved.split(token).join(value);
  }
  // These are Windows paths by construction; do not let a POSIX host's
  // `path.sep` decide the separator.
  return resolved.split("/").join("\\");
}

export type BrowserDetectionDeps = {
  /** Null on an OS ADE has no browser locations for. */
  platform: BrowserTargetPlatform | null;
  env: NodeJS.ProcessEnv;
  fileExists: (candidate: string) => boolean;
  commandSucceeds: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<boolean>;
};

function defaultDeps(): BrowserDetectionDeps {
  // An OS the catalog has no entries for is a real answer ("nothing is
  // installed"), not a value to cast into the union.
  const platform = isBrowserTargetPlatform(process.platform) ? process.platform : null;
  return {
    platform,
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
  definition: BrowserTargetEntry,
  deps: BrowserDetectionDeps,
  found: Map<BrowserTarget, string>,
): Promise<DetectedBrowser | null> {
  const { platform, env } = deps;
  if (!platform || !definition.platforms.includes(platform)) return null;

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
      if (!candidate) continue;
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

/**
 * The seam tests use, the way `services/editors/editorDetection` exposes one:
 * detection reads the real machine, so the three-OS matrix is only reachable
 * by driving the injected deps directly.
 */
export const _testing = {
  detectBrowsers,
  expandWindowsBrowserExecutable,
  resolveDetectedBrowserCommand,
};
