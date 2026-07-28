import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { RecentProjectSummary } from "../../../shared/types";
import type { RecentProjectRemote } from "../state/globalState";
import { hasTable, openReadOnlyDatabase } from "./readOnlySqlite";
import { readOriginRemoteUrlFromGitConfig } from "./repoProjectResolver";
import { resolveGitMetadataDirectory, resolveWorktreeParentRef } from "./worktreeParent";

type RecentProjectEntry = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  remote?: RecentProjectRemote;
  pinned?: boolean;
};

export type RecentProjectInspection = {
  summary: RecentProjectSummary;
  projectId: string | null;
  defaultBaseRef: string | null;
};

type LaneCountRow = {
  lane_type: string | null;
  worktree_path: string | null;
  attached_root_path: string | null;
  status: string | null;
  archived_at: string | null;
};

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

function laneExistsOnDisk(row: LaneCountRow, projectRoot: string): boolean {
  if ((row.lane_type ?? "").trim() === "primary") {
    return fs.existsSync(projectRoot);
  }
  const candidatePath = normalizePath(row.worktree_path) ?? normalizePath(row.attached_root_path);
  return candidatePath ? fs.existsSync(candidatePath) : false;
}

type AdeProjectInspection = {
  projectId: string | null;
  defaultBaseRef: string | null;
  laneCount: number | null;
};

const EMPTY_ADE_PROJECT: AdeProjectInspection = {
  projectId: null,
  defaultBaseRef: null,
  laneCount: null,
};

function inspectAdeProject(projectRoot: string): AdeProjectInspection {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!fs.existsSync(dbPath)) return EMPTY_ADE_PROJECT;

  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const hasProjectsTable = hasTable(db, "projects");
    const hasLanesTable = hasTable(db, "lanes");

    const projectRow = hasProjectsTable
      ? db.prepare(
        `
          select id, default_base_ref as defaultBaseRef
          from projects
          where root_path = ?
          order by last_opened_at desc, created_at desc
          limit 1
        `,
      ).get<{ id?: string; defaultBaseRef?: string | null }>(projectRoot)
        ?? db.prepare(
          `
            select id, default_base_ref as defaultBaseRef
            from projects
            order by last_opened_at desc, created_at desc
            limit 1
          `,
        ).get<{ id?: string; defaultBaseRef?: string | null }>()
      : null;

    const projectId = projectRow?.id ?? null;
    const defaultBaseRef = projectRow?.defaultBaseRef ?? null;

    if (!hasLanesTable) {
      return { projectId, defaultBaseRef, laneCount: null };
    }

    const rows = db.prepare(
      `
        select lane_type, worktree_path, attached_root_path, status, archived_at
        from lanes
        where coalesce(status, 'active') != 'archived'
          and archived_at is null
      `,
    ).all<LaneCountRow>();

    let count = 0;
    for (const row of rows) {
      if (laneExistsOnDisk(row, projectRoot)) count += 1;
    }
    return { projectId, defaultBaseRef, laneCount: count > 0 ? count : null };
  } catch {
    return EMPTY_ADE_PROJECT;
  } finally {
    db?.close();
  }
}

function readGitLaneCount(projectRoot: string): number | undefined {
  try {
    const actualGitDir = resolveGitMetadataDirectory(projectRoot);
    if (!actualGitDir) return undefined;

    let laneCount = 1;
    const worktreesPath = path.join(actualGitDir, "worktrees");
    if (fs.existsSync(worktreesPath)) {
      laneCount += fs.readdirSync(worktreesPath, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .length;
    }
    return laneCount;
  } catch {
    return undefined;
  }
}

/**
 * Undecorates a git-config value: git strips surrounding quotes and honours
 * `\` escapes inside them, and treats an unquoted `;` or `#` as the start of a
 * trailing comment. Leaving either in place corrupts the origin URL, and the
 * origin URL is what decides whether two checkouts are the same repository.
 */
export function cleanGitConfigValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("\"")) {
    let out = "";
    for (let i = 1; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "\\" && i + 1 < trimmed.length) {
        out += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (char === "\"") break;
      out += char;
    }
    return out.trim() || null;
  }
  const commentIdx = trimmed.search(/[;#]/);
  const value = (commentIdx === -1 ? trimmed : trimmed.slice(0, commentIdx)).trim();
  return value || null;
}

/**
 * `origin`'s url from raw git-config text.
 *
 * Section scanning is delegated to the line-based parser the repo resolver
 * already uses, which anchors on whole `[...]` lines (so an indented
 * `  [remote "upstream"]` still ends origin's section) and case-folds the
 * section name. Only value undecoration is added on top.
 */
export function parseGitOriginUrlFromConfig(configText: string): string | null {
  const raw = readOriginRemoteUrlFromGitConfig(configText);
  return raw ? cleanGitConfigValue(raw) : null;
}

/**
 * The directory whose `config` holds a checkout's remotes.
 *
 * A linked worktree's metadata dir contains a `commondir` pointer to the
 * repository-wide Git directory, whose config owns the remotes. Reading that
 * pointer works for ordinary `.git` directories, bare repositories, and
 * separately named Git directories without guessing from path basenames.
 *
 * The path-shape check remains only as a compatibility fallback for incomplete
 * metadata (including older synthetic fixtures). It is deliberately strict: a
 * repo that merely lives under a folder named `worktrees` must not be
 * truncated to that folder's parent, and a submodule nested inside a linked
 * worktree must keep its own config.
 */
export function resolveGitConfigDirectory(gitDir: string): string {
  try {
    const rawCommonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (rawCommonDir) return path.resolve(gitDir, rawCommonDir);
  } catch {
    // Fall through to the legacy path-shape check.
  }

  const parent = path.dirname(gitDir);
  if (path.basename(parent) !== "worktrees") return gitDir;
  const commonGitDir = path.dirname(parent);
  if (path.basename(commonGitDir) !== ".git") return gitDir;
  return commonGitDir;
}

type GitOriginCacheEntry = {
  configPath: string;
  mtimeMs: number;
  url: string | null;
};

// Recents are re-summarized on every focus and every project change. The config
// file is small, but re-reading and re-parsing one per recent on every pass is
// pure waste when it almost never changes — key on its mtime.
const GIT_ORIGIN_CACHE_LIMIT = 256;
const gitOriginCache = new Map<string, GitOriginCacheEntry>();

export function clearGitOriginCacheForTests(): void {
  gitOriginCache.clear();
}

/**
 * Reads `origin` straight out of the repo's git config.
 *
 * This is what lets the top bar join a local checkout and a remote checkout of
 * the same repository into one tab. Deliberately a plain file read rather than
 * `git remote get-url`: spawning `git` once per recent would not be free.
 */
export function readGitOriginUrl(projectRoot: string): string | null {
  try {
    const gitDir = resolveGitMetadataDirectory(projectRoot);
    if (!gitDir) return null;
    const configPath = path.join(resolveGitConfigDirectory(gitDir), "config");

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(configPath).mtimeMs;
    } catch {
      return null;
    }
    const cached = gitOriginCache.get(projectRoot);
    if (cached && cached.configPath === configPath && cached.mtimeMs === mtimeMs) {
      return cached.url;
    }

    const url = parseGitOriginUrlFromConfig(fs.readFileSync(configPath, "utf8"));
    if (gitOriginCache.size >= GIT_ORIGIN_CACHE_LIMIT) gitOriginCache.clear();
    gitOriginCache.set(projectRoot, { configPath, mtimeMs, url });
    return url;
  } catch {
    return null;
  }
}

function remoteRecentSummary(entry: RecentProjectEntry): RecentProjectSummary {
  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    // A remote project always "exists" from the desktop's point of view — its
    // reachability is a live connection concern resolved by the renderer
    // against the remote connection snapshot, not a local-disk check.
    exists: true,
    kind: "remote",
    remote: entry.remote,
    ...(entry.remote?.gitOriginUrl
      ? { gitOriginUrl: entry.remote.gitOriginUrl }
      : {}),
    ...(entry.pinned ? { pinned: true } : {}),
  };
}

export function inspectRecentProject(entry: RecentProjectEntry): RecentProjectInspection {
  if (entry.remote) {
    return {
      summary: remoteRecentSummary(entry),
      projectId: null,
      defaultBaseRef: null,
    };
  }
  const exists = fs.existsSync(entry.rootPath);
  const adeProject = exists ? inspectAdeProject(entry.rootPath) : EMPTY_ADE_PROJECT;
  const laneCount = exists ? (adeProject.laneCount ?? readGitLaneCount(entry.rootPath)) : undefined;
  const worktreeOf = exists ? resolveWorktreeParentRef(entry.rootPath) : null;

  return {
    summary: {
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt,
      exists,
      ...(worktreeOf ? { worktreeOf } : {}),
      laneCount,
      kind: "local",
      ...(exists ? { gitOriginUrl: readGitOriginUrl(entry.rootPath) } : {}),
      ...(entry.pinned ? { pinned: true } : {}),
    },
    projectId: adeProject.projectId,
    defaultBaseRef: adeProject.defaultBaseRef,
  };
}

export function toShallowRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  if (entry.remote) {
    return remoteRecentSummary(entry);
  }
  const exists = fs.existsSync(entry.rootPath);
  const worktreeOf = exists ? resolveWorktreeParentRef(entry.rootPath) : null;
  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    exists,
    ...(worktreeOf ? { worktreeOf } : {}),
    kind: "local",
    // The renderer's tab bar joins local and remote checkouts of one repo on
    // this key, and IPC.projectListRecent serves the tab bar from this shallow
    // path — without it every tab would arrive origin-less and nothing would
    // ever merge. The read is mtime-cached, so it stays cheap on the repeated
    // focus/project-change passes the recents cache already absorbs.
    ...(exists ? { gitOriginUrl: readGitOriginUrl(entry.rootPath) } : {}),
    ...(entry.pinned ? { pinned: true } : {}),
  };
}

export function toRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  return inspectRecentProject(entry).summary;
}
