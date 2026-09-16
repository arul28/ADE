import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAccountSettingsRoute } from "../src/accountSettings";
import type { AttentionRelayEnv } from "../src/attentionShared";

// Vitest 0.34 resolves bare specifiers through Vite, which cannot see
// `node:sqlite`. `createRequire` loads the builtin directly.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...values: never[]): unknown;
      all(...values: never[]): unknown[];
      run(...values: never[]): { changes?: number | bigint };
    };
  };
};
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/**
 * These run the REAL migration against real SQLite rather than a hand-matched
 * fake, because most of what is worth testing here is the SQL itself: the
 * upsert's conflict target, the `updated_at > ?` cursor, and the primary key
 * that makes last-writer-wins per key rather than per account. A fake that
 * pattern-matches the query string would agree with any of those being wrong.
 */

const MIGRATION = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
    "0008_account_settings.sql",
  ),
  "utf8",
);

/** The slice of D1's surface this module uses, over node:sqlite. */
function createDatabase(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(MIGRATION);

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bound = values;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        return (raw.prepare(sql).get(...(bound as never[])) ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: raw.prepare(sql).all(...(bound as never[])) as T[] };
      },
      async run() {
        const result = raw.prepare(sql).run(...(bound as never[]));
        return { success: true, meta: { changes: Number(result.changes ?? 0) } };
      },
    };
    return statement;
  };

  const db = {
    prepare,
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;

  return { db, raw };
}

const USER = "user_ada";
const OTHER_USER = "user_grace";

describe("account settings store", () => {
  let db: D1Database;
  let raw: DatabaseSync;
  let env: AttentionRelayEnv;

  beforeEach(() => {
    ({ db, raw } = createDatabase());
    env = { DB: db } as AttentionRelayEnv;
  });

  async function call(
    method: string,
    pathname: string,
    body?: unknown,
    userId = USER,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = new URL(`https://relay.test${pathname}`);
    const request = new Request(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const route = url.pathname.split("/").filter(Boolean).slice(2);
    const response = await handleAccountSettingsRoute(request, env, url, userId, route);
    if (!response) return { status: 404, body: {} };
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const put = (settings: unknown[], userId = USER) =>
    call("PUT", "/attention/account/settings", { settings, deviceId: "device-1" }, userId);

  it("round-trips a setting", async () => {
    const written = await put([
      { scope: "all", key: "appearance.theme", value: "dark" },
    ]);
    expect(written.body).toMatchObject({ ok: true, written: 1 });

    const read = await call("GET", "/attention/account/settings");
    expect(read.body.settings).toMatchObject([
      { scope: "all", key: "appearance.theme", value: "dark", writerDeviceId: "device-1" },
    ]);
  });

  // The reason this table has one row per setting instead of one JSON document
  // per account: a machine that was offline must be able to change one key
  // without reverting every key it never saw.
  it("keeps last-writer-wins per key, not per account", async () => {
    await put([
      { scope: "all", key: "appearance.theme", value: "dark" },
      { scope: "all", key: "chat.font-size", value: 14 },
    ]);
    await put([{ scope: "all", key: "appearance.theme", value: "light" }]);

    const read = await call("GET", "/attention/account/settings");
    const settings = read.body.settings as Array<Record<string, unknown>>;
    expect(settings).toHaveLength(2);
    expect(settings.find((s) => s.key === "appearance.theme")?.value).toBe("light");
    // Untouched by a write that never mentioned it.
    expect(settings.find((s) => s.key === "chat.font-size")?.value).toBe(14);
  });

  it("separates the two scope axes", async () => {
    await put([
      { scope: "all", key: "lanes-git.auto-rebase", value: true },
      { scope: "repo:github.com/arul28/ade", key: "lanes-git.auto-rebase", value: false },
    ]);

    const all = await call("GET", "/attention/account/settings?scope=all");
    expect(all.body.settings).toMatchObject([{ scope: "all", value: true }]);

    const repo = await call(
      "GET",
      "/attention/account/settings?scope=repo%3Agithub.com%2Farul28%2Fade",
    );
    expect(repo.body.settings).toMatchObject([{ value: false }]);
  });

  it("never returns another account's settings", async () => {
    await put([{ scope: "all", key: "appearance.theme", value: "dark" }], USER);
    await put([{ scope: "all", key: "appearance.theme", value: "light" }], OTHER_USER);

    const mine = await call("GET", "/attention/account/settings", undefined, USER);
    expect(mine.body.settings).toMatchObject([{ value: "dark" }]);
    const theirs = await call("GET", "/attention/account/settings", undefined, OTHER_USER);
    expect(theirs.body.settings).toMatchObject([{ value: "light" }]);
  });

  // The pull rides a 30-second heartbeat, so an idle account must cost nothing.
  it("returns only what changed after the cursor", async () => {
    await put([{ scope: "all", key: "appearance.theme", value: "dark" }]);
    const first = await call("GET", "/attention/account/settings");
    const cursor = first.body.cursor as string;

    const unchanged = await call("GET", `/attention/account/settings?since=${cursor}`);
    expect(unchanged.body.settings).toHaveLength(0);

    // `updated_at` is stamped by the Worker, so force a later stamp rather than
    // racing the clock inside one millisecond.
    raw.exec("update account_settings set updated_at = '2099-01-01T00:00:00.000Z'");
    const changed = await call("GET", `/attention/account/settings?since=${cursor}`);
    expect(changed.body.settings).toHaveLength(1);
  });

  // A client's clock must never decide the winner: ADE has already had one sync
  // bug caused by trusting a peer's clock for ordering.
  it("stamps updated_at itself and keeps the caller's claim as diagnostics only", async () => {
    await put([
      {
        scope: "all",
        key: "appearance.theme",
        value: "dark",
        changedAt: "1999-01-01T00:00:00.000Z",
      },
    ]);
    const read = await call("GET", "/attention/account/settings");
    const setting = (read.body.settings as Array<Record<string, unknown>>)[0]!;
    expect(setting.changedAt).toBe("1999-01-01T00:00:00.000Z");
    expect(Date.parse(setting.updatedAt as string)).toBeGreaterThan(Date.parse("2020-01-01"));
  });

  it("deletes a setting and stays idempotent on retry", async () => {
    await put([{ scope: "all", key: "appearance.theme", value: "dark" }]);

    const first = await call("DELETE", "/attention/account/settings/all/appearance.theme");
    expect(first.body).toMatchObject({ ok: true, deleted: true });
    const again = await call("DELETE", "/attention/account/settings/all/appearance.theme");
    expect(again.body).toMatchObject({ ok: true, deleted: false });

    const read = await call("GET", "/attention/account/settings");
    expect(read.body.settings).toHaveLength(0);
  });

  // A partial success is the worst outcome: the caller believes everything
  // landed, and the one setting that did not is the one it never checks again.
  it("rejects a whole batch when one item is invalid, writing nothing", async () => {
    const result = await put([
      { scope: "all", key: "appearance.theme", value: "dark" },
      { scope: "nonsense-scope", key: "appearance.theme", value: "dark" },
    ]);
    expect(result.status).toBe(400);

    const read = await call("GET", "/attention/account/settings");
    expect(read.body.settings).toHaveLength(0);
  });

  it("rejects a key that carries structure and a value that is too large", async () => {
    expect((await put([{ scope: "all", key: "../etc/passwd", value: 1 }])).status).toBe(400);
    expect((await put([{ scope: "all", key: "a b", value: 1 }])).status).toBe(400);
    expect((await put([
      { scope: "all", key: "big.value", value: "x".repeat(20_000) },
    ])).status).toBe(400);
  });

  // `undefined` is not a value. Removing a setting is an explicit DELETE, so a
  // write can never half-mean a delete.
  it("refuses a write with no value rather than treating it as a removal", async () => {
    const result = await put([{ scope: "all", key: "appearance.theme" }]);
    expect(result.status).toBe(400);
  });

  it("reports truncation explicitly rather than leaving the client to guess", async () => {
    const read = await call("GET", "/attention/account/settings");
    expect(read.body).toMatchObject({ ok: true, truncated: false });
  });

  it("does not answer routes that are not its own", async () => {
    const url = new URL("https://relay.test/attention/account/snapshot");
    const response = await handleAccountSettingsRoute(
      new Request(url),
      env,
      url,
      USER,
      ["snapshot"],
    );
    expect(response).toBeNull();
  });
});
