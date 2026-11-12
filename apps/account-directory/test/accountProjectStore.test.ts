/**
 * The account's project list at service level: the store in
 * `src/accountProjects/store.ts` runs against a real SQLite engine (node:sqlite)
 * behind a D1-shaped adapter. The adapter keeps D1's rules the store depends on:
 * `batch` is one transaction that rolls back whole when a statement fails, and
 * a constraint failure surfaces as the same "UNIQUE constraint failed" error.
 * The fake D1 in `./fakeD1` does not model these tables, so it cannot run the
 * race and merge logic under test here.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addProject,
  listProjects,
  readProject,
  replaceMachineCopies,
  type CopyPlanInput,
  type IdentityInput,
} from "../src/accountProjects/store";

/** The part of node:sqlite's `DatabaseSync` this test uses. The package's @types/node predates the module. */
type SqliteEngine = {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
};

// Loaded through require: this Vitest version does not resolve the `node:sqlite` import itself.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteEngine;
};

const USER = "user-a";
const MIGRATION = fileURLToPath(new URL("../migrations/0028_account_projects.sql", import.meta.url));

class SqliteStatement {
  private params: unknown[] = [];

  constructor(
    private readonly engine: SqliteEngine,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    this.params = values.map((value) => value ?? null);
    return this;
  }

  private rows(): Record<string, unknown>[] {
    return this.engine.prepare(this.sql).all(...(this.params as never[])) as Record<string, unknown>[];
  }

  private execute(): { results: Record<string, unknown>[]; success: true; meta: Record<string, never> } {
    if (/^\s*select\b/i.test(this.sql)) return { results: this.rows(), success: true, meta: {} };
    this.engine.prepare(this.sql).run(...(this.params as never[]));
    return { results: [], success: true, meta: {} };
  }

  async first<T>(): Promise<T | null> {
    return (this.rows()[0] ?? null) as T | null;
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    return { results: this.rows() };
  }

  /** @internal Used by batch: runs inside the batch's transaction. */
  _execute(): unknown {
    return this.execute();
  }
}

/** D1's `batch`: one transaction. A failing statement rolls the whole batch back and throws. */
class SqliteD1 {
  readonly engine = new DatabaseSync(":memory:");

  constructor() {
    this.engine.exec(MIGRATION_SQL);
    // Stands in for the `machines` table of the earlier migrations: the columns the copy reads join on.
    this.engine.exec("create table machines (user_id text not null, machine_key text not null, primary key (user_id, machine_key))");
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.engine, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = null;
    hook?.();
    this.engine.exec("begin");
    try {
      const results = statements.map((statement) => statement._execute());
      this.engine.exec("commit");
      return results;
    } catch (error) {
      this.engine.exec("rollback");
      throw error;
    }
  }

  /** One-shot: runs just before the next batch, as a purge from another request would. */
  beforeNextBatch: (() => void) | null = null;

  addMachine(userId: string, machineKey: string): void {
    this.engine.prepare("insert into machines (user_id, machine_key) values (?, ?)").run(userId, machineKey);
  }
}

const MIGRATION_SQL = fs.readFileSync(MIGRATION, "utf8");

/** The D1 binding the store receives. */
function openDb(): SqliteD1 {
  return new SqliteD1();
}

function repo(owner: string, name: string, repoId: number | null = null): IdentityInput {
  return {
    host: "github.com",
    owner,
    name,
    repoKey: `repo:github.com/${owner}/${name}`,
    canonicalRepoKey: repoId === null ? null : `repo:github.com/${owner}/${name}`,
    repoId,
    defaultBranch: "main",
  };
}

function copy(machineRepo: IdentityInput, checkoutId: string): CopyPlanInput {
  return { ...machineRepo, checkoutId, rootPath: `/home/dev/${checkoutId}`, isMain: true, add: "auto" };
}

describe("account project store (service level, real SQLite behind the D1 adapter)", () => {
  it("answers two address-only adds of one repository at once with one project and one address", async () => {
    const db = openDb();
    const input = repo("octo", "widget");

    const [first, second] = await Promise.all([
      addProject(db as unknown as D1Database, USER, input, 100),
      addProject(db as unknown as D1Database, USER, input, 101),
    ]);

    expect(second.projectId).toBe(first.projectId);
    const { projects } = await listProjects(db as unknown as D1Database, USER, null);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.aliases).toEqual(["repo:github.com/octo/widget"]);
  });

  it.each<[string, number | null, number, number | null, boolean, string[]]>([
    // [label, cursor, floor, floor a purge raises it to before the batch (null: none), reset, names in the answer]
    ["no cursor yet", null, 0, null, true, ["alpha", "beta"]],
    ["a cursor above the account counter", 9, 0, null, true, ["alpha", "beta"]],
    ["a cursor below the floor a purge raised", 1, 2, null, true, ["alpha", "beta"]],
    ["a purge that lands between the cursor read and the batch", 1, 0, 2, true, ["alpha", "beta"]],
    ["a cursor at the counter", 2, 0, null, false, []],
    ["a cursor inside the window", 1, 0, null, false, ["beta"]],
  ])("answers the list for %s: a full list or only the changes after the cursor", async (_label, cursor, floor, raiseTo, reset, names) => {
    const db = openDb();
    const d1 = db as unknown as D1Database;
    await addProject(d1, USER, repo("octo", "alpha"), 100);
    await addProject(d1, USER, repo("octo", "beta"), 200);
    // A purge raises the floor when it drops old tombstones. That takes a thousand rows,
    // so the test sets the floor the purge would have set, before the read or before the batch.
    db.engine.prepare("update account_project_state set floor_seq = ? where user_id = ?").run(floor, USER);
    if (raiseTo !== null) {
      db.beforeNextBatch = () => db.engine.prepare("update account_project_state set floor_seq = ? where user_id = ?").run(raiseTo, USER);
    }

    const answer = await listProjects(d1, USER, cursor);

    expect(answer.reset).toBe(reset);
    expect(answer.cursor).toBe(2);
    expect(answer.projects.map((project) => project.name).sort()).toEqual(names);
  });

  it("hides the folders of a machine that left the account, and shows the folders of a machine still on it", async () => {
    const db = openDb();
    const d1 = db as unknown as D1Database;
    db.addMachine(USER, "machine-on-account");
    const onAccount = repo("octo", "on-account");
    const leftAccount = repo("octo", "left-account");
    await replaceMachineCopies(d1, USER, "machine-on-account", [copy(onAccount, "checkout-on")], 300);
    await replaceMachineCopies(d1, USER, "machine-left", [copy(leftAccount, "checkout-left")], 310);

    const { projects } = await listProjects(d1, USER, null);
    const byName = new Map(projects.map((project) => [project.name, project]));

    expect(byName.get("on-account")?.copies.map((item) => item.checkoutId)).toEqual(["checkout-on"]);
    expect(byName.get("left-account")?.copies).toEqual([]);
    expect((await readProject(d1, USER, byName.get("left-account")!.id))?.copies).toEqual([]);
  });
});
