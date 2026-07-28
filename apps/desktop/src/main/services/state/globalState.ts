import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppWelcomeVideoState, OpenProjectBinding, RecentProjectRemoteRef, RecentlyInstalledUpdate } from "../../../shared/types";
import { projectRefStateKey } from "../../../shared/projectIdentity";
import { sanitizePortableGitRemote } from "../../../shared/crossMachineHandoff";

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
 *
 * Delegates to the shared definition so main, preload, and renderer cannot
 * drift — they previously each had their own copy of this format, which is how
 * the renderer ended up writing its lane cache under one key and reading it
 * back under another.
 */
export function recentProjectKey(
  proj: { rootPath: string; remote?: RecentProjectRemote },
): string {
  return projectRefStateKey(proj);
}

export type PendingInstallUpdate = {
  fromVersion: string;
  targetVersion: string;
  releaseNotesUrl: string | null;
  requestedAt: string;
};

// Consecutive installs of the same version that quit without landing. The
// archive was already checksum-verified before it went "ready", so the first
// failure keeps it and a retry skips re-downloading; a repeat says the archive
// itself is suspect and earns a clean slate.
export type FailedInstallAttempts = {
  targetVersion: string;
  count: number;
  lastFailedAt: string;
};

export type GlobalState = {
  lastProjectRoot?: string;
  lastRemoteProjectBinding?: Extract<OpenProjectBinding, { kind: "remote" }> & {
    updatedAt?: string;
  };
  recentProjects?: RecentProject[];
  pendingInstallUpdate?: PendingInstallUpdate;
  recentlyInstalledUpdate?: RecentlyInstalledUpdate;
  failedInstallAttempts?: FailedInstallAttempts;
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
const REMOTE_PROJECT_ICON_DATA_URL_MAX_BYTES = 128 * 1024;
const REMOTE_PROJECT_ICON_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

// Global state should only store small, already-bounded project icon payloads.
// Callers with full-size remote icons should thumbnail before this boundary.
export function persistableRemoteProjectIconDataUrl(
  value: string | null | undefined,
): string | null {
  const dataUrl = typeof value === "string" ? value.trim() : "";
  if (!dataUrl || !REMOTE_PROJECT_ICON_DATA_URL_RE.test(dataUrl)) return null;
  return Buffer.byteLength(dataUrl, "utf8") <= REMOTE_PROJECT_ICON_DATA_URL_MAX_BYTES
    ? dataUrl
    : null;
}

export function withPersistableRemoteProjectIcon<T extends { iconDataUrl?: string | null }>(
  value: T,
): T {
  const next = { ...value };
  const iconDataUrl = persistableRemoteProjectIconDataUrl(value.iconDataUrl);
  if (iconDataUrl) {
    next.iconDataUrl = iconDataUrl;
  } else {
    delete next.iconDataUrl;
  }
  return next;
}

export function persistableRemoteProjectBinding<
  T extends Extract<OpenProjectBinding, { kind: "remote" }>,
>(value: T): T {
  const next = withPersistableRemoteProjectIcon(value);
  const gitOriginUrl = typeof value.gitOriginUrl === "string" && value.gitOriginUrl.trim()
    ? sanitizePortableGitRemote(value.gitOriginUrl)
    : null;
  if (gitOriginUrl) {
    next.gitOriginUrl = gitOriginUrl;
  } else {
    delete next.gitOriginUrl;
  }
  return next;
}

export function persistableRecentProjectRemote(
  remote: RecentProjectRemote,
): RecentProjectRemote {
  const iconDataUrl = persistableRemoteProjectIconDataUrl(remote.iconDataUrl);
  const gitOriginUrl = typeof remote.gitOriginUrl === "string" && remote.gitOriginUrl.trim()
    ? sanitizePortableGitRemote(remote.gitOriginUrl)
    : null;
  return {
    targetId: remote.targetId,
    projectId: remote.projectId,
    runtimeName: remote.runtimeName,
    hostname: remote.hostname,
    ...(gitOriginUrl ? { gitOriginUrl } : {}),
    ...(iconDataUrl ? { iconDataUrl } : {}),
  };
}

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
  const remote = proj.remote ? persistableRecentProjectRemote(proj.remote) : undefined;
  const nextEntry: RecentProject = {
    rootPath: proj.rootPath,
    displayName: proj.displayName,
    lastOpenedAt: now,
    ...(remote ? { remote } : {}),
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
