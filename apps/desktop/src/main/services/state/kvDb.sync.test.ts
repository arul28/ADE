import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";
import { isCrsqliteAvailable } from "./crsqliteExtension";

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

function packedTextPrimaryKey(text: string): { type: "bytes"; base64: string } {
  const textBytes = Buffer.from(text, "utf8");
  return {
    type: "bytes",
    base64: Buffer.concat([Buffer.from([0x01, 0x0b, textBytes.length]), textBytes]).toString("base64"),
  };
}

function syncPrimaryKeyMatchesText(value: unknown, text: string): boolean {
  if (value === text) return true;
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && (value as { type?: unknown }).type === "bytes"
    && "base64" in value
    && (value as { base64?: unknown }).base64 === packedTextPrimaryKey(text).base64,
  );
}

describe.skipIf(!isCrsqliteAvailable())("kvDb sync foundation", () => {
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

  it("normalizes legacy text primary keys before applying remote CRDT changes", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-legacy-pk-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-legacy-pk-b-"), createLogger() as any);

    db1.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-legacy", "/repo/legacy", "Legacy", "main", "2026-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"]
    );
    db1.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
        is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "lane-legacy",
        "project-legacy",
        "Legacy Lane",
        null,
        "worktree",
        "main",
        "feature/legacy",
        "/repo/legacy/.ade/worktrees/lane-legacy",
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

    const legacyChanges = db1.sync.exportChangesSince(0).map((change) => {
      if (change.table === "projects") return { ...change, pk: "project-legacy" };
      if (change.table === "lanes") return { ...change, pk: "lane-legacy" };
      return change;
    });

    expect(() => db2.sync.applyChanges(legacyChanges)).not.toThrow();
    expect(db2.get<{ name: string }>("select name from lanes where id = ?", ["lane-legacy"])?.name).toBe("Legacy Lane");

    db1.close();
    db2.close();
  });

  it("applies CRDT changes for composite primary-key tables", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-composite-pk-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-composite-pk-b-"), createLogger() as any);
    const now = "2026-03-15T00:00:00.000Z";

    db1.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-composite", "/repo/composite", "Composite", "main", now, now],
    );
    db1.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
        is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "lane-composite",
        "project-composite",
        "Composite Lane",
        null,
        "worktree",
        "main",
        "feature/composite",
        "/repo/composite/.ade/worktrees/lane-composite",
        null,
        0,
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

    const baselineChanges = db1.sync.exportChangesSince(0);
    db2.sync.applyChanges(baselineChanges);

    const versionBeforeRuntime = db1.sync.getDbVersion();
    db1.run(
      `insert into process_runtime(project_id, lane_id, process_key, status, readiness, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-composite", "lane-composite", "dev", "running", "ready", "2026-03-15T00:01:00.000Z"],
    );

    const runtimeChanges = db1.sync.exportChangesSince(versionBeforeRuntime);
    expect(runtimeChanges.some((change) => change.table === "process_runtime")).toBe(true);

    const result = db2.sync.applyChanges(runtimeChanges);
    expect(result.appliedCount).toBe(runtimeChanges.length);
    expect(result.touchedTables).toContain("process_runtime");
    expect(
      db2.get<{ status: string }>(
        "select status from process_runtime where project_id = ? and lane_id = ? and process_key = ?",
        ["project-composite", "lane-composite", "dev"],
      )?.status,
    ).toBe("running");

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

  it("does not replicate queue_landing_state overhaul wipe deletes to synced peers", async () => {
    const dbPathA = makeDbPath("ade-kvdb-sync-queue-wipe-a-");
    const dbA = await openKvDb(dbPathA, createLogger() as any);
    const wipeMarker = "queue_landing_state.wiped_for_stacked_overhaul.v1";
    const projectId = "project-queue-wipe";
    const groupId = "group-queue-wipe";
    const queueId = "queue-wipe-1";

    dbA.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      [projectId, "/repo/queue-wipe", "Queue Wipe", "main", "2026-03-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z"],
    );
    dbA.run(
      `insert into pr_groups(id, project_id, group_type, name, auto_rebase, ci_gating, target_branch, created_at)
       values (?, ?, ?, ?, 0, 0, ?, ?)`,
      [groupId, projectId, "stack", "Stack", "main", "2026-03-15T00:00:00.000Z"],
    );
    dbA.run(
      `insert into queue_landing_state(
        id, group_id, project_id, state, entries_json, config_json, current_position, started_at
      ) values (?, ?, ?, ?, ?, ?, 0, ?)`,
      [queueId, groupId, projectId, "active", "[]", "{}", "2026-03-15T00:00:00.000Z"],
    );

    const dbB = await openKvDb(makeDbPath("ade-kvdb-sync-queue-wipe-b-"), createLogger() as any);
    const baselineChanges = dbA.sync.exportChangesSince(0);
    expect(baselineChanges.some((change) => change.table === "queue_landing_state")).toBe(true);
    dbB.sync.applyChanges(baselineChanges);
    expect(
      dbB.get<{ id: string }>("select id from queue_landing_state where id = ?", [queueId])?.id,
    ).toBe(queueId);

    const versionBeforeWipe = dbA.sync.getDbVersion();
    dbA.run("delete from kv where key = ?", [wipeMarker]);
    dbA.close();

    const dbAReopened = await openKvDb(dbPathA, createLogger() as any);
    expect(
      dbAReopened.get<{ id: string }>("select id from queue_landing_state where id = ?", [queueId]),
    ).toBeNull();

    const wipeChanges = dbAReopened.sync.exportChangesSince(versionBeforeWipe);
    expect(wipeChanges.some((change) => change.table === "queue_landing_state")).toBe(false);
    expect(wipeChanges.some((change) => change.table === "kv" && syncPrimaryKeyMatchesText(change.pk, wipeMarker))).toBe(false);

    dbB.sync.applyChanges(wipeChanges);
    expect(
      dbB.get<{ id: string }>("select id from queue_landing_state where id = ?", [queueId])?.id,
    ).toBe(queueId);

    const markerValueBeforeApply = dbB.get<{ value: string }>(
      "select value from kv where key = ?",
      [wipeMarker],
    )?.value ?? null;
    const versionBeforeMarkerApply = dbB.sync.getDbVersion();
    const markerApplyResult = dbB.sync.applyChanges([{
      table: "kv",
      pk: packedTextPrimaryKey(wipeMarker),
      cid: "value",
      val: "remote-marker-should-not-apply",
      col_version: 999,
      db_version: versionBeforeMarkerApply + 1,
      site_id: "f".repeat(32),
      cl: 1,
      seq: 1,
    }]);
    expect(markerApplyResult.appliedCount).toBe(0);
    expect(markerApplyResult.touchedTables).toEqual([]);
    expect(dbB.sync.getDbVersion()).toBe(versionBeforeMarkerApply);
    expect(
      dbB.get<{ value: string }>("select value from kv where key = ?", [wipeMarker])?.value ?? null,
    ).toBe(markerValueBeforeApply);

    dbAReopened.close();
    dbB.close();
  });

  it("continues a bounded export past suppressed rows instead of returning an empty truncated window", async () => {
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-suppressed-scan-"), createLogger() as any);
    const siteId = db.sync.getSiteId();

    // A backlog of own-site kv writes, then a suppression covering all of them.
    for (let index = 0; index < 50; index += 1) {
      db.run("insert into kv(key, value) values (?, ?)", [`suppressed-${index}`, `value-${index}`]);
    }
    db.run(
      `insert into local_crr_change_suppressions(table_name, site_id, through_db_version, created_at)
       values (?, ?, ?, ?)`,
      ["kv", siteId, db.sync.getDbVersion(), "2026-06-10T00:00:00.000Z"],
    );
    // One legitimate change AFTER the suppressed backlog.
    db.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-after-suppression", "/repo/after", "After", "main", "2026-06-10T00:00:00.000Z", "2026-06-10T00:00:00.000Z"],
    );

    // maxRows is small enough that the first scan window holds only suppressed
    // rows. Consumers treat an empty export as "the whole range was scanned"
    // and advance their watermark to the range end, so the export must keep
    // scanning until it surfaces the projects change (or truly exhausts the range).
    const exported = db.sync.exportChangesSince(0, { maxRows: 10 });
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.some((change) => change.table === "projects")).toBe(true);
    expect(exported.some((change) => change.table === "kv")).toBe(false);

    db.close();
  });

  it("ignores CRDT changes for legacy unified_memories tables removed in #329", async () => {
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-mem-skip-"), createLogger() as any);
    const legacyChanges = ["unified_memories", "unified_memories_fts_content"].map((table, index) => ({
      table,
      pk: Buffer.from([0x01, 0x06, 0, 0, 0, 0, 0, index + 1]).toString("base64"),
      cid: "id",
      val: null,
      col_version: 1,
      db_version: index + 1,
      site_id: "a".repeat(32),
      cl: 1,
      seq: index,
    }));

    const beforeVersion = db2.sync.getDbVersion();
    const result = db2.sync.applyChanges(legacyChanges as any);
    expect(result.appliedCount).toBe(0);
    expect(result.touchedTables).toEqual([]);
    expect(db2.sync.getDbVersion()).toBe(beforeVersion);

    db2.close();
  });

  it("rejects CRDT changes for unknown future tables", async () => {
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-future-table-"), createLogger() as any);
    const futureChange = {
      table: "missing_future_table",
      pk: "row-1",
      cid: "name",
      val: "future",
      col_version: 1,
      db_version: 1,
      site_id: "a".repeat(32),
      cl: 1,
      seq: 1,
    };

    const beforeVersion = db2.sync.getDbVersion();
    expect(() => db2.sync.applyChanges([futureChange as any])).toThrow(/unknown_sync_table:missing_future_table/);
    expect(db2.sync.getDbVersion()).toBe(beforeVersion);

    db2.close();
  });

});
