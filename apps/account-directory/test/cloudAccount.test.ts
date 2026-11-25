import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCloudBillingPublicRequest, reportExtraHours } from "../src/cloud/billing";
import { enforcePhoneAllowance, handleNomacWebhook } from "../src/cloud/phones";
import { CLOUD_BACKUP_MAX_ACCOUNT_BYTES, CLOUD_BACKUP_MAX_BYTES, CLOUD_BACKUP_NEVER_SAVED_SENTENCE, CLOUD_CHAT_MESSAGE_TTL_MS, CLOUD_OUTSIDE_AGENT_FREE_MESSAGE, type CloudAccountState, type CloudCopyRecord, type CloudFreeRecord, type CloudMoveRecord } from "../src/cloud/contract";
import { deleteAllAccountChats } from "../src/cloud/chats";
import { pruneSponsored } from "../src/cloud/gravity";
import { expireAccountTests } from "../src/cloud/ownerAccounts";
import { sweepStaleBackupUploads } from "../src/cloud/laneBackups";
import { runIdleCleanup } from "../src/cloud/idleCleanup";
import { runPlanCleanupPicks } from "../src/cloud/planCleanup";
import { CloudProviderError, createCloudProvider } from "../src/cloud/provider";
import { startCloudUpdate } from "../src/cloud/updates";
import { failUnjoinedLaunches, MACHINE_LAUNCH_MIN_VERSION_SETTING } from "../src/cloud/launches";
import { runCloudMoves } from "../src/cloud/moves";
import { rewardReferralIfDue } from "../src/cloud/referrals";
import { prepareStopBackupReportId, runCloudMinuteCron } from "../src/cloud/cron";
import { runLinearRenewalCron } from "../src/cloud/linearRenewal";
import { nextFireAt } from "../src/cloud/automationSchedule";
import { createComputer, forkComputer, handleCloudRequest } from "../src/cloud/routes";
import { handleSignupAnalyticsRequest } from "../src/signupAnalytics";
import { applyCloudPlanChange, type CloudEnv, type ComputerRow } from "../src/cloud/store";
import { runDailyCostReport } from "../src/cloud/costReport";
import { grantAad, seal, tokenKey } from "../src/githubApp/seal";
import { ISSUER, jwksEndpoint, mintToken, OAUTH_CLIENT_ID } from "./jwks";

/**
 * ADE Cloud's money and ownership contracts, through the real routes, cron and
 * webhook, on the real migrations. Only the network is faked: the compute
 * provider and Stripe. A race is written by having the fake provider run the
 * other request after it answers, which is where a real one lands.
 */

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const OWNER = "user_owner";
const OTHER = "user_other";
const NEWCOMER = "user_newcomer";
const INSTANCE = "abcde12345";
const SECOND = "fghij67890";
const WEBHOOK_SECRET = "whsec_cloud_test";
const PROVIDER = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const STRIPE = "https://api.stripe.com/v1";
const RESEND = "https://api.resend.com";
const CLERK = "https://api.clerk.com/v1";
/** An ADE older than `ade cloud save-for-rest`: the save goes on without capsules. */
const OLD_ADE_EXEC = { exit_code: 127, stdout: "", stderr: "unknown command" };

type SqliteStatement = {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): SqliteStatement };
};

type Row = Record<string, unknown>;

/** D1 over node:sqlite with every migration applied; a batch is one transaction, as on D1. */
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(__dirname, "../migrations");
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  let fault: ((sql: string, params: unknown[]) => boolean) | null = null;
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      if (fault?.(sql, params)) throw new Error("D1_ERROR: injected");
      return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
    },
    first: async <T>() => (db.prepare(sql).get(...params) ?? null) as T | null,
    all: async <T>() => ({ success: true, results: db.prepare(sql).all(...params) as T[] }),
    apply: () => {
      if (fault?.(sql, params)) throw new Error("D1_ERROR: injected");
      // As in D1, a read in a batch answers its rows.
      if (/^\s*select\b/i.test(sql)) return { success: true, results: db.prepare(sql).all(...params), meta: { changes: 0 } };
      return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
    },
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
    injectFault: (next: typeof fault) => { fault = next; },
    insert: (table: string, row: Row) => {
      const keys = Object.keys(row);
      db.prepare(`insert into ${table} (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`).run(...keys.map((key) => row[key]));
    },
    row: (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as Row,
    rows: (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params),
    exec: (sql: string, ...params: unknown[]) => { db.prepare(sql).run(...params); },
  };
}

type FakeInstance = { id: string; status: string; type: string; metadata: Record<string, string>; resources?: Record<string, number> };
type Call = { method: string; url: string; body: Record<string, unknown> | null; idempotencyKey: string | null };

/** The compute provider and Stripe at `fetch`. */
function fakeNetwork() {
  const realFetch = globalThis.fetch;
  const instances = new Map<string, FakeInstance>();
  const subscriptions = new Map<string, Row>();
  const calls: Call[] = [];
  /** The next matching call answers this instead, or throws it, once. */
  const once: Array<{ match: RegExp; reply: Response | Error }> = [];
  /** Runs once after the matching call has its answer, before the caller sees it. */
  const after: Array<{ match: RegExp; run: () => Promise<void> | void }> = [];
  /** A computer's shell, when a test gives it one: what each command prints (else exit 0, nothing). */
  const hooks: { exec: ((id: string, command: string) => { exit_code: number; stdout: string } | null) | null } = { exec: null };

  const instanceJson = (instance: FakeInstance) => ({ ...instance, resources: instance.resources ?? { cpu: 2, memory: 4, disk: 4 } });
  const reply = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
  const missing = () => reply({ error: { code: "not_found" } }, 404);

  function answer(method: string, url: string, body: Row | null): Response {
    if (url.startsWith(`${STRIPE}/subscriptions/`)) {
      const id = decodeURIComponent(url.slice(`${STRIPE}/subscriptions/`.length));
      const subscription = subscriptions.get(id);
      return subscription ? reply({ id, ...subscription }) : reply({ error: { message: "no such subscription" } }, 404);
    }
    // A plan switch moves the item's price, as Stripe does, and answers with the item.
    const item = method === "POST" ? url.match(/\/subscription_items\/([^/?]+)$/) : null;
    if (item) {
      const id = decodeURIComponent(item[1]!);
      for (const subscription of subscriptions.values()) {
        const found = ((subscription.items as { data?: Row[] } | undefined)?.data ?? []).find((entry) => entry.id === id);
        if (found) {
          found.price = { id: body?.price };
          return reply({ id, price: { id: body?.price } });
        }
      }
      return reply({ error: { message: "no such item" } }, 404);
    }
    // A new item joins its subscription, as Stripe does.
    if (method === "POST" && url === `${STRIPE}/subscription_items`) {
      const subscription = subscriptions.get(String(body?.subscription));
      if (!subscription) return reply({ error: { message: "no such subscription" } }, 404);
      const items = ((subscription.items ??= { data: [] }) as { data: Row[] }).data;
      const added = { id: `si_new${items.length}`, price: { id: body?.price } };
      items.push(added);
      return reply(added);
    }
    if (url.startsWith(STRIPE)) return reply({});
    if (url.startsWith(RESEND)) return reply({ id: "email_1" });
    // The one-time sign-in ticket the device approval mints for a user.
    if (url.startsWith(`${CLERK}/sign_in_tokens`)) return reply({ url: `https://clerk.test/v1/tickets/accept?ticket=t_${String(body?.user_id)}` });
    const rest = url.replace(PROVIDER, "").replace(SANDBOX, "");
    if (method === "GET" && rest === "/instances") return reply({ data: [...instances.values()].map(instanceJson) });
    if (method === "GET" && rest.startsWith("/usage")) return reply({ instances: [] });
    if (method === "GET" && rest === "/billing") return reply({ balance_usd: 100, instance_limit: 100, auto_top_up: { enabled: true } });
    if (method === "POST" && rest === "/instances") {
      const made: FakeInstance = { id: "madenew12345", status: "running", type: "default", metadata: (body?.metadata ?? {}) as Record<string, string>, resources: body?.resources as Record<string, number> };
      instances.set(made.id, made);
      return reply(instanceJson(made), 201);
    }
    const match = rest.match(/^\/instances\/([^/]+)(?:\/([a-z-]+))?$/);
    if (!match) return reply({ error: { code: "not_found" } }, 404);
    const [, id, action] = match as unknown as [string, string, string | undefined];
    const instance = instances.get(id);
    if (method === "POST" && action === "fork" && instance) {
      const made: FakeInstance = { id: "copied123456", status: "running", type: instance.type, metadata: (body?.metadata ?? {}) as Record<string, string>, resources: body?.resources as Record<string, number> };
      instances.set(made.id, made);
      return reply(instanceJson(made), 201);
    }
    if (method === "GET" && action === "events") return reply({ events: [] });
    if (!instance) return missing();
    if (method === "GET" && !action) return reply(instanceJson(instance));
    if (method === "DELETE") {
      instances.delete(id);
      return reply(null, 204);
    }
    if (method === "POST" && action === "exec") return reply({ stderr: "", ...(hooks.exec?.(id, String(body?.command ?? "")) ?? { exit_code: 0, stdout: "" }) });
    if (method === "POST" && action === "signed-url") return reply({ url: `https://serve-${id}.test/?sig=secret-link`, expires_at: null });
    if (method === "POST" && action) {
      const next = ({ sleep: "sleeping", stop: "stopped", start: "running" } as Record<string, string>)[action] ?? instance.status;
      instance.status = next;
      return reply({ status: next });
    }
    return reply({});
  }

  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (![PROVIDER, SANDBOX, STRIPE, RESEND, CLERK].some((prefix) => url.startsWith(prefix))) return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";
    // JSON to the provider, a form to Stripe.
    const body = typeof init?.body !== "string" ? null
      : init.body.startsWith("{") ? JSON.parse(init.body) as Row
      : Object.fromEntries(new URLSearchParams(init.body)) as Row;
    calls.push({ method, url, body, idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
    const planned = once.findIndex((entry) => entry.match.test(`${method} ${url}`));
    let response: Response;
    if (planned !== -1) {
      const { reply: planReply } = once.splice(planned, 1)[0]!;
      if (planReply instanceof Error) throw planReply;
      response = planReply;
    } else {
      response = answer(method, url, body);
    }
    const hook = after.findIndex((entry) => entry.match.test(`${method} ${url}`));
    if (hook !== -1) await after.splice(hook, 1)[0]!.run();
    return response;
  };
  return { instances, subscriptions, calls, once, after, hooks, fetchStub, reply };
}

type Harness = ReturnType<typeof sqliteD1> & {
  env: CloudEnv;
  net: ReturnType<typeof fakeNetwork>;
  /** What reached the push relay over the `ACTIVITY_RELAY` binding. */
  relayCalls: Array<{ method: string; url: string; directoryAuth: string | null }>;
  send: (caller: string, method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  tick: () => Promise<void>;
};

let clock = NOW;
let tokens: Record<string, string> = {};
let harness: Harness;
const originalFetch = globalThis.fetch;

function buildHarness(): Harness {
  const data = sqliteD1();
  const net = fakeNetwork();
  vi.stubGlobal("fetch", net.fetchStub);
  const env = {
    DB: data.DB,
    CLERK_JWKS_URL: jwksEndpoint(),
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    AGENT37_API_KEY: "provider-key",
    STRIPE_SECRET_KEY: "stripe-key",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PLAN_PRICE_ID: "price_plan",
    STRIPE_EXTRA_PRICE_ID: "price_extra",
  } as CloudEnv;
  return {
    ...data,
    env,
    net,
    relayCalls: [],
    send: (caller, method, url, body, headers = {}) => handleCloudRequest(new Request(`https://directory.test${url}`, {
      method,
      headers: { authorization: `Bearer ${tokens[caller]}`, "content-type": "application/json", ...headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body ?? {}) }),
    }), env),
    tick: () => runCloudMinuteCron(env, { now: clock }),
  };
}

function seedAccount(data: Harness, userId: string, overrides: Row = {}): void {
  data.insert("cloud_accounts", {
    user_id: userId,
    plan: "free",
    included_milli: 100_000,
    period_start: NOW - 8 * DAY,
    period_end: NOW + 22 * DAY,
    created_at: NOW - 60 * DAY,
    updated_at: NOW - 60 * DAY,
    ...overrides,
  });
}

/** The race, written down: `run` (the other request) lands just before the first statement matching `match`. */
function landBefore(match: RegExp, run: () => Promise<unknown>): void {
  const db = harness.env.DB;
  let armed = true;
  const hold = async () => {
    if (!armed) return;
    armed = false;
    await run();
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const hit = () => (match.test(sql) ? hold() : Promise.resolve());
    return {
      ...statement,
      sql,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      run: async () => { await hit(); return statement.run(); },
      first: async (...args: []) => { await hit(); return statement.first(...args); },
      all: async () => { await hit(); return statement.all(); },
    } as unknown as D1PreparedStatement;
  };
  harness.env.DB = {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statements: Array<D1PreparedStatement & { sql?: string }>) => {
      if (statements.some((statement) => match.test(statement.sql ?? ""))) await hold();
      return db.batch(statements);
    },
  } as unknown as D1Database;
}

function seedComputer(data: Harness, overrides: Row = {}): void {
  data.insert("cloud_computers", {
    instance_id: INSTANCE,
    user_id: OWNER,
    type: "default",
    cpu: 2,
    memory_gb: 4,
    disk_gb: 4,
    multiplier_milli: 1000,
    status: "running",
    status_changed_at: NOW,
    awake_since: NOW,
    last_awake_at: NOW,
    created_at: NOW - 40 * DAY,
    ...overrides,
  });
}

function provide(data: Harness, id = INSTANCE, status = "running", metadata: Record<string, string> = {}): FakeInstance {
  const instance = { id, status, type: "default", metadata };
  data.net.instances.set(id, instance);
  return instance;
}

const usedMilli = (data: Harness, user = OWNER): number => data.row("select used_milli from cloud_accounts where user_id = ?", user).used_milli as number;
const meteredMilli = (data: Harness, id = INSTANCE): number => Number(data.row("select coalesce(sum(metered_milli), 0) as total from cloud_computer_days where instance_id = ?", id).total);
const computer = (data: Harness, id = INSTANCE): Row => data.row("select * from cloud_computers where instance_id = ?", id);
const providerCalls = (data: Harness, pattern: RegExp) => data.net.calls.filter((call) => pattern.test(`${call.method} ${call.url}`));

beforeEach(async () => {
  clock = NOW;
  // Minted against the real clock: the token check reads it, not the mocked one below.
  tokens = Object.fromEntries(await Promise.all([OWNER, OTHER, NEWCOMER].map(async (sub) => [sub, await mintToken({ sub })])));
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  harness = buildHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("ADE Cloud account", () => {
  const instancePath = `/cloud/instances/${INSTANCE}`;
  it.each<[string, string, string, string, unknown]>([
    // Another account: a computer it doesn't own doesn't exist for it.
    ["another account reading a computer", OTHER, "GET", instancePath, undefined],
    ["another account deleting a computer", OTHER, "DELETE", instancePath, {}],
    ...["sleep", "idle", "start", "stop", "update", "resize", "fork", "exec", "backups", "signed-url", "public-ports"].map(
      (action): [string, string, string, string, unknown] => [`another account running ${action}`, OTHER, "POST", `${instancePath}/${action}`, { command: "id", port: 7337, ttlSeconds: 60, cpu: 2, memory: 4 }],
    ),
    ["another account renaming a computer", OTHER, "PUT", `${instancePath}/name`, { name: "mine now" }],
    ["another account setting auto-sleep", OTHER, "PUT", `${instancePath}/auto-sleep`, { autoSleep: false }],
    ["another account rewriting metadata", OTHER, "PUT", `${instancePath}/metadata`, { metadata: { ade_machine_key: "theirs" } }],
    ["another account moving from a computer", OTHER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE }],
    ["another account's timed wake", OTHER, "PUT", "/cloud/wake", { instanceId: INSTANCE, url: "https://wake-abc.agent37.app", at: NOW + HOUR }],
    ["another account saving a chat against a computer", OTHER, "PUT", "/cloud/chats/key-a/chat-a/parts/1", { text: "hello", instanceId: INSTANCE, row: {} }],
    ["another account setting a computer's event wakes", OTHER, "PUT", `${instancePath}/event-wakes`, { topics: [] }],
  ])("%s is refused as if it weren't there", async (_label, caller, method, url, body) => {
    const data = harness;
    data.env.CLOUD_CHATS = {} as R2Bucket;
    data.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedAccount(data, OWNER);
    seedComputer(data);
    provide(data);
    const before = computer(data);

    const response = await data.send(caller, method, url, body);

    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("not_found");
    // Not one call out, so the provider never heard about it and nothing was spent.
    expect(data.net.calls).toEqual([]);
    expect(computer(data)).toEqual(before);
    expect(usedMilli(data)).toBe(0);

    // The refusal is about this caller: the owner still reaches the same computer.
    const owners = await data.send(OWNER, "GET", instancePath);
    expect(owners.status).toBe(200);
    // ADE Cloud is open to every account: builds that still ask are told yes, even for an account it has never seen.
    const access = await (await data.send(NEWCOMER, "GET", "/cloud/access")).json() as { enabled: boolean };
    expect(access.enabled).toBe(true);
  });

  it("a computer's new name reaches the provider and the dashboard without control or bidi characters", async () => {
    const data = harness;
    seedAccount(data, OWNER);
    seedComputer(data);
    provide(data);

    const response = await data.send(OWNER, "PUT", `${instancePath}/name`, { name: "  Fix\u202e the\u0007\nlogin  " });

    expect(response.status).toBe(200);
    expect(providerCalls(data, /^PATCH /).map((call) => call.body)).toEqual([{ name: "Fix the login" }]);
    expect(computer(data).name).toBe("Fix the login");
  });

  it.each<[string, () => Promise<void>, number]>([
    ["a sleep and a status read racing it", async () => {
      // The computer asks to be slept, and a status read sees it asleep while that call is out.
      harness.net.after.push({ match: /POST .*\/sleep$/, run: async () => { await harness.send(OWNER, "GET", `/cloud/instances/${INSTANCE}`); } });
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/idle`)).status).toBe(200);
    }, 1000],
    ["two deletes at once", async () => {
      harness.net.after.push({ match: new RegExp(`DELETE .*/instances/${INSTANCE}$`), run: async () => { expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${INSTANCE}`)).status).toBe(200); } });
      expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${INSTANCE}`)).status).toBe(200);
      expect(computer(harness).status).toBe("deleted");
    }, 1000],
    ["the daily settle and a sleep racing it", async () => {
      // The tick has read this computer as awake; the sleep lands before the daily settle runs.
      harness.net.after.push({ match: /GET .*\/instances$/, run: async () => { expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200); } });
      await harness.tick();
      expect(harness.row("select value from cloud_settings where key = 'last_daily_day'").value).toBe("2026-11-09");
    }, 1000],
    ["a resize at the old rate", async () => {
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 4, memory: 8 })).status).toBe(200);
      expect(computer(harness).multiplier_milli).toBe(1000);
      clock += HOUR;
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200);
    }, 2000],
    ["a resize whose writes were lost, taken from the provider by the tick", async () => {
      // The provider resized it, but the restart cut the Worker off before its writes.
      Object.assign(harness.net.instances.get(INSTANCE)!, { resources: { cpu: 4, memory: 8, disk: 4 } });
      await harness.tick();
      expect(computer(harness)).toMatchObject({ cpu: 4, memory_gb: 8, multiplier_milli: 1000 });
      clock += HOUR;
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200);
    }, 2000],
    ["a resize that finishes its writes while the tick reads the provider", async () => {
      // The provider has resized it; the resize's own writes land after the tick read the row.
      Object.assign(harness.net.instances.get(INSTANCE)!, { resources: { cpu: 4, memory: 8, disk: 4 } });
      harness.net.after.push({ match: /GET .*\/instances$/, run: async () => {
        expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 4, memory: 8 })).status).toBe(200);
      } });
      await harness.tick();
      clock += HOUR;
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200);
    }, 2000],
  ])("charges one stretch once: %s", async (_label, run, expectedMilli) => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { awake_since: NOW - HOUR, machine_key: "key-a" });
    harness.insert("machines", { user_id: OWNER, machine_key: "key-a", last_seen_at: NOW });
    provide(harness);

    await run();

    expect(usedMilli(harness)).toBe(expectedMilli);
    // The day's record and the account agree, so the daily reconcile can't correct a phantom charge.
    expect(meteredMilli(harness)).toBe(expectedMilli);
    expect(computer(harness).awake_since).toBeNull();
  });

  // A sleep freezes the computer: a turn it cuts must be stopped and saved first,
  // or its saved copy reads Done while it sleeps. A sleeping computer is never woken for it.
  // When the prepare also saved every lane, the computer rests saved: a move needs no wake.
  const SLEEP_REPORT = "e".repeat(32);
  // The save counts only when the computer froze new work until its sleep (`frozen`); an older ADE doesn't.
  const prepared = (backups: string, frozen: boolean) => JSON.stringify({ result: { stillRunning: 0, chatsNotUploaded: 0, timedOut: false, frozen, backups: { reportId: SLEEP_REPORT, state: backups } } });
  it.each<[string, "running" | "sleeping", string | null, boolean, boolean]>([
    ["an awake computer stops its turns, saves its chats and lanes, then sleeps saved", "running", "current", true, true],
    ["a lane save that didn't finish: it sleeps, not saved", "running", "failed", true, false],
    ["an ADE that did not freeze new work: it sleeps, not saved", "running", "current", false, false],
    ["a computer that already sleeps gets no command, so no wake", "sleeping", null, false, false],
  ])("the person's Sleep: %s", async (_label, status, backups, frozen, restsSaved) => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-a", backup_report_id: SLEEP_REPORT, backup_report_state: backups === "current" ? "current" : "failed" });
    provide(harness);
    harness.net.instances.get(INSTANCE)!.status = status;
    if (backups) harness.net.hooks.exec = (_id, command) => command.includes("prepare-stop") ? { exit_code: 0, stdout: prepared(backups, frozen) } : null;

    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200);

    const lifecycle = providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/(exec|sleep)$`)).map((call) => call.url.endsWith("/exec") ? String(call.body?.command) : "sleep");
    expect(lifecycle).toEqual(backups
      ? [expect.stringContaining("ade cloud prepare-stop --timeout 20 --for-sleep --json"), "sleep"]
      : ["sleep"]);
    expect(computer(harness).backup_rest_at != null).toBe(restsSaved);
  });

  function webhook(event: Row): Promise<Response> {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(clock / 1000);
    return (async () => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
      const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return handleCloudBillingPublicRequest(new Request("https://directory.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${hex}` },
        body,
      }), harness.env);
    })();
  }

  const PERIOD_START_S = Math.floor((NOW - 8 * DAY) / 1000);
  const NEXT_PERIOD_S = Math.floor((NOW + 22 * DAY) / 1000);
  const renewalInvoice = {
    id: "evt_renewal",
    type: "invoice.paid",
    data: { object: { billing_reason: "subscription_cycle", period_end: NEXT_PERIOD_S, parent: { subscription_details: { subscription: "sub_1" } } } },
  };
  const paidAccount = { plan: "paid", included_milli: 300_000, used_milli: 120_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active", period_start: PERIOD_START_S * 1000 };
  const activeSubscription = {
    status: "active",
    customer: "cus_1",
    metadata: { ade_user_id: OWNER },
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_plan" }, current_period_start: NEXT_PERIOD_S, current_period_end: NEXT_PERIOD_S + 30 * 86_400 }] },
    billing_thresholds: { amount_gte: 500 },
  };

  it.each<[string, () => Promise<void>]>([
    ["a renewal delivered twice resets the hours once", async () => {
      expect((await webhook(renewalInvoice)).status).toBe(200);
      expect(usedMilli(harness)).toBe(0);
      expect(harness.row("select period_start from cloud_accounts where user_id = ?", OWNER).period_start).toBe(NEXT_PERIOD_S * 1000);

      // Time used since the renewal must survive the replay.
      harness.exec("update cloud_accounts set used_milli = 7000 where user_id = ?", OWNER);
      const stripeCalls = harness.net.calls.length;
      const replay = await webhook(renewalInvoice);

      expect(await replay.json()).toEqual({ received: true, duplicate: true });
      expect(usedMilli(harness)).toBe(7000);
      expect(harness.net.calls).toHaveLength(stripeCalls);
    }],
    ["a delivery that failed halfway gives its claim back and the retry applies", async () => {
      harness.net.once.push({ match: /GET .*\/subscriptions\/sub_1$/, reply: harness.net.reply({ error: { message: "boom" } }, 500) });
      expect((await webhook(renewalInvoice)).status).toBe(500);
      expect(usedMilli(harness)).toBe(120_000);
      expect(harness.rows("select event_id from cloud_stripe_events")).toEqual([]);

      expect((await webhook(renewalInvoice)).status).toBe(200);
      expect(usedMilli(harness)).toBe(0);
      expect(harness.row("select applied_at from cloud_stripe_events where event_id = 'evt_renewal'").applied_at).toBe(NOW);
    }],
    ["a claim left behind by a crash is retaken, and a fresh one is left alone", async () => {
      harness.insert("cloud_stripe_events", { event_id: "evt_renewal", type: "invoice.paid", received_at: NOW - 30_000 });
      expect((await webhook(renewalInvoice)).status).toBe(409);
      expect(usedMilli(harness)).toBe(120_000);

      clock += 5 * 60_000;
      expect((await webhook(renewalInvoice)).status).toBe(200);
      expect(usedMilli(harness)).toBe(0);
    }],
    ["a subscription still paying at checkout starts the plan when it activates", async () => {
      harness.exec("update cloud_accounts set plan = 'free', included_milli = 50000, used_milli = 0, stripe_subscription_id = null, stripe_status = null where user_id = ?", OWNER);
      harness.net.subscriptions.set("sub_1", { ...activeSubscription, status: "incomplete" });
      const completed = { id: "evt_checkout", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: OWNER } } };

      expect((await webhook(completed)).status).toBe(200);
      expect(harness.row("select plan, stripe_status from cloud_accounts where user_id = ?", OWNER)).toEqual(expect.objectContaining({ plan: "free", stripe_status: "incomplete" }));

      harness.net.subscriptions.set("sub_1", activeSubscription);
      expect((await webhook({ id: "evt_active", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } })).status).toBe(200);
      expect(harness.row("select plan, included_milli, stripe_status from cloud_accounts where user_id = ?", OWNER))
        .toEqual(expect.objectContaining({ plan: "paid", included_milli: 100_000, stripe_status: "active" }));
    }],
    ["a failed threshold on a plan that just activated is retried", async () => {
      harness.exec("update cloud_accounts set plan = 'free', included_milli = 50000, used_milli = 0, stripe_status = 'incomplete' where user_id = ?", OWNER);
      const { billing_thresholds: _none, ...withoutThreshold } = activeSubscription;
      harness.net.subscriptions.set("sub_1", withoutThreshold);
      const activated = { id: "evt_active", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
      harness.net.once.push({ match: /POST .*\/subscriptions\/sub_1$/, reply: harness.net.reply({ error: { message: "boom" } }, 500) });

      expect((await webhook(activated)).status).toBe(500);
      expect((await webhook(activated)).status).toBe(200);

      expect(providerCalls(harness, /POST .*\/subscriptions\/sub_1$/)).toHaveLength(2);
    }],
    ["a renewal that fails halfway changes nothing, so its retry resets the extra-hours count", async () => {
      harness.exec("update cloud_accounts set extra_reported_milli = 3000 where user_id = ?", OWNER);
      harness.injectFault((sql) => /extra_reported_milli = \?/.test(sql) && /^\s*update cloud_accounts/.test(sql));
      expect((await webhook(renewalInvoice)).status).toBe(500);
      expect(usedMilli(harness)).toBe(120_000);

      harness.injectFault(null);
      expect((await webhook(renewalInvoice)).status).toBe(200);
      expect(harness.row("select used_milli, extra_reported_milli from cloud_accounts where user_id = ?", OWNER)).toEqual(expect.objectContaining({ used_milli: 0, extra_reported_milli: 0 }));
    }],
    ["a renewal moves a subscription bought before Cloud 7 to its plan's extra-hours price, uncharged, and leaves an old extra-disk item alone", async () => {
      Object.assign(harness.env, { STRIPE_DISK_PRICE_ID: "price_disk", STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: "price_extra_plus" });
      harness.net.subscriptions.set("sub_1", { ...activeSubscription, items: { data: [
        { ...activeSubscription.items.data[0], id: "si_plan" },
        { id: "si_extra", price: { id: "price_extra", recurring: { meter: "mtr_hours" } } },
        { id: "si_disk", price: { id: "price_disk_old", recurring: { meter: "mtr_disk" } } },
      ] } });

      expect((await webhook(renewalInvoice)).status).toBe(200);

      expect(providerCalls(harness, /POST .*\/subscription_items\//).map((call) => [call.url.split("/").pop(), call.body?.price, call.body?.proration_behavior]))
        .toEqual([["si_extra", "price_extra_plus", "none"]]);
    }],
    ["a renewal moves a price a plan no longer sells to the plan's new one, and adds no second hours item", async () => {
      Object.assign(harness.env, { STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: "price_extra_plus_v2", STRIPE_EXTRA_HOURS_RETIRED_PRICE_IDS: "price_extra_pro_v1, price_extra_plus_v1" });
      harness.net.subscriptions.set("sub_1", { ...activeSubscription, items: { data: [
        { ...activeSubscription.items.data[0], id: "si_plan" },
        { id: "si_extra", price: { id: "price_extra_plus_v1", recurring: { meter: "mtr_hours" } } },
      ] } });

      expect((await webhook(renewalInvoice)).status).toBe(200);

      expect(providerCalls(harness, /POST .*\/subscription_items\//).map((call) => [call.url.split("/").pop(), call.body?.price, call.body?.proration_behavior]))
        .toEqual([["si_extra", "price_extra_plus_v2", "none"]]);
      expect(providerCalls(harness, /POST .*\/subscription_items$/)).toHaveLength(0);
    }],
  ])("Stripe: %s", async (_label, run) => {
    seedAccount(harness, OWNER, paidAccount);
    harness.net.subscriptions.set("sub_1", activeSubscription);
    await run();
  });

  it.each<[string, () => Promise<void>]>([
    ["a create the provider timed out on keeps its slot, and the tick adopts the computer", async () => {
      harness.net.once.push({ match: /POST .*\/instances$/, reply: harness.net.reply({ error: { code: "upstream_timeout" } }, 504) });
      const response = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ade_request_id: "req-create" } });
      expect(response.status).toBe(504);
      const pending = harness.rows("select instance_id from cloud_computers where instance_id like 'pending:%'");
      expect(pending).toHaveLength(1);

      provide(harness, "lateid123456", "running", { ade_request_id: "req-create" });
      await harness.tick();
      expect(harness.rows("select instance_id from cloud_computers where instance_id like 'pending:%'")).toEqual([]);
      expect(computer(harness, "lateid123456")).toEqual(expect.objectContaining({ user_id: OWNER, status: "running", awake_since: NOW, request_id: "req-create" }));
    }],
    ["a request tag is one account's: another can't take it or see that computer", async () => {
      harness.net.once.push({ match: /POST .*\/instances$/, reply: harness.net.reply({ error: { code: "upstream_timeout" } }, 504) });
      const body = { type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ade_request_id: "req-mine" } };
      expect((await harness.send(OWNER, "POST", "/cloud/instances", body)).status).toBe(504);
      provide(harness, "mineid123456", "running", { ade_request_id: "req-mine" });

      expect((await harness.send(OTHER, "POST", "/cloud/instances", body)).status).toBe(400);
      const list = await (await harness.send(OTHER, "GET", "/cloud/instances")).json() as { data: unknown[] };
      expect(list.data).toEqual([]);
      expect(harness.rows("select user_id from cloud_computers where instance_id like 'pending:%'")).toEqual([{ user_id: OWNER }]);
    }],
    ["a copy the provider timed out on keeps its slot", async () => {
      seedComputer(harness);
      provide(harness);
      harness.net.once.push({ match: /POST .*\/fork$/, reply: new Error("connection reset") });
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/fork`, { metadata: { ade_request_id: "req-copy" } })).status).toBe(502);
      expect(harness.rows("select request_id from cloud_computers where instance_id like 'pending:%'")).toEqual([expect.objectContaining({ request_id: "req-copy" })]);
    }],
    // An older desktop put the person's saved keys and Claude token in a new
    // computer's env; the host keeps that env in plain text for the computer's life.
    ["a create keeps only the client's ADE version in the new computer's env, never a sign-in or a launch's join", async () => {
      const response = await harness.send(OWNER, "POST", "/cloud/instances", {
        type: "default",
        resources: { cpu: 2, memory: 4 },
        env: {
          ADE_MIN_VERSION: "1.4.2-beta.3",
          OPENAI_API_KEY: "fixture-openai-value",
          CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-value",
          OPENROUTER_API_KEY: "fixture-openrouter-value",
          ADE_LAUNCH_ID: "forged-launch",
          ADE_LAUNCH_JOIN: "forged-join",
        },
      });
      expect(response.status).toBe(201);
      expect(providerCalls(harness, /POST .*\/instances$/)[0]?.body?.env).toEqual({ ADE_MIN_VERSION: "1.4.2-beta.3" });
      // A version-named variable that is not a version is dropped too: the entrypoint passes it to an install.
      await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, env: { ADE_MIN_VERSION: "1.0.0; curl x" } });
      expect(providerCalls(harness, /POST .*\/instances$/)[1]?.body).not.toHaveProperty("env");
    }],
    ["a provider that refuses ADE's key is ADE's problem, and leaves nothing behind", async () => {
      harness.net.once.push({ match: /POST .*\/instances$/, reply: harness.net.reply({ error: { code: "invalid_api_key" } }, 401) });
      const response = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } });
      expect(response.status).toBe(502);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_api_key");
      expect(harness.rows("select instance_id from cloud_computers where instance_id like 'pending:%'")).toEqual([]);
    }],
    ["a move gets the source computer's disk, and goes at the free plan's computer limit (its computer replaces the old one)", async () => {
      harness.exec("update cloud_accounts set plan = 'paid', included_milli = 500000 where user_id = ?", OWNER);
      seedComputer(harness, { disk_gb: 12 });
      provide(harness);
      const moved = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE });
      expect(moved.status).toBe(201);
      expect(providerCalls(harness, /POST .*\/instances$/)[0]?.body?.resources).toEqual({ cpu: 2, memory: 4, disk: 12 });

      // That move failed (its new computer is gone); another computer holds 4 GB.
      harness.exec("update cloud_computers set deleted_at = ? where instance_id = 'madenew12345'", NOW);
      seedComputer(harness, { instance_id: SECOND, disk_gb: 4 });
      harness.exec("update cloud_accounts set plan = 'free' where user_id = ?", OWNER);
      const atLimit = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE });
      expect(atLimit.status).toBe(201);
      expect(providerCalls(harness, /POST .*\/instances$/)[1]?.body?.resources).toEqual({ cpu: 2, memory: 4, disk: 12 });
    }],
    ["a copy can't shrink a disk", async () => {
      seedComputer(harness, { disk_gb: 8 });
      provide(harness);
      const refused = await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/fork`, { resources: { cpu: 2, memory: 4, disk: 4 } });
      expect(refused.status).toBe(400);
      expect(providerCalls(harness, /\/fork$/)).toEqual([]);
      expect(harness.rows("select instance_id from cloud_computers where instance_id like 'pending:%'")).toEqual([]);
    }],
    ["a request id already on a computer can't stop the tick or adopt that computer", async () => {
      seedComputer(harness, { request_id: "req-dup" });
      seedComputer(harness, { instance_id: SECOND, status: "running" });
      seedComputer(harness, { instance_id: "pending:dup", request_id: "req-dup", status: "provisioning", awake_since: null, created_at: NOW });
      provide(harness, INSTANCE, "running", { ade_request_id: "req-dup" });
      provide(harness, SECOND, "sleeping");

      await harness.tick();

      // The rest of the tick still ran.
      expect(computer(harness, SECOND).status).toBe("sleeping");
      expect(computer(harness, "pending:dup").status).toBe("provisioning");
      expect(computer(harness).user_id).toBe(OWNER);

      clock += 16 * 60_000;
      await harness.tick();
      expect(harness.rows("select instance_id from cloud_computers where instance_id = 'pending:dup'")).toEqual([]);
    }],
    ["a sleeping computer that just woke isn't put back to sleep", async () => {
      seedComputer(harness, { status: "sleeping", awake_since: null, machine_key: "key-a", last_awake_at: NOW - 2 * DAY });
      harness.insert("machines", { user_id: OWNER, machine_key: "key-a", last_seen_at: NOW - DAY });
      provide(harness, INSTANCE, "running");
      await harness.tick();
      expect(providerCalls(harness, /POST .*\/sleep$/)).toEqual([]);
      expect(computer(harness).awake_since).toBe(NOW);
    }],
    ["a deleted account loses its plan, computers and saved chats even with analytics off", async () => {
      harness.exec("update cloud_accounts set plan = 'paid', stripe_subscription_id = 'sub_1', stripe_status = 'active' where user_id = ?", OWNER);
      seedComputer(harness);
      provide(harness);
      harness.insert("cloud_user_keys", { user_id: OWNER, sealed_key: "v1.x.y", created_at: NOW });
      // Its status menu's facts carry no user id: they go with the computer.
      harness.insert("cloud_instance_events", { delivery_id: "evt_1", instance_id: INSTANCE, status: "running", at: NOW - DAY, received_at: NOW - DAY });
      harness.insert("cloud_computer_activity", { instance_id: INSTANCE, busy: 0, running_agents: 0, reported_at: NOW - DAY });
      harness.net.subscriptions.set("sub_1", activeSubscription);
      const response = await deleteAccountOverClerk();

      expect(response.status).toBe(200);
      expect(providerCalls(harness, /DELETE .*\/subscriptions\/sub_1$/)).toHaveLength(1);
      expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(1);
      expect(harness.row("select plan, stripe_subscription_id from cloud_accounts where user_id = ?", OWNER)).toEqual(expect.objectContaining({ plan: "free", stripe_subscription_id: null }));
      expect(computer(harness).deleted_at).toBe(NOW);
      expect(harness.rows("select user_id from cloud_user_keys where user_id = ?", OWNER)).toEqual([]);
      expect([...harness.rows("select instance_id from cloud_instance_events"), ...harness.rows("select instance_id from cloud_computer_activity")]).toEqual([]);
      // Its vault and settings live in the push relay's D1, so the relay is asked to remove them.
      expect(harness.relayCalls).toEqual([
        { method: "DELETE", url: `https://relay.test/directory/accounts/${OWNER}`, directoryAuth: "directory-secret" },
      ]);
    }],
    ["an account deleted while its create runs still loses the computer it was making", async () => {
      harness.net.after.push({ match: /POST .*\/instances$/, run: async () => { expect((await deleteAccountOverClerk()).status).toBe(200); } });
      expect((await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ade_request_id: "req-gone" } })).status).toBe(201);

      await harness.tick();

      expect(providerCalls(harness, /DELETE .*\/instances\/madenew12345$/)).toHaveLength(1);
      expect(harness.row("select reason from cloud_delete_log where instance_id = 'madenew12345'").reason).toBe("account_deleted");
    }],
    ["a grow whose answer was lost goes to the provider again on retry", async () => {
      harness.exec("update cloud_accounts set plan = 'paid', included_milli = 500000 where user_id = ?", OWNER);
      seedComputer(harness, { status: "sleeping", awake_since: null });
      provide(harness, INSTANCE, "sleeping");
      harness.net.once.push({ match: /POST .*\/resize$/, reply: harness.net.reply({ error: { code: "upstream_timeout" } }, 504) });
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8 })).status).toBe(504);

      // The first try woke it (the provider resizes only an awake computer), so the retry says it's idle.
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8, computerIdle: true })).status).toBe(200);

      expect(providerCalls(harness, /POST .*\/resize$/).map((call) => call.body?.disk)).toEqual([8, 8]);
      expect(computer(harness).disk_gb).toBe(8);
    }],
    ["a grow that never happened gives its room in the shared disk back", async () => {
      harness.exec("update cloud_accounts set plan = 'paid', included_milli = 500000 where user_id = ?", OWNER);
      seedComputer(harness, { status: "sleeping", awake_since: null });
      provide(harness, INSTANCE, "sleeping");
      harness.net.once.push({ match: /POST .*\/resize$/, reply: new Error("connection reset") });
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8 })).status).toBe(502);
      expect(computer(harness).disk_gb).toBe(8);

      // The provider's size can lag a grow that is still landing, so nothing is released yet.
      await harness.tick();
      expect(computer(harness).disk_gb).toBe(8);

      harness.exec("update cloud_computers set disk_reserved_at = ? where instance_id = ?", NOW - 11 * 60_000, INSTANCE);
      await harness.tick();

      expect(computer(harness).disk_gb).toBe(4);
    }],
    ["one account's failure doesn't cost another account its stop at 0 hours", async () => {
      seedAccount(harness, OTHER, { used_milli: 100_000 });
      harness.exec("update cloud_accounts set used_milli = 100000 where user_id = ?", OWNER);
      seedComputer(harness, { awake_since: NOW - 60_000 });
      seedComputer(harness, { instance_id: SECOND, user_id: OTHER, awake_since: NOW - 60_000 });
      provide(harness);
      provide(harness, SECOND);
      harness.injectFault((sql, params) => /set warned_zero_at/.test(sql) && params.includes(OWNER));

      await harness.tick();

      expect(computer(harness, SECOND).status).toBe("stopped");
      expect(computer(harness).status).toBe("running");
    }],
  ])("%s", async (_label, run) => {
    seedAccount(harness, OWNER);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    await run();
  });

  // Money: extra disk, plan changes and the owner's limit (docs/plans/ade-cloud-plans-and-disk.md).
  const MONEY_ENV = { STRIPE_PRO_PRICE_ID: "price_pro" };
  /** Each plan's own extra-hours price (Cloud 7); `price_extra` stays the first, graduated one older subscriptions hold. */
  const EXTRA_PRICES = { STRIPE_MAX_PRICE_ID: "price_max", STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: "price_extra_plus", STRIPE_EXTRA_HOURS_PRO_PRICE_ID: "price_extra_pro", STRIPE_EXTRA_HOURS_MAX_PRICE_ID: "price_extra_max" };
  const plusAccount = { plan: "paid", paid_plan: "plus", included_milli: 300_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" };
  const proAccount = { ...plusAccount, paid_plan: "pro", included_milli: 1_600_000 };
  const DAY_ONE = "2026-11-09";
  const errorOf = async (response: Response) => ((await response.json()) as { error?: { code?: string; reason?: string; lanes?: Array<{ laneName: string; diskGb: number }> } }).error ?? null;
  const accountRow = () => harness.row("select plan, paid_plan, paid_plan_next, included_milli from cloud_accounts where user_id = ?", OWNER);

  /** Stopped computers holding `disks` GB, each the same size at the provider. */
  function seedStopped(disks: number[], size: { type: string; cpu: number; memory: number } = { type: "default", cpu: 2, memory: 4 }): void {
    disks.forEach((disk, index) => {
      const id = [INSTANCE, SECOND][index] ?? `stopped${String(index).padStart(5, "0")}`;
      seedComputer(harness, { instance_id: id, type: size.type, cpu: size.cpu, memory_gb: size.memory, disk_gb: disk, status: "stopped", awake_since: null, last_awake_at: NOW - 2 * DAY });
      const instance = provide(harness, id, "stopped");
      instance.type = size.type;
      instance.resources = { cpu: size.cpu, memory: size.memory, disk };
    });
  }

  const XLARGE = { type: "vm", cpu: 4, memory: 16 };
  // No account-wide disk (Pricing v2): a grow passes inside its size's own disk, whatever the
  // account's other computers hold, and is refused past it.
  it.each<[string, Row, { type: string; cpu: number; memory: number }, number, number, number, string | null]>([
    ["a grow inside the size's disk passes beside another computer's disk", plusAccount, XLARGE, 28, 100, 200, null],
    ["a grow past the size's disk is refused", plusAccount, XLARGE, 28, 104, 403, "tier_limit"],
    ["a free Small grows to its 12 GB beside another computer's disk", {}, { type: "default", cpu: 2, memory: 4 }, 8, 12, 200, null],
    ["a free Small can't grow past its 12 GB", {}, { type: "default", cpu: 2, memory: 4 }, 8, 16, 403, "tier_limit"],
  ])("disk grow: %s", async (_label, account, size, fromGb, toGb, status, reason) => {
    Object.assign(harness.env, MONEY_ENV);
    seedAccount(harness, OWNER, account);
    seedStopped([fromGb, 12], size);

    const response = await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: size.cpu, memory: size.memory, disk: toGb });

    expect(response.status).toBe(status);
    expect((await errorOf(response))?.reason ?? null).toBe(reason);
    expect(computer(harness).disk_gb).toBe(reason ? fromGb : toGb);
    expect(providerCalls(harness, /POST .*\/resize$/)).toHaveLength(reason ? 0 : 1);
  });

  const planItem = () => ((harness.net.subscriptions.get("sub_1")?.items as { data: Row[] }).data[0]!.price as Row).id;
  const itemCalls = () => providerCalls(harness, /POST .*\/subscription_items\/si_plan$/);
  function seedSubscribed(account: Row, price: string, disks: number[]): void {
    seedAccount(harness, OWNER, account);
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [{ id: "si_plan", price: { id: price } }, { id: "si_extra", price: { id: "price_extra" } }] } });
    seedStopped(disks);
  }
  const checkout = (plan: string) => harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan, knowsMax: true });

  it.each<[string, () => Promise<void>]>([
    ["Pro to Plus above Plus's computers is accepted for the period end, and names what Plus's limits free", async () => {
      seedSubscribed(proAccount, "price_pro", [28, 22, 4, 4]);
      const response = await checkout("plus");
      expect(response.status).toBe(200);
      const body = await response.json() as { change: string; cleanup?: { planId: string; computerCount: number; computerLimit: number; usedGb: number; limitGb: number; computers: unknown[] } };
      expect(body.change).toBe("next_period");
      // Older builds compared disk: they read a limit equal to the disk used, so they never ask for a pick over disk.
      expect(body.cleanup).toEqual(expect.objectContaining({ planId: "plus", computerCount: 4, computerLimit: 3, usedGb: 58, limitGb: 58 }));
      expect(body.cleanup?.computers).toHaveLength(1);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: "plus" }));
    }],
    ["Pro to Plus that fits waits for the period end, and Stay on Pro undoes it uncharged", async () => {
      seedSubscribed(proAccount, "price_pro", [12, 8]);
      expect(await (await checkout("plus")).json()).toEqual({ url: null, change: "next_period" });
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: "plus", included_milli: 1_600_000 }));
      expect(planItem()).toBe("price_plan");

      expect((await checkout("pro")).status).toBe(200);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: null, included_milli: 1_600_000 }));
      expect(planItem()).toBe("price_pro");
      expect(itemCalls().map((call) => [call.body?.price, call.body?.proration_behavior, call.body?.payment_behavior ?? null]))
        .toEqual([["price_plan", "none", null], ["price_pro", "none", null]]);
    }],
    ["Pro with a move to Plus waiting, then Max: the item goes back to Pro uncharged, so Max is charged from what was paid", async () => {
      Object.assign(harness.env, EXTRA_PRICES);
      seedSubscribed({ ...proAccount, paid_plan_next: "plus" }, "price_plan", [4]);
      expect((await checkout("max")).status).toBe(200);
      expect(planItem()).toBe("price_max");
      expect(itemCalls().map((call) => [call.body?.price, call.body?.proration_behavior]))
        .toEqual([["price_pro", "none"], ["price_max", "always_invoice"]]);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "max", paid_plan_next: null }));
    }],
    ["a Max plan isn't changed from a build that doesn't know Max (it reads Max as Plus)", async () => {
      Object.assign(harness.env, EXTRA_PRICES);
      seedSubscribed({ ...proAccount, paid_plan: "max", included_milli: 5_000_000 }, "price_max", [4]);
      const response = await harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan: "pro" });
      expect(response.status).toBe(409);
      expect((await errorOf(response))?.code).toBe("update_needed");
      expect(itemCalls()).toHaveLength(0);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "max", paid_plan_next: null }));
    }],
    ["Plus to Pro with a declined card leaves the plan, the hours and the item as they were", async () => {
      seedSubscribed(plusAccount, "price_plan", [4]);
      harness.net.once.push({ match: /POST .*\/subscription_items\/si_plan$/, reply: harness.net.reply({ error: { message: "Your card was declined." } }, 402) });
      const response = await checkout("pro");
      expect(response.status).toBe(402);
      expect((await errorOf(response))?.code).toBe("payment_failed");
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "plus", paid_plan_next: null, included_milli: 300_000 }));
      expect(planItem()).toBe("price_plan");
    }],
    ["a Stripe answer whose item isn't on the new price writes nothing", async () => {
      seedSubscribed(plusAccount, "price_plan", [4]);
      harness.net.once.push({ match: /POST .*\/subscription_items\/si_plan$/, reply: harness.net.reply({ id: "si_plan", price: { id: "price_plan" } }) });
      const response = await checkout("pro");
      expect(response.status).toBe(409);
      expect((await errorOf(response))?.code).toBe("plan_change_refused");
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "plus", included_milli: 300_000 }));
      expect(planItem()).toBe("price_plan");
    }],
    ["a grow counts in the day's disk only once the provider made it: refused never, a lost answer from the old size until the tick sees it", async () => {
      seedAccount(harness, OWNER, plusAccount);
      seedStopped([40], XLARGE);
      const grow = () => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 4, memory: 16, disk: 52 });
      const peak = () => harness.row("select peak_gb from cloud_disk_days where user_id = ? and day = ?", OWNER, DAY_ONE).peak_gb;
      harness.net.once.push({ match: /POST .*\/resize$/, reply: harness.net.reply({ error: { code: "invalid_request" } }, 400) });
      expect((await grow()).ok).toBe(false);
      harness.net.once.push({ match: /POST .*\/resize$/, reply: harness.net.reply({ error: { code: "upstream_timeout" } }, 504) });
      expect((await grow()).ok).toBe(false);
      await harness.tick();
      expect(peak()).toBe(40);

      // The grow landed and the computer woke: the tick settles it without waiting for it to rest.
      Object.assign(harness.net.instances.get(INSTANCE)!, { status: "running", resources: { cpu: 4, memory: 16, disk: 52 } });
      clock += 60_000;
      await harness.tick();
      expect(computer(harness).disk_reserved_at).toBeNull();
      clock += DAY;
      await harness.tick();
      expect(peak()).toBe(52);
    }],
    ["a move's old computer counts once while the move runs, and again if it outlives the move", async () => {
      seedAccount(harness, OWNER);
      harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
      seedStopped([8]);
      const wakeOld = () => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, {});
      const moveFrom = (id: string) => harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: id });
      const counted = async () => ((await (await harness.send(OWNER, "GET", "/cloud/account")).json()) as { disk: { usedGb: number }; computers: { total: number } });
      expect((await moveFrom(INSTANCE)).status).toBe(201);
      expect(await counted()).toMatchObject({ disk: { usedGb: 8 }, computers: { total: 1 } });
      expect((await wakeOld()).status).toBe(200);
      // One move at a time: neither the new computer nor the old one starts another while it runs.
      for (const id of ["madenew12345", INSTANCE]) expect((await errorOf(await moveFrom(id)))?.code).toBe("computer_busy");

      clock += 3 * HOUR;
      await harness.tick();
      expect(await counted()).toMatchObject({ disk: { usedGb: 16 }, computers: { total: 2 } });
    }],
    ["the owner's limit reached last month lets a new computer in once the month turns, with no computer left", async () => {
      seedAccount(harness, OWNER, plusAccount);
      harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "10", updated_at: NOW });
      harness.insert("cloud_settings", { key: "cost_mtd_micros", value: "10000000", updated_at: NOW });
      clock = Date.UTC(2026, 11, 1, 3);
      await harness.tick();
      expect((await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } })).status).toBe(201);
    }],
    ["the owner hears once per $50 the month's cost passes: once on crossing, never inside a step, and with no limit set", async () => {
      await costChecks([[40, 0], [60, 1], [90, 1]]);
      expect(stepEmails()[0]).toContain("$50");
    }],
    ["a jump over several $50 steps sends one email, for the highest below the limit", async () => {
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "1000", updated_at: NOW });
      await costChecks([[40, 0], [170, 1]]);
      expect(stepEmails()[0]).toContain("$150");
    }],
    ["two owner checks at once send one email for a step", async () => {
      setMonthCost(60);
      clock += 11 * 60_000;
      await Promise.all([harness.tick(), harness.tick()]);
      expect(stepEmails()).toHaveLength(1);
    }],
    ["a step email that fails is sent again by the next check", async () => {
      harness.net.once.push({ match: /POST https:\/\/api\.resend\.com\/emails$/, reply: harness.net.reply({ message: "busy" }, 503) });
      await costChecks([[60, 1], [60, 2]]);
    }],
    ["a new month starts the steps again at $50", async () => {
      await costChecks([[60, 1]]);
      clock = Date.UTC(2026, 11, 1, 12) - 11 * 60_000;
      harness.exec("update cloud_settings set value = '2026-12-01' where key = 'last_daily_day'");
      harness.insert("cloud_computer_days", { instance_id: INSTANCE, day: "2026-12-01", user_id: OWNER, multiplier_milli: 1000, cost_micros: 55_000_000 });
      await costChecks([[null, 2]]);
      expect(stepEmails()[1]).toContain("$50");
    }],
    ["the cap counts free use only: paid use past it sends the step email and no cap email", async () => {
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "100", updated_at: NOW });
      await costChecks([[120, 1]]);
      expect(stepEmails()).toEqual(["ADE Cloud passed $100 this month"]);
    }],
    ["free use past 50% of the cap emails once; a cap email that fails is sent again by the next check", async () => {
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "60", updated_at: NOW });
      harness.net.once.push({ match: /POST https:\/\/api\.resend\.com\/emails$/, reply: harness.net.reply({ message: "busy" }, 503) });
      setMonthCost(40, 40);
      await costChecks([[null, 1], [null, 2], [null, 2]]);
      expect(stepEmails()).toEqual(["ADE Cloud free use passed 50% of your cap", "ADE Cloud free use passed 50% of your cap"]);
    }],
    ["Plus to Pro moves extra hours to Pro's own price at once, uncharged; a move down keeps it until the renewal", async () => {
      Object.assign(harness.env, EXTRA_PRICES);
      seedSubscribed(plusAccount, "price_plan", [4]);
      expect((await checkout("pro")).status).toBe(200);
      expect((await checkout("plus")).status).toBe(200);
      expect(providerCalls(harness, /POST .*\/subscription_items\/si_extra$/).map((call) => [call.body?.price, call.body?.proration_behavior]))
        .toEqual([["price_extra_pro", "none"]]);
    }],
  ])("plans and billing: %s", async (_label, run) => {
    Object.assign(harness.env, MONEY_ENV, { RESEND_API_KEY: "resend-key", CLOUD_ALERT_EMAIL: "owner@example.test" });
    await run();
  });

  it.each<[string, string, string]>([
    ["plus", "price_plan", "price_extra_plus"],
    ["pro", "price_pro", "price_extra_pro"],
    ["max", "price_max", "price_extra_max"],
  ])("a new %s subscription sells only the plan; extra hours join at that plan's own price when turned on, once", async (plan, planPrice, extraPrice) => {
    Object.assign(harness.env, MONEY_ENV, EXTRA_PRICES);
    seedAccount(harness, OWNER, { stripe_customer_id: "cus_1" });
    harness.net.once.push({ match: /POST .*\/checkout\/sessions$/, reply: harness.net.reply({ url: "https://checkout.stripe.test/s" }) });

    const response = await harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan });

    expect(response.status).toBe(200);
    const session = providerCalls(harness, /POST .*\/checkout\/sessions$/)[0]?.body ?? {};
    expect(Object.keys(session).filter((key) => key.startsWith("line_items[")).sort()).toEqual(["line_items[0][price]", "line_items[0][quantity]"]);
    expect(session["line_items[0][price]"]).toBe(planPrice);

    // Bought: the subscription holds the plan alone until extra hours go on.
    harness.exec("update cloud_accounts set plan = 'paid', paid_plan = ?, stripe_subscription_id = 'sub_1', stripe_status = 'active' where user_id = ?", plan, OWNER);
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [{ id: "si_plan", price: { id: planPrice } }] } });
    const extraHours = (enabled: boolean) => harness.send(OWNER, "POST", "/cloud/billing/extra-hours", { enabled });
    const added = () => providerCalls(harness, /POST .*\/subscription_items$/).map((call) => [call.body?.subscription, call.body?.price]);
    expect((await extraHours(true)).status).toBe(200);
    expect(added()).toEqual([["sub_1", extraPrice]]);
    // Off leaves the item at zero (what was used before still bills); on again adds nothing.
    expect((await extraHours(false)).status).toBe(200);
    expect((await extraHours(true)).status).toBe(200);
    expect(added()).toHaveLength(1);
    expect(providerCalls(harness, /DELETE .*\/subscription_items\//)).toHaveLength(0);
    expect(harness.row("select extra_enabled from cloud_accounts where user_id = ?", OWNER).extra_enabled).toBe(1);
  });

  // Where Stripe sends the person back comes only from this server's own settings, never from the request.
  it.each<[string, Row, Record<string, unknown>, { success: string; cancel: string } | null]>([
    ["no returnTo: this server's page, on the request's origin", {}, {}, { success: "https://directory.test/billing/return?to=done&plan=plus", cancel: "https://directory.test/billing/return?to=cancelled" }],
    ["no returnTo with BILLING_RETURN_ORIGIN: the clean domain", { BILLING_RETURN_ORIGIN: "https://account.ade.test" }, {}, { success: "https://account.ade.test/billing/return?to=done&plan=plus", cancel: "https://account.ade.test/billing/return?to=cancelled" }],
    ["returnTo web: the web client's own origin", { WEB_CLIENT_ORIGIN: "https://app.ade.test" }, { returnTo: "web" }, { success: "https://app.ade.test/?cloudReturn=done", cancel: "https://app.ade.test/?cloudReturn=cancelled" }],
    ["returnTo web with no web client set up is refused", {}, { returnTo: "web" }, null],
    ["a returnTo naming an address is refused", { WEB_CLIENT_ORIGIN: "https://app.ade.test" }, { returnTo: "https://evil.test" }, null],
  ])("checkout's way back: %s", async (_label, env, extra, expected) => {
    Object.assign(harness.env, MONEY_ENV, env);
    seedAccount(harness, OWNER, { stripe_customer_id: "cus_1" });
    harness.net.once.push({ match: /POST .*\/checkout\/sessions$/, reply: harness.net.reply({ url: "https://checkout.stripe.test/s" }) });

    const response = await harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan: "plus", ...extra });

    const sessions = providerCalls(harness, /POST .*\/checkout\/sessions$/);
    if (!expected) {
      expect(response.status).toBe(400);
      expect(sessions).toHaveLength(0);
      return;
    }
    expect(response.status).toBe(200);
    expect(sessions[0]?.body?.success_url).toBe(expected.success);
    expect(sessions[0]?.body?.cancel_url).toBe(expected.cancel);
  });

  const ITEM_CREATE = /POST .*\/subscription_items$/;
  it.each<[string, Row, Row[], { status: number; times?: number; landed?: boolean } | null, number, string[]]>([
    // A subscription bought before Cloud 8 already bills extra hours (on the first price until its renewal moves it).
    ["a subscription that already has an hours item gets no second one", plusAccount, [{ id: "si_plan", price: { id: "price_plan" } }, { id: "si_extra", price: { id: "price_extra" } }], null, 200, []],
    // Pro with a move to Plus waiting still pays Pro's hour until the renewal.
    ["a downgrade waiting adds the hour of the plan in force", { ...proAccount, paid_plan_next: "plus" }, [{ id: "si_plan", price: { id: "price_plan" } }], null, 200, ["price_extra_pro"]],
    // Stripe answers a key's 500 again for a day: one more try under a key of its own.
    ["a 500 with no item held tries once more under a new key", plusAccount, [{ id: "si_plan", price: { id: "price_plan" } }], { status: 500 }, 200, ["price_extra_plus", "price_extra_plus"]],
    ["Stripe refusing the item twice leaves extra hours off", plusAccount, [{ id: "si_plan", price: { id: "price_plan" } }], { status: 500, times: 2 }, 503, ["price_extra_plus", "price_extra_plus"]],
    // A second turn-on raced this one and its item landed: that item is all that's needed.
    ["a 409 while another turn-on's item landed still turns extra hours on", plusAccount, [{ id: "si_plan", price: { id: "price_plan" } }], { status: 409, landed: true }, 200, ["price_extra_plus"]],
    ["a 409 with no item held leaves extra hours off", plusAccount, [{ id: "si_plan", price: { id: "price_plan" } }], { status: 409 }, 503, ["price_extra_plus"]],
  ])("extra hours on: %s", async (_label, account, items, refuse, status, triedPrices) => {
    Object.assign(harness.env, MONEY_ENV, EXTRA_PRICES);
    seedAccount(harness, OWNER, account);
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: items } });
    for (let index = 0; index < (refuse?.times ?? (refuse ? 1 : 0)); index += 1) {
      harness.net.once.push({ match: ITEM_CREATE, reply: harness.net.reply({ error: { message: "no" } }, refuse!.status) });
    }
    if (refuse?.landed) {
      harness.net.after.push({ match: ITEM_CREATE, run: () => {
        harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [...items, { id: "si_raced", price: { id: "price_extra_plus" } }] } });
      } });
    }

    const response = await harness.send(OWNER, "POST", "/cloud/billing/extra-hours", { enabled: true });

    expect(response.status).toBe(status);
    const creates = providerCalls(harness, ITEM_CREATE);
    expect(creates.map((call) => call.body?.price)).toEqual(triedPrices);
    // Each try has its own key: a repeated key would only get the first answer back.
    expect(new Set(creates.map((call) => call.idempotencyKey)).size).toBe(creates.length);
    // Never on without an item to bill it: an extra hour would be free.
    expect(harness.row("select extra_enabled from cloud_accounts where user_id = ?", OWNER).extra_enabled).toBe(status === 200 ? 1 : 0);
  });

  // The plan's computer limit (Pricing v2): asleep computers count, and the count is part of the
  // reservation's one insert, so creates at once can't pass it together. A move's count leaves its
  // own source out, but another running move's source counts: a source can outlive its move, so two
  // moves at once can't leave the account over. (The hidden awake cap, 25, is above every plan's
  // limit: a create meets the limit first.) A move whose reservation timed out stops counting, and
  // its source counts again at once, before the tick cleans the move up.
  it.each<[string, number, "create" | "move" | "move one computer twice" | "create after a timed-out move", Array<201 | "computer_limit" | "computer_busy" | "over_plan_limits">]>([
    ["19 asleep computers on Max don't stop a new one", 19, "create", [201]],
    ["20 asleep computers on Max stop a new one, with what the limit card shows", 20, "create", ["computer_limit"]],
    ["two creates at once with room for one: one is made, the other meets the limit", 19, "create", [201, "computer_limit"]],
    ["a move at the limit goes (its computer replaces the old one)", 20, "move", [201]],
    ["two moves at once at the limit: one goes, the other meets the limit", 20, "move", [201, "computer_limit"]],
    ["two moves of one computer at once at the limit: one goes, the other finds it busy", 20, "move one computer twice", [201, "computer_busy"]],
    ["an account already over its limit is refused a move like a create", 21, "move", ["over_plan_limits"]],
    ["a move whose reservation timed out counts its source again", 20, "create after a timed-out move", ["computer_limit"]],
  ])("computer limit: %s", async (_label, count, kind, outcomes) => {
    seedAccount(harness, OWNER, { plan: "paid", paid_plan: "max", included_milli: 1_500_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" });
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    const idOf = (index: number) => `cap${String(index).padStart(9, "0")}`;
    for (let index = 0; index < count; index += 1) {
      seedComputer(harness, { instance_id: idOf(index), disk_gb: 4, status: "stopped", awake_since: null, last_awake_at: NOW - index * 60_000 });
      provide(harness, idOf(index), "stopped");
    }
    if (kind === "create after a timed-out move") {
      seedComputer(harness, { instance_id: "pending:timed-out-move", moving_from: idOf(0), status: "provisioning", awake_since: null, created_at: NOW - 16 * 60_000 });
      const state = (await (await harness.send(OWNER, "GET", "/cloud/account")).json()) as { computers: { total: number } };
      expect(state.computers.total).toBe(count);
    }

    // Each move starts from its own computer, but for the one moved twice.
    let sent = 0;
    const send = () => {
      const index = sent++;
      const source = kind === "move" ? idOf(index) : kind === "move one computer twice" ? idOf(0) : null;
      return harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, ...(source ? { moveFromInstanceId: source } : {}) });
    };
    // A second request lands its whole request after the first passed every check and before its reservation is written.
    const others: Response[] = [];
    if (outcomes.length === 2) landBefore(/insert into cloud_computers/, async () => { others.push(await send()); });
    const responses = [await send(), ...others];

    const outcomeOf = async (response: Response) => (response.status === 201 ? 201 : ((await response.clone().json()) as { error: { code: string } }).error.code);
    expect((await Promise.all(responses.map(outcomeOf))).sort()).toEqual([...outcomes].sort());
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(outcomes.filter((outcome) => outcome === 201).length);
    const refused = responses.find((response) => response.status === 403);
    if (refused && outcomes.includes("computer_limit")) {
      const error = ((await refused.json()) as { error: { code: string; planId: string; limit: number; total: number; lanes: Array<{ instanceId: string }>; nextPlan: unknown } }).error;
      expect(error).toMatchObject({ code: "computer_limit", planId: "max", limit: 20, total: 20, nextPlan: null });
      // Least recently used first: the computer awake longest ago leads the card.
      // The race's winner is one of the 20 (its reservation counts the moment it is made).
      expect(error.lanes).toHaveLength(count + outcomes.filter((outcome) => outcome === 201).length);
      expect(error.lanes[0]?.instanceId).toBe(idOf(count - 1));
    }
  });

  // Outside agents (ADE MCP) may use ADE Cloud only on a paid plan; each route that makes or wakes a computer checks it.
  it.each<[string, "free" | "plus", "create" | "start" | "resize", boolean]>([
    ["a create on the free plan is refused", "free", "create", true],
    ["a start on the free plan is refused", "free", "start", true],
    ["a resize on the free plan is refused (it may wake the computer)", "free", "resize", true],
    ["a create on Plus goes", "plus", "create", false],
    ["a start on Plus goes", "plus", "start", false],
    ["a resize on Plus goes", "plus", "resize", false],
  ])("an outside agent: %s", async (_label, plan, action, refusedExpected) => {
    seedAccount(harness, OWNER, plan === "plus"
      ? { plan: "paid", paid_plan: "plus", included_milli: 100_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" }
      : {});
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedComputer(harness, { status: "stopped", awake_since: null });
    provide(harness, INSTANCE, "stopped");

    const response = action === "create"
      ? await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ade_made_by_agent: "mcp" } })
      : action === "start"
        ? await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, { origin: "mcp" })
        : await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 4, memory: 8, origin: "mcp" });

    const code = response.ok ? null : ((await response.clone().json()) as { error?: { code?: string; message?: string } }).error;
    const providerPath = action === "create" ? /POST .*\/instances$/ : action === "start" ? /POST .*\/start$/ : /POST .*\/resize$/;
    if (refusedExpected) {
      expect(response.status).toBe(403);
      expect(code).toMatchObject({ code: "outside_agent_free_plan", message: CLOUD_OUTSIDE_AGENT_FREE_MESSAGE });
      expect(providerCalls(harness, providerPath)).toHaveLength(0);
    } else {
      expect([response.status, code?.code ?? null]).toEqual([action === "create" ? 201 : 200, null]);
      expect(providerCalls(harness, providerPath)).toHaveLength(1);
    }
    expect(harness.rows("select instance_id from cloud_computers where deleted_at is null")).toHaveLength(refusedExpected || action !== "create" ? 1 : 2);
  });

  // The owner's alert emails (steps and the limit): every email but the daily report (the day's run is marked done, so only a new day sends one).
  const stepEmails = () => providerCalls(harness, /POST https:\/\/api\.resend\.com\/emails$/)
    .map((call) => String(call.body?.subject)).filter((subject) => !/daily report/i.test(subject));
  /** This month's settled cost, all on day one, of which `freeUsd` ran on free-plan rules. */
  function setMonthCost(usd: number, freeUsd = 0): void {
    if (!harness.rows("select 1 from cloud_accounts where user_id = ?", OWNER).length) seedAccount(harness, OWNER, plusAccount);
    if (!harness.rows("select 1 from cloud_settings where key = 'last_daily_day'").length) harness.insert("cloud_settings", { key: "last_daily_day", value: DAY_ONE, updated_at: NOW });
    harness.exec("delete from cloud_computer_days where day = ?", DAY_ONE);
    harness.insert("cloud_computer_days", { instance_id: INSTANCE, day: DAY_ONE, user_id: OWNER, multiplier_milli: 1000, cost_micros: usd * 1_000_000, free_cost_micros: freeUsd * 1_000_000 });
  }
  /** One owner check (ten minutes on) per step, each with the step emails expected after it; null keeps the cost. */
  async function costChecks(steps: Array<[number | null, number]>): Promise<void> {
    for (const [usd, emails] of steps) {
      if (usd != null) setMonthCost(usd);
      clock += 11 * 60_000;
      await harness.tick();
      expect(stepEmails()).toHaveLength(emails);
    }
  }

  // The owner's cap counts free use only: at it, an account on free-plan rules gets no new computer and no disk growth.
  it.each<[string, Row, string, string, Row, number, string | null, RegExp]>([
    ["a free account's new computer", {}, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } }, 503, "unavailable", /POST .*\/instances$/],
    ["a free account's copy", {}, "POST", `/cloud/instances/${INSTANCE}/fork`, {}, 503, "unavailable", /POST .*\/fork$/],
    ["a free account's move", {}, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE }, 503, "unavailable", /POST .*\/instances$/],
    ["a free account's disk grow", {}, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8 }, 403, "disk_limit", /POST .*\/resize$/],
    ["a past-due account is on free rules", { ...plusAccount, stripe_status: "past_due" }, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } }, 503, "unavailable", /POST .*\/instances$/],
    ["a free account's wake still works", {}, "POST", `/cloud/instances/${INSTANCE}/start`, {}, 200, null, /POST .*\/start$/],
    ["a paid account's new computer is never refused", plusAccount, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } }, 201, null, /POST .*\/instances$/],
  ])("owner's cap reached by free use: %s", async (_label, account, method, url, body, status, code, providerCall) => {
    seedAccount(harness, OWNER, account);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "10", updated_at: NOW });
    harness.insert("cloud_settings", { key: "free_cost_mtd_micros", value: "10000000", updated_at: NOW });
    seedStopped([4]);

    const response = await harness.send(OWNER, method, url, body);

    expect(response.status).toBe(status);
    expect(code ? (await errorOf(response))?.code : null).toBe(code);
    expect(providerCalls(harness, providerCall)).toHaveLength(code ? 0 : 1);
    expect(harness.rows("select instance_id from cloud_computers where deleted_at is null")).toHaveLength(status === 201 ? 2 : 1);
    expect(computer(harness).disk_gb).toBe(4);
  });

  it.each<[string, Error | null, number, string]>([
    // The row names no lane and the provider's metadata names none either: nothing to keep.
    ["the provider's metadata names no lane", null, 409, "no_lane"],
    // The provider couldn't be read and the row names no lane: the delete is refused, not guessed.
    ["the provider can't be read", new Error("upstream down"), 502, "lane_read_failed"],
  ])("a keep-the-lane delete with no lane facts deletes nothing (%s)", async (_label, readFailure, status, code) => {
    seedComputer(harness);
    provide(harness);
    if (readFailure) {
      harness.net.once.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), reply: new Error(readFailure.message) });
    }

    const response = await harness.send(OWNER, "DELETE", instancePath, { keepLane: { branchRef: "feature/lost" } });

    expect(response.status).toBe(status);
    expect((await errorOf(response))?.code).toBe(code);
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toEqual([]);
    expect(computer(harness)).toEqual(expect.objectContaining({ deleted_at: null, lane_keep_reason: null }));
  });

  // A move from the saved copy deletes the computer only while it rests right after a save of all its work.
  const SAVED_REPORT = "d".repeat(32);
  it.each<[string, string, Row, number, string | null]>([
    ["it rests with every lane saved", "sleeping", { backup_rest_at: NOW - HOUR, backup_report_id: SAVED_REPORT, backup_report_state: "current" }, 200, null],
    ["it woke after the save", "running", { backup_rest_at: NOW - HOUR, backup_report_id: SAVED_REPORT, backup_report_state: "current" }, 409, "computer_awake"],
    ["its last save failed", "sleeping", { backup_rest_at: null, backup_report_id: SAVED_REPORT, backup_report_state: "failed" }, 409, "backup_not_current"],
    ["it never saved", "sleeping", { backup_rest_at: null, backup_report_id: null }, 409, "backup_never_saved"],
  ])("a keep-the-lane delete only if saved: %s", async (_label, status, backup, expected, code) => {
    seedComputer(harness, { status, awake_since: status === "running" ? NOW : null, lane_id: "lane_pricing", lane_name: "pricing", ...backup });
    provide(harness, INSTANCE, status);

    const response = await harness.send(OWNER, "DELETE", instancePath, { reason: "moved", keepLane: { branchRef: "ade/pricing", onlyIfSaved: true } });

    expect(response.status).toBe(expected);
    expect(code ? (await errorOf(response))?.code : null).toBe(code);
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(code ? 0 : 1);
    // A refusal deletes nothing and leaves no keep-the-lane mark behind; a delete keeps the lane.
    if (code) expect(computer(harness)).toEqual(expect.objectContaining({ deleted_at: null, lane_keep_reason: null }));
    expect(harness.rows("select lane_id from cloud_lanes_without_computer")).toEqual(code ? [] : [{ lane_id: "lane_pricing" }]);
  });

  // While a move from the saved copy deletes the computer, no wake or command reaches it; a wake that got there first calls the delete off.
  it.each<[string, (() => Promise<Response>) | null, number, string | null]>([
    ["a start during the delete is refused and the delete goes on", () => harness.send(OWNER, "POST", `${instancePath}/start`, {}), 200, null],
    ["a command during the delete is refused and the delete goes on", () => harness.send(OWNER, "POST", `${instancePath}/exec`, { command: "ls" }), 200, null],
    ["a resize during the delete is refused and the delete goes on", () => harness.send(OWNER, "POST", `${instancePath}/resize`, { cpu: 2, memory: 4 }), 200, null],
    ["the computer woke just before the claim: nothing is deleted and it takes work again", null, 409, "computer_awake"],
  ])("a delete only if saved holds the computer: %s", async (_label, during, expected, code) => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { status: "sleeping", awake_since: null, lane_id: "lane_pricing", lane_name: "pricing", backup_rest_at: NOW - HOUR, backup_report_id: SAVED_REPORT, backup_report_state: "current" });
    provide(harness, INSTANCE, "sleeping");
    const refusals: Array<[number, string | undefined]> = [];
    // The first live read comes before the claim: a wake lands there. The next read comes after the claim.
    harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: () => {
      if (!during) harness.net.instances.get(INSTANCE)!.status = "running";
    } });
    harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: async () => {
      if (!during) return;
      const response = await during();
      refusals.push([response.status, (await errorOf(response))?.code]);
    } });

    const response = await harness.send(OWNER, "DELETE", instancePath, { reason: "moved", keepLane: { branchRef: "ade/pricing", onlyIfSaved: true } });

    expect([response.status, code ? (await errorOf(response))?.code : null]).toEqual([expected, code]);
    expect(refusals).toEqual(during ? [[409, "computer_deleting"]] : []);
    expect(providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/(start|exec)$`))).toEqual([]);
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(code ? 0 : 1);
    if (code) {
      // The claim is given back: a start works again.
      expect(computer(harness)).toEqual(expect.objectContaining({ idle_deleting_at: null, deleted_at: null, lane_keep_reason: null }));
      expect((await harness.send(OWNER, "POST", `${instancePath}/start`, {})).status).toBe(200);
    }
  });

  it("a delete only if saved whose close fails after the provider's delete keeps the lane, and a retry closes it with no live computer", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { status: "sleeping", awake_since: null, lane_id: "lane_pricing", lane_name: "pricing", backup_rest_at: NOW - HOUR, backup_report_id: SAVED_REPORT, backup_report_state: "current" });
    provide(harness, INSTANCE, "sleeping");
    const del = () => harness.send(OWNER, "DELETE", instancePath, { reason: "moved", keepLane: { branchRef: "ade/pricing", onlyIfSaved: true } });
    harness.injectFault((sql) => /insert into cloud_delete_log/.test(sql));

    await expect(del()).rejects.toThrow("D1_ERROR");
    harness.injectFault(null);

    expect(harness.net.instances.has(INSTANCE)).toBe(false);
    expect(computer(harness)).toEqual(expect.objectContaining({ deleted_at: null, lane_keep_reason: "freed" }));
    const retried = await del();
    expect(retried.status).toBe(200);
    expect(computer(harness).deleted_at).toBe(NOW);
    expect(harness.rows("select lane_id from cloud_lanes_without_computer")).toEqual([{ lane_id: "lane_pricing" }]);
  });

  it("a repeated create by the same account gets its first computer back, and makes no second one", async () => {
    seedAccount(harness, OWNER, plusAccount);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    const body = { type: "default", resources: { cpu: 2, memory: 4 }, metadata: { ade_request_id: "req-again" } };
    const first = await harness.send(OWNER, "POST", "/cloud/instances", body);
    expect(first.status).toBe(201);

    const again = await harness.send(OWNER, "POST", "/cloud/instances", body);

    expect(again.status).toBe(200);
    expect((await again.json() as { id: string }).id).toBe("madenew12345");
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);
    expect(harness.rows("select instance_id from cloud_computers where deleted_at is null")).toEqual([{ instance_id: "madenew12345" }]);
  });

  function deleteAccountOverClerk(): Promise<Response> {
    const secret = Buffer.from("clerk-webhook-secret-for-this-test");
    const body = JSON.stringify({ type: "user.deleted", timestamp: NOW, data: { id: OWNER, deleted: true } });
    const timestamp = String(Math.floor(NOW / 1000));
    const signature = createHmac("sha256", secret).update(`msg_del.${timestamp}.${body}`).digest("base64");
    return handleSignupAnalyticsRequest(new Request("https://directory.test/webhooks/clerk", {
      method: "POST",
      headers: { "svix-id": "msg_del", "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
      body,
    }), {
      DB: harness.DB,
      CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${secret.toString("base64")}`,
      AGENT37_API_KEY: "provider-key",
      STRIPE_SECRET_KEY: "stripe-key",
      PUSH_RELAY_URL: "https://relay.test",
      DIRECTORY_AUTH_SECRET: "directory-secret",
      ACTIVITY_RELAY: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          harness.relayCalls.push({ method: init?.method ?? "GET", url: String(input), directoryAuth: headers.get("x-ade-directory-auth") });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });
  }
});

/*
 * Earned hours, referrals and one free plan per computer (README "Referrals
 * and the free plan"). Races and hour accounting only: these have no surface
 * but the routes and the stored rows, so a test is how they are proven.
 */
describe("ADE Cloud saved chats list", () => {
  it("says whether each chat's computer still exists, and why a deleted one went", async () => {
    const data = harness;
    data.env.CLOUD_CHAT_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    seedAccount(data, OWNER);
    // Live; deleted by the person (a later provider close must not hide that); deleted by the idle cleanup; a computer whose key a live computer has again (its chat, saved by the deleted one, still exists).
    seedComputer(data, { instance_id: "live0000001", machine_key: "key-live" });
    seedComputer(data, { instance_id: "gone0000001", machine_key: "key-mine", status: "deleted", awake_since: null, deleted_at: NOW - DAY });
    seedComputer(data, { instance_id: "gone0000002", machine_key: "key-idle", status: "deleted", awake_since: null, deleted_at: NOW - 2 * DAY });
    seedComputer(data, { instance_id: "gone0000003", machine_key: "key-moved", status: "deleted", awake_since: null, deleted_at: NOW - 3 * DAY });
    seedComputer(data, { instance_id: "live0000002", machine_key: "KEY-MOVED" });
    data.insert("cloud_delete_log", { instance_id: "gone0000001", user_id: OWNER, who: "Studio", reason: "user", created_at: NOW - DAY });
    data.insert("cloud_delete_log", { instance_id: "gone0000001", user_id: OWNER, who: null, reason: "gone_from_provider", created_at: NOW - DAY + 60_000 });
    data.insert("cloud_delete_log", { instance_id: "gone0000002", user_id: OWNER, who: "system", reason: "idle_cleanup", created_at: NOW - 2 * DAY });
    const chat = (machineKey: string, chatId: string, instanceId: string | null) => data.insert("cloud_chat_copies", {
      user_id: OWNER, machine_key: machineKey, chat_id: chatId, instance_id: instanceId, r2_key: `chats/${OWNER}/${machineKey}/${chatId}/`, updated_at: NOW - HOUR,
    });
    chat("key-live", "chat-live", "live0000001");
    chat("key-mine", "chat-mine", "gone0000001");
    chat("key-idle", "chat-idle", "gone0000002");
    chat("key-moved", "chat-moved", "gone0000003");
    chat("key-unknown", "chat-unknown", null);

    const response = await data.send(OWNER, "GET", "/cloud/chats");
    expect(response.status).toBe(200);
    const { chats } = await response.json() as { chats: Array<{ chatId: string; computer: unknown }> };
    expect(Object.fromEntries(chats.map((row) => [row.chatId, row.computer]))).toEqual({
      "chat-live": { state: "exists" },
      "chat-mine": { state: "deleted", deletedAt: NOW - DAY, reason: "you" },
      "chat-idle": { state: "deleted", deletedAt: NOW - 2 * DAY, reason: "idle" },
      "chat-moved": { state: "exists" },
      "chat-unknown": null,
    });
  });
});

describe("ADE Cloud automatic updates", () => {
  // An update the provider took while the computer was asleep: it boots about a minute later on its own.
  const asleepUpdate = (startedAt: number): Row => ({
    status: "sleeping",
    awake_since: null,
    update_state: "updating",
    update_reason: "asleep",
    update_started_at: startedAt,
  });
  it.each<[string, Row, boolean]>([
    ["the boot right after an asleep update is the update's, and free", asleepUpdate(NOW - 60_000), false],
    ["a wake with no update is metered", { status: "sleeping", awake_since: null }, true],
    ["a wake long after the update's window is metered", asleepUpdate(NOW - 2 * HOUR), true],
  ])("%s", async (_label, row, charged) => {
    seedAccount(harness, OWNER);
    seedComputer(harness, row);
    provide(harness, INSTANCE, "running");
    await harness.tick();
    clock = NOW + 10 * 60_000;
    harness.net.instances.get(INSTANCE)!.status = "sleeping";
    await harness.tick();
    expect(computer(harness).status).toBe("sleeping");
    expect(usedMilli(harness) > 0).toBe(charged);
  });

  // An idle update of an awake computer opens its free window before the provider answers, which can take minutes.
  it.each<[string, boolean]>([
    ["a provider that refuses the idle update takes back its free window and power log", false],
    ["the same refusal after a tick saw the computer running meanwhile still takes them back", true],
  ])("%s", async (_label, tickDuring) => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { awake_since: NOW - HOUR, last_awake_at: NOW - HOUR });
    provide(harness, INSTANCE, "running");
    const row = computer(harness) as unknown as ComputerRow;
    const provider = {
      updateInstance: async () => {
        if (tickDuring) await harness.tick();
        throw new CloudProviderError("no", "provider_error", 500);
      },
    };
    await expect(startCloudUpdate(harness.env, provider, row, { reason: "idle", target: "tmpl_new", expectsReport: true, now: NOW })).rejects.toThrow("no");
    expect(computer(harness)).toMatchObject({ status: "running", awake_since: NOW, free_wake_started_at: null, free_wake_until: null, update_state: null });
    expect(harness.rows("select action from cloud_power_log where instance_id = ? and action = 'update'", INSTANCE)).toEqual([]);
  });
});

describe("ADE Cloud earned hours, referrals and the free plan per computer", () => {
  const COMPUTER = "a".repeat(64);
  const OTHER_COMPUTER = "b".repeat(64);
  const from = (computer: string) => ({ "x-ade-computer": computer, "x-ade-computer-platform": "darwin" });
  const stateOf = async (user = OWNER, headers: Record<string, string> = {}) =>
    (await (await harness.send(user, "GET", "/cloud/account", undefined, headers)).json()) as CloudAccountState;
  const plus = { plan: "paid", paid_plan: "plus", included_milli: 300_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" };
  const extraReports = () => providerCalls(harness, /POST .*\/billing\/meter_events$/).filter((call) => String(call.body?.identifier).startsWith("ade-extra:"));
  const ctx = () => ({ now: clock, waitUntil: undefined });
  const grants = (user: string) => harness.rows("select reason, milli from cloud_earned_hours where user_id = ? order by id", user);
  const balance = (user: string) => harness.row("select earned_granted_milli, earned_used_milli from cloud_accounts where user_id = ?", user);

  it.each<[string, Row, { state: string; earnedLeft: number; extraUsed: number; reports: number }]>([
    ["a free account past its plan's hours keeps running on earned hours",
      { used_milli: 110_000, earned_granted_milli: 20_000 }, { state: "warn80", earnedLeft: 10_000, extraUsed: 0, reports: 0 }],
    ["a free account is out once its earned hours are gone too",
      { used_milli: 120_000, earned_granted_milli: 20_000 }, { state: "zero", earnedLeft: 0, extraUsed: 0, reports: 0 }],
    ["earned hours an ended period drew are gone",
      { used_milli: 105_000, earned_granted_milli: 20_000, earned_used_milli: 15_000 }, { state: "zero", earnedLeft: 0, extraUsed: 0, reports: 0 }],
    ["an account refused the free plan runs on earned hours from its first hour",
      { included_milli: 0, free_refused_at: NOW - DAY, used_milli: 5_000, earned_granted_milli: 20_000 }, { state: "none", earnedLeft: 15_000, extraUsed: 0, reports: 0 }],
    ["paid extra hours start only after earned hours, and earned hours are never billed",
      { ...plus, extra_enabled: 1, used_milli: 303_500, earned_granted_milli: 2_000 }, { state: "warn95", earnedLeft: 0, extraUsed: 1_500, reports: 1 }],
    ["hours granted after extra hours were billed cover only what comes next",
      { ...plus, extra_enabled: 1, used_milli: 320_000, extra_reported_milli: 20_000, earned_granted_milli: 20_000 }, { state: "warn95", earnedLeft: 20_000, extraUsed: 20_000, reports: 0 }],
  ])("order of use: %s", async (_label, overrides, expected) => {
    harness.env.STRIPE_METER_EVENT = "ade_cloud_extra_hours";
    seedAccount(harness, OWNER, overrides);

    const state = await stateOf();
    await reportExtraHours(harness.env, clock);

    expect({ state: state.hours.state, earnedLeft: state.earnedHours?.leftMilli, extraUsed: state.extraHours.usedMilli, reports: extraReports().length }).toEqual(expected);
  });

  it("a period's end draws its earned hours once, even when two reads roll it at once", async () => {
    seedAccount(harness, OWNER, { period_start: NOW - 31 * DAY, period_end: NOW - HOUR, used_milli: 110_000, earned_granted_milli: 20_000 });

    // The second read rolls the period while the first, holding the old row, is about to.
    let second: CloudAccountState | null = null;
    landBefore(/select \* from cloud_computers where user_id = \? and deleted_at is null/, async () => { second = await stateOf(); });
    const first = await stateOf();

    expect(balance(OWNER)).toEqual({ earned_granted_milli: 20_000, earned_used_milli: 10_000 });
    expect([first.earnedHours?.leftMilli, second!.earnedHours?.leftMilli]).toEqual([10_000, 10_000]);
    expect(first.hours.usedMilli).toBe(0);
  });

  it("a failed payment and a paid invoice in the same period draw that period's earned hours once", async () => {
    seedAccount(harness, OWNER, { ...plus, used_milli: 320_000, earned_granted_milli: 30_000 });

    await applyCloudPlanChange(harness.env, OWNER, { stripeStatus: "past_due" }, clock);
    expect(balance(OWNER)).toEqual({ earned_granted_milli: 30_000, earned_used_milli: 20_000 });
    await applyCloudPlanChange(harness.env, OWNER, { stripeStatus: "active", plan: "paid" }, clock + HOUR);

    // The restored hours draw again when the period ends; what the cut drew came back.
    expect(balance(OWNER)).toEqual({ earned_granted_milli: 30_000, earned_used_milli: 0 });
    expect((await stateOf()).earnedHours?.leftMilli).toBe(10_000);
  });

  it.each<[string, Row, number]>([
    // A period that began on other terms (Pricing v2 halved the hours of periods already running).
    ["give back the hours the period had, not the plan's", { ...plus, included_milli: 250_000 }, 250_000],
    // Upgraded to Pro mid-period: Pro's 600 hours.
    ["give back the hours the period had after an upgrade", { ...plus, paid_plan: "pro", included_milli: 600_000 }, 600_000],
  ])("a failed payment and a paid invoice in the same period %s", async (_label, account, includedMilli) => {
    seedAccount(harness, OWNER, account);

    await applyCloudPlanChange(harness.env, OWNER, { stripeStatus: "past_due" }, clock);
    await applyCloudPlanChange(harness.env, OWNER, { stripeStatus: "active", plan: "paid" }, clock + HOUR);

    expect(harness.row("select included_milli from cloud_accounts where user_id = ?", OWNER)).toEqual({ included_milli: includedMilli });
    // No account-wide disk since Pricing v2.
    expect((await stateOf()).disk.limitGb).toBeNull();
  });

  it("two accounts using one computer at once: one gets its free plan, the other gets 0 free hours", async () => {
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    const create = { type: "default", resources: { cpu: 2, memory: 4 } };

    // OTHER claims the computer after OWNER saw it free and before OWNER's claim lands.
    landBefore(/insert into cloud_free_plan_claims/, () => harness.send(OTHER, "POST", "/cloud/instances", create, from(COMPUTER)));
    await harness.send(OWNER, "POST", "/cloud/instances", create, from(COMPUTER));

    expect(harness.rows("select user_id from cloud_free_plan_claims")).toEqual([{ user_id: OTHER }]);
    const refused = await stateOf(OWNER);
    expect(refused.freePlan).toMatchObject({ state: "refused", sentence: "This computer already used another account's free credits. Plus gives you 100 credits a month." });
    expect([refused.hours.includedMilli, refused.hours.state]).toEqual([0, "zero"]);
    expect((await stateOf(OTHER)).freePlan?.state).toBe("claimed");
  });

  it.each<[string, Array<[string, "GET" | "POST", Record<string, string>]>, Record<string, string>]>([
    ["a read never claims, so the first account to use the computer gets it",
      [[OWNER, "GET", from(COMPUTER)], [OTHER, "POST", from(COMPUTER)], [OWNER, "GET", from(COMPUTER)]], { [OWNER]: "refused", [OTHER]: "claimed" }],
    ["a reinstall on the same computer is the same claim",
      [[OWNER, "POST", from(COMPUTER)], [OWNER, "POST", from(COMPUTER)]], { [OWNER]: "claimed", [OTHER]: "unclaimed" }],
    ["an account with its own computer may use a shared one",
      [[OWNER, "POST", from(COMPUTER)], [OTHER, "POST", from(OTHER_COMPUTER)], [OTHER, "POST", from(COMPUTER)]], { [OWNER]: "claimed", [OTHER]: "claimed" }],
    ["a refused account gets its free hours back by using a computer of its own",
      [[OWNER, "POST", from(COMPUTER)], [OTHER, "GET", from(COMPUTER)], [OTHER, "POST", from(OTHER_COMPUTER)]], { [OWNER]: "claimed", [OTHER]: "claimed" }],
    ["a refused account's read from another computer (any id it sends) gives nothing back",
      [[OWNER, "POST", from(COMPUTER)], [OTHER, "GET", from(COMPUTER)], [OTHER, "GET", from(OTHER_COMPUTER)]], { [OWNER]: "claimed", [OTHER]: "refused" }],
    ["a computer that can't read its id, and the phone, claim nothing",
      [[OWNER, "POST", { "x-ade-computer": "unreadable" }], [OTHER, "POST", {}]], { [OWNER]: "unclaimed", [OTHER]: "unclaimed" }],
  ])("free plan per computer: %s", async (_label, steps, expected) => {
    seedAccount(harness, OWNER, { included_milli: 50_000 });
    seedAccount(harness, OTHER, { included_milli: 50_000 });
    for (const [user, method, headers] of steps) {
      await harness.send(user, method, method === "GET" ? "/cloud/account" : "/cloud/instances", method === "GET" ? undefined : { type: "default", resources: { cpu: 2, memory: 4 } }, headers);
    }

    const states = { [OWNER]: (await stateOf(OWNER)).freePlan?.state, [OTHER]: (await stateOf(OTHER)).freePlan?.state };
    expect(states).toEqual(expected);
    // Only a refused account loses the free plan's hours.
    for (const user of [OWNER, OTHER]) {
      expect(harness.row("select included_milli from cloud_accounts where user_id = ?", user).included_milli).toBe(expected[user] === "refused" ? 0 : 50_000);
    }
  });

  function seedReferral(friend: string, referrer: string): void {
    harness.insert("cloud_referrals", { friend_user_id: friend, referrer_user_id: referrer, entered_at: NOW - HOUR, state: "pending" });
  }

  it("two first chats at once pay the referral once: 20 hours to each account", async () => {
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    seedReferral(OTHER, OWNER);

    // The second first chat lands after the first read the referral as pending, before it pays.
    let inner: string | null = null;
    landBefore(/update cloud_referrals set state = 'rewarded'/, async () => { inner = await rewardReferralIfDue(harness.env, OTHER, ctx()); });
    const outer = await rewardReferralIfDue(harness.env, OTHER, ctx());

    expect([outer, inner].filter((outcome) => outcome === "rewarded")).toHaveLength(1);
    expect(grants(OTHER)).toEqual([{ reason: "referral_friend", milli: 20_000 }]);
    expect(grants(OWNER)).toEqual([{ reason: "referral_referrer", milli: 20_000 }]);
    expect([balance(OTHER).earned_granted_milli, balance(OWNER).earned_granted_milli]).toEqual([20_000, 20_000]);
  });

  it("a referrer's 10th and 11th rewards landing at once pay the referrer once; both friends get theirs", async () => {
    seedAccount(harness, OWNER);
    for (let index = 1; index <= 9; index += 1) {
      harness.insert("cloud_earned_hours", { user_id: OWNER, milli: 20_000, reason: "referral_referrer", reference: `user_earlier_${index}`, created_at: NOW - DAY });
    }
    seedReferral("user_friend_a", OWNER);
    seedReferral("user_friend_b", OWNER);

    // Friend B's reward is paid between friend A's read and A's payment.
    landBefore(/update cloud_referrals set state = 'rewarded'/, () => rewardReferralIfDue(harness.env, "user_friend_b", ctx()));
    await rewardReferralIfDue(harness.env, "user_friend_a", ctx());

    expect(grants(OWNER)).toHaveLength(10);
    expect(balance(OWNER).earned_granted_milli).toBe(200_000);
    expect([balance("user_friend_a").earned_granted_milli, balance("user_friend_b").earned_granted_milli]).toEqual([20_000, 20_000]);
    expect(Number(harness.row("select sum(referrer_rewarded) as paid from cloud_referrals").paid)).toBe(1);

    // Past the cap nothing comes back for the referrer: its out-of-hours warning and 30-day delete clock stay.
    harness.exec("update cloud_accounts set warned_zero_at = ?, hours_restored_at = null where user_id = ?", NOW - HOUR, OWNER);
    seedReferral("user_friend_c", OWNER);
    expect(await rewardReferralIfDue(harness.env, "user_friend_c", ctx())).toBe("rewarded");
    expect(balance("user_friend_c").earned_granted_milli).toBe(20_000);
    expect(harness.row("select warned_zero_at, hours_restored_at from cloud_accounts where user_id = ?", OWNER)).toEqual({ warned_zero_at: NOW - HOUR, hours_restored_at: null });
  });

  it.each<[string, () => void, string]>([
    ["the two accounts were seen on one computer", () => {
      harness.insert("cloud_account_computers", { user_id: OWNER, computer_hash: "shared", first_seen_at: NOW });
      harness.insert("cloud_account_computers", { user_id: OTHER, computer_hash: "shared", first_seen_at: NOW });
    }, "same_computer"],
    ["the friend's computer already gave another account its free hours", () => {
      harness.exec("update cloud_accounts set free_refused_at = ? where user_id = ?", NOW, OTHER);
    }, "friend_computer_used"],
  ])("no reward when %s, and the refusal keeps its reason", async (_label, arrange, reason) => {
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    seedReferral(OTHER, OWNER);
    arrange();

    expect(await rewardReferralIfDue(harness.env, OTHER, ctx())).toBe("refused");

    expect(harness.row("select state, reason from cloud_referrals where friend_user_id = ?", OTHER)).toEqual({ state: "refused", reason });
    expect(harness.rows("select 1 from cloud_earned_hours")).toEqual([]);
  });

  /* ---- The free plan's GitHub rules (`freePlanGithub.ts`) ---- */

  const GH_API = "https://github-api.test";
  const GH_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
  const createBody = { type: "default", resources: { cpu: 2, memory: 4 } };
  /** What GitHub's `GET /user` answers next, per call; the default names user 77, 40 days old. */
  let githubUser: Array<() => Response> = [];
  let githubCalls = 0;

  function withGithub(): void {
    Object.assign(harness.env, { GITHUB_APP_CLIENT_ID: "Iv23test", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_TOKEN_KEY: GH_TOKEN_KEY, GITHUB_API_BASE_URL: GH_API });
    githubUser = [];
    githubCalls = 0;
    const inner = harness.net.fetchStub;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(GH_API)) return inner(input, init);
      githubCalls += 1;
      const next = githubUser.shift();
      return next ? next() : new Response(JSON.stringify({ id: 77, login: "octo", created_at: new Date(clock - 40 * DAY).toISOString() }), { status: 200 });
    });
  }

  /** A connected GitHub account: the grant (a live token) and, when known, its age. */
  async function connectGithub(user: string, githubUserId: number, ageDays: number | null): Promise<void> {
    const key = await tokenKey(GH_TOKEN_KEY);
    harness.insert("github_app_grants", {
      user_id: user, github_user_id: githubUserId, github_login: `gh${githubUserId}`,
      access_token_sealed: await seal(key!, `token-${user}`, grantAad(user, "access")), access_token_sha256: "0".repeat(64),
      access_expires_at: clock + 8 * HOUR, origin: "web_flow", state: "active", generation: 1, created_at: clock, updated_at: clock,
    });
    if (ageDays != null) harness.exec("insert or replace into github_account_ages (github_user_id, github_created_at, checked_at, failures) values (?, ?, ?, 0)", githubUserId, clock - ageDays * DAY, clock);
  }

  const included = (user = OWNER) => harness.row("select included_milli from cloud_accounts where user_id = ?", user).included_milli;
  const githubClaims = () => harness.rows("select github_user_id, user_id from cloud_free_github_claims order by github_user_id");

  it.each<[string, () => Promise<void>, { state: string; included: number; claims: Row[]; create: number }]>([
    ["no GitHub connected: no free hours, and a create is refused",
      async () => {}, { state: "no_github", included: 0, claims: [], create: 402 }],
    ["a GitHub account younger than 30 days waits, with the card option",
      () => connectGithub(OWNER, 77, 10), { state: "too_new", included: 0, claims: [], create: 402 }],
    ["a GitHub account another ADE account claimed is refused; the first keeps it",
      async () => { await connectGithub(OWNER, 77, 40); harness.insert("cloud_free_github_claims", { github_user_id: 77, user_id: OTHER, claimed_at: NOW - DAY }); },
      { state: "used", included: 0, claims: [{ github_user_id: 77, user_id: OTHER }], create: 402 }],
    ["a GitHub account 30 days old claims the free plan",
      () => connectGithub(OWNER, 77, 40), { state: "ok", included: 100_000, claims: [{ github_user_id: 77, user_id: OWNER }], create: 201 }],
    ["a revoked GitHub connection whose age is still stored gets no free hours",
      async () => { await connectGithub(OWNER, 77, 40); harness.exec("update github_app_grants set state = 'needs_reauth', state_reason = 'bad_refresh_token' where user_id = ?", OWNER); },
      { state: "no_github", included: 0, claims: [], create: 402 }],
    ["a former paid customer's card counts for a new GitHub account",
      async () => { await connectGithub(OWNER, 77, 10); harness.exec("update cloud_accounts set stripe_subscription_id = 'sub_old' where user_id = ?", OWNER); },
      { state: "ok", included: 100_000, claims: [{ github_user_id: 77, user_id: OWNER }], create: 201 }],
    ["an account that used ADE Cloud before the rules keeps its hours with no GitHub",
      async () => { harness.exec("update cloud_accounts set free_github_exempt = 1 where user_id = ?", OWNER); },
      { state: "ok", included: 100_000, claims: [], create: 201 }],
  ])("free plan per GitHub account: %s", async (_label, arrange, expected) => {
    withGithub();
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    await arrange();

    const state = await stateOf();
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    const create = await harness.send(OWNER, "POST", "/cloud/instances", createBody);

    expect({ state: state.freePlan?.github?.state, included: included(), claims: githubClaims(), create: create.status }).toEqual(expected);
    if (expected.state === "too_new") {
      expect(state.freePlan?.github).toMatchObject({ canUnlockWithCard: true, oldEnoughAt: clock + 20 * DAY });
    }
  });

  it.each<[string, () => void, { state: string; included: number }]>([
    ["a new free account gets no free hours while GitHub can't be checked", () => {}, { state: "checking", included: 0 }],
    ["a hold from before stays", () => harness.exec("update cloud_accounts set free_github_hold = 'no_github', included_milli = 0 where user_id = ?", OWNER), { state: "no_github", included: 0 }],
    ["an account that already claimed its GitHub account keeps its hours", () => harness.insert("cloud_free_github_claims", { github_user_id: 77, user_id: OWNER, claimed_at: NOW - DAY }), { state: "ok", included: 100_000 }],
    ["an account that used ADE Cloud before the rules keeps its hours", () => harness.exec("update cloud_accounts set free_github_exempt = 1 where user_id = ?", OWNER), { state: "ok", included: 100_000 }],
    ["a settle that throws holds a new free account's hours", () => {
      withGithub();
      // No GitHub connected, and the write of that hold fails: the settle throws.
      harness.injectFault((sql, params) => /set free_github_hold = \?/.test(sql) && params[0] === "no_github");
    }, { state: "checking", included: 0 }],
  ])("in production, the GitHub rules fail closed: %s", async (_label, arrange, expected) => {
    harness.env.SENTRY_ENVIRONMENT = "production";
    seedAccount(harness, OWNER);
    arrange();

    const state = await stateOf();

    expect({ state: state.freePlan?.github?.state, included: included() }).toEqual(expected);
  });

  const WARNED = { warned_80_at: NOW - 2 * HOUR, warned_95_at: NOW - HOUR, warned_zero_at: NOW - HOUR };
  it.each<[string, Row, { included: number; warnings: Array<number | null> }]>([
    ["a free period that began on fewer hours gets today's free hours at once, and its hour warnings clear", { included_milli: 25_000, used_milli: 25_000, ...WARNED }, { included: 50_000, warnings: [null, null, null] }],
    ["an account refused the free plan keeps 0", { included_milli: 0, free_refused_at: NOW - DAY }, { included: 0, warnings: [null, null, null] }],
    ["a paid period keeps its own hours and warnings", { plan: "paid", paid_plan: "plus", included_milli: 50_000, warned_80_at: NOW - HOUR }, { included: 50_000, warnings: [NOW - HOUR, null, null] }],
  ])("free hours raised by a release: %s", async (_label, overrides, expected) => {
    seedAccount(harness, OWNER, overrides);

    const state = await stateOf();

    const row = harness.row("select warned_80_at, warned_95_at, warned_zero_at from cloud_accounts where user_id = ?", OWNER);
    expect({ included: included(), warnings: [row.warned_80_at, row.warned_95_at, row.warned_zero_at] }).toEqual(expected);
    expect(state.hours.includedMilli).toBe(expected.included);
  });

  it("two ADE accounts claiming one GitHub account at once: one gets the free plan, the other is refused", async () => {
    withGithub();
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    await connectGithub(OWNER, 77, 40);
    await connectGithub(OTHER, 77, 40);

    // OTHER claims after OWNER found the GitHub account unclaimed and before OWNER's claim lands.
    landBefore(/insert into cloud_free_github_claims/, () => stateOf(OTHER));
    const owner = await stateOf(OWNER);

    expect(githubClaims()).toEqual([{ github_user_id: 77, user_id: OTHER }]);
    expect([owner.freePlan?.github?.state, included(OWNER)]).toEqual(["used", 0]);
    expect([(await stateOf(OTHER)).freePlan?.github?.state, included(OTHER)]).toEqual(["ok", 100_000]);
  });

  it("switching GitHub accounts never lets one GitHub account feed two free plans", async () => {
    withGithub();
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    await connectGithub(OWNER, 77, 40);
    await stateOf(OWNER);
    // OWNER connects another GitHub account; OTHER connects OWNER's first one.
    harness.exec("update github_app_grants set github_user_id = 88 where user_id = ?", OWNER);
    harness.exec("insert into github_account_ages (github_user_id, github_created_at, failures) values (88, ?, 0)", clock - 40 * DAY);
    await connectGithub(OTHER, 77, 40);

    expect((await stateOf(OWNER)).freePlan?.github?.state).toBe("ok");
    expect([(await stateOf(OTHER)).freePlan?.github?.state, included(OTHER)]).toEqual(["used", 0]);
    expect(githubClaims()).toEqual([{ github_user_id: 77, user_id: OWNER }]);
  });

  it("GitHub down holds the hours and asks again after a wait; a revoked GitHub account means connect again", async () => {
    withGithub();
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    await connectGithub(OWNER, 77, null);
    githubUser.push(() => new Response("busy", { status: 502 }));

    expect((await stateOf()).freePlan?.github?.state).toBe("checking");
    expect(included()).toBe(0);
    // Inside the wait, no second call to GitHub; after it, GitHub answers and the hours come back.
    clock += 60_000;
    expect((await stateOf()).freePlan?.github?.state).toBe("checking");
    expect(githubCalls).toBe(1);
    clock += 5 * 60_000;
    expect((await stateOf()).freePlan?.github?.state).toBe("ok");
    expect([githubCalls, included()]).toEqual([2, 50_000]);

    // A GitHub account deleted (or the App revoked) before its age was read: connect GitHub again.
    await connectGithub(OTHER, 99, null);
    githubUser.push(() => new Response("{}", { status: 401 }));
    expect((await stateOf(OTHER)).freePlan?.github?.state).toBe("no_github");
  });

  /** Stripe's signed webhook, as the billing tests send it. */
  async function stripeWebhook(event: Row): Promise<Response> {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(clock / 1000);
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
    return handleCloudBillingPublicRequest(new Request("https://directory.test/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body,
    }), harness.env);
  }

  it("a card saved with no charge unlocks a new GitHub account's free hours, once per card; a card that didn't save unlocks nothing", async () => {
    Object.assign(harness.env, { RESEND_API_KEY: "resend-key", CLOUD_ALERT_EMAIL: "owner@example.test" });
    withGithub();
    seedAccount(harness, OWNER, { stripe_customer_id: "cus_1" });
    await connectGithub(OWNER, 77, 10);
    expect((await stateOf()).freePlan?.github?.state).toBe("too_new");
    harness.net.once.push(
      { match: /GET .*\/customers\/cus_1\/payment_methods/, reply: harness.net.reply({ data: [] }) },
      { match: /POST .*\/checkout\/sessions$/, reply: harness.net.reply({ id: "cs_1", url: "https://checkout.stripe.test/setup" }) },
    );

    const opened = await harness.send(OWNER, "POST", "/cloud/billing/free-unlock", {});
    expect(await opened.json()).toEqual({ url: "https://checkout.stripe.test/setup", unlocked: false });
    expect(providerCalls(harness, /POST .*\/checkout\/sessions$/).at(-1)?.body).toMatchObject({ mode: "setup", "metadata[ade_purpose]": "free_unlock" });
    expect(included()).toBe(0);

    const session = { id: "cs_1", object: "checkout.session", mode: "setup", status: "complete", setup_intent: "seti_1", client_reference_id: OWNER, metadata: { ade_user_id: OWNER, ade_purpose: "free_unlock" } };
    harness.net.once.push({ match: /GET .*\/setup_intents\/seti_1\?expand/, reply: harness.net.reply({ id: "seti_1", status: "requires_payment_method" }) });
    expect((await stripeWebhook({ id: "evt_unlock_failed", type: "checkout.session.completed", data: { object: session } })).status).toBe(200);
    expect([harness.row("select free_card_unlocked_at from cloud_accounts where user_id = ?", OWNER).free_card_unlocked_at, included()]).toEqual([null, 0]);

    // The card comes with the intent (`expand[]=payment_method`): its fingerprint is what one free unlock is held against.
    const card = (pm: string) => ({ id: pm, object: "payment_method", card: { fingerprint: "fp_card_1" } });
    harness.net.once.push({ match: /GET .*\/setup_intents\/seti_1\?expand/, reply: harness.net.reply({ id: "seti_1", status: "succeeded", payment_method: card("pm_1") }) });
    expect((await stripeWebhook({ id: "evt_unlock", type: "checkout.session.completed", data: { object: session } })).status).toBe(200);

    expect(harness.row("select free_card_unlocked_at, free_github_hold from cloud_accounts where user_id = ?", OWNER)).toEqual({ free_card_unlocked_at: clock, free_github_hold: null });
    expect([included(), githubClaims()]).toEqual([50_000, [{ github_user_id: 77, user_id: OWNER }]]);
    // A card already unlocked: the route says so and opens nothing.
    expect(await (await harness.send(OWNER, "POST", "/cloud/billing/free-unlock", {})).json()).toEqual({ url: null, unlocked: true });

    // The same card on a second new account unlocks nothing, comes off that customer, and alerts the owner once,
    // also when Stripe sends the completion again.
    seedAccount(harness, OTHER, { stripe_customer_id: "cus_2" });
    await connectGithub(OTHER, 88, 10);
    expect((await stateOf(OTHER)).freePlan?.github?.state).toBe("too_new");
    const otherSession = { ...session, id: "cs_2", setup_intent: "seti_2", client_reference_id: OTHER, metadata: { ade_user_id: OTHER, ade_purpose: "free_unlock" } };
    for (const eventId of ["evt_reuse", "evt_reuse_again"]) {
      harness.net.once.push({ match: /GET .*\/setup_intents\/seti_2\?expand/, reply: harness.net.reply({ id: "seti_2", status: "succeeded", payment_method: card("pm_2") }) });
      expect((await stripeWebhook({ id: eventId, type: "checkout.session.completed", data: { object: otherSession } })).status).toBe(200);
    }
    expect([harness.row("select free_card_unlocked_at from cloud_accounts where user_id = ?", OTHER).free_card_unlocked_at, included(OTHER), (await stateOf(OTHER)).freePlan?.github?.state])
      .toEqual([null, 0, "too_new"]);
    expect(providerCalls(harness, /POST .*\/payment_methods\/pm_2\/detach$/).length).toBeGreaterThan(0);
    expect(harness.rows("select card_fingerprint, user_id from cloud_free_card_claims")).toEqual([{ card_fingerprint: "fp_card_1", user_id: OWNER }]);
    expect(providerCalls(harness, /POST https:\/\/api\.resend\.com\/emails$/).map((call) => String(call.body?.subject)).filter((subject) => /used again/.test(subject)))
      .toEqual(["ADE Cloud: a card was used again for free credits"]);
  });

  it("the owner's block: only the owner token reaches it; it cuts off, stops and cancels the account, and puts its GitHub account and saved card on the block list until unblocked", async () => {
    withGithub();
    harness.env.CLOUD_OWNER_TOKEN = "owner-token-test";
    const owner = (path: string, body: Row, bearer = "owner-token-test") => handleCloudRequest(new Request(`https://directory.test/cloud/owner/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }), harness.env);
    const blocks = () => harness.rows("select user_id, github_user_id, card_fingerprint from cloud_blocks order by card_fingerprint");
    seedAccount(harness, OWNER, plus);
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [] } });
    await connectGithub(OWNER, 77, 400);
    seedComputer(harness);
    provide(harness);
    expect((await harness.send(OWNER, "GET", "/cloud/account")).status).toBe(200);

    // An account's own sign-in is not the owner's token.
    expect([(await owner("block", { userId: OWNER }, tokens[OWNER]!)).status, (await owner("block", { userId: OWNER }, "wrong")).status]).toEqual([401, 401]);
    expect(blocks()).toEqual([]);

    harness.net.once.push({ match: /GET .*\/customers\/cus_1\/payment_methods/, reply: harness.net.reply({ data: [{ id: "pm_9", card: { fingerprint: "fp_saved" } }] }) });
    expect((await owner("block", { userId: OWNER, reason: "spam" })).status).toBe(200);
    expect(blocks()).toEqual([{ user_id: OWNER, github_user_id: 77, card_fingerprint: "fp_saved" }]);
    expect(providerCalls(harness, new RegExp(`PATCH .*/instances/${INSTANCE}$`)).map((call) => call.body)).toEqual([{ network: "deny-all" }]);
    expect(providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/stop$`))).toHaveLength(1);
    expect(providerCalls(harness, /DELETE .*\/subscriptions\/sub_1$/).map((call) => call.body)).toEqual([{ prorate: "false", invoice_now: "false" }]);
    // Blocked is read-only: the reads in `CLOUD_BLOCKED_READ_ROUTES` answer, anything that does work is refused.
    const blockedAccount = await harness.send(OWNER, "GET", "/cloud/account");
    expect([blockedAccount.status, ((await blockedAccount.json()) as { blocked?: boolean }).blocked]).toEqual([200, true]);
    expect(await (await harness.send(OWNER, "GET", "/cloud/access")).json()).toEqual({ enabled: false, readOnly: true, reason: expect.any(String) });
    expect((await harness.send(OWNER, "GET", "/cloud/lanes/without-computer")).status).toBe(200);
    for (const [method, url] of [["POST", `/cloud/instances/${INSTANCE}/start`], ["GET", "/cloud/instances"], ["POST", "/cloud/chats/key/chat/messages"], ["DELETE", "/cloud/chats/key/chat"], ["POST", "/cloud/integrations/linear/query"], ["PUT", "/cloud/limits"]] as const) {
      const refused = await harness.send(OWNER, method, url, method === "GET" ? undefined : {});
      expect([url, refused.status, ((await refused.json()) as { error?: { code?: string } }).error?.code]).toEqual([url, 403, "account_blocked"]);
    }

    // The blocked GitHub account on a new ADE account gets no free plan.
    seedAccount(harness, OTHER);
    await connectGithub(OTHER, 77, 400);
    expect([(await stateOf(OTHER)).freePlan?.github?.state, included(OTHER)]).toEqual(["used", 0]);

    // Unblocked: the account's rows go with its GitHub account and card, the account works again,
    // and its computer gets the internet back but stays stopped (the person starts it).
    expect((await owner("unblock", { userId: OWNER })).status).toBe(200);
    expect(blocks()).toEqual([]);
    expect((await harness.send(OWNER, "GET", "/cloud/account")).status).toBe(200);
    expect(providerCalls(harness, new RegExp(`PATCH .*/instances/${INSTANCE}$`)).map((call) => call.body)).toEqual([{ network: "deny-all" }, { network: "allow-all" }]);
    expect(computer(harness).status).toBe("stopped");
  });

  it.each<[string, number, string[]]>([
    ["five sign-ups from one address within an hour raise the alarm", 5, ["5 sign-ups from one IP address within an hour from 10:00 UTC"]],
    ["four do not", 4, []],
  ])("the daily report's abuse lines: %s; a computer at full CPU for hours with no chat turn is listed", async (_label, signups, burstLines) => {
    Object.assign(harness.env, { RESEND_API_KEY: "resend-key", CLOUD_ALERT_EMAIL: "owner@example.test", CLOUD_CHAT_MASTER_KEY: Buffer.alloc(32, 3).toString("base64") });
    const day = new Date(NOW - DAY).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    seedAccount(harness, OWNER);
    seedComputer(harness);
    provide(harness);
    const secret = Buffer.from("clerk-webhook-secret-for-this-test");
    for (let index = 0; index < signups; index += 1) {
      const body = JSON.stringify({ type: "user.created", data: { id: `user_burst_${index}`, created_at: dayStart + 10 * HOUR + index * 10 * 60_000 }, event_attributes: { http_request: { client_ip: "203.0.113.9", user_agent: "x" } } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`msg_${index}.${timestamp}.${body}`).digest("base64");
      await handleSignupAnalyticsRequest(new Request("https://directory.test/webhooks/clerk", {
        method: "POST", headers: { "svix-id": `msg_${index}`, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }, body,
      }), { DB: harness.DB, CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${secret.toString("base64")}`, CLOUD_CHAT_MASTER_KEY: harness.env.CLOUD_CHAT_MASTER_KEY } as never);
    }
    // The raw address is never stored.
    expect(JSON.stringify(harness.rows("select * from cloud_signup_ips"))).not.toContain("203.0.113.9");
    clock = dayStart + 20 * HOUR;
    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/cpu-report`, { since: dayStart + 15 * HOUR, minutes: 300, cpuPercent: 97 })).status).toBe(200);
    clock = NOW;

    await runDailyCostReport(harness.env, day);

    const report = String(providerCalls(harness, /POST https:\/\/api\.resend\.com\/emails$/).at(-1)?.body?.text ?? "");
    expect(report).toContain(`Computer ${INSTANCE} of account ${OWNER} (free) ran at 97% CPU or more for 5 hours from 15:00 UTC with no chat turn or agent working.`);
    for (const line of burstLines) expect(report).toContain(line);
    if (!burstLines.length) expect(report).not.toContain("sign-ups from one IP address");
  });
});

/**
 * A cheaper plan's limits free only the computers the person picked
 * (`planCleanup.ts`). The run deletes computers with nobody watching, from
 * the cron only, so a test is the one way to prove it frees exactly the pick,
 * never deletes a computer whose lanes aren't saved when `push` is on, never
 * wakes one, and never one whose pick no longer applies.
 */
describe("ADE Cloud plan cleanup", () => {
  const NEWER = ["newer000001", "newer000002", "newer000003"];
  const quiet = JSON.stringify({ result: { interruptedChats: 0, interruptedClis: 0, stillRunning: 0, chatsUploaded: 0, chatsNotUploaded: 0, timedOut: false } });
  const REPORT = "a".repeat(32);

  /** The free plan allows 3 computers; the person picked the oldest of 4, each lane's work saved first. */
  function seedOverFreePlan(): void {
    seedAccount(harness, OWNER, { plan_cleanup_choice_json: JSON.stringify({ planId: "free", push: true, instanceIds: [INSTANCE], at: NOW - HOUR }) });
    seedComputer(harness, { created_at: NOW - 40 * DAY, machine_key: "key-a" });
    provide(harness);
    NEWER.forEach((id, index) => seedComputer(harness, { instance_id: id, created_at: NOW - (10 - index) * DAY, disk_gb: 2 }));
  }

  /**
   * An awake computer's two answers, in order: prepare-stop, then save-for-rest.
   * Its save posts its backup report (`lanes`) as the real computer does,
   * before the exec answers; `lanes` null is an ADE older than lane backups.
   */
  function answerExecs(prepare: string, lanes: Row[] | null): void {
    harness.net.once.push({ match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`), reply: harness.net.reply({ exit_code: 0, stdout: prepare, stderr: "" }) });
    if (!lanes) {
      harness.net.once.push({ match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`), reply: harness.net.reply(OLD_ADE_EXEC) });
      return;
    }
    const saved = JSON.stringify({ result: { ok: true, capsules: 0, sessions: 0, git: 0, skipped: 0, backups: { reportId: REPORT, state: "current", saved: 0, unchanged: 0, clean: lanes.length, failed: 0 } } });
    harness.net.once.push({ match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`), reply: harness.net.reply({ exit_code: 0, stdout: saved, stderr: "" }) });
    harness.net.after.push({
      match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`),
      run: async () => {
        // The first exec (prepare-stop) passes; the report lands during the second.
        harness.net.after.push({
          match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`),
          run: async () => {
            const sent = await harness.send(OWNER, "POST", "/cloud/backups/report", { instanceId: INSTANCE, reportId: REPORT, complete: true, lanes });
            expect(sent.status).toBe(200);
          },
        });
      },
    });
  }

  const run = async () => runPlanCleanupPicks(harness.env, createCloudProvider("provider-key"), clock);
  const cleanLane = { laneId: "lane_main", state: "clean" };

  // `arrange` may return the reason a kept computer shows. `unfreezes`: an
  // awake computer kept after a confirmed prepare takes work again at once.
  it.each<[string, () => string | void, boolean, boolean]>([
    ["awake, every lane saved in place: freed", () => answerExecs(quiet, [cleanLane, { laneId: "lane_x", state: "clean" }]), true, false],
    ["awake, a lane too large to save: kept with the sentence", () => answerExecs(quiet, [{ laneId: "lane_x", laneName: "big", state: "too_large" }]), false, true],
    ["awake, an ADE older than lane backups: kept", () => answerExecs(quiet, null), false, true],
    // Not confirmed: the computer ends its own freeze.
    ["agents still running after prepare-stop: kept", () => answerExecs(JSON.stringify({ result: { stillRunning: 1, chatsNotUploaded: 0, timedOut: true } }), [cleanLane]), false, false],
    ["the person bought Plus while it saved, so the pick no longer applies: not freed", () => {
      answerExecs(quiet, [cleanLane]);
      harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: () => { harness.exec("update cloud_accounts set plan = 'paid', paid_plan = 'plus', stripe_status = 'active' where user_id = ?", OWNER); } });
    }, false, true],
    ["a move of it that began while it saved: not freed, so the move keeps its files", () => {
      answerExecs(quiet, [cleanLane]);
      harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: () => { seedComputer(harness, { instance_id: "pending_move_target", moving_from: INSTANCE, status: "provisioning", created_at: NOW }); } });
    }, false, true],
    ["asleep, rested with every lane saved: freed with no start and no command", () => {
      harness.exec("update cloud_computers set status = 'sleeping', awake_since = null, backup_rest_at = ? where instance_id = ?", NOW - HOUR, INSTANCE);
      harness.net.instances.get(INSTANCE)!.status = "sleeping";
    }, true, false],
    ["asleep, its last save failed: kept, never woken", () => {
      harness.exec("update cloud_computers set status = 'sleeping', awake_since = null, backup_report_id = ?, backup_report_state = 'failed' where instance_id = ?", REPORT, INSTANCE);
      harness.net.instances.get(INSTANCE)!.status = "sleeping";
      return "ADE couldn't save this lane's work.";
    }, false, false],
    ["asleep, it rested before its ADE saved lane work: kept, never woken, and told it isn't a failure", () => {
      harness.exec("update cloud_computers set status = 'sleeping', awake_since = null where instance_id = ?", INSTANCE);
      harness.net.instances.get(INSTANCE)!.status = "sleeping";
      return CLOUD_BACKUP_NEVER_SAVED_SENTENCE;
    }, false, false],
  ])("%s", async (_label, arrange, freed, unfreezes) => {
    seedOverFreePlan();
    const keptReason = arrange();
    const startedAs = harness.net.instances.get(INSTANCE)!.status;

    await run();

    expect(computer(harness).deleted_at != null).toBe(freed);
    // Never a wake: every wake is use.
    expect(providerCalls(harness, /POST .*\/(start|stop|sleep)$/)).toEqual([]);
    if (startedAs === "sleeping") expect(providerCalls(harness, /POST .*\/exec$/)).toEqual([]);
    // Never a commit or a push.
    const commands = providerCalls(harness, /POST .*\/exec$/).map((call) => String(call.body?.command));
    expect(commands).not.toContainEqual(expect.stringContaining("push-work"));
    // An awake computer freezes new work from its prepare until the delete, so nothing written after the save is lost.
    if (startedAs !== "sleeping") expect(commands[0]).toContain("ade cloud prepare-stop --timeout 40 --for-delete --json");
    expect(commands.filter((command) => command.includes("ade cloud unfreeze"))).toHaveLength(unfreezes ? 1 : 0);
    if (!freed) expect([harness.net.instances.get(INSTANCE)?.status, computer(harness).status]).toEqual([startedAs, startedAs]);
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(freed ? 1 : 0);
    // Only the pick: the newer computers are never touched.
    for (const id of NEWER) expect(computer(harness, id).deleted_at).toBeNull();
    if (keptReason) {
      const done = JSON.parse(String(harness.row("select plan_cleanup_result_json from cloud_accounts where user_id = ?", OWNER).plan_cleanup_result_json)) as { kept: Array<{ reason: string }> };
      expect(done.kept[0]!.reason).toContain(keptReason);
    }
  });

  it("a downgrade's pick is checked before Stripe is asked, then only the picked computers are freed, each saved before its delete", async () => {
    harness.env.STRIPE_PRO_PRICE_ID = "price_pro";
    seedAccount(harness, OWNER, { plan: "paid", paid_plan: "pro", included_milli: 600_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" });
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [{ id: "si_plan", price: { id: "price_pro" } }, { id: "si_extra", price: { id: "price_extra" } }] } });
    // 4 computers against Plus's 3: a pick that frees none leaves the account over, freeing the oldest fits.
    seedComputer(harness, { disk_gb: 44, created_at: NOW - 40 * DAY, machine_key: "key-a" });
    provide(harness);
    for (const id of [SECOND, "third1234567", "fourth123456"]) {
      seedComputer(harness, { instance_id: id, disk_gb: 4, created_at: NOW - 10 * DAY });
      provide(harness, id);
    }
    const downgrade = (instanceIds: string[]) => harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan: "plus", cleanup: { push: true, instanceIds } });
    const stored = () => harness.row("select paid_plan_next, plan_cleanup_choice_json is not null as picked from cloud_accounts where user_id = ?", OWNER);

    const refused = await downgrade([]);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe("cleanup_does_not_fit");
    expect(providerCalls(harness, /\/subscription_items\//)).toHaveLength(0);
    expect(stored()).toEqual({ paid_plan_next: null, picked: 0 });

    const made = await downgrade([INSTANCE]);
    expect(await made.json()).toEqual({ url: null, change: "next_period", freeing: [INSTANCE] });
    expect(stored()).toEqual({ paid_plan_next: "plus", picked: 1 });

    answerExecs(quiet, [cleanLane]);
    await run();
    expect([computer(harness).deleted_at != null, computer(harness, SECOND).deleted_at != null]).toEqual([true, false]);
    const savedAt = harness.net.calls.findIndex((call) => call.url.endsWith(`/instances/${INSTANCE}/exec`) && String(call.body?.command).includes("ade cloud save-for-rest"));
    const deletedAt = harness.net.calls.findIndex((call) => call.method === "DELETE" && call.url.endsWith(`/instances/${INSTANCE}`));
    expect(savedAt).toBeGreaterThan(-1);
    expect(deletedAt).toBeGreaterThan(savedAt);
    expect(providerCalls(harness, new RegExp(`(POST|DELETE) .*/instances/${SECOND}`))).toEqual([]);

    // Nothing left to free: the next tick finishes the pick.
    await run();
    expect(stored()).toEqual({ paid_plan_next: "plus", picked: 0 });
  });
});

/**
 * The idle cleanup (`idleCleanup.ts`) deletes unused computers from the cron
 * with nobody watching, so a test is the one way to prove the deletes that
 * must not happen: before the time the warning announced (a plan change
 * included), when a lane isn't saved, for an account out of hours,
 * for a computer used since its warning or while its save ran, and for one
 * with a timed wake-up booked; and that a failure never repeats every minute.
 */
describe("ADE Cloud idle cleanup", () => {
  const BRANCH = "ade/pricing-page";
  const run = async () => runIdleCleanup(harness.env, createCloudProvider("provider-key"), clock);
  const execs = () => providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/exec$`));
  const deletes = () => providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`));
  const wakes = () => providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/(start|stop|sleep)$`));
  /** Every email the cleanup sent, as Resend got it. */
  const emails = () => providerCalls(harness, /POST https:\/\/api\.resend\.com/).map((call) => ({ subject: String(call.body?.subject), text: String(call.body?.text) }));

  beforeEach(() => {
    Object.assign(harness.env, { RESEND_API_KEY: "resend-key", CLERK_SECRET_KEY: "sk_test" });
    seedAccount(harness, OWNER);
    // The account's address, for every email the run sends.
    for (let index = 0; index < 8; index += 1) {
      harness.net.once.push({ match: /GET https:\/\/api\.clerk\.com\/v1\/users\//, reply: harness.net.reply({ primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: "person@example.test" }] }) });
    }
  });

  /** A sleeping lane computer last used `idleMs` ago, rested with every lane saved, with the ignored files it reported. */
  function seedIdle(idleMs: number, overrides: Row = {}): void {
    seedComputer(harness, {
      status: "sleeping",
      awake_since: null,
      last_awake_at: clock - idleMs,
      status_changed_at: clock - idleMs,
      created_at: clock - 30 * DAY,
      machine_key: "key-a",
      lane_id: "lane_pricing",
      lane_name: "pricing-page",
      lane_project_origin: "github.com/acme/web",
      lane_branch: BRANCH,
      backup_report_id: "b".repeat(32),
      backup_report_state: "current",
      backup_rest_at: clock - idleMs,
      ignored_files_json: JSON.stringify({ checkedAt: clock - idleMs, paths: [".env", "prisma/dev.db"], more: 1, rebuildable: 2 }),
      ...overrides,
    });
    provide(harness, INSTANCE, "sleeping");
  }

  it("a free computer is warned at 2 days, emailed again 6 hours before, and deleted no sooner than announced, with no wake, its lane kept", async () => {
    seedIdle(2 * DAY + 60_000);
    await run();
    const announced = computer(harness).idle_deletes_at as number;
    // The full day's lead from the warning.
    expect(announced).toBe(NOW + DAY);
    expect(emails()).toHaveLength(1);
    expect(emails()[0]!.subject).toBe("The computer for pricing-page will be deleted in 1 day");
    expect(emails()[0]!.text).toContain("these won't be kept: .env, prisma/dev.db and 1 more");

    // An overlapping tick sends nothing twice.
    await run();
    expect(emails()).toHaveLength(1);

    clock = announced - 6 * HOUR;
    await run();
    expect(emails()).toHaveLength(2);

    clock = announced - 60_000;
    await run();
    expect(deletes()).toEqual([]);

    clock = announced;
    await run();
    // Deleted as it rests: never started, no command run on it, nothing pushed.
    expect([wakes(), execs()]).toEqual([[], []]);
    expect(deletes()).toHaveLength(1);
    expect(computer(harness).deleted_at).toBe(announced);
    expect(harness.rows("select action from cloud_power_log where instance_id = ? and action = 'start'", INSTANCE)).toEqual([]);
    expect(meteredMilli(harness)).toBe(0);
    expect(harness.row("select reason from cloud_delete_log where instance_id = ?", INSTANCE).reason).toBe("idle_cleanup");
    expect(harness.row("select lane_name, branch_ref, reason from cloud_lanes_without_computer where lane_id = 'lane_pricing'"))
      .toEqual({ lane_name: "pricing-page", branch_ref: BRANCH, reason: "idle_cleanup" });
    expect(emails().at(-1)!.text).toContain("nothing was pushed");
  });

  /** Warned a day ago on Free, its announced time now, its last email sent: due unless something below stops it. */
  const dueRow: Row = { idle_warned_at: NOW - DAY, idle_deletes_at: NOW, idle_emailed_at: NOW - 6 * HOUR };
  const notSaved: Row = { backup_rest_at: null, backup_report_state: "failed", backup_problems_json: JSON.stringify([{ laneId: "lane_pricing", laneName: "pricing-page", reason: "Git LFS files can't travel; push them first. ADE can't save this lane's work until then." }]) };

  it.each<[string, Row, () => Promise<void> | void, boolean]>([
    ["a lane isn't saved: kept as it rests, never woken, and told why", notSaved, () => {}, true],
    ["it slept on the provider's own timer, with no save: kept", { backup_rest_at: null }, () => {}, true],
    ["it rested before its ADE saved lane work: kept, and no email (nothing failed)", { backup_rest_at: null, backup_report_id: null, backup_report_state: null }, () => {}, false],
    ["the account is out of hours: never swept", {}, () => {
      harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER);
    }, false],
    ["the computer was used after its warning: the clock restarts", {}, () => {
      harness.exec("update cloud_computers set last_awake_at = ? where instance_id = ?", NOW - HOUR, INSTANCE);
    }, false],
    ["the person pressed Keep it: the clock restarts with no wake", {}, async () => {
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/keep`)).status).toBe(200);
    }, false],
    ["a paid computer announced for later moved to Free: the announced time holds", {}, () => {
      harness.exec("update cloud_computers set idle_deletes_at = ?, idle_warned_at = ?, idle_emailed_at = ? where instance_id = ?", NOW + 2 * DAY, NOW - DAY, NOW - DAY, INSTANCE);
    }, false],
    ["a timed wake-up is booked weeks ahead: in use until it fires", {}, () => {
      harness.insert("cloud_wakes", { user_id: OWNER, instance_id: INSTANCE, wake_url: "https://box.agent37.app", wake_at: NOW + 20 * DAY, updated_at: NOW });
    }, false],
  ])("not deleted: %s", async (_label, row, arrange, held) => {
    seedIdle(3 * DAY + HOUR, { ...dueRow, ...row });
    await arrange();

    await run();

    expect(deletes()).toEqual([]);
    expect(computer(harness).deleted_at).toBeNull();
    // Kept as it is: never started, nothing run on it.
    expect([wakes(), execs()]).toEqual([[], []]);
    expect([harness.net.instances.get(INSTANCE)?.status, computer(harness).status]).toEqual(["sleeping", "sleeping"]);
    if (!held) expect(emails()).toEqual([]);
    if (held) {
      expect(String(computer(harness).idle_held_reason)).toContain("ADE couldn't save this lane's work.");
      expect(emails().map((email) => email.subject)).toEqual(["ADE Cloud didn't delete pricing-page: its work couldn't be saved"]);
      // A day later it reads again, and still deletes and wakes nothing.
      clock = NOW + DAY;
      await run();
      expect([deletes(), wakes(), execs()]).toEqual([[], [], []]);
      expect(emails()).toHaveLength(1);
      // Once it rests with its lanes saved (its next real use), the next read deletes it, still with no wake.
      harness.exec("update cloud_computers set backup_rest_at = ?, backup_report_state = 'current', backup_problems_json = null where instance_id = ?", clock, INSTANCE);
      clock = NOW + 3 * DAY + HOUR;
      await run();
      expect(wakes()).toEqual([]);
      expect(deletes()).toHaveLength(1);
    }
  });

  it("a person who starts the computer while the cleanup reads it keeps it, awake", async () => {
    seedIdle(3 * DAY + HOUR, dueRow);
    // Lands as the run reads the computer, before the delete claim.
    harness.net.after.push({
      match: new RegExp(`GET .*/instances/${INSTANCE}$`),
      run: async () => {
        expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, {})).status).toBe(200);
      },
    });

    await run();

    expect(deletes()).toEqual([]);
    expect(computer(harness).deleted_at).toBeNull();
    expect([harness.net.instances.get(INSTANCE)?.status, computer(harness).status]).toEqual(["running", "running"]);
    // The start took it out of rest: its lanes may change, so the backups it rested with no longer count.
    expect(computer(harness).backup_rest_at).toBeNull();
  });

  it("Keep it pressed once the delete is under way is refused, never answered and then ignored", async () => {
    seedIdle(3 * DAY + HOUR, dueRow);
    let keep: Response | null = null;
    // Lands as the delete reads the computer's last events, just before the provider delete.
    harness.net.after.push({
      match: new RegExp(`GET .*/instances/${INSTANCE}/events$`),
      run: async () => { keep = await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/keep`); },
    });

    await run();

    expect(keep!.status).toBe(409);
    expect(computer(harness).deleted_at).toBe(NOW);
  });

  it("a delete the provider refuses waits before it runs again, never every minute", async () => {
    seedIdle(3 * DAY + HOUR, dueRow);
    harness.net.once.push({ match: new RegExp(`DELETE .*/instances/${INSTANCE}$`), reply: harness.net.reply({ error: { code: "server_error" } }, 500) });
    await run();
    expect(computer(harness).deleted_at).toBeNull();
    expect(deletes()).toHaveLength(1);

    clock = NOW + 60_000;
    await run();
    expect(deletes()).toHaveLength(1);

    clock = NOW + HOUR;
    await run();
    expect(computer(harness).deleted_at).toBe(clock);
  });

  it("a used computer is warned again only 2 days after its last use", async () => {
    seedIdle(2 * DAY + 60_000);
    await run();
    expect(computer(harness).idle_warned_at).toBe(NOW);

    harness.exec("update cloud_computers set last_awake_at = ? where instance_id = ?", NOW + HOUR, INSTANCE);
    clock = NOW + DAY + HOUR;
    await run();
    expect(computer(harness).idle_warned_at).toBeNull();
    expect(emails()).toHaveLength(1);

    clock = NOW + HOUR + 2 * DAY;
    await run();
    expect(computer(harness).idle_warned_at).toBe(clock);
    expect(computer(harness).idle_deletes_at).toBe(NOW + HOUR + 3 * DAY);
  });
});

/*
 * The server launcher (C6) and `/cloud/*` from a browser (C7): the launch id's
 * replay, the one-time join code's rules, and the CORS gate. The join is the
 * one `/cloud` route with no account token, so its code is the whole proof.
 */
describe("ADE Cloud server launcher", () => {
  const LAUNCH = "0b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a10";
  const USER_CODE = "BCDF-2345";
  const WEB = "https://app.ade.test";
  const launchBody = {
    launchId: LAUNCH,
    kind: "chat",
    sizeId: "small",
    project: { origin: "https://github.com/Acme/Widgets.git" },
    lane: { id: "5d1e8a3c-2b4f-4e6a-9c7d-1f0b3a5e8c21", name: "Fix the login page" },
    chat: { provider: "codex", modelId: "gpt-5", permissions: "full-auto", prompt: "Fix the login page." },
  };

  beforeEach(() => {
    harness.env.CLERK_SECRET_KEY = "sk_test";
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.env.WEB_CLIENT_ORIGIN = WEB;
    seedAccount(harness, OWNER);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
  });

  const madeCalls = () => providerCalls(harness, /POST .*\/instances$/);
  const joinCode = (): string => (madeCalls()[0]!.body!.env as Record<string, string>).ADE_LAUNCH_JOIN!;
  const join = (body: Record<string, unknown>, instanceId = "madenew12345") => handleCloudRequest(new Request(`https://directory.test/cloud/launches/${LAUNCH}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ade-instance": instanceId },
    body: JSON.stringify(body),
  }), harness.env);
  const seedDeviceSignIn = (userCode = USER_CODE) => harness.insert("device_authorizations", {
    device_code: `device-${userCode}`, user_code: userCode, device_secret_hash: "hash", status: "pending", poll_interval_seconds: 5, created_at: NOW, expires_at: NOW + 60 * 60_000,
  });

  // A computer made from an image older than the launch's boot never joins.
  it.each([
    { stable: "ade@17", sent: undefined, channel: "beta", image: "ade@53" },
    { stable: "ade@17", sent: "stable", channel: "beta", image: "ade@53" },
    { stable: "ade@60", sent: undefined, channel: "stable", image: "ade@60" },
    { stable: "ade@60", sent: "stable", channel: "stable", image: "ade@60" },
    { stable: "ade@60", sent: "beta", channel: "beta", image: "ade@53" },
  ])("a launch with stable on $stable and $sent asked is made on $channel ($image)", async ({ stable, sent, channel, image }) => {
    harness.insert("cloud_settings", { key: "template_version_stable", value: stable, updated_at: NOW });
    harness.insert("cloud_settings", { key: "template_version_beta", value: "ade@53", updated_at: NOW });
    const started = await harness.send(OWNER, "POST", "/cloud/launches", sent ? { ...launchBody, channel: sent } : launchBody);
    expect(started.status).toBe(201);
    expect(harness.row("select channel, template_version from cloud_computers where instance_id = ?", "madenew12345")).toEqual({ channel, template_version: image });
  });

  it("one launch id makes one computer: a repeat answers the same launch, another account can't use it", async () => {
    const first = await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual(expect.objectContaining({ instanceId: "madenew12345", state: "joining" }));

    const again = await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(expect.objectContaining({ instanceId: "madenew12345", state: "joining" }));
    const theirs = await harness.send(OTHER, "POST", "/cloud/launches", launchBody);
    expect(theirs.status).toBe(400);

    expect(madeCalls()).toHaveLength(1);
    expect(harness.rows("select instance_id from cloud_computers where deleted_at is null")).toEqual([{ instance_id: "madenew12345" }]);
    // Only the code's hash is kept, never the code.
    expect(harness.row("select join_hash from cloud_launches where launch_id = ?", LAUNCH).join_hash).not.toBe(joinCode());
    // Another account sees no such launch.
    expect((await harness.send(OTHER, "GET", `/cloud/launches/${LAUNCH}`)).status).toBe(404);
    expect((await harness.send(OTHER, "DELETE", `/cloud/launches/${LAUNCH}`)).status).toBe(404);
  });

  it("a message queued before the chat exists is sent once: one claim takes it, a lost answer retried gets it back, only that claim finishes it", async () => {
    const messages = `/cloud/launches/${LAUNCH}/messages`;
    const claim = (claimId: string) => harness.send(OWNER, "POST", `${messages}/m2/claim`, { claimId });
    const report = (claimId: string, state: string) => harness.send(OWNER, "PUT", `${messages}/m2`, { claimId, state });
    const [CLAIM_A, CLAIM_B] = ["claim-aaaaaaaaaaaaaaaa", "claim-bbbbbbbbbbbbbbbb"];
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);

    // The same id twice is one message; another account sees no such launch.
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m2", text: "Also fix the footer." })).status).toBe(201);
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m2", text: "Also fix the footer." })).status).toBe(200);
    expect((await harness.send(OTHER, "GET", messages)).status).toBe(404);
    // Nothing is claimed before the chat exists: the computer would send it into no chat.
    expect((await claim(CLAIM_A)).status).toBe(409);

    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${LAUNCH}/stages`, { state: "running", sessionId: "chat-1" })).status).toBe(200);
    expect([(await claim(CLAIM_A)).status, (await claim(CLAIM_B)).status, (await claim(CLAIM_A)).status]).toEqual([200, 409, 200]);
    expect([(await report(CLAIM_B, "delivered")).status, (await report(CLAIM_A, "delivered")).status, (await report(CLAIM_A, "delivered")).status]).toEqual([409, 200, 200]);
    // Delivered stays delivered: no later claim sends it again, and a new message goes to the chat itself.
    expect((await claim(CLAIM_B)).status).toBe(409);
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m3", text: "And the header." })).status).toBe(409);

    const listed = await (await harness.send(OWNER, "GET", messages)).json() as { messages: Array<{ messageId: string; state: string }> };
    expect(listed.messages.map((message) => [message.messageId, message.state])).toEqual([[expect.any(String), "delivered"], ["m2", "delivered"]]);
  });

  it("the follow-ups queued before the chat existed join the new chat's own queue once its computer has its key: the chat shows each one as the launch sends it, a failed one with its reason", async () => {
    harness.env.CLOUD_CHAT_MASTER_KEY = Buffer.alloc(32, 4).toString("base64");
    const messages = `/cloud/launches/${LAUNCH}/messages`;
    const CLAIM = "claim-dddddddddddddddd";
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m2", text: "Also fix the footer." })).status).toBe(201);
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m3", text: "And the header." })).status).toBe(201);
    // The computer saved the new chat, as it does once the chat runs.
    harness.exec(
      "insert into cloud_chat_copies (user_id, machine_key, chat_id, lane_id, r2_key, updated_at) values (?, ?, ?, ?, ?, ?)",
      OWNER, "key-new", "chat-1", launchBody.lane.id, `chats/${OWNER}/key-new/chat-1`, NOW,
    );
    const chatQueue = async () => ((await (await harness.send(OWNER, "GET", "/cloud/chats/key-new/chat-1/messages")).json()) as {
      messages: Array<{ messageId: string; state: string; text: string; error: string | null }>;
    }).messages.map((message) => [message.messageId, message.state, message.text, message.error]);

    // The chat runs before the computer wrote its key (it does that off the launch's path): nothing to carry yet.
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${LAUNCH}/stages`, { state: "running", sessionId: "chat-1" })).status).toBe(200);
    expect(await chatQueue()).toEqual([]);
    // The key arrives: the follow-ups join the chat. A later report of the chat carries nothing twice.
    const carried = [["m2", "queued", "Also fix the footer.", null], ["m3", "queued", "And the header.", null]];
    expect((await harness.send(OWNER, "PUT", "/cloud/instances/madenew12345/metadata", { metadata: { ade_machine_key: "key-new" } })).status).toBe(200);
    expect(await chatQueue()).toEqual(carried);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${LAUNCH}/stages`, { state: "running", sessionId: "chat-1" })).status).toBe(200);
    expect(await chatQueue()).toEqual(carried);
    // The computer sends the launch's own rows and never claims the chat's copies.
    expect(((await (await harness.send(OWNER, "GET", "/cloud/instances/madenew12345/messages")).json()) as { messages: unknown[] }).messages).toEqual([]);

    expect((await harness.send(OWNER, "POST", `${messages}/m2/claim`, { claimId: CLAIM })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `${messages}/m2`, { claimId: CLAIM, state: "delivered" })).status).toBe(200);
    expect((await harness.send(OWNER, "POST", `${messages}/m3/claim`, { claimId: CLAIM })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `${messages}/m3`, { claimId: CLAIM, state: "failed", error: "The agent refused it." })).status).toBe(200);
    expect(await chatQueue()).toEqual([["m2", "delivered", "Also fix the footer.", null], ["m3", "failed", "And the header.", "The agent refused it."]]);
    // The carried rows settle at the report, not at the next cron: a failed one no longer counts as open.
    expect(harness.rows("select message_id, state from cloud_chat_messages where via_launch = 1 order by seq")).toEqual([
      { message_id: "m2", state: "delivered" }, { message_id: "m3", state: "failed" },
    ]);
  });

  it.each<[string, (code: string) => Promise<Response>, number]>([
    ["a wrong code", () => join({ nonce: "x".repeat(43), userCode: USER_CODE }), 403],
    ["the code from another computer", (code) => join({ nonce: code, userCode: USER_CODE }, "otherbox1234"), 403],
    ["the code after its 30 minutes", (code) => { clock = NOW + 31 * 60_000; return join({ nonce: code, userCode: USER_CODE }); }, 410],
  ])("%s is refused and leaves the code unused", async (_label, attempt, status) => {
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    seedDeviceSignIn();

    expect((await attempt(joinCode())).status).toBe(status);

    expect(harness.row("select join_used_at from cloud_launches where launch_id = ?", LAUNCH).join_used_at).toBeNull();
    expect(providerCalls(harness, /sign_in_tokens/)).toHaveLength(0);
    if (status !== 410) expect((await join({ nonce: joinCode(), userCode: USER_CODE })).status).toBe(200);
  });

  it("the join code is spent by the first join, and its links sign in only the launch's account", async () => {
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    seedDeviceSignIn();
    seedDeviceSignIn("GHJK-6789");

    const first = await join({ nonce: joinCode(), userCode: USER_CODE });
    // The same computer joining again while the launch still joins (a restart mid-sign-in) names a fresh sign-in.
    const second = await join({ nonce: joinCode(), userCode: "GHJK-6789" });

    expect(first.status).toBe(200);
    expect((await first.json() as { url: string }).url).toContain(`ticket=t_${OWNER}`);
    expect(second.status).toBe(200);
    expect(providerCalls(harness, /sign_in_tokens/).map((call) => call.body?.user_id)).toEqual([OWNER, OWNER]);
    // After it was spent, the same computer may still say a person has to confirm.
    expect((await join({ nonce: joinCode(), needsApproval: true })).status).toBe(200);
    const record = await (await harness.send(OWNER, "GET", `/cloud/launches/${LAUNCH}`)).json();
    expect(record).toEqual(expect.objectContaining({ state: "needs_approval", approval: expect.objectContaining({ userCode: "GHJK-6789" }) }));
  });

  it("a Retry holds the failed launch while it deletes its computer: that computer's reports and a second start change nothing, the launch starts again with a new deadline", async () => {
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    harness.exec("update cloud_launches set state = 'failed', error = 'The clone failed.' where launch_id = ?", LAUNCH);
    clock = NOW + 2 * HOUR;
    // A report the failed computer sent before the Retry: read against the old row, its body still arriving.
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    let sendBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => new Promise<void>((resolve) => {
        bodyRead();
        sendBody = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ state: "running" })));
          controller.close();
          resolve();
        };
      }),
    });
    const earlyReport = handleCloudRequest(new Request(`https://directory.test/cloud/launches/${LAUNCH}/stages`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tokens[OWNER]}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit), harness.env);
    await reading;
    // While the delete is in flight, where a real one lands: a late report, the early one's body, and a second start.
    const during: number[] = [];
    harness.net.after.push({ match: /DELETE .*\/instances\/madenew12345$/, run: async () => {
      during.push((await harness.send(OWNER, "PUT", `/cloud/launches/${LAUNCH}/stages`, { state: "joined" })).status);
      sendBody();
      during.push((await earlyReport).status);
      during.push((await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, retry: true })).status);
      during.push(madeCalls().length);
    } });

    const retried = await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, retry: true });

    expect(retried.status).toBe(201);
    // Both reports refused, the second start answered with no computer made.
    expect(during).toEqual([409, 409, 200, 1]);
    expect(providerCalls(harness, /DELETE .*\/instances\/madenew12345$/)).toHaveLength(1);
    expect(madeCalls()).toHaveLength(2);
    expect(harness.row("select state, expires_at from cloud_launches where launch_id = ?", LAUNCH)).toEqual({ state: "joining", expires_at: clock + 7 * DAY });
  });

  it("a Retry whose delete the provider refuses keeps the launch failed with its computer, so the next Retry deletes it", async () => {
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    harness.exec("update cloud_launches set state = 'failed', error = 'The clone failed.' where launch_id = ?", LAUNCH);
    harness.net.once.push({ match: /DELETE .*\/instances\/madenew12345$/, reply: harness.net.reply({ error: { code: "upstream" } }, 500) });

    expect((await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, retry: true })).status).toBe(503);
    expect(harness.row("select state, instance_id from cloud_launches where launch_id = ?", LAUNCH)).toEqual({ state: "failed", instance_id: "madenew12345" });
    expect(madeCalls()).toHaveLength(1);
    // A later Retry whose Worker stopped mid-delete leaves its hold: after 5 minutes a read says failed, so the client retries.
    harness.exec("update cloud_launches set state = 'retrying', updated_at = ? where launch_id = ?", clock, LAUNCH);
    clock += 6 * 60_000;
    expect(await (await harness.send(OWNER, "GET", `/cloud/launches/${LAUNCH}`)).json()).toEqual(expect.objectContaining({ state: "failed", instanceId: null }));

    expect((await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, retry: true })).status).toBe(201);
    expect(providerCalls(harness, /DELETE .*\/instances\/madenew12345$/)).toHaveLength(2);
    expect(madeCalls()).toHaveLength(2);
  });

  // A big repository's install fills the 4 GB every computer starts with: the setup grows it,
  // the computer restarts and setup runs again. The next launch starts at that disk instead,
  // inside the size's own disk (Pricing v2 has no account-wide disk).
  // `before`: a disk an earlier setup needed, and how long ago. `later`: one more launch that much later, and its disk.
  it.each<[string, { paid: boolean; agentStarted: boolean; before?: { diskGb: number; agoMs: number }; later?: { afterMs: number; diskGb: number } }, number | null, number]>([
    ["a paid account's next launch starts at the disk its setup grew to", { paid: true, agentStarted: false }, 8, 8],
    ["a free account's next launch starts at that disk too: there is no shared disk to leave room in", { paid: false, agentStarted: false }, 8, 8],
    ["a grow after the agent started is not the setup's, and records nothing", { paid: true, agentStarted: true }, null, 4],
    // A launch that grew only partway keeps the most the setup needed; a Small starts at its own limit, never past it.
    ["a smaller grow keeps the larger disk, and a Small starts at its 12 GB limit", { paid: true, agentStarted: false, before: { diskGb: 20, agoMs: DAY } }, 20, 12],
    ["a memory past its 90 days is replaced by the new grow", { paid: true, agentStarted: false, before: { diskGb: 20, agoMs: 91 * DAY } }, 8, 8],
    // The smaller grow on day 80 keeps day 0's peak and its date, so the peak still ages out: day 100 starts small.
    ["a smaller grow keeps the peak's date, so the peak still ages out", { paid: true, agentStarted: false, before: { diskGb: 20, agoMs: 80 * DAY }, later: { afterMs: 20 * DAY, diskGb: 4 } }, 20, 12],
  ])("%s", async (_label, { paid, agentStarted, before, later }, remembered, nextDisk) => {
    if (paid) harness.exec("update cloud_accounts set plan = 'paid', included_milli = 500000 where user_id = ?", OWNER);
    await harness.send(OWNER, "POST", "/cloud/launches", launchBody);
    // Written while this launch (started at 4 GB) was being made, by another computer's setup.
    if (before) {
      harness.insert("cloud_repo_disks", { user_id: OWNER, project_origin: "github.com/acme/widgets", setup_key: "", disk_gb: before.diskGb, launch_id: null, recorded_at: clock - before.agoMs });
    }
    if (agentStarted) harness.exec("update cloud_launches set state = 'running', stages_json = ? where launch_id = ?", JSON.stringify([{ id: "agent", status: "running" }]), LAUNCH);

    const grow = await harness.send(OWNER, "POST", "/cloud/instances/madenew12345/resize", { cpu: 2, memory: 4, disk: 8, computerIdle: true, origin: "auto" });
    expect(grow.status).toBe(200);
    expect(harness.rows("select disk_gb from cloud_repo_disks where user_id = ?", OWNER)).toEqual(remembered == null ? [] : [{ disk_gb: remembered }]);

    clock += HOUR;
    const next = await harness.send(OWNER, "POST", "/cloud/launches", {
      ...launchBody, launchId: "9d4f6b8a-3e5c-4c7d-9a1b-2c3d4e5f6a7b", lane: { id: "4e6a8c0b-3d5f-4c7b-9d2e-0f1a2b3c4d5e", name: "Next" },
    });
    expect(next.status).toBe(201);
    expect(madeCalls()[1]!.body!.resources).toEqual(expect.objectContaining({ disk: nextDisk }));
    // The reserved and billed disk is the disk the provider was asked for.
    expect(harness.row("select disk_gb from cloud_computers where request_id = ?", "9d4f6b8a-3e5c-4c7d-9a1b-2c3d4e5f6a7b")).toEqual({ disk_gb: nextDisk });
    if (later) {
      clock += later.afterMs;
      const last = await harness.send(OWNER, "POST", "/cloud/launches", {
        ...launchBody, launchId: "1b3d5f7a-9c2e-4d6f-8a1b-3c5d7e9f0a2b", lane: { id: "6a8c0e2b-4d6f-4a8c-9e1d-2f3a4b5c6d7e", name: "Later" },
      });
      expect(last.status).toBe(201);
      expect(madeCalls()[2]!.body!.resources).toEqual(expect.objectContaining({ disk: later.diskGb }));
    }
  });

  describe("a default-size launch whose setup runs out of memory", () => {
    const LAUNCH_2 = "7a2e4c6b-1d3f-4a5b-8c9d-0e1f2a3b4c5d";
    const LANE_2 = "3c5e7a9b-2d4f-4b6a-8c1d-9e0f1a2b3c4d";
    const moveUp = (launchId = LAUNCH, instanceId = "madenew12345") =>
      harness.send(OWNER, "POST", `/cloud/instances/${instanceId}/resize`, { cpu: 4, memory: 8, computerIdle: true, origin: "auto", launchId });
    const remembered = () => harness.rows("select project_origin, setup_key, size_id from cloud_repo_sizes where user_id = ?", OWNER);

    it("moves its own computer to Medium once, and the repository's next default launch starts there", async () => {
      await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, sizeChoice: "default" });

      expect((await moveUp()).status).toBe(200);
      expect(computer(harness, "madenew12345")).toEqual(expect.objectContaining({ cpu: 4, memory_gb: 8 }));
      expect(remembered()).toEqual([{ project_origin: "github.com/acme/widgets", setup_key: "", size_id: "medium" }]);
      expect(await (await harness.send(OWNER, "GET", `/cloud/launches/${LAUNCH}`)).json()).toEqual(expect.objectContaining({
        sizeId: "medium",
        autoSize: { from: "small", to: "medium", why: "setup_memory" },
      }));
      // One step: a second ask for the same launch (Medium ran out too) moves nothing.
      const again = await moveUp();
      expect([again.status, ((await again.json()) as { error: { code: string; reason: string } }).error]).toEqual([409, expect.objectContaining({ code: "size_kept", reason: "moved" })]);
      expect(providerCalls(harness, /POST .*\/resize$/)).toHaveLength(1);

      clock += HOUR;
      const next = await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, launchId: LAUNCH_2, lane: { id: LANE_2, name: "Next" }, sizeChoice: "default" });
      expect(await next.json()).toEqual(expect.objectContaining({ sizeId: "medium", autoSize: expect.objectContaining({ why: "remembered" }) }));
      expect(madeCalls()[1]!.body!.resources).toEqual(expect.objectContaining({ cpu: 4, memory: 8 }));
    });

    it.each<[string, Record<string, unknown>, "picked" | "capped" | null]>([
      ["a size picked for the launch", {}, "picked"],
      ["a default Small the agent limits keep", { sizeChoice: "capped" }, "capped"],
      ["a move the provider refuses", { sizeChoice: "default" }, null],
    ])("%s stays Small and records nothing", async (_label, choice, reason) => {
      await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, ...choice });
      if (!reason) harness.net.once.push({ match: /POST .*\/resize$/, reply: harness.net.reply({ error: { code: "quota_exceeded" } }, 422) });

      const response = await moveUp();

      expect(response.ok).toBe(false);
      if (reason) expect(((await response.json()) as { error: { reason: string } }).error.reason).toBe(reason);
      expect(remembered()).toEqual([]);
      expect(harness.row("select size_id, auto_size from cloud_launches where launch_id = ?", LAUNCH)).toEqual({ size_id: "small", auto_size: null });
      expect(computer(harness, "madenew12345")).toEqual(expect.objectContaining({ cpu: 2, memory_gb: 4 }));
      // The next default launch of the repository still starts at Small.
      await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, launchId: LAUNCH_2, lane: { id: LANE_2, name: "Next" }, sizeChoice: "default" });
      expect(madeCalls()[1]!.body!.resources).toEqual(expect.objectContaining({ cpu: 2, memory: 4 }));
    });

    it("a repository remembered as needing Medium starts at Small when the account has no hours left (Small may still run)", async () => {
      harness.insert("cloud_repo_sizes", { user_id: OWNER, project_origin: "github.com/acme/widgets", setup_key: "", size_id: "medium", launch_id: LAUNCH_2, recorded_at: clock });
      harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER);

      const started = await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, sizeChoice: "default" });

      expect(started.status).toBe(201);
      expect(await started.json()).toEqual(expect.objectContaining({ sizeId: "small", autoSize: null }));
      expect(madeCalls()[0]!.body!.resources).toEqual(expect.objectContaining({ cpu: 2, memory: 4 }));
      // Its setup can't move it up either: Medium uses hours.
      expect(((await (await moveUp()).json()) as { error: { code: string } }).error.code).toBe("out_of_hours");
    });

    // A Retry deletes the failed computer and starts a new one: at the size chosen now (the repository
    // needed Medium since), and with the choice sent now (an agent whose limits were lowered sends "capped").
    it.each<[string, "default" | "capped", string, { cpu: number; memory: number }]>([
      ["a retry of a default launch after the repository needed Medium starts there", "default", "medium", { cpu: 4, memory: 8 }],
      ["a retry the agent limits now hold at Small starts Small, and keeps that choice for a setup move", "capped", "small", { cpu: 2, memory: 4 }],
    ])("%s", async (_label, retryChoice, sizeId, resources) => {
      await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, sizeChoice: "default" });
      harness.insert("cloud_repo_sizes", { user_id: OWNER, project_origin: "github.com/acme/widgets", setup_key: "", size_id: "medium", launch_id: LAUNCH_2, recorded_at: clock });
      harness.exec("update cloud_launches set state = 'failed', error = 'The clone failed.' where launch_id = ?", LAUNCH);

      expect((await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, sizeChoice: retryChoice, retry: true })).status).toBe(201);

      expect(madeCalls()[1]!.body!.resources).toEqual(expect.objectContaining(resources));
      // What a setup move checks (`launchAutoSizeCheck`): the retry's own choice.
      const row = harness.row("select size_id, request_json from cloud_launches where launch_id = ?", LAUNCH) as { size_id: string; request_json: string };
      expect([row.size_id, JSON.parse(row.request_json).sizeChoice]).toEqual([sizeId, retryChoice]);
    });

    it("moves only the launch's own computer", async () => {
      await harness.send(OWNER, "POST", "/cloud/launches", { ...launchBody, sizeChoice: "default" });
      seedComputer(harness);
      provide(harness);

      const response = await moveUp(LAUNCH, INSTANCE);

      expect([response.status, ((await response.json()) as { error: { reason: string } }).error.reason]).toEqual([409, "not_launch"]);
      expect(providerCalls(harness, /POST .*\/resize$/)).toHaveLength(0);
      expect(remembered()).toEqual([]);
    });
  });

  it.each<[string, Record<string, string>, number, string | null]>([
    ["a preflight from the web client", { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" }, 204, WEB],
    ["a preflight from another site", { origin: "https://evil.test", "access-control-request-method": "POST" }, 403, null],
  ])("CORS: %s", async (_label, headers, status, allowed) => {
    const response = await handleCloudRequest(new Request("https://directory.test/cloud/launches", { method: "OPTIONS", headers }), harness.env);
    expect(response.status).toBe(status);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowed);
  });

  it("CORS: a browser call from another site is refused before anything runs; the web client's is answered", async () => {
    const refused = await harness.send(OWNER, "POST", "/cloud/launches", launchBody, { origin: "https://evil.test" });
    expect(refused.status).toBe(403);
    expect(madeCalls()).toHaveLength(0);

    const answered = await harness.send(OWNER, "GET", "/cloud/account", undefined, { origin: WEB });
    expect(answered.status).toBe(200);
    expect(answered.headers.get("access-control-allow-origin")).toBe(WEB);
  });
});

/*
 * Automations whose home is ADE Cloud (C9): the server starts each run, so
 * its own rules are the whole guard against running a rule twice at once,
 * running it without end, and taking a delivery nobody signed.
 */
describe("ADE Cloud automations", () => {
  const VERSION = "2026-11-09T12:00:00.000Z";
  const spec = (triggers: unknown[], limits: Record<string, unknown> = {}) => ({
    name: "Nightly review",
    project: { origin: "https://github.com/Acme/Widgets.git" },
    triggers,
    sizeId: "small",
    chat: { provider: "codex", modelId: "gpt-5", permissions: "full-auto", prompt: "Review the latest changes." },
    limits,
  });
  const register = (ruleId: string, body: Record<string, unknown>) =>
    harness.send(OWNER, "PUT", `/cloud/automations/${ruleId}`, { ruleVersion: VERSION, enabled: true, ...body });
  const runs = (ruleId: string) => harness.rows("select state, reason from cloud_automation_runs where rule_id = ? order by created_at, rowid", ruleId) as Array<{ state: string; reason: string | null }>;

  beforeEach(() => {
    seedAccount(harness, OWNER);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    harness.env.CLOUD_CHAT_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    // The vault answers (a GitHub sign-in, no stored agent limits: the default): limits never read refuse spending.
    Object.assign(harness.env, {
      PUSH_RELAY_URL: "https://relay.test",
      ACTIVITY_RELAY: {
        fetch: async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/attention/account/vault")
          ? { items: [{ kind: "integration", key: "github", value: JSON.stringify({ v: 1, token: "gho_test" }) }] }
          : { ok: true }), { status: 200 }),
      },
    });
  });

  it("starts one run at a time with one waiting, and pauses a rule past its runs an hour", async () => {
    expect((await register("nightly", { spec: spec([{ kind: "manual" }]) })).status).toBe(200);
    const states = [];
    for (let index = 0; index < 3; index += 1) {
      states.push(((await (await harness.send(OWNER, "POST", "/cloud/automations/nightly/run")).json()) as { state: string }).state);
    }
    // One computer made: the second waits for the first, the third is recorded and dropped.
    expect(states).toEqual(["running", "queued", "skipped"]);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);

    expect((await register("storm", { spec: spec([{ kind: "manual" }], { maxRunsPerHour: 1 }) })).status).toBe(200);
    await harness.send(OWNER, "POST", "/cloud/automations/storm/run");
    clock += 60_000;
    const stopped = await (await harness.send(OWNER, "POST", "/cloud/automations/storm/run")).json() as { state: string; reason: string };
    expect(stopped.state).toBe("skipped");
    expect(harness.row("select enabled, paused_reason from cloud_automations where rule_id = 'storm'")).toEqual({ enabled: 0, paused_reason: "storm" });
    expect(runs("storm").map((run) => run.state)).toEqual(["running", "skipped"]);
  });

  it("two rules started at once can't both take the day's last computer", async () => {
    for (const ruleId of ["first", "second"]) expect((await register(ruleId, { spec: spec([{ kind: "manual" }]) })).status).toBe(200);
    harness.exec("update cloud_automations set limits_json = ?", JSON.stringify({ unattendedSpend: true, machinesPerDay: 1, maxShape: "4x16" }));
    // The second rule's run starts while the first one's computer is being made.
    let second: { state: string; reason: string | null } | null = null;
    harness.net.after.push({ match: /POST .*\/instances$/, run: async () => {
      second = await (await harness.send(OWNER, "POST", "/cloud/automations/second/run")).json() as { state: string; reason: string | null };
    } });
    const first = await (await harness.send(OWNER, "POST", "/cloud/automations/first/run")).json() as { state: string };
    expect(first.state).toBe("running");
    expect(second).toMatchObject({ state: "failed", reason: expect.stringContaining("1 new computer a day") });
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);
  });

  it("takes a webhook delivery only signed with the hook's own key, and one run per delivery", async () => {
    const registered = await (await register("hooked", { spec: spec([{ kind: "webhook", hookId: "hook-abcdef12" }]) })).json() as { forward: { url: string; secret: string } };
    const deliver = (body: string, options: { secret?: string; timestamp?: number; hookId?: string } = {}) => {
      const timestamp = String(options.timestamp ?? clock);
      const signature = createHmac("sha256", Buffer.from(options.secret ?? registered.forward.secret, "hex")).update(`${timestamp}.${body}`).digest("hex");
      return handleCloudRequest(new Request(registered.forward.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ade-hook-id": options.hookId ?? "hook-abcdef12", "x-ade-hook-timestamp": timestamp, "x-ade-hook-signature": signature },
        body,
      }), harness.env);
    };
    const delivery = JSON.stringify({ eventId: "0b7c2f4e-9a51-4d0e-8c1a-3f6b2d9e7a11", method: "POST", body: "{\"ok\":true}", bodyEncoding: "utf8", receivedAt: new Date(clock).toISOString() });

    expect((await deliver(delivery, { secret: "ab".repeat(32) })).status).toBe(401);
    expect((await deliver(delivery, { timestamp: clock - 10 * 60_000 })).status).toBe(401);
    expect((await deliver(delivery, { hookId: "hook-unknown1" })).status).toBe(410);
    expect(runs("hooked")).toEqual([]);

    const first = await deliver(delivery);
    expect(first.status).toBe(202);
    // The relay sends again until it hears 2xx: the same delivery is the same run.
    const again = await deliver(delivery);
    expect((await again.json() as { runId: string }).runId).toBe((await first.json() as { runId: string }).runId);
    expect(runs("hooked")).toHaveLength(1);
  });

  it.each<[string, string, string, string, string | null]>([
    ["9:00 the day the clocks go forward", "0 9 * * *", "America/New_York", "2026-03-07T15:00:00Z", "2026-03-08T13:00:00.000Z"],
    ["3:30 the morning the clocks go forward", "30 3 * * *", "America/New_York", "2026-03-07T15:00:00Z", "2026-03-08T07:30:00.000Z"],
    ["a time the clocks skip doesn't fire that day", "30 2 * * *", "America/New_York", "2026-03-07T08:00:00Z", "2026-03-09T06:30:00.000Z"],
    ["a time the clocks pass twice fires at its first pass", "30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00.000Z"],
    ["...and not again at its second", "30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z", "2026-11-02T06:30:00.000Z"],
    ["Monday 9:00 in Berlin", "0 9 * * 1", "Europe/Berlin", "2026-11-11T12:00:00Z", "2026-11-16T08:00:00.000Z"],
    ["every 15 minutes in UTC", "*/15 * * * *", "UTC", "2026-11-11T12:07:00Z", "2026-11-11T12:15:00.000Z"],
    ["a zone ADE doesn't know", "0 9 * * *", "Mars/Olympus", "2026-11-11T12:00:00Z", null],
  ])("a schedule's next fire: %s", (_label, cron, zone, after, expected) => {
    const next = nextFireAt(cron, zone, Date.parse(after));
    expect(next == null ? null : new Date(next).toISOString()).toBe(expected);
  });
});

// --- server-edge ---
/*
 * Account data with no computer, and wakes from events: the privacy and trust
 * seams only. A secrets list must never carry a value, whatever relay
 * answers; Jira calls never leave atlassian.net; only the webhook relay's
 * secret wakes a computer, at most once per cooldown.
 */
describe("ADE Cloud account data and event wakes", () => {
  const RELAY = "https://relay.test";
  const vaultRows = [
    { scope: "all", kind: "provider_api_key", key: "anthropic", value: "sk-ant-secret-value", updatedAt: "2026-11-01T00:00:00.000Z" },
    { scope: "all", kind: "secret", key: "mcp/github/env/GITHUB_TOKEN", value: "ghp_secret_value", updatedAt: "2026-11-01T00:00:00.000Z" },
    { scope: "all", kind: "provider_login", key: "antigravity/0123456789ab.default", value: "login-secret-blob", updatedAt: "2026-11-01T00:00:00.000Z" },
  ];

  function withRelay(data: Harness, narrowRoutes: boolean): void {
    Object.assign(data.env, {
      PUSH_RELAY_URL: RELAY,
      ACTIVITY_RELAY: {
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
          if (url.pathname === "/attention/account/vault/keys") {
            if (!narrowRoutes) return reply({ ok: false, error: "not found" }, 404);
            return reply({ ok: true, items: vaultRows.map(({ value: _value, ...row }) => row) });
          }
          if (url.pathname === "/attention/account/vault") return reply({ ok: true, items: vaultRows, truncated: false, cursor: null });
          return reply({ ok: false, error: "not found" }, 404);
        },
      },
    });
  }

  it.each([["a relay with the keys read", true], ["an older relay (full read)", false]])(
    "lists saved secrets by name only, never a value, from %s",
    async (_label, narrowRoutes) => {
      const data = harness;
      seedAccount(data, OWNER);
      withRelay(data, narrowRoutes);
      const response = await data.send(OWNER, "GET", "/cloud/account-secrets");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        secrets: [
          { scope: "all", kind: "provider_api_key", key: "anthropic", updatedAt: "2026-11-01T00:00:00.000Z" },
          { scope: "all", kind: "secret", key: "mcp/github/env/GITHUB_TOKEN", updatedAt: "2026-11-01T00:00:00.000Z" },
        ],
      });
      expect(text).not.toMatch(/secret-value|secret_value|login-secret|antigravity/);
    },
  );

  it.each<[string, string | null]>([
    ["acme.atlassian.net", "https://acme.atlassian.net"],
    ["https://Acme.atlassian.net/jira/software", "https://acme.atlassian.net"],
    ["http://acme.atlassian.net", null],
    ["https://acme.atlassian.net:8443", null],
    ["https://user:pw@acme.atlassian.net", null],
    ["https://acme.atlassian.net.evil.example", null],
    ["https://evil.example/.atlassian.net", null],
    ["https://evil.example#.atlassian.net", null],
    ["https://169.254.169.254", null],
    ["https://jira.acme.example", null],
  ])("lets Jira reach %s only as %s", async (siteUrl, expected) => {
    const { jiraSiteOrigin } = await import("../src/cloud/integrations");
    expect(jiraSiteOrigin(siteUrl)).toBe(expected);
  });

  const SECRET = "event-wake-secret-for-tests";
  const wake = (secret: string | null, topic = `hooks-account:${OWNER}`) => handleCloudRequest(new Request("https://directory.test/cloud/internal/event-wake", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-ade-event-wake-secret": secret } : {}) },
    body: JSON.stringify({ topic }),
  }), harness.env);

  it("wakes a listening computer only for the webhook relay's secret, once per cooldown", async () => {
    const data = harness;
    seedAccount(data, OWNER);
    seedComputer(data, { status: "sleeping", awake_since: null });
    provide(data, INSTANCE, "sleeping");
    const set = await data.send(OWNER, "PUT", `/cloud/instances/${INSTANCE}/event-wakes`, { topics: [`hooks-account:${OWNER}`, "linear-org:org-1"] });
    expect(set.status).toBe(200);
    const starts = () => providerCalls(data, new RegExp(`POST .*/instances/${INSTANCE}/start$`)).length;

    expect((await wake(null)).status).toBe(503);
    (data.env as CloudEnv & { CLOUD_EVENT_WAKE_SECRET?: string }).CLOUD_EVENT_WAKE_SECRET = SECRET;
    expect((await wake(null)).status).toBe(404);
    expect((await wake("not-the-secret")).status).toBe(404);
    expect(starts()).toBe(0);

    const first = await wake(SECRET);
    expect(await first.json()).toEqual({ subscribed: true, woken: 1 });
    expect(starts()).toBe(1);
    // Asleep again, a second delivery inside the cooldown wakes nothing.
    data.exec("update cloud_computers set status = 'sleeping' where instance_id = ?", INSTANCE);
    data.net.instances.get(INSTANCE)!.status = "sleeping";
    clock = NOW + 60_000;
    await wake(SECRET);
    expect(starts()).toBe(1);
    clock = NOW + 6 * 60_000;
    await wake(SECRET);
    expect(starts()).toBe(2);
    expect(await (await wake(SECRET, "linear-org:org-unknown")).json()).toEqual({ subscribed: false, woken: 0 });

    // A move from the saved copy claims the delete after this wake read the computer: the wake starts nothing.
    data.exec("update cloud_computers set status = 'sleeping', awake_since = null where instance_id = ?", INSTANCE);
    data.net.instances.get(INSTANCE)!.status = "sleeping";
    clock = NOW + 12 * 60_000;
    data.injectFault((sql) => {
      if (/insert into cloud_event_wake_state/.test(sql)) data.exec("update cloud_computers set idle_deleting_at = ? where instance_id = ?", clock, INSTANCE);
      return false;
    });
    expect(await (await wake(SECRET)).json()).toEqual({ subscribed: true, woken: 0 });
    data.injectFault(null);
    expect(starts()).toBe(2);
  });

  it("refuses an event topic of another account", async () => {
    const data = harness;
    seedAccount(data, OWNER);
    seedComputer(data);
    const response = await data.send(OWNER, "PUT", `/cloud/instances/${INSTANCE}/event-wakes`, { topics: [`hooks-account:${OTHER}`] });
    expect(response.status).toBe(400);
    expect(data.row("select count(*) as n from cloud_event_wakes").n).toBe(0);
  });
});

/*
 * The directory renews a Linear grant when no computer does (linearRenewal.ts):
 * the lease and its conditional writes only. A rotated refresh token that the
 * vault never receives signs the person out of Linear on every computer, so
 * these pin: no exchange without a settled lease, one exchange per lease, a
 * publish that names the lease revision, and a renewed grant that outlives a
 * failed publish until the cron's lease route delivers it.
 */
describe("ADE Cloud Linear renewal", () => {
  const ORIGIN = "https://github.com/acme/app";
  const SCOPE = "repo:github.com/acme/app";
  const ADE_CLIENT = "e552c738cd63ea5967f08bbc9c09b54c";
  const MACHINE = "device-machine-a";
  const SERVER = "ade-cloud-directory";
  type Row = { value: string; updatedAt: string; refreshOwner: string | null; writer: string | null; deleted?: boolean };

  let vault: Map<string, Row>;
  let revisionClock: number;
  let failVaultWrites: boolean;
  let leaseCalls: Array<{ auth: string | null; body: Record<string, unknown> }>;
  let tokenCalls: Array<{ refreshToken: string | null; clientId: string | null }>;
  let tokenAnswer: () => Response;
  let pending: Promise<unknown>[];
  let beforeItemRead: Array<() => void>;
  const itemKey = `${SCOPE}|integration|linear`;
  const nextRevision = () => new Date(++revisionClock).toISOString();
  const grant = (token: string, refresh: string, expiresAt: number, extra: Record<string, unknown> = { clientId: ADE_CLIENT }) =>
    JSON.stringify({ v: 1, authMode: "oauth", token, refreshToken: refresh, expiresAt: new Date(expiresAt).toISOString(), ...extra });
  const stored = () => JSON.parse(vault.get(itemKey)!.value) as Record<string, unknown>;

  beforeEach(() => {
    vault = new Map();
    revisionClock = NOW - HOUR;
    failVaultWrites = false;
    leaseCalls = [];
    tokenCalls = [];
    pending = [];
    beforeItemRead = [];
    let issued = 0;
    tokenAnswer = () => {
      issued += 1;
      return new Response(JSON.stringify({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 86_399 }), { status: 200 });
    };
    Object.assign(harness.env, {
      PUSH_RELAY_URL: "https://relay.test",
      DIRECTORY_AUTH_SECRET: "directory-secret",
      CLOUD_CHAT_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      // The relay's vault, with its revision rule: a write names the revision it replaces, or this device wrote last.
      ACTIVITY_RELAY: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
          if (url.pathname === "/attention/account/vault/item") {
            beforeItemRead.shift()?.();
            const row = vault.get(`${url.searchParams.get("scope")}|${url.searchParams.get("kind")}|${url.searchParams.get("key")}`);
            return reply({ ok: true, item: row ? { scope: SCOPE, kind: "integration", key: "linear", ...row } : null });
          }
          if (url.pathname === "/attention/account/vault" && init?.method === "PUT") {
            if (failVaultWrites) return reply({ ok: false }, 500);
            const body = JSON.parse(String(init.body)) as { deviceId: string; items: Array<Record<string, string>> };
            const item = body.items[0]!;
            const key = `${item.scope}|${item.kind}|${item.key}`;
            const row = vault.get(key);
            if (row && row.updatedAt !== item.ifRevision && row.writer !== body.deviceId) return reply({ ok: true, results: [{ status: "stale" }] });
            vault.set(key, { value: item.value!, updatedAt: nextRevision(), refreshOwner: item.refreshOwner ?? null, writer: body.deviceId });
            return reply({ ok: true, results: [{ status: "written" }] });
          }
          const lease = url.pathname.match(/^\/directory\/accounts\/([^/]+)\/vault\/linear-lease$/);
          if (lease && init?.method === "PUT") {
            const body = JSON.parse(String(init.body)) as Record<string, string>;
            leaseCalls.push({ auth: new Headers(init.headers).get("x-ade-directory-auth"), body });
            const row = vault.get(`${body.scope}|integration|linear`);
            if (!row || row.deleted || (JSON.parse(row.value) as { refreshToken?: string }).refreshToken !== body.spentRefreshToken) return reply({ ok: true, written: 0 });
            vault.set(`${body.scope}|integration|linear`, { value: body.value!, updatedAt: nextRevision(), refreshOwner: body.refreshOwner!, writer: body.refreshOwner! });
            return reply({ ok: true, written: 1 });
          }
          return reply({ ok: false }, 404);
        },
      },
    });
    const providerFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api.linear.app/oauth/token") {
        const form = new URLSearchParams(String(init?.body));
        tokenCalls.push({ refreshToken: form.get("refresh_token"), clientId: form.get("client_id") });
        return tokenAnswer();
      }
      if (url === "https://api.linear.app/graphql") {
        return new Response(JSON.stringify({ data: { viewer: { id: "u1", authorization: new Headers(init?.headers).get("authorization") } } }), { status: 200 });
      }
      return providerFetch(input, init);
    });
    seedAccount(harness, OWNER);
  });

  const ask = async () => {
    const response = await handleCloudRequest(new Request("https://directory.test/cloud/integrations/linear/query", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[OWNER]}`, "content-type": "application/json" },
      body: JSON.stringify({ origin: ORIGIN, op: "identity" }),
    }), harness.env, (promise) => { pending.push(promise); });
    await Promise.all(pending.splice(0));
    const body = await response.json() as { error?: { code: string }; data?: { viewer?: { authorization?: string } } };
    return body.error?.code ?? body.data?.viewer?.authorization ?? `status ${response.status}`;
  };

  it("claims a quiet owner's grant, exchanges once after the claim settles, and publishes it against the lease revision", async () => {
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });

    expect(await ask()).toBe("linear_renewing");
    expect(vault.get(itemKey)).toMatchObject({ refreshOwner: SERVER });
    expect(stored().refreshToken).toBe("refresh-0");
    clock = NOW + 10_000;
    expect(await ask()).toBe("linear_renewing");
    expect(tokenCalls).toEqual([]);

    // Past the settle, two requests at once: one exchange.
    clock = NOW + 31_000;
    const both = await Promise.all([ask(), ask()]);
    expect(both).toEqual(["linear_renewing", "linear_renewing"]);
    expect(tokenCalls).toEqual([{ refreshToken: "refresh-0", clientId: ADE_CLIENT }]);
    expect(stored()).toMatchObject({ token: "access-1", refreshToken: "refresh-1", clientId: ADE_CLIENT });
    expect(vault.get(itemKey)!.refreshOwner).toBe(SERVER);
    expect(harness.row("select count(*) as n from cloud_linear_renewals").n).toBe(0);
    expect(await ask()).toBe("Bearer access-1");
  });

  it("lets go without exchanging when another device writes the item after the lease was read", async () => {
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });
    await ask();
    clock = NOW + 31_000;
    // The request reads the item; then the old owner wakes and publishes its own turn before the exchange looks again.
    beforeItemRead.push(() => {}, () => {
      vault.set(itemKey, { value: grant("access-m", "refresh-m", NOW + DAY), updatedAt: nextRevision(), refreshOwner: MACHINE, writer: MACHINE });
    });
    expect(await ask()).toBe("linear_renewing");
    expect(tokenCalls).toEqual([]);
    expect(stored()).toMatchObject({ refreshToken: "refresh-m" });
    expect(vault.get(itemKey)!.refreshOwner).toBe(MACHINE);
    expect(await ask()).toBe("Bearer access-m");
  });

  it("leaves an owner inside its grace, a grant of another client, and a dead grant alone", async () => {
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 2 * 60_000), updatedAt: new Date(NOW - 2 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });
    const before = vault.get(itemKey);
    expect(await ask()).toBe("linear_renewing");
    expect(vault.get(itemKey)).toBe(before);

    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000, {}), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });
    expect(await ask()).toBe("linear_needs_renewal");
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000, { clientId: "a-persons-own-client" }), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });
    expect(await ask()).toBe("linear_needs_renewal");
    expect(tokenCalls).toEqual([]);

    // Dead at Linear: the vault item is a computer's to remove, never the server's.
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: MACHINE, writer: MACHINE });
    tokenAnswer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    await ask();
    clock = NOW + 31_000;
    await ask();
    expect(tokenCalls).toHaveLength(1);
    expect(stored().refreshToken).toBe("refresh-0");
    expect(vault.get(itemKey)!.deleted).toBeUndefined();
    expect(harness.row("select count(*) as n from cloud_linear_renewals").n).toBe(0);
  });

  it("keeps a renewed grant sealed when its publish fails, uses it, and the cron delivers it through the lease route", async () => {
    vault.set(itemKey, { value: grant("access-0", "refresh-0", NOW - 20 * 60_000), updatedAt: new Date(NOW - 20 * 60_000).toISOString(), refreshOwner: null, writer: MACHINE });
    await ask();
    clock = NOW + 31_000;
    failVaultWrites = true;
    expect(await ask()).toBe("linear_renewing");
    expect(tokenCalls).toHaveLength(1);
    expect(stored().refreshToken).toBe("refresh-0");
    const row = harness.row("select state, sealed_grant from cloud_linear_renewals");
    expect(row.state).toBe("publish");
    expect(String(row.sealed_grant)).not.toMatch(/refresh-1|access-1/);

    // The person keeps working on the renewed grant meanwhile; no second exchange.
    clock = NOW + 45_000;
    expect(await ask()).toBe("Bearer access-1");
    expect(tokenCalls).toHaveLength(1);

    clock = NOW + 2 * 60_000;
    await runLinearRenewalCron(harness.env, clock);
    expect(leaseCalls).toEqual([{ auth: "directory-secret", body: expect.objectContaining({ scope: SCOPE, spentRefreshToken: "refresh-0", refreshOwner: SERVER }) }]);
    expect(stored()).toMatchObject({ token: "access-1", refreshToken: "refresh-1" });
    expect(harness.row("select count(*) as n from cloud_linear_renewals").n).toBe(0);
  });
});

/** R2 in memory: only what the saved-chat and capsule routes call. */
function memoryBucket(): R2Bucket {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  const objectOf = (key: string) => {
    const stored = objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength, customMetadata: stored.customMetadata, arrayBuffer: async () => stored.bytes.slice().buffer } : null;
  };
  return {
    put: async (key: string, value: ArrayBuffer | Uint8Array | string, options?: { customMetadata?: Record<string, string> }) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value));
      objects.set(key, { bytes: bytes.slice(), customMetadata: options?.customMetadata });
      return objectOf(key);
    },
    get: async (key: string) => objectOf(key),
    head: async (key: string) => objectOf(key),
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => objectOf(key)!),
      truncated: false,
    }),
  } as unknown as R2Bucket;
}

describe("ADE Cloud without a computer", () => {
  const LANE = "5d1e8a3c-2b4f-4e6a-9c7d-1f0b3a5e8c21";

  beforeEach(() => {
    harness.env.CLOUD_CHAT_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    harness.env.CLOUD_CHATS = memoryBucket();
  });

  const savePart = (instanceId: string, machineKey: string, seq: number, text: string) => harness.send(OWNER, "PUT", `/cloud/chats/${machineKey}/c1/parts/${seq}`, {
    instanceId, text, row: { lastSeq: seq, laneId: LANE, projectKey: "github.com/acme/widgets", provider: "claude", model: "claude-sonnet" },
  });

  it("a message to a resting chat is kept once and sent once: a refused send stores nothing, two claims race and one wins, only it finishes the message, its checked settings go sealed to the computer only", async () => {
    seedAccount(harness, OWNER, { used_milli: 100_000 });
    seedComputer(harness, { machine_key: "key-a", status: "sleeping", awake_since: null });
    provide(harness, INSTANCE, "sleeping");
    expect((await savePart(INSTANCE, "key-a", 1, "{}\n")).status).toBe(200);
    const messages = "/cloud/chats/key-a/c1/messages";
    const queued = () => harness.rows("select message_id, state from cloud_chat_messages");

    // Out of hours: refused like a wake, and nothing is kept to arrive later.
    const refused = await harness.send(OWNER, "POST", messages, { messageId: "m1", text: "Fix the footer." });
    expect([refused.status, ((await refused.json()) as { error?: { code?: string } }).error?.code]).toEqual([402, "out_of_hours"]);
    expect(queued()).toEqual([]);
    expect(providerCalls(harness, /POST .*\/start$/)).toHaveLength(0);

    harness.exec("update cloud_accounts set used_milli = 0 where user_id = ?", OWNER);
    // An image that never listed `chat_queue` can't drain: refused before anything is kept, until its boot report lists it.
    const old = await harness.send(OWNER, "POST", messages, { messageId: "m1", text: "Fix the footer." });
    expect([old.status, ((await old.json()) as { error?: { code?: string } }).error?.code]).toEqual([409, "update_needed"]);
    expect(queued()).toEqual([]);
    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/booted`, { adeVersion: "1.2.131", features: ["chat_queue", "later_feature"] })).status).toBe(200);
    expect(harness.row("select ade_features from cloud_computers where instance_id = ?", INSTANCE).ade_features).toBe("chat_queue");
    // Settings keep known keys with short plain values only.
    const settings = { reasoningEffort: "xhigh", fastMode: true, fastTier: "turbo", presetId: "<b>p</b>", runtimeActor: "cto" };
    const sent = await harness.send(OWNER, "POST", messages, { messageId: "m1", text: "Fix the footer.", settings });
    expect(sent.status).toBe(201);
    expect(((await sent.json()) as { wake: unknown }).wake).toEqual({ state: "waking" });
    // The same id again is the same message, with no second wake.
    expect((await harness.send(OWNER, "POST", messages, { messageId: "m1", text: "Fix the footer." })).status).toBe(200);
    expect(providerCalls(harness, /POST .*\/start$/)).toHaveLength(1);
    expect(providerCalls(harness, /POST .*\/exec$/).map((call) => call.body?.command)).toEqual(["ade cloud messages drain --json"]);
    // The text is sealed at rest; another account sees no such chat or computer.
    expect(JSON.stringify(harness.rows("select * from cloud_chat_messages"))).not.toContain("footer");
    expect(JSON.stringify(harness.rows("select * from cloud_chat_messages"))).not.toContain("xhigh");
    // The person's own list shows no settings; the computer's list carries them, checked.
    expect(JSON.stringify(await (await harness.send(OWNER, "GET", messages)).json())).not.toContain("xhigh");
    const forComputer = (await (await harness.send(OWNER, "GET", `/cloud/instances/${INSTANCE}/messages`)).json()) as { messages: Array<{ settings?: unknown }> };
    expect(forComputer.messages.map((message) => message.settings)).toEqual([{ reasoningEffort: "xhigh", fastMode: true }]);
    expect((await harness.send(OTHER, "GET", messages)).status).toBe(404);
    expect((await harness.send(OTHER, "GET", `/cloud/instances/${INSTANCE}/messages`)).status).toBe(404);

    const claim = (claimId: string) => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/messages/m1/claim`, { claimId });
    const report = (claimId: string, state: string) => harness.send(OWNER, "PUT", `/cloud/instances/${INSTANCE}/messages/m1`, { claimId, state });
    const [CLAIM_A, CLAIM_B] = ["claim-aaaaaaaaaaaaaaaa", "claim-bbbbbbbbbbbbbbbb"];
    const raced = await Promise.all([claim(CLAIM_A), claim(CLAIM_B)]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    const [winner, loser] = raced[0]!.status === 200 ? [CLAIM_A, CLAIM_B] : [CLAIM_B, CLAIM_A];
    expect([(await report(loser, "delivered")).status, (await report(winner, "delivered")).status, (await report(winner, "failed")).status]).toEqual([409, 200, 409]);
    // Delivered stays delivered: no later claim or cancel touches it.
    expect([(await claim(loser)).status, (await harness.send(OWNER, "DELETE", `${messages}/m1`)).status]).toEqual([409, 409]);
    expect(queued()).toEqual([{ message_id: "m1", state: "delivered" }]);
  });

  it("a fork restore moves a saved chat to the new computer with its full history: it lists once, old names still read it, nothing is uploaded again", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-old" });
    expect((await savePart(INSTANCE, "key-old", 1, "first\n")).status).toBe(200);
    expect((await savePart(INSTANCE, "key-old", 2, "second\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-new" });
    const move = (caller: string, toMachineKey = "key-new") => harness.send(caller, "POST", "/cloud/chats/key-old/c1/move", { toMachineKey, instanceId: SECOND });
    const partsOf = async (machineKey: string) => ((await (await harness.send(OWNER, "GET", `/cloud/chats/${machineKey}/c1`)).json()) as { parts: Array<{ text: string }> }).parts.map((part) => part.text);

    expect([(await move(OTHER)).status, (await move(OWNER, "key-else")).status]).toEqual([404, 409]);
    const moved = await move(OWNER);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ chat: expect.objectContaining({ machineKey: "key-new", lastSeq: 2, forkedFrom: { machineKey: "key-old", chatId: "c1" } }), moved: true });
    // Once, under the new key; the same move again answers the moved row.
    const listed = (await (await harness.send(OWNER, "GET", "/cloud/chats")).json()) as { chats: Array<{ machineKey: string; chatId: string }> };
    expect(listed.chats.map((chat) => [chat.machineKey, chat.chatId])).toEqual([["key-new", "c1"]]);
    expect(((await (await move(OWNER)).json()) as { moved: boolean }).moved).toBe(false);
    // The full history reads under the new key, and under the old one (an older client), with no new upload.
    expect([await partsOf("key-new"), await partsOf("key-old")]).toEqual([["second\n", "first\n"], ["second\n", "first\n"]]);
    // The new computer's uploader goes on from the restored seq; the old key can't write over the moved parts.
    expect((await savePart(SECOND, "key-new", 3, "third\n")).status).toBe(200);
    expect(await partsOf("key-new")).toEqual(["third\n", "second\n", "first\n"]);
    seedComputer(harness, { instance_id: "thirdbox12", machine_key: "key-old" });
    expect((await savePart("thirdbox12", "key-old", 1, "other\n")).status).toBe(409);
  });

  it("a fork capsule is replaced only at its new upload's commit, a move keeps it when asked, and its delete removes every part", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-old" });
    const capsule = "/cloud/capsules/key-old/c1";
    const putPart = async (part: number, text: string) => (await harness.send(OWNER, "PUT", `${capsule}/parts/${part}`, text, { "x-ade-instance": INSTANCE })).status;
    const commit = async (parts: number) => (await harness.send(OWNER, "POST", `${capsule}/commit`, { instanceId: INSTANCE, parts, provider: "claude", transportKind: "claude-jsonl", sessionKind: "chat", laneId: LANE })).status;
    const readPart = async (part: number) => {
      const response = await harness.send(OWNER, "GET", `${capsule}/parts/${part}`);
      return response.status === 200 ? JSON.parse(await response.text()) as string : response.status;
    };
    const manifestParts = async () => ((await (await harness.send(OWNER, "GET", capsule)).json()) as { parts?: number }).parts ?? null;
    const stored = async () => (await harness.env.CLOUD_CHATS!.list({ prefix: "capsules/" })).objects.length;

    expect([await putPart(1, "old 1"), await putPart(2, "old 2"), await commit(2)]).toEqual([200, 200, 200]);
    // A new upload that stops after its first part: the committed capsule reads whole, as before.
    expect(await putPart(1, "new 1")).toBe(200);
    expect([await manifestParts(), await readPart(1), await readPart(2)]).toEqual([2, "old 1", "old 2"]);
    // A commit that names parts it never uploaded changes nothing.
    expect([await commit(2), await readPart(1)]).toEqual([409, "old 1"]);
    // Its commit swaps it in, and only then do the older parts go.
    expect(await commit(1)).toBe(200);
    expect([await manifestParts(), await readPart(1), await readPart(2), await stored()]).toEqual([1, "new 1", 404, 1]);

    // A restore's move keeps the capsule at its old key until the restore used it.
    expect((await savePart(INSTANCE, "key-old", 1, "first\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-new" });
    expect((await harness.send(OWNER, "POST", "/cloud/chats/key-old/c1/move", { toMachineKey: "key-new", instanceId: SECOND, keepCapsule: true })).status).toBe(200);
    expect(await readPart(1)).toBe("new 1");
    expect(await (await harness.send(OWNER, "DELETE", capsule)).json()).toEqual({ deleted: true });
    expect([await manifestParts(), await stored()]).toEqual([null, 0]);

    // A new save starts while a delete sweeps: the delete takes only the uploads it ended, never the new one's parts.
    const putAs = async (part: number, text: string) => (await harness.send(OWNER, "PUT", `${capsule}/parts/${part}`, text, { "x-ade-instance": SECOND })).status;
    expect(await putAs(1, "gone 1")).toBe(200);
    const bucket = harness.env.CLOUD_CHATS!;
    const list = bucket.list.bind(bucket);
    let savedDuring: number | null = null;
    bucket.list = async (options) => {
      if (savedDuring == null && options?.prefix?.startsWith("capsules/")) savedDuring = await putAs(1, "kept 1");
      return list(options);
    };
    expect(await (await harness.send(OWNER, "DELETE", capsule)).json()).toEqual({ deleted: true });
    bucket.list = list;
    const committed = await harness.send(OWNER, "POST", `${capsule}/commit`, { instanceId: SECOND, parts: 1, provider: "claude", transportKind: "claude-jsonl", sessionKind: "chat", laneId: LANE });
    expect([savedDuring, committed.status, await readPart(1), await stored()]).toEqual([200, 200, "kept 1", 1]);
  });

  it("two uploads of one capsule never mix, and a new upload never deletes one that committed while it started", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-old" });
    const capsule = "/cloud/capsules/key-old/c1";
    const putPart = async (part: number, text: string, uploadId?: string) => {
      const response = await harness.send(OWNER, "PUT", `${capsule}/parts/${part}`, text, { "x-ade-instance": INSTANCE, ...(uploadId ? { "x-ade-capsule-upload": uploadId } : {}) });
      const body = (await response.json()) as { uploadId?: string; error?: { code?: string } };
      return { status: response.status, uploadId: body.uploadId ?? null, code: body.error?.code ?? null };
    };
    const commit = async (parts: number, uploadId?: string) => (await harness.send(OWNER, "POST", `${capsule}/commit`, { instanceId: INSTANCE, uploadId, parts, provider: "claude", transportKind: "claude-jsonl", sessionKind: "chat", laneId: LANE })).status;
    const readParts = async () => {
      const manifest = (await (await harness.send(OWNER, "GET", capsule)).json()) as { parts?: number };
      const parts: unknown[] = [];
      for (let part = 1; part <= (manifest.parts ?? 0); part += 1) {
        const response = await harness.send(OWNER, "GET", `${capsule}/parts/${part}`);
        parts.push(response.status === 200 ? JSON.parse(await response.text()) : response.status);
      }
      return parts;
    };

    // Two saves at once: B's part 1 replaces A's upload, so A's later part and commit are refused, never mixed into B's.
    const a = await putPart(1, "a 1");
    const b = await putPart(1, "b 1");
    expect([a.status, b.status, a.uploadId !== b.uploadId]).toEqual([200, 200, true]);
    expect((await putPart(2, "a 2", a.uploadId!)).code).toBe("capsule_replaced");
    expect(await commit(2, a.uploadId!)).toBe(409);
    expect((await putPart(2, "b 2", b.uploadId!)).status).toBe(200);
    expect([await commit(2, b.uploadId!), await readParts()]).toEqual([200, ["b 1", "b 2"]]);
    // The same commit again answers the capsule; nothing of A's upload is left.
    expect(await commit(2, b.uploadId!)).toBe(200);
    expect((await harness.env.CLOUD_CHATS!.list({ prefix: "capsules/" })).objects).toHaveLength(2);

    // A new part 1 read C as pending, then C committed before the part 1 replaced it: C stays readable.
    const c = await putPart(1, "c 1");
    let landed = false;
    harness.injectFault((sql) => {
      if (!landed && /pending_parts = 0/.test(sql)) {
        landed = true;
        harness.exec(`update cloud_fork_capsules set r2_key = pending_r2_key, parts = pending_parts, committed_at = ?, pending_r2_key = null, pending_parts = 0, pending_bytes = 0
          where pending_r2_key = ?`, NOW, `capsules/${OWNER}/key-old/c1/u/${c.uploadId}/`);
      }
      return false;
    });
    expect((await putPart(1, "d 1")).status).toBe(200);
    harness.injectFault(null);
    expect([landed, await readParts()]).toEqual([true, ["c 1"]]);

    // A retry of E's part 2 lands after E committed: the committed capsule keeps reading that part.
    const e = await putPart(1, "e 1");
    expect((await putPart(2, "e 2", e.uploadId!)).status).toBe(200);
    let committedFirst = false;
    harness.injectFault((sql) => {
      if (!committedFirst && /set pending_parts = max\(pending_parts/.test(sql)) {
        committedFirst = true;
        harness.exec(`update cloud_fork_capsules set r2_key = pending_r2_key, parts = pending_parts, committed_at = ?, pending_r2_key = null, pending_parts = 0, pending_bytes = 0
          where pending_r2_key = ?`, NOW, `capsules/${OWNER}/key-old/c1/u/${e.uploadId}/`);
      }
      return false;
    });
    expect((await putPart(2, "e 2", e.uploadId!)).code).toBe("capsule_replaced");
    harness.injectFault(null);
    expect([committedFirst, await readParts()]).toEqual([true, ["e 1", "e 2"]]);
  });

  it("a CLI copy that two computers move at once lands on one: only that move says moved, and the copy reads there", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-cli" });
    const saved = await harness.send(OWNER, "PUT", "/cloud/sessions/key-cli/cli-1", {
      instanceId: INSTANCE, format: "text", text: "$ ready\n", row: { kind: "cli", toolType: "cursor-cli", laneId: LANE, projectKey: "github.com/acme/widgets" },
    });
    expect(saved.status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-new" });
    seedComputer(harness, { instance_id: "thirdbox12", machine_key: "key-third" });
    const moveTo = (instanceId: string, toMachineKey: string) => harness.send(OWNER, "POST", "/cloud/sessions/key-cli/cli-1/move", { toMachineKey, instanceId });

    const answers = await Promise.all([moveTo(SECOND, "key-new"), moveTo("thirdbox12", "key-third")]);
    const read = await Promise.all(answers.map(async (answer) => [answer.status, answer.status === 200 ? ((await answer.json()) as { moved: boolean }).moved : ((await answer.json()) as { error?: { code?: string } }).error?.code]));

    expect(read.map(String).sort()).toEqual(["200,true", "409,session_moved"]);
    const winner = read[0]![1] === true ? "key-new" : "key-third";
    expect(harness.rows("select machine_key from cloud_session_copies")).toEqual([{ machine_key: winner }]);
    const copy = await harness.send(OWNER, "GET", `/cloud/sessions/${winner}/cli-1`);
    expect([copy.status, ((await copy.json()) as { text: string }).text]).toEqual([200, "$ ready\n"]);
  });

  it("a CLI copy's move reads again when the copies change under it: a new computer's copy that goes, or a newer save, never loses the copy or its messages", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-cli" });
    const save = (instanceId: string, key: string, text: string) => harness.send(OWNER, "PUT", `/cloud/sessions/${key}/cli-1`, {
      instanceId, format: "text", text, row: { kind: "cli", toolType: "cursor-cli", laneId: LANE, projectKey: "github.com/acme/widgets" },
    });
    const textAt = async (key: string) => {
      const copy = await harness.send(OWNER, "GET", `/cloud/sessions/${key}/cli-1`);
      return copy.status === 200 ? ((await copy.json()) as { text: string }).text : copy.status;
    };
    const waitingAt = () => harness.rows("select machine_key from cloud_chat_messages where message_id = 'm-wait'");
    expect((await save(INSTANCE, "key-cli", "$ ready\n")).status).toBe(200);
    harness.insert("cloud_chat_messages", { user_id: OWNER, machine_key: "key-cli", chat_id: "cli-1", message_id: "m-wait", via_launch: 0, seq: 1, body_sealed: "sealed", state: "queued", created_at: NOW, updated_at: NOW });
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-new" });
    expect((await save(SECOND, "key-new", "$ new\n")).status).toBe(200);
    // The new computer's copy is deleted after the move read it, before its write: the write moves nothing,
    // and the move's second read finds no copy there and moves the old one, with its message.
    let gone = false;
    let waitingOnRetry: unknown = null;
    harness.injectFault((sql) => {
      if (!gone && /^\s*update cloud_chat_messages set machine_key/.test(sql)) {
        gone = true;
        harness.exec("delete from cloud_session_copies where machine_key = 'key-new'");
      } else if (gone && waitingOnRetry == null && /^\s*insert into cloud_session_copies/.test(sql)) {
        waitingOnRetry = waitingAt();
      }
      return false;
    });
    const moved = await harness.send(OWNER, "POST", "/cloud/sessions/key-cli/cli-1/move", { toMachineKey: "key-new", instanceId: SECOND });
    harness.injectFault(null);
    expect([gone, waitingOnRetry, moved.status, await moved.json()]).toEqual([true, [{ machine_key: "key-cli" }], 200, { moved: true }]);
    expect([harness.rows("select machine_key from cloud_session_copies"), waitingAt(), await textAt("key-new")]).toEqual([[{ machine_key: "key-new" }], [{ machine_key: "key-new" }], "$ ready\n"]);

    // A newer save lands just after a move read the copy: the move takes the newer save, never the one it read first.
    expect((await save(SECOND, "key-new", "$ again\n")).status).toBe(200);
    seedComputer(harness, { instance_id: "thirdbox12", machine_key: "key-third" });
    const bucket = harness.env.CLOUD_CHATS!;
    const get = bucket.get.bind(bucket);
    let savedDuring: number | null = null;
    bucket.get = async (key) => {
      const object = await get(key);
      if (savedDuring == null && key.startsWith("sessions/")) savedDuring = (await save(SECOND, "key-new", "$ newer\n")).status;
      return object;
    };
    const movedOn = await harness.send(OWNER, "POST", "/cloud/sessions/key-new/cli-1/move", { toMachineKey: "key-third", instanceId: "thirdbox12" });
    bucket.get = get;
    expect([savedDuring, movedOn.status, await textAt("key-third"), harness.rows("select machine_key from cloud_session_copies")]).toEqual([200, 200, "$ newer\n", [{ machine_key: "key-third" }]]);
    expect(harness.rows("select r2_key from cloud_storage_sweeps")).toEqual([]);
  });

  it("a kept lane moved to the person's own machine: only that account's machine takes a deleted computer's chat onto its key, and the lane's forget keeps what moved there", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-old" });
    expect((await savePart(INSTANCE, "key-old", 1, "first\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    harness.insert("cloud_lanes_without_computer", {
      user_id: OWNER, lane_id: LANE, lane_name: "Fix the login page", project_origin: "https://github.com/acme/widgets", branch_ref: "ade/fix-login",
      reason: "idle_cleanup", type: "default", cpu: 2, memory_gb: 4, former_instance_id: INSTANCE, former_machine_key: "key-old", created_at: NOW,
    });
    harness.insert("machines", { user_id: OWNER, machine_key: "key-mac", last_seen_at: NOW });
    harness.insert("machines", { user_id: OTHER, machine_key: "key-theirs", last_seen_at: NOW });
    const move = (caller: string, from: string, toMachineKey: string) => harness.send(caller, "POST", `/cloud/chats/${from}/c1/move`, { toMachineKey });

    // Another account, to its own machine or to the owner's: no such chat or machine of theirs.
    expect([(await move(OTHER, "key-old", "key-theirs")).status, (await move(OTHER, "key-old", "key-mac")).status]).toEqual([404, 404]);
    // The owner's chat, to a key that is no machine of the owner's.
    expect((await move(OWNER, "key-old", "key-theirs")).status).toBe(404);
    // A copy whose computer still exists stays with it.
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-live" });
    expect((await savePart(SECOND, "key-live", 1, "live\n")).status).toBe(200);
    expect((await move(OWNER, "key-live", "key-mac")).status).toBe(409);

    // A message still waiting for the deleted computer: no machine of the person's drains a queue, so it fails with its text kept.
    harness.insert("cloud_chat_messages", { user_id: OWNER, machine_key: "key-old", chat_id: "c1", message_id: "m-wait", via_launch: 0, seq: 1, body_sealed: "sealed", state: "queued", created_at: NOW - 60_000, updated_at: NOW - 60_000 });
    // The key as the client spells it: stored under the machine's own spelling, which every read matches.
    const moved = await move(OWNER, "key-old", "KEY-MAC");
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ chat: expect.objectContaining({ machineKey: "key-mac", lastSeq: 1, forkedFrom: { machineKey: "key-old", chatId: "c1" } }), moved: true });
    expect(harness.rows("select machine_key from cloud_chat_copies where user_id = ?", OWNER).map((row) => row.machine_key).sort()).toEqual(["key-live", "key-mac"]);
    expect(harness.rows("select machine_key, state, error from cloud_chat_messages where message_id = 'm-wait'")).toEqual([{ machine_key: "key-mac", state: "failed", error: expect.stringContaining("Send it again") }]);
    // It lists as the machine's chat, not as a deleted computer's.
    const listed = (await (await harness.send(OWNER, "GET", "/cloud/chats")).json()) as { chats: Array<{ machineKey: string; computer?: unknown }> };
    expect(listed.chats.find((chat) => chat.machineKey === "key-mac")?.computer).toBeNull();
    // From there it is no deleted computer's copy: it doesn't move on to another machine this way.
    harness.insert("machines", { user_id: OWNER, machine_key: "key-desk", last_seen_at: NOW });
    expect((await move(OWNER, "key-mac", "key-desk")).status).toBe(404);

    // The lane is on the machine now: the record goes, the chat that moved there stays.
    // A cleanup that fails part way keeps the record, so the same forget again finishes it.
    harness.injectFault((sql) => /^\s*delete from cloud_(?!lanes_without_computer)/.test(sql));
    await expect(harness.send(OWNER, "POST", `/cloud/lanes/without-computer/${LANE}/moved`, { toMachineKey: "key-mac", keepBackups: false })).rejects.toThrow("injected");
    harness.injectFault(null);
    expect(harness.rows("select lane_id from cloud_lanes_without_computer")).toEqual([{ lane_id: LANE }]);
    const forgot = await harness.send(OWNER, "POST", `/cloud/lanes/without-computer/${LANE}/moved`, { toMachineKey: "key-mac", keepBackups: false });
    expect(await forgot.json()).toEqual({ forgotten: true });
    expect(harness.rows("select lane_id from cloud_lanes_without_computer")).toEqual([]);
    const kept = (await (await harness.send(OWNER, "GET", "/cloud/chats/key-mac/c1")).json()) as { parts: Array<{ text: string }> };
    expect(kept.parts.map((part) => part.text)).toEqual(["first\n"]);
  });

  it("a lane's forget deletes only the rows it listed: a chat that moved to the person's machine while it ran stays there", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-old" });
    const saveChat = (chatId: string, text: string) => harness.send(OWNER, "PUT", `/cloud/chats/key-old/${chatId}/parts/1`, {
      instanceId: INSTANCE, text, row: { lastSeq: 1, laneId: LANE, projectKey: "github.com/acme/widgets", provider: "claude", model: "claude-sonnet" },
    });
    expect([(await saveChat("c1", "one\n")).status, (await saveChat("c2", "two\n")).status]).toEqual([200, 200]);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    harness.insert("cloud_lanes_without_computer", {
      user_id: OWNER, lane_id: LANE, lane_name: "Fix the login page", project_origin: "https://github.com/acme/widgets", branch_ref: "ade/fix-login",
      reason: "idle_cleanup", type: "default", cpu: 2, memory_gb: 4, former_instance_id: INSTANCE, former_machine_key: "key-old", created_at: NOW,
    });
    harness.insert("machines", { user_id: OWNER, machine_key: "key-mac", last_seen_at: NOW });
    // While the forget deletes c1's parts, the person's machine takes c2.
    const bucket = harness.env.CLOUD_CHATS!;
    const deleteObjects = bucket.delete.bind(bucket);
    let movedDuring: number | null = null;
    bucket.delete = async (keys) => {
      await deleteObjects(keys);
      if (movedDuring == null) movedDuring = (await harness.send(OWNER, "POST", "/cloud/chats/key-old/c2/move", { toMachineKey: "key-mac" })).status;
    };

    const forgot = await harness.send(OWNER, "POST", `/cloud/lanes/without-computer/${LANE}/moved`, { toMachineKey: "key-mac", keepBackups: false });

    expect([forgot.status, movedDuring]).toEqual([200, 200]);
    expect(harness.rows("select machine_key, chat_id from cloud_chat_copies")).toEqual([{ machine_key: "key-mac", chat_id: "c2" }]);
    const kept = (await (await harness.send(OWNER, "GET", "/cloud/chats/key-mac/c2")).json()) as { parts: Array<{ text: string }> };
    expect(kept.parts.map((part) => part.text)).toEqual(["two\n"]);
  });

  it("a saved chat's delete sweeps only its own copy's storage, and a sweep that fails is finished by the tick", async () => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-a" });
    const read = async () => {
      const response = await harness.send(OWNER, "GET", "/cloud/chats/key-a/c1");
      return response.status === 200 ? ((await response.json()) as { parts: Array<{ text: string }> }).parts.map((part) => part.text) : response.status;
    };
    const objects = async () => (await harness.env.CLOUD_CHATS!.list({ prefix: `chats/${OWNER}/` })).objects.length;
    const bucket = harness.env.CLOUD_CHATS!;

    // The computer starts its copy over while the delete sweeps: the new copy keeps its part.
    expect((await savePart(INSTANCE, "key-a", 1, "first\n")).status).toBe(200);
    const list = bucket.list.bind(bucket);
    let savedDuring: number | null = null;
    bucket.list = async (options) => {
      if (savedDuring == null && options?.prefix?.startsWith("chats/")) savedDuring = (await savePart(INSTANCE, "key-a", 1, "again\n")).status;
      return list(options);
    };
    expect(await (await harness.send(OWNER, "DELETE", "/cloud/chats/key-a/c1")).json()).toEqual({ deleted: true });
    bucket.list = list;
    expect([savedDuring, await read(), await objects()]).toEqual([200, ["again\n"], 1]);

    // The storage fails mid-delete: the chat is gone at once, and the next tick removes what was left.
    const remove = bucket.delete.bind(bucket);
    bucket.delete = async () => { throw new Error("R2 down"); };
    await expect(harness.send(OWNER, "DELETE", "/cloud/chats/key-a/c1")).rejects.toThrow("R2 down");
    bucket.delete = remove;
    expect([await read(), await objects()]).toEqual([404, 1]);
    clock = NOW + 11 * 60_000;
    await harness.tick();
    expect([await objects(), harness.rows("select r2_key from cloud_storage_sweeps")]).toEqual([0, []]);
  });

  it.each([
    { name: "fails before its agent runs: its computer goes and the lane is kept without one", agent: false, kept: true },
    { name: "fails after its agent ran: its computer stays", agent: true, kept: false },
  ])("a continue launch that $name", async ({ agent, kept }) => {
    harness.env.CLERK_SECRET_KEY = "sk_test";
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-gone", lane_id: LANE, lane_name: "Fix the login page", lane_project_origin: "https://github.com/acme/widgets", lane_branch: "ade/fix-login" });
    expect((await savePart(INSTANCE, "key-gone", 1, "{}\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    const sent = await harness.send(OWNER, "POST", "/cloud/chats/key-gone/c1/messages", { messageId: "m1", text: "Go on." });
    const { wake } = (await sent.json()) as { wake: { launchId: string } };
    const { instance_id: instanceId } = harness.row("select instance_id from cloud_launches where launch_id = ?", wake.launchId) as { instance_id: string };
    expect(harness.row("select lane_id from cloud_computers where instance_id = ? and deleted_at is null", instanceId)).toEqual({ lane_id: LANE });

    const stages = [
      { id: "clone", status: "done", detail: null, error: null },
      { id: "checkout", status: agent ? "done" : "failed", detail: null, error: agent ? null : "Branch 'ade/fix-login' not found" },
      ...(agent ? [{ id: "agent", status: "failed", detail: null, error: "The agent stopped." }] : []),
    ];
    harness.exec("update cloud_launches set state = 'failed', error = 'It failed.', stages_json = ? where launch_id = ?", JSON.stringify(stages), wake.launchId);
    await failUnjoinedLaunches(harness.env, { provider: createCloudProvider("provider-key"), now: clock });

    const alive = harness.rows("select instance_id from cloud_computers where instance_id = ? and deleted_at is null", instanceId);
    const lanes = ((await (await harness.send(OWNER, "GET", "/cloud/lanes/without-computer")).json()) as { lanes?: Array<{ laneId: string; branchRef: string | null }> }).lanes ?? [];
    expect([alive.length, lanes.map((lane) => [lane.laneId, lane.branchRef])]).toEqual(kept ? [0, [[LANE, "ade/fix-login"]]] : [1, []]);
  });

  it("a message's file reaches the computer that runs it: read from its upload, kept as long as the message can wait, and brought to a new computer", async () => {
    harness.env.CLERK_SECRET_KEY = "sk_test";
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-gone", lane_id: LANE, lane_name: "Fix the login page", lane_project_origin: "https://github.com/acme/widgets", lane_branch: "ade/fix-login" });
    expect((await savePart(INSTANCE, "key-gone", 1, "{}\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    // The phone uploads to a draft of its own, then names that draft on the message.
    const upload = "3f6c2a1e-8b4d-4c7a-9e2f-5a1b0c9d8e7f";
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${upload}/files/photo-1`, "png", { "content-type": "image/png" })).status).toBe(201);
    const file = { launchId: upload, fileId: "photo-1", name: "photo.png", contentType: "image/png", sizeBytes: 5 };
    const sent = await harness.send(OWNER, "POST", "/cloud/chats/key-gone/c1/messages", { messageId: "m1", text: "What is this?", attachments: [file] });
    expect(sent.status).toBe(201);
    const { wake } = (await sent.json()) as { wake: { launchId: string } };
    const read = async (launchId: string) => (await harness.send(OWNER, "GET", `/cloud/launches/${launchId}/files/photo-1`)).status;
    expect([await read(wake.launchId), await read(upload)]).toEqual([200, 200]);
    expect((harness.row("select expires_at from cloud_launches where launch_id = ?", upload) as { expires_at: number }).expires_at)
      .toBeGreaterThanOrEqual(NOW + CLOUD_CHAT_MESSAGE_TTL_MS);
  });

  it("a send to a chat whose computer is gone continues it on one new computer, at the size the person picked: a second send rides the same launch", async () => {
    harness.env.CLERK_SECRET_KEY = "sk_test";
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-gone", lane_id: LANE, lane_name: "Fix the login page", lane_project_origin: "https://github.com/acme/widgets", lane_branch: "ade/fix-login" });
    expect((await savePart(INSTANCE, "key-gone", 1, "{}\n")).status).toBe(200);
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    const send = (messageId: string, extra: Record<string, unknown> = {}) =>
      harness.send(OWNER, "POST", "/cloud/chats/key-gone/c1/messages", { messageId, text: "Go on.", ...extra });

    // A size ADE Cloud doesn't offer is refused before anything is stored or started.
    expect((await send("m0", { sizeId: "huge" })).status).toBe(400);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(0);

    const first = await send("m1", { sizeId: "medium" });
    expect(first.status).toBe(201);
    const { wake } = (await first.json()) as { wake: { state: string; launchId: string } };
    expect(wake).toEqual({ state: "launching", launchId: expect.any(String) });
    const launch = harness.row("select lane_id, size_id, continue_machine_key, continue_chat_id, request_json from cloud_launches where launch_id = ?", wake.launchId);
    expect([launch.lane_id, launch.continue_machine_key, launch.continue_chat_id]).toEqual([LANE, "key-gone", "c1"]);
    expect(JSON.parse(String(launch.request_json)).lane).toEqual(expect.objectContaining({ id: LANE, existingBranch: "ade/fix-login" }));
    // The picked size, kept as picked: ADE's own sizing never changes it.
    expect([launch.size_id, JSON.parse(String(launch.request_json)).sizeChoice]).toEqual(["medium", "picked"]);

    // The second send finds the launch already continuing this chat: no second computer.
    const second = await send("m2");
    expect([second.status, ((await second.json()) as { wake: unknown }).wake]).toEqual([201, { state: "launching", launchId: wake.launchId }]);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);
    expect(harness.rows("select message_id from cloud_launch_messages where launch_id = ? order by seq", wake.launchId)).toEqual([{ message_id: "m1" }, { message_id: "m2" }]);

    // The launch fails: both messages read failed with its sentence at once, and the minute cron writes it down.
    harness.exec("update cloud_launches set state = 'failed', error = 'The clone failed.' where launch_id = ?", wake.launchId);
    const listed = async () => ((await (await harness.send(OWNER, "GET", "/cloud/chats/key-gone/c1/messages")).json()) as { messages: Array<{ messageId: string; state: string; error: string | null }> }).messages
      .map((message) => [message.messageId, message.state, message.error]);
    expect(await listed()).toEqual([["m1", "failed", "The clone failed."], ["m2", "failed", "The clone failed."]]);
    await harness.tick();
    expect(harness.rows("select message_id, state, error from cloud_chat_messages order by seq")).toEqual([
      { message_id: "m1", state: "failed", error: "The clone failed." },
      { message_id: "m2", state: "failed", error: "The clone failed." },
    ]);

    // A Retry of the failed launch sends them after all: the computer's report wins over the failed mark, and the cron keeps it.
    harness.exec("update cloud_launches set state = 'joined', error = null where launch_id = ?", wake.launchId);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${wake.launchId}/stages`, { state: "running", sessionId: "c1" })).status).toBe(200);
    expect((await harness.send(OWNER, "POST", `/cloud/launches/${wake.launchId}/messages/m2/claim`, { claimId: "claim-cccccccccccccccc" })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${wake.launchId}/messages/m2`, { claimId: "claim-cccccccccccccccc", state: "delivered" })).status).toBe(200);
    expect(harness.rows("select message_id, state, error from cloud_chat_messages where message_id in ('m1', 'm2') order by seq")).toEqual([
      { message_id: "m1", state: "delivered", error: null },
      { message_id: "m2", state: "delivered", error: null },
    ]);
    harness.exec("update cloud_launches set state = 'failed', error = 'The computer stopped.' where launch_id = ?", wake.launchId);
    clock += 25 * HOUR;
    await harness.tick();
    expect((await listed()).slice(0, 2)).toEqual([["m1", "delivered", null], ["m2", "delivered", null]]);
    // A send after it starts a new launch: the failed one no longer holds the chat.
    const third = await send("m3");
    expect([third.status, ((await third.json()) as { wake: { launchId: string } }).wake.launchId]).toEqual([201, expect.not.stringMatching(wake.launchId)]);
  });

  it("a saved CLI takes messages like a chat: its computer reads it as a CLI, a gone one continues it with no model, a shell takes none", async () => {
    harness.env.CLERK_SECRET_KEY = "sk_test";
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    seedAccount(harness, OWNER);
    seedComputer(harness, { machine_key: "key-cli", ade_features: "chat_queue", lane_id: LANE, lane_name: "Fix the login page", lane_project_origin: "https://github.com/acme/widgets", lane_branch: "ade/fix-login" });
    const saveSession = (sessionId: string, kind: "cli" | "shell", toolType: string) => harness.send(OWNER, "PUT", `/cloud/sessions/key-cli/${sessionId}`, {
      instanceId: INSTANCE, format: "text", text: "$ ready\n", row: { kind, toolType, laneId: LANE, projectKey: "github.com/acme/widgets" },
    });
    expect([(await saveSession("cli-1", "cli", "cursor-cli")).status, (await saveSession("sh-1", "shell", "shell")).status]).toEqual([200, 200]);
    const send = (sessionId: string, messageId: string) => harness.send(OWNER, "POST", `/cloud/chats/key-cli/${sessionId}/messages`, { messageId, text: "Run the tests." });

    // A live computer: the message waits for it, marked as typed input for a CLI.
    expect((await send("cli-1", "m1")).status).toBe(201);
    const listed = (await (await harness.send(OWNER, "GET", `/cloud/instances/${INSTANCE}/messages`)).json()) as { messages: Array<{ messageId: string; targetKind?: string; laneId: string | null }> };
    expect(listed.messages.map((message) => [message.messageId, message.targetKind, message.laneId])).toEqual([["m1", "cli", LANE]]);
    expect((await send("sh-1", "m2")).status).toBe(404);

    // Its computer gone: one launch continues the CLI, with its agent and no model.
    harness.exec("update cloud_computers set deleted_at = ?, status = 'deleted' where instance_id = ?", NOW, INSTANCE);
    const gone = await send("cli-1", "m3");
    expect(gone.status).toBe(201);
    const { wake } = (await gone.json()) as { wake: { launchId: string } };
    const request = JSON.parse(String(harness.row("select request_json from cloud_launches where launch_id = ?", wake.launchId).request_json)) as Record<string, Record<string, unknown>>;
    expect([request.continueChat, request.chat!.provider, request.chat!.modelId]).toEqual([{ machineKey: "key-cli", chatId: "cli-1", kind: "cli" }, "cursor", ""]);

    // The new computer continued it: the copy and its waiting message move to its key once,
    // and a later send to the old address reaches it instead of starting another computer.
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-new", ade_features: "chat_queue" });
    const moveCli = async (toMachineKey = "key-new") => harness.send(OWNER, "POST", "/cloud/sessions/key-cli/cli-1/move", { toMachineKey, instanceId: SECOND });
    expect((await moveCli("key-else")).status).toBe(409);
    expect([await (await moveCli()).json(), await (await moveCli()).json()]).toEqual([{ moved: true }, { moved: false }]);
    const copyAt = async (machineKey: string) => {
      const response = await harness.send(OWNER, "GET", `/cloud/sessions/${machineKey}/cli-1`);
      if (response.status !== 200) return [response.status];
      const copy = (await response.json()) as { text: string; session: { machineKey: string; toolType: string | null } };
      return [200, copy.text, copy.session.machineKey, copy.session.toolType];
    };
    // Sealed again under the new key: it opens there, with its summary, and is gone from the old one.
    expect([await copyAt("key-new"), await copyAt("key-cli")]).toEqual([[200, "$ ready\n", "key-new", "cursor-cli"], [404]]);
    expect((await send("cli-1", "m4")).status).toBe(201);
    const onNew = (await (await harness.send(OWNER, "GET", `/cloud/instances/${SECOND}/messages`)).json()) as { messages: Array<{ messageId: string; targetKind?: string }> };
    expect(onNew.messages.map((message) => [message.messageId, message.targetKind])).toEqual([["m1", "cli"], ["m4", "cli"]]);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);

    // Another computer's move takes the copy after a send read it at key-new: nothing is queued where no copy is.
    let moved = false;
    harness.injectFault((sql) => {
      if (!moved && /update cloud_computers set last_awake_at/.test(sql)) {
        moved = true;
        harness.exec("update cloud_session_copies set machine_key = 'key-third' where session_id = 'cli-1'");
        harness.exec("update cloud_chat_messages set machine_key = 'key-third' where chat_id = 'cli-1'");
      }
      return false;
    });
    const late = await harness.send(OWNER, "POST", "/cloud/chats/key-new/cli-1/messages", { messageId: "m5", text: "Run the tests." });
    harness.injectFault(null);
    expect([moved, late.status, ((await late.json()) as { error?: { code?: string } }).error?.code]).toEqual([true, 409, "chat_moved"]);
    expect(harness.rows("select machine_key from cloud_chat_messages where message_id = 'm5'")).toEqual([]);

    // The same message again, which a move took to the copy's new key with the copy: it was sent, once.
    harness.exec("update cloud_chat_messages set machine_key = 'key-fourth' where message_id = 'm4'");
    let movedAgain = false;
    harness.injectFault((sql) => {
      if (!movedAgain && /update cloud_computers set last_awake_at/.test(sql)) {
        movedAgain = true;
        harness.exec("update cloud_session_copies set machine_key = 'key-fourth' where session_id = 'cli-1'");
      }
      return false;
    });
    const again = await harness.send(OWNER, "POST", "/cloud/chats/key-third/cli-1/messages", { messageId: "m4", text: "Run the tests." });
    harness.injectFault(null);
    expect([movedAgain, again.status, ((await again.json()) as { message?: { messageId?: string } }).message?.messageId]).toEqual([true, 200, "m4"]);
    expect(harness.rows("select machine_key from cloud_chat_messages where message_id = 'm4'")).toEqual([{ machine_key: "key-fourth" }]);
  });
});

/**
 * Lane backups at rest (`laneBackups.ts`): a person's work that isn't on
 * GitHub lives only here once its computer is gone, so a test is the one way
 * to prove who can read and write it, that a new backup never loses the old
 * one before it is whole, that the caps refuse, that a computer rests with
 * its backups only through its own sleep or the 0-hours stop and a wake
 * clears that, and that the lane's and the account's deletes remove it.
 */
describe("ADE Cloud lane backups", () => {
  const LANE = "lane_pricing";
  const REPORT = "c".repeat(32);
  const FINGERPRINT = "f".repeat(64);
  const facts = { branchRef: "ade/pricing", laneName: "pricing", projectKey: "github.com/acme/web", headSha: "1".repeat(40), snapshotSha: "2".repeat(40), baseSha: "3".repeat(40), commits: 2, files: 3 };
  const base = `/cloud/backups/key-a/${LANE}`;

  beforeEach(() => {
    harness.env.CLOUD_CHAT_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
    harness.env.CLOUD_CHATS = memoryBucket();
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    seedComputer(harness, { machine_key: "key-a" });
    provide(harness);
  });

  /** A raw part, as a computer sends it: no Origin, its instance header. */
  const putPart = (caller: string, path: string, bytes: Uint8Array, headers: Record<string, string> = { "x-ade-instance": INSTANCE }) =>
    handleCloudRequest(new Request(`https://directory.test${path}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${tokens[caller]}`, "content-type": "application/octet-stream", ...headers },
      body: bytes as Uint8Array<ArrayBuffer>,
    }), harness.env);
  const start = (caller = OWNER, bundleBytes = 5, patchBytes = 4, path = base) =>
    harness.send(caller, "POST", `${path}/uploads`, { instanceId: INSTANCE, fingerprint: FINGERPRINT, bundleBytes, patchBytes, facts });
  /** One whole backup: start, a bundle part and a patch part, commit. */
  async function saveBackup(bundle = "BNDL1", patch = "PTCH"): Promise<string> {
    const started = await start(OWNER, bundle.length, patch.length);
    expect(started.status).toBe(200);
    const { uploadId } = (await started.json()) as { uploadId: string };
    expect((await putPart(OWNER, `${base}/uploads/${uploadId}/bundle/1`, new TextEncoder().encode(bundle))).status).toBe(200);
    expect((await putPart(OWNER, `${base}/uploads/${uploadId}/patch/1`, new TextEncoder().encode(patch))).status).toBe(200);
    const committed = await harness.send(OWNER, "POST", `${base}/uploads/${uploadId}/commit`, { instanceId: INSTANCE, bundleParts: 1, patchParts: 1 });
    expect(committed.status).toBe(200);
    return uploadId;
  }
  const readPart = async (caller: string, kind: string, headers: Record<string, string> = {}) => {
    const response = await harness.send(caller, "GET", `${base}/${kind}/1`, undefined, headers);
    return response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : response.status;
  };
  const objects = async () => (await harness.env.CLOUD_CHATS!.list({ prefix: "backups/" })).objects.map((object) => object.key);

  it("only the account reads it, only its own computer writes it, and it is sealed; a new backup replaces the old only when whole", async () => {
    const first = await saveBackup("BNDL1", "PTCH");
    expect([await readPart(OWNER, "bundle"), await readPart(OWNER, "patch")]).toEqual(["BNDL1", "PTCH"]);
    // Sealed at rest: neither the bytes nor the branch name are in R2 or D1 in the clear.
    const stored = await Promise.all((await objects()).map(async (key) => Buffer.from(await (await harness.env.CLOUD_CHATS!.get(key))!.arrayBuffer()).toString("latin1")));
    expect(stored.join("")).not.toContain("BNDL1");
    expect(JSON.stringify(harness.rows("select * from cloud_lane_backups"))).not.toContain("ade/pricing");
    // A part moved under another lane does not open: the additional data names its place.
    const key = (await objects()).find((entry) => entry.endsWith("bundle/00001"))!;
    const moved = key.replace(`/${LANE}/`, "/lane_other/");
    await harness.env.CLOUD_CHATS!.put(moved, await (await harness.env.CLOUD_CHATS!.get(key))!.arrayBuffer());
    harness.exec("insert into cloud_lane_backups (user_id, machine_key, lane_id, upload_id, r2_prefix, fingerprint, facts_sealed, bundle_bytes, bundle_parts, saved_at, updated_at) select user_id, machine_key, 'lane_other', upload_id, replace(r2_prefix, ?, 'lane_other'), fingerprint, facts_sealed, bundle_bytes, bundle_parts, saved_at, updated_at from cloud_lane_backups", LANE);
    expect((await harness.send(OWNER, "GET", "/cloud/backups/key-a/lane_other/bundle/1")).status).toBe(503);

    // Another account: nothing is there, to read or to write.
    expect(((await (await harness.send(OTHER, "GET", "/cloud/backups")).json()) as { backups: unknown[] }).backups).toEqual([]);
    expect([await readPart(OTHER, "bundle"), await readPart(OTHER, "patch"), (await harness.send(OTHER, "GET", base)).status]).toEqual([404, 404, 404]);
    expect((await start(OTHER)).status).toBe(404);
    expect((await harness.send(OTHER, "DELETE", base, { instanceId: INSTANCE })).status).toBe(404);
    // The account's own computer may not write under another machine key.
    expect((await start(OWNER, 5, 4, `/cloud/backups/key-b/${LANE}`)).status).toBe(404);
    // A browser page reads the manifest and the patch, never the bundle, and writes nothing.
    const web = { origin: "https://app.ade.test" };
    harness.env.WEB_CLIENT_ORIGIN = web.origin;
    expect([await readPart(OWNER, "patch", web), await readPart(OWNER, "bundle", web)]).toEqual(["PTCH", 404]);
    expect((await harness.send(OWNER, "POST", `${base}/uploads`, { instanceId: INSTANCE, fingerprint: FINGERPRINT, bundleBytes: 5, patchBytes: 4, facts }, web)).status).toBe(404);
    delete harness.env.WEB_CLIENT_ORIGIN;

    // A commit of less than its upload declared (the patch never sent) is no backup: the old one stays.
    const { uploadId: short } = (await (await start(OWNER, 5, 4)).json()) as { uploadId: string };
    expect((await putPart(OWNER, `${base}/uploads/${short}/bundle/1`, new TextEncoder().encode("BNDLX"))).status).toBe(200);
    expect((await harness.send(OWNER, "POST", `${base}/uploads/${short}/commit`, { instanceId: INSTANCE, bundleParts: 1, patchParts: 0 })).status).toBe(409);
    expect(await readPart(OWNER, "bundle")).toBe("BNDL1");

    // A second upload that never commits leaves the first one whole and readable.
    const started = await start(OWNER, 5, 0);
    const { uploadId } = (await started.json()) as { uploadId: string };
    expect((await putPart(OWNER, `${base}/uploads/${uploadId}/bundle/1`, new TextEncoder().encode("BNDL2"))).status).toBe(200);
    expect(await readPart(OWNER, "bundle")).toBe("BNDL1");
    // Its commit swaps it in, and only then the old one's objects go.
    expect((await harness.send(OWNER, "POST", `${base}/uploads/${uploadId}/commit`, { instanceId: INSTANCE, bundleParts: 1, patchParts: 0 })).status).toBe(200);
    expect(await readPart(OWNER, "bundle")).toBe("BNDL2");
    expect((await objects()).filter((entry) => entry.includes(`/${LANE}/`)).every((entry) => entry.includes(uploadId) && !entry.includes(first))).toBe(true);

    // An upload nobody commits: the minute sweep drops its parts after half an hour; the committed backup stays.
    const { uploadId: stale } = (await (await start(OWNER, 5, 0)).json()) as { uploadId: string };
    expect((await putPart(OWNER, `${base}/uploads/${stale}/bundle/1`, new TextEncoder().encode("BNDL3"))).status).toBe(200);
    expect(await sweepStaleBackupUploads(harness.env, clock + 29 * 60_000)).toBe(0);
    expect(await sweepStaleBackupUploads(harness.env, clock + 31 * 60_000)).toBe(1);
    expect([(await objects()).some((entry) => entry.includes(stale)), await readPart(OWNER, "bundle")]).toEqual([false, "BNDL2"]);
  });

  it.each<[string, () => Promise<Response>, string]>([
    ["one lane over its cap", () => start(OWNER, CLOUD_BACKUP_MAX_BYTES, 1), "backup_too_large"],
    ["the account over its cap", async () => {
      harness.exec("insert into cloud_lane_backups (user_id, machine_key, lane_id, upload_id, bundle_bytes, saved_at, updated_at) values (?, 'key-a', 'lane_full', 'x', ?, ?, ?)", OWNER, CLOUD_BACKUP_MAX_ACCOUNT_BYTES, NOW, NOW);
      return start(OWNER, 10, 0);
    }, "backup_account_full"],
    ["a part past the size the upload said", async () => {
      const { uploadId } = (await (await start(OWNER, 5, 0)).json()) as { uploadId: string };
      return putPart(OWNER, `${base}/uploads/${uploadId}/bundle/9`, new TextEncoder().encode("extra"));
    }, "backup_too_large"],
    ["a part bigger than its kind's declared size", async () => {
      const { uploadId } = (await (await start(OWNER, 5, 0)).json()) as { uploadId: string };
      return putPart(OWNER, `${base}/uploads/${uploadId}/bundle/1`, new TextEncoder().encode("toolong"));
    }, "backup_too_large"],
    ["a patch part when the upload declared no patch", async () => {
      const { uploadId } = (await (await start(OWNER, 5, 0)).json()) as { uploadId: string };
      return putPart(OWNER, `${base}/uploads/${uploadId}/patch/1`, new TextEncoder().encode("x"));
    }, "backup_too_large"],
  ])("refused with a sentence: %s", async (_label, run, code) => {
    const response = await run();
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect([response.status, body.error.code]).toEqual([413, code]);
    expect(body.error.message).toMatch(/The computer is kept until then\.$|^This lane's work/);
    expect(harness.rows("select lane_id from cloud_lane_backups where upload_id is not null and lane_id = ?", LANE)).toEqual([]);
  });

  it("a computer rests with its backups only through its own sleep or the 0-hours stop, naming a current report; a wake clears it", async () => {
    await saveBackup();
    const report = (lanes: Row[], reportId = REPORT) => harness.send(OWNER, "POST", "/cloud/backups/report", { instanceId: INSTANCE, reportId, complete: true, lanes });
    const restAt = () => computer(harness).backup_rest_at;
    // A fingerprint the server doesn't hold is not saved, whatever the computer says.
    expect(await (await report([{ laneId: LANE, state: "saved", fingerprint: "e".repeat(64) }])).json()).toEqual({ state: "failed" });
    expect(await (await report([{ laneId: LANE, state: "unchanged", fingerprint: FINGERPRINT }, { laneId: "lane_clean", state: "clean" }])).json()).toEqual({ state: "current" });
    // A sleep that names another report, or none, does not rest with it.
    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/idle`, { backupReportId: "d".repeat(32) })).status).toBe(200);
    expect(restAt()).toBeNull();
    harness.net.instances.get(INSTANCE)!.status = "running";
    harness.exec("update cloud_computers set status = 'running', awake_since = ? where instance_id = ?", NOW, INSTANCE);
    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/idle`, { backupReportId: REPORT })).status).toBe(200);
    expect(restAt()).toBe(NOW);
    // A later report means the computer is awake again: the rest ends, whatever the report says.
    expect(await (await report([{ laneId: LANE, state: "failed" }], "e".repeat(32))).json()).toEqual({ state: "failed" });
    expect(restAt()).toBeNull();
    // Any wake: its lanes can change, so the report and the rest go.
    expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, {})).status).toBe(200);
    expect([restAt(), computer(harness).backup_report_state]).toEqual([null, null]);

    // 0 hours: prepare-stop's save reports, the stop rests the computer with it, and nothing wakes it again.
    expect(await (await report([{ laneId: LANE, state: "unchanged", fingerprint: FINGERPRINT }])).json()).toEqual({ state: "current" });
    harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER);
    harness.net.once.push({
      match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`),
      reply: harness.net.reply({ exit_code: 0, stdout: JSON.stringify({ result: { stillRunning: 0, chatsNotUploaded: 0, timedOut: false, backups: { reportId: REPORT, state: "current" } } }), stderr: "" }),
    });
    await harness.tick();
    expect(providerCalls(harness, /POST .*\/exec$/).map((call) => String(call.body?.command))).toEqual([expect.stringContaining("ade cloud prepare-stop --timeout 40 --json")]);
    expect([computer(harness).status, restAt()]).toEqual(["stopped", clock]);
    const starts = providerCalls(harness, /POST .*\/start$/).length;
    clock = NOW + DAY;
    await harness.tick();
    expect(providerCalls(harness, /POST .*\/start$/)).toHaveLength(starts);
  });

  // A stop that wasn't fully prepared (a turn still running, a chat not saved, out of time) can be written to after its save.
  it.each<[string, Record<string, unknown>, string | null]>([
    ["prepared", { stillRunning: 0, chatsNotUploaded: 0, timedOut: false }, REPORT],
    ["a turn still running", { stillRunning: 1, chatsNotUploaded: 0, timedOut: true }, null],
    ["a chat not saved", { stillRunning: 0, chatsNotUploaded: 2, timedOut: false }, null],
    ["out of time", { stillRunning: 0, chatsNotUploaded: 0, timedOut: true }, null],
    ["an older ADE that sends no counts", {}, null],
  ])("the 0-hours stop rests with its save only when the stop was prepared: %s", (_label, stop, expected) => {
    const stdout = JSON.stringify({ result: { ...stop, backups: { reportId: REPORT, state: "current" } } });
    expect([prepareStopBackupReportId(stdout), prepareStopBackupReportId(stdout.replace('"current"', '"failed"'))]).toEqual([expected, null]);
  });

  it("the lane's delete and the account's delete remove its backups; a delete that keeps the lane keeps them", async () => {
    harness.exec("update cloud_computers set lane_id = ? where instance_id = ?", LANE, INSTANCE);
    await saveBackup();
    seedComputer(harness, { instance_id: SECOND, machine_key: "key-b", lane_id: LANE, lane_name: "pricing" });
    provide(harness, SECOND);
    // The lane's other computer marks the backup it applied by fingerprint: a backup it didn't apply is not marked.
    const restored = (fingerprint: string) => harness.send(OWNER, "POST", `${base}/restored`, { instanceId: SECOND, fingerprint });
    expect([(await restored("e".repeat(64))).status, (await restored(FINGERPRINT)).status]).toEqual([404, 200]);
    // A computer's own round lists the backups it made and the ones it restored, and no other.
    const listedFor = async (machineKey: string) => ((await (await harness.send(OWNER, "GET", `/cloud/backups?machineKey=${machineKey}`)).json()) as { backups: Array<{ laneId: string }> }).backups.map((entry) => entry.laneId);
    expect([await listedFor("key-a"), await listedFor("key-b"), await listedFor("key-z")]).toEqual([[LANE], [LANE], []]);
    // Freeing the other computer and keeping the lane: the backup stays for the lane's next computer.
    expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${SECOND}`, { keepLane: { branchRef: "ade/pricing" } })).status).toBe(200);
    expect(harness.rows("select lane_id from cloud_lane_backups")).toEqual([{ lane_id: LANE }]);
    // A failed move's target is a fork with the computer's machine key: its delete keeps the source's backup.
    const FORK = "klmno24680";
    seedComputer(harness, { instance_id: FORK, machine_key: "key-a", lane_id: LANE, lane_name: "pricing" });
    provide(harness, FORK);
    expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${FORK}`, { reason: "cleanup" })).status).toBe(200);
    expect(harness.rows("select lane_id from cloud_lane_backups")).toEqual([{ lane_id: LANE }]);
    // The idle cleanup deleted the lane's computer and kept the lane; its next computer fails to start.
    // That delete keeps the backup: it is the only copy of the lane's work.
    harness.exec("update cloud_computers set deleted_at = ? where instance_id = ?", NOW, INSTANCE);
    const NEXT = "pqrst13579";
    seedComputer(harness, { instance_id: NEXT, machine_key: "key-c", lane_id: LANE, lane_name: "pricing" });
    provide(harness, NEXT);
    expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${NEXT}`, { reason: "create_failed" })).status).toBe(200);
    expect(harness.rows("select lane_id from cloud_lane_backups")).toEqual([{ lane_id: LANE }]);
    harness.exec("update cloud_computers set deleted_at = null where instance_id = ?", INSTANCE);
    // The lane also has a backup from its earlier computer (another machine key).
    harness.exec("create temp table earlier as select * from cloud_lane_backups");
    harness.exec("update earlier set machine_key = 'key-b'");
    harness.exec("insert into cloud_lane_backups select * from earlier");
    harness.exec("drop table earlier");
    // The person deletes the lane (its computer, no lane kept): every backup of it goes.
    expect((await harness.send(OWNER, "DELETE", `/cloud/instances/${INSTANCE}`, {})).status).toBe(200);
    expect([harness.rows("select lane_id from cloud_lane_backups"), await objects()]).toEqual([[], []]);

    // The account's delete: every object under backups/<user>/ and every row.
    // A computer of the account saves again, then the account goes.
    harness.exec("update cloud_computers set deleted_at = null where instance_id = ?", INSTANCE);
    await saveBackup();
    // The person's own delete: refused while a computer holds that work, then from any app (the web too) once it is gone.
    const forget = (headers: Record<string, string> = {}) => harness.send(OWNER, "POST", `${base}/forget`, {}, headers);
    expect((await forget()).status).toBe(409);
    harness.exec("update cloud_computers set deleted_at = ? where instance_id = ?", NOW, INSTANCE);
    harness.env.WEB_CLIENT_ORIGIN = "https://app.ade.test";
    expect((await forget({ origin: "https://app.ade.test" })).status).toBe(200);
    delete harness.env.WEB_CLIENT_ORIGIN;
    expect([harness.rows("select lane_id from cloud_lane_backups"), await objects()]).toEqual([[], []]);
    harness.exec("update cloud_computers set deleted_at = null where instance_id = ?", INSTANCE);
    await saveBackup();
    expect((await objects()).length).toBeGreaterThan(0);
    await deleteAllAccountChats(harness.env, OWNER);
    expect([harness.rows("select lane_id from cloud_lane_backups where user_id = ?", OWNER), await objects()]).toEqual([[], []]);
  });
});

describe("ADE Cloud iPhone", () => {
  const PERIOD = NOW - 8 * DAY;

  /** A paid Pro account on sub_1 with the ADE Cloud iPhone on. */
  function seedPhoneAccount(overrides: Row = {}): void {
    harness.env.NOMAC_API_KEY = "nmk_test";
    harness.env.CLOUD_PHONE_ACCESS = "all";
    seedAccount(harness, OWNER, {
      plan: "paid",
      paid_plan: "pro",
      stripe_status: "active",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      period_start: PERIOD,
      ...overrides,
    });
  }

  /**
   * A phone NoMac settled: `minutes` billed, started at `startedAt`. `credits`: it counts in credits, its
   * minutes already in the account's balance; false is a row from before credits (history only).
   */
  function seedPhone(id: string, minutes: number, startedAt = PERIOD + HOUR, state = "ended", credits = true): void {
    harness.insert("cloud_phones", {
      phone_id: id,
      user_id: OWNER,
      device: "iphone",
      state,
      created_at: startedAt,
      ready_at: startedAt,
      ended_at: state === "ended" ? startedAt + minutes * 60_000 : null,
      billed_seconds: minutes * 60,
      cost_micros: minutes * 15_000,
      free: 0,
      updated_at: startedAt,
      credits: credits ? 1 : 0,
      credited_milli: credits ? minutes * 1000 : 0,
    });
  }

  it("a credits phone's billed minutes land in the account's balance once, a phone from before credits never, and the account says credits", async () => {
    seedPhoneAccount();
    seedPhone("ses_c", 0, clock - 10 * 60_000, "live");
    // A phone from before credits, this period: history only, whatever NoMac says of it later.
    seedPhone("ses_old", 0, PERIOD + HOUR, "ended", false);
    const usedBefore = Number(harness.row("select used_milli from cloud_accounts where user_id = ?", OWNER).used_milli);
    const at = (ms: number) => new Date(ms).toISOString();
    // NoMac has billed 2 minutes 5 seconds so far: 3 whole minutes, 3 credits.
    const session = { id: "ses_c", state: "ready", label: `ade:${OWNER}`, device: "iphone", created_at: at(clock - 10 * 60_000), ready_at: at(clock - 10 * 60_000), cost: { billed_seconds: 125, accrued_microunits: "2000" } };
    const inner = harness.net.fetchStub;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/simulator/sessions/ses_c")) return new Response(JSON.stringify({ session }), { status: 200, headers: { "content-type": "application/json" } });
      return inner(input, init);
    });
    // Read twice: the second answer is the same, and adds nothing.
    expect((await harness.send(OWNER, "GET", "/cloud/phone")).status).toBe(200);
    expect((await harness.send(OWNER, "GET", "/cloud/phone")).status).toBe(200);
    expect(Number(harness.row("select used_milli from cloud_accounts where user_id = ?", OWNER).used_milli)).toBe(usedBefore + 3000);
    expect(harness.row("select credited_milli from cloud_phones where phone_id = 'ses_c'").credited_milli).toBe(3000);
    // Its end with 50 billed minutes charges nothing.
    expect((await nomacDelivery("ses_old", PERIOD + HOUR, "phone.ended", { state: "ended", ended_at: new Date(PERIOD + 2 * HOUR).toISOString(), cost: { billed_seconds: 3000, accrued_microunits: "0" } })).status).toBe(200);
    expect(harness.row("select state, credits, credited_milli from cloud_phones where phone_id = 'ses_old'")).toEqual({ state: "ended", credits: 0, credited_milli: 0 });
    expect(Number(harness.row("select used_milli from cloud_accounts where user_id = ?", OWNER).used_milli)).toBe(usedBefore + 3000);
    const state = await (await harness.send(OWNER, "GET", "/cloud/account")).json() as CloudAccountState;
    expect(state.credits).toEqual({ phoneMilliPerMinute: 1000 });
    // Its time so far counts (10 minutes running), past what NoMac has billed; the old phone's 50 minutes never.
    expect(state.phone?.creditsUsedMilli).toBe(10_000);
    // The balance counts the 7 minutes NoMac hasn't billed yet too, so a computer can't spend them.
    const included = Number(harness.row("select included_milli from cloud_accounts where user_id = ?", OWNER).included_milli);
    expect(state.hours.leftMilli).toBe(Math.max(0, included - usedBefore - 10_000));
  });

  /** NoMac answers the live phone `id` as running, ready at `readyAt`, with `billedSeconds` billed. */
  function liveNomacPhone(id: string, readyAt: number, billedSeconds: number): void {
    const at = (ms: number) => new Date(ms).toISOString();
    const session = { id, state: "ready", label: `ade:${OWNER}`, device: "iphone", created_at: at(readyAt), ready_at: at(readyAt), cost: { billed_seconds: billedSeconds, accrued_microunits: "0" } };
    const inner = harness.net.fetchStub;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith(`/simulator/sessions/${id}`)) {
        const ended = init?.method === "DELETE" ? { ...session, state: "ended", ended_at: at(clock) } : session;
        return new Response(JSON.stringify({ session: ended }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    });
  }

  /** A signed NoMac delivery about phone `id` (labelled for OWNER), started at `startedAt`: ready, unless `type` and `session` say more. */
  async function nomacDelivery(id: string, startedAt: number, type = "phone.ready", session: Row = {}): Promise<Response> {
    harness.env.NOMAC_WEBHOOK_SECRET = "whsec_test";
    const at = (ms: number) => new Date(ms).toISOString();
    const raw = JSON.stringify({ id: `evt_${id}_${type}`, type, data: { session: { id, state: "ready", label: `ade:${OWNER}`, device: "iphone", created_at: at(startedAt), ready_at: at(startedAt), ...session } } });
    const t = Math.floor(clock / 1000);
    const v1 = createHmac("sha256", "whsec_test").update(`${t}.${raw}`).digest("hex");
    return handleNomacWebhook(new Request("https://directory.test/cloud/nomac/webhook", { method: "POST", headers: { "nomac-signature": `t=${t},v1=${v1}` }, body: raw }), harness.env, clock);
  }

  it("a phone found with no row (its start's answer was lost) is billed in credits", async () => {
    seedPhoneAccount();
    expect((await nomacDelivery("ses_lost", clock - 9 * 60_000)).status).toBe(200);
    expect(harness.row("select credits from cloud_phones where phone_id = 'ses_lost'").credits).toBe(1);
  });

  it("a new phone after the last one ended is billed in credits", async () => {
    seedPhoneAccount();
    // A phone from before credits; NoMac now says it has ended.
    seedPhone("ses_prev", 0, clock - 30 * 60_000, "live", false);
    const at = (ms: number) => new Date(ms).toISOString();
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fresh = { id: "ses_next", state: "ready", label: `ade:${OWNER}`, device: "iphone", created_at: at(clock), ready_at: at(clock) };
    const inner = harness.net.fetchStub;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/simulator/sessions/ses_prev")) return reply(200, { session: { id: "ses_prev", state: "ended", label: `ade:${OWNER}`, device: "iphone", created_at: at(clock - 30 * 60_000), ended_at: at(clock - 60_000), end_reason: "idle" } });
      if (url === "https://nomac.app/api/v1/simulator/sessions" && init?.method === "POST") return reply(201, { session: fresh, reused: false });
      if (url.endsWith("/simulator/sessions/ses_next/token")) return reply(200, { token: "nmp_test", expires_at: at(clock + HOUR) });
      if (url.endsWith("/simulator/sessions/ses_next")) return reply(200, { session: fresh });
      return inner(input, init);
    });
    expect((await harness.send(OWNER, "POST", "/cloud/phone", { providers: ["nomac"] })).status).toBe(200);
    expect(harness.row("select credits from cloud_phones where phone_id = 'ses_next'").credits).toBe(1);
  });

  it("a period's turn charges a running credits phone's unbilled minutes to the period that ends, once", async () => {
    // Free, every plan credit used, 40 earned: the 20 minutes the phone ran draw 20 earned at the turn.
    harness.env.NOMAC_API_KEY = "nmk_test";
    harness.env.CLOUD_PHONE_ACCESS = "all";
    // Ten minutes into December: the phone started at 23:50 on November 30.
    clock = Date.UTC(2026, 11, 1, 0, 10);
    seedAccount(harness, OWNER, { plan: "free", period_start: Date.UTC(2026, 10, 1), period_end: Date.UTC(2026, 11, 1), used_milli: 50_000, earned_granted_milli: 40_000, earned_used_milli: 0 });
    harness.exec("update cloud_accounts set included_milli = 50000 where user_id = ?", OWNER);
    seedPhone("ses_t", 0, clock - 20 * 60_000, "live");
    expect((await harness.send(OWNER, "GET", "/cloud/account")).status).toBe(200);
    const after = () => harness.row("select a.earned_used_milli, a.used_milli, p.credited_milli from cloud_accounts a join cloud_phones p on p.user_id = a.user_id where a.user_id = ?", OWNER);
    expect(after()).toEqual({ earned_used_milli: 20_000, used_milli: 0, credited_milli: 20_000 });
    // NoMac's later answer for those minutes adds nothing to the new period.
    liveNomacPhone("ses_t", clock - 20 * 60_000, 21 * 60);
    expect((await harness.send(OWNER, "GET", "/cloud/phone")).status).toBe(200);
    expect(after()).toMatchObject({ earned_used_milli: 20_000, used_milli: 0 });
  });

  /**
   * The providers' networks for a start: NoMac answers as `nomac` says (and runs `during` mid-start); Revyl
   * refuses its first call (503). Answers which providers were asked to start a phone, in order.
   */
  function phoneStartNetwork(nomac: "ok" | "refused" | "down" | "timeout", during?: () => Promise<void>): string[] {
    const asked: string[] = [];
    const inner = harness.net.fetchStub;
    const at = (ms: number) => new Date(ms).toISOString();
    const session = { id: "ses_new", state: "ready", label: `ade:${OWNER}`, device: "iphone", created_at: at(clock), ready_at: at(clock) };
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.startsWith("https://backend.revyl.ai/")) {
        if (!asked.includes("revyl")) asked.push("revyl");
        return reply(503, { error: { code: "unavailable", message: "busy" } });
      }
      if (url === "https://nomac.app/api/v1/simulator/sessions" && method === "POST") {
        asked.push("nomac");
        await during?.();
        if (nomac === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
        if (nomac === "refused") return reply(401, { error: { code: "invalid_api_key", message: "API key is malformed" } });
        if (nomac === "down") return reply(500, { error: { code: "internal", message: "oops" } });
        return reply(201, { session, reused: false });
      }
      if (url.endsWith("/simulator/sessions/ses_new/token")) return reply(200, { token: "nmp_test", expires_at: at(clock + HOUR) });
      if (url.endsWith("/simulator/sessions/ses_new")) return reply(200, { session });
      return inner(input, init);
    });
    return asked;
  }

  /**
   * An account on the beta list (`pick`: the tester's own provider pick, `auto` for the fixed order;
   * `none`: not on it), paid unless `free`, both providers set up.
   */
  function seedPhoneTester(pick: "nomac" | "revyl" | "auto" | "none", revylSwitch: "on" | "off", { free = false }: { free?: boolean } = {}): void {
    seedPhoneAccount(free ? { plan: "free", stripe_status: null, stripe_subscription_id: null } : {});
    harness.env.CLOUD_PHONE_ACCESS = "beta";
    harness.env.REVYL_PARTNER_API_KEY = "rvl_test";
    harness.env.CLOUD_PHONE_REVYL = revylSwitch;
    if (pick !== "none") harness.insert("cloud_phone_beta", { user_id: OWNER, email: "tester@example.com", added_at: clock, provider: pick === "auto" ? null : pick });
  }

  const startPhone = (needs?: string[]) => harness.send(OWNER, "POST", "/cloud/phone", { providers: ["nomac", "revyl"], ...(needs ? { needs } : {}) });

  it.each([
    { name: "a paid plan starts on NoMac first", pick: "auto", free: false, revyl: "on", nomac: "ok", needs: undefined, status: 200, code: null, asked: ["nomac"], phones: 1 },
    { name: "a definite NoMac refusal hands a paid start to Revyl", pick: "auto", free: false, revyl: "on", nomac: "refused", needs: undefined, status: 503, code: "phone_unavailable", asked: ["nomac", "revyl"], phones: 0 },
    { name: "a NoMac 5xx may hide a phone it made: no second start", pick: "auto", free: false, revyl: "on", nomac: "down", needs: undefined, status: 502, code: "phone_unavailable", asked: ["nomac"], phones: 0 },
    { name: "a NoMac timeout may hide a phone it made: no second start", pick: "auto", free: false, revyl: "on", nomac: "timeout", needs: undefined, status: 502, code: "phone_unavailable", asked: ["nomac"], phones: 0 },
    { name: "a free plan's phone is NoMac's alone", pick: "auto", free: true, revyl: "on", nomac: "ok", needs: undefined, status: 200, code: null, asked: ["nomac"], phones: 1 },
    { name: "a free plan NoMac refuses is told it is busy, never sent to Revyl", pick: "auto", free: true, revyl: "on", nomac: "refused", needs: undefined, status: 503, code: "phone_busy", asked: ["nomac"], phones: 0 },
    { name: "a free plan's lost NoMac answer is not called busy", pick: "auto", free: true, revyl: "on", nomac: "down", needs: undefined, status: 502, code: "phone_unavailable", asked: ["nomac"], phones: 0 },
    { name: "a need never picks the provider: one the first can't do starts nothing", pick: "auto", free: false, revyl: "on", nomac: "ok", needs: ["perf"], status: 409, code: "phone_lacks", asked: [], phones: 0 },
    { name: "a fallback that can't do a need is left out", pick: "auto", free: false, revyl: "on", nomac: "refused", needs: ["tests"], status: 400, code: "phone_unavailable", asked: ["nomac"], phones: 0 },
    { name: "a tester's NoMac pick never falls back to Revyl", pick: "nomac", free: false, revyl: "on", nomac: "refused", needs: undefined, status: 400, code: "phone_unavailable", asked: ["nomac"], phones: 0 },
    { name: "a tester's Revyl pick goes to Revyl, on a free plan too", pick: "revyl", free: true, revyl: "on", nomac: "ok", needs: undefined, status: 503, code: "phone_unavailable", asked: ["revyl"], phones: 0 },
    { name: "a tester's Revyl pick with Revyl switched off starts nothing", pick: "revyl", free: false, revyl: "off", nomac: "ok", needs: undefined, status: 503, code: "phone_unavailable", asked: [], phones: 0 },
    { name: "an account off the beta list starts nothing", pick: "none", free: false, revyl: "on", nomac: "ok", needs: undefined, status: 403, code: "phone_not_on_account", asked: [], phones: 0 },
  ] as const)("which provider starts the phone: $name", async ({ pick, free, revyl, nomac, needs, status, code, asked, phones }) => {
    seedPhoneTester(pick, revyl, { free });
    const calls = phoneStartNetwork(nomac);
    const response = await startPhone(needs ? [...needs] : undefined);
    expect(response.status).toBe(status);
    if (code) expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
    expect(calls).toEqual(asked);
    expect(harness.rows("select phone_id from cloud_phones where user_id = ?", OWNER)).toHaveLength(phones);
  });

  it("a second start while one runs for the account is told to try again, and then gets the same phone", async () => {
    seedPhoneTester("auto", "on");
    let during: Response | null = null;
    const calls = phoneStartNetwork("ok", async () => {
      during ??= await startPhone();
    });
    expect((await startPhone()).status).toBe(200);
    expect(during!.status).toBe(409);
    expect((await during!.json() as { error: { code: string } }).error.code).toBe("phone_starting");
    const again = await startPhone();
    expect(again.status).toBe(200);
    expect((await again.json() as { phone: { id: string } }).phone.id).toBe("ses_new");
    expect(calls).toEqual(["nomac"]);
    expect(harness.rows("select phone_id from cloud_phones where user_id = ?", OWNER)).toHaveLength(1);
  });

  it("a start whose answer was lost keeps the next starts on that provider until one finds its phone", async () => {
    seedPhoneTester("auto", "on");
    const calls = phoneStartNetwork("timeout");
    expect((await startPhone()).status).toBe(502);
    expect(calls).toEqual(["nomac"]);
    // NoMac may be bringing a phone up: the next start goes there alone, even past a refusal (never on to Revyl).
    const held = phoneStartNetwork("refused");
    expect((await startPhone()).status).toBe(400);
    expect(held).toEqual(["nomac"]);
    // A plain start goes back to NoMac alone; once it answers, the route is free again.
    calls.length = 0;
    phoneStartNetwork("ok");
    expect((await startPhone()).status).toBe(200);
    expect(harness.rows("select phone_start_unsure from cloud_accounts where user_id = ?", OWNER)).toEqual([{ phone_start_unsure: null }]);
  });

  it("a live phone its provider can't answer for blocks a new start, even one that would go elsewhere", async () => {
    seedPhoneTester("auto", "on");
    seedPhone("ses_live", 0, clock - 60_000, "live");
    const calls = phoneStartNetwork("ok");
    const answering = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).endsWith("/simulator/sessions/ses_live")
        ? new Response(JSON.stringify({ error: { code: "internal", message: "oops" } }), { status: 500 })
        : answering(input, init));
    const response = await startPhone(["perf"]);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("phone_unavailable");
    expect(calls).toEqual([]);
    expect(harness.rows("select phone_id from cloud_phones where user_id = ? and state = 'live'", OWNER)).toEqual([{ phone_id: "ses_live" }]);
  });

  it("holds a running phone to what the account may still use, and the minute tick stops it then", async () => {
    // Extra credits off, and credits left for 5 more minutes past the 5 the running phone has used.
    seedPhoneAccount({ extra_enabled: 0 });
    harness.exec("update cloud_accounts set used_milli = included_milli - 5000 where user_id = ?", OWNER);
    seedPhone("ses_live", 5, clock - 5 * 60_000, "live");
    const nomacCalls: string[] = [];
    let state = "ready";
    const network = harness.net.fetchStub;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://nomac.app/api/v1/simulator/sessions/ses_live")) return network(input, init);
      const method = init?.method ?? "GET";
      nomacCalls.push(method);
      if (method === "DELETE") state = "stopped";
      return new Response(JSON.stringify({
        session: { id: "ses_live", state, label: `ade:${OWNER}`, device: "iphone", created_at: new Date(clock - 5 * 60_000).toISOString(), ready_at: new Date(clock - 5 * 60_000).toISOString(), cost: { billed_seconds: 300, accrued_microunits: "75000" } },
      }), { status: 200 });
    });

    expect(await enforcePhoneAllowance(harness.env, OWNER, clock)).toBe("running");
    const stopAt = Number(harness.row("select stop_at from cloud_phones where phone_id = 'ses_live'").stop_at);
    expect(nomacCalls).not.toContain("DELETE");
    expect(stopAt).toBe(clock + 5 * 60_000);

    // Before its time the tick leaves it running; past it, the tick stops it at NoMac.
    clock += 4 * 60_000;
    await harness.tick();
    expect(nomacCalls).not.toContain("DELETE");
    clock += 2 * 60_000;
    await harness.tick();
    expect(nomacCalls).toContain("DELETE");
    expect(harness.row("select state from cloud_phones where phone_id = 'ses_live'").state).toBe("ended");
  });
});

describe("ADE Cloud server moves", () => {
  const MOVE = "6f0e1d2c-3b4a-4c5d-8e7f-9a0b1c2d3e4f";
  const OTHER_MOVE = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const TARGET = "madenew12345";
  const ROOT = "/home/node/widgets";
  const SETTING = MACHINE_LAUNCH_MIN_VERSION_SETTING;
  /** What the computers' shells print for the move's commands. */
  let shell: { copy: string; serve: string; receive: string };
  let ran: Array<{ id: string; command: string }>;

  beforeEach(() => {
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    seedAccount(harness, OWNER);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    harness.insert("cloud_settings", { key: SETTING, value: "1.2.131", updated_at: NOW });
    seedComputer(harness, { name: "Widgets", machine_key: "mk_source", lane_id: "lane-1", lane_name: "Fix login" });
    provide(harness, INSTANCE, "running", { ade_machine_key: "mk_source", ade_lane_id: "lane-1", ade_lane_name: "Fix login", ade_former_machine_keys: "mk_older" });
    harness.insert("machines", { user_id: OWNER, machine_key: "mk_source", name: "Widgets", created_at: NOW });
    shell = { copy: "", serve: "started", receive: "started" };
    ran = [];
    harness.net.hooks.exec = (id, command) => {
      ran.push({ id, command });
      if (command.includes("not_started")) return { exit_code: 0, stdout: shell.copy };
      if (command.includes('touch "$ADE_HOME/brain.paused"')) return { exit_code: 0, stdout: shell.serve };
      if (command.includes("/tmp/ade-move.started")) return { exit_code: 0, stdout: shell.receive };
      if (command.includes("ade projects list")) return { exit_code: 0, stdout: JSON.stringify({ projects: [{ rootPath: ROOT }, { rootPath: "/tmp/elsewhere" }] }) };
      if (command.includes("tail -n 3 /tmp/ade-move.log")) return { exit_code: 0, stdout: "curl: (22) The requested URL returned error: 502" };
      return null;
    };
  });

  const run = () => runCloudMoves(harness.env, {
    provider: createCloudProvider("provider-key"),
    createComputer: (userId, provider, extras) => createComputer(harness.env, userId, provider, extras, { now: clock, waitUntil: undefined }),
  });
  const job = () => harness.row("select * from cloud_jobs where job_id = ?", MOVE);
  /** The minute cron, tick after tick, until the move reaches `step`. */
  const drive = async (step: string) => {
    for (let tick = 0; tick < 200 && job().step !== step; tick += 1) {
      clock += 16_000;
      await run();
    }
    expect(job().step).toBe(step);
  };
  const start = (body: Row = {}) => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/move`, { moveId: MOVE, to: "full", ...body });
  const record = async (moveId = MOVE) => await (await harness.send(OWNER, "GET", `/cloud/moves/${moveId}`)).json() as CloudMoveRecord;
  /** The new computer signs in as its brain does: it registers, names its machine, then reports its launch done. */
  const signIn = async () => {
    harness.insert("machines", { user_id: OWNER, machine_key: "mk_target", name: "ade-box", created_at: clock });
    expect((await harness.send(OWNER, "PUT", `/cloud/instances/${TARGET}/metadata`, { metadata: { ade_machine_key: "mk_target" } })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${job().target_launch_id as string}/stages`, { state: "done" })).status).toBe(200);
  };
  const onComputer = (id: string, text: string) => ran.filter((entry) => entry.id === id && entry.command.includes(text));
  const unpaused = () => onComputer(INSTANCE, 'rm -f "$ADE_HOME/brain.paused"').length > 0;
  const sourceDeletes = () => providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`));

  it("moves a computer to the other kind: one new computer, its files copied, the old one gone, the new one named for it", async () => {
    const started = await start();
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual(expect.objectContaining({ moveId: MOVE, sourceInstanceId: INSTANCE, sourceName: "Widgets", to: "full", state: "making", sourceDeleted: null, cancellable: true }));
    // The same move again answers that move.
    const again = await start();
    expect(again.status).toBe(200);
    expect((await again.json() as CloudMoveRecord).moveId).toBe(MOVE);

    await drive("join");
    const made = providerCalls(harness, /POST .*\/instances$/);
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toEqual(expect.objectContaining({
      type: "vm",
      // The ADE that knows a computer with nothing on it, installed before its first brain start.
      env: expect.objectContaining({ ADE_MIN_VERSION: "1.2.131", ADE_LAUNCH_ID: job().target_launch_id }),
      metadata: expect.objectContaining({ ade_moved_from: INSTANCE, ade_lane_id: "lane-1", ade_lane_name: "Fix login", ade_former_machine_keys: "mk_older,mk_source" }),
    }));
    expect(computer(harness, TARGET).moving_from).toBe(INSTANCE);
    expect(await record()).toEqual(expect.objectContaining({ state: "joining", targetInstanceId: TARGET }));

    await signIn();
    await drive("copy");
    // The chats were saved before the old computer's ADE was paused.
    const onSource = ran.filter((entry) => entry.id === INSTANCE).map((entry) => entry.command);
    const saved = onSource.findIndex((command) => command.includes("ade cloud prepare-stop"));
    expect(saved).toBeGreaterThan(-1);
    expect(onSource.findIndex((command) => command.includes('touch "$ADE_HOME/brain.paused"'))).toBeGreaterThan(saved);
    expect(await record()).toEqual(expect.objectContaining({ state: "copying", cancellable: false }));
    // Paused, the old computer checks in no more: the minute cron leaves both computers awake.
    clock += 11 * 60_000;
    await harness.tick();
    expect(providerCalls(harness, /POST .*\/sleep$/)).toHaveLength(0);

    shell.copy = "0";
    await drive("end");
    expect(await record()).toEqual(expect.objectContaining({
      state: "done", sourceDeleted: true, targetMachineKey: "mk_target", projects: [ROOT], message: "Moved Widgets to a full computer.",
    }));
    expect(onComputer(TARGET, `ade projects add '${ROOT}'`)).toHaveLength(1);
    expect(harness.net.instances.has(INSTANCE)).toBe(false);
    expect(computer(harness).deleted_at).not.toBeNull();
    // The old machine's row went with it; the new one carries the old name.
    expect(harness.rows("select machine_key, custom_name from machines where user_id = ?", OWNER)).toEqual([{ machine_key: "mk_target", custom_name: "Widgets" }]);
    expect(computer(harness, TARGET).name).toBe("Widgets");
    expect(providerCalls(harness, new RegExp(`PATCH .*/instances/${TARGET}$`)).some((call) => call.body?.name === "Widgets")).toBe(true);
    // The signed link to the old computer's files is never kept.
    expect(JSON.stringify(job())).not.toContain("secret-link");
    expect(harness.net.instances.has(TARGET)).toBe(true);
  });

  it.each<[string, () => Promise<void>, string, boolean]>([
    ["the new computer never signs in", async () => {
      clock += 47 * 60_000;
      await failUnjoinedLaunches(harness.env, { provider: createCloudProvider("provider-key"), now: clock });
    }, "the new computer didn't sign in.", false],
    ["the old computer doesn't hand its files over", async () => {
      shell.serve = "";
      await signIn();
    }, "the old computer didn't start handing its files over.", true],
    ["the copy exits non-zero", async () => {
      await signIn();
      await drive("copy");
      shell.copy = "2";
    }, "copying the files failed (exit 2): curl: (22) The requested URL returned error: 502.", true],
    ["the copy runs past its 40 minutes", async () => {
      await signIn();
      await drive("copy");
      clock += 41 * 60_000;
    }, "copying the files took too long.", true],
  ])("%s: the old computer is as it was and the new one is deleted", async (_label, fail, why, paused) => {
    expect((await start()).status).toBe(201);
    await drive("join");
    await fail();
    await drive("end");

    expect(await record()).toEqual(expect.objectContaining({
      state: "failed",
      error: `ADE couldn't move Widgets: ${why} Widgets is as it was, and the new computer was deleted.`,
      sourceDeleted: null,
    }));
    expect(harness.net.instances.has(TARGET)).toBe(false);
    expect(computer(harness, TARGET).deleted_at).not.toBeNull();
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(computer(harness).deleted_at).toBeNull();
    expect(sourceDeletes()).toHaveLength(0);
    // Paused, its ADE starts again; never paused, nothing is undone on it.
    expect(unpaused()).toBe(paused);
    // The computer is free for another move.
    expect((await start({ moveId: OTHER_MOVE })).status).toBe(201);
  });

  it("an old computer the provider won't delete is kept with its ADE running again, and the move ends on the new one", async () => {
    expect((await start()).status).toBe(201);
    await drive("join");
    await signIn();
    shell.copy = "0";
    for (let i = 0; i < 3; i += 1) {
      harness.net.once.push({ match: new RegExp(`DELETE .*/instances/${INSTANCE}$`), reply: harness.net.reply({ error: { code: "server_error", message: "boom" } }, 500) });
    }
    await drive("end");

    expect(await record()).toEqual(expect.objectContaining({
      state: "done",
      sourceDeleted: false,
      message: "Moved Widgets to a full computer. The old computer couldn't be deleted, so it's still there. Delete it from its card.",
    }));
    expect(sourceDeletes()).toHaveLength(3);
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(computer(harness).deleted_at).toBeNull();
    expect(unpaused()).toBe(true);
    expect(harness.net.instances.has(TARGET)).toBe(true);
    expect(computer(harness, TARGET).deleted_at).toBeNull();
  });

  it("a cancel before the copy undoes the move", async () => {
    expect((await start()).status).toBe(201);
    await drive("join");

    const cancelled = await harness.send(OWNER, "DELETE", `/cloud/moves/${MOVE}`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(expect.objectContaining({ state: "cancelled", message: "The move was cancelled. Widgets is as it was.", cancellable: false }));
    expect(harness.net.instances.has(TARGET)).toBe(false);
    expect(computer(harness, TARGET).deleted_at).not.toBeNull();
    expect(harness.row("select state from cloud_launches where launch_id = ?", job().target_launch_id).state).toBe("cancelled");
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(unpaused()).toBe(false);
    // Another account sees no such move.
    expect((await harness.send(OTHER, "DELETE", `/cloud/moves/${MOVE}`)).status).toBe(404);
  });

  it("once the copy started, a cancel is refused and the move goes on", async () => {
    expect((await start()).status).toBe(201);
    await drive("join");
    await signIn();
    await drive("copy");

    const refused = await harness.send(OWNER, "DELETE", `/cloud/moves/${MOVE}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.objectContaining({ code: "move_started" }) });
    shell.copy = "0";
    await drive("end");
    expect((await record()).state).toBe("done");
  });

  it("a step that dies after the provider made the new computer runs again and adopts it, never making a second one", async () => {
    // The provider made it, and the Worker stopped before it read the answer.
    harness.net.after.push({ match: /POST .*\/instances$/, run: () => { throw new Error("the Worker stopped"); } });
    expect((await start()).status).toBe(201);
    clock += 1_000;
    await run();
    expect(job()).toEqual(expect.objectContaining({ step: "make", attempts: 1, target_instance_id: null }));
    // A runner that died holding the job keeps the next one out until its lease ends.
    harness.exec("update cloud_jobs set lease_id = 'dead', lease_until = ?, next_at = ? where job_id = ?", clock + 5 * 60_000, clock, MOVE);
    clock += 60_000;
    await run();
    expect(job()).toEqual(expect.objectContaining({ step: "make", lease_id: "dead" }));

    clock += 5 * 60_000;
    await drive("join");
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(1);
    expect(await record()).toEqual(expect.objectContaining({ state: "joining", targetInstanceId: TARGET }));
  });

  it.each<[string, () => void, Row, number, string]>([
    ["the same kind", () => undefined, { to: "standard" }, 409, "already_that_kind"],
    ["an agent", () => undefined, { origin: "agent" }, 403, "person_only"],
    ["no hours left", () => harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER), {}, 402, "out_of_hours"],
    ["a disk past the new size", () => harness.exec("update cloud_computers set disk_gb = 60 where instance_id = ?", INSTANCE), { sizeId: "large" }, 403, "disk_limit"],
    ["a computer still being set up", () => harness.insert("cloud_launches", {
      launch_id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f", user_id: OWNER, state: "joining", kind: "lane", instance_id: INSTANCE, created_at: NOW, updated_at: NOW, expires_at: NOW + DAY,
    }), {}, 409, "computer_busy"],
    ["moves turned off on the server", () => harness.exec("delete from cloud_settings where key = ?", SETTING), {}, 409, "server_move_unavailable"],
  ])("a move asked with %s is refused and makes nothing", async (_label, setUp, body, status, code) => {
    setUp();
    const refused = await start(body);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error: expect.objectContaining({ code }) });
    expect(harness.rows("select job_id from cloud_jobs")).toEqual([]);
    await run();
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(0);
  });

  it("a second move of a computer answers the one already running", async () => {
    expect((await start()).status).toBe(201);
    const second = await start({ moveId: OTHER_MOVE });
    expect(second.status).toBe(200);
    expect((await second.json() as CloudMoveRecord).moveId).toBe(MOVE);
    expect(harness.rows("select job_id from cloud_jobs")).toEqual([{ job_id: MOVE }]);
    const listed = await (await harness.send(OWNER, "GET", "/cloud/moves")).json() as { moves: CloudMoveRecord[] };
    expect(listed.moves.map((move) => move.moveId)).toEqual([MOVE]);
    expect((await (await harness.send(OTHER, "GET", "/cloud/moves")).json() as { moves: unknown[] }).moves).toEqual([]);
  });

  it("a machine launch makes a computer that only signs in, refused while the setting is off and for an agent", async () => {
    const LAUNCH = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    harness.exec("delete from cloud_settings where key = ?", SETTING);
    const off = await harness.send(OWNER, "POST", "/cloud/launches", { launchId: LAUNCH, kind: "machine" });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: expect.objectContaining({ code: "machine_launch_unavailable" }) });
    harness.insert("cloud_settings", { key: SETTING, value: "1.2.131", updated_at: NOW });
    expect((await harness.send(OWNER, "POST", "/cloud/launches", { launchId: LAUNCH, kind: "machine", madeBy: { kind: "agent", agent: "chat" } })).status).toBe(403);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(0);

    const made = await harness.send(OWNER, "POST", "/cloud/launches", { launchId: LAUNCH, kind: "machine", name: "Scratch" });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual(expect.objectContaining({
      kind: "machine", instanceId: TARGET, request: null, machine: { type: "default", name: "Scratch", movedFrom: null },
    }));
    const create = providerCalls(harness, /POST .*\/instances$/);
    expect(create).toHaveLength(1);
    expect(create[0]!.body!.env).toEqual(expect.objectContaining({ ADE_MIN_VERSION: "1.2.131", ADE_LAUNCH_ID: LAUNCH }));
    // An older app reads each listed launch as a chat or a lane: this one is never listed.
    expect((await (await harness.send(OWNER, "GET", "/cloud/launches?active=1")).json() as { launches: unknown[] }).launches).toEqual([]);
    // The same start again is the same launch.
    expect((await harness.send(OWNER, "POST", "/cloud/launches", { launchId: LAUNCH, kind: "machine", name: "Scratch" })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${LAUNCH}/stages`, { state: "done" })).status).toBe(200);
    expect((await (await harness.send(OWNER, "GET", `/cloud/launches/${LAUNCH}`)).json() as { state: string }).state).toBe("done");
  });
});

describe("ADE Cloud server copies", () => {
  const COPY = "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  const OTHER_COPY = "9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
  const TARGET = "copied123456";
  const USER_CODE = "BCDF-2345";
  const SETTING = MACHINE_LAUNCH_MIN_VERSION_SETTING;
  /** What the fork's shell prints for the hand-over. */
  let shell: { hand: string };
  let ran: Array<{ id: string; command: string }>;

  beforeEach(() => {
    harness.env.CLOUD_LAUNCH_JOIN_KEY = "join-key-test";
    harness.env.CLERK_SECRET_KEY = "sk_test";
    // A copy is a second computer: a plan with room for it.
    seedAccount(harness, OWNER, { plan: "paid", included_milli: 500_000 });
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    harness.insert("cloud_settings", { key: SETTING, value: "1.2.131", updated_at: NOW });
    seedComputer(harness, { name: "Widgets", machine_key: "mk_source", lane_id: "lane-1", lane_name: "Fix login", ade_version: "1.2.131" });
    // What a moved, launched computer carries: none of its own names may reach the copy.
    provide(harness, INSTANCE, "running", {
      ade_machine_key: "mk_source", ade_lane_id: "lane-1", ade_lane_name: "Fix login", ade_launch_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", ade_moved_from: "older1234567", ade_former_machine_keys: "mk_older",
    });
    harness.insert("machines", { user_id: OWNER, machine_key: "mk_source", name: "Widgets", created_at: NOW });
    harness.insert("device_authorizations", {
      device_code: `device-${USER_CODE}`, user_code: USER_CODE, device_secret_hash: "hash", status: "pending", poll_interval_seconds: 5, created_at: NOW, expires_at: NOW + 60 * 60_000,
    });
    shell = { hand: "handed\n" };
    ran = [];
    harness.net.hooks.exec = (id, command) => {
      ran.push({ id, command });
      if (command.includes("launch-join.json")) return { exit_code: 0, stdout: shell.hand };
      return null;
    };
  });

  const run = () => runCloudMoves(harness.env, {
    provider: createCloudProvider("provider-key"),
    createComputer: (userId, provider, extras) => createComputer(harness.env, userId, provider, extras, { now: clock, waitUntil: undefined }),
    forkComputer: (source, provider, extras) => forkComputer(harness.env, source, provider, extras, { now: clock, waitUntil: undefined }),
  });
  const job = (copyId = COPY) => harness.row("select * from cloud_jobs where job_id = ?", copyId);
  const launch = () => harness.row("select * from cloud_launches where launch_id = ?", job().target_launch_id);
  /** The minute cron, tick after tick, until the copy reaches `step`. */
  const drive = async (step: string) => {
    for (let tick = 0; tick < 200 && job().step !== step; tick += 1) {
      clock += 16_000;
      await run();
    }
    expect(job().step).toBe(step);
  };
  const start = (body: Row = {}) => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/copy`, { copyId: COPY, ...body });
  const record = async (copyId = COPY) => await (await harness.send(OWNER, "GET", `/cloud/copies/${copyId}`)).json() as CloudCopyRecord;
  const onComputer = (id: string, text: string) => ran.filter((entry) => entry.id === id && entry.command.includes(text));
  /** Each hand-over the fork got, read as its brain reads the file. */
  const handed = () => onComputer(TARGET, "launch-join.json").map((entry) => {
    const encoded = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(entry.command)?.[1] ?? "";
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { launchId: string; join: string };
  });
  const join = (nonce: string, instanceId = TARGET, body: Row = { userCode: USER_CODE }) => handleCloudRequest(new Request(`https://directory.test/cloud/launches/${job().target_launch_id as string}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ade-instance": instanceId },
    body: JSON.stringify({ nonce, ...body }),
  }), harness.env);
  /** The fork's brain once signed in: it registers, names its machine, then reports its launch done. */
  const signedIn = async () => {
    harness.insert("machines", { user_id: OWNER, machine_key: "mk_copy", name: "ade-box", created_at: clock });
    expect((await harness.send(OWNER, "PUT", `/cloud/instances/${TARGET}/metadata`, { metadata: { ade_machine_key: "mk_copy" } })).status).toBe(200);
    expect((await harness.send(OWNER, "PUT", `/cloud/launches/${job().target_launch_id as string}/stages`, { state: "done" })).status).toBe(200);
  };
  const held = () => onComputer(INSTANCE, '"reason":"copy"').length;
  const released = () => onComputer(INSTANCE, 'rm -f "$ADE_HOME/cloud/holds/copy.json"').length;

  it("copies a computer: one fork with its files, signed in with a one-time code, named, the original untouched", async () => {
    const started = await start();
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual(expect.objectContaining({
      copyId: COPY, sourceInstanceId: INSTANCE, sourceName: "Widgets", name: "Widgets copy", state: "copying", targetInstanceId: null, cancellable: true,
    }));
    // The same copy again answers that copy.
    const again = await start();
    expect(again.status).toBe(200);
    expect((await again.json() as CloudCopyRecord).copyId).toBe(COPY);

    await drive("join");
    const forks = providerCalls(harness, /POST .*\/instances\/abcde12345\/fork$/);
    expect(forks).toHaveLength(1);
    const metadata = forks[0]!.body!.metadata as Record<string, string>;
    expect(metadata).toEqual(expect.objectContaining({ ade_copied_from: INSTANCE, ade_lane_id: "lane-1", ade_launch_id: job().target_launch_id, ade_request_id: job().target_launch_id }));
    for (const key of ["ade_machine_key", "ade_former_machine_keys", "ade_moved_from", "ade_made_by_agent"]) expect(metadata).not.toHaveProperty(key);
    expect(launch()).toEqual(expect.objectContaining({ kind: "machine", state: "joining", instance_id: TARGET }));
    // The running original was held awake for the fork, and let go once the fork ran.
    expect([held(), released()]).toEqual([1, 1]);
    expect(job().source_instance_id).toBeNull();
    expect(await record()).toEqual(expect.objectContaining({ state: "joining", targetInstanceId: TARGET, sourceInstanceId: INSTANCE }));

    // The fork got its launch and code once; the code signs in only the launch's account, on the fork.
    const [hand] = handed();
    expect(handed()).toHaveLength(1);
    expect(hand!.launchId).toBe(job().target_launch_id);
    expect(onComputer(TARGET, 'pkill -f "serve --socket $ADE_HOME/sock/ade.sock"')).toHaveLength(1);
    const joined = await join(hand!.join);
    expect(joined.status).toBe(200);
    expect((await joined.json() as { url: string }).url).toContain(`ticket=t_${OWNER}`);
    // The code is never kept: only its hash, in the launch.
    expect(JSON.stringify([job(), launch()])).not.toContain(hand!.join);

    await signedIn();
    await drive("end");
    expect(await record()).toEqual(expect.objectContaining({
      state: "done", targetMachineKey: "mk_copy", cancellable: false, message: "Copied Widgets into Widgets copy.",
    }));
    expect(harness.row("select custom_name from machines where machine_key = 'mk_copy'").custom_name).toBe("Widgets copy");
    expect(computer(harness, TARGET).name).toBe("Widgets copy");
    // The original is as it was.
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(computer(harness).deleted_at).toBeNull();
    expect(providerCalls(harness, /DELETE .*\/instances\//)).toHaveLength(0);
    // Its copy answers no more cancels.
    const late = await harness.send(OWNER, "DELETE", `/cloud/copies/${COPY}`);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: expect.objectContaining({ code: "copy_signed_in" }) });
  });

  it.each<[string, (code: string) => Promise<Response>, number, string]>([
    ["from another computer", (code) => join(code, "otherbox1234"), 403, "join_refused"],
    ["past its 30 minutes", (code) => { clock += 31 * 60_000; return join(code); }, 410, "join_expired"],
    ["again once its sign-in was approved", async (code) => {
      expect((await join(code)).status).toBe(200);
      harness.exec("update device_authorizations set status = 'approved' where user_code = ?", USER_CODE);
      return join(code, TARGET, { userCode: "GHJK-6789" });
    }, 409, "join_used"],
  ])("the copy's join code used %s is refused", async (_label, attempt, status, code) => {
    expect((await start()).status).toBe(201);
    await drive("join");

    const refused = await attempt(handed()[0]!.join);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error: expect.objectContaining({ code }) });
  });

  it.each<[string, () => Promise<void>, string]>([
    ["the fork never runs", async () => {
      harness.net.after.push({ match: /\/fork$/, run: () => { harness.net.instances.get(TARGET)!.status = "creating"; } });
      await drive("boot");
      clock += 16 * 60_000;
    }, "ADE Cloud didn't finish making the copy in time."],
    ["the fork fails", async () => {
      harness.net.after.push({ match: /\/fork$/, run: () => { harness.net.instances.get(TARGET)!.status = "failed"; } });
    }, "ADE Cloud couldn't make the copy."],
    ["the fork never takes its sign-in", async () => {
      shell.hand = "";
    }, "the copy didn't take its sign-in."],
    ["the copy never signs in", async () => {
      await drive("join");
      clock += 46 * 60_000;
    }, "the copy didn't sign in in time."],
    ["the launcher ends the unjoined copy", async () => {
      await drive("join");
      clock += 46 * 60_000;
      await failUnjoinedLaunches(harness.env, { provider: createCloudProvider("provider-key"), now: clock });
    }, "the copy didn't sign in."],
  ])("%s: the copy is deleted and the original is as it was", async (_label, fail, why) => {
    expect((await start()).status).toBe(201);
    await fail();
    await drive("end");

    expect(await record()).toEqual(expect.objectContaining({
      state: "failed", error: `ADE couldn't copy Widgets: ${why} Widgets is as it was, and the copy was deleted.`,
    }));
    expect(harness.net.instances.has(TARGET)).toBe(false);
    expect(computer(harness, TARGET).deleted_at).not.toBeNull();
    expect(["cancelled", "failed"]).toContain(launch().state);
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(computer(harness).deleted_at).toBeNull();
    expect(released()).toBeGreaterThanOrEqual(1);
    // The original is free for another copy.
    expect((await start({ copyId: OTHER_COPY })).status).toBe(201);
  });

  it("a fork whose brain lost its code before it joined is handed the same code again, at most three times", async () => {
    expect((await start()).status).toBe(201);
    await drive("join");
    const window = launch().join_expires_at;
    // Each tick past four minutes with the code unused hands it again, until the third.
    for (const count of [2, 3, 3]) {
      clock += 5 * 60_000;
      await run();
      expect(handed()).toHaveLength(count);
    }
    const hands = handed();
    expect(new Set(hands.map((hand) => hand.join)).size).toBe(1);
    // The window is the first hand's 30 minutes, never pushed on by a later hand.
    expect(launch().join_expires_at).toBe(window);
    expect((await join(hands[0]!.join)).status).toBe(200);
  });

  it.each<[string, boolean, number]>([
    ["nobody approved its sign-in: it is handed the code again", false, 2],
    ["its sign-in was approved: the code is spent, never handed again", true, 1],
  ])("a fork whose brain used its code and stopped before it signed in, when %s", async (_label, approved, hands) => {
    expect((await start()).status).toBe(201);
    await drive("join");
    // The code is used late in its hand's first minutes.
    clock += 3 * 60_000;
    expect((await join(handed()[0]!.join)).status).toBe(200);
    if (approved) harness.exec("update device_authorizations set status = 'approved' where user_code = ?", USER_CODE);
    // Handed long ago, but claimed a moment ago: still signing in, left alone.
    clock += 2 * 60_000;
    await run();
    expect(handed()).toHaveLength(1);

    clock += 5 * 60_000;
    await run();
    expect(handed()).toHaveLength(hands);
  });

  it("a cancel before the copy signs in deletes the fork and closes its sign-in", async () => {
    expect((await start()).status).toBe(201);
    await drive("join");
    const code = handed()[0]!.join;

    const cancelled = await harness.send(OWNER, "DELETE", `/cloud/copies/${COPY}`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(expect.objectContaining({ state: "cancelled", message: "The copy was cancelled. Widgets is as it was.", cancellable: false }));
    expect(harness.net.instances.has(TARGET)).toBe(false);
    expect(computer(harness, TARGET).deleted_at).not.toBeNull();
    expect(launch().state).toBe("cancelled");
    expect((await join(code)).status).toBe(409);
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    // Another account sees no such copy.
    expect((await harness.send(OTHER, "DELETE", `/cloud/copies/${COPY}`)).status).toBe(404);
    expect((await harness.send(OTHER, "GET", `/cloud/copies/${COPY}`)).status).toBe(404);
  });

  it.each<[string, () => Promise<void>, Partial<CloudCopyRecord>]>([
    ["a cancel after it signed in, before the job read it", async () => {
      await signedIn();
      const late = await harness.send(OWNER, "DELETE", `/cloud/copies/${COPY}`);
      expect(late.status).toBe(409);
      expect(await late.json()).toEqual({ error: expect.objectContaining({ code: "copy_signed_in" }) });
      expect((await record()).cancellable).toBe(false);
    }, { state: "done", message: "Copied Widgets into Widgets copy.", targetMachineKey: "mk_copy" }],
    ["a cancel asked as it signed in", async () => {
      harness.exec("update cloud_jobs set cancel_requested_at = ? where job_id = ?", clock, COPY);
      await signedIn();
    }, { state: "done", message: "Widgets copy had already signed in, so the copy wasn't cancelled. Delete it from its card if you don't want it.", targetMachineKey: "mk_copy" }],
    ["a failure after it signed in", async () => {
      // Signed in with no machine key on its row yet, and ADE Cloud can't read the copy to find it.
      expect((await harness.send(OWNER, "PUT", `/cloud/launches/${job().target_launch_id as string}/stages`, { state: "done" })).status).toBe(200);
      for (let attempt = 0; attempt < 5; attempt += 1) harness.net.once.push({ match: /GET .*\/instances\/copied123456$/, reply: new Error("the provider is down") });
    }, { state: "failed", error: "ADE couldn't finish copying Widgets: could not reach ADE Cloud. Try again. Widgets copy had already signed in, so ADE kept it. Widgets is as it was." }],
  ])("%s: the copy is kept, never deleted", async (_label, act, expected) => {
    expect((await start()).status).toBe(201);
    await drive("join");
    await act();
    await drive("end");

    expect(await record()).toEqual(expect.objectContaining(expected));
    expect(launch().state).toBe("done");
    expect(harness.net.instances.has(TARGET)).toBe(true);
    expect(computer(harness, TARGET).deleted_at).toBeNull();
    expect(providerCalls(harness, /DELETE .*\/instances\//)).toHaveLength(0);
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
  });

  it("a step that dies after the provider made the fork runs again and adopts it, never making a second one", async () => {
    // The provider made it, and the Worker stopped before it read the answer.
    harness.net.after.push({ match: /\/fork$/, run: () => { throw new Error("the Worker stopped"); } });
    expect((await start()).status).toBe(201);
    clock += 1_000;
    await run();
    expect(job()).toEqual(expect.objectContaining({ step: "fork", attempts: 1, target_instance_id: null }));

    await drive("join");
    expect(providerCalls(harness, /\/fork$/)).toHaveLength(1);
    expect(await record()).toEqual(expect.objectContaining({ state: "joining", targetInstanceId: TARGET }));
    expect(launch().instance_id).toBe(TARGET);
    expect(handed()).toHaveLength(1);
  });

  it("an agent's copy is the agent's, and each account lists only its own copies", async () => {
    expect((await start({ origin: "agent", madeByChat: "chat-1", name: "Scratch", sizeId: "medium" })).status).toBe(201);
    await drive("join");
    const fork = providerCalls(harness, /\/fork$/)[0]!.body!;
    expect(fork.metadata).toEqual(expect.objectContaining({ ade_made_by_agent: "chat", ade_made_by_chat: "chat-1" }));
    expect(fork).toEqual(expect.objectContaining({ name: "Scratch", resources: expect.objectContaining({ cpu: 4, memory: 8 }) }));
    expect(await record()).toEqual(expect.objectContaining({ name: "Scratch", sizeId: "medium" }));

    const listed = await (await harness.send(OWNER, "GET", "/cloud/copies")).json() as { copies: CloudCopyRecord[] };
    expect(listed.copies.map((copy) => copy.copyId)).toEqual([COPY]);
    expect((await (await harness.send(OTHER, "GET", "/cloud/copies")).json() as { copies: unknown[] }).copies).toEqual([]);
  });

  it.each<[string, () => void, Row, number, string]>([
    ["the other kind's size", () => undefined, { sizeId: "large" }, 400, "bad_request"],
    // Small uses no hours, so only a size that does is refused.
    ["no hours left, at a size that uses them", () => harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER), { sizeId: "medium" }, 402, "out_of_hours"],
    ["a computer on an older ADE", () => harness.exec("update cloud_computers set ade_version = '1.2.130' where instance_id = ?", INSTANCE), {}, 409, "copy_needs_update"],
    ["copies turned off on the server", () => harness.exec("delete from cloud_settings where key = ?", SETTING), {}, 409, "server_copy_unavailable"],
    ["a computer another job is changing", () => harness.insert("cloud_jobs", {
      job_id: OTHER_COPY, kind: "move", user_id: OWNER, source_instance_id: INSTANCE, state: "copying", step: "copy", next_at: clock + HOUR, created_at: NOW, updated_at: NOW, expires_at: NOW + DAY,
    }), {}, 409, "computer_busy"],
    ["an origin ADE doesn't know", () => undefined, { origin: "robot" }, 400, "bad_request"],
  ])("a copy asked with %s is refused and makes nothing", async (_label, setUp, body, status, code) => {
    setUp();
    const refused = await start(body);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error: expect.objectContaining({ code }) });
    expect(harness.rows("select job_id from cloud_jobs where kind = 'copy'")).toEqual([]);
    await run();
    expect(providerCalls(harness, /\/fork$/)).toHaveLength(0);
    // Another account's computer doesn't exist for it.
    expect((await harness.send(OTHER, "POST", `/cloud/instances/${INSTANCE}/copy`, { copyId: COPY })).status).toBe(404);
  });
});

describe("ADE Cloud server frees (the computer deleted, its lane kept)", () => {
  const FREE = "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  const lane = (state: string, extra: Row = {}) => ({ laneId: "lane-1", laneName: "Fix login", branchRef: "ade/fix-login", primary: false, state, ...extra });
  /** What the computer's shell prints for the free's commands. */
  let shell: { keepAwake: string; push: string; check: string };
  let ran: string[];

  beforeEach(() => {
    seedAccount(harness, OWNER);
    seedComputer(harness, { name: "Widgets", machine_key: "mk_source", lane_id: "lane-1", lane_name: "Fix login" });
    provide(harness, INSTANCE, "running", { ade_machine_key: "mk_source", ade_lane_id: "lane-1", ade_lane_name: "Fix login" });
    shell = {
      keepAwake: JSON.stringify({ busy: false, reasons: [] }),
      push: JSON.stringify({ pushed: 1, failed: 0, skipped: 0, lanes: [lane("pushed")] }),
      check: JSON.stringify({ pushed: 0, failed: 0, skipped: 0, lanes: [lane("clean")] }),
    };
    ran = [];
    harness.net.hooks.exec = (_id, command) => {
      ran.push(command);
      if (command.includes("keep-awake.json")) return { exit_code: 0, stdout: shell.keepAwake };
      if (command.includes("ade cloud push-work")) return { exit_code: 0, stdout: shell.push };
      if (command.includes("ade cloud work-state")) return { exit_code: 0, stdout: shell.check };
      return null;
    };
  });

  const run = () => runCloudMoves(harness.env, {
    provider: createCloudProvider("provider-key"),
    createComputer: (userId, provider, extras) => createComputer(harness.env, userId, provider, extras, { now: clock, waitUntil: undefined }),
  });
  const job = () => harness.row("select * from cloud_jobs where job_id = ?", FREE);
  const drive = async () => {
    for (let tick = 0; tick < 50 && job().step !== "end"; tick += 1) {
      clock += 16_000;
      await run();
    }
    expect(job().step).toBe("end");
  };
  const start = () => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/free`, { freeId: FREE });
  const record = async () => await (await harness.send(OWNER, "GET", `/cloud/frees/${FREE}`)).json() as CloudFreeRecord;
  const keptLanes = async () => ((await (await harness.send(OWNER, "GET", "/cloud/lanes/without-computer")).json()) as { lanes?: Array<{ laneId: string; branchRef: string | null }> }).lanes ?? [];

  it("pushes the work, checks it again, then deletes the computer and keeps its lane on the pushed branch", async () => {
    const started = await start();
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual(expect.objectContaining({ freeId: FREE, instanceId: INSTANCE, laneId: "lane-1", state: "checking", cancellable: true }));
    // The same id again answers the same free.
    expect((await start()).status).toBe(200);
    await drive();

    expect(await record()).toEqual(expect.objectContaining({ state: "done", laneKept: true, branchRef: "ade/fix-login", error: null }));
    // Nothing deleted before the push and the check after it.
    const push = ran.findIndex((command) => command.includes("ade cloud push-work"));
    const check = ran.findIndex((command) => command.includes("ade cloud work-state"));
    expect(push).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(push);
    expect(harness.net.instances.has(INSTANCE)).toBe(false);
    expect(computer(harness).deleted_at).not.toBeNull();
    expect(await keptLanes()).toEqual([expect.objectContaining({ laneId: "lane-1", branchRef: "ade/fix-login" })]);
  });

  it("deleting the kept lane deletes its chats under every computer they were filed under, and no other lane's", async () => {
    harness.env.CLOUD_CHATS = memoryBucket();
    expect((await start()).status).toBe(201);
    await drive();
    const chat = (machineKey: string, chatId: string, laneId: string) => harness.exec(
      "insert into cloud_chat_copies (user_id, machine_key, chat_id, lane_id, r2_key, updated_at) values (?, ?, ?, ?, ?, ?)",
      OWNER, machineKey, chatId, laneId, `chats/${OWNER}/${machineKey}/${chatId}`, clock,
    );
    // Its own computer's key, and a key from before a move that no client listed.
    chat("mk_source", "c1", "lane-1");
    chat("mk_before_move", "c2", "lane-1");
    chat("mk_before_move", "c3", "lane-2");
    expect((await harness.send(OWNER, "DELETE", "/cloud/lanes/without-computer/lane-1")).status).toBe(200);
    expect(await keptLanes()).toEqual([]);
    expect(harness.rows("select chat_id from cloud_chat_copies where user_id = ? order by chat_id", OWNER)).toEqual([{ chat_id: "c3" }]);
  });

  it("a watched free goes on with each read of its record, with no cron", async () => {
    const pending: Array<Promise<unknown>> = [];
    const waitUntil = (promise: Promise<unknown>) => { pending.push(promise); };
    const watch = (method: string, url: string, body?: Row) => handleCloudRequest(new Request(`https://directory.test${url}`, {
      method,
      headers: { authorization: `Bearer ${tokens[OWNER]}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), harness.env, waitUntil);
    expect((await watch("POST", `/cloud/instances/${INSTANCE}/free`, { freeId: FREE })).status).toBe(201);
    for (let read = 0; read < 10 && job().step !== "end"; read += 1) {
      await Promise.all(pending.splice(0));
      clock += 2_000;
      expect((await watch("GET", `/cloud/frees/${FREE}`)).status).toBe(200);
    }
    await Promise.all(pending.splice(0));
    expect(await record()).toEqual(expect.objectContaining({ state: "done", laneKept: true }));
    expect(harness.net.instances.has(INSTANCE)).toBe(false);
  });

  it("reads a busy file from before the free again: a turn that just ended frees at the computer's next check", async () => {
    // The computer writes the file once a minute: it still says busy right after the work ended.
    let reads = 0;
    const exec = harness.net.hooks.exec!;
    harness.net.hooks.exec = (id, command) => {
      if (!command.includes("keep-awake.json")) return exec(id, command);
      reads += 1;
      const stale = reads <= 2;
      const startedAt = Number(job().created_at);
      return { exit_code: 0, stdout: JSON.stringify(stale ? { busy: true, reasons: ["terminal"], updatedAt: startedAt - 30_000 } : { busy: false, reasons: [], updatedAt: startedAt + 60_000 }) };
    };
    expect((await start()).status).toBe(201);
    await drive();
    expect(reads).toBeGreaterThan(2);
    expect(await record()).toEqual(expect.objectContaining({ state: "done", laneKept: true }));
    expect(harness.net.instances.has(INSTANCE)).toBe(false);
  });

  it.each([
    { name: "wakes a resting computer to push its work", held: false },
    // A move from its saved copy claimed the delete after this free started: a wake now would put work after that save.
    { name: "never wakes a resting computer a delete holds", held: true },
  ])("$name", async ({ held }) => {
    harness.net.instances.get(INSTANCE)!.status = "sleeping";
    harness.exec("update cloud_computers set status = 'sleeping' where instance_id = ?", INSTANCE);
    expect((await start()).status).toBe(201);
    if (held) harness.exec("update cloud_computers set idle_deleting_at = ? where instance_id = ?", clock, INSTANCE);
    await drive();
    expect(providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/start$`)).length > 0).toBe(!held);
    expect(await record()).toEqual(expect.objectContaining(held ? { state: "failed", laneKept: null } : { state: "done", laneKept: true }));
  });

  it.each<[string, () => void, string]>([
    ["only the lane's setup is running (a launch waiting for a provider sign-in)", () => {
      shell.keepAwake = JSON.stringify({ busy: true, reasons: ["setup", "in_use"] });
    }, "This lane is still being set up. Finish signing in, or cancel the setup, then free the computer."],
    ["an agent is working", () => {
      shell.keepAwake = JSON.stringify({ busy: true, reasons: ["chat", "setup"] });
    }, "The agent is still working. Stop it or wait, then free the computer."],
    ["what is running can't be read", () => {
      shell.keepAwake = "";
    }, "ADE couldn't tell whether the agent is still working, so the computer stays. Try again in a moment."],
    ["a lane's work couldn't be pushed", () => {
      shell.push = JSON.stringify({ pushed: 0, failed: 1, skipped: 0, lanes: [lane("failed", { dirty: true, ahead: 0 })] });
    }, "ADE couldn't push the work in (Fix login) to GitHub, so the computer stays. Open it, push or discard that work, then try again."],
    ["the main checkout couldn't be read in time (a cold git status on a big repository)", () => {
      shell.push = JSON.stringify({ pushed: 0, failed: 1, skipped: 0, lanes: [
        lane("clean", { dirty: false, ahead: 0 }),
        lane("failed", { laneId: "main", laneName: "Primary", branchRef: "main", primary: true, dirty: false, ahead: 0 }),
      ] });
    }, "ADE couldn't read the work in (main checkout), so nothing was deleted. Try again in a minute; if it fails again, open that lane to see why."],
    ["an older ADE's push names no lanes", () => {
      shell.push = JSON.stringify({ pushed: 0, failed: 1, skipped: 0 });
    }, "ADE couldn't push all work on this computer, so it stays. Open the lane to see why, then try again."],
    ["work changed while it pushed", () => {
      shell.check = JSON.stringify({ pushed: 0, failed: 0, skipped: 0, lanes: [lane("unpushed")] });
    }, "Work changed on this computer while ADE pushed it (Fix login), so it stays. Try again."],
    ["the check after the push can't say", () => {
      shell.check = JSON.stringify({ pushed: 0, failed: 0, skipped: 0 });
    }, "ADE couldn't confirm all work is on GitHub, so the computer stays. Try again."],
  ])("%s: nothing is deleted and no lane is kept", async (_label, arrange, why) => {
    arrange();
    expect((await start()).status).toBe(201);
    await drive();
    expect(await record()).toEqual(expect.objectContaining({ state: "failed", error: why, laneKept: null }));
    expect(harness.net.instances.has(INSTANCE)).toBe(true);
    expect(computer(harness).deleted_at).toBeNull();
    expect(computer(harness).lane_keep_reason).toBeNull();
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(0);
    expect(await keptLanes()).toEqual([]);
  });

  it("refuses a computer with no lane before anything starts", async () => {
    harness.exec("update cloud_computers set lane_id = null, lane_name = null where instance_id = ?", INSTANCE);
    harness.net.instances.get(INSTANCE)!.metadata = {};
    const noLane = await start();
    expect(noLane.status).toBe(409);
    expect(((await noLane.json()) as { error?: { code?: string } }).error?.code).toBe("no_lane");
    expect(harness.rows("select job_id from cloud_jobs")).toEqual([]);
  });
});


describe("ADE Cloud computer status (the provider's webhook and the brain's activity)", () => {
  const SECRET_BYTES = Buffer.from("status-webhook-test-key-32-bytes");
  const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
  const MIN = 60_000;

  const event = (status: string, previous: string | null, at: number, id = INSTANCE) => JSON.stringify({
    type: "instance.status.updated",
    timestamp: new Date(at).toISOString(),
    data: { id, status, previous_status: previous, status_reason: null, name: "ADE · lane", metadata: {} },
  });
  const signature = (deliveryId: string, timestamp: number, body: string, key: Buffer = SECRET_BYTES) =>
    `v1,${createHmac("sha256", key).update(`${deliveryId}.${timestamp}.${body}`).digest("base64")}`;
  const deliver = (deliveryId: string, body: string, options: { timestamp?: number; sign?: string } = {}) => {
    const timestamp = options.timestamp ?? Math.floor(clock / 1000);
    return handleCloudRequest(new Request("https://directory.test/cloud/agent37/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": options.sign ?? signature(deliveryId, timestamp, body),
      },
      body,
    }), harness.env);
  };
  const health = (restartCount: number, memory = "healthy") => harness.net.reply({
    logs: "",
    truncated: false,
    health: { running: true, restart_count: restartCount, exit_code: null, oom_suspected: false, resource_verdict: { memory, cpu: "healthy", disk: "healthy", overall: memory } },
    fetched_at: Math.floor(clock / 1000),
  });
  const events = () => harness.rows("select delivery_id, status, at, restart_count from cloud_instance_events order by at");
  const status = async () => (await (await harness.send(OWNER, "GET", `/cloud/instances/${INSTANCE}/status`)).json()) as Record<string, unknown>;

  beforeEach(() => {
    harness.env.AGENT37_WEBHOOK_SECRET = SECRET;
    seedAccount(harness, OWNER);
    seedComputer(harness, { status: "running", status_changed_at: NOW - 2 * HOUR, awake_since: NOW - 2 * HOUR });
    provide(harness);
  });

  it("keeps a signed change once, for the account's computers only, and refuses a forged, tampered or stale one", async () => {
    const woke = event("running", "starting", NOW - 10 * MIN);
    harness.net.once.push({ match: new RegExp(`GET ${SANDBOX}/instances/${INSTANCE}/logs`), reply: health(3) });
    expect((await deliver("evt_1", woke)).status).toBe(200);
    // The same delivery again is taken once.
    expect(await (await deliver("evt_1", woke)).json()).toEqual({ ok: true, kept: false });
    expect(events()).toEqual([{ delivery_id: "evt_1", status: "running", at: NOW - 10 * MIN, restart_count: 3 }]);

    const asleep = event("sleeping", "running", NOW - MIN);
    expect((await deliver("evt_forged", asleep, { sign: signature("evt_forged", Math.floor(NOW / 1000), asleep, Buffer.from("another-key")) })).status).toBe(401);
    expect((await deliver("evt_tampered", asleep, { sign: signature("evt_tampered", Math.floor(NOW / 1000), woke) })).status).toBe(401);
    const stale = Math.floor(NOW / 1000) - 600;
    expect((await deliver("evt_stale", asleep, { timestamp: stale, sign: signature("evt_stale", stale, asleep) })).status).toBe(401);
    expect((await deliver("evt_unsigned", asleep, { sign: "" })).status).toBe(401);
    // Another workspace instance (not one of ADE's computers) is answered and not kept.
    expect((await deliver("evt_other", event("running", null, NOW - MIN, "zzzzz99999"))).status).toBe(200);
    // Nor is a late one for a computer already deleted (its facts went with it).
    seedComputer(harness, { instance_id: "gone0000001", status: "deleted", awake_since: null, deleted_at: NOW - MIN });
    expect((await deliver("evt_gone", event("sleeping", "running", NOW - MIN, "gone0000001"))).status).toBe(200);
    expect(events().map((row) => row.delivery_id)).toEqual(["evt_1"]);

    // Out of order: an older change arriving late never wins over the newer one.
    expect((await deliver("evt_old", event("sleeping", "running", NOW - 30 * MIN))).status).toBe(200);
    harness.net.once.push({ match: new RegExp(`GET ${SANDBOX}/instances/${INSTANCE}/logs`), reply: health(5, "pressure") });
    expect(await status()).toEqual(expect.objectContaining({
      status: "running",
      awakeSince: NOW - 10 * MIN,
      restarts: 2,
      memory: "pressure",
      outOfMemory: false,
    }));

    // Deliveries missed since (a sleep, then a wake the tick saw): the row is
    // newer, so that older running event no longer dates this stretch awake
    // nor counts its restarts.
    harness.exec("update cloud_computers set status_changed_at = ? where instance_id = ?", NOW - 2 * MIN, INSTANCE);
    harness.net.once.push({ match: new RegExp(`GET ${SANDBOX}/instances/${INSTANCE}/logs`), reply: health(6) });
    expect(await status()).toEqual(expect.objectContaining({ status: "running", awakeSince: NOW - 2 * MIN, restarts: null }));
  });

  it("shows the brain's activity of this stretch awake, never an older report", async () => {
    harness.net.once.push({ match: new RegExp(`GET ${SANDBOX}/instances/${INSTANCE}/logs`), reply: health(1) });
    await deliver("evt_1", event("running", "sleeping", NOW - 10 * MIN));
    const report = (body: Row) => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/activity`, body);
    const idle = { busy: false, idleSince: NOW - 2 * MIN, sleepsAt: NOW + MIN, runningAgents: 0, reportedAt: NOW - MIN };
    expect((await report(idle)).status).toBe(200);
    // Sent late: an older report doesn't replace the newer one.
    expect((await report({ busy: true, idleSince: null, sleepsAt: null, runningAgents: 2, reportedAt: NOW - 5 * MIN })).status).toBe(200);
    expect((await report({ busy: "yes", runningAgents: 1, reportedAt: NOW })).status).toBe(400);
    expect((await status()).activity).toEqual(idle);
    // A report from before the computer woke says nothing about now.
    harness.exec("update cloud_computer_activity set reported_at = ? where instance_id = ?", NOW - 20 * MIN, INSTANCE);
    expect((await status()).activity).toBeNull();
  });
});

/**
 * Sponsored cards and the Index (`gravity.ts`): what reaches Gravity is a
 * privacy contract. Nothing leaves without the switch, the Free plan, the
 * account's yes and a chat on the account's own ADE Cloud computer; the
 * person's own address and device go with it; a reply asks once.
 */
describe("sponsored cards", () => {
  type GravityCall = { url: string; body: Row };
  let gravityCalls: GravityCall[];
  let gravityAnswer: Row;
  const AD = { adText: "Serverless Postgres that scales to zero.", title: "Neon", brandName: "Neon", cta: "Try Neon", url: "https://neon.tech", clickUrl: "https://api.trygravity.ai/track/click?p=1", impUrl: "https://api.trygravity.ai/ack?p=1", favicon: "https://icons.example/neon.ico" };
  const PICK = { search_id: "s1", recommendation: { name: "Neon", description: "Serverless Postgres", category: "database", click_url: "https://index.trygravity.com/go/abc", website_url: "https://neon.tech", sponsored: true }, install: { steps: [{ text: "npm i @neondatabase/serverless" }, { command: "npx\u200b neonctl init" }, { text: "x".repeat(501) }, { text: "rm -rf ./db" }] } };
  const DEVICE = { type: "desktop", os: "macos", osVersion: "15.1", ua: "ADE/1.2.133" };
  const adBody = (overrides: Row = {}) => ({ instanceId: INSTANCE, chatId: "chat-1", turnId: "turn-1", messages: [{ role: "user", content: "set up a database" }, { role: "assistant", content: "Use Postgres." }], device: DEVICE, ...overrides });
  const send = (caller: string, path: string, body: unknown) => harness.send(caller, "POST", path, body, { "cf-connecting-ip": "203.0.113.7" });
  const gravityEnv = () => harness.env as unknown as { GRAVITY_ADS?: string };
  // The instant switches (`settings.ts`): the deploy variables are only their ceilings.
  const setting = (key: string, value: string) => harness.exec("insert or replace into cloud_settings (key, value, updated_at) values (?, ?, ?)", key, value, NOW);
  const goLive = () => {
    Object.assign(harness.env, { GRAVITY_LIVE: "1" });
    setting("gravity_live", "on");
  };

  beforeEach(() => {
    gravityCalls = [];
    gravityAnswer = AD;
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!/trygravity\./.test(url)) return inner(input as RequestInfo, init);
      gravityCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Row : {} });
      return new Response(JSON.stringify(url.includes("index.") ? PICK : [gravityAnswer]), { status: 200, headers: { "content-type": "application/json" } });
    });
    Object.assign(harness.env, { GRAVITY_API_KEY: "gravity-key", GRAVITY_ADS: "all" });
    setting("gravity_ads", "all");
    seedAccount(harness, OWNER);
    seedComputer(harness);
    harness.insert("cloud_sponsored_consent", { user_id: OWNER, consent: "granted", email_hash: "e".repeat(64), decided_at: NOW });
    // The computer saved a copy of the chat after its turn: it runs there.
    harness.insert("cloud_chat_copies", { user_id: OWNER, machine_key: "mk-1", chat_id: "chat-1", instance_id: INSTANCE, r2_key: "chats/1", updated_at: NOW });
  });

  it("sends the person's chat, address and device once per reply, and answers the same card again", async () => {
    const first = await (await send(OWNER, "/cloud/sponsored/ad", adBody())).json() as { ad: Row | null };
    expect(first.ad).toMatchObject({ brand: "Neon", clickUrl: AD.clickUrl, impUrl: AD.impUrl, test: true });
    expect(gravityCalls).toHaveLength(1);
    expect(gravityCalls[0]!.body).toMatchObject({
      testAd: true,
      messages: [{ role: "user", content: "set up a database" }, { role: "assistant", content: "Use Postgres." }],
      device: { ip: "203.0.113.7", device_type: "desktop", os: "macos", os_version: "15.1" },
      user: { hashed_email: "e".repeat(64) },
    });
    // The account id never goes: Gravity gets an opaque one.
    expect(JSON.stringify(gravityCalls[0]!.body)).not.toContain(OWNER);
    // A reload or a second screen asks for the same reply: the same card, no second request.
    expect(await (await send(OWNER, "/cloud/sponsored/ad", adBody())).json()).toEqual(first);
    expect(gravityCalls).toHaveLength(1);
    // Two screens ask for a new reply at the same moment: Gravity is asked once.
    const both = await Promise.all([1, 2].map(async () => (await send(OWNER, "/cloud/sponsored/ad", adBody({ turnId: "turn-2" }))).json() as Promise<{ ad: Row | null }>));
    expect(gravityCalls).toHaveLength(2);
    expect(both.filter((answer) => answer.ad).length).toBe(1);
    // No chat text is kept on the server.
    expect(JSON.stringify(harness.rows("select * from cloud_sponsored_turns"))).not.toContain("database");
  });

  // App Tracking Transparency: an iPhone sends the hashed email only once the person allowed tracking.
  const IPHONE = { type: "mobile", os: "ios", osVersion: "26.1", ua: "ADE-iOS/1.1.10" };
  it.each<[string, Row, boolean]>([
    ["a desktop", DEVICE, true],
    ["an iPhone that allowed tracking", { ...IPHONE, tracking: "authorized" }, true],
    ["an iPhone that said no", { ...IPHONE, tracking: "denied" }, false],
    ["an iPhone where tracking is restricted", { ...IPHONE, tracking: "restricted" }, false],
    ["an iPhone that never answered", { ...IPHONE, tracking: "not_determined" }, false],
    ["an older iPhone app that sends no answer", IPHONE, false],
    ["the web app in an iPhone browser (no Apple prompt there)", { type: "mobile", os: "ios", osVersion: "26.1", ua: null }, true],
  ])("from %s, the card is still asked for, with the hashed email only when allowed", async (_label, device, withEmail) => {
    const answer = await (await send(OWNER, "/cloud/sponsored/ad", adBody({ device }))).json() as { ad: Row | null };
    expect(answer.ad).toMatchObject({ brand: "Neon" });
    expect(gravityCalls).toHaveLength(1);
    const user = gravityCalls[0]!.body.user as Row;
    expect(user.hashed_email).toBe(withEmail ? "e".repeat(64) : undefined);
    // The Index sends the email by the device the person last watched from.
    goLive();
    expect(await (await send(OWNER, "/cloud/sponsored/seen", { instanceId: INSTANCE, device })).json()).toEqual({ ok: true });
    await send(OWNER, "/cloud/sponsored/index", { instanceId: INSTANCE, chatId: "chat-1", need: "a hosted Postgres for this app" });
    expect(gravityCalls).toHaveLength(2);
    expect(gravityCalls[1]!.body.hashed_email).toBe(withEmail ? "e".repeat(64) : undefined);
  });

  it.each<[string, () => void, Row, string]>([
    ["the switch is off", () => { setting("gravity_ads", "off"); }, {}, "off"],
    ["the deploy variable is a hard off", () => { gravityEnv().GRAVITY_ADS = "off"; }, {}, "off"],
    ["the account is not a tester", () => { setting("gravity_ads", "testers"); }, {}, "off"],
    ["the deploy variable holds the switch to testers", () => { gravityEnv().GRAVITY_ADS = "testers"; }, {}, "off"],
    ["the plan is paid", () => { harness.exec("update cloud_accounts set plan = 'paid' where user_id = ?", OWNER); }, {}, "plan"],
    ["the plan is paid and past due", () => { harness.exec("update cloud_accounts set plan = 'paid', stripe_status = 'past_due' where user_id = ?", OWNER); }, {}, "plan"],
    ["the account said no", () => { harness.exec("update cloud_sponsored_consent set consent = 'declined' where user_id = ?", OWNER); }, {}, "consent"],
    ["the account never answered", () => { harness.exec("delete from cloud_sponsored_consent"); }, {}, "consent"],
    ["the chat is on the person's own machine", () => undefined, { instanceId: "notacloud1" }, "not_cloud"],
    ["the computer is another account's", () => { harness.exec("update cloud_computers set user_id = ? where instance_id = ?", OTHER, INSTANCE); }, {}, "not_cloud"],
    ["the computer was deleted", () => { harness.exec("update cloud_computers set deleted_at = ? where instance_id = ?", NOW, INSTANCE); }, {}, "not_cloud"],
    ["the chat doesn't run on that computer", () => undefined, { chatId: "chat-elsewhere" }, "not_cloud"],
    ["the chat is a subagent's", () => { harness.exec("update cloud_chat_copies set parent_chat_id = 'chat-0' where chat_id = 'chat-1'"); }, {}, "not_cloud"],
    ["the account used today's ads", () => { harness.insert("cloud_sponsored_days", { day: new Date(NOW).toISOString().slice(0, 10), user_id: OWNER, kind: "ad_request", count: 120 }); }, {}, "limit"],
  ])("no card and nothing sent to Gravity when %s", async (_label, arrange, overrides, reason) => {
    arrange();
    const answer = await (await send(OWNER, "/cloud/sponsored/ad", adBody(overrides))).json();
    expect(answer).toEqual({ ad: null, reason });
    expect(gravityCalls).toEqual([]);
  });

  // Gravity's renderer: only a client that draws Gravity's design gets it, and only what that renderer draws.
  const SPEC = { version: 1, name: "design", root: { type: "link", bind: "url", children: [{ type: "text", bind: "title" }] } };
  it.each<[string, Row, Row, string | undefined]>([
    ["an older client gets ADE's own card, and Gravity is told no design will be drawn", {}, { supportsSpec: false }, undefined],
    ["desktop and web get Gravity's web design, with the icon inlined", { renderer: "web1" }, { supportsSpec: true, specCapabilities: "web1" }, "data:image/png;base64,iVBORw=="],
    ["the iPhone app gets Gravity's native design, with the icon's own link", { renderer: "psp1", surface: "ios", device: IPHONE }, { supportsSpec: true, specCapabilities: "psp1" }, AD.favicon],
    ["the inline format stays ADE's own linked line, whatever the client draws", { renderer: "web1", format: "inline" }, { supportsSpec: false }, undefined],
  ])("%s", async (_label, overrides, request, favicon) => {
    gravityAnswer = {
      ...AD,
      renderer_spec: SPEC,
      render: { mode: "iframe", frameUrl: "https://frames.trygravity.ai/f/1" },
      unit: { type: "action_card", version: 1, layouts: [], content: {} },
      action: { type: "prompt", id: "a1", prompt: "install neon" },
      connect: { type: "mcp", id: "c1", serverUrl: "https://mcp.example", name: "Neon" },
    };
    const gravity = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === AD.favicon ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }) : gravity(input, init));
    const answer = await (await send(OWNER, "/cloud/sponsored/ad", adBody(overrides))).json() as { ad: Row & { gravity?: Row } };
    expect(gravityCalls).toHaveLength(1);
    const body = gravityCalls[0]!.body;
    expect(body).toMatchObject(request);
    // Never a frame, a data unit or an image layout: no ADE client draws one.
    expect(body.supportsFrames).toBeUndefined();
    expect((body.placements as Row[])[0]!.capabilities).toBeUndefined();
    expect(answer.ad).toMatchObject({ brand: "Neon", clickUrl: AD.clickUrl, impUrl: AD.impUrl });
    if (!favicon) {
      expect(answer.ad.gravity).toBeUndefined();
      return;
    }
    expect(answer.ad.gravity).toEqual({
      adText: AD.adText, title: "Neon", cta: "Try Neon", brandName: "Neon", url: "https://neon.tech/", favicon,
      clickUrl: AD.clickUrl, impUrl: AD.impUrl, renderer_spec: SPEC,
    });
  });

  it("tells clients nothing while the switch is off, and the answer while it is on", async () => {
    setting("gravity_ads", "off");
    expect((await (await harness.send(OWNER, "GET", "/cloud/account")).json() as CloudAccountState).sponsored).toBeUndefined();
    setting("gravity_ads", "all");
    expect((await (await harness.send(OWNER, "GET", "/cloud/account")).json() as CloudAccountState).sponsored).toEqual({ ads: true, consent: "granted", test: true, smallNeedsCards: true, format: "below_reply" });
    // A no on one machine is the answer on every machine.
    expect(await (await send(OWNER, "/cloud/sponsored/seen", { instanceId: INSTANCE, device: DEVICE })).json()).toEqual({ ok: true });
    expect((await harness.send(OWNER, "PUT", "/cloud/sponsored/consent", { consent: "declined" })).status).toBe(200);
    expect(harness.row("select consent, email_hash from cloud_sponsored_consent where user_id = ?", OWNER)).toEqual({ consent: "declined", email_hash: null });
    // A no keeps nothing of where the person watched from.
    expect(harness.rows("select * from cloud_sponsored_viewers")).toEqual([]);
    // From now on a yes is confirmed a second time.
    expect((await (await harness.send(OWNER, "GET", "/cloud/account")).json() as CloudAccountState).sponsored).toEqual({ ads: true, consent: "declined", test: true, smallNeedsCards: true, format: "below_reply", confirmYes: true });
  });

  const owner = (path: string, body: Row, bearer = "owner-token-test") => handleCloudRequest(new Request(`https://directory.test/cloud/owner/${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), harness.env);
  const accountState = async () => (await harness.send(OWNER, "GET", "/cloud/account")).json() as Promise<CloudAccountState>;

  it("the account test tool: only the owner token; a paid account acts as Free for its limits and cards while billing keeps the real plan, until the test ends", async () => {
    harness.env.CLOUD_OWNER_TOKEN = "owner-token-test";
    harness.exec("update cloud_accounts set plan = 'paid', paid_plan = 'pro', included_milli = 600000, stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', stripe_status = 'active' where user_id = ?", OWNER);
    const billing = () => harness.row("select plan, paid_plan, included_milli, stripe_subscription_id, stripe_status, period_end from cloud_accounts where user_id = ?", OWNER);
    const before = billing();
    expect([(await owner("account", { userId: OWNER, plan: "free" }, tokens[OWNER]!)).status, (await owner("account", { userId: OWNER, plan: "free" }, "wrong")).status]).toEqual([401, 401]);
    expect((await accountState()).planId).toBe("pro");

    const set = await (await owner("account", { userId: OWNER, plan: "free", computers: 1, hours: 7, tester: true, note: "ads test" })).json() as { account: Row };
    expect(set.account).toMatchObject({ real: { plan: "pro" }, inForce: { plan: "free", computers: 1, hours: 7 }, sponsored: { tester: true } });
    const acting = await accountState();
    expect([acting.planId, acting.rules, acting.hours.includedMilli, acting.computers.limit, acting.sponsored?.ads, acting.extraHours.available]).toEqual(["free", "free", 7000, 1, true, false]);
    // Stripe, the period and its hours are the real plan's.
    expect(billing()).toEqual(before);
    // More hours than the real plan's would spend a real earned balance (or bill extra hours): refused.
    harness.exec("update cloud_accounts set earned_granted_milli = 5000 where user_id = ?", OWNER);
    expect((await owner("account", { userId: OWNER, hours: 1000 })).status).toBe(409);
    expect((await accountState()).hours.includedMilli).toBe(7000);
    harness.exec("update cloud_accounts set earned_granted_milli = 0 where user_id = ?", OWNER);

    // The test ends by itself: the tick clears it and the real plan is back.
    expect(await expireAccountTests(harness.env, NOW + 6 * DAY)).toBe(0);
    expect(await expireAccountTests(harness.env, NOW + 8 * DAY)).toBe(1);
    expect([(await accountState()).planId, (await accountState()).sponsored?.ads]).toEqual(["pro", false]);
    expect(harness.rows("select action from cloud_owner_log where user_id = ? order by id", OWNER).map((row) => row.action)).toEqual(["account_test", "account_test_ended"]);
  });

  it("where ads reach Free, a no runs Small at half a Medium-hour, a yes at none, each charged for its own stretch; an older no is asked again; ads off frees Small", async () => {
    harness.env.CLOUD_OWNER_TOKEN = "owner-token-test";
    harness.exec("update cloud_computers set multiplier_milli = 0 where instance_id = ?", INSTANCE);
    expect((await owner("settings", { key: "gravity_ads", value: "all" })).status).toBe(200);
    // The yes from before keeps Small free.
    expect(computer(harness).multiplier_milli).toBe(0);
    const used = usedMilli(harness);

    expect((await harness.send(OWNER, "PUT", "/cloud/sponsored/consent", { consent: "declined" })).status).toBe(200);
    expect(computer(harness).multiplier_milli).toBe(500);
    // A yes from where Gravity shows no cards would be unlimited Small for nothing: refused.
    const fromBrazil = (method: string, path: string, body?: Row) => {
      const request = new Request(`https://directory.test${path}`, {
        method,
        headers: { authorization: `Bearer ${tokens[OWNER]}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      Object.defineProperty(request, "cf", { value: { country: "BR" } });
      return handleCloudRequest(request, harness.env);
    };
    expect((await fromBrazil("PUT", "/cloud/sponsored/consent", { consent: "granted" })).status).toBe(403);
    expect(computer(harness).multiplier_milli).toBe(500);
    // A tester sees Gravity's test ads from anywhere, so its cards show abroad; never with real ads.
    harness.insert("cloud_sponsored_testers", { user_id: OWNER, added_at: NOW });
    const abroad = async () => ((await (await fromBrazil("GET", "/cloud/account")).json()) as CloudAccountState).sponsored?.ads;
    expect(await abroad()).toBe(true);
    // Its yes from abroad counts too, and frees Small; with real ads it is refused.
    expect((await fromBrazil("PUT", "/cloud/sponsored/consent", { consent: "granted", confirmed: true })).status).toBe(200);
    expect(computer(harness).multiplier_milli).toBe(0);
    expect((await harness.send(OWNER, "PUT", "/cloud/sponsored/consent", { consent: "declined" })).status).toBe(200);
    goLive();
    expect(await abroad()).toBe(false);
    expect((await fromBrazil("PUT", "/cloud/sponsored/consent", { consent: "granted" })).status).toBe(403);
    setting("gravity_live", "off");
    harness.exec("delete from cloud_sponsored_testers where user_id = ?", OWNER);
    expect(computer(harness).multiplier_milli).toBe(500);
    const declined = await accountState();
    expect([declined.sponsored?.smallNeedsCards, declined.catalog.sizes.find((size) => size.tier === "small")?.multiplierMilli]).toEqual([true, 500]);
    clock += HOUR;
    expect((await harness.send(OWNER, "PUT", "/cloud/sponsored/consent", { consent: "granted", confirmed: true })).status).toBe(200);
    expect([computer(harness).multiplier_milli, usedMilli(harness) - used]).toEqual([0, 500]);
    // An hour on the yes adds nothing to the meter.
    clock += HOUR;
    expect((await accountState()).hours.usedMilli - used).toBe(500);

    // A no from before the rule was a different deal: the question comes back.
    harness.exec("update cloud_sponsored_consent set consent = 'declined', decided_at = ? where user_id = ?", NOW - DAY, OWNER);
    expect((await accountState()).sponsored?.consent).toBeNull();
    // A no holds two weeks, then the question comes back; until answered it still counts as a no.
    expect((await harness.send(OWNER, "PUT", "/cloud/sponsored/consent", { consent: "declined" })).status).toBe(200);
    clock += 13 * DAY;
    expect((await accountState()).sponsored?.consent).toBe("declined");
    clock += DAY;
    expect((await accountState()).sponsored?.consent).toBeNull();
    expect(computer(harness).multiplier_milli).toBe(500);
    // Paid plans and accounts the ad switch doesn't reach keep Small free; turning ads off frees every Small at once.
    harness.exec("update cloud_computers set multiplier_milli = 500 where instance_id = ?", INSTANCE);
    expect((await owner("settings", { key: "gravity_ads", value: "off" })).status).toBe(200);
    expect(computer(harness).multiplier_milli).toBe(0);
  });

  it("where cards start on (the US), the person is told and can turn them off: the notice's yes holds only there, a no holds a year there and two weeks elsewhere, and a no is never turned back on by a notice", async () => {
    // Where a request comes from: a country, or a country and state ("US-TX").
    const from = (where: string, method: string, path: string, body?: Row, headers: Record<string, string> = {}) => {
      const request = new Request(`https://directory.test${path}`, {
        method,
        headers: { authorization: `Bearer ${tokens[OWNER]}`, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const [country, regionCode] = where.split("-");
      Object.defineProperty(request, "cf", { value: { country, regionCode } });
      return handleCloudRequest(request, harness.env);
    };
    const state = async (where: string, headers?: Record<string, string>) => ((await (await from(where, "GET", "/cloud/account", undefined, headers)).json()) as CloudAccountState).sponsored;
    const choose = async (where: string, consent: string, headers?: Record<string, string>) => (await from(where, "PUT", "/cloud/sponsored/consent", { consent }, headers)).status;
    const saved = () => harness.row("select consent, source, country from cloud_sponsored_consent where user_id = ?", OWNER);
    const US = "US-TX";
    harness.exec("delete from cloud_sponsored_consent");
    harness.exec("update cloud_computers set multiplier_milli = 500 where instance_id = ?", INSTANCE);

    // Never answered: told in the US; asked in the UK, in California (or a US state Cloudflare doesn't know), and in the US when the browser sends Global Privacy Control.
    expect(await state(US)).toMatchObject({ ads: true, consent: null, startsOn: true });
    for (const where of ["GB", "US-CA", "US"]) expect((await state(where))?.startsOn).toBeUndefined();
    expect(await state(US, { "sec-gpc": "1" })).toMatchObject({ consent: null, confirmYes: true });
    expect((await state(US, { "sec-gpc": "1" }))?.startsOn).toBeUndefined();
    expect([await choose("GB", "notice"), await choose("US-CA", "notice"), await choose(US, "notice", { "sec-gpc": "1" })]).toEqual([409, 409, 409]);
    expect(saved()).toBeUndefined();
    // Told in the US: the yes is saved as the notice's, Small runs free, and cards go to Gravity from there.
    expect(await choose(US, "notice")).toBe(200);
    expect(saved()).toEqual({ consent: "granted", source: "notice", country: "US" });
    expect(computer(harness).multiplier_milli).toBe(0);
    expect(((await (await from(US, "POST", "/cloud/sponsored/ad", adBody())).json()) as { ad: Row | null }).ad).toMatchObject({ brand: "Neon" });
    // From the UK or California that yes doesn't hold: the person is asked, and no card goes to Gravity.
    expect((await state("GB"))?.consent).toBeNull();
    expect((await state("US-CA"))?.consent).toBeNull();
    expect(await (await from("GB", "POST", "/cloud/sponsored/ad", adBody({ turnId: "turn-2" }))).json()).toEqual({ ad: null, reason: "consent" });
    expect(gravityCalls).toHaveLength(1);
    // A look from a browser that now sends Global Privacy Control: the earlier look no longer lets the Index answer its agents.
    const seen = (headers?: Record<string, string>, where = US) => from(where, "POST", "/cloud/sponsored/seen", { instanceId: INSTANCE, device: DEVICE }, headers).then((response) => response.json());
    const index = async () => ((await (await from(US, "POST", "/cloud/sponsored/index", { instanceId: INSTANCE, chatId: "chat-1", need: "a hosted Postgres" })).json()) as { pick: Row | null; reason?: string });
    expect(await seen()).toEqual({ ok: true });
    goLive();
    // The Index answers from where the person last looked: their US state, kept with the look.
    expect((await index()).pick).toMatchObject({ name: "Neon" });
    // A look from California, where the notice's yes doesn't hold, stops it at once.
    expect(await seen(undefined, "US-CA")).toEqual({ ok: false });
    expect(await index()).toMatchObject({ pick: null });
    expect(await seen()).toEqual({ ok: true });
    expect(await seen({ "sec-gpc": "1" })).toEqual({ ok: false });
    expect(harness.rows("select instance_id from cloud_sponsored_viewers where user_id = ?", OWNER)).toEqual([]);

    // Turned off in the US: Small uses credits, a later notice never overwrites it, and it holds a year, whatever the switch does.
    expect(await choose(US, "declined")).toBe(200);
    expect(computer(harness).multiplier_milli).toBe(500);
    expect(await choose(US, "notice")).toBe(200);
    expect(saved()).toEqual({ consent: "declined", source: "answer", country: "US" });
    harness.exec("update cloud_settings set updated_at = ? where key = 'gravity_ads'", clock + DAY);
    clock += 364 * DAY;
    expect((await state(US))?.consent).toBe("declined");
    // A year on the person is asked again, never told: a notice doesn't turn a no back on.
    clock += DAY;
    expect(await state(US)).toMatchObject({ consent: null });
    expect((await state(US))?.startsOn).toBeUndefined();
    expect(await choose(US, "notice")).toBe(200);
    expect(saved()).toEqual({ consent: "declined", source: "answer", country: "US" });
    // So is a no saved before answers kept their country (asked again after two weeks).
    harness.exec("update cloud_sponsored_consent set country = null, decided_at = ? where user_id = ?", clock - 15 * DAY, OWNER);
    expect((await state(US))?.startsOn).toBeUndefined();
    // A no given in the UK is asked again after two weeks, or at once after the switch changes.
    expect(await choose("GB", "declined")).toBe(200);
    clock += 14 * DAY;
    expect((await state("GB"))?.consent).toBeNull();
    expect(await choose("GB", "declined")).toBe(200);
    harness.exec("update cloud_settings set updated_at = ? where key = 'gravity_ads'", clock + 1);
    clock += 2;
    expect((await state("GB"))?.consent).toBeNull();
    // After a no, a yes takes a second confirm: an app too old to ask twice can't turn cards back on in one click.
    expect(await choose("GB", "granted")).toBe(409);
    expect((await from("GB", "PUT", "/cloud/sponsored/consent", { consent: "granted", confirmed: true })).status).toBe(200);
    expect(saved()).toEqual({ consent: "granted", source: "answer", country: "GB" });
  });

  it("forgets where people watched from a day after their last look, twice an hour, for every account", async () => {
    const DAY = 24 * 60 * 60_000;
    const viewer = (user: string, instance: string, seenAt: number) => harness.insert("cloud_sponsored_viewers", { user_id: user, instance_id: instance, ip: "203.0.113.7", ua: "ADE/1", device_type: "desktop", os: "macos", seen_at: seenAt });
    viewer(OWNER, INSTANCE, NOW - DAY - 60_000);
    viewer(OTHER, "other00001", NOW - DAY - 60_000);
    viewer(OWNER, "recent0001", NOW);
    // NOW is 12:00 UTC. Only minutes 23 and 53 prune; the rest of the hour makes no query.
    await pruneSponsored(harness.env as never, NOW + 22 * 60_000);
    expect(harness.rows("select instance_id from cloud_sponsored_viewers")).toHaveLength(3);
    await pruneSponsored(harness.env as never, NOW + 23 * 60_000);
    expect(harness.rows("select user_id, instance_id from cloud_sponsored_viewers")).toEqual([{ user_id: OWNER, instance_id: "recent0001" }]);
  });

  it("the Index answers an agent only while the person watches, with the person's address", async () => {
    const index = () => send(OWNER, "/cloud/sponsored/index", { instanceId: INSTANCE, chatId: "chat-1", need: "a hosted Postgres for this app" });
    // The Index has no test mode: with test ads for everyone, no search goes.
    expect(await (await index()).json()).toEqual({ pick: null, reason: "off" });
    goLive();
    expect(await (await index()).json()).toEqual({ pick: null, reason: "nobody_watching" });
    expect(gravityCalls).toEqual([]);

    // The person opens the chat from home; the agent's search comes from the computer, elsewhere.
    expect(await (await send(OWNER, "/cloud/sponsored/seen", { instanceId: INSTANCE, device: DEVICE })).json()).toEqual({ ok: true });
    const answer = await harness.send(OWNER, "POST", "/cloud/sponsored/index", { instanceId: INSTANCE, chatId: "chat-1", need: "a hosted Postgres for this app" }, { "cf-connecting-ip": "198.51.100.9" });
    expect(await answer.json()).toMatchObject({ pick: { name: "Neon", url: PICK.recommendation.click_url, sponsored: true, installSteps: ["npm i @neondatabase/serverless", "npx neonctl init"] } });
    expect(gravityCalls).toHaveLength(1);
    expect(gravityCalls[0]!.body).toMatchObject({ query: "a hosted Postgres for this app", user_ip: "203.0.113.7", user_agent: "ADE/1.2.133" });

    // A subagent's chat gets nothing, even while the person watches another chat there.
    harness.insert("cloud_chat_copies", { user_id: OWNER, machine_key: "mk-1", chat_id: "chat-child", instance_id: INSTANCE, r2_key: "chats/2", updated_at: NOW, parent_chat_id: "chat-1" });
    expect(await (await send(OWNER, "/cloud/sponsored/index", { instanceId: INSTANCE, chatId: "chat-child", need: "a hosted Postgres for this app" })).json()).toEqual({ pick: null, reason: "not_cloud" });
    expect(gravityCalls).toHaveLength(1);

    // A tester watching from outside the countries gets no search before go-live either: Index picks are real.
    setting("gravity_live", "off");
    setting("gravity_ads", "testers");
    harness.insert("cloud_sponsored_testers", { user_id: OWNER, added_at: NOW });
    harness.exec("update cloud_sponsored_viewers set country = 'BR' where user_id = ?", OWNER);
    expect(await (await index()).json()).toEqual({ pick: null, reason: "country" });
    expect(gravityCalls).toHaveLength(1);

    // Ten minutes after the person last looked, nobody is watching.
    harness.exec("update cloud_sponsored_viewers set country = null where user_id = ?", OWNER);
    clock = NOW + 11 * 60_000;
    expect(await (await index()).json()).toEqual({ pick: null, reason: "nobody_watching" });
    expect(gravityCalls).toHaveLength(1);
  });
});
