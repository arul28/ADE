/**
 * Detects, and on request fixes, an ADE.app that this user cannot write.
 *
 * Squirrel.Mac decides per update whether to install unprivileged or through
 * a privileged helper: when the running bundle (or the folder holding it) is
 * not writable by the signed-in user, it asks for an administrator password
 * ("ADE is trying to add a new helper tool") and installs as root. The copy it
 * writes is root-owned again, so one install done with admin rights makes every
 * later update prompt, forever. The fix is to give the bundle back to the user:
 * `chown -R <uid>:<gid> /Applications/ADE.app`, run once with admin rights.
 *
 * Cost: the check is a handful of `lstat` + `access` calls on fixed paths at
 * the top of the bundle (never a recursive walk), made only when the renderer
 * asks, then cached until "Check again" or a fix. An update relaunches ADE, so
 * the first read after an update lands is always fresh.
 *
 * This module has no Electron import so it can run under plain Node.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execSystemText } from "../power/systemSleepConfig";
import type {
  AppBundleOwnershipFixResult,
  AppBundleOwnershipStatus,
} from "../../../shared/types/appBundleOwnership";

/** Waits on a person at the macOS password dialog. */
const FIX_TIMEOUT_MS = 120_000;

export type AppBundleOwnershipDeps = {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  /** `process.execPath` of the main process: `<bundle>.app/Contents/MacOS/<exe>`. */
  execPath?: string;
  appVersion?: string | null;
  uid?: number;
  gid?: number;
  execFileText?: typeof execSystemText;
  now?: () => Date;
};

/** The `.app` folder that holds `execPath`, or null when it is not inside one. */
export function resolveAppBundlePath(execPath: string): string | null {
  const macosDir = path.posix.dirname(execPath);
  const contentsDir = path.posix.dirname(macosDir);
  const bundle = path.posix.dirname(contentsDir);
  if (!path.posix.isAbsolute(execPath)) return null;
  if (path.posix.basename(macosDir) !== "MacOS" || path.posix.basename(contentsDir) !== "Contents") return null;
  if (!bundle.endsWith(".app") || bundle === "/.app") return null;
  return bundle;
}

/** POSIX single-quote a string for a command the user pastes into Terminal. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function manualFixCommand(bundlePath: string): string {
  // `id` runs in the user's own shell, so it names the user, not root.
  return `sudo chown -R "$(id -un)":"$(id -gn)" ${shellQuote(bundlePath)}`;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : null;
}

async function writable(target: string): Promise<{ ok: boolean; code: string | null }> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return { ok: true, code: null };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

function ownerLabel(ownerUid: number): string {
  return ownerUid === 0 ? "root" : `another account (uid ${ownerUid})`;
}

export function createAppBundleOwnershipService(deps: AppBundleOwnershipDeps) {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const appVersion = deps.appVersion ?? null;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const gid = deps.gid ?? (typeof process.getgid === "function" ? process.getgid() : -1);
  const run = deps.execFileText ?? execSystemText;
  const now = deps.now ?? (() => new Date());
  let cached: AppBundleOwnershipStatus | null = null;
  let inFlight: Promise<AppBundleOwnershipStatus> | null = null;

  const base = (patch: Partial<AppBundleOwnershipStatus>): AppBundleOwnershipStatus => ({
    state: "not_applicable",
    reason: null,
    bundlePath: null,
    problemPaths: [],
    ownerName: null,
    parentWritable: null,
    manualCommand: null,
    appVersion,
    checkedAt: now().toISOString(),
    ...patch,
  });

  async function check(): Promise<AppBundleOwnershipStatus> {
    if (platform !== "darwin") {
      return base({
        reason: platform === "win32"
          ? "Windows installs ADE for your account only, so updates never need an administrator password."
          : "This check is for the macOS app.",
      });
    }
    if (!deps.isPackaged) return base({ reason: "Development builds are not updated by the macOS updater." });
    const bundlePath = resolveAppBundlePath(execPath);
    if (!bundlePath) return base({ reason: "ADE is not running from an app bundle." });
    if (bundlePath.includes("/AppTranslocation/")) {
      return base({ bundlePath, reason: "macOS is running a quarantined copy of ADE. Move ADE to Applications first." });
    }

    let bundleStat;
    try {
      bundleStat = await fs.lstat(bundlePath);
    } catch {
      return base({ state: "unknown", bundlePath, reason: "ADE couldn't read its own app folder." });
    }
    if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) {
      return base({ state: "unknown", bundlePath, reason: "ADE's app folder is not a regular folder." });
    }

    // The bundle root is what Squirrel tests; the rest are the files an
    // unprivileged install has to replace, sampled at the top of the tree.
    const exeName = path.posix.basename(execPath);
    const samples = [".", "Contents", `Contents/MacOS/${exeName}`, "Contents/Resources", "Contents/Info.plist"];
    const problemPaths: string[] = [];
    for (const relative of samples) {
      const target = relative === "." ? bundlePath : path.posix.join(bundlePath, relative);
      const result = await writable(target);
      if (result.ok) continue;
      if (result.code === "ENOENT") continue;
      if (result.code === "EROFS") {
        return base({ bundlePath, reason: "ADE is running from a read-only disk. Move ADE to Applications first." });
      }
      problemPaths.push(relative);
    }
    const parent = await writable(path.posix.dirname(bundlePath));
    const ownerName = bundleStat.uid !== uid ? ownerLabel(bundleStat.uid) : null;

    if (problemPaths.length === 0) {
      return base({ state: "ok", bundlePath, ownerName, parentWritable: parent.ok });
    }
    return base({
      state: "needs_fix",
      bundlePath,
      problemPaths,
      ownerName,
      parentWritable: parent.ok,
      manualCommand: manualFixCommand(bundlePath),
    });
  }

  async function getStatus(options: { refresh?: boolean } = {}): Promise<AppBundleOwnershipStatus> {
    if (cached && !options.refresh) return cached;
    if (inFlight) return inFlight;
    inFlight = check()
      .then((status) => {
        cached = status;
        return status;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function fix(): Promise<AppBundleOwnershipFixResult> {
    const before = await getStatus({ refresh: true });
    if (before.state !== "needs_fix" || !before.bundlePath) {
      return {
        outcome: "not_applicable",
        message: before.state === "ok" ? "ADE's files already belong to your account." : before.reason ?? "There is nothing to fix here.",
        status: before,
      };
    }
    // Only ever the exact bundle this process runs from, re-derived here rather
    // than trusted from anywhere else.
    const bundlePath = resolveAppBundlePath(execPath);
    if (!bundlePath || bundlePath !== before.bundlePath || !Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
      return { outcome: "failed", message: "ADE couldn't tell which account to give its files to.", status: before };
    }
    // The owner and path reach the shell only through AppleScript's
    // `quoted form of`, as run-handler arguments: nothing is spliced into the
    // script text, so neither can break out of the chown.
    const result = await run(
      "/usr/bin/osascript",
      [
        "-e", "on run argv",
        "-e", 'do shell script "/usr/sbin/chown -R " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) with prompt "ADE wants to give its app files back to your account, so updates stop asking for your password." with administrator privileges',
        "-e", "end run",
        `${uid}:${gid}`,
        bundlePath,
      ],
      FIX_TIMEOUT_MS,
    );
    const after = await getStatus({ refresh: true });
    if (!result.ok) {
      if (/User canceled|\(-128\)/i.test(result.stderr)) {
        return { outcome: "cancelled", message: "You cancelled the password prompt. Nothing was changed.", status: after };
      }
      if (after.state === "ok") return { outcome: "fixed", message: "ADE's files belong to your account again.", status: after };
      return { outcome: "failed", message: "macOS wouldn't change the owner of ADE's files.", status: after };
    }
    if (after.state === "ok") {
      return {
        outcome: "fixed",
        message: after.parentWritable === false
          ? "ADE's files belong to your account again, but your account can't write to the folder ADE is in, so updates may still ask for a password."
          : "ADE's files belong to your account again. Updates won't ask for your password.",
        status: after,
      };
    }
    return { outcome: "still_root_owned", message: "The command ran, but your account still can't change some of ADE's files.", status: after };
  }

  return { getStatus, fix };
}

export type AppBundleOwnershipService = ReturnType<typeof createAppBundleOwnershipService>;
