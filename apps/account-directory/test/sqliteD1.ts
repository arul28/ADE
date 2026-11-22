import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * D1 over node:sqlite with every migration in `../migrations` applied, for
 * suites that need the real schema and SQL. A batch is one transaction, as on
 * D1. Older suites carry their own copy of this; new ones import it.
 */

type SqliteStatement = {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
};
// Loaded at run time: the test runner's resolver does not know `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
};

export function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(__dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
    first: async <T>() => (db.prepare(sql).get(...params) ?? null) as T | null,
    all: async <T>() => ({ success: true, results: db.prepare(sql).all(...params) as T[] }),
    apply: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  const DB = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      db.exec("begin");
      try {
        const results = statements.map((entry) => entry.apply());
        db.exec("commit");
        return results;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    DB,
    exec: (sql: string, ...params: unknown[]) => { db.prepare(sql).run(...params); },
    rows: (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params).map((row) => ({ ...row })),
  };
}
