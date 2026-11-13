import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCloudBillingPublicRequest, reportExtraHours } from "../src/cloud/billing";
import type { CloudAccountState } from "../src/cloud/contract";
import { runIdleCleanup } from "../src/cloud/idleCleanup";
import { runPlanCleanupPicks } from "../src/cloud/planCleanup";
import { createCloudProvider } from "../src/cloud/provider";
import { rewardReferralIfDue } from "../src/cloud/referrals";
import { runCloudMinuteCron } from "../src/cloud/cron";
import { nextFireAt } from "../src/cloud/automationSchedule";
import { handleCloudRequest } from "../src/cloud/routes";
import { handleSignupAnalyticsRequest } from "../src/signupAnalytics";
import { applyCloudPlanChange, type CloudEnv } from "../src/cloud/store";
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
const OFF_LIST = "user_off_list";
const INSTANCE = "abcde12345";
const SECOND = "fghij67890";
const WEBHOOK_SECRET = "whsec_cloud_test";
const PROVIDER = "https://api.agent37.com/v1";
const SANDBOX = "https://sandbox.agent37.app/v1";
const STRIPE = "https://api.stripe.com/v1";
const RESEND = "https://api.resend.com";
const CLERK = "https://api.clerk.com/v1";

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
    if (![PROVIDER, SANDBOX, STRIPE, RESEND, CLERK].some((prefix) => url.startsWith(prefix))) return realFetch(input as RequestInfo, init);
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
        .toEqual(expect.objectContaining({ plan: "paid", included_milli: 300_000, stripe_status: "active" }));
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
    ["a renewal moves a subscription bought before Cloud 7 to its plan's extra-hours price and the new disk price, uncharged", async () => {
      Object.assign(harness.env, { STRIPE_DISK_PRICE_ID: "price_disk", STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: "price_extra_plus" });
      harness.net.subscriptions.set("sub_1", { ...activeSubscription, items: { data: [
        { ...activeSubscription.items.data[0], id: "si_plan" },
        { id: "si_extra", price: { id: "price_extra", recurring: { meter: "mtr_hours" } } },
        { id: "si_disk", price: { id: "price_disk_old", recurring: { meter: "mtr_disk" } } },
      ] } });
      harness.net.once.push({ match: /GET .*\/prices\/price_disk$/, reply: harness.net.reply({ id: "price_disk", recurring: { meter: "mtr_disk" } }) });

      expect((await webhook(renewalInvoice)).status).toBe(200);

      expect(providerCalls(harness, /POST .*\/subscription_items\//).map((call) => [call.url.split("/").pop(), call.body?.price, call.body?.proration_behavior]))
        .toEqual([["si_extra", "price_extra_plus", "none"], ["si_disk", "price_disk", "none"]]);
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
  /** Each plan's own extra-hours price (Cloud 7); `price_extra` stays the first, graduated one older subscriptions hold. */
  const EXTRA_PRICES = { STRIPE_MAX_PRICE_ID: "price_max", STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: "price_extra_plus", STRIPE_EXTRA_HOURS_PRO_PRICE_ID: "price_extra_pro", STRIPE_EXTRA_HOURS_MAX_PRICE_ID: "price_extra_max" };
  const plusAccount = { plan: "paid", paid_plan: "plus", included_milli: 300_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" };
  const proAccount = { ...plusAccount, paid_plan: "pro", included_milli: 1_600_000 };
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
    seedStopped([24, 16]);
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
    seedStopped([24, 16]);
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
    // Plus has 30 GB; a full month of 10 GB extra is $2.
    ["a grow that fits the last day's share but not a full month", { extra_disk_state: "on", extra_disk_limit_cents: 200, period_end: NOW + 12 * HOUR }, 28, 44, 403, "monthly_limit"],
    ["a full month just inside the limit, on a period's first day", { extra_disk_state: "on", extra_disk_limit_cents: 600, period_start: NOW, period_end: NOW + 30 * DAY }, 28, 60, 200, null],
    ["one step past a full month at the limit", { extra_disk_state: "on", extra_disk_limit_cents: 600 }, 28, 64, 403, "monthly_limit"],
    ["extra disk on with no limit asks first", { extra_disk_state: "on", extra_disk_limit_cents: null }, 28, 32, 403, "needs_approval"],
    ["extra disk never decided asks first", { extra_disk_state: "off" }, 28, 32, 403, "needs_approval"],
    ["extra disk turned down", { extra_disk_state: "asked", extra_disk_limit_cents: 600 }, 28, 32, 403, "extra_off"],
    ["a grow inside the plan's disk needs no extra disk", { extra_disk_state: "off" }, 20, 28, 200, null],
    // An account from before Cloud 7 keeps Plus's 40 GB until its next period starts.
    ["an account on the old terms keeps 40 GB until its next period", { extra_disk_state: "off", old_plan_terms: 1 }, 20, 36, 200, null],
    ["the same grow on the new terms asks first", { extra_disk_state: "off" }, 20, 36, 403, "needs_approval"],
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
    ["Pro to Plus above Plus's disk with extra disk off is accepted for the period end, and names what Plus's limits free", async () => {
      seedSubscribed({ ...proAccount, extra_disk_state: "off" }, "price_pro", [28, 22]);
      const response = await checkout("plus");
      expect(response.status).toBe(200);
      const body = await response.json() as { change: string; cleanup?: { planId: string; usedGb: number; limitGb: number; computers: unknown[] } };
      expect(body.change).toBe("next_period");
      expect(body.cleanup).toEqual(expect.objectContaining({ planId: "plus", usedGb: 50, limitGb: 30 }));
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
      expect(meterCalls().map((call) => call.body?.["payload[value]"])).toEqual(["22"]);
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
    ["at the limit the limit's own email goes, not a step email", async () => {
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "100", updated_at: NOW });
      await costChecks([[120, 1]]);
      expect(stepEmails()).toEqual(["ADE Cloud reached your cost limit"]);
    }],
    ["a limit email that fails is sent again by the next check", async () => {
      harness.insert("cloud_settings", { key: "owner_cost_limit_usd", value: "100", updated_at: NOW });
      harness.net.once.push({ match: /POST https:\/\/api\.resend\.com\/emails$/, reply: harness.net.reply({ message: "busy" }, 503) });
      await costChecks([[120, 1], [120, 2]]);
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
  ])("a new %s subscription bills extra hours at that plan's own price, and extra disk at the disk price", async (plan, planPrice, extraPrice) => {
    Object.assign(harness.env, MONEY_ENV, EXTRA_PRICES);
    seedAccount(harness, OWNER, { stripe_customer_id: "cus_1" });
    harness.net.once.push({ match: /POST .*\/checkout\/sessions$/, reply: harness.net.reply({ url: "https://checkout.stripe.test/s" }) });

    const response = await harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan });

    expect(response.status).toBe(200);
    const session = providerCalls(harness, /POST .*\/checkout\/sessions$/)[0]?.body ?? {};
    expect([session["line_items[0][price]"], session["line_items[1][price]"], session["line_items[2][price]"]]).toEqual([planPrice, extraPrice, "price_disk"]);
  });

  it.each<[string, string, number, string | null]>([
    ["26 sleeping computers don't stop a new one: no plan limits how many", "stopped", 26, null],
    ["25 awake computers stop a new one, with a plain sentence", "running", 25, "too_many_awake"],
  ])("awake cap: %s", async (_label, status, count, code) => {
    seedAccount(harness, OWNER, { plan: "paid", paid_plan: "max", included_milli: 5_000_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" });
    harness.insert("cloud_settings", { key: "template_version", value: "ade@3", updated_at: NOW });
    for (let index = 0; index < count; index += 1) {
      const id = `cap${String(index).padStart(9, "0")}`;
      seedComputer(harness, { instance_id: id, disk_gb: 4, status, awake_since: status === "running" ? NOW : null, last_awake_at: NOW });
      provide(harness, id, status);
    }

    const response = await harness.send(OWNER, "POST", "/cloud/instances", { type: "default", resources: { cpu: 2, memory: 4 } });

    expect(response.status).toBe(code ? 429 : 201);
    expect((await errorOf(response))?.code ?? null).toBe(code);
    expect(providerCalls(harness, /POST .*\/instances$/)).toHaveLength(code ? 0 : 1);
  });

  // The owner's alert emails (steps and the limit): every email but the daily report (the day's run is marked done, so only a new day sends one).
  const stepEmails = () => providerCalls(harness, /POST https:\/\/api\.resend\.com\/emails$/)
    .map((call) => String(call.body?.subject)).filter((subject) => !/daily report/i.test(subject));
  /** This month's settled cost, all on day one. */
  function setMonthCost(usd: number): void {
    if (!harness.rows("select 1 from cloud_accounts where user_id = ?", OWNER).length) seedAccount(harness, OWNER, plusAccount);
    if (!harness.rows("select 1 from cloud_settings where key = 'last_daily_day'").length) harness.insert("cloud_settings", { key: "last_daily_day", value: DAY_ONE, updated_at: NOW });
    harness.exec("delete from cloud_computer_days where day = ?", DAY_ONE);
    harness.insert("cloud_computer_days", { instance_id: INSTANCE, day: DAY_ONE, user_id: OWNER, multiplier_milli: 1000, cost_micros: usd * 1_000_000 });
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

  it.each<[string, Row, { state: string; earnedLeft: number; extraUsed: number; reports: number }]>([
    ["a free account past its plan's hours keeps running on earned hours",
      { used_milli: 60_000, earned_granted_milli: 20_000 }, { state: "warn80", earnedLeft: 10_000, extraUsed: 0, reports: 0 }],
    ["a free account is out once its earned hours are gone too",
      { used_milli: 70_000, earned_granted_milli: 20_000 }, { state: "zero", earnedLeft: 0, extraUsed: 0, reports: 0 }],
    ["earned hours an ended period drew are gone",
      { used_milli: 55_000, earned_granted_milli: 20_000, earned_used_milli: 15_000 }, { state: "zero", earnedLeft: 0, extraUsed: 0, reports: 0 }],
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
    seedAccount(harness, OWNER, { period_start: NOW - 31 * DAY, period_end: NOW - HOUR, used_milli: 60_000, earned_granted_milli: 20_000 });

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

  it("two accounts using one computer at once: one gets its free plan, the other gets 0 free hours", async () => {
    seedAccount(harness, OWNER);
    seedAccount(harness, OTHER);
    const create = { type: "default", resources: { cpu: 2, memory: 4 } };

    // OTHER claims the computer after OWNER saw it free and before OWNER's claim lands.
    landBefore(/insert into cloud_free_plan_claims/, () => harness.send(OTHER, "POST", "/cloud/instances", create, from(COMPUTER)));
    await harness.send(OWNER, "POST", "/cloud/instances", create, from(COMPUTER));

    expect(harness.rows("select user_id from cloud_free_plan_claims")).toEqual([{ user_id: OTHER }]);
    const refused = await stateOf(OWNER);
    expect(refused.freePlan).toMatchObject({ state: "refused", sentence: "This computer already used another account's free hours. Plus gives you 300 hours a month." });
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
    seedAccount(harness, OWNER, { included_milli: 100_000 });
    seedAccount(harness, OTHER, { included_milli: 100_000 });
    for (const [user, method, headers] of steps) {
      await harness.send(user, method, method === "GET" ? "/cloud/account" : "/cloud/instances", method === "GET" ? undefined : { type: "default", resources: { cpu: 2, memory: 4 } }, headers);
    }

    const states = { [OWNER]: (await stateOf(OWNER)).freePlan?.state, [OTHER]: (await stateOf(OTHER)).freePlan?.state };
    expect(states).toEqual(expected);
    // Only a refused account loses the free plan's hours.
    for (const user of [OWNER, OTHER]) {
      expect(harness.row("select included_milli from cloud_accounts where user_id = ?", user).included_milli).toBe(expected[user] === "refused" ? 0 : 100_000);
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
      () => connectGithub(OWNER, 77, 40), { state: "ok", included: 50_000, claims: [{ github_user_id: 77, user_id: OWNER }], create: 201 }],
    ["a former paid customer's card counts for a new GitHub account",
      async () => { await connectGithub(OWNER, 77, 10); harness.exec("update cloud_accounts set stripe_subscription_id = 'sub_old' where user_id = ?", OWNER); },
      { state: "ok", included: 50_000, claims: [{ github_user_id: 77, user_id: OWNER }], create: 201 }],
    ["an account that used ADE Cloud before the rules keeps its hours with no GitHub",
      async () => { harness.exec("update cloud_accounts set free_github_exempt = 1 where user_id = ?", OWNER); },
      { state: "ok", included: 50_000, claims: [], create: 201 }],
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
    expect([(await stateOf(OTHER)).freePlan?.github?.state, included(OTHER)]).toEqual(["ok", 50_000]);
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

  it("a card saved with no charge unlocks a new GitHub account's free hours; a card that didn't save unlocks nothing", async () => {
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
    harness.net.once.push({ match: /GET .*\/setup_intents\/seti_1$/, reply: harness.net.reply({ id: "seti_1", status: "requires_payment_method" }) });
    expect((await stripeWebhook({ id: "evt_unlock_failed", type: "checkout.session.completed", data: { object: session } })).status).toBe(200);
    expect([harness.row("select free_card_unlocked_at from cloud_accounts where user_id = ?", OWNER).free_card_unlocked_at, included()]).toEqual([null, 0]);

    harness.net.once.push({ match: /GET .*\/setup_intents\/seti_1$/, reply: harness.net.reply({ id: "seti_1", status: "succeeded" }) });
    expect((await stripeWebhook({ id: "evt_unlock", type: "checkout.session.completed", data: { object: session } })).status).toBe(200);

    expect(harness.row("select free_card_unlocked_at, free_github_hold from cloud_accounts where user_id = ?", OWNER)).toEqual({ free_card_unlocked_at: clock, free_github_hold: null });
    expect([included(), githubClaims()]).toEqual([50_000, [{ github_user_id: 77, user_id: OWNER }]]);
    // A card already unlocked: the route says so and opens nothing.
    expect(await (await harness.send(OWNER, "POST", "/cloud/billing/free-unlock", {})).json()).toEqual({ url: null, unlocked: true });
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
 * never deletes work that isn't on GitHub when push is on, and never a
 * computer whose pick no longer applies.
 */
describe("ADE Cloud plan cleanup", () => {
  const NEWER = ["newer000001", "newer000002", "newer000003"];
  const lane = (overrides: Row = {}) => ({ laneId: "lane_main", laneName: "main", branchRef: "main", primary: true, state: "clean", ...overrides });
  const tally = (lanes: Row[], extra: Row = {}) => JSON.stringify({ result: { pushed: 0, failed: 0, skipped: 0, lanes, ...extra } });
  const quiet = JSON.stringify({ result: { interruptedChats: 0, interruptedClis: 0, stillRunning: 0, chatsUploaded: 0, chatsNotUploaded: 0, timedOut: false } });

  /** The free plan allows 3 computers; the person picked the oldest of 4, its work pushed first. */
  function seedOverFreePlan(): void {
    seedAccount(harness, OWNER, { plan_cleanup_choice_json: JSON.stringify({ planId: "free", push: true, instanceIds: [INSTANCE], at: NOW - HOUR }) });
    seedComputer(harness, { created_at: NOW - 40 * DAY });
    provide(harness);
    NEWER.forEach((id, index) => seedComputer(harness, { instance_id: id, created_at: NOW - (10 - index) * DAY, disk_gb: 2 }));
  }

  /** The computer's three answers, in order: prepare-stop, push-work, work-state. */
  function answerExecs(prepare: string, push: string, check: string): void {
    for (const stdout of [prepare, push, check]) {
      harness.net.once.push({ match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`), reply: harness.net.reply({ exit_code: 0, stdout, stderr: "" }) });
    }
  }

  const run = async () => runPlanCleanupPicks(harness.env, createCloudProvider("provider-key"), clock);

  it.each<[string, () => void, boolean]>([
    ["every lane on GitHub, read against the remotes: freed", () => answerExecs(quiet, tally([lane(), lane({ laneId: "lane_x", primary: false, state: "pushed" })], { readsRemotes: true }), tally([lane()], { readsRemotes: true })), true],
    ["a primary lane 'clean' from an ADE that counts against its own branch: kept", () => answerExecs(quiet, tally([lane()]), tally([lane()])), false],
    ["a lane in a state the server doesn't know: kept", () => answerExecs(quiet, tally([lane({ primary: false, state: "unknown" })], { readsRemotes: true }), tally([lane()], { readsRemotes: true })), false],
    ["agents still running after prepare-stop: kept", () => answerExecs(JSON.stringify({ result: { stillRunning: 1, chatsNotUploaded: 0, timedOut: true } }), tally([lane()], { readsRemotes: true }), tally([lane()], { readsRemotes: true })), false],
    ["the person bought Plus while it pushed, so the pick no longer applies: not freed", () => {
      answerExecs(quiet, tally([lane()], { readsRemotes: true }), tally([lane()], { readsRemotes: true }));
      // Lands as the computer is read for the push: after the first check, before the delete.
      harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: () => { harness.exec("update cloud_accounts set plan = 'paid', paid_plan = 'plus', stripe_status = 'active' where user_id = ?", OWNER); } });
    }, false],
    ["a move of it that began while it pushed: not freed, so the move keeps its files", () => {
      answerExecs(quiet, tally([lane()], { readsRemotes: true }), tally([lane()], { readsRemotes: true }));
      harness.net.after.push({ match: new RegExp(`GET .*/instances/${INSTANCE}$`), run: () => { seedComputer(harness, { instance_id: "pending_move_target", moving_from: INSTANCE, status: "provisioning", created_at: NOW }); } });
    }, false],
    ["a sleeping computer it woke for the push and then kept goes back to sleep", () => {
      harness.exec("update cloud_computers set status = 'sleeping', awake_since = null where instance_id = ?", INSTANCE);
      harness.net.instances.get(INSTANCE)!.status = "sleeping";
      answerExecs(quiet, tally([lane({ primary: false, state: "unpushed" })], { readsRemotes: true }), tally([lane()], { readsRemotes: true }));
    }, false],
  ])("%s", async (_label, arrange, freed) => {
    seedOverFreePlan();
    arrange();
    const startedAs = harness.net.instances.get(INSTANCE)!.status;

    await run();

    expect(computer(harness).deleted_at != null).toBe(freed);
    // A computer it keeps ends as it started: one it woke is never left running.
    if (!freed) expect([harness.net.instances.get(INSTANCE)?.status, computer(harness).status]).toEqual([startedAs, startedAs]);
    expect(providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`))).toHaveLength(freed ? 1 : 0);
    // Only the pick: the newer computers are never touched.
    for (const id of NEWER) expect(computer(harness, id).deleted_at).toBeNull();
  });

  it("a downgrade's pick is checked before Stripe is asked, then only the picked computers are freed, each pushed before its delete", async () => {
    harness.env.STRIPE_PRO_PRICE_ID = "price_pro";
    seedAccount(harness, OWNER, { plan: "paid", paid_plan: "pro", included_milli: 1_600_000, stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_status: "active" });
    harness.net.subscriptions.set("sub_1", { status: "active", customer: "cus_1", items: { data: [{ id: "si_plan", price: { id: "price_pro" } }, { id: "si_extra", price: { id: "price_extra" } }] } });
    // 48 GB against Plus's 40: freeing the 4 GB computer leaves the account over, freeing the 44 GB one fits.
    seedComputer(harness, { disk_gb: 44, created_at: NOW - 40 * DAY });
    provide(harness);
    seedComputer(harness, { instance_id: SECOND, disk_gb: 4, created_at: NOW - 10 * DAY });
    provide(harness, SECOND);
    const downgrade = (instanceIds: string[]) => harness.send(OWNER, "POST", "/cloud/billing/checkout", { plan: "plus", cleanup: { push: true, instanceIds } });
    const stored = () => harness.row("select paid_plan_next, plan_cleanup_choice_json is not null as picked from cloud_accounts where user_id = ?", OWNER);

    const refused = await downgrade([SECOND]);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: { code?: string } }).error?.code).toBe("cleanup_does_not_fit");
    expect(providerCalls(harness, /\/subscription_items\//)).toHaveLength(0);
    expect(stored()).toEqual({ paid_plan_next: null, picked: 0 });

    const made = await downgrade([INSTANCE]);
    expect(await made.json()).toEqual({ url: null, change: "next_period", freeing: [INSTANCE] });
    expect(stored()).toEqual({ paid_plan_next: "plus", picked: 1 });

    answerExecs(quiet, tally([lane()], { readsRemotes: true }), tally([lane()], { readsRemotes: true }));
    await run();
    expect([computer(harness).deleted_at != null, computer(harness, SECOND).deleted_at != null]).toEqual([true, false]);
    const pushedAt = harness.net.calls.findIndex((call) => call.url.endsWith(`/instances/${INSTANCE}/exec`) && String(call.body?.command).includes("ade cloud push-work"));
    const deletedAt = harness.net.calls.findIndex((call) => call.method === "DELETE" && call.url.endsWith(`/instances/${INSTANCE}`));
    expect(pushedAt).toBeGreaterThan(-1);
    expect(deletedAt).toBeGreaterThan(pushedAt);
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
 * included), when the push didn't go through, for an account out of hours,
 * and for a computer used since its warning.
 */
describe("ADE Cloud idle cleanup", () => {
  const BRANCH = "ade/pricing-page";
  const lane = (overrides: Row = {}) => ({ laneId: "lane_pricing", laneName: "pricing-page", branchRef: BRANCH, primary: false, state: "pushed", ...overrides });
  const tally = (lanes: Row[]) => JSON.stringify({ result: { pushed: 1, failed: 0, skipped: 0, lanes, readsRemotes: true } });
  const quiet = JSON.stringify({ result: { interruptedChats: 0, interruptedClis: 0, stillRunning: 0, chatsUploaded: 0, chatsNotUploaded: 0, timedOut: false } });
  const run = async () => runIdleCleanup(harness.env, createCloudProvider("provider-key"), clock);
  const execs = () => providerCalls(harness, new RegExp(`POST .*/instances/${INSTANCE}/exec$`));
  const deletes = () => providerCalls(harness, new RegExp(`DELETE .*/instances/${INSTANCE}$`));
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

  /** A sleeping lane computer last used `idleMs` ago, with the ignored files it reported. */
  function seedIdle(idleMs: number, overrides: Row = {}): void {
    seedComputer(harness, {
      status: "sleeping",
      awake_since: null,
      last_awake_at: clock - idleMs,
      status_changed_at: clock - idleMs,
      created_at: clock - 30 * DAY,
      lane_id: "lane_pricing",
      lane_name: "pricing-page",
      lane_project_origin: "github.com/acme/web",
      lane_branch: BRANCH,
      ignored_files_json: JSON.stringify({ checkedAt: clock - idleMs, paths: [".env", "prisma/dev.db"], more: 1, rebuildable: 2 }),
      ...overrides,
    });
    provide(harness, INSTANCE, "sleeping");
  }

  /** The computer's three answers, in order: prepare-stop, push-work, work-state. */
  function answerExecs(push: string, check: string): void {
    for (const stdout of [quiet, push, check]) {
      harness.net.once.push({ match: new RegExp(`POST .*/instances/${INSTANCE}/exec$`), reply: harness.net.reply({ exit_code: 0, stdout, stderr: "" }) });
    }
  }

  it("a free computer is warned at 2 days, emailed again 6 hours before, saved, and deleted no sooner than announced, its lane kept", async () => {
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
    expect([execs(), deletes()]).toEqual([[], []]);

    clock = announced;
    answerExecs(tally([lane()]), tally([lane()]));
    await run();
    expect(execs().map((call) => String(call.body?.command)).find((command) => command.includes("push-work"))).toContain("--message 'saved by ADE before cleanup'");
    expect(deletes()).toHaveLength(1);
    expect(computer(harness).deleted_at).toBe(announced);
    expect(harness.row("select reason from cloud_delete_log where instance_id = ?", INSTANCE).reason).toBe("idle_cleanup");
    expect(harness.row("select lane_name, branch_ref, reason from cloud_lanes_without_computer where lane_id = 'lane_pricing'"))
      .toEqual({ lane_name: "pricing-page", branch_ref: BRANCH, reason: "idle_cleanup" });
  });

  /** Warned a day ago on Free, its announced time now, its last email sent: due unless something below stops it. */
  const dueRow: Row = { idle_warned_at: NOW - DAY, idle_deletes_at: NOW, idle_emailed_at: NOW - 6 * HOUR };

  it.each<[string, () => Promise<void> | void, boolean]>([
    ["GitHub refuses the push: kept, back to sleep, and told why", () => {
      answerExecs(tally([lane({ state: "unpushed" })]), tally([lane({ state: "unpushed" })]));
    }, true],
    ["the account is out of hours: never swept", () => {
      harness.exec("update cloud_accounts set used_milli = included_milli where user_id = ?", OWNER);
    }, false],
    ["the computer was used after its warning: the clock restarts", () => {
      harness.exec("update cloud_computers set last_awake_at = ? where instance_id = ?", NOW - HOUR, INSTANCE);
    }, false],
    ["the person pressed Keep it: the clock restarts with no wake", async () => {
      expect((await harness.send(OWNER, "POST", `/cloud/instances/${INSTANCE}/keep`)).status).toBe(200);
    }, false],
    ["a paid computer announced for later moved to Free: the announced time holds", () => {
      harness.exec("update cloud_computers set idle_deletes_at = ?, idle_warned_at = ?, idle_emailed_at = ? where instance_id = ?", NOW + 2 * DAY, NOW - DAY, NOW - DAY, INSTANCE);
    }, false],
  ])("not deleted: %s", async (_label, arrange, saveTried) => {
    seedIdle(3 * DAY + HOUR, dueRow);
    await arrange();

    await run();

    expect(deletes()).toEqual([]);
    expect(computer(harness).deleted_at).toBeNull();
    expect(execs().length > 0).toBe(saveTried);
    // A computer it kept ends as it started: one it woke is never left running.
    expect([harness.net.instances.get(INSTANCE)?.status, computer(harness).status]).toEqual(["sleeping", "sleeping"]);
    // Nothing to tell the person: no warning starts over, no email goes out.
    if (!saveTried) expect(emails()).toEqual([]);
    if (saveTried) {
      expect(computer(harness).idle_held_reason).toEqual(expect.any(String));
      expect(emails().map((email) => email.subject)).toEqual(["ADE Cloud didn't delete pricing-page: its work couldn't be saved"]);
      // A day later it tries again, and still deletes nothing while the push is refused.
      clock = NOW + DAY;
      // The refused push ends the run before the check, so its answer is left over.
      harness.net.once.splice(0, harness.net.once.length, ...harness.net.once.filter((entry) => !entry.match.source.includes("/exec")));
      answerExecs(tally([lane({ state: "unpushed" })]), tally([lane({ state: "unpushed" })]));
      await run();
      expect(deletes()).toEqual([]);
      expect(harness.rows("select detail from cloud_idle_cleanup_log where step = 'push_refused'")).toEqual([{ detail: "push_left_work" }, { detail: "push_left_work" }]);
      expect(emails()).toHaveLength(1);
    }
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
