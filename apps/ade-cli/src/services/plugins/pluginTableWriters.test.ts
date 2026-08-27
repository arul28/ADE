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
  deletePluginPresenceForPlugin,
  isPluginBudgetExceeded,
  publishPluginContribution,
  putPluginCollectionValue,
  putPluginPanel,
  readAllPluginPresence,
  readPluginCollectionUsage,
  replacePluginPresenceForMachine,
} from "./pluginTableWriters";

const NOW = "2026-08-11T00:00:00.000Z";
const LATER = "2026-08-11T01:00:00.000Z";

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

  describe("ifFull: evictOldest", () => {
    /** A JSON string value of exactly `bytes` bytes, quotes included. */
    const valueOf = (bytes: number): string => JSON.stringify("x".repeat(bytes - 2));

    const seed = (collection: string, key: string, bytes: number, updatedAt: string): void => {
      db.run(
        `insert into plugin_collections (plugin_id, collection, key, value_json, updated_at)
         values (?, ?, ?, ?, ?)`,
        ["graph", collection, key, valueOf(bytes), updatedAt],
      );
    };

    const keysIn = (collection: string): string[] => db.all<{ key: string }>(
      "select key from plugin_collections where plugin_id = ? and collection = ? order by key",
      ["graph", collection],
    ).map((row) => row.key);

    it("frees exactly enough bytes, in updated_at then key order, and lands the write", () => {
      // 31 × 64 KiB leaves room for one more 64 KiB value minus the three bytes
      // the other collection holds, so the write needs exactly one eviction.
      for (let index = 0; index < 31; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 64 * 1024, NOW);
      }
      // Older than every cache row and in another collection: eviction must not
      // reach it even though it is the oldest row the plugin owns.
      seed("saved", "pinned", 3, "2019-01-01T00:00:00.000Z");
      // Oldest cache row, and deliberately the LAST key alphabetically, so the
      // order clause is proven to lead on updated_at rather than on key.
      seed("cache", "zzz-oldest", 64 * 1024, "2020-01-01T00:00:00.000Z");

      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "fresh",
        valueJson: valueOf(64 * 1024),
        ifFull: "evictOldest",
        nowIso: LATER,
      });

      expect(keysIn("cache")).toContain("fresh");
      expect(keysIn("cache")).not.toContain("zzz-oldest");
      // Exactly one row freed, not "everything until comfortable".
      expect(keysIn("cache")).toHaveLength(31);
      expect(keysIn("saved")).toEqual(["pinned"]);

      // Same collection again: every remaining row shares NOW, so the tie breaks
      // on key — and `fresh` (written at LATER, and alphabetically before k0000)
      // is protected by its recency, not by luck.
      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "fresher",
        valueJson: valueOf(64 * 1024),
        ifFull: "evictOldest",
        nowIso: LATER,
      });
      expect(keysIn("cache")).not.toContain("k0000");
      expect(keysIn("cache")).toContain("fresh");
      expect(keysIn("cache")).toContain("fresher");
    });

    it("evicts to make room under the row cap without touching another collection", () => {
      for (let index = 0; index < PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN - 2; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 3, NOW);
      }
      seed("cache", "zzz-oldest", 3, "2020-01-01T00:00:00.000Z");
      seed("saved", "pinned", 3, "2019-01-01T00:00:00.000Z");
      expect(readPluginCollectionUsage(db, "graph").rows).toBe(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);

      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "fresh",
        valueJson: '"v"',
        ifFull: "evictOldest",
        nowIso: LATER,
      });

      expect(readPluginCollectionUsage(db, "graph").rows).toBe(PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);
      expect(keysIn("saved")).toEqual(["pinned"]);
      expect(keysIn("cache")).toContain("fresh");
      expect(keysIn("cache")).not.toContain("zzz-oldest");
    });

    it("evicts nothing when replacing a key with a smaller value", () => {
      for (let index = 0; index < 32; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 64 * 1024, NOW);
      }
      // At the byte ceiling exactly, so any real growth would refuse — but a
      // replacement shrinks, and the delta accounting has to see that before it
      // reaches for anyone else's row.
      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "k0000",
        valueJson: '"small"',
        ifFull: "evictOldest",
        nowIso: LATER,
      });

      expect(keysIn("cache")).toHaveLength(32);
      expect(db.get<{ value_json: string }>(
        "select value_json from plugin_collections where plugin_id = ? and collection = ? and key = ?",
        ["graph", "cache", "k0000"],
      )?.value_json).toBe('"small"');
    });

    it("never evicts the key it is writing, even when that key is the oldest row", () => {
      seed("cache", "target", 3, "2019-01-01T00:00:00.000Z");
      for (let index = 0; index < 32; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 64 * 1024, NOW);
      }

      // Growing `target` from 3 bytes to 64 KiB does not fit, and `target` is the
      // oldest row in the collection: freeing it would be self-defeating, so the
      // eviction has to skip it and take the next oldest instead.
      putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "target",
        valueJson: valueOf(64 * 1024),
        ifFull: "evictOldest",
        nowIso: LATER,
      });

      expect(keysIn("cache")).toContain("target");
      expect(keysIn("cache")).not.toContain("k0000");
      expect(db.get<{ bytes: number }>(
        "select length(cast(value_json as blob)) as bytes from plugin_collections where key = ?",
        ["target"],
      )?.bytes).toBe(64 * 1024);
    });

    it("refuses, and rolls its evictions back, when the collection cannot free enough", () => {
      // The bytes are held by another collection, which eviction may never
      // touch, so emptying `cache` entirely still does not make room.
      for (let index = 0; index < 32; index += 1) {
        seed("other", `o${index}`, 64 * 1024, NOW);
      }
      seed("cache", "only", 64 * 1024, NOW);

      let thrown: unknown;
      try {
        putPluginCollectionValue(db, {
          pluginId: "graph",
          collection: "cache",
          key: "new",
          valueJson: valueOf(64 * 1024),
          ifFull: "evictOldest",
          nowIso: LATER,
        });
      } catch (error) {
        thrown = error;
      }

      expect(isPluginBudgetExceeded(thrown)).toBe(true);
      // The transaction is the whole point: a failed put must not leave the
      // plugin poorer in rows than it started, having gained nothing.
      expect(keysIn("cache")).toEqual(["only"]);
      expect(keysIn("other")).toHaveLength(32);
    });

    it("stops at the eviction bound rather than emptying a collection row by row", () => {
      for (let index = 0; index < 31; index += 1) {
        seed("other", `o${index}`, 64 * 1024, NOW);
      }
      // 350 evictable rows worth 140,000 bytes — more than the 140,000-byte
      // deficit the write creates, so an unbounded loop would succeed here. Only
      // the first 200 are considered, which frees 80,000 and is not enough.
      for (let index = 0; index < 350; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 400, NOW);
      }

      expect(() => putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "new",
        valueJson: valueOf(64 * 1024),
        ifFull: "evictOldest",
        nowIso: LATER,
      })).toThrowError(/maximum is/);
      expect(keysIn("cache")).toHaveLength(350);
    });

    it("cannot rescue a value that is over the per-value ceiling", () => {
      seed("cache", "k0", 3, NOW);

      expect(() => putPluginCollectionValue(db, {
        pluginId: "graph",
        collection: "cache",
        key: "huge",
        valueJson: valueOf(PLUGIN_COLLECTION_VALUE_MAX_BYTES + 1),
        ifFull: "evictOldest",
        nowIso: LATER,
      })).toThrowError(/at most/);
      // No row was spent on a write that could never have fit.
      expect(keysIn("cache")).toEqual(["k0"]);
    });

    it('refuses identically with ifFull absent and with ifFull "fail"', () => {
      for (let index = 0; index < 32; index += 1) {
        seed("cache", `k${String(index).padStart(4, "0")}`, 64 * 1024, NOW);
      }
      const put = (ifFull?: "fail" | "evictOldest"): unknown => {
        try {
          putPluginCollectionValue(db, {
            pluginId: "graph",
            collection: "cache",
            key: "new",
            valueJson: valueOf(64 * 1024),
            ...(ifFull ? { ifFull } : {}),
            nowIso: LATER,
          });
          return null;
        } catch (error) {
          return error;
        }
      };

      const absent = put();
      const explicit = put("fail");
      expect(isPluginBudgetExceeded(absent)).toBe(true);
      expect((absent as Error).message).toBe((explicit as Error).message);
      expect(keysIn("cache")).toHaveLength(32);
    });
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

  it("stamps the manifest's refresh action, and never the plugin's own", () => {
    const schema = (panelId: string) => JSON.parse(db.get<{ schema_json: string }>(
      "select schema_json from plugin_panels where plugin_id = ? and panel_id = ?",
      ["graph", panelId],
    )?.schema_json ?? "null") as Record<string, unknown>;
    const put = (panelId: string, args: { schemaJson?: string; refreshAction?: string | null }) =>
      putPluginPanel(db, {
        pluginId: "graph",
        panelId,
        title: "Panel",
        icon: "graph",
        surface: "work",
        schemaJson: args.schemaJson ?? '{"v":1,"body":[]}',
        vocabVersion: 1,
        ...(args.refreshAction === undefined ? {} : { refreshAction: args.refreshAction }),
        nowIso: NOW,
      });

    put("fleet", { refreshAction: "refresh-fleet" });
    expect(schema("fleet")).toEqual({ v: 1, body: [], mobile: true, refreshAction: "refresh-fleet" });

    // Absent stays absent rather than being written as null: an absent key and
    // a null one would differ on the wire while meaning the same thing.
    put("plain", {});
    expect(schema("plain")).toEqual({ v: 1, body: [], mobile: true });

    // Dropping the declaration has to REMOVE the key, not leave a gesture that
    // dispatches an action the manifest no longer names.
    put("fleet", { refreshAction: null });
    expect(schema("fleet")).toEqual({ v: 1, body: [], mobile: true });

    // A plugin republishing a panel cannot mint the gesture: the key it wrote
    // is stripped and the host's answer takes its place.
    put("forged", { schemaJson: '{"v":1,"body":[],"refreshAction":"delete-everything"}' });
    expect(schema("forged")).toEqual({ v: 1, body: [], mobile: true });
    put("forged", {
      schemaJson: '{"v":1,"body":[],"refreshAction":"delete-everything"}',
      refreshAction: "refresh-fleet",
    });
    expect(schema("forged")).toEqual({ v: 1, body: [], mobile: true, refreshAction: "refresh-fleet" });
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

  /**
   * Uninstall's counterpart. These rows are the one leftover another COMPUTER
   * can see: a surviving row reports this machine as still having the plugin
   * enabled, which is exactly what the coverage matrix is built to avoid.
   */
  it("removes one machine's presence row for an uninstalled plugin and leaves the rest", () => {
    const rows = [
      { pluginId: "graph", version: "1.0.0", enabled: true, displayName: "Graph", icon: "graph", accent: "#000" },
      { pluginId: "video", version: "2.0.0", enabled: true, displayName: "Video", icon: "play", accent: "#111" },
    ];
    const forMachine = (machineKey: string) =>
      readAllPluginPresence(db).filter((row) => row.machineKey === machineKey);
    replacePluginPresenceForMachine(db, "machine-a", rows, NOW);
    replacePluginPresenceForMachine(db, "machine-b", rows, NOW);

    expect(deletePluginPresenceForPlugin(db, "machine-a", "graph")).toBe(1);
    expect(forMachine("machine-a").map((row) => row.pluginId)).toEqual(["video"]);
    // Uninstalling here says nothing about the other machine's installs.
    expect(forMachine("machine-b")).toHaveLength(2);

    // Idempotent: the remote-command adapter and the local action both clean up.
    expect(deletePluginPresenceForPlugin(db, "machine-a", "graph")).toBe(0);
    // An unpaired machine has no key, and a blank one must not sweep by plugin.
    expect(deletePluginPresenceForPlugin(db, "", "video")).toBe(0);
    expect(forMachine("machine-a")).toHaveLength(1);
    expect(forMachine("machine-b")).toHaveLength(2);
  });

  /**
   * The delete has to REPLICATE, not just disappear locally: a peer that never
   * receives it keeps showing the plugin as present on this machine. On a CRR
   * a delete is a change like any other, and `crsql_changes` is where that is
   * visible — so this asserts the mechanism, not just the local row count.
   */
  it("records the presence delete as a replicated change", () => {
    replacePluginPresenceForMachine(
      db,
      "machine-a",
      [{ pluginId: "graph", version: "1.0.0", enabled: true, displayName: "Graph", icon: "graph", accent: "#000" }],
      NOW,
    );
    const changesFor = (): number => db.get<{ count: number }>(
      "select count(*) as count from crsql_changes where \"table\" = 'plugin_presence'",
    )?.count ?? 0;
    const before = changesFor();

    deletePluginPresenceForPlugin(db, "machine-a", "graph");

    expect(changesFor()).toBeGreaterThan(0);
    expect(changesFor()).not.toBe(before);
  });
});
