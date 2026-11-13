import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handlePasswordsRoute, type PasswordsEnv } from "../src/passwords";
import { handleKeyServiceRequest } from "../../password-key-service/src/index";

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
 * What must hold for Passwords on the relay: an account only ever gets its own
 * vault key back (the same one every time, until a reset); a database dump
 * holds no key that opens anything; a write made on an old copy never silently
 * replaces a newer one; and a reset wipes the items under the old key.
 */
const MIGRATION = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0013_passwords.sql"),
  "utf8",
);

function createEnv(): { env: PasswordsEnv; raw: InstanceType<typeof DatabaseSync> } {
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
      for (const statement of statements) await statement.run();
      return [];
    },
  } as unknown as D1Database;
  // The real key service, reached the way the service binding reaches it.
  const keyServiceEnv = { PASSWORD_KEK_MASTER: btoa("0123456789abcdef0123456789abcdef"), KEY_SERVICE_AUTH_SECRET: "shared" };
  const fetcher = {
    fetch: (input: string, init: RequestInit) => handleKeyServiceRequest(new Request(input, init), keyServiceEnv),
  } as unknown as Fetcher;
  return { env: { DB: db, PASSWORD_KEY_SERVICE: fetcher, KEY_SERVICE_AUTH_SECRET: "shared" } as PasswordsEnv, raw };
}

async function call(env: PasswordsEnv, userId: string, method: string, route: string, body?: unknown) {
  const url = new URL(`https://relay.test/attention/account/${route}`);
  const response = await handlePasswordsRoute(
    new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    url,
    userId,
    route.split("?")[0]!.split("/"),
  );
  if (!response) throw new Error("route not handled");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const releaseBody = { deviceId: "mac-studio", machineKind: "desktop" };

describe("passwords relay routes", () => {
  it("gives an account the same vault key every time, never another account's, and stores it only wrapped", async () => {
    const { env, raw } = createEnv();
    const first = await call(env, "user_a", "POST", "passwords/key", releaseBody);
    const again = await call(env, "user_a", "POST", "passwords/key", { deviceId: "cloud-1", machineKind: "cloud" });
    const other = await call(env, "user_b", "POST", "passwords/key", releaseBody);
    expect(first.status).toBe(200);
    expect(again.body.dek).toBe(first.body.dek);
    expect(again.body.epoch).toBe(1);
    expect(other.body.dek).not.toBe(first.body.dek);
    // Nothing in the database is the key itself.
    const dump = JSON.stringify(raw.prepare("select * from password_keys").all());
    expect(dump).not.toContain(first.body.dek);
    // Every release is on the record.
    const releases = await call(env, "user_a", "GET", "passwords/releases");
    expect(releases.body.releases.map((r: { machineKind: string }) => r.machineKind).sort()).toEqual(["cloud", "desktop"]);
  });

  it("refuses a write made on an old copy instead of overwriting the newer row", async () => {
    const { env } = createEnv();
    const created = await call(env, "user_a", "PUT", "passwords/items", { items: [{ id: "item_00000001", ciphertext: "v1", ifRevision: "absent" }] });
    const revision1 = created.body.results[0].revision;
    expect(created.body.results[0].status).toBe("ok");
    // Device A edits from revision 1.
    const edit = await call(env, "user_a", "PUT", "passwords/items", { items: [{ id: "item_00000001", ciphertext: "v2-from-a", ifRevision: revision1 }] });
    expect(edit.body.results[0].status).toBe("ok");
    // Device B still holds revision 1: refused, and told the stored revision.
    const stale = await call(env, "user_a", "PUT", "passwords/items", { items: [{ id: "item_00000001", ciphertext: "v2-from-b", ifRevision: revision1 }] });
    expect(stale.body.results[0].status).toBe("stale");
    expect(stale.body.results[0].revision).toBe(edit.body.results[0].revision);
    const read = await call(env, "user_a", "GET", "passwords/items");
    expect(read.body.items).toEqual([expect.objectContaining({ id: "item_00000001", ciphertext: "v2-from-a", deleted: false })]);
    // Another account sees none of it.
    expect((await call(env, "user_b", "GET", "passwords/items")).body.items).toEqual([]);
  });

  it("reset starts a new key epoch and turns every old item into a tombstone", async () => {
    const { env } = createEnv();
    const sealed = (epoch: number) => JSON.stringify({ v: 1, epoch, iv: "aXY=", tag: "dGFn", ct: "Y3Q=" });
    const before = await call(env, "user_a", "POST", "passwords/key", releaseBody);
    const first = await call(env, "user_a", "PUT", "passwords/items", { items: [{ id: "item_00000001", ciphertext: sealed(1), ifRevision: "absent" }] });
    expect(first.body.results[0].status).toBe("ok");
    expect((await call(env, "user_a", "POST", "passwords/reset", releaseBody)).status).toBe(400);
    const reset = await call(env, "user_a", "POST", "passwords/reset", { ...releaseBody, confirm: "reset" });
    expect(reset.body.epoch).toBe(2);
    expect(reset.body.dek).not.toBe(before.body.dek);
    expect((await call(env, "user_a", "POST", "passwords/key", releaseBody)).body.dek).toBe(reset.body.dek);
    const read = await call(env, "user_a", "GET", "passwords/items");
    expect(read.body.items).toEqual([expect.objectContaining({ id: "item_00000001", ciphertext: null, deleted: true })]);
    expect(read.body.epoch).toBe(2);
    // A computer that has not heard of the reset still seals under epoch 1:
    // refused (it would be unreadable everywhere else), and told the epoch.
    const late = await call(env, "user_a", "PUT", "passwords/items", { items: [
      { id: "item_00000002", ciphertext: sealed(1), ifRevision: "absent" },
      { id: "item_00000003", ciphertext: sealed(2), ifRevision: "absent" },
    ] });
    expect(late.body.results.map((r: { status: string }) => r.status)).toEqual(["stale_key", "ok"]);
    const after = await call(env, "user_a", "GET", "passwords/items");
    expect(after.body.items.map((r: { id: string }) => r.id).sort()).toEqual(["item_00000001", "item_00000003"]);
  });
});
