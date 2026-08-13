import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger";
import { PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN, PluginSdkError } from "../../../shared/plugins/sdk";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createPluginDataStore, PLUGIN_TABLE_DDL, type PluginDataStore } from "./pluginDataStore";

type ScratchDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
};
const testRequire = createRequire(import.meta.url);
const { DatabaseSync } = testRequire("node:sqlite") as { DatabaseSync: new (dbPath: string) => ScratchDatabase };

const PLUGIN_TABLES = ["plugin_panels", "plugin_collections", "plugin_contributions"] as const;

/**
 * `pragma table_info` reduced to the parts that must match, dropping the
 * default on primary-key columns: `crsql_as_crr` REWRITES the base table to add
 * a `default ''` to every PK column, so a migrated database legitimately
 * reports one where the raw DDL declares none.
 */
function columnShape(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    pk: row.pk,
    ...(Number(row.pk) > 0 ? {} : { dflt_value: row.dflt_value }),
  }));
}

const openDatabases: AdeDb[] = [];
const tempRoots: string[] = [];

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function openStore(): Promise<{ db: AdeDb; store: PluginDataStore }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-data-"));
  tempRoots.push(root);
  const db = await openKvDb(path.join(root, ".ade", "ade.db"), silentLogger());
  openDatabases.push(db);
  return { db, store: createPluginDataStore({ db }) };
}

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PluginSdkError) return error.code;
    throw error;
  }
  throw new Error("Expected the writer to refuse this call.");
}

describe("pluginDataStore", () => {
  afterEach(() => {
    while (openDatabases.length) openDatabases.pop()?.close();
    while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  });

  it("declares the same table shape the kvDb migration creates", async () => {
    // `create table if not exists` makes drift between these two copies silent:
    // the writer's DDL would be ignored on a migrated database and quietly
    // authoritative on one that predates the migration.
    const { db } = await openStore();
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-ddl-"));
    tempRoots.push(scratchRoot);
    const scratch = new DatabaseSync(path.join(scratchRoot, "scratch.db"));
    try {
      for (const statement of PLUGIN_TABLE_DDL) scratch.exec(statement);
      for (const table of PLUGIN_TABLES) {
        expect(columnShape(scratch.prepare(`pragma table_info('${table}')`).all()))
          .toEqual(columnShape(db.all(`pragma table_info('${table}')`)));
      }
    } finally {
      scratch.close();
    }
  });

  it("round-trips collection rows and filters a list by key prefix", async () => {
    const { store } = await openStore();

    store.putCollection("graph", "issues", "ade/1", { title: "First" });
    store.putCollection("graph", "issues", "ade/2", { title: "Second" });
    store.putCollection("graph", "issues", "other/3", { title: "Third" });

    expect(store.getCollection("graph", "issues", "ade/1")).toEqual({ title: "First" });
    expect(store.listCollection("graph", "issues").map((row) => row.key)).toEqual(["ade/1", "ade/2", "other/3"]);
    expect(store.listCollection("graph", "issues", { keyPrefix: "ade/" }).map((row) => row.key))
      .toEqual(["ade/1", "ade/2"]);
    expect(store.listCollection("graph", "issues", { limit: 1 })).toHaveLength(1);

    store.deleteCollection("graph", "issues", "ade/1");
    expect(store.getCollection("graph", "issues", "ade/1")).toBeNull();
    expect(store.listCollection("graph", "issues")).toHaveLength(2);
  });

  it("refuses a value larger than the per-value ceiling", async () => {
    const { store } = await openStore();

    expect(codeOf(() => store.putCollection("graph", "issues", "big", "x".repeat(70_000))))
      .toBe("plugin_budget_exceeded");
    // Nothing landed: the ceiling is enforced before the row is written.
    expect(store.listCollection("graph", "issues")).toHaveLength(0);
  });

  it("refuses a new row past the per-plugin row ceiling but still updates existing ones", async () => {
    const { db, store } = await openStore();

    db.run(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ?)
       insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
       select 'graph', 'issues', 'k' || n, '1', '2026-01-01T00:00:00.000Z' from seq`,
      [PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN],
    );

    expect(codeOf(() => store.putCollection("graph", "issues", "one-too-many", 1))).toBe("plugin_budget_exceeded");
    // Replacing a row the plugin already owns must not count as a new row.
    expect(() => store.putCollection("graph", "issues", "k1", 2)).not.toThrow();
    expect(store.getCollection("graph", "issues", "k1")).toBe(2);
  });

  it("makes room for the write when the plugin opts into evicting its oldest rows", async () => {
    const { db, store } = await openStore();

    db.run(
      `with recursive seq(n) as (select 1 union all select n + 1 from seq where n < ?)
         insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
         select 'graph', 'cache', 'k' || substr('0000' || n, -4), '1',
                '2026-08-11T00:00:0' || (n % 2) || '.000Z' from seq`,
      [PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN],
    );

    // Same full collection, two different answers — the option is the plugin's
    // to make, and the store carries it through rather than deciding for it.
    expect(codeOf(() => store.putCollection("graph", "cache", "fresh", 1))).toBe("plugin_budget_exceeded");
    expect(() => store.putCollection("graph", "cache", "fresh", 1, { ifFull: "evictOldest" })).not.toThrow();

    expect(store.getCollection("graph", "cache", "fresh")).toBe(1);
    expect(store.usage("graph").entries[0]?.collectionRows).toBe(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);
    // The oldest row (even n, stamped a second earlier) is the one that paid for it.
    expect(store.getCollection("graph", "cache", "k0002")).toBeNull();
    expect(store.getCollection("graph", "cache", "k0001")).toBe(1);
  });

  it("publishes a contribution and deletes it on a null payload", async () => {
    const { store } = await openStore();

    store.publishContribution("graph", "pr", "1042", "row-badge", { text: "3 refs", tone: "accent" });
    expect(store.usage("graph").entries[0]?.contributionRows).toBe(1);

    expect(codeOf(() => store.publishContribution("graph", "pr", "1042", "row-badge", { tone: "accent" })))
      .toBe("invalid_args");

    store.publishContribution("graph", "pr", "1042", "row-badge", null);
    expect(store.usage("graph").entries).toHaveLength(0);
  });

  /**
   * Goes THROUGH publish, not around it.
   *
   * The filter-chip regression that made this test necessary was invisible to
   * the model-level suites because they build their fixtures by hand —
   * `laneBadgeRow("graph", { text: "Risk", filterKey: "stacked" })`, a payload
   * shape the publish path could not produce. Those tests proved the model and
   * not the pipeline, so a whitelist that dropped `filterKey` from every kind
   * but `filter-chip` shipped: the tag never reached the database, every
   * client's filter-key map was empty in production, and selecting a chip hid
   * every row instead of filtering them. Reading the stored JSON back out is
   * the assertion that could not have passed then.
   */
  it("persists a cross-kind filterKey tag, which is what makes a chip filter", async () => {
    const { db, store } = await openStore();

    store.publishContribution("graph", "lane", "lane-1", "row-badge", {
      text: "Risk",
      tone: "warning",
      filterKey: "stacked",
    });

    const stored = db.all<{ payload_json: string }>(
      "select payload_json from plugin_contributions where entity_id = ?",
      ["lane-1"],
    );
    expect(JSON.parse(stored[0]!.payload_json)).toMatchObject({ text: "Risk", filterKey: "stacked" });
  });

  it("persists id and order, the other two fields the whitelist dropped", async () => {
    const { db, store } = await openStore();

    store.publishContribution("graph", "lane", "lane-3", "row-badge", {
      text: "Risk",
      tone: "warning",
      id: "risk-badge",
      order: 2,
    });

    const stored = db.all<{ payload_json: string }>(
      "select payload_json from plugin_contributions where entity_id = ?",
      ["lane-3"],
    );
    // `id` addresses one of two same-kind declarations; `order` sorts a
    // plugin's own rows. Both were read structurally by clients off a payload
    // the writer had already stripped them from, so both were inert.
    expect(JSON.parse(stored[0]!.payload_json)).toMatchObject({ id: "risk-badge", order: 2 });
  });

  it("refuses a filterKey no chip could match rather than storing it", async () => {
    const { db, store } = await openStore();

    // Over the 64-character ceiling the chip's own copy is held to. Dropped
    // rather than truncated: a truncated tag would silently group the entity
    // under a key no declared chip carries, which looks exactly like the bug
    // above from the user's side.
    store.publishContribution("graph", "lane", "lane-2", "row-badge", {
      text: "Risk",
      tone: "warning",
      filterKey: "x".repeat(65),
    });

    const stored = db.all<{ payload_json: string }>(
      "select payload_json from plugin_contributions where entity_id = ?",
      ["lane-2"],
    );
    expect(JSON.parse(stored[0]!.payload_json).filterKey).toBeUndefined();
  });

  it("reports per-plugin usage with the writer's own budgets", async () => {
    const { store } = await openStore();

    store.putCollection("graph", "issues", "a", { title: "A" });
    store.putCollection("graph", "issues", "b", { title: "B" });
    store.publishContribution("graph", "lane", "lane-1", "row-badge", { text: "ok", tone: "success" });
    store.updatePanel("graph", "main", { schema: { type: "stack" }, vocabVersion: 1 });
    store.putCollection("player", "files", "a.mp4", { seconds: 12 });

    const all = store.usage();
    expect(all.entries.map((entry) => entry.pluginId)).toEqual(["graph", "player"]);
    const graph = all.entries[0]!;
    expect(graph.collectionRows).toBe(2);
    expect(graph.collectionBytes).toBe(JSON.stringify({ title: "A" }).length * 2);
    expect(graph.contributionRows).toBe(1);
    expect(graph.panelRows).toBe(1);
    expect(all.budgets.collectionRowsPerPlugin).toBe(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);

    expect(store.usage("player").entries).toHaveLength(1);

    store.removePluginData("graph");
    expect(store.usage().entries.map((entry) => entry.pluginId)).toEqual(["player"]);
  });

  it("reads back a materialized panel, and survives one whose schema is corrupt", async () => {
    const { db, store } = await openStore();

    store.updatePanel("graph", "main", { title: "Graph", schema: { type: "stack" }, vocabVersion: 2 });
    const panel = store.readPanel("graph", "main");
    expect(panel).toMatchObject({ pluginId: "graph", panelId: "main", title: "Graph", vocabVersion: 2 });
    // The stored schema carries the host's resolved `mobile` flag alongside what
    // the plugin wrote: `plugin_panels` has no column for it, so the writer
    // stamps it into the payload. Absent from the update means yes.
    expect(panel?.schema).toEqual({ type: "stack", mobile: true });
    expect(panel?.updatedAt).toBeTruthy();

    expect(store.readPanel("graph", "missing")).toBeNull();

    // A row whose JSON cannot be parsed still resolves to a panel: blanking the
    // whole surface would hide every other panel the plugin publishes.
    db.run("update plugin_panels set schema_json = ? where plugin_id = ? and panel_id = ?", ["{oops", "graph", "main"]);
    expect(store.readPanel("graph", "main")).toMatchObject({ title: "Graph", schema: null });
  });

  it("notifies on collection writes so panels update without waiting for the poll", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-notify-"));
    tempRoots.push(root);
    const db = await openKvDb(path.join(root, ".ade", "ade.db"), silentLogger());
    openDatabases.push(db);
    let notifications = 0;
    const store = createPluginDataStore({ db, onCollectionChanged: () => { notifications += 1; } });

    store.putCollection("graph", "issues", "a", { title: "A" });
    store.deleteCollection("graph", "issues", "a");
    expect(notifications).toBe(2);

    // Contributions render from their own tables and do not drive the panel push.
    store.publishContribution("graph", "pr", "1042", "row-badge", { text: "3 refs", tone: "accent" });
    expect(notifications).toBe(2);
  });
});
