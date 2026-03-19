import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";

const require = createRequire(import.meta.url);

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeDbPath(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(root, ".ade", "kv.sqlite");
}

describe("kvDb sync foundation", () => {
  it("persists a stable local site id and marks CRR tables", async () => {
    const dbPath = makeDbPath("ade-kvdb-sync-site-");
    const db = await openKvDb(dbPath, createLogger() as any);
    const firstSiteId = db.sync.getSiteId();

    expect(firstSiteId).toMatch(/^[0-9a-f]{32}$/);
    expect(
      db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'lanes__crsql_clock' limit 1"
      )?.name
    ).toBe("lanes__crsql_clock");
    expect(
      db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'devices__crsql_clock' limit 1"
      )?.name
    ).toBe("devices__crsql_clock");
    expect(
      db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'sync_cluster_state__crsql_clock' limit 1"
      )?.name
    ).toBe("sync_cluster_state__crsql_clock");
    expect(
      db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'unified_memories_fts__crsql_clock' limit 1"
      )
    ).toBeNull();
    db.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    expect(reopened.sync.getSiteId()).toBe(firstSiteId);
    expect(fs.existsSync(path.join(path.dirname(dbPath), "secrets", "sync-site-id"))).toBe(true);
    reopened.close();
  });

  it("exports and applies CRDT changes across two databases", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-b-"), createLogger() as any);

    db1.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", "/repo/a", "Repo A", "main", "2026-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]
    );
    db1.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
        is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "lane-1",
        "project-1",
        "Lane 1",
        null,
        "worktree",
        "main",
        "feature/sync",
        "/repo/a/.ade/worktrees/lane-1",
        null,
        0,
        null,
        null,
        null,
        null,
        null,
        "active",
        "2026-03-15T00:00:00.000Z",
        null,
      ]
    );

    const changes = db1.sync.exportChangesSince(0);
    expect(changes.length).toBeGreaterThan(0);

    const result = db2.sync.applyChanges(changes);
    expect(result.appliedCount).toBe(changes.length);
    expect(result.touchedTables).toEqual(expect.arrayContaining(["projects", "lanes"]));
    expect(db2.sync.getDbVersion()).toBeGreaterThan(0);
    expect(db2.get<{ name: string }>("select name from lanes where id = ?", ["lane-1"])?.name).toBe("Lane 1");

    db1.close();
    db2.close();
  });

  it("repairs a legacy projects unique constraint before CRR marking", async () => {
    const dbPath = makeDbPath("ade-kvdb-sync-projects-legacy-");
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } };
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table projects (
        id text primary key,
        root_path text not null unique,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
    `);
    rawDb.close();

    const repaired = await openKvDb(dbPath, createLogger() as any);
    const indexes = repaired.all<{ name: string; unique: number; origin: string }>("pragma index_list('projects')");
    expect(indexes.filter((index) => Number(index.unique) === 1 && index.origin !== "pk")).toHaveLength(0);
    expect(
      repaired.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'projects__crsql_clock' limit 1",
      )?.name,
    ).toBe("projects__crsql_clock");
    repaired.close();
  });

  it("reloads crsqlite before rerunning migrations after a legacy repair on a CRR database", async () => {
    const dbPath = makeDbPath("ade-kvdb-sync-projects-crr-repair-");
    const seeded = await openKvDb(dbPath, createLogger() as any);
    seeded.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-crr", "/repo/crr", "Repo CRR", "main", "2026-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"],
    );
    seeded.run(
      `insert into unified_memories(
        id, project_id, scope, scope_owner_id, tier, category, content, importance, confidence, observation_count,
        status, source_type, source_id, source_session_id, source_pack_key, source_run_id, file_scope_pattern,
        agent_id, pinned, access_score, composite_score, write_gate_reason, dedupe_key, created_at, updated_at,
        last_accessed_at, access_count, promoted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "mem-crr",
        "project-crr",
        "project",
        null,
        1,
        "note",
        "legacy repair should keep crsqlite loaded",
        "medium",
        1,
        1,
        "promoted",
        "agent",
        "agent-crr",
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        0,
        null,
        "legacy repair should keep crsqlite loaded",
        "2026-03-15T00:00:00.000Z",
        "2026-03-15T00:00:00.000Z",
        "2026-03-15T00:00:00.000Z",
        0,
        null,
      ],
    );
    seeded.close();

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      alter table projects rename to projects_old;
      create table projects (
        id text primary key,
        root_path text not null unique,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
      select id, root_path, display_name, default_base_ref, created_at, last_opened_at from projects_old;
      drop table projects_old;
    `);
    rawDb.close();

    const repaired = await openKvDb(dbPath, createLogger() as any);
    expect(
      repaired.get<{ count: number }>("select count(*) as count from unified_memories where id = ?", ["mem-crr"])?.count,
    ).toBe(1);
    const indexes = repaired.all<{ name: string; unique: number; origin: string }>("pragma index_list('projects')");
    expect(indexes.filter((index) => Number(index.unique) === 1 && index.origin !== "pk")).toHaveLength(0);
    repaired.close();
  });

  it("rebuilds unified memory FTS after remote changes are applied", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-mem-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-mem-b-"), createLogger() as any);

    db1.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-mem", "/repo/mem", "Repo Memory", "main", "2026-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]
    );
    db1.run(
      `insert into unified_memories(
        id, project_id, scope, scope_owner_id, tier, category, content, importance, confidence, observation_count,
        status, source_type, source_id, source_session_id, source_pack_key, source_run_id, file_scope_pattern,
        agent_id, pinned, access_score, composite_score, write_gate_reason, dedupe_key, created_at, updated_at,
        last_accessed_at, access_count, promoted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "mem-1",
        "project-mem",
        "project",
        null,
        2,
        "note",
        "sync memory guide for ios readiness",
        "medium",
        1,
        1,
        "promoted",
        "agent",
        "agent-1",
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        0,
        null,
        "sync memory guide for ios readiness",
        "2026-03-15T00:00:00.000Z",
        "2026-03-15T00:00:00.000Z",
        "2026-03-15T00:00:00.000Z",
        0,
        null,
      ]
    );

    const result = db2.sync.applyChanges(db1.sync.exportChangesSince(0));
    expect(result.rebuiltFts).toBe(true);

    const match = db2.get<{ count: number }>(
      "select count(*) as count from unified_memories_fts where unified_memories_fts match ?",
      ["ios"]
    );
    expect(Number(match?.count ?? 0)).toBeGreaterThan(0);

    db1.close();
    db2.close();
  });
});
