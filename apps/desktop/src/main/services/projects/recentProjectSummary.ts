import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { RecentProjectSummary } from "../../../shared/types";

const require = createRequire(__filename);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

type RecentProjectEntry = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
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

function readAdeLaneCount(projectRoot: string): number | null {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!fs.existsSync(dbPath)) return null;

  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(dbPath);
    const hasLanesTable = Boolean(
      db.prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
        .get<{ present?: number }>("lanes")?.present,
    );
    if (!hasLanesTable) return null;

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
    return count > 0 ? count : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function readGitLaneCount(projectRoot: string): number | undefined {
  try {
    const gitPath = path.join(projectRoot, ".git");
    const gitStat = fs.existsSync(gitPath) ? fs.statSync(gitPath) : null;
    if (!gitStat) return undefined;

    let actualGitDir = gitPath;
    if (gitStat.isFile()) {
      // .git file in a worktree checkout — read the gitdir pointer
      const content = fs.readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return 1;
      actualGitDir = path.resolve(projectRoot, match[1]);
    } else if (!gitStat.isDirectory()) {
      return 1;
    }

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

export function toRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  const exists = fs.existsSync(entry.rootPath);
  const laneCount = exists ? (readAdeLaneCount(entry.rootPath) ?? readGitLaneCount(entry.rootPath)) : undefined;

  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    exists,
    laneCount,
  };
}
