import { mkdtempSync, rmSync } from "node:fs";
import type * as NodeModule from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts every `node:sqlite` require made through `createRequire`, so the test
// can see when the module actually loads SQLite.
const sqliteLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>();
  const createRequire = (filename: string | URL) => {
    const inner = actual.createRequire(filename);
    return Object.assign((id: string) => {
      if (id === "node:sqlite") sqliteLoads.count += 1;
      return inner(id);
    }, inner);
  };
  return { ...actual, default: { ...actual, createRequire }, createRequire };
});

async function importFresh() {
  vi.resetModules();
  return import("./readOnlySqlite");
}

describe("readOnlySqlite", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ade-readonly-sqlite-"));
    sqliteLoads.count = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeFixture(): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (location: string) => DatabaseSyncType };
    const dbPath = path.join(dir, "store.db");
    const db = new DatabaseSync(dbPath);
    db.exec("create table events (id integer primary key, name text)");
    db.exec("insert into events (name) values ('first')");
    db.close();
    return dbPath;
  }

  it("loads node:sqlite on the first open, not on import, and only once", async () => {
    const readOnlySqlite = await importFresh();
    expect(sqliteLoads.count).toBe(0);

    const dbPath = await writeFixture();
    const before = sqliteLoads.count;
    const first = readOnlySqlite.openReadOnlyDatabase(dbPath);
    first.close();
    const second = readOnlySqlite.openReadOnlyDatabase(dbPath);
    second.close();
    expect(sqliteLoads.count - before).toBe(1);
  });

  it("opens read-only: reads succeed and writes are refused", async () => {
    const { hasColumn, hasTable, openReadOnlyDatabase } = await importFresh();
    const db = openReadOnlyDatabase(await writeFixture());
    try {
      expect(db.prepare("select name from events").all()).toEqual([{ name: "first" }]);
      expect(hasTable(db, "events")).toBe(true);
      expect(hasTable(db, "missing")).toBe(false);
      expect(hasColumn(db, "events", "name")).toBe(true);
      expect(hasColumn(db, "events", "missing")).toBe(false);
      expect(() => db.exec("insert into events (name) values ('second')")).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
  });

  it("throws when the file does not exist, rather than creating it", async () => {
    const { openReadOnlyDatabase } = await importFresh();
    expect(() => openReadOnlyDatabase(path.join(dir, "absent.db"))).toThrow();
  });
});
