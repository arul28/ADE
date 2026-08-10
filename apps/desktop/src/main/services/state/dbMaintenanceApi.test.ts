import { describe, expect, it, vi } from "vitest";

import {
  pruneRowsInBatches,
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
