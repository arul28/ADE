import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import {
  PLUGIN_BUDGET_EXCEEDED_CODE,
  PLUGIN_COLLECTION_VALUE_MAX_BYTES,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES,
  PLUGIN_PANELS_MAX_PER_PLUGIN,
} from "../../../../desktop/src/main/services/state/dbMaintenanceApi";
import {
  deletePluginCollectionValue,
  isPluginBudgetExceeded,
  publishPluginContribution,
  putPluginCollectionValue,
  putPluginPanel,
  readAllPluginPresence,
  readPluginCollectionUsage,
  replacePluginPresenceForMachine,
} from "./pluginTableWriters";

const NOW = "2026-08-11T00:00:00.000Z";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

describe("plugin table writers", () => {
  let root: string;
  let db: AdeDb;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-writers-"));
    db = await openKvDb(path.join(root, ".ade", "kv.sqlite"), createLogger());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stores and reads back a collection value", () => {
    putPluginCollectionValue(db, {
      pluginId: "graph",
      collection: "issues",
      key: "a",
      valueJson: '{"n":1}',
      nowIso: NOW,
    });
    const usage = readPluginCollectionUsage(db, "graph");
    expect(usage.rows).toBe(1);
    expect(usage.bytes).toBe(7);
    expect(deletePluginCollectionValue(db, { pluginId: "graph", collection: "issues", key: "a" })).toBe(true);
    expect(readPluginCollectionUsage(db, "graph").rows).toBe(0);
  });

  it("rejects an oversized single value with a typed error and writes nothing", () => {
    const tooBig = JSON.stringify("x".repeat(PLUGIN_COLLECTION_VALUE_MAX_BYTES));
    let thrown: unknown;
    try {
      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "issues",
        key: "a",
        valueJson: tooBig,
        nowIso: NOW,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isPluginBudgetExceeded(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe(PLUGIN_BUDGET_EXCEEDED_CODE);
    // Rejection, not accept-then-prune: on a CRR an accepted row leaves clock
    // and pks shadows behind that no later prune reclaims.
    expect(readPluginCollectionUsage(db, "graph").rows).toBe(0);
  });

  it("rejects a write past the per-plugin row cap but still lets the plugin shrink", () => {
    // Seed to the cap directly so the test does not pay 4,000 budget-checked
    // writes; the writer's own accounting is what is under test on the next one.
    for (let index = 0; index < PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN; index += 1) {
      db.run(
        `insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
         values (?, ?, ?, ?, ?)`,
        ["graph", "issues", `k${index}`, '"v"', NOW],
      );
    }
    expect(() => putPluginCollectionValue(db, {
      pluginId: "graph",
      collection: "issues",
      key: "overflow",
      valueJson: '"v"',
      nowIso: NOW,
    })).toThrowError(/maximum is/);

    // Replacing an existing key is not a new row, so it must still succeed at
    // the cap — otherwise a plugin that fills its budget can never update
    // anything again, including shrinking itself back under it.
    expect(() => putPluginCollectionValue(db, {
      pluginId: "graph",
      collection: "issues",
      key: "k0",
      valueJson: '"replaced"',
      nowIso: NOW,
    })).not.toThrow();
    expect(readPluginCollectionUsage(db, "graph").rows).toBe(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);
  });

  it("caps contributions per plugin and treats a null payload as a retraction", () => {
    for (let index = 0; index < 3; index += 1) {
      publishPluginContribution(db, {
        entityKind: "pr",
        entityId: `pr-${index}`,
        pluginId: "graph",
        socket: "row-badge",
        payloadJson: '{"text":"ok"}',
        nowIso: NOW,
      });
    }
    expect(() => publishPluginContribution(db, {
      entityKind: "pr",
      entityId: "pr-0",
      pluginId: "graph",
      socket: "row-badge",
      payloadJson: "x".repeat(PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES + 1),
      nowIso: NOW,
    })).toThrowError(/at most/);

    publishPluginContribution(db, {
      entityKind: "pr",
      entityId: "pr-0",
      pluginId: "graph",
      socket: "row-badge",
      payloadJson: null,
      nowIso: NOW,
    });
    // A retraction deletes the row rather than storing a null, so it stops
    // costing budget the moment it is retracted.
    const remaining = db.get<{ count: number }>(
      "select count(*) as count from plugin_contributions where plugin_id = ?",
      ["graph"],
    );
    expect(Number(remaining?.count)).toBe(2);
  });

  it("caps panels per plugin", () => {
    for (let index = 0; index < PLUGIN_PANELS_MAX_PER_PLUGIN; index += 1) {
      putPluginPanel(db, {
        pluginId: "graph",
        panelId: `p${index}`,
        title: "Panel",
        icon: "graph",
        surface: "work",
        schemaJson: "{}",
        vocabVersion: 1,
        nowIso: NOW,
      });
    }
    expect(() => putPluginPanel(db, {
      pluginId: "graph",
      panelId: "overflow",
      title: "Panel",
      icon: "graph",
      surface: "work",
      schemaJson: "{}",
      vocabVersion: 1,
      nowIso: NOW,
    })).toThrowError(/maximum is/);
  });

  it("stamps the mobile flag into the stored schema without touching the SQL shape", () => {
    const schema = (panelId: string) => db.get<{ schema_json: string }>(
      "select schema_json from plugin_panels where plugin_id = ? and panel_id = ?",
      ["graph", panelId],
    )?.schema_json ?? "";
    const put = (panelId: string, mobile?: boolean) => putPluginPanel(db, {
      pluginId: "graph",
      panelId,
      title: "Panel",
      icon: "graph",
      surface: "work",
      schemaJson: '{"v":1,"body":[]}',
      vocabVersion: 1,
      ...(mobile === undefined ? {} : { mobile }),
      nowIso: NOW,
    });

    put("desktop-only", false);
    expect(JSON.parse(schema("desktop-only"))).toEqual({ v: 1, body: [], mobile: false });

    // Absent means yes, and the row says so out loud: a client reading the flag
    // and one that has never heard of it must reach the same answer.
    put("phone", true);
    expect(JSON.parse(schema("phone"))).toEqual({ v: 1, body: [], mobile: true });
    put("unstated");
    expect(JSON.parse(schema("unstated"))).toEqual({ v: 1, body: [], mobile: true });

    // Flipping back has to REMOVE the false, not leave a stale one behind.
    put("desktop-only", true);
    expect(JSON.parse(schema("desktop-only"))).toEqual({ v: 1, body: [], mobile: true });
  });

  it("keeps a schema it cannot stamp byte-identical", () => {
    // Not an object: there is nowhere to put the key, and inventing a wrapper
    // would turn an unrenderable panel into a differently unrenderable one.
    putPluginPanel(db, {
      pluginId: "graph",
      panelId: "array",
      title: "",
      icon: "",
      surface: "",
      schemaJson: "[1,2]",
      vocabVersion: 1,
      mobile: false,
      nowIso: NOW,
    });
    expect(db.get<{ schema_json: string }>(
      "select schema_json from plugin_panels where plugin_id = ? and panel_id = ?",
      ["graph", "array"],
    )?.schema_json).toBe("[1,2]");
  });

  it("skips unchanged presence rows and removes ones that are gone", () => {
    const rows = [
      { pluginId: "graph", version: "1.0.0", enabled: true, displayName: "Graph", icon: "graph", accent: "#000" },
      { pluginId: "video", version: "2.0.0", enabled: true, displayName: "Video", icon: "play", accent: "#111" },
    ];
    const forMachine = (machineKey: string) =>
      readAllPluginPresence(db).filter((row) => row.machineKey === machineKey);

    expect(replacePluginPresenceForMachine(db, "machine-a", rows, NOW)).toBe(2);
    // Republishing the same state must cost nothing: on a CRR an idempotent
    // rewrite still stamps a clock entry per column and ships a changeset.
    expect(replacePluginPresenceForMachine(db, "machine-a", rows, NOW)).toBe(0);

    expect(replacePluginPresenceForMachine(db, "machine-a", [rows[0]], NOW)).toBe(1);
    expect(forMachine("machine-a").map((row) => row.pluginId)).toEqual(["graph"]);

    // Another machine's rows are untouched — the key is the whole isolation.
    replacePluginPresenceForMachine(db, "machine-b", rows, NOW);
    expect(forMachine("machine-b")).toHaveLength(2);
    expect(forMachine("machine-a")).toHaveLength(1);
  });
});
