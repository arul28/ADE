import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveCrsqliteExtensionPath } from "../../../../../desktop/src/main/services/state/crsqliteExtension";
import { hasColumn, hasTable, loadNodeSqlite } from "../../../../../desktop/src/main/services/projects/readOnlySqlite";
import { remapUnderRoot } from "./moveGitLinks";

/**
 * Every column that stores a path under the project. Synced tables first,
 * then the ones that stay on this machine. Free text that merely mentions a
 * path (tool output, summaries) is history and is left alone.
 */
const PATH_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["projects", "root_path"],
  ["lanes", "worktree_path"],
  ["lanes", "attached_root_path"],
  ["terminal_sessions", "transcript_path"],
  ["test_runs", "log_path"],
  ["packs_index", "pack_path"],
  ["pack_versions", "rendered_path"],
  ["files_workspaces", "root_path"],
  ["runtime_processes", "project_root"],
  ["test_suites", "cwd"],
  ["local_worktree_residual_cleanups", "worktree_path"],
  ["local_lane_storage_state", "worktree_path"],
  ["lane_worktree_locks", "worktree_path"],
];

/** `kv` keys that carry the project root (layout state keyed by project). */
const KV_KEY_PREFIXES = ["dock_layout:", "tiling_tree:", "graph_state:"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function projectDatabasePath(root: string): string {
  return path.join(root, ".ade", "ade.db");
}

/**
 * An exact copy of a closed project's database, write-ahead log included.
 * The copy is made page by page through SQLite, never by copying the file,
 * so committed rows still in the log are kept.
 */
export async function snapshotProjectDatabase(sourceDbPath: string, destinationDbPath: string): Promise<void> {
  const { DatabaseSync, backup } = loadNodeSqlite();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${destinationDbPath}${suffix}`, { force: true });
  // Not read-only: a read-only open of a closed WAL database fails, since it
  // cannot create the shared-memory file.
  const source = new DatabaseSync(sourceDbPath);
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    await backup(source, destinationDbPath);
  } finally {
    source.close();
  }
}

function openWithCrsqlite(dbPath: string): DatabaseSyncType {
  const extensionPath = resolveCrsqliteExtensionPath();
  if (!extensionPath) {
    throw new Error("ADE couldn't find its sync extension, so it can't update the project's data.");
  }
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.enableLoadExtension(true);
  db.loadExtension(extensionPath);
  return db;
}

function closeWithCrsqlite(db: DatabaseSyncType): void {
  try {
    db.exec("select crsql_finalize()");
  } catch {
    // not loaded
  }
  db.close();
}

/**
 * Rewrites every stored path from the old root to the final root, in one
 * transaction with the sync extension loaded, so the change syncs to the
 * person's other devices like any edit. Ids are kept: chats, PRs and synced
 * rows stay attached to the same project and lanes.
 */
export function rewriteProjectDatabasePaths(args: {
  dbPath: string;
  oldSpellings: string[];
  finalRoot: string;
}): void {
  const db = openWithCrsqlite(args.dbPath);
  try {
    const projects = db.prepare("select id from projects").all() as Array<{ id: string }>;
    if (projects.length !== 1) {
      throw new Error(`The project's data lists ${projects.length} projects, so ADE won't change it.`);
    }
    db.exec("begin immediate");
    try {
      for (const old of args.oldSpellings) {
        for (const [table, column] of PATH_COLUMNS) {
          if (!hasTable(db, table) || !hasColumn(db, table, column)) continue;
          db.prepare(
            `update "${table}" set "${column}" = ? || substr("${column}", ?)
             where "${column}" = ? or substr("${column}", 1, ?) = ?`,
          ).run(args.finalRoot, old.length + 1, old, old.length + 1, `${old}/`);
        }
      }
      if (hasTable(db, "kv")) {
        // One pass over all spellings, so a key is never rewritten twice.
        const spellings = [...args.oldSpellings].sort((a, b) => b.length - a.length);
        const pattern = new RegExp(`(?:${spellings.map(escapeRegExp).join("|")})(?=$|[/:])`, "gu");
        const rows = db.prepare("select key from kv").all() as Array<{ key: string }>;
        for (const { key } of rows) {
          if (!KV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
          const next = key.replace(pattern, args.finalRoot);
          if (next === key) continue;
          // A synced table: delete then update, never `replace`, so the change
          // reaches other devices as an ordinary delete and an ordinary edit.
          db.prepare("delete from kv where key = ?").run(next);
          db.prepare("update kv set key = ? where key = ?").run(next, key);
        }
      }
      if (hasTable(db, "computer_use_artifacts") && hasColumn(db, "computer_use_artifacts", "metadata_json")) {
        const rows = db.prepare("select rowid as rid, metadata_json as json from computer_use_artifacts").all() as Array<{ rid: number; json: string | null }>;
        for (const row of rows) {
          if (!row.json || !args.oldSpellings.some((spelling) => row.json!.includes(spelling))) continue;
          const next = rewriteJsonPaths(row.json, args.oldSpellings, args.finalRoot, ["absolutePath", "path", "filePath"]);
          if (next === row.json) continue;
          db.prepare("update computer_use_artifacts set metadata_json = ? where rowid = ?").run(next, row.rid);
        }
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  } finally {
    closeWithCrsqlite(db);
  }
}

/** Rewrites string values of the named keys that start with an old root. Returns the input when nothing changes. */
export function rewriteJsonPaths(json: string, oldSpellings: string[], finalRoot: string, keys: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  let changed = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (keys.includes(key) && typeof inner === "string") {
        const remapped = remapUnderRoot(inner, oldSpellings, finalRoot);
        if (remapped !== null) {
          out[key] = remapped;
          changed = true;
          continue;
        }
      }
      out[key] = visit(inner);
    }
    return out;
  };
  const next = visit(parsed);
  return changed ? JSON.stringify(next) : json;
}

export type DatabaseSummary = {
  projectId: string | null;
  projectCount: number;
  lanes: Array<{ id: string; name: string; worktreePath: string; status: string; laneType: string }>;
};

/** Read-only look at a project's database, for the checks and the verification. */
export function readProjectDatabaseSummary(dbPath: string): DatabaseSummary {
  const { DatabaseSync } = loadNodeSqlite();
  let db: DatabaseSyncType;
  try {
    // A read-only open sees rows still in the write-ahead log of an open project.
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("select 1").get();
  } catch {
    // A closed database has no shared-memory file for a read-only open to use.
    // `immutable=1` then reads it without creating files or taking locks; a
    // closed database has no log left to miss.
    db = new DatabaseSync(`file:${encodeURI(dbPath)}?immutable=1`, { readOnly: true });
  }
  try {
    const projects = db.prepare("select id from projects").all() as Array<{ id: string }>;
    const lanes = hasTable(db, "lanes")
      ? (db.prepare(
          "select id, name, coalesce(worktree_path, '') as worktreePath, coalesce(status, '') as status, coalesce(lane_type, '') as laneType from lanes",
        ).all() as DatabaseSummary["lanes"])
      : [];
    return { projectId: projects[0]?.id ?? null, projectCount: projects.length, lanes };
  } finally {
    db.close();
  }
}

/** Problems found in the rewritten copy. Empty means it passed. */
export function verifyProjectDatabase(args: {
  dbPath: string;
  oldSpellings: string[];
  finalRoot: string;
  /** Lanes that live outside the project and keep their paths. */
  outsideLanePaths: string[];
  expectedProjectId: string;
  expectedLaneIds: string[];
}): string[] {
  const problems: string[] = [];
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(args.dbPath, { readOnly: true });
  try {
    const check = db.prepare("pragma quick_check").all() as Array<Record<string, string>>;
    const firstValue = check[0] ? Object.values(check[0])[0] : "missing";
    if (firstValue !== "ok") problems.push(`The copied project data failed SQLite's check: ${firstValue}`);
    const projects = db.prepare("select id from projects").all() as Array<{ id: string }>;
    if (projects.length !== 1 || projects[0]!.id !== args.expectedProjectId) {
      problems.push("The copied project data no longer has exactly the original project.");
    }
    const laneIds = new Set((db.prepare("select id from lanes").all() as Array<{ id: string }>).map((row) => row.id));
    const lost = args.expectedLaneIds.filter((id) => !laneIds.has(id));
    if (lost.length) problems.push(`${lost.length} lane(s) are missing from the copied project data.`);
    // Whatever spelling a row used, every lane must now be inside the new
    // location or be one of the lanes that live outside the project.
    const outside = new Set(args.outsideLanePaths);
    const lanes = db.prepare("select name, coalesce(worktree_path, '') as path from lanes").all() as Array<{ name: string; path: string }>;
    const stray = lanes.filter((lane) =>
      lane.path
      && lane.path !== args.finalRoot
      && !lane.path.startsWith(`${args.finalRoot}/`)
      && !outside.has(lane.path));
    if (stray.length) {
      problems.push(`${stray.length} lane(s) still point outside the new location: ${stray.map((lane) => lane.name).join(", ")}.`);
    }
    for (const [table, column] of PATH_COLUMNS) {
      if (!hasTable(db, table) || !hasColumn(db, table, column)) continue;
      for (const old of args.oldSpellings) {
        const row = db.prepare(
          `select count(*) as n from "${table}" where "${column}" = ? or substr("${column}", 1, ?) = ?`,
        ).get(old, old.length + 1, `${old}/`) as { n: number };
        if (row.n > 0) problems.push(`${row.n} value(s) in ${table}.${column} still name the old location.`);
      }
    }
  } finally {
    db.close();
  }
  return problems;
}
