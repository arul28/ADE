import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCloudBillingPublicRequest } from "../src/cloud/billing";
import { runCloudMinuteCron } from "../src/cloud/cron";
import { handleCloudRequest } from "../src/cloud/routes";
import { handleSignupAnalyticsRequest } from "../src/signupAnalytics";
import type { CloudEnv } from "../src/cloud/store";
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
const OFF_LIST = "user_off_list";
const INSTANCE = "abcde12345";
const SECOND = "fghij67890";
const WEBHOOK_SECRET = "whsec_cloud_test";
const PROVIDER = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const STRIPE = "https://api.stripe.com/v1";

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
type Call = { method: string; url: string; body: Record<string, unknown> | null };

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
    if (url.startsWith(STRIPE)) return reply({});
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
    if (method === "POST" && action === "exec") return reply({ exit_code: 0, stdout: "", stderr: "" });
    if (method === "POST" && action) {
      const next = ({ sleep: "sleeping", stop: "stopped", start: "running" } as Record<string, string>)[action] ?? instance.status;
      instance.status = next;
      return reply({ status: next });
    }
    return reply({});
  }

  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PROVIDER) && !url.startsWith(SANDBOX) && !url.startsWith(STRIPE)) return realFetch(input as RequestInfo, init);
    const method = init?.method ?? "GET";
    // JSON to the provider, a form to Stripe.
    const body = typeof init?.body !== "string" ? null
      : init.body.startsWith("{") ? JSON.parse(init.body) as Row
      : Object.fromEntries(new URLSearchParams(init.body)) as Row;
    calls.push({ method, url, body });
    const planned = once.findIndex((entry) => entry.match.test(`${method} ${url}`));
    if (planned !== -1) {
      const { reply: planReply } = once.splice(planned, 1)[0]!;
      if (planReply instanceof Error) throw planReply;
      return planReply;
    }
    const response = answer(method, url, body);
    const hook = after.findIndex((entry) => entry.match.test(`${method} ${url}`));
    if (hook !== -1) await after.splice(hook, 1)[0]!.run();
    return response;
  };
  return { instances, subscriptions, calls, once, after, fetchStub, reply };
}

type Harness = ReturnType<typeof sqliteD1> & {
  env: CloudEnv;
  net: ReturnType<typeof fakeNetwork>;
  /** What reached the push relay over the `ACTIVITY_RELAY` binding. */
  relayCalls: Array<{ method: string; url: string; directoryAuth: string | null }>;
  send: (caller: string, method: string, url: string, body?: unknown) => Promise<Response>;
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
    CLOUD_ACCESS_ACCOUNTS: `${OWNER},${OTHER}`,
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
    send: (caller, method, url, body) => handleCloudRequest(new Request(`https://directory.test${url}`, {
      method,
      headers: { authorization: `Bearer ${tokens[caller]}`, "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body ?? {}) }),
    }), env),
    tick: () => runCloudMinuteCron(env, { now: clock }),
  };
}

function seedAccount(data: Harness, userId: string, overrides: Row = {}): void {
  data.insert("cloud_accounts", {
    user_id: userId,
    plan: "free",
    included_milli: 50_000,
    period_start: NOW - 8 * DAY,
    period_end: NOW + 22 * DAY,
    created_at: NOW - 60 * DAY,
    updated_at: NOW - 60 * DAY,
    ...overrides,
  });
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
  tokens = Object.fromEntries(await Promise.all([OWNER, OTHER, OFF_LIST].map(async (sub) => [sub, await mintToken({ sub })])));
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
    // Another account on the list: a computer it doesn't own doesn't exist for it.
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
    // Not on the access list: nothing under /cloud answers but the access flag.
    ["an off-list account listing computers", OFF_LIST, "GET", "/cloud/instances", undefined],
    ["an off-list account creating a computer", OFF_LIST, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } }],
    ["an off-list account reading the account", OFF_LIST, "GET", "/cloud/account", undefined],
    ["an off-list account starting checkout", OFF_LIST, "POST", "/cloud/billing/checkout", {}],
    ["an off-list account turning on extra hours", OFF_LIST, "POST", "/cloud/billing/extra-hours", { enabled: true }],
    ["an off-list account reading saved chats", OFF_LIST, "GET", "/cloud/chats", undefined],
    ["an off-list account asking for a timed wake", OFF_LIST, "PUT", "/cloud/wake", { instanceId: INSTANCE, url: "https://wake-abc.agent37.app", at: NOW + HOUR }],
    ["an off-list account's own computer", OFF_LIST, "POST", `${instancePath}/sleep`, {}],
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
    // The one route an off-list account gets a real answer from says no.
    const access = await (await data.send(OFF_LIST, "GET", "/cloud/access")).json() as { enabled: boolean };
    expect(access.enabled).toBe(false);
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
      expect(computer(harness).multiplier_milli).toBe(2000);
      clock += HOUR;
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/sleep`)).status).toBe(200);
    }, 3000],
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
  const paidAccount = { plan: "paid", included_milli: 500_000, used_milli: 120_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active", period_start: PERIOD_START_S * 1000 };
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
        .toEqual(expect.objectContaining({ plan: "paid", included_milli: 500_000, stripe_status: "active" }));
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
    ["a provider that refuses ADE's key is ADE's problem, and leaves nothing behind", async () => {
      harness.net.once.push({ match: /POST .*\/instances$/, reply: harness.net.reply({ error: { code: "invalid_api_key" } }, 401) });
      const response = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } });
      expect(response.status).toBe(502);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_api_key");
      expect(harness.rows("select instance_id from cloud_computers where instance_id like 'pending:%'")).toEqual([]);
    }],
    ["a move gets the source computer's disk, and the free plan can't take a bigger one", async () => {
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
      const refused = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE });
      expect(refused.status).toBe(403);
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
    ["the 30-day delete leaves a computer the provider says woke up", async () => {
      seedRestingComputer();
      provide(harness, INSTANCE, "stopped");
      harness.net.after.push({ match: /GET .*\/instances$/, run: () => { harness.net.instances.get(INSTANCE)!.status = "running"; } });
      await harness.tick();
      expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toEqual([]);
      expect(computer(harness).deleted_at).toBeNull();
    }],
    ["the 30-day delete leaves a computer used since the tick read it", async () => {
      seedRestingComputer();
      provide(harness, INSTANCE, "stopped");
      harness.net.after.push({ match: /GET .*\/instances$/, run: () => { harness.exec("update cloud_computers set last_awake_at = ? where instance_id = ?", clock, INSTANCE); } });
      await harness.tick();
      expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toEqual([]);
      expect(computer(harness).deleted_at).toBeNull();
    }],
    ["a computer unused for 30 days, warned twice, is deleted", async () => {
      seedRestingComputer();
      provide(harness, INSTANCE, "stopped");
      await harness.tick();
      expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(1);
      expect(computer(harness).deleted_at).toBe(NOW);
      expect(harness.row("select reason from cloud_delete_log where instance_id = ?", INSTANCE).reason).toBe("inactive_30_days");
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
      harness.net.subscriptions.set("sub_1", activeSubscription);
      const response = await deleteAccountOverClerk();

      expect(response.status).toBe(200);
      expect(providerCalls(harness, /DELETE .*\/subscriptions\/sub_1$/)).toHaveLength(1);
      expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(1);
      expect(harness.row("select plan, stripe_subscription_id from cloud_accounts where user_id = ?", OWNER)).toEqual(expect.objectContaining({ plan: "free", stripe_subscription_id: null }));
      expect(computer(harness).deleted_at).toBe(NOW);
      expect(harness.rows("select user_id from cloud_user_keys where user_id = ?", OWNER)).toEqual([]);
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

      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8 })).status).toBe(200);

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
      seedAccount(harness, OTHER, { used_milli: 50_000 });
      harness.exec("update cloud_accounts set used_milli = 50000 where user_id = ?", OWNER);
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
  const MONEY_ENV = { STRIPE_PRO_PRICE_ID: "price_pro", STRIPE_DISK_PRICE_ID: "price_disk", STRIPE_DISK_METER_EVENT: "ade_cloud_extra_disk_gb_days" };
  const plusAccount = { plan: "paid", paid_plan: "plus", included_milli: 500_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" };
  const proAccount = { ...plusAccount, paid_plan: "pro", included_milli: 1_500_000 };
  const DAY_ONE = "2026-11-09";
  const meterCalls = () => providerCalls(harness, /POST .*\/billing\/meter_events$/)
    .filter((call) => call.body?.identifier === `ade-disk:sub_1:${DAY_ONE}`);
  const diskDay = () => harness.row(
    "select billed_gb, reported_at is not null as reported, unconfirmed_at is not null as unconfirmed from cloud_disk_days where user_id = ? and day = ?",
    OWNER, DAY_ONE,
  );
  const errorOf = async (response: Response) => ((await response.json()) as { error?: { code?: string; reason?: string } }).error ?? null;
  const accountRow = () => harness.row("select plan, paid_plan, paid_plan_next, included_milli from cloud_accounts where user_id = ?", OWNER);

  /** Stopped computers holding `disks` GB, each the same size at the provider. */
  function seedStopped(disks: number[], size: { type: string; cpu: number; memory: number } = { type: "default", cpu: 2, memory: 4 }): void {
    disks.forEach((disk, index) => {
      const id = [INSTANCE, SECOND][index]!;
      seedComputer(harness, { instance_id: id, type: size.type, cpu: size.cpu, memory_gb: size.memory, disk_gb: disk, status: "stopped", awake_since: null, last_awake_at: NOW - 2 * DAY });
      const instance = provide(harness, id, "stopped");
      instance.type = size.type;
      instance.resources = { cpu: size.cpu, memory: size.memory, disk };
    });
  }

  it.each<[string, Row, number | null]>([
    ["a paid plan with extra disk on pays the GB past the plan", { extra_disk_state: "on", extra_disk_limit_cents: 1000 }, 10],
    ["extra disk turned down pays nothing", { extra_disk_state: "asked", extra_disk_limit_cents: 1000 }, null],
    ["the free plan pays nothing", { plan: "free", stripe_status: null, extra_disk_state: "on", extra_disk_limit_cents: 1000 }, null],
    ["a failed payment pays nothing", { stripe_status: "past_due", extra_disk_state: "on", extra_disk_limit_cents: 1000 }, null],
  ])("extra disk: a finished day is billed once, from that day's row: %s", async (_label, overrides, billedGb) => {
    Object.assign(harness.env, MONEY_ENV);
    seedAccount(harness, OWNER, { ...plusAccount, ...overrides });
    seedStopped([28, 22]);
    // Day one writes its row; the next day's owner check bills it; a later check finds nothing left.
    await harness.tick();
    clock += DAY;
    await harness.tick();
    const sentByReport = meterCalls().length;
    clock += 11 * 60_000;
    await harness.tick();

    expect(meterCalls().map((call) => [call.body?.["payload[value]"], call.body?.["payload[stripe_customer_id]"]]))
      .toEqual(billedGb == null ? [] : [[String(billedGb), "cus_1"]]);
    expect(meterCalls()).toHaveLength(sentByReport);
    expect(diskDay()).toEqual({ billed_gb: billedGb ?? 0, reported: 1, unconfirmed: 0 });
  });

  it.each<[string, number, boolean]>([
    ["is sent again, with the same value, inside Stripe's one-day window", 11 * 60_000, true],
    ["is never sent again after the window, and waits for the owner", 21 * HOUR, false],
  ])("extra disk: a meter send that timed out %s", async (_label, wait, resent) => {
    Object.assign(harness.env, MONEY_ENV);
    seedAccount(harness, OWNER, { ...plusAccount, extra_disk_state: "on", extra_disk_limit_cents: 1000 });
    seedStopped([28, 22]);
    await harness.tick();
    clock += DAY;
    harness.net.once.push({ match: /POST .*\/billing\/meter_events$/, reply: new Error("timed out") });
    await harness.tick();
    expect(diskDay()).toEqual({ billed_gb: 10, reported: 0, unconfirmed: 0 });

    clock += wait;
    await harness.tick();
    clock += 11 * 60_000;
    await harness.tick();

    expect(meterCalls().map((call) => call.body?.["payload[value]"])).toEqual(resent ? ["10", "10"] : ["10"]);
    expect(diskDay()).toEqual(resent ? { billed_gb: 10, reported: 1, unconfirmed: 0 } : { billed_gb: 10, reported: 0, unconfirmed: 1 });
  });

  const XLARGE = { type: "vm", cpu: 4, memory: 16 };
  it.each<[string, Row, number, number, number, string | null]>([
    // Plus has 40 GB; a full month of 10 GB extra is $1.
    ["a grow that fits the last day's share but not a full month", { extra_disk_state: "on", extra_disk_limit_cents: 100, period_end: NOW + 12 * HOUR }, 40, 52, 403, "monthly_limit"],
    ["a full month just inside the limit, on a period's first day", { extra_disk_state: "on", extra_disk_limit_cents: 400, period_start: NOW, period_end: NOW + 30 * DAY }, 40, 80, 200, null],
    ["one step past a full month at the limit", { extra_disk_state: "on", extra_disk_limit_cents: 400 }, 40, 84, 403, "monthly_limit"],
    ["extra disk on with no limit asks first", { extra_disk_state: "on", extra_disk_limit_cents: null }, 40, 44, 403, "needs_approval"],
    ["extra disk never decided asks first", { extra_disk_state: "off" }, 40, 44, 403, "needs_approval"],
    ["extra disk turned down", { extra_disk_state: "asked", extra_disk_limit_cents: 400 }, 40, 44, 403, "extra_off"],
    ["a grow inside the plan's disk needs no extra disk", { extra_disk_state: "off" }, 20, 36, 200, null],
  ])("extra disk limit: %s", async (_label, overrides, fromGb, toGb, status, reason) => {
    Object.assign(harness.env, MONEY_ENV);
    seedAccount(harness, OWNER, { ...plusAccount, ...overrides });
    seedStopped([fromGb], XLARGE);

    const response = await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 4, memory: 16, disk: toGb });

    expect(response.status).toBe(status);
    expect((await errorOf(response))?.reason ?? null).toBe(reason);
    expect(computer(harness).disk_gb).toBe(reason ? fromGb : toGb);
    expect(providerCalls(harness, /POST .*\/resize$/)).toHaveLength(reason ? 0 : 1);
  });

  it.each<[string, Row, Row, number, string | null, boolean]>([
    ["the free plan above its disk can't wake", { plan: "free" }, {}, 402, "over_plan_disk", false],
    ["the free plan above its disk still gets the push-work wake, which isn't use", { plan: "free" }, { reason: "push_work" }, 200, null, false],
    ["a failed payment with the same disk still wakes", { ...plusAccount, stripe_status: "past_due" }, {}, 200, null, true],
  ])("free shared disk: %s", async (_label, overrides, body, status, code, lastAwakeMoves) => {
    seedAccount(harness, OWNER, overrides);
    seedStopped([8, 8]);

    const response = await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, body);

    expect(response.status).toBe(status);
    expect(status === 200 ? null : (await errorOf(response))?.code).toBe(code);
    expect(providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/start$`))).toHaveLength(code ? 0 : 1);
    // The 30-day delete clock moves only for real use.
    expect(computer(harness).last_awake_at).toBe(lastAwakeMoves ? NOW : NOW - 2 * DAY);
  });

  const planItem = () => ((harness.net.subscriptions.get("sub_1")?.items as { data: Row[] }).data[0]!.price as Row).id;
  const itemCalls = () => providerCalls(harness, /POST .*\/subscription_items\/si_plan$/);
  function seedSubscribed(account: Row, price: string, disks: number[]): void {
    seedAccount(harness, OWNER, account);
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [{ id: "si_plan", price: { id: price } }, { id: "si_extra", price: { id: "price_extra" } }] } });
    seedStopped(disks);
  }
  const checkout = (plan: string) => harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan });

  it.each<[string, () => Promise<void>]>([
    ["Pro to Plus above Plus's disk with extra disk off is refused, and nothing moves", async () => {
      seedSubscribed({ ...proAccount, extra_disk_state: "off" }, "price_pro", [28, 22]);
      const response = await checkout("plus");
      expect(response.status).toBe(409);
      expect((await errorOf(response))?.code).toBe("disk_over_plan");
      expect(itemCalls()).toEqual([]);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: null }));
    }],
    ["Pro to Plus that fits waits for the period end, and Stay on Pro undoes it uncharged", async () => {
      seedSubscribed(proAccount, "price_pro", [12, 8]);
      expect(await (await checkout("plus")).json()).toEqual({ url: null, change: "next_period" });
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: "plus", included_milli: 1_500_000 }));
      expect(planItem()).toBe("price_plan");

      expect((await checkout("pro")).status).toBe(200);
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "pro", paid_plan_next: null, included_milli: 1_500_000 }));
      expect(planItem()).toBe("price_pro");
      expect(itemCalls().map((call) => [call.body?.price, call.body?.proration_behavior, call.body?.payment_behavior ?? null]))
        .toEqual([["price_plan", "none", null], ["price_pro", "none", null]]);
    }],
    ["Plus to Pro with a declined card leaves the plan, the hours and the item as they were", async () => {
      seedSubscribed(plusAccount, "price_plan", [4]);
      harness.net.once.push({ match: /POST .*\/subscription_items\/si_plan$/, reply: harness.net.reply({ error: { message: "Your card was declined." } }, 402) });
      const response = await checkout("pro");
      expect(response.status).toBe(402);
      expect((await errorOf(response))?.code).toBe("payment_failed");
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "plus", paid_plan_next: null, included_milli: 500_000 }));
      expect(planItem()).toBe("price_plan");
    }],
    ["a Stripe answer whose item isn't on the new price writes nothing", async () => {
      seedSubscribed(plusAccount, "price_plan", [4]);
      harness.net.once.push({ match: /POST .*\/subscription_items\/si_plan$/, reply: harness.net.reply({ id: "si_plan", price: { id: "price_plan" } }) });
      const response = await checkout("pro");
      expect(response.status).toBe(409);
      expect((await errorOf(response))?.code).toBe("plan_change_refused");
      expect(accountRow()).toEqual(expect.objectContaining({ paid_plan: "plus", included_milli: 500_000 }));
      expect(planItem()).toBe("price_plan");
    }],
    ["a grow is billed only once the provider made it: refused never, a lost answer from the old size until the tick sees it", async () => {
      seedAccount(harness, OWNER, { ...plusAccount, extra_disk_state: "on", extra_disk_limit_cents: 1000 });
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
      expect(meterCalls().map((call) => call.body?.["payload[value]"])).toEqual(["12"]);
    }],
    ["a move's old computer counts once while the move runs, and again if it outlives the move", async () => {
      seedAccount(harness, OWNER);
      harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
      seedStopped([8]);
      const wakeOld = () => harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/start`, {});
      const moveFrom = (id: string) => harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: id });
      const usedGb = async () => ((await (await harness.send(OWNER, "GET", "/cloud/account")).json()) as { disk: { usedGb: number } }).disk.usedGb;
      expect((await moveFrom(INSTANCE)).status).toBe(201);
      expect(await usedGb()).toBe(8);
      expect((await wakeOld()).status).toBe(200);
      // One move at a time: neither the new computer nor the old one starts another while it runs.
      for (const id of ["madenew12345", INSTANCE]) expect((await errorOf(await moveFrom(id)))?.code).toBe("computer_busy");

      clock += 3 * HOUR;
      await harness.tick();
      expect((await errorOf(await wakeOld()))?.code).toBe("over_plan_disk");
      expect(await usedGb()).toBe(16);
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
  ])("plans and billing: %s", async (_label, run) => {
    Object.assign(harness.env, MONEY_ENV);
    await run();
  });

  it.each<[string, string, string, Row, number, string | null, RegExp]>([
    ["a new computer", "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } }, 503, "unavailable", /POST .*\/instances$/],
    ["a copy", "POST", `/cloud/instances/${INSTANCE}/fork`, {}, 503, "unavailable", /POST .*\/fork$/],
    ["a move", "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 }, moveFromInstanceId: INSTANCE }, 503, "unavailable", /POST .*\/instances$/],
    ["a disk grow", "POST", `/cloud/instances/${INSTANCE}/resize`, { cpu: 2, memory: 4, disk: 8 }, 403, "disk_limit", /POST .*\/resize$/],
    ["a wake still works", "POST", `/cloud/instances/${INSTANCE}/start`, {}, 200, null, /POST .*\/start$/],
  ])("owner's cost limit reached: %s", async (_label, method, url, body, status, code, providerCall) => {
    seedAccount(harness, OWNER, plusAccount);
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "10", updated_at: NOW });
    harness.insert("cloud_settings", { key: "cost_mtd_micros", value: "10000000", updated_at: NOW });
    seedStopped([4]);

    const response = await harness.send(OWNER, method, url, body);

    expect(response.status).toBe(status);
    expect(status === 200 ? null : (await errorOf(response))?.code).toBe(code);
    expect(providerCalls(harness, providerCall)).toHaveLength(code ? 0 : 1);
    expect(harness.rows("select instance_id from cloud_computers where deleted_at is null order by instance_id")).toEqual([{ instance_id: INSTANCE }]);
    expect(computer(harness).disk_gb).toBe(4);
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

  function seedRestingComputer(): void {
    seedComputer(harness, {
      status: "stopped",
      awake_since: null,
      last_awake_at: NOW - 40 * DAY,
      status_changed_at: NOW - 40 * DAY,
      delete_warned_7d_at: NOW - 8 * DAY,
      delete_warned_1d_at: NOW - 2 * DAY,
    });
  }
});
