import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenProjectBinding, RecentlyInstalledUpdate } from "../../../shared/types";

export type RecentProject = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
};

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

export function upsertRecentProject(
  state: GlobalState,
  proj: { rootPath: string; displayName: string },
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
  const nextEntry = { rootPath: proj.rootPath, displayName: proj.displayName, lastOpenedAt: now };
  if (options.preserveRecentOrder === true) {
    const existingIndex = prev.findIndex((p) => p.rootPath === proj.rootPath);
    if (existingIndex >= 0 && existingIndex < 12) {
      const updated = prev.slice(0, 12);
      updated[existingIndex] = nextEntry;
      next.recentProjects = updated;
      return next;
    }
  }
  const filtered = prev.filter((p) => p.rootPath !== proj.rootPath);
  next.recentProjects = [nextEntry, ...filtered].slice(0, 12);
  return next;
}

export function reorderRecentProjects(
  state: GlobalState,
  orderedPaths: string[]
): GlobalState {
  const prev = state.recentProjects ?? [];
  const byPath = new Map(prev.map((p) => [p.rootPath, p]));
  const reordered: RecentProject[] = [];
  for (const rp of orderedPaths) {
    const entry = byPath.get(rp);
    if (entry) {
      reordered.push(entry);
      byPath.delete(rp);
    }
  }
  // Append any entries not in the new order (shouldn't happen, but be safe).
  for (const entry of byPath.values()) {
    reordered.push(entry);
  }
  return { ...state, recentProjects: reordered };
}
