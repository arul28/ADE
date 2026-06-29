import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppWelcomeVideoState, OpenProjectBinding, RecentProjectRemoteRef, RecentlyInstalledUpdate } from "../../../shared/types";

export type RecentProjectRemote = RecentProjectRemoteRef;

export type RecentProject = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  /** Present iff this recent points at a project on a remote machine. */
  remote?: RecentProjectRemote;
  /** Pinned projects are kept above the recency order and never auto-evicted. */
  pinned?: boolean;
};

/**
 * Stable identity for a recent project. Local projects are keyed by their
 * absolute root path (so a remote path string can never collide with a local
 * one); remote projects are keyed by their owning target + remote project id.
 */
export function recentProjectKey(
  proj: { rootPath: string; remote?: RecentProjectRemote },
): string {
  return proj.remote
    ? `remote:${proj.remote.targetId}:${proj.remote.projectId}`
    : proj.rootPath;
}

export type PendingInstallUpdate = {
  fromVersion: string;
  targetVersion: string;
  releaseNotesUrl: string | null;
  requestedAt: string;
};

export type GlobalState = {
  lastProjectRoot?: string;
  lastRemoteProjectBinding?: Extract<OpenProjectBinding, { kind: "remote" }> & {
    updatedAt?: string;
  };
  recentProjects?: RecentProject[];
  pendingInstallUpdate?: PendingInstallUpdate;
  recentlyInstalledUpdate?: RecentlyInstalledUpdate;
  welcomeVideo?: AppWelcomeVideoState;
};

export function readGlobalState(filePath: string): GlobalState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as GlobalState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeGlobalState(filePath: string, state: GlobalState): void {
  let tempPath: string | null = null;
  let fd: number | null = null;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    fd = fs.openSync(tempPath, "w");
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    tempPath = null;
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best effort across filesystems/platforms.
    }
  } catch {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
    // Non-fatal; global state is a convenience.
  }
}

type UpsertRecentProjectOptions = {
  recordLastProject?: boolean;
  recordRecent?: boolean;
  preserveRecentOrder?: boolean;
};

// Recents are recency-ordered. We keep more than the visible window so a few
// pinned-but-stale projects don't crowd out fresh ones, and pinned entries are
// retained beyond the cap entirely (they are never auto-evicted).
const RECENT_PROJECT_CAP = 24;

export function upsertRecentProject(
  state: GlobalState,
  proj: { rootPath: string; displayName: string; remote?: RecentProjectRemote },
  options: UpsertRecentProjectOptions = {}
): GlobalState {
  const next: GlobalState = { ...state };
  const now = new Date().toISOString();
  if (options.recordLastProject ?? false) {
    next.lastProjectRoot = proj.rootPath;
  } else {
    delete next.lastProjectRoot;
  }
  if (options.recordRecent === false) {
    return next;
  }
  const prev = next.recentProjects ?? [];
  const key = recentProjectKey(proj);
  const existing = prev.find((p) => recentProjectKey(p) === key);
  const nextEntry: RecentProject = {
    rootPath: proj.rootPath,
    displayName: proj.displayName,
    lastOpenedAt: now,
    ...(proj.remote ? { remote: proj.remote } : {}),
    ...(existing?.pinned ? { pinned: true } : {}),
  };
  if (options.preserveRecentOrder === true) {
    const existingIndex = prev.findIndex((p) => recentProjectKey(p) === key);
    if (existingIndex >= 0 && existingIndex < RECENT_PROJECT_CAP) {
      const updated = prev.slice();
      updated[existingIndex] = nextEntry;
      next.recentProjects = updated;
      return next;
    }
  }
  const filtered = prev.filter((p) => recentProjectKey(p) !== key);
  const merged = [nextEntry, ...filtered];
  next.recentProjects = merged.filter((entry, index) => entry.pinned || index < RECENT_PROJECT_CAP);
  return next;
}

export function setRecentProjectPinned(
  state: GlobalState,
  key: string,
  pinned: boolean,
): GlobalState {
  const prev = state.recentProjects ?? [];
  const nextProjects = prev.map((p) =>
    recentProjectKey(p) === key ? { ...p, pinned } : p,
  );
  return { ...state, recentProjects: nextProjects };
}

export function reorderRecentProjects(
  state: GlobalState,
  orderedKeys: string[]
): GlobalState {
  const prev = state.recentProjects ?? [];
  const byKey = new Map(prev.map((p) => [recentProjectKey(p), p]));
  const reordered: RecentProject[] = [];
  for (const key of orderedKeys) {
    const entry = byKey.get(key);
    if (entry) {
      reordered.push(entry);
      byKey.delete(key);
    }
  }
  // Append any entries not in the new order (shouldn't happen, but be safe).
  for (const entry of byKey.values()) {
    reordered.push(entry);
  }
  return { ...state, recentProjects: reordered };
}
