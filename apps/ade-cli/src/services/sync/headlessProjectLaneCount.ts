import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { resolveGitMetadataDirectory } from "../../../../desktop/src/main/services/projects/worktreeParent";

// Same cheap cross-project read the roster uses: open each project's
// `.ade/ade.db` read-only with `node:sqlite` — NO cr-sqlite, NO runtime boot —
// so listing the catalog never has to activate every project's scope.
type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => DatabaseSyncType;
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

type LaneCountRow = {
  lane_type: string | null;
  worktree_path: string | null;
  attached_root_path: string | null;
};

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

// Mirrors `laneExistsOnDisk` in the desktop's recentProjectSummary.ts so the
// catalog never advertises lanes whose worktree was deleted out from under ADE.
function laneExistsOnDisk(row: LaneCountRow, projectRoot: string): boolean {
  if ((row.lane_type ?? "").trim() === "primary") {
    return fs.existsSync(projectRoot);
  }
  const candidate = normalizePath(row.worktree_path) ?? normalizePath(row.attached_root_path);
  return candidate ? fs.existsSync(candidate) : false;
}

function hasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db
      .prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get<{ present?: number }>(tableName)?.present,
  );
}

/**
 * Fallback when the DB can't answer, mirroring `readGitLaneCount` in the
 * desktop's recentProjectSummary.ts: the primary lane plus one per registered
 * git worktree. Without it a project whose `.ade/ade.db` is missing, locked, or
 * pre-lanes-schema showed "0 lanes" in the catalog while desktop recents showed
 * the real number for the same project.
 */
function gitLaneCount(projectRoot: string): number | null {
  try {
    const gitDir = resolveGitMetadataDirectory(projectRoot);
    if (!gitDir) return null;
    let count = 1;
    const worktreesPath = path.join(gitDir, "worktrees");
    if (fs.existsSync(worktreesPath)) {
      count += fs
        .readdirSync(worktreesPath, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory()).length;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Lane count for a project the headless brain only knows by path, counted
 * straight off disk (read-only). Inclusive of the primary lane, matching the
 * desktop's recent-projects count so desktop recents and the web/iOS catalog
 * agree on the same number.
 *
 * Never throws: a missing, locked, or schema-shifted DB falls back to the git
 * worktree count, and only a project with no git metadata either reports 0.
 */
function computeHeadlessProjectLaneCount(projectRoot: string): number {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  if (!fs.existsSync(dbPath)) return gitLaneCount(projectRoot) ?? 0;

  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Matches the desktop's `inspectAdeProject` timeout: a shorter one made the
    // headless read give up on a busy DB the desktop would have waited out, and
    // fall back to the coarser git count for no reason.
    db.exec("PRAGMA busy_timeout = 5000");
    if (!hasTable(db, "lanes")) return gitLaneCount(projectRoot) ?? 0;

    const rows = db
      .prepare(
        `
          select lane_type, worktree_path, attached_root_path
          from lanes
          where coalesce(status, 'active') != 'archived'
            and archived_at is null
        `,
      )
      .all<LaneCountRow>();

    let count = 0;
    for (const row of rows) {
      if (laneExistsOnDisk(row, projectRoot)) count += 1;
    }
    // Desktop treats a zero row count as "the DB doesn't know" and falls back to
    // git too (`laneCount: count > 0 ? count : null`); match it exactly or the
    // catalog and recents disagree on the same project.
    return count > 0 ? count : (gitLaneCount(projectRoot) ?? 0);
  } catch {
    return gitLaneCount(projectRoot) ?? 0;
  } finally {
    try {
      db?.close();
    } catch {
      // A throw from `finally` escapes the catch above; swallow it so a failed
      // close can never take down the whole catalog listing.
    }
  }
}

/**
 * Every catalog listing counts lanes for every registered project, and each
 * count is a synchronous SQLite open plus a directory walk on the brain's event
 * loop. A burst of catalog requests (several clients, or one client retrying)
 * re-scanned all of them each time. Memoize per project root for a few seconds:
 * short enough that a lane created in the UI shows up immediately after, long
 * enough that a burst pays for one scan.
 */
const LANE_COUNT_TTL_MS = 5_000;
const laneCountMemo = new Map<string, { value: number; at: number }>();

export function headlessProjectLaneCount(projectRoot: string): number {
  const now = Date.now();
  const cached = laneCountMemo.get(projectRoot);
  if (cached && now - cached.at < LANE_COUNT_TTL_MS) return cached.value;
  const value = computeHeadlessProjectLaneCount(projectRoot);
  laneCountMemo.set(projectRoot, { value, at: now });
  // No timer to keep the process alive: sweep expired entries opportunistically
  // so a long-lived brain can't accumulate roots it will never see again.
  if (laneCountMemo.size > 128) {
    for (const [key, entry] of laneCountMemo) {
      if (now - entry.at >= LANE_COUNT_TTL_MS) laneCountMemo.delete(key);
    }
  }
  return value;
}
