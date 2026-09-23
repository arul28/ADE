import { describe, expect, it, vi } from "vitest";
import { assertFts5Available, SearchIndexFts5UnavailableError } from "./searchIndexDb";

describe("search index FTS5 capability", () => {
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
});
