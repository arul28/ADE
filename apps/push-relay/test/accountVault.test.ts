import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAccountVaultRoute, MAX_ITEMS_PER_READ } from "../src/accountVault";
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

/**
 * The vault stores credentials sealed with a key this Worker holds — platform
 * encryption, not end-to-end. So the properties worth pinning are: the value
 * round-trips, what lands in D1 is never the plaintext, a key that cannot open
 * a row says so rather than reporting the row as missing, and one account never
 * sees another's.
 */

// 32 bytes, base64. The Worker refuses anything else rather than hashing it,
// so a misconfigured secret is loud instead of silently weak.
const TEST_KEY = btoa("0123456789abcdef0123456789abcdef");

const MIGRATION = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
    "0009_account_vault.sql",
  ),
  "utf8",
);

function createDatabase(): { db: D1Database; raw: InstanceType<typeof DatabaseSync> } {
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

describe("account vault", () => {
  let env: AttentionRelayEnv & { VAULT_ENCRYPTION_KEY?: string };
  let raw: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    const made = createDatabase();
    raw = made.raw;
    env = { DB: made.db, VAULT_ENCRYPTION_KEY: TEST_KEY } as never;
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
    const response = await handleAccountVaultRoute(request, env, url, userId, route);
    if (!response) return { status: 404, body: {} };
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const put = (items: unknown[], userId = USER) =>
    call("PUT", "/attention/account/vault", { items, deviceId: "device-1" }, userId);

  const sealed = (over: Record<string, unknown> = {}) => ({
    scope: "all",
    kind: "provider_key",
    key: "anthropic",
    value: "sk-live-abc123",
    ...over,
  });

  it("round-trips a credential", async () => {
    expect((await put([sealed()])).body).toMatchObject({ ok: true, written: 1 });

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toMatchObject([
      { scope: "all", kind: "provider_key", key: "anthropic", value: "sk-live-abc123" },
    ]);
  });

  // The property the whole design exists for: a database dump alone reveals
  // nothing. If this ever fails, the vault is a plaintext table.
  it("never stores the plaintext", async () => {
    await put([sealed({ value: "sk-live-UNIQUEMARKER" })]);

    const stored = raw
      .prepare("select ciphertext from account_vault_items")
      .all() as Array<{ ciphertext: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.ciphertext).not.toContain("UNIQUEMARKER");
    expect(stored[0]!.ciphertext.startsWith("v1.")).toBe(true);
  });

  it("gives two identical values different stored bytes", async () => {
    await put([sealed({ key: "a" }), sealed({ key: "b" })]);

    const stored = raw
      .prepare("select ciphertext from account_vault_items")
      .all() as Array<{ ciphertext: string }>;
    expect(stored[0]!.ciphertext).not.toBe(stored[1]!.ciphertext);
  });

  // A caller offering pre-sealed bytes assumes an encryption model this Worker
  // does not implement, and storing them would produce a row nothing can open.
  it("refuses an item that supplies its own ciphertext", async () => {
    const result = await put([{ ...sealed(), ciphertext: "v1.AAAA.BBBB" }]);
    expect(result.status).toBe(400);
  });

  // A rotated or wrong key must look like "ADE cannot read this", never like
  // "you never saved it" — otherwise a client overwrites a credential that is
  // still perfectly good on another machine.
  it("reports an unopenable row rather than hiding it", async () => {
    await put([sealed()]);
    env.VAULT_ENCRYPTION_KEY = btoa("ffffffffffffffffffffffffffffffff");

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toMatchObject([{ key: "anthropic", value: null }]);
  });

  // A vault that silently stored plaintext because a secret was missing is
  // worse than one that refuses, because nobody finds out until it matters.
  it("refuses to work at all when no key is configured", async () => {
    delete env.VAULT_ENCRYPTION_KEY;

    expect((await put([sealed()])).status).toBe(503);
    expect((await call("GET", "/attention/account/vault")).status).toBe(503);
  });

  it("refuses a key that is not 32 bytes", async () => {
    env.VAULT_ENCRYPTION_KEY = btoa("too-short");
    expect((await put([sealed()])).status).toBe(503);
  });

  it("refuses a credential kind it does not know how to own", async () => {
    expect((await put([sealed({ kind: "ssh_key" })])).status).toBe(400);
    expect((await put([sealed({ kind: "" })])).status).toBe(400);
  });

  it("accepts the account credential kinds ADE actually stores", async () => {
    for (const kind of ["secret", "provider_key", "integration", "provider_api_key", "linear_refresh_token", "project_secret"]) {
      expect((await put([sealed({ kind, key: `k-${kind}` })])).status, kind).toBe(200);
    }
    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toHaveLength(6);
  });

  it("round-trips a project secret kind", async () => {
    expect((await put([sealed({ kind: "project_secret", key: "DATABASE_URL", value: "postgres://local" })])).body)
      .toMatchObject({ ok: true, written: 1 });

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toMatchObject([
      { scope: "all", kind: "project_secret", key: "DATABASE_URL", value: "postgres://local" },
    ]);
  });

  it("never returns another account's credentials", async () => {
    await put([sealed({ value: "mine" })], USER);
    await put([sealed({ value: "theirs" })], OTHER_USER);

    const mine = await call("GET", "/attention/account/vault", undefined, USER);
    expect(mine.body.items).toMatchObject([{ value: "mine" }]);
  });

  // Same kind, same key, different scope: a repo-scoped Linear token and an
  // account-wide one are two credentials, not one.
  it("keeps the same key in two scopes apart", async () => {
    await put([
      sealed({ kind: "integration", key: "linear", scope: "all", value: "account-wide" }),
      sealed({
        kind: "integration",
        key: "linear",
        scope: "repo:github.com/arul28/ade",
        value: "repo-scoped",
      }),
    ]);

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toHaveLength(2);
  });

  it("keeps the same key under two kinds apart", async () => {
    await put([
      sealed({ kind: "secret", key: "shared-name", value: "a-secret" }),
      sealed({ kind: "provider_key", key: "shared-name", value: "a-key" }),
    ]);

    expect((await call("GET", "/attention/account/vault")).body.items).toHaveLength(2);
  });

  it("replaces a credential in place rather than accumulating versions", async () => {
    await put([sealed({ value: "old" })]);
    await put([sealed({ value: "new" })]);

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toMatchObject([{ value: "new" }]);
  });

  // Revoking has to work from anywhere, including a machine the user no longer
  // has. A vault you can only add to is not a vault.
  it("deletes a credential and stays idempotent", async () => {
    await put([sealed()]);

    const first = await call("DELETE", "/attention/account/vault/all/provider_key/anthropic");
    expect(first.body).toMatchObject({ ok: true, deleted: true });
    const again = await call("DELETE", "/attention/account/vault/all/provider_key/anthropic");
    expect(again.body).toMatchObject({ ok: true, deleted: false });
    expect((await call("GET", "/attention/account/vault")).body.items).toEqual([
      expect.objectContaining({ key: "anthropic", deleted: true, value: null }),
    ]);
  });

  it("rejects the whole batch when one item is bad, writing nothing", async () => {
    const result = await put([sealed(), sealed({ kind: "ssh_key", key: "other" })]);
    expect(result.status).toBe(400);
    expect((await call("GET", "/attention/account/vault")).body.items).toHaveLength(0);
  });

  it("bounds the value", async () => {
    expect((await put([sealed({ value: "x".repeat(10_000) })])).status).toBe(400);
    expect((await put([sealed({ value: "" })])).status).toBe(400);
  });

  // Nothing rotating is stored yet, but the column is what lets one join later
  // without repeating the two-machines-one-refresh-token bug.
  it("records which machine may refresh a rotating credential", async () => {
    await put([sealed({ kind: "integration", key: "linear", refreshOwner: "machine-abc" })]);

    const read = await call("GET", "/attention/account/vault");
    expect(read.body.items).toMatchObject([{ refreshOwner: "machine-abc" }]);
  });

  it("leaves refreshOwner null for a credential that never rotates", async () => {
    await put([sealed()]);
    expect((await call("GET", "/attention/account/vault")).body.items)
      .toMatchObject([{ refreshOwner: null }]);
  });

  // Same page-boundary bug as settings, one column wider: the vault's tiebreak
  // has to include `item_kind` because the primary key does.
  it("walks every item exactly once when a whole page shares one updated_at", async () => {
    const stamp = "2031-05-05T05:05:05.000Z";
    const total = MAX_ITEMS_PER_READ + 5;
    const insert = raw.prepare(`
      insert into account_vault_items(
        user_id, scope_key, item_kind, item_key, ciphertext, updated_at,
        writer_device_id, refresh_owner
      ) values (?, 'all', 'secret', ?, 'v1.unreadable.unreadable', ?, 'device-1', null)
    `);
    for (let index = 0; index < total; index += 1) {
      insert.run(...([USER, `bulk.${String(index).padStart(5, "0")}`, stamp] as never[]));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const suffix: string = cursor ? `?since=${cursor}` : "";
      const read = await call("GET", `/attention/account/vault${suffix}`);
      for (const item of read.body.items as Array<Record<string, unknown>>) {
        seen.push(item.key as string);
      }
      cursor = read.body.cursor as string | null;
      if (!read.body.truncated) break;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("still accepts a legacy bare-timestamp cursor", async () => {
    await put([sealed()]);
    const legacy = new Date().toISOString();
    raw.exec("update account_vault_items set updated_at = '2000-01-01T00:00:00.000Z'");
    const read = await call(
      "GET",
      `/attention/account/vault?since=${encodeURIComponent(legacy)}`,
    );
    expect(read.body.items).toHaveLength(0);
  });

  it("does not answer routes that are not its own", async () => {
    const url = new URL("https://relay.test/attention/account/settings");
    const response = await handleAccountVaultRoute(
      new Request(url),
      env,
      url,
      USER,
      ["settings"],
    );
    expect(response).toBeNull();
  });
});
