import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { RecentProjectSummary } from "../../../shared/types";
import type { RecentProjectRemote } from "../state/globalState";
import { resolveGitMetadataDirectory, resolveWorktreeParentRef } from "./worktreeParent";

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => DatabaseSyncType;

const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

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

function hasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db.prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get<{ present?: number }>(tableName)?.present,
  );
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
    db = new DatabaseSync(dbPath, { readOnly: true });
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
    ...(entry.pinned ? { pinned: true } : {}),
  };
}

export function toRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  return inspectRecentProject(entry).summary;
}
