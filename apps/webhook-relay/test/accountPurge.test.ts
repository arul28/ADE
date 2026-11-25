import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { purgeDeletedAccounts } from "../src/accountPurge";
import type { RelayEnv } from "../src/shared";

/*
 * A deleted account leaves this relay (`src/accountPurge.ts`): the cross-Worker
 * contract with the account directory's list, and the rows the purge must
 * delete or clear on the real schema. Privacy: a row it misses keeps the
 * account's ID and data for good.
 */

type SqliteStatement = { run(...params: unknown[]): { changes: number | bigint }; all(...params: unknown[]): Array<Record<string, unknown>> };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
};

function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(__dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    apply: () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
    run: async () => statement(sql, params).apply(),
    all: async () => ({ success: true, results: db.prepare(sql).all(...params) }),
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
  };
  return { DB: DB as unknown as D1Database, run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params), rows: (sql: string) => db.prepare(sql).all() };
}

const GONE = "user_gone";
const KEPT = "user_kept";
const AT = "2026-11-25T00:00:00.000Z";
const NOW = Date.parse(AT);
const MINUTE = 60_000;

function seed(data: ReturnType<typeof sqliteD1>, account: string): void {
  const run = data.run;
  run("insert into custom_hooks (hook_id, account_id, token_hash, created_at, updated_at, forward_url) values (?, ?, ?, ?, ?, 'https://forward.test')", `hook-${account}`, account, `hash-${account}`, AT, AT);
  run("insert into custom_hook_events (event_id, hook_id, account_id, method, headers_json, body, received_at) values (?, ?, ?, 'POST', '{}', 'body', ?)", `hev-${account}`, `hook-${account}`, account, AT);
  run("insert into github_events (project_id, event_id, github_event, summary, payload_json, received_at, account_id) values ('p', ?, 'push', 's', '{}', ?, ?)", `gh-${account}`, AT, account);
  run("insert into github_app_repositories (repository_key, repository_full_name, owner, name, last_seen_at, source_event, account_id) values (?, ?, 'o', 'n', ?, 'installation', ?)", `repo-${account}`, `o/${account}`, AT, account);
  run("insert into github_app_repositories (repository_key, repository_full_name, owner, name, last_seen_at, source_event, unlinked_account_id) values (?, ?, 'o', 'n', ?, 'installation', ?)", `old-repo-${account}`, `o/old-${account}`, AT, account);
  run("insert into linear_events (org_id, event_id, event_type, action, received_at, body, routed_account_id) values ('org', ?, 'Issue', 'create', ?, 'body', ?)", `lin-${account}`, AT, account);
  run("insert into linear_organizations (org_id, webhook_secret, registered_at, updated_at, account_id) values (?, 's', ?, ?, ?)", `org-${account}`, AT, AT, account);
  run("insert into linear_agent_members (org_id, linear_user_id, account_id, display_name, registered_at, last_seen_at) values ('org', ?, ?, 'Name', ?, ?)", `lu-${account}`, account, AT, AT);
  run("insert into linear_agent_sessions (session_id, org_id, routed_account_id, created_at, updated_at) values (?, 'org', ?, ?, ?)", `ses-${account}`, account, AT, AT);
  run("insert into linear_agent_installs (org_id, app_user_id, installed_by_account_id, fallback_mode, runner_account_id, installed_at, updated_at) values (?, 'app', ?, 'runner', ?, ?, ?)", `inst-${account}`, account, account, AT, AT);
  run("insert into cursor_events (event_id, event_type, status, agent_id, received_at, body, account_id) values (?, 'statusChange', 'done', 'a', ?, 'body', ?)", `cur-${account}`, AT, account);
  run("insert into cursor_webhook_secrets (id, webhook_secret, account_id, registered_at, updated_at) values (?, 's', ?, ?, ?)", `sec-${account}`, account, AT, AT);
}

/** Every row anywhere that still names `account`, as `table.column`. */
function mentions(data: ReturnType<typeof sqliteD1>, account: string): string[] {
  const tables = data.rows("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%'") as Array<{ name: string }>;
  return tables.flatMap(({ name }) => data.rows(`select * from "${name}"`).flatMap((row) => Object.entries(row).filter(([, value]) => value === account).map(([column]) => `${name}.${column}`)));
}

function directory(answer: () => Response, seen: Array<string | null>) {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://account-directory.internal/cloud/internal/deleted-accounts");
      seen.push(new Headers(init?.headers).get("x-ade-event-wake-secret"));
      return answer();
    }) as typeof fetch,
  };
}

describe("deleted account purge", () => {
  it("deletes or clears every row of each listed account, keeps shared rows and other accounts, and skips the dev directory that refuses", async () => {
    const data = sqliteD1();
    seed(data, GONE);
    seed(data, KEPT);
    const secrets: Array<string | null> = [];
    const env = {
      DB: data.DB,
      CLOUD_EVENT_WAKE_SECRET: "wake-secret",
      ACCOUNT_DIRECTORY_PRODUCTION: directory(() => Response.json({ accounts: [{ userId: GONE, deletedAt: NOW }] }), secrets),
      ACCOUNT_DIRECTORY: directory(() => new Response("{}", { status: 503 }), secrets),
    } as unknown as RelayEnv;
    const keptBefore = mentions(data, KEPT);

    expect(await purgeDeletedAccounts(env, NOW + MINUTE)).toBe(1);
    // Safe to repeat: the run after the directory's next repeat purges again and finds nothing more.
    expect(await purgeDeletedAccounts(env, NOW + 20 * MINUTE)).toBe(1);

    expect(secrets).toEqual(["wake-secret", "wake-secret", "wake-secret", "wake-secret"]);
    // Only the purge record names the account, until it goes 25 hours after the last purge.
    expect(mentions(data, GONE)).toEqual(["deleted_account_purges.account_id"]);
    expect(mentions(data, KEPT)).toEqual(keptBefore);
    // Shared rows stay without the account: another account can link the repository or workspace again.
    expect(data.rows(`select repository_key from github_app_repositories where repository_key like '%${GONE}' order by repository_key`))
      .toEqual([{ repository_key: `old-repo-${GONE}` }, { repository_key: `repo-${GONE}` }]);
    expect(data.rows(`select org_id from linear_organizations where org_id = 'org-${GONE}'`)).toEqual([{ org_id: `org-${GONE}` }]);
    expect(data.rows(`select session_id from linear_agent_sessions where session_id = 'ses-${GONE}'`)).toEqual([{ session_id: `ses-${GONE}` }]);
    expect(data.rows(`select org_id from linear_agent_installs where org_id = 'inst-${GONE}'`)).toEqual([{ org_id: `inst-${GONE}` }]);
  });

  it("asks no directory without the shared secret, purges only near the directory's repeats, and throws when the production directory refuses", async () => {
    const data = sqliteD1();
    seed(data, GONE);
    let answer = () => Response.json({ accounts: [{ userId: GONE, deletedAt: NOW }] }) as Response;
    const secrets: Array<string | null> = [];
    const env = {
      DB: data.DB,
      ACCOUNT_DIRECTORY_PRODUCTION: directory(() => answer(), secrets),
    } as unknown as RelayEnv;
    const before = mentions(data, GONE);

    // No shared secret: no directory is asked, and nothing is purged.
    expect(await purgeDeletedAccounts(env, NOW + MINUTE)).toBe(0);
    expect(secrets).toEqual([]);
    expect(mentions(data, GONE)).toEqual(before);
    (env as RelayEnv & { CLOUD_EVENT_WAKE_SECRET?: string }).CLOUD_EVENT_WAKE_SECRET = "wake-secret";

    expect(await purgeDeletedAccounts(env, NOW + MINUTE)).toBe(1);
    expect(mentions(data, GONE)).toEqual(["deleted_account_purges.account_id"]);
    // Purged since the last repeat: not due again until the next one.
    expect(await purgeDeletedAccounts(env, NOW + 10 * MINUTE)).toBe(0);
    expect(await purgeDeletedAccounts(env, NOW + 20 * MINUTE)).toBe(1);
    expect(await purgeDeletedAccounts(env, NOW + 55 * MINUTE)).toBe(0);
    // An outage missed the repeat at 75 minutes: the next run after it still purges.
    expect(await purgeDeletedAccounts(env, NOW + 4 * 60 * MINUTE)).toBe(1);

    // More due accounts than one run takes: the ones skipped go first on the next run.
    const many = Array.from({ length: 41 }, (_, n) => ({ userId: `user_many_${n}`, deletedAt: NOW }));
    answer = () => Response.json({ accounts: many });
    expect(await purgeDeletedAccounts(env, NOW + 2 * MINUTE)).toBe(40);
    expect(await purgeDeletedAccounts(env, NOW + 3 * MINUTE)).toBe(1);
    expect(await purgeDeletedAccounts(env, NOW + 4 * MINUTE)).toBe(0);

    // The account has left the list: its purge record goes 25 hours after its last purge.
    answer = () => Response.json({ accounts: [] });
    expect(await purgeDeletedAccounts(env, NOW + 30 * 60 * MINUTE)).toBe(0);
    expect(mentions(data, GONE)).toEqual([]);

    answer = () => new Response("{}", { status: 503 });
    await expect(purgeDeletedAccounts(env, NOW + 80 * MINUTE)).rejects.toThrow("deleted_accounts_list_failed");
  });
});
