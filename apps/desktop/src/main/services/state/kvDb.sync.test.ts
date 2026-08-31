import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE } from "../../../shared/types/sync";
import { createPluginDataStore } from "../plugins/pluginDataStore";
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

  it("exports a compact current-state reseed that converges an existing replica", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-reseed-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-reseed-b-"), createLogger() as any);

    db1.run("insert into kv(key, value) values (?, ?)", ["reseed-key", "version-1"]);
    db2.sync.applyChanges(db1.sync.exportChangesSince(0));
    db1.run("update kv set value = ? where key = ?", ["version-2", "reseed-key"]);
    db1.run("update kv set value = ? where key = ?", ["version-3", "reseed-key"]);

    const reseed = db1.sync.exportChangesSince(0);
    const reseedKeyChanges = reseed.filter((change) =>
      change.table === "kv" && syncPrimaryKeyMatchesText(change.pk, "reseed-key")
    );
    expect(reseedKeyChanges).toHaveLength(1);
    expect(reseedKeyChanges[0]?.val).toBe("version-3");

    db2.sync.applyChanges(reseed);
    expect(db2.get<{ value: string }>("select value from kv where key = ?", ["reseed-key"])?.value).toBe("version-3");

    db1.run("delete from kv where key = ?", ["reseed-key"]);
    const deletionReseed = db1.sync.exportChangesSince(0);
    const deletion = deletionReseed.find((change) =>
      change.table === "kv" && syncPrimaryKeyMatchesText(change.pk, "reseed-key")
    );
    expect(deletion?.cid).toBe("-1");
    db2.sync.applyChanges(deletionReseed);
    expect(db2.get("select value from kv where key = ?", ["reseed-key"])).toBeNull();

    db1.close();
    db2.close();
  });

  it("bounds compact exports before materializing excluded tables or oversized version groups", async () => {
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-reseed-bounds-"), createLogger() as any);

    db.run("begin immediate");
    for (let index = 0; index < 20; index += 1) {
      db.run("insert into kv(key, value) values (?, ?)", [`bounded-${index}`, `value-${index}`]);
    }
    db.run("commit");

    expect(db.sync.exportChangesSince(0, {
      maxRows: 10,
      excludeTables: ["kv"],
      rejectOversizedVersionGroup: true,
    }).some((change) => change.table === "kv")).toBe(false);

    let exportError: unknown = null;
    try {
      db.sync.exportChangesSince(0, {
        maxRows: 10,
        rejectOversizedVersionGroup: true,
      });
    } catch (error) {
      exportError = error;
    }
    expect((exportError as { code?: unknown } | null)?.code).toBe(
      CRSQL_EXPORT_VERSION_GROUP_TOO_LARGE_CODE,
    );

    db.close();
  });

  it("exports one table subset, finds its version floor, and remembers a peer's plugin watermark", async () => {
    // The three primitives the host's plugin catch-up is built on. It has to
    // ship rows for four named tables out of a backlog whose cursor has already
    // moved past them, which needs an INCLUDE filter; it has to skip the
    // (usually enormous) prefix before the first plugin row, which needs the
    // clock floor because `crsql_changes` does not push a table predicate down;
    // and it has to remember what it sent so a phone that reconnects all day is
    // swept once.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-plugin-catchup-"), createLogger() as any);

    db.run("begin immediate");
    for (let index = 0; index < 5; index += 1) {
      db.run("insert into kv(key, value) values (?, ?)", [`before-${index}`, `value-${index}`]);
    }
    db.run("commit");
    const beforePluginRows = db.sync.getDbVersion();

    db.run(
      `insert into plugin_panels(plugin_id, panel_id, title, icon, surface, schema_json, vocab_version, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["hn", "stories", "Top", "", "work", '{"mobile":true}', 1, "2026-08-28T00:00:00.000Z"],
    );
    db.run("insert into kv(key, value) values (?, ?)", ["after", "value-after"]);

    const pluginOnly = db.sync.exportChangesSince(0, { includeTables: ["plugin_panels"] });
    expect(pluginOnly.length).toBeGreaterThan(0);
    expect(pluginOnly.every((change) => change.table === "plugin_panels")).toBe(true);

    // An empty include list is "nothing", never "no filter" — the dangerous
    // reading would send a whole backlog to a peer that asked for one table.
    expect(db.sync.exportChangesSince(0, { includeTables: [] })).toEqual([]);

    // Both filters compose: exclude wins over include for the same table.
    expect(db.sync.exportChangesSince(0, {
      includeTables: ["plugin_panels"],
      excludeTables: ["plugin_panels"],
    })).toEqual([]);

    const floor = db.sync.minDbVersionForTables(["plugin_panels", "plugin_collections"]);
    expect(floor).not.toBeNull();
    expect(floor as number).toBeGreaterThan(beforePluginRows);
    // A table nobody has written to has no floor, which is what tells the host
    // there is nothing to sweep at all.
    expect(db.sync.minDbVersionForTables(["plugin_collections"])).toBeNull();
    expect(db.sync.minDbVersionForTables(["not_a_table_here"])).toBeNull();

    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(0);
    db.sync.setPluginTablesWatermark("phone-1", 42);
    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(42);
    // Monotonic: a later, lower claim must not un-send rows already sent.
    db.sync.setPluginTablesWatermark("phone-1", 7);
    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(42);
    expect(db.sync.getPluginTablesWatermark("phone-2")).toBe(0);
    // The one exception to monotonic, and the only repair for a watermark
    // stamped from a foreign version space: the sync host resets such a row to
    // 0 so the device is swept again (bug A3). Monotonic writes cannot undo it.
    db.sync.setPluginTablesWatermark("phone-1", 0, { allowRegression: true });
    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(0);
    db.sync.setPluginTablesWatermark("phone-1", 9);
    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(9);

    // Local-only: the watermark describes this host's own link, so it must
    // never appear in a changeset bound for a peer.
    expect(db.sync.exportChangesSince(0).some(
      (change) => change.table === "sync_peer_plugin_watermarks",
    )).toBe(false);

    db.close();
  });

  it("keeps plugin writes replicable when the data store creates the tables itself", async () => {
    // The dogfood P0, reduced to its mechanism. `createPluginDataStore` creates
    // the three plugin tables itself because it "runs against a database whose
    // migration predates the plugin platform" (PLUGIN_TABLE_DDL's own comment).
    // `ensureCrrTables` runs ONCE, inside `openKvDb`, so a table born after that
    // is a plain SQLite table: writes to it never enter `crsql_changes`, and no
    // export path — ordinary, reseed, or `sendPluginTablesCatchUp` — can see a
    // row that is not in the change log. The phone then receives nothing, for
    // ever, while every write on the machine appears to succeed.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-plugin-plain-"), createLogger() as any);

    // Model the pre-plugin-platform database: the tables the data store has to
    // create are absent, along with the CRR metadata `openKvDb` gave them.
    for (const table of ["plugin_collections", "plugin_contributions", "plugin_panels"]) {
      db.run(`drop table if exists "${table}"`);
      db.run(`drop table if exists "${table}__crsql_clock"`);
      db.run(`drop table if exists "${table}__crsql_pks"`);
    }

    const store = createPluginDataStore({ db });
    store.putCollection("decision-log", "decisions", "d1", { state: "open" });

    expect(db.get<{ count: number }>("select count(*) as count from plugin_collections")?.count).toBe(1);
    // The row is on the machine. The question the phone cares about is whether
    // it is on the WIRE.
    const exported = db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] });
    expect(exported.length).toBeGreaterThan(0);
    expect(db.sync.minDbVersionForTables(["plugin_collections"])).not.toBeNull();

    // A delete has to reach the phone too — that is what makes uninstall's
    // promise ("deletes its synced copies on your other devices") true. A
    // cr-sqlite delete is a sentinel row, not an absence, so it exports.
    store.deleteCollection("decision-log", "decisions", "d1");
    const afterDelete = db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] });
    expect(afterDelete.some((change) => change.cid === "-1")).toBe(true);

    db.close();
  });

  it("never lets a local-only CRR reach a changeset", async () => {
    // `plugin_wire_meter_daily` is local-only by declaration, and a database
    // converted by a build that predates that declaration still has live clock
    // tables for it — the dogfood machine's does. Shipping one of its rows does
    // not merely leak a stale number: a desktop peer whose schema lacks the
    // table throws `unknown_sync_table` inside applyChanges, rolls the batch
    // back, and never advances its cursor again.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-local-only-"), createLogger() as any);
    // Force the pre-declaration shape: a local-only table that IS a CRR.
    db.run(`drop table if exists "plugin_wire_meter_daily__crsql_clock"`);
    db.run(`drop table if exists "plugin_wire_meter_daily__crsql_pks"`);
    db.get<{ ok: number }>("select crsql_as_crr(?) as ok", ["plugin_wire_meter_daily"]);
    db.run(
      `insert into plugin_wire_meter_daily(day, plugin_id, direction, bytes, frames)
       values (?, ?, ?, ?, ?)`,
      ["2026-08-30", "decision-log", "outbound", 1024, 4],
    );

    // It is in the local change log — this machine's own bookkeeping — and in
    // no changeset bound anywhere.
    expect(
      db.get<{ count: number }>(
        "select count(*) as count from plugin_wire_meter_daily__crsql_clock",
      )?.count,
    ).toBeGreaterThan(0);
    expect(db.sync.exportChangesSince(0).some((change) => change.table === "plugin_wire_meter_daily")).toBe(false);
    expect(db.sync.exportChangesSince(0, { includeTables: ["plugin_wire_meter_daily"] })).toEqual([]);

    db.close();
  });

  it("puts rows a plain plugin table already collected back on the wire", async () => {
    // The repair half. A database that ran the broken build has real rows in a
    // plain `plugin_collections` and nothing in `crsql_changes` for them, so
    // preventing new losses is not enough — those rows are on the machine and on
    // no other device. `crsql_as_crr` backfills what a table already holds, so
    // the registration that closes the hole also empties it.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-plugin-backfill-"), createLogger() as any);
    db.run(`drop table if exists "plugin_collections"`);
    db.run(`drop table if exists "plugin_collections__crsql_clock"`);
    db.run(`drop table if exists "plugin_collections__crsql_pks"`);
    db.run(`create table plugin_collections (
      plugin_id text not null,
      collection text not null,
      key text not null,
      value_json text not null default 'null',
      updated_at text not null default '',
      primary key (plugin_id, collection, key)
    )`);
    db.run(
      "insert into plugin_collections(plugin_id, collection, key, value_json, updated_at) values (?, ?, ?, ?, ?)",
      ["decision-log", "decisions", "d1", '{"state":"open"}', "2026-08-30T00:00:00.000Z"],
    );
    expect(db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] })).toEqual([]);

    createPluginDataStore({ db });

    const exported = db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] });
    expect(exported.length).toBeGreaterThan(0);
    db.close();
  });

  it("repairs a registered plugin table whose clock lost every row", async () => {
    // The other shape of the same damage: the table IS a CRR and holds rows,
    // but its clock is empty, so nothing about those rows is exportable.
    // Re-running `crsql_as_crr` cannot fix this (cr-sqlite already considers
    // the table converted) and neither can touching a column with the value it
    // already holds — both measured against the vendored extension. The rebuild
    // is what works, and it has to leave the table able to replicate DELETES
    // too, which is what the uninstall promise rests on.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-plugin-clockloss-"), createLogger() as any);
    db.run(
      `insert into plugin_collections(plugin_id, collection, key, value_json, updated_at)
       values (?, ?, ?, ?, ?)`,
      ["decision-log", "decisions", "d1", '{"state":"open"}', "2026-08-30T00:00:00.000Z"],
    );
    db.run(
      `insert into plugin_collections(plugin_id, collection, key, value_json, updated_at)
       values (?, ?, ?, ?, ?)`,
      ["decision-log", "decisions", "d2", '{"state":"open"}', "2026-08-30T00:01:00.000Z"],
    );
    db.run(`delete from plugin_collections__crsql_clock`);
    expect(db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] })).toEqual([]);

    db.sync.ensureTablesAreCrr(["plugin_collections"]);

    expect(
      db.get<{ count: number }>("select count(*) as count from plugin_collections")?.count,
    ).toBe(2);
    const exported = db.sync.exportChangesSince(0, { includeTables: ["plugin_collections"] });
    expect(exported.length).toBeGreaterThan(0);

    // And the repaired table replicates a delete as a sentinel, not as an
    // absence — the uninstall path depends on it.
    const store = createPluginDataStore({ db, ensureTables: false });
    store.deleteCollection("decision-log", "decisions", "d1");
    expect(
      db.sync
        .exportChangesSince(0, { includeTables: ["plugin_collections"] })
        .some((change) => change.cid === "-1"),
    ).toBe(true);

    db.close();
  });

  it("skips a local-only table and survives one cr-sqlite refuses", async () => {
    // The two ways `ensureTablesAreCrr` must decline, both reachable from real
    // callers. A local-only table is declined by DECLARATION — converting it
    // would put a table about this machine's own bookkeeping on the wire.
    // A table with a nullable primary key is declined by CR-SQLITE, which is
    // every `id text primary key` in `automationService` (SQLite leaves such a
    // column nullable); those are converted at open by the retrofit pass
    // instead. Neither may throw: the caller is a service constructor, and
    // failing it would take down a feature over a replication detail.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-late-tables-"), createLogger() as any);
    db.run(`drop table if exists "plugin_wire_meter_daily__crsql_clock"`);
    db.run(`drop table if exists "plugin_wire_meter_daily__crsql_pks"`);
    db.run(`create table if not exists zz_nullable_pk_probe (id text primary key, project_id text not null)`);

    expect(() => db.sync.ensureTablesAreCrr([
      "plugin_wire_meter_daily",
      "zz_nullable_pk_probe",
      "zz_table_that_does_not_exist",
    ])).not.toThrow();

    for (const table of ["plugin_wire_meter_daily", "zz_nullable_pk_probe"]) {
      expect(
        db.get<{ count: number }>(
          "select count(*) as count from sqlite_master where name = ?",
          [`${table}__crsql_clock`],
        )?.count,
      ).toBe(0);
    }

    db.close();
  });

  it("keeps a peer's plugin watermark durable on a database that never migrated the table", async () => {
    // The dogfood database has no `sync_peer_plugin_watermarks` at all — it was
    // added by the watermark fix, and that database was last migrated before
    // it. Every persist threw, the sync host swallowed it by design, and the
    // debt each peer was owed lived only as long as its connection.
    const db = await openKvDb(makeDbPath("ade-kvdb-sync-watermark-table-"), createLogger() as any);
    db.run("drop table if exists sync_peer_plugin_watermarks");

    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(0);
    db.sync.setPluginTablesWatermark("phone-1", 4321);
    expect(db.sync.getPluginTablesWatermark("phone-1")).toBe(4321);

    // Recreated local-only, the way migrate creates it: a table about this
    // host's own outbound link must never ride a changeset.
    expect(db.sync.exportChangesSince(0).some(
      (change) => change.table === "sync_peer_plugin_watermarks",
    )).toBe(false);

    db.close();
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

  it("ignores CRDT changes for tables removed from the local schema", async () => {
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-mem-skip-"), createLogger() as any);
    const legacyChanges = [
      "unified_memories",
      "unified_memories_fts_content",
      "process_definitions",
      "process_runtime",
      "process_runs",
      "stack_buttons",
    ].map((table, index) => ({
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

  it("purges retired terminal sessions sent by an older peer", async () => {
    const db1 = await openKvDb(makeDbPath("ade-kvdb-sync-retired-session-a-"), createLogger() as any);
    const db2 = await openKvDb(makeDbPath("ade-kvdb-sync-retired-session-b-"), createLogger() as any);

    db1.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", "/repo/a", "Repo A", "main", "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
    );
    db1.run(
      `insert into lanes(
         id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
         attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json,
         folder, status, created_at, archived_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "lane-1", "project-1", "Lane 1", null, "worktree", "main", "feature/legacy",
        "/repo/a/.ade/worktrees/lane-1", null, 0, null, null, null, null, null,
        "active", "2026-07-27T00:00:00.000Z", null,
      ],
    );
    db1.run(
      `insert into terminal_sessions(
         id, lane_id, tracked, tool_type, pinned, manually_named, title, started_at,
         transcript_path, status
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["session-legacy", "lane-1", 1, "run-shell", 0, 0, "Legacy", "2026-07-27T00:00:00.000Z", "/tmp/legacy.log", "completed"],
    );

    const result = db2.sync.applyChanges(db1.sync.exportChangesSince(0));
    expect(result.touchedTables).toContain("terminal_sessions");
    expect(db2.get("select 1 as present from terminal_sessions where id = ?", ["session-legacy"])).toBeNull();

    db1.close();
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
