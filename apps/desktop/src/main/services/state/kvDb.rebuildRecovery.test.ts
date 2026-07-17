import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { constrainSqliteMaxPages } from "../../../test/faultInjection";
import {
  classifySqliteOpenError,
  openKvDb,
  openReadonlyDatabase,
  rebuildTableInTransaction,
  recoverInterruptedTableRebuilds,
  type TableRebuildPlan,
} from "./kvDb";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

type LogEntry = { event: string; fields: Record<string, unknown> };

function createLogger(entries: LogEntry[] = []) {
  const record = (event: string, fields: Record<string, unknown> = {}) => entries.push({ event, fields });
  return {
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as any;
}

const activeDisposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (activeDisposers.length > 0) {
    await activeDisposers.pop()?.();
  }
});

function makeDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-rebuild-"));
  activeDisposers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "ade.db");
}

function closeLater(db: { close: () => void }): void {
  activeDisposers.push(() => db.close());
}

function rawTableExists(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(tableName));
}

function rawCount(db: DatabaseSyncType, tableName: string): number {
  return Number((db.prepare(`select count(*) as count from "${tableName}"`).get() as { count: number }).count);
}

function basicRebuildPlan(tableName = "rebuild_source", stagingName = "__ade_crr_repair_rebuild_source"): TableRebuildPlan {
  return {
    tableName,
    stagingName,
    createStagingSql: `create table "${stagingName}" (id integer primary key, payload text not null)`,
    columnsSql: '"id", "payload"',
    indexSqlsToRecreate: [`create index idx_${tableName}_payload on "${tableName}"(payload)`],
  };
}

describe("kvDb transactional table rebuilds", () => {
  it("recovers the automation ingress incident without losing rows or its unique index", async () => {
    const dbPath = makeDbPath();
    const first = await openKvDb(dbPath, createLogger());
    first.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", "/repo", "ADE", "main", "2026-07-12T00:00:00.000Z", "2026-07-12T00:00:00.000Z"],
    );
    first.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      create table automation_ingress_events (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        automation_ids_json text,
        trigger_type text not null,
        event_name text,
        status text not null,
        summary text,
        error_message text,
        cursor text,
        raw_payload_json text,
        received_at text not null,
        foreign key(project_id) references projects(id)
      );
      create unique index idx_automation_ingress_events_project_key
        on automation_ingress_events(project_id, source, event_key);
      create index idx_automation_ingress_events_project_received
        on automation_ingress_events(project_id, received_at desc);
      create table __ade_crr_repair_automation_ingress_events (
        id text not null primary key,
        project_id text not null default '',
        source text not null default '',
        event_key text not null default '',
        automation_ids_json text,
        trigger_type text not null default '',
        event_name text,
        status text not null default '',
        summary text,
        error_message text,
        cursor text,
        raw_payload_json text,
        received_at text not null default ''
      );
      begin;
    `);
    const insert = raw.prepare(`
      insert into automation_ingress_events(
        id, project_id, source, event_key, trigger_type, status, received_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 9_000; index += 1) {
      insert.run(`event-${index}`, "project-1", "github", `key-${index}`, "webhook", "received", "2026-07-12T00:00:00.000Z");
    }
    raw.exec("commit");
    raw.close();

    const reopened = await openKvDb(dbPath, createLogger());
    expect(reopened.get<{ count: number }>("select count(*) as count from automation_ingress_events")?.count).toBe(9_000);
    expect(reopened.get("select 1 from sqlite_master where type = 'table' and name = '__ade_crr_repair_automation_ingress_events'")).toBeNull();
    expect(reopened.get<{ name: string }>("select name from sqlite_master where type = 'index' and name = 'idx_automation_ingress_events_project_key'")?.name)
      .toBe("idx_automation_ingress_events_project_key");
    reopened.close();

    const third = await openKvDb(dbPath, createLogger());
    closeLater(third);
    expect(third.get<{ count: number }>("select count(*) as count from automation_ingress_events")?.count).toBe(9_000);
    expect(third.get("select 1 from sqlite_master where name = '__ade_crr_repair_automation_ingress_events'")).toBeNull();
  });

  it("rolls back a real SQLITE_FULL and succeeds after headroom is restored", () => {
    const dbPath = makeDbPath();
    const raw = new DatabaseSync(dbPath);
    closeLater(raw);
    raw.exec("create table rebuild_source (id integer primary key, payload text not null); begin");
    const insert = raw.prepare("insert into rebuild_source(payload) values (?)");
    const payload = "x".repeat(2_000);
    for (let index = 0; index < 3_000; index += 1) insert.run(`${index}-${payload}`);
    raw.exec("commit");

    const currentPages = Number((raw.prepare("pragma page_count").get() as { page_count: number }).page_count);
    constrainSqliteMaxPages(raw, currentPages + 2);
    expect(() => rebuildTableInTransaction(raw, basicRebuildPlan())).toThrow(/database or disk is full/i);
    expect(rawCount(raw, "rebuild_source")).toBe(3_000);
    expect(rawTableExists(raw, "__ade_crr_repair_rebuild_source")).toBe(false);

    constrainSqliteMaxPages(raw, currentPages * 4);
    rebuildTableInTransaction(raw, basicRebuildPlan());
    expect(rawCount(raw, "rebuild_source")).toBe(3_000);
    expect(rawTableExists(raw, "__ade_crr_repair_rebuild_source")).toBe(false);
  });

  it("rolls back failures at every executed rebuild statement", () => {
    const totalStatements = 7; // begin, create, copy, drop, rename, index, commit
    for (let failAt = 1; failAt <= totalStatements; failAt += 1) {
      const dbPath = makeDbPath();
      const raw = new DatabaseSync(dbPath);
      raw.exec("create table rebuild_source (id integer primary key, payload text not null)");
      const insert = raw.prepare("insert into rebuild_source(payload) values (?)");
      for (let index = 0; index < 20; index += 1) insert.run(`payload-${index}`);

      let statementNumber = 0;
      const injectedRun = ((db: DatabaseSyncType, sql: string) => {
        statementNumber += 1;
        if (statementNumber === failAt) throw new Error(`database or disk is full at statement ${failAt}`);
        return db.prepare(sql).run() as { changes: number };
      }) as any;

      expect(() => rebuildTableInTransaction(raw, basicRebuildPlan(), injectedRun)).toThrow(/disk is full/i);
      expect(rawCount(raw, "rebuild_source")).toBe(20);
      expect(rawTableExists(raw, "__ade_crr_repair_rebuild_source")).toBe(false);

      rebuildTableInTransaction(raw, basicRebuildPlan());
      expect(rawCount(raw, "rebuild_source")).toBe(20);
      expect(rawTableExists(raw, "__ade_crr_repair_rebuild_source")).toBe(false);
      expect(raw.prepare("select name from sqlite_master where type = 'index' and name = 'idx_rebuild_source_payload'").get())
        .toBeTruthy();
      raw.close();
    }
  });
});

describe("kvDb interrupted rebuild recovery", () => {
  it("classifies empty, partial, completed-rename, and ambiguous states while keeping startup alive", async () => {
    const dbPath = makeDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      create table recovery_empty (id integer primary key, value text);
      insert into recovery_empty values (1, 'authoritative');
      create table __ade_crr_repair_recovery_empty (id integer primary key, value text);

      create table recovery_partial (id integer primary key, value text);
      insert into recovery_partial values (1, 'a'), (2, 'b'), (3, 'c');
      create table __ade_fk_repair_recovery_partial (id integer primary key, value text);
      insert into __ade_fk_repair_recovery_partial values (1, 'a'), (2, 'b');

      create table __ade_crr_repair_recovery_renamed (id integer, value text);
      insert into __ade_crr_repair_recovery_renamed values (1, 'preserved');

      create table recovery_ambiguous (id text not null, value text);
      insert into recovery_ambiguous values ('original', 'safe');
      create table __ade_crr_repair_recovery_ambiguous (different_id text, value text);
      insert into __ade_crr_repair_recovery_ambiguous values ('staged', 'uncertain');
    `);
    raw.close();

    const logs: LogEntry[] = [];
    const db = await openKvDb(dbPath, createLogger(logs));
    closeLater(db);

    expect(db.get("select 1 from sqlite_master where name = '__ade_crr_repair_recovery_empty'")).toBeNull();
    expect(db.get("select 1 from sqlite_master where name = '__ade_fk_repair_recovery_partial'")).toBeNull();
    expect(db.get<{ value: string }>("select value from recovery_renamed")?.value).toBe("preserved");
    expect(db.get("select 1 from sqlite_master where name = '__ade_crr_repair_recovery_renamed'")).toBeNull();
    expect(db.get<{ value: string }>("select value from recovery_ambiguous")?.value).toBe("safe");
    expect(db.get<{ value: string }>("select value from __ade_crr_repair_recovery_ambiguous")?.value).toBe("uncertain");

    const actions = logs
      .filter((entry) => entry.event === "db.rebuild_recovery")
      .map((entry) => entry.fields.action);
    expect(actions).toEqual(expect.arrayContaining([
      "dropped_empty_staging",
      "dropped_partial_staging",
      "completed_interrupted_rename",
    ]));
    expect(logs.find((entry) => entry.event === "db.rebuild_recovery_ambiguous")?.fields.table)
      .toBe("recovery_ambiguous");
    expect(logs.find((entry) => entry.event === "db.rebuild_recovery_report")?.fields.ambiguous)
      .toEqual(["recovery_ambiguous"]);

    const ambiguousSql = db.get<{ sql: string }>("select sql from sqlite_master where type = 'table' and name = 'recovery_ambiguous'")?.sql;
    expect(ambiguousSql).not.toMatch(/default/i);
  });

  it("reports the guarded both-missing state", () => {
    const logs: LogEntry[] = [];
    const fakeDb = {
      prepare(sql: string) {
        return {
          all: () => sql.includes("order by name") ? [{ name: "__ade_crr_repair_ghost" }] : [],
          get: () => undefined,
          run: () => ({ changes: 0 }),
        };
      },
    };
    const report = recoverInterruptedTableRebuilds(fakeDb as any, createLogger(logs));
    expect(report).toEqual({
      recovered: [{ table: "ghost", action: "noop_both_missing" }],
      ambiguous: [],
    });
  });

  it("drops a 40-row partial staging table and retains all 100 authoritative rows", async () => {
    const dbPath = makeDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      create table partial_hundred (id integer primary key, value text);
      create table __ade_crr_repair_partial_hundred (id integer primary key, value text);
      begin;
    `);
    const originalInsert = raw.prepare("insert into partial_hundred values (?, ?)");
    const stagingInsert = raw.prepare("insert into __ade_crr_repair_partial_hundred values (?, ?)");
    for (let index = 1; index <= 100; index += 1) {
      originalInsert.run(index, `row-${index}`);
      if (index <= 40) stagingInsert.run(index, `row-${index}`);
    }
    raw.exec("commit");
    raw.close();

    const db = await openKvDb(dbPath, createLogger());
    closeLater(db);
    expect(db.get<{ count: number }>("select count(*) as count from partial_hundred")?.count).toBe(100);
    expect(db.get("select 1 from sqlite_master where name = '__ade_crr_repair_partial_hundred'")).toBeNull();
  });

  it("completes an interrupted drop-then-rename on a migrate()-owned table with its data intact", async () => {
    // Recovery must run BEFORE migrate(): if the crash landed between the old
    // rebuild's `drop table projects` and the staging rename, migrate() would
    // recreate `projects` empty and strand every row in the staging table.
    const dbPath = makeDbPath();
    const first = await openKvDb(dbPath, createLogger());
    first.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      create table __ade_crr_repair_projects (
        id text not null primary key,
        root_path text not null default '',
        display_name text not null default '',
        default_base_ref text not null default '',
        created_at text not null default '',
        last_opened_at text not null default ''
      );
      insert into __ade_crr_repair_projects values
        ('project-1', '/repo/one', 'One', 'main', '2026-01-01', '2026-01-02'),
        ('project-2', '/repo/two', 'Two', 'main', '2026-01-03', '2026-01-04');
      drop table projects;
    `);
    raw.close();

    const reopened = await openKvDb(dbPath, createLogger());
    closeLater(reopened);
    expect(reopened.get<{ count: number }>("select count(*) as count from projects")?.count).toBe(2);
    expect(reopened.get<{ display_name: string }>("select display_name from projects where id = 'project-1'")?.display_name).toBe("One");
    expect(reopened.get("select 1 from sqlite_master where name = '__ade_crr_repair_projects'")).toBeNull();
  });

  it("does not churn the excluded automation ingress table across opens", async () => {
    const dbPath = makeDbPath();
    const first = await openKvDb(dbPath, createLogger());
    first.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      create table automation_ingress_events (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        received_at text not null
      );
      create unique index idx_automation_ingress_events_project_key
        on automation_ingress_events(project_id, source, event_key);
    `);
    const originalSql = (raw.prepare("select sql from sqlite_master where type = 'table' and name = 'automation_ingress_events'").get() as { sql: string }).sql;
    raw.close();

    for (let openNumber = 0; openNumber < 2; openNumber += 1) {
      const db = await openKvDb(dbPath, createLogger());
      expect(db.get<{ sql: string }>("select sql from sqlite_master where type = 'table' and name = 'automation_ingress_events'")?.sql)
        .toBe(originalSql);
      expect(db.get<{ name: string }>("select name from sqlite_master where type = 'index' and name = 'idx_automation_ingress_events_project_key'")?.name)
        .toBe("idx_automation_ingress_events_project_key");
      expect(db.get("select 1 from sqlite_master where name = '__ade_crr_repair_automation_ingress_events'")).toBeNull();
      db.close();
    }
  });
});

describe("kvDb migration backup", () => {
  it("requires headroom, leaves no partial backup, then creates a complete backup", async () => {
    const dbPath = makeDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("create table seed (id integer primary key, value text); insert into seed values (1, 'kept')");
    raw.close();

    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1n, bsize: 1n } as any);
    let openError: unknown;
    try {
      await openKvDb(dbPath, createLogger());
    } catch (error) {
      openError = error;
    }
    expect(classifySqliteOpenError(openError)).toBe("insufficient_headroom");
    expect(fs.existsSync(`${dbPath}.pre-crsqlite-w1.bak`)).toBe(false);
    expect(fs.readdirSync(path.dirname(dbPath)).some((name) => name.includes(".pre-crsqlite-w1.bak.tmp-"))).toBe(false);

    vi.restoreAllMocks();
    const db = await openKvDb(dbPath, createLogger());
    closeLater(db);
    const backupPath = `${dbPath}.pre-crsqlite-w1.bak`;
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);
    const backup = new DatabaseSync(backupPath);
    expect((backup.prepare("pragma integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    expect((backup.prepare("select value from seed where id = 1").get() as { value: string }).value).toBe("kept");
    backup.close();
  });

  it("classifies explicit migration codes, full disks, and corrupt databases", () => {
    expect(classifySqliteOpenError(Object.assign(new Error("custom"), { code: "migration_unknown_state" })))
      .toBe("migration_unknown_state");
    expect(classifySqliteOpenError(new Error("SQLITE_FULL: database or disk is full"))).toBe("disk_full");
    expect(classifySqliteOpenError(new Error("database disk image is malformed"))).toBe("db_integrity");
    expect(classifySqliteOpenError(new Error("surprise"))).toBe("unknown");
  });
});

describe("kvDb storage maintenance", () => {
  it("switches a delete-journal database to WAL with NORMAL synchronous writes", async () => {
    const dbPath = makeDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec("pragma journal_mode = delete; create table seed(id integer primary key, value text)");
    raw.close();

    const readonly = openReadonlyDatabase(dbPath);
    expect((readonly.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    readonly.close();

    const db = await openKvDb(dbPath, createLogger());
    closeLater(db);
    expect(db.get<{ journal_mode: string }>("pragma journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ synchronous: number }>("pragma synchronous")?.synchronous).toBe(1);
  });

  it("reclaims a fragmented file, activates incremental auto-vacuum, and skips a healthy file", async () => {
    const dbPath = makeDbPath();
    const logs: LogEntry[] = [];
    const db = await openKvDb(dbPath, createLogger(logs));
    closeLater(db);
    db.run("create table maintenance_fragmentation(id integer primary key, payload text not null)");
    db.run("begin immediate");
    for (let index = 0; index < 2_000; index += 1) {
      db.run(
        "insert into maintenance_fragmentation(id, payload) values (?, ?)",
        [index, `${index}-${"x".repeat(4_000)}`],
      );
    }
    db.run("commit");
    db.flushNow();
    db.run("delete from maintenance_fragmentation");
    db.flushNow();

    const beforeBytes = fs.statSync(dbPath).size;
    const pageCount = Number(db.get<{ page_count: number }>("pragma page_count")?.page_count ?? 0);
    const freePages = Number(db.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count ?? 0);
    expect(freePages / pageCount).toBeGreaterThan(0.2);

    const result = db.maintenance?.vacuumIfFragmented(0.2);
    expect(result?.skippedReason).toBeNull();
    expect(result?.itemsAffected).toBeGreaterThan(0);
    expect(result?.bytesReclaimed).toBeGreaterThan(0);
    expect(fs.statSync(dbPath).size).toBeLessThan(beforeBytes);
    expect(db.get<{ auto_vacuum: number }>("pragma auto_vacuum")?.auto_vacuum).toBe(2);

    // The first fragmented pass ran a one-time full VACUUM.
    const vacuumModes = () => logs
      .filter((entry) => entry.event === "db.maintenance_vacuum")
      .map((entry) => entry.fields.mode);
    expect(vacuumModes().at(-1)).toBe("full");

    // Re-fragment above the threshold. With incremental auto-vacuum now active,
    // a second fragmented pass must use the bounded incremental path, never a
    // second blocking full VACUUM.
    db.run("begin immediate");
    for (let index = 0; index < 2_000; index += 1) {
      db.run(
        "insert into maintenance_fragmentation(id, payload) values (?, ?)",
        [index, `${index}-${"z".repeat(4_000)}`],
      );
    }
    db.run("commit");
    db.flushNow();
    db.run("delete from maintenance_fragmentation");
    db.flushNow();
    const refragPages = Number(db.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count ?? 0);
    const refragTotal = Number(db.get<{ page_count: number }>("pragma page_count")?.page_count ?? 0);
    expect(refragPages / refragTotal).toBeGreaterThan(0.2);
    const secondFragmented = db.maintenance?.vacuumIfFragmented(0.2);
    expect(secondFragmented?.skippedReason).toBeNull();
    expect(secondFragmented?.itemsAffected).toBeGreaterThan(0);
    expect(vacuumModes().at(-1)).toBe("incremental");
    expect(vacuumModes().filter((mode) => mode === "full")).toHaveLength(1);

    db.run("begin immediate");
    for (let index = 0; index < 256; index += 1) {
      db.run(
        "insert into maintenance_fragmentation(id, payload) values (?, ?)",
        [index, `${index}-${"y".repeat(4_000)}`],
      );
    }
    db.run("commit");
    db.run("delete from maintenance_fragmentation");
    const incrementalFreePages = Number(db.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count ?? 0);
    expect(incrementalFreePages).toBeGreaterThan(0);
    const incrementalResult = db.maintenance?.vacuumIfFragmented(1);
    expect(incrementalResult?.skippedReason).toBeNull();
    expect(incrementalResult?.itemsAffected).toBeGreaterThan(0);

    const healthyPath = makeDbPath();
    const healthy = await openKvDb(healthyPath, createLogger());
    closeLater(healthy);
    const healthyResult = healthy.maintenance?.vacuumIfFragmented(0.9);
    expect(healthyResult).toMatchObject({
      itemsAffected: 0,
      skippedReason: "below_threshold",
    });
    expect(healthy.get<{ auto_vacuum: number }>("pragma auto_vacuum")?.auto_vacuum).toBe(0);
    expect(healthy.maintenance?.vacuumIfFragmented(Number.NaN)).toEqual({
      itemsAffected: 0,
      bytesReclaimed: 0,
      skippedReason: "unsupported",
    });
  });

  it("gates CRR tombstone compaction on peer state", async () => {
    const pairedPath = makeDbPath();
    const paired = await openKvDb(pairedPath, createLogger(), { hasSyncPeers: () => true });
    closeLater(paired);
    expect(paired.maintenance?.compactCrsqlTombstones()).toEqual({
      itemsAffected: 0,
      bytesReclaimed: 0,
      skippedReason: "has_peers",
    });
  });

  it.skipIf(process.platform === "linux")("compacts CRR tombstones with no peers and preserves operations byte-for-byte", async () => {
    const dbPath = makeDbPath();
    const db = await openKvDb(dbPath, createLogger(), { hasSyncPeers: () => false });
    closeLater(db);
    expect(db.sync.isAvailable?.(), "cr-sqlite must be available for the compaction contract test").toBe(true);

    const now = "2026-07-17T12:00:00.000Z";
    db.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-maintenance", "/repo/maintenance", "Maintenance", "main", now, now],
    );
    db.run("begin immediate");
    for (let index = 0; index < 250; index += 1) {
      db.run(
        `insert into operations(
          id, project_id, lane_id, kind, started_at, ended_at, status,
          pre_head_sha, post_head_sha, metadata_json
        ) values (?, 'project-maintenance', null, 'test', ?, ?, 'succeeded', null, null, ?)`,
        [`operation-${index}`, now, now, JSON.stringify({ index, payload: "x".repeat(1_000) })],
      );
    }
    db.run("commit");
    db.run("delete from operations where id not in (select id from operations order by id desc limit 10)");

    const before = db.all<Record<string, unknown>>("select * from operations order by id");
    const shadowRowsBefore = Number(db.get<{ count: number }>(
      `select
         (select count(*) from operations__crsql_pks)
         + (select count(*) from operations__crsql_clock) as count`,
    )?.count ?? 0);
    expect(shadowRowsBefore).toBeGreaterThan(before.length);

    const result = db.maintenance?.compactCrsqlTombstones();
    expect(result?.skippedReason).toBeNull();
    expect(result?.itemsAffected).toBeGreaterThan(0);
    expect(db.all<Record<string, unknown>>("select * from operations order by id")).toEqual(before);
    const shadowRowsAfter = Number(db.get<{ count: number }>(
      `select
         (select count(*) from operations__crsql_pks)
         + (select count(*) from operations__crsql_clock) as count`,
    )?.count ?? 0);
    expect(shadowRowsAfter).toBeLessThan(shadowRowsBefore);
  });
});
