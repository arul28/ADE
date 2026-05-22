import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";

const require = createRequire(import.meta.url);

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void };
  close: () => void;
};

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

function isFts4Available(rawDb: RawDb): boolean {
  try {
    rawDb.exec("create virtual table if not exists temp.__ade_fts4_probe using fts4(content)");
    rawDb.exec("drop table if exists temp.__ade_fts4_probe");
    return true;
  } catch {
    return false;
  }
}

describe("kvDb upgrade-path migration", () => {
  it("drops legacy unified_memories FTS4 schema before retrofit passes run", async () => {
    const dbPath = makeDbPath("ade-kvdb-legacy-memory-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    if (!isFts4Available(rawDb)) {
      rawDb.close();
      return;
    }

    const now = "2026-05-22T00:00:00.000Z";
    rawDb.exec(`
      create table projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      insert into projects values ('project-1', '/repo', 'ADE', 'main', '${now}', '${now}');

      create table unified_memories (
        id text primary key,
        project_id text not null,
        scope text not null,
        scope_owner_id text,
        tier integer not null default 2,
        category text not null,
        content text not null,
        importance text not null default 'medium',
        confidence real not null default 1.0,
        observation_count integer not null default 1,
        status text not null default 'promoted',
        source_type text not null default 'agent',
        source_id text,
        source_session_id text,
        source_pack_key text,
        source_run_id text,
        file_scope_pattern text,
        agent_id text,
        pinned integer not null default 0,
        access_score real not null default 0,
        composite_score real not null default 0,
        write_gate_reason text,
        dedupe_key text not null default '',
        created_at text not null,
        updated_at text not null,
        last_accessed_at text not null,
        access_count integer not null default 0,
        promoted_at text
      );
      insert into unified_memories(
        id, project_id, scope, category, content, created_at, updated_at, last_accessed_at
      ) values ('mem-1', 'project-1', 'project', 'note', 'hello', '${now}', '${now}', '${now}');

      create virtual table unified_memories_fts using fts4(
        content,
        content='unified_memories'
      );
      create trigger unified_memories_fts_ai after insert on unified_memories begin
        insert into unified_memories_fts(rowid, content) values (new.rowid, new.content);
      end;
      create trigger unified_memories_fts_au after update on unified_memories begin
        insert into unified_memories_fts(unified_memories_fts, rowid, content) values ('delete', old.rowid, old.content);
        insert into unified_memories_fts(rowid, content) values (new.rowid, new.content);
      end;
      create trigger unified_memories_fts_bd before delete on unified_memories begin
        insert into unified_memories_fts(unified_memories_fts, rowid, content) values ('delete', old.rowid, old.content);
      end;
      create trigger unified_memories_fts_bu before update on unified_memories begin
        insert into unified_memories_fts(unified_memories_fts, rowid, content) values ('delete', old.rowid, old.content);
      end;
    `);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      expect(db.get("select 1 as present from sqlite_master where name = 'unified_memories' limit 1")).toBeNull();
      expect(db.get("select 1 as present from sqlite_master where name = 'unified_memories_fts' limit 1")).toBeNull();
      expect(
        db.get<{ count: number }>(
          "select count(1) as count from sqlite_master where name like 'unified_memories_fts_%'",
        )?.count,
      ).toBe(0);
      expect(db.get<{ count: number }>("select count(1) as count from projects")?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("coalesces duplicate lane_linear_issue_links rows during migrate", async () => {
    const dbPath = makeDbPath("ade-kvdb-linear-links-dedupe-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    const now = "2026-05-22T00:00:00.000Z";
    rawDb.exec(`
      create table projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      insert into projects values ('project-1', '/repo', 'ADE', 'main', '${now}', '${now}');

      create table lane_linear_issue_links (
        id text primary key,
        project_id text not null,
        lane_id text not null,
        issue_id text not null,
        issue_json text not null,
        role text not null,
        source text not null,
        include_in_pr integer not null default 1,
        close_on_merge integer not null default 0,
        created_at text not null,
        updated_at text not null
      );
      insert into lane_linear_issue_links values
        ('link-old', 'project-1', 'lane-1', 'issue-1', '{}', 'primary', 'linear', 1, 0, '${now}', '2026-01-01T00:00:00.000Z'),
        ('link-new', 'project-1', 'lane-1', 'issue-1', '{}', 'primary', 'linear', 1, 0, '${now}', '${now}');
    `);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      expect(db.get<{ count: number }>("select count(1) as count from lane_linear_issue_links")?.count).toBe(1);
      expect(db.get<{ id: string }>("select id from lane_linear_issue_links limit 1")?.id).toBe("link-new");
    } finally {
      db.close();
    }
  });

  it("drops legacy uq_lane_linear_issue_links_role before CRR conversion", async () => {
    const dbPath = makeDbPath("ade-kvdb-linear-links-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    const now = "2026-05-22T00:00:00.000Z";
    rawDb.exec(`
      create table projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      insert into projects values ('project-1', '/repo', 'ADE', 'main', '${now}', '${now}');

      create table lane_linear_issue_links (
        id text primary key,
        project_id text not null,
        lane_id text not null,
        issue_id text not null,
        issue_json text not null,
        role text not null,
        source text not null,
        include_in_pr integer not null default 1,
        close_on_merge integer not null default 0,
        created_at text not null,
        updated_at text not null
      );
      insert into lane_linear_issue_links values
        ('link-1', 'project-1', 'lane-1', 'issue-1', '{}', 'primary', 'linear', 1, 0, '${now}', '${now}');
      create unique index uq_lane_linear_issue_links_role
        on lane_linear_issue_links(project_id, lane_id, issue_id, role);
    `);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger() as any);
    try {
      expect(
        db.get(
          "select 1 as present from sqlite_master where type = 'index' and name = 'uq_lane_linear_issue_links_role' limit 1",
        ),
      ).toBeNull();
      expect(db.get<{ count: number }>("select count(1) as count from lane_linear_issue_links")?.count).toBe(1);
      expect(db.get<{ id: string }>("select id from lane_linear_issue_links limit 1")?.id).toBe("link-1");
    } finally {
      db.close();
    }
  });
});
