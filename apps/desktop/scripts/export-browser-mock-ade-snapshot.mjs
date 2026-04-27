#!/usr/bin/env node
/**
 * Reads `.ade/ade.db` for a project and writes
 * `src/renderer/browser-mock-ade-snapshot.generated.json` for the Vite-in-browser
 * mock (`window.ade` / browserMock).
 *
 * Usage:
 *   node ./scripts/export-browser-mock-ade-snapshot.mjs [PROJECT_ROOT]
 *   ADE_PROJECT_ROOT=/path/to/repo node ./scripts/export-browser-mock-ade-snapshot.mjs
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_ROOT = path.resolve(__dirname, "../src/renderer");
const OUT_FILE = path.join(
  RENDERER_ROOT,
  "browser-mock-ade-snapshot.generated.json"
);

const projectRoot = path.resolve(
  process.env.ADE_PROJECT_ROOT ?? process.argv[2] ?? process.cwd()
);

const dbPath = path.join(projectRoot, ".ade", "ade.db");

if (!existsSync(dbPath)) {
  console.error(
    `[export-browser-mock-ade] No database at ${dbPath}\n` +
      "Open the project in ADE (Electron) once, or set ADE_PROJECT_ROOT to a repo with .ade/ade.db"
  );
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
db.exec("PRAGMA busy_timeout = 5000");

function hasTable(name) {
  const row = db
    .prepare(
      "select 1 as ok from sqlite_master where type = 'table' and name = ?"
    )
    .get(name);
  return Boolean(row);
}

if (!hasTable("projects") || !hasTable("lanes")) {
  console.error(
    "[export-browser-mock-ade] projects/lanes tables missing; is this a valid ADE database?"
  );
  db.close();
  process.exit(1);
}

const projectRow = db
  .prepare(
    `select id, display_name as displayName, root_path as rootPath, default_base_ref as defaultBaseRef,
            created_at as createdAt, last_opened_at as lastOpenedAt
     from projects
     where root_path = ?
     order by last_opened_at desc, created_at desc
     limit 1`
  )
  .get(projectRoot);

if (!projectRow) {
  console.error(
    `[export-browser-mock-ade] No project row for root_path=${projectRoot}`
  );
  db.close();
  process.exit(1);
}

const projectId = String(projectRow.id);
const hasLaneSnapshots = hasTable("lane_state_snapshots");

const laneStateStmt = hasLaneSnapshots
  ? db.prepare(
      `select dirty, ahead, behind, remote_behind, rebase_in_progress
       from lane_state_snapshots
       where lane_id = ?`
    )
  : null;

const laneRows = db
  .prepare(
    `select id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
            is_edit_protected, parent_lane_id, color, icon, tags_json, folder, mission_id, lane_role,
            status, created_at, archived_at
     from lanes
     where project_id = ?
       and coalesce(status, 'active') != 'archived'
       and archived_at is null
     order by
       case when lane_type = 'primary' then 0 else 1 end,
       created_at asc,
       name asc`
  )
  .all(projectId);

const lanes = laneRows.map((row) => {
  const laneId = String(row.id);
  let st = {
    dirty: false,
    ahead: 0,
    behind: 0,
    remoteBehind: -1,
    rebaseInProgress: false,
  };
  if (laneStateStmt) {
    const snap = laneStateStmt.get(laneId);
    if (snap) {
      st = {
        dirty: Boolean(snap.dirty),
        ahead: snap.ahead ?? 0,
        behind: snap.behind ?? 0,
        remoteBehind: snap.remote_behind ?? -1,
        rebaseInProgress: Boolean(snap.rebase_in_progress),
      };
    }
  }
  let tags = [];
  if (row.tags_json) {
    try {
      const parsed = JSON.parse(String(row.tags_json));
      if (Array.isArray(parsed)) tags = parsed;
    } catch {
      /* ignore */
    }
  }
  return {
    id: laneId,
    name: String(row.name),
    description: row.description,
    laneType: row.lane_type,
    baseRef: String(row.base_ref),
    branchRef: String(row.branch_ref),
    worktreePath: String(row.worktree_path),
    attachedRootPath: row.attached_root_path,
    isEditProtected: Boolean(row.is_edit_protected),
    parentLaneId: row.parent_lane_id,
    color: row.color,
    icon: row.icon,
    tags,
    folder: row.folder,
    missionId: row.mission_id,
    laneRole: row.lane_role,
    status: st,
    createdAt: String(row.created_at),
    archivedAt: row.archived_at,
  };
});

db.close();

const snapshot = {
  version: 1,
  exportedAt: new Date().toISOString(),
  project: {
    id: String(projectRow.id),
    name: String(projectRow.displayName),
    rootPath: String(projectRow.rootPath),
    gitDefaultBranch: String(
      projectRow.defaultBaseRef ?? "main"
    ),
    createdAt: projectRow.createdAt
      ? String(projectRow.createdAt)
      : new Date().toISOString(),
  },
  lanes,
  stripInlineDemo: true,
};

await fs.writeFile(OUT_FILE, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(
  `[export-browser-mock-ade] Wrote ${lanes.length} lanes → ${OUT_FILE}\n` +
    "Restart Vite or refresh the browser. PR/queue demo data is cleared while this file exists (remove it to restore built-in PR mocks)."
);
