import { describe, expect, it, vi } from "vitest";

import {
  pruneRowsInBatches,
  prunePluginRowsForAbsentPlugins,
  MAINTENANCE_DELETE_BATCH_ROWS,
  MAINTENANCE_DELETE_MAX_BATCHES,
} from "./dbMaintenanceApi";

describe("pruneRowsInBatches", () => {
  /** A table of `total` matching rows that deletes at most `limit` per call. */
  function fakeTable(total: number) {
    let remaining = total;
    return {
      get remaining() { return remaining; },
      deleteRows: vi.fn((sql: string) => {
        const limit = Number(/limit (\d+)/.exec(sql)?.[1] ?? 0);
        const deleted = Math.min(limit, remaining);
        remaining -= deleted;
        return deleted;
      }),
    };
  }

  it("yields to the event loop between batches", async () => {
    const table = fakeTable(MAINTENANCE_DELETE_BATCH_ROWS * 3);
    const yields = vi.fn(async () => {});

    const removed = await pruneRowsInBatches({
      table: "ai_usage_log",
      where: "timestamp < ?",
      params: ["2026-01-01"],
      deleteRows: table.deleteRows,
      yieldToEventLoop: yields,
    });

    expect(removed).toBe(MAINTENANCE_DELETE_BATCH_ROWS * 3);
    expect(table.deleteRows).toHaveBeenCalledTimes(4);
    // The driver is synchronous, so without these yields the whole delete runs
    // as one uninterruptible block — UI, IPC, and the sync pump all stall.
    expect(yields).toHaveBeenCalledTimes(3);
  });

  it("stops on the first short batch without an extra probe", async () => {
    const table = fakeTable(10);
    const yields = vi.fn(async () => {});

    const removed = await pruneRowsInBatches({
      table: "cto_session_logs",
      where: "created_at < ?",
      params: ["2026-01-01"],
      deleteRows: table.deleteRows,
      yieldToEventLoop: yields,
    });

    expect(removed).toBe(10);
    expect(table.deleteRows).toHaveBeenCalledTimes(1);
    expect(yields).not.toHaveBeenCalled();
  });

  it("bounds one call so a huge backlog cannot run away", async () => {
    const table = fakeTable(MAINTENANCE_DELETE_BATCH_ROWS * (MAINTENANCE_DELETE_MAX_BATCHES + 50));

    const removed = await pruneRowsInBatches({
      table: "ai_usage_log",
      where: "timestamp < ?",
      params: ["2026-01-01"],
      deleteRows: table.deleteRows,
      yieldToEventLoop: async () => {},
    });

    expect(table.deleteRows).toHaveBeenCalledTimes(MAINTENANCE_DELETE_MAX_BATCHES);
    expect(removed).toBe(MAINTENANCE_DELETE_BATCH_ROWS * MAINTENANCE_DELETE_MAX_BATCHES);
    // The rest is left for the next sweep rather than held in one long pause.
    expect(table.remaining).toBe(MAINTENANCE_DELETE_BATCH_ROWS * 50);
  });

  it("deletes by rowid so each batch costs the batch, not the table", async () => {
    const table = fakeTable(1);
    await pruneRowsInBatches({
      table: "pack_events",
      where: "created_at < ?",
      params: ["2026-01-01"],
      deleteRows: table.deleteRows,
      yieldToEventLoop: async () => {},
    });
    const sql = table.deleteRows.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("where rowid in (");
    expect(sql).toContain(`limit ${MAINTENANCE_DELETE_BATCH_ROWS}`);
  });
});

describe("prunePluginRowsForAbsentPlugins", () => {
  function recordingDeleter() {
    const statements: Array<{ sql: string; params: string[] }> = [];
    return {
      statements,
      deleteRows: (sql: string, params: string[]) => {
        statements.push({ sql, params });
        return 1;
      },
    };
  }

  it("never touches the replicated plugin tables", () => {
    const deleter = recordingDeleter();
    prunePluginRowsForAbsentPlugins(deleter.deleteRows, ["ade-graph"], "2026-01-01");
    const sql = deleter.statements.map((statement) => statement.sql).join("\n");
    // These three are CRRs with no machine dimension: a delete keyed on THIS
    // machine's registry destroys rows a plugin installed on another machine
    // owns, and replicates that destruction back to it.
    expect(sql).not.toContain("plugin_collections");
    expect(sql).not.toContain("plugin_contributions");
    expect(sql).not.toContain("plugin_panels");
  });

  it("prunes only local meter rollups, by absence and by age", () => {
    const deleter = recordingDeleter();
    const removed = prunePluginRowsForAbsentPlugins(deleter.deleteRows, ["ade-graph"], "2026-01-01");

    expect(removed).toBe(2);
    expect(deleter.statements).toEqual([
      {
        sql: "delete from plugin_wire_meter_daily where plugin_id not in (?)",
        params: ["ade-graph"],
      },
      {
        sql: "delete from plugin_wire_meter_daily where day < ?",
        params: ["2026-01-01"],
      },
    ]);
  });

  it("treats an empty registry as a real answer for local rows only", () => {
    const deleter = recordingDeleter();
    prunePluginRowsForAbsentPlugins(deleter.deleteRows, [], "2026-01-01");
    // A machine with nothing installed clears its own meter and nothing else —
    // the pre-fix version read the same empty registry and wiped the entire
    // account's plugin data.
    expect(deleter.statements[0]?.sql).toBe("delete from plugin_wire_meter_daily where 1 = 1");
    expect(deleter.statements.every((statement) => statement.sql.includes("plugin_wire_meter_daily"))).toBe(true);
  });
});
