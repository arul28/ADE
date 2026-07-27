import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createLaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import { openKvDb } from "./kvDb";
import { isCrsqliteAvailable } from "./crsqliteExtension";

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
  } as any;
}

function listColumnNames(db: Awaited<ReturnType<typeof openKvDb>>, table: string): string[] {
  const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
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

function expectTables(db: Awaited<ReturnType<typeof openKvDb>>, tables: readonly string[]): void {
  for (const table of tables) {
    const hit = db.get<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name = ? limit 1",
      [table],
    );
    expect(hit?.name).toBe(table);
  }
}

function expectIndexes(db: Awaited<ReturnType<typeof openKvDb>>, indexes: readonly string[]): void {
  for (const indexName of indexes) {
    const hit = db.get<{ name: string }>(
      "select name from sqlite_master where type = 'index' and name = ? limit 1",
      [indexName],
    );
    expect(hit?.name).toBe(indexName);
  }
}

describe("kvDb migrations - legacy upgrade paths", () => {
  it("marks pre-integration usage rows local-only when adding the analytics export column", async () => {
    const dbPath = makeDbPath("ade-kvdb-usage-analytics-legacy-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table usage_events (
        id text primary key,
        project_id text not null,
        client_surface text not null,
        action text not null,
        feature text not null,
        session_id text,
        occurred_at text not null
      );
      insert into usage_events values (
        '11111111-1111-4111-8111-111111111111',
        'project-1',
        'desktop',
        'chat.send',
        'chat',
        'session-1',
        '2026-07-12T12:00:00.000Z'
      );
    `);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger());
    try {
      expect(listColumnNames(db, "usage_events")).toContain("analytics_exported_at");
      expect(db.get<{ value: string }>(
        "select analytics_exported_at as value from usage_events where id = ?",
        ["11111111-1111-4111-8111-111111111111"],
      )?.value).toBe("pre_analytics");
    } finally {
      db.close();
    }
  });

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

    const db = await openKvDb(dbPath, createLogger());
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

  it("drops retired execution tables and their terminal sessions on upgrade", async () => {
    const dbPath = makeDbPath("ade-kvdb-retired-execution-");
    const first = await openKvDb(dbPath, createLogger());
    first.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", "/repo", "ADE", "main", "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
    );
    first.run(
      `insert into lanes(id, project_id, name, description, base_ref, branch_ref, worktree_path, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-1", "project-1", "main", "", "main", "main", "/repo", "active", "2026-07-27T00:00:00.000Z"],
    );
    first.run(
      `insert into terminal_sessions(
         id, lane_id, tracked, tool_type, pinned, manually_named, title, started_at,
         transcript_path, status
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["session-1", "lane-1", 1, "run-shell", 0, 0, "Legacy", "2026-07-27T00:00:00.000Z", "/tmp/legacy.log", "completed"],
    );
    first.close();

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table process_definitions (id text primary key);
      create table process_runtime (id text primary key);
      create table process_runs (id text primary key);
      create table stack_buttons (id text primary key);
    `);
    rawDb.close();

    const reopened = await openKvDb(dbPath, createLogger());
    try {
      for (const table of ["process_definitions", "process_runtime", "process_runs", "stack_buttons"]) {
        expect(
          reopened.get("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1", [table]),
        ).toBeNull();
      }
      expect(reopened.get("select 1 as present from terminal_sessions where id = ?", ["session-1"])).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it.skipIf(!isCrsqliteAvailable())("skips primary-key retrofit for tables that already have __crsql_clock companions", async () => {
    const dbPath = makeDbPath("ade-kvdb-pk-retrofit-skip-crr-");
    const first = await openKvDb(dbPath, createLogger());
    first.run("create unique index if not exists temp_ade_pk_retrofit_probe on lanes(project_id, name)");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger());
    try {
      expect(
        reopened.get<{ name: string }>(
          "select name from sqlite_master where type = 'table' and name = 'lanes__crsql_clock' limit 1",
        )?.name,
      ).toBe("lanes__crsql_clock");
      reopened.run("drop index if exists temp_ade_pk_retrofit_probe");
    } finally {
      reopened.close();
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

    const db = await openKvDb(dbPath, createLogger());
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

    const db = await openKvDb(dbPath, createLogger());
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

describe("kvDb migrations - lane worktree lock schema", () => {
  it("repairs legacy lock tables before lane lock upserts run", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-legacy-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table lane_worktree_locks (
        worktree_key text not null,
        worktree_path text not null,
        lane_id text not null,
        owner_kind text not null,
        owner_pr_id text,
        owner_session_id text,
        owner_proposal_id text,
        owner_label text not null,
        token text not null,
        created_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );
    `);
    const insert = rawDb.prepare(`
      insert into lane_worktree_locks (
        worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
        owner_session_id, owner_proposal_id, owner_label, token,
        created_at, heartbeat_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const key = fs.realpathSync.native(worktreePath);
    const expiredAt = "2026-01-01T00:00:00.000Z";
    insert.run(key, key, "lane-old", "conflict_resolution", "pr-old", null, null, "Old stale lock 1", "token-1", expiredAt, expiredAt, expiredAt);
    insert.run(key, key, "lane-old", "conflict_resolution", "pr-old", null, null, "Old stale lock 2", "token-2", expiredAt, expiredAt, expiredAt);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger());
    try {
      expect(
        db.get<{ name: string }>(
          "select name from sqlite_master where type = 'index' and name = 'idx_lane_worktree_locks_worktree_key_unique' limit 1",
        )?.name,
      ).toBe("idx_lane_worktree_locks_worktree_key_unique");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);

      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-new",
        worktreePath,
        ownerKind: "conflict_resolution",
        ownerPrId: "pr-new",
        ownerLabel: "Conflict resolution for PR #123",
      });

      expect(acquired.token).toBeTruthy();
      expect(acquired.lock.worktreeKey).toBe(key);
      expect(acquired.lock.laneId).toBe("lane-new");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("returns the actual number of rows released", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-release-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });

    const db = await openKvDb(dbPath, createLogger());
    try {
      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-1",
        worktreePath,
        ownerKind: "conflict_resolution",
        ownerPrId: "pr-1",
        ownerLabel: "Conflict resolution for PR #1",
      });

      expect(service.release({ ownerKind: "conflict_resolution", ownerPrId: "missing" })).toBe(0);
      expect(service.getActiveForLane("lane-1")).toHaveLength(1);
      expect(service.release({ token: "missing-token" })).toBe(0);
      expect(service.release({ token: acquired.token })).toBe(1);
      expect(service.release({ token: acquired.token })).toBe(0);
    } finally {
      db.close();
    }
  });

  it("clears legacy path_to_merge and pr_issue_resolution locks on open", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-ptm-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    const key = fs.realpathSync.native(worktreePath);
    const now = "2026-06-12T00:00:00.000Z";
    rawDb.exec(`
      create table lane_worktree_locks (
        worktree_key text not null unique,
        worktree_path text not null,
        lane_id text not null,
        owner_kind text not null,
        owner_pr_id text,
        owner_session_id text,
        owner_proposal_id text,
        owner_label text not null,
        token text not null,
        created_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );
    `);
    const insert = rawDb.prepare(`
      insert into lane_worktree_locks (
        worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
        owner_session_id, owner_proposal_id, owner_label, token,
        created_at, heartbeat_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(key, key, "lane-1", "path_to_merge", "pr-1", "session-1", null, "PtM", "token-ptm", now, now, "2099-01-01T00:00:00.000Z");
    insert.run(`${key}-other`, `${key}-other`, "lane-2", "pr_issue_resolution", "pr-2", "session-2", null, "Issue", "token-issue", now, now, "2099-01-01T00:00:00.000Z");
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger());
    try {
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks")?.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("kvDb migrations - worker agent schema", () => {
  it("creates W2 worker tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-workers-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    try {

    const expectedTables = [
      "worker_agents",
      "worker_agent_revisions",
      "worker_agent_cost_events",
      "worker_agent_task_sessions",
      "worker_agent_runs",
    ];

    expectTables(db, expectedTables);

    expect(listColumnNames(db, "worker_agents")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "slug",
        "name",
        "role",
        "reports_to",
        "capabilities_json",
        "status",
        "adapter_type",
        "adapter_config_json",
        "runtime_config_json",
        "budget_monthly_cents",
        "spent_monthly_cents",
        "last_heartbeat_at",
        "created_at",
        "updated_at",
        "deleted_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_revisions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "before_json",
        "after_json",
        "changed_keys_json",
        "had_redactions",
        "actor",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_cost_events")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "run_id",
        "session_id",
        "provider",
        "model_id",
        "input_tokens",
        "output_tokens",
        "cost_cents",
        "estimated",
        "source",
        "occurred_at",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_task_sessions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "adapter_type",
        "task_key",
        "payload_json",
        "cleared_at",
        "created_at",
        "updated_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "status",
        "wakeup_reason",
        "task_key",
        "issue_key",
        "execution_run_id",
        "execution_locked_at",
        "context_json",
        "result_json",
        "error_message",
        "started_at",
        "finished_at",
        "created_at",
        "updated_at",
      ]),
    );

    const expectedIndexes = [
      "idx_worker_agents_project",
      "idx_worker_agents_project_active",
      "idx_worker_agent_revisions_agent",
      "idx_worker_agent_task_sessions_lookup",
      "idx_worker_agent_runs_agent",
      "idx_worker_agent_runs_status",
      "idx_worker_agent_cost_events_agent",
      "idx_worker_agent_cost_events_month",
    ];

    expectIndexes(db, expectedIndexes);
    } finally {
      db.close();
    }
  });
});
