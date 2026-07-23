import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  openKvDb,
  rebuildTableInTransaction,
  sweepOrphanedRepairStagingTables,
  type TableRebuildPlan,
} from "./kvDb";
import { isCrsqliteAvailable } from "./crsqliteExtension";

const testRequire = createRequire(import.meta.url);
const { DatabaseSync } = testRequire("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-primary",
      "project-1",
      "Primary",
      null,
      "primary",
      "main",
      "main",
      "/repo/ade",
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      "active",
      now,
      null,
    ],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-child",
      "project-1",
      "linear test",
      null,
      "worktree",
      "main",
      "ade/linear-test",
      "/repo/ade/.ade/worktrees/linear-test",
      null,
      0,
      "lane-primary",
      null,
      null,
      null,
      null,
      "active",
      "2026-03-17T00:05:00.000Z",
      null,
    ],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-primary", 0, 0, 0, 0, 0, null, now],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-child", 1, 0, 1, 0, 0, null, "2026-03-17T00:05:00.000Z"],
  );
}

function insertSessionAndPr(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:10:00.000Z";
  db.run(
    `insert into terminal_sessions(
      id, lane_id, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
      exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
      last_output_at, summary, resume_command
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "session-1",
      "lane-child",
      null,
      1,
      "Ship W5",
      "run-shell",
      0,
      "npm test",
      now,
      null,
      null,
      "/tmp/session-1.log",
      null,
      null,
      "running",
      "Tests starting",
      now,
      null,
      "npm test",
    ],
  );
  db.run(
    `insert into pull_requests(
      id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
      title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
      last_synced_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      "project-1",
      "lane-child",
      "arul",
      "ade",
      42,
      "https://github.com/arul/ade/pull/42",
      "node-42",
      "Fix mobile hydration",
      "open",
      "main",
      "ade/linear-test",
      "pending",
      "requested",
      12,
      4,
      now,
      now,
      now,
    ],
  );
  db.run(
    `insert into pull_request_snapshots(
      pr_id, detail_json, status_json, checks_json, reviews_json, comments_json, files_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      JSON.stringify({
        prId: "pr-1",
        body: "Hydration fix",
        assignees: [],
        author: { login: "arul", avatarUrl: null },
        isDraft: false,
        labels: [],
        requestedReviewers: [],
        milestone: null,
        linkedIssues: [],
      }),
      JSON.stringify({
        prId: "pr-1",
        state: "open",
        checksStatus: "pending",
        reviewStatus: "requested",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      }),
      "[]",
      "[]",
      "[]",
      "[]",
      now,
    ],
  );
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe("openKvDb SQL binding", () => {
  it("binds boolean params and reports unsupported param types with context", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-bind-values-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    db.run("create table if not exists db_value_test(flag integer not null)");
    db.run("insert into db_value_test(flag) values (?)", [true]);
    expect(db.get<{ flag: number }>("select flag from db_value_test limit 1")?.flag).toBe(1);

    expect(() =>
      db.run("insert into db_value_test(flag) values (?)", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=insert into db_value_test/i);
    expect(() =>
      db.get("select flag from db_value_test where flag = ?", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=select flag from db_value_test/i);
    expect(() =>
      db.all("select flag from db_value_test where flag = ?", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=select flag from db_value_test/i);
  });

  it("checkpoints pending writes when flushed", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-flush-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    db.setJson("flush:probe", { ok: true });
    expect(() => db.flushNow()).not.toThrow();
    expect(db.getJson<{ ok: boolean }>("flush:probe")).toEqual({ ok: true });
  });
});

describe("lane_linear_issue_links schema", () => {
  it("does not keep a non-PK unique index that blocks crsql_as_crr", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-linear-issue-links-index-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'index' and name = 'uq_lane_linear_issue_links_role' limit 1",
      ),
    ).toBeNull();
  });
});

describe("session_linear_issues schema", () => {
  it("creates the table with session/lane/issue columns", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-cols-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    const columns = db
      .all<{ name: string }>("pragma table_info('session_linear_issues')")
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      "id",
      "project_id",
      "session_id",
      "lane_id",
      "issue_id",
      "issue_json",
      "role",
      "source",
      "include_in_pr",
      "close_on_merge",
      "evidence_json",
      "created_at",
      "updated_at",
    ]));
  });

  it("carries no non-PK unique index that would block crsql_as_crr", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-index-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    const uniqueIndexes = db.all<{ name: string }>(
      "select name from sqlite_master where type = 'index' and tbl_name = 'session_linear_issues' and sql like '%unique%'",
    );
    expect(uniqueIndexes).toHaveLength(0);
  });
});

describe.skipIf(!isCrsqliteAvailable())("openKvDb CRR repair", () => {
  it("enables CRR on lane_linear_issue_links without a blocking unique index", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-linear-issue-links-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(() => db.get("select crsql_as_crr(?) as ok", ["lane_linear_issue_links"])).not.toThrow();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'lane_linear_issue_links__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("enables CRR on session_linear_issues without a blocking unique index", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(() => db.get("select crsql_as_crr(?) as ok", ["session_linear_issues"])).not.toThrow();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'session_linear_issues__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("keeps composite-key PR AI summary cache local-only", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-ai-summary-local-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pull_request_ai_summaries__crsql_clock' limit 1",
      ),
    ).toBeNull();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pull_request_ai_summaries__crsql_pks' limit 1",
      ),
    ).toBeNull();
  });

  it("removes stale CRR metadata for local-only PR AI summaries", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-ai-summary-crr-cleanup-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    first.run("create table pull_request_ai_summaries__crsql_clock(dummy integer)");
    first.run("create table pull_request_ai_summaries__crsql_pks(dummy integer)");
    first.run(`
      create trigger pull_request_ai_summaries__crsql_utrig
      after update on pull_request_ai_summaries
      begin
        select 1;
      end
    `);
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pull_request_ai_summaries__crsql_clock' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pull_request_ai_summaries__crsql_pks' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'trigger' and name = 'pull_request_ai_summaries__crsql_utrig' limit 1",
      ),
    ).toBeNull();
  });

  it("removes metadata-only CRR rows for local-only PR AI summaries", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-ai-summary-crr-metadata-only-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);
    // Old builds' schema retrofit stripped checked FK constraints from every
    // non-CRR table, so a DB that an older build mis-converted to CRR has the
    // FK-less shape on disk. Recreate that legacy shape here — the current
    // retrofit intentionally no longer rewrites CRR-excluded tables, and
    // crsql_as_crr refuses tables with checked foreign keys.
    first.run("drop table pull_request_ai_summaries");
    first.run(`
      create table pull_request_ai_summaries (
        pr_id text not null,
        head_sha text not null,
        summary_json text not null default '',
        generated_at text not null default '',
        primary key(pr_id, head_sha)
      )
    `);
    first.get("select crsql_as_crr(?)", ["pull_request_ai_summaries"]);
    first.run(
      `insert into pull_request_ai_summaries(pr_id, head_sha, summary_json, generated_at)
       values (?, ?, ?, ?)`,
      ["pr-1", "head-1", "{}", "2026-03-17T00:00:00.000Z"],
    );
    expect(first.get<{ count: number }>("select count(1) as count from crsql_changes where [table] = ?", ["pull_request_ai_summaries"])?.count).toBeGreaterThan(0);
    for (const trigger of first.all<{ name: string }>(
      "select name from sqlite_master where type = 'trigger' and tbl_name = ? and name like ?",
      ["pull_request_ai_summaries", "pull_request_ai_summaries__crsql_%trig"],
    )) {
      first.run(`drop trigger if exists "${trigger.name}"`);
    }
    first.run("drop table pull_request_ai_summaries__crsql_clock");
    first.run("drop table pull_request_ai_summaries__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(
      reopened.get<{ count: number }>(
        "select count(1) as count from crsql_changes where [table] = ?",
        ["pull_request_ai_summaries"],
      )?.count,
    ).toBe(0);
  });

  it("keeps config-snapshot tables (process_definitions/stack_buttons/test_suites) local-only", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-config-snapshot-local-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    for (const table of ["process_definitions", "stack_buttons", "test_suites"]) {
      expect(
        db.get<{ present: number }>(
          `select 1 as present from sqlite_master where type = 'table' and name = '${table}__crsql_clock' limit 1`,
        ),
      ).toBeNull();
      expect(
        db.get<{ present: number }>(
          `select 1 as present from sqlite_master where type = 'trigger' and tbl_name = '${table}' and name like '${table}__crsql_%trig' limit 1`,
        ),
      ).toBeNull();
    }
  });

  it("un-CRRs a previously-converted process_definitions so the snapshot rebuild delete never fires crsql triggers", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-process-defs-crr-cleanup-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);

    // Simulate a DB written by an older build that incorrectly converted the
    // config-snapshot table to a CRR (installs triggers calling
    // crsql_internal_sync_bit + clock/pks shadow tables). Older builds' schema
    // retrofit had rewritten the table with a NOT NULL primary key and no FK
    // lines, so recreate that legacy shape first — the current retrofit
    // intentionally no longer rewrites CRR-excluded tables, and crsql_as_crr
    // refuses nullable primary keys.
    first.run("drop table process_definitions");
    first.run(`
      create table process_definitions (
        id text not null primary key,
        project_id text not null default '',
        key text not null default '',
        name text not null default '',
        command_json text not null default '',
        cwd text not null default '',
        env_json text not null default '',
        autostart integer not null default 0,
        restart_policy text not null default '',
        graceful_shutdown_ms integer not null default 0,
        depends_on_json text not null default '',
        readiness_json text not null default '',
        updated_at text not null default ''
      )
    `);
    first.get("select crsql_as_crr(?)", ["process_definitions"]);
    first.run(
      `insert into process_definitions(
        id, project_id, key, name, command_json, cwd, env_json, autostart,
        restart_policy, graceful_shutdown_ms, depends_on_json, readiness_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "proc-1",
        "project-1",
        "web",
        "Web",
        JSON.stringify(["npm", "run", "dev"]),
        "/repo/ade",
        "{}",
        1,
        "on-failure",
        5000,
        "[]",
        "[]",
        "2026-03-17T00:00:00.000Z",
      ],
    );
    expect(
      first.get<{ count: number }>(
        "select count(1) as count from crsql_changes where [table] = ?",
        ["process_definitions"],
      )?.count,
    ).toBeGreaterThan(0);
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    // CRR metadata is stripped on reopen: no shadow tables, no triggers, no
    // replicated changes — so a crsqlite-less runtime can run the rebuild
    // delete without hitting the missing crsql_internal_sync_bit function.
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'process_definitions__crsql_clock' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'process_definitions__crsql_pks' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'trigger' and tbl_name = 'process_definitions' and name like 'process_definitions__crsql_%trig' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ count: number }>(
        "select count(1) as count from crsql_changes where [table] = ?",
        ["process_definitions"],
      )?.count,
    ).toBe(0);
    expect(() =>
      reopened.run("delete from process_definitions where project_id = ?", ["project-1"]),
    ).not.toThrow();
  });

  it("backfills phone-critical tables whose rows predate CRR enablement", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-pre-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("drop table terminal_sessions__crsql_clock");
    first.run("drop table terminal_sessions__crsql_pks");
    first.run("drop table pull_request_snapshots__crsql_clock");
    first.run("drop table pull_request_snapshots__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots")?.count).toBe(1);
  });

  it("repairs divergent __crsql_pks counts without losing rows or indexes", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-mismatch-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("delete from lanes__crsql_pks where __crsql_key = (select max(__crsql_key) from lanes__crsql_pks)");
    first.run(
      "delete from lane_state_snapshots__crsql_pks where __crsql_key = (select max(__crsql_key) from lane_state_snapshots__crsql_pks)",
    );
    first.run("delete from terminal_sessions__crsql_pks");
    first.run("delete from pull_requests__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from lanes")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lanes__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lane_state_snapshots__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_requests__crsql_pks")?.count).toBe(1);
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'index' and name = 'idx_terminal_sessions_started_at' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("keeps CRR change capture enabled after failed runtime ALTER TABLE", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-crr-alter-failure-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'automation_runs__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);

    const alterSql = "alter table automation_runs add column ade_crr_alter_failure_probe text";
    db.run(alterSql);
    expect(() => db.run(alterSql)).toThrow();

    insertProjectGraph(db);
    const countAutomationRunChanges = () =>
      db.get<{ count: number }>("select count(1) as count from crsql_changes where [table] = ?", ["automation_runs"])
        ?.count ?? 0;
    const changesBeforeInsert = countAutomationRunChanges();
    db.run(
      `insert into automation_runs(
         id, project_id, automation_id, trigger_type, started_at, status, actions_total
       ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        "run-probe",
        "project-1",
        "automation-probe",
        "manual",
        "2026-05-26T00:00:00.000Z",
        "queued",
        0,
      ],
    );

    expect(
      db.get<{ id: string }>("select id from automation_runs where id = ? limit 1", ["run-probe"])?.id,
    ).toBe("run-probe");
    expect(countAutomationRunChanges()).toBeGreaterThan(changesBeforeInsert);
  });
});

describe("rebuildTableInTransaction leftover staging guard", () => {
  it("rebuilds successfully when a leftover __ade_crr_repair_ staging table already exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-guard-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("create table widgets (id integer primary key, payload text not null)");
      const insert = db.prepare("insert into widgets(payload) values (?)");
      for (let i = 0; i < 25; i += 1) insert.run(`payload-${i}`);

      // Simulate the wedge: an aborted/killed rebuild left the staging table
      // behind, populated. Without the inline drop-guard the bare CREATE inside
      // rebuildTableInTransaction throws "table __ade_crr_repair_widgets already
      // exists" and every future repair fails the same way.
      db.exec(
        "create table __ade_crr_repair_widgets (id integer primary key, payload text not null default '')",
      );
      db.exec("insert into __ade_crr_repair_widgets(id, payload) values (999, 'stale')");

      const plan: TableRebuildPlan = {
        tableName: "widgets",
        stagingName: "__ade_crr_repair_widgets",
        createStagingSql:
          'create table "__ade_crr_repair_widgets" (id integer primary key, payload text not null default \'\')',
        columnsSql: '"id", "payload"',
        indexSqlsToRecreate: [],
      };

      expect(() => rebuildTableInTransaction(db, plan)).not.toThrow();

      // Original rows preserved, staging gone, stale orphan row not leaked in.
      expect(db.prepare("select count(*) as count from widgets").get()).toEqual({ count: 25 });
      expect(db.prepare("select count(*) as count from widgets where id = 999").get()).toEqual({ count: 0 });
      expect(
        db.prepare("select 1 from sqlite_master where type = 'table' and name = '__ade_crr_repair_widgets'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepOrphanedRepairStagingTables", () => {
  it("drops non-ambiguous repair orphans and crsql siblings while preserving ambiguous staging", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-sweep-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table alpha (id integer primary key);
        create table __ade_crr_repair_alpha (id integer primary key);
        create table __ade_crr_repair_alpha__crsql_clock (id integer primary key);
        create table __ade_fk_repair_beta (id integer primary key);
        create table gamma (id integer primary key);
        create table __ade_crr_repair_gamma (id integer primary key);
      `);

      // `gamma` is ambiguous (recovery could not classify it) → its staging table
      // must survive; every other repair orphan is swept.
      sweepOrphanedRepairStagingTables(db, new Set(["gamma"]));

      const remaining = db
        .prepare(
          "select name from sqlite_master where type = 'table' and (name like '__ade_crr_repair_%' or name like '__ade_fk_repair_%') order by name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(remaining).toEqual(["__ade_crr_repair_gamma"]);

      // Real tables are untouched.
      expect(db.prepare("select 1 from sqlite_master where name = 'alpha'").get()).toBeTruthy();
      expect(db.prepare("select 1 from sqlite_master where name = 'gamma'").get()).toBeTruthy();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves crsql shadow siblings of an ambiguous staging table while still sweeping non-ambiguous ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-sweep-shadow-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table gamma (id integer primary key);
        create table __ade_crr_repair_gamma (id integer primary key);
        create table __ade_crr_repair_gamma__crsql_clock (id integer primary key);
        create table __ade_crr_repair_gamma__crsql_pks (id integer primary key);
        create table __ade_crr_repair_delta (id integer primary key);
        create table __ade_crr_repair_delta__crsql_clock (id integer primary key);
      `);

      // `gamma` is ambiguous. Its shadow siblings share the `__ade_crr_repair_%`
      // prefix, so a naive sweep would strip the prefix to `gamma__crsql_clock`
      // (not `gamma`), miss the ambiguous check, and drop them — silently
      // breaking the deliberately-preserved base. Non-ambiguous `delta` + its
      // shadow must still be swept.
      sweepOrphanedRepairStagingTables(db, new Set(["gamma"]));

      const remaining = db
        .prepare(
          "select name from sqlite_master where type = 'table' and name like '__ade_%_repair_%' order by name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(remaining).toEqual([
        "__ade_crr_repair_gamma",
        "__ade_crr_repair_gamma__crsql_clock",
        "__ade_crr_repair_gamma__crsql_pks",
      ]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
