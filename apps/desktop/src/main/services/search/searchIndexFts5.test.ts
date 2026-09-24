import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFts5Available, openSearchIndexDb, SearchIndexFts5UnavailableError } from "./searchIndexDb";

// The same builtin class the index module loads, so its prototype can be spied.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: { prototype: DatabaseSyncType };
};

describe("search index FTS5 capability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names a missing module instead of letting a bare error escape", () => {
    // A dev brain's SQLite had no FTS5, so `CREATE VIRTUAL TABLE … USING
    // fts5` threw "no such module: fts5" from inside the DDL. The caller read
    // that as corruption, deleted the index file, recreated it, failed again,
    // and logged `search.index_source_failed` per chat event — several lines a
    // second.
    const exec = vi.fn(() => {
      throw new Error("no such module: fts5");
    });

    let caught: unknown = null;
    try {
      assertFts5Available({ exec } as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SearchIndexFts5UnavailableError);
    expect((caught as SearchIndexFts5UnavailableError).code).toBe("SEARCH_INDEX_FTS5_UNAVAILABLE");
    // The reason survives, so a report can say which module was missing.
    expect(String((caught as SearchIndexFts5UnavailableError).cause)).toContain("fts5");
  });

  it("probes on a temp table and cleans up, so asking costs nothing", () => {
    const statements: string[] = [];
    const exec = vi.fn((sql: string) => {
      statements.push(sql);
    });

    expect(() => assertFts5Available({ exec } as never)).not.toThrow();

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("temp.ade_fts5_probe");
    expect(statements[0]).toContain("USING fts5");
    expect(statements[1]).toContain("DROP TABLE IF EXISTS temp.ade_fts5_probe");
  });

  it("closes the handle it opened when the runtime has no FTS5", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-fts5-close-"));
    const realExec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSyncType, sql: string) {
      if (sql.includes("USING fts5")) throw new Error("no such module: fts5");
      return realExec.call(this, sql);
    });
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() => openSearchIndexDb(cacheDir)).toThrow(SearchIndexFts5UnavailableError);
      // One open, one close: the handle does not outlive the failed probe.
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
