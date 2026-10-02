// Per-lane Electron user-data folders for the dev desktop.
//
// Every dev app used to share one folder (`ade-desktop-dev`). Electron keeps
// its single-instance lock there, so a second dev app (another lane's) lost the
// lock and waited forever: no window, no error. `dev:desktop` now gives each
// lane worktree a folder of its own and marks it, so the folders a lane leaves
// behind can be found and removed when the lane is gone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPidAlive } from "./dev-shared.mjs";

// Twin: the dev folder name in apps/desktop/src/main/desktopUserDataPath.ts.
export const BASE_DEV_USER_DATA_NAME = "ade-desktop-dev";
export const DEV_USER_DATA_MARKER = ".ade-dev-lane.json";
/** A marked folder unused this long is stale even when its worktree remains. */
export const DEV_USER_DATA_IDLE_DAYS = 30;
const DEV_USER_DATA_IDLE_MS = DEV_USER_DATA_IDLE_DAYS * 24 * 60 * 60 * 1000;
/** Machine-local files a new lane folder copies from the shared one, once. */
const SEEDED_FILES = ["ade-state.json"];

/**
 * Electron's `appData` folder, the parent of every `ade-desktop-*` folder.
 * Twin: `resolveElectronAppDataPath` in apps/desktop/src/main/desktopUserDataPath.ts.
 */
export function electronAppDataPath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || path.win32.join(homeDir, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
}

/**
 * The lane name of a worktree under `<project>/.ade/worktrees/<name>`, or null
 * for the primary checkout (which keeps the shared folder).
 */
export function laneSlugForWorktree(worktreeRoot) {
  const parts = path.resolve(worktreeRoot).split(path.sep);
  const index = parts.lastIndexOf("worktrees");
  if (index < 1 || parts[index - 1] !== ".ade" || index !== parts.length - 2) return null;
  const slug = parts[index + 1].toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  // ADE names worktrees `<name>-<first 8 of lane id>`, and long prompt-derived
  // names exist. Keep the tail when trimming, so two lanes never share a folder.
  return slug.length > 80 ? `${slug.slice(0, 71)}-${slug.slice(-8)}` : slug;
}

/** The user-data folder `dev:desktop` uses for a worktree, or null for the shared one. */
export function laneUserDataPath(worktreeRoot, appDataPath = electronAppDataPath()) {
  const slug = laneSlugForWorktree(worktreeRoot);
  return slug ? path.join(appDataPath, `${BASE_DEV_USER_DATA_NAME}-${slug}`) : null;
}

function readMarker(folder) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(folder, DEV_USER_DATA_MARKER), "utf8"));
    return marker && typeof marker.worktreePath === "string" ? marker : null;
  } catch {
    return null;
  }
}

/**
 * Create (first use: seed) the lane's folder and stamp its marker. Returns the
 * folder, or null when the worktree keeps the shared one.
 */
export function prepareLaneUserData(worktreeRoot, { appDataPath = electronAppDataPath(), now = Date.now() } = {}) {
  const folder = laneUserDataPath(worktreeRoot, appDataPath);
  if (!folder) return null;
  const created = !fs.existsSync(folder);
  fs.mkdirSync(folder, { recursive: true });
  if (created) {
    const base = path.join(appDataPath, BASE_DEV_USER_DATA_NAME);
    for (const name of SEEDED_FILES) {
      try {
        fs.copyFileSync(path.join(base, name), path.join(folder, name), fs.constants.COPYFILE_EXCL);
      } catch {
        // Nothing to seed from, or already there: the app starts with defaults.
      }
    }
  }
  const previous = readMarker(folder);
  fs.writeFileSync(
    path.join(folder, DEV_USER_DATA_MARKER),
    `${JSON.stringify({
      worktreePath: path.resolve(worktreeRoot),
      createdAt: previous?.createdAt ?? new Date(now).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
      // The launcher that is about to start an app here. Cleanup leaves the
      // folder alone while it lives, so the gap before Electron takes its lock
      // is covered too.
      launcherPid: process.pid,
    }, null, 2)}\n`,
  );
  return folder;
}

/**
 * Whether an Electron app holds this folder's single-instance lock right now.
 * POSIX: `SingletonLock` is a symlink to `<host>-<pid>`. Windows: `lockfile`
 * is held open, so it cannot be renamed while the app runs.
 */
export function userDataInUse(folder, platform = process.platform) {
  if (platform === "win32") {
    const lock = path.join(folder, "lockfile");
    if (!fs.existsSync(lock)) return false;
    try {
      fs.renameSync(lock, `${lock}.probe`);
      fs.renameSync(`${lock}.probe`, lock);
      return false;
    } catch {
      return true;
    }
  }
  let target;
  try {
    target = fs.readlinkSync(path.join(folder, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number.parseInt(target.slice(target.lastIndexOf("-") + 1), 10);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  return isPidAlive(pid);
}

/** An app holds the folder, or the launcher that marked it is still running. */
function folderBusy(folder, marker) {
  return userDataInUse(folder) || isPidAlive(marker?.launcherPid);
}

/**
 * Why a folder may be removed now, or null. Read fresh each time: cleanup asks
 * again right before it deletes, so a lane that started in between keeps it.
 */
function staleReason(folder, now) {
  const marker = readMarker(folder);
  if (!marker || folderBusy(folder, marker)) return null;
  if (!fs.existsSync(marker.worktreePath)) return "worktree removed";
  const lastUsedMs = Date.parse(marker.lastUsedAt ?? "") || 0;
  return now - lastUsedMs > DEV_USER_DATA_IDLE_MS ? `unused for ${DEV_USER_DATA_IDLE_DAYS}+ days` : null;
}

function folderSizeBytes(folder) {
  let total = 0;
  const stack = [folder];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Vanished while we looked.
        }
      }
    }
  }
  return total;
}

/**
 * Every `ade-desktop-dev-*` folder and why it is (or is not) stale.
 *
 * `stale` is set only for folders this launcher marked: the worktree is gone,
 * or the folder went unused for DEV_USER_DATA_IDLE_DAYS. An unmarked folder (made by hand with
 * ADE_DESKTOP_USER_DATA_PATH) is reported with its age and never called stale.
 */
export function listDevUserDataFolders({ appDataPath = electronAppDataPath(), now = Date.now(), withSize = false } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(appDataPath);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${BASE_DEV_USER_DATA_NAME}-`) && !name.includes(".deleting-"))
    .map((name) => {
      const folder = path.join(appDataPath, name);
      const marker = readMarker(folder);
      let modifiedMs = 0;
      try {
        modifiedMs = fs.statSync(folder).mtimeMs;
      } catch {
        // Unreadable: treated as old.
      }
      const lastUsedMs = Date.parse(marker?.lastUsedAt ?? "") || modifiedMs;
      const inUse = folderBusy(folder, marker);
      const reason = staleReason(folder, now);
      return {
        folder,
        marked: Boolean(marker),
        worktreePath: marker?.worktreePath ?? null,
        lastUsedMs,
        inUse,
        stale: reason !== null,
        reason,
        ...(withSize ? { bytes: folderSizeBytes(folder) } : {}),
      };
    });
}

/** Remove the stale marked folders. Returns what was removed. */
export function pruneStaleDevUserData({ appDataPath = electronAppDataPath(), now = Date.now(), keep = null } = {}) {
  const removed = [];
  for (const entry of listDevUserDataFolders({ appDataPath, now })) {
    if (!entry.stale || (keep && path.resolve(keep) === entry.folder)) continue;
    if (!removeIfStillStale(entry.folder, now)) continue;
    removed.push(entry);
  }
  return removed;
}

/**
 * Remove a folder only if it is still stale at this moment. Another lane may
 * have started on it since the list was read; its launcher stamps the marker
 * first, so the fresh check sees it and the folder stays.
 */
export function removeIfStillStale(folder, now = Date.now()) {
  if (!staleReason(folder, now)) return false;
  return removeFolder(folder);
}

/**
 * Move the folder out of the way in one atomic rename, then delete the copy.
 * A recursive delete can take seconds; a lane starting meanwhile gets a fresh
 * folder instead of a half-deleted one. On Windows the rename fails while an
 * app holds files open, which keeps the folder.
 */
function removeFolder(folder) {
  const doomed = `${folder}.deleting-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(folder, doomed);
  } catch {
    // Left for the next run or `npm run dev:clean-data`.
    return false;
  }
  fs.rmSync(doomed, { recursive: true, force: true });
  return true;
}

/**
 * Remove a folder made by hand (no marker) if no app holds it at this moment.
 * Only `npm run dev:clean-data --include-unmarked` asks for this.
 */
export function removeUnmarkedIfIdle(folder) {
  if (userDataInUse(folder)) return false;
  return removeFolder(folder);
}
