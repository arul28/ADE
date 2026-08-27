import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import {
  createPluginWebhookIngressService,
  pluginWebhookUrl,
  resetPluginIngressOwnersForTests,
  verifyPluginWebhookSignature,
  type PluginWebhookIngressDb,
  type PluginWebhookIngressPlugin,
} from "./pluginWebhookIngressService";
import {
  PLUGIN_WEBHOOK_BODY_MAX_BYTES,
  PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX,
  PLUGIN_WEBHOOK_LEDGER_RETENTION_DAYS,
  PLUGIN_WEBHOOK_LEDGER_ROWS_MAX,
  PLUGIN_WEBHOOK_SECRET_NAME,
  type PluginWebhookPayload,
} from "../../../shared/plugins/sdk";

const testRequire = createRequire(import.meta.url);
const { DatabaseSync } = testRequire("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

/**
 * A REAL sqlite database rather than a statement-matching fake.
 *
 * The three properties under test here are all properties of the SQL: the
 * dedupe is an indexed lookup, the prune is a delete with a subselect that must
 * spare pending rows, and the redelivery order is `order by received_at, rowid`.
 * A fake that pattern-matched on statement text would pass every one of them
 * while the query said something else.
 *
 * The DDL is copied verbatim from `kvDb.ts`'s migration; `kvDb.migrations.test`
 * owns proving that migration runs.
 */
function createDb(): PluginWebhookIngressDb & { raw: DatabaseSyncType; close: () => void } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    create table if not exists plugin_ingress_events (
      id text primary key,
      project_id text not null,
      plugin_id text not null,
      channel text not null,
      delivery_id text not null,
      event_type text not null,
      received_at text not null,
      stored_at text not null,
      headers_json text,
      body text,
      attempts integer not null default 0,
      acked_at text,
      abandoned_at text
    );
    create index if not exists idx_plugin_ingress_events_delivery on plugin_ingress_events(project_id, plugin_id, delivery_id);
    create index if not exists idx_plugin_ingress_events_pending on plugin_ingress_events(project_id, plugin_id, acked_at, abandoned_at);
    create index if not exists idx_plugin_ingress_events_stored on plugin_ingress_events(plugin_id, stored_at desc);
  `);
  const kv = new Map<string, unknown>();
  return {
    raw,
    close: () => raw.close(),
    getJson: <T>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown): void => {
      if (value === null || value === undefined) kv.delete(key);
      else kv.set(key, value);
    },
    run: (sql: string, params: unknown[] = []): void => {
      raw.prepare(sql).run(...(params as never[]));
    },
    get: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T | null => {
      return (raw.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    all: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] => {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
  } as PluginWebhookIngressDb & { raw: DatabaseSyncType; close: () => void };
}

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

type RelayEventInput = {
  seq: number;
  eventId: string;
  channel?: string;
  eventType?: string;
  createdAt?: string;
  headers?: Record<string, unknown>;
  body?: string;
};

function relayEvent(input: RelayEventInput): Record<string, unknown> {
  return {
    cursor: `seq:${input.seq}`,
    eventId: input.eventId,
    channel: input.channel ?? "default",
    eventType: input.eventType ?? "status",
    createdAt: input.createdAt ?? new Date(1_700_000_000_000 + input.seq * 1000).toISOString(),
    headers: input.headers ?? { "content-type": "application/json" },
    body: input.body ?? JSON.stringify({ seq: input.seq }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const DEFAULT_CHANNELS: PluginWebhookIngressPlugin["channels"] = [
  { id: "default", label: "Default" },
];

function createHarness(options: {
  channels?: PluginWebhookIngressPlugin["channels"];
  pages?: Record<string, unknown>[][];
  deliver?: (pluginId: string, payload: PluginWebhookPayload) => boolean;
  secrets?: Record<string, string>;
  pluginId?: string;
} = {}) {
  const pluginId = options.pluginId ?? "ade-cursor-cloud";
  const db = createDb();
  const logger = createLogger();
  const delivered: PluginWebhookPayload[] = [];
  const secretValues = new Map<string, string>(Object.entries(options.secrets ?? {}));
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let pageIndex = 0;
  const pages = options.pages ?? [[]];

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    if (url.includes("/register")) return jsonResponse({ ok: true, secretId: "secret-1" });
    const page = pages[Math.min(pageIndex, pages.length - 1)] ?? [];
    pageIndex += 1;
    const nextCursor = page.length ? (page[page.length - 1] as { cursor: string }).cursor : null;
    return jsonResponse({ events: page, nextCursor, cursorExpired: false });
  }) as unknown as typeof fetch;

  const service = createPluginWebhookIngressService({
    db,
    projectId: "project-1",
    logger,
    listPlugins: () => [{ pluginId, channels: options.channels ?? DEFAULT_CHANNELS }],
    secrets: {
      get: async (id, name) => secretValues.get(`${id}:${name}`) ?? null,
      set: async (id, name, value) => {
        secretValues.set(`${id}:${name}`, value);
      },
    },
    deliver: (id, payload) => {
      const accepted = options.deliver ? options.deliver(id, payload) : true;
      if (accepted) delivered.push(payload);
      return accepted;
    },
    fetchImpl,
  });

  const rows = (): Record<string, unknown>[] => db.all(
    "select * from plugin_ingress_events order by rowid asc",
    [],
  );

  return { db, service, delivered, logger, requests, rows, secretValues, pluginId };
}

afterEach(() => {
  resetPluginIngressOwnersForTests();
  vi.useRealTimers();
});

beforeEach(() => {
  resetPluginIngressOwnersForTests();
});

describe("pluginWebhookIngressService drain", () => {
  it("registers a secret once, then polls and delivers each event", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    await harness.service.pollNow();

    expect(harness.requests[0]?.url).toContain("/plugin/ade-cursor-cloud/register");
    expect(harness.requests[1]?.url).toContain("/plugin/ade-cursor-cloud/events");
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject({
      event: "webhook.received",
      id: "d-1",
      channel: "default",
      eventType: "status",
      attempt: 1,
    });

    await harness.service.pollNow();
    // One registration for the life of the drain: the second tick polls only.
    expect(harness.requests.filter((entry) => entry.url.includes("/register"))).toHaveLength(1);
  });

  it("never puts the relay secret in a URL or a body", async () => {
    const harness = createHarness();
    await harness.service.pollNow();
    const secret = harness.secretValues.get(`${harness.pluginId}:${PLUGIN_WEBHOOK_SECRET_NAME}`);
    expect(secret).toBeTruthy();
    for (const request of harness.requests) {
      expect(request.url).not.toContain(secret!);
      expect(String((request.init?.headers as Record<string, string>).authorization)).toBe(`Bearer ${secret}`);
    }
  });

  // The replay guard. A relay that re-serves a page — a cursor reset, a retried
  // poll — must not fire the plugin twice.
  it("dedupes a redelivered relay event by delivery id", async () => {
    const event = relayEvent({ seq: 1, eventId: "d-1" });
    const harness = createHarness({ pages: [[event], [event]] });
    await harness.service.pollNow();
    await harness.service.pollNow();
    expect(harness.rows()).toHaveLength(1);
    // The second tick redelivers the row it already had, because nobody acked.
    expect(harness.delivered.map((payload) => payload.attempt)).toEqual([1, 2]);
  });

  it("stops redelivering once the plugin acks", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    await harness.service.pollNow();
    harness.service.ack(harness.pluginId, "d-1");
    await harness.service.pollNow();
    expect(harness.delivered).toHaveLength(1);
    expect(harness.rows()[0]?.acked_at).toBeTruthy();
  });

  it("ignores an ack from a plugin that does not own the delivery", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    await harness.service.pollNow();
    harness.service.ack("some-other-plugin", "d-1");
    expect(harness.rows()[0]?.acked_at).toBeNull();
  });

  // A child that is not running has not failed. Charging it an attempt would
  // abandon deliveries after five ticks of a plugin that simply had not booted.
  it("does not spend an attempt when nobody takes the delivery", async () => {
    let accepting = false;
    const harness = createHarness({
      pages: [[relayEvent({ seq: 1, eventId: "d-1" })], [], []],
      deliver: () => accepting,
    });
    await harness.service.pollNow();
    await harness.service.pollNow();
    expect(harness.rows()[0]?.attempts).toBe(0);
    accepting = true;
    await harness.service.pollNow();
    expect(harness.rows()[0]?.attempts).toBe(1);
    expect(harness.delivered).toHaveLength(1);
  });

  it("abandons a delivery the plugin never acks after the attempt ceiling", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    for (let tick = 0; tick < PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX + 1; tick += 1) {
      await harness.service.pollNow();
    }
    expect(harness.delivered).toHaveLength(PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX);
    expect(harness.rows()[0]?.abandoned_at).toBeTruthy();
    // And it stays abandoned rather than coming back on the next tick.
    await harness.service.pollNow();
    expect(harness.delivered).toHaveLength(PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX);
  });

  it("drops a delivery on a channel the manifest does not declare", async () => {
    const harness = createHarness({
      pages: [[relayEvent({ seq: 1, eventId: "d-1", channel: "typo" })], []],
    });
    await harness.service.pollNow();
    expect(harness.rows()).toHaveLength(0);
    expect(harness.delivered).toHaveLength(0);
  });

  it("filters headers to the allowlist and clamps an oversized body", async () => {
    const harness = createHarness({
      pages: [[relayEvent({
        seq: 1,
        eventId: "d-1",
        headers: { "content-type": "application/json", authorization: "Bearer super-secret", cookie: "session=1" },
        body: "x".repeat(PLUGIN_WEBHOOK_BODY_MAX_BYTES + 100),
      })], []],
    });
    await harness.service.pollNow();
    const payload = harness.delivered[0]!;
    expect(payload.headers).toEqual({ "content-type": "application/json" });
    expect(payload.body.length).toBeLessThanOrEqual(PLUGIN_WEBHOOK_BODY_MAX_BYTES);
    expect(payload.truncated).toBe(true);
    // The stored row is filtered too, so a header that never reaches a child
    // also never sits in the project database.
    expect(String(harness.rows()[0]?.headers_json)).not.toContain("super-secret");
  });

  it("advances the poll cursor so the next tick asks for what follows", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 7, eventId: "d-7" })], []] });
    await harness.service.pollNow();
    await harness.service.pollNow();
    const eventsRequests = harness.requests.filter((entry) => entry.url.includes("/events"));
    expect(eventsRequests.at(-1)?.url).toContain("after=seq%3A7");
  });
});

describe("pluginWebhookIngressService signature verification", () => {
  const channels: PluginWebhookIngressPlugin["channels"] = [
    { id: "default", label: "Default", verify: { kind: "hmac-sha256", secretRef: "SIGNING" } },
  ];

  function signedEvent(secret: string, body: string): Record<string, unknown> {
    const signature = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
    return relayEvent({ seq: 1, eventId: "d-1", body, headers: { "x-webhook-signature": signature } });
  }

  it("delivers an event whose signature checks out", async () => {
    const body = JSON.stringify({ ok: true });
    const harness = createHarness({
      channels,
      secrets: { "ade-cursor-cloud:SIGNING": "s".repeat(40) },
      pages: [[signedEvent("s".repeat(40), body)], []],
    });
    await harness.service.pollNow();
    expect(harness.delivered).toHaveLength(1);
    expect(harness.rows()[0]?.abandoned_at).toBeNull();
  });

  it("abandons an event signed with the wrong secret", async () => {
    const body = JSON.stringify({ ok: true });
    const harness = createHarness({
      channels,
      secrets: { "ade-cursor-cloud:SIGNING": "s".repeat(40) },
      pages: [[signedEvent("wrong-secret", body)], []],
    });
    await harness.service.pollNow();
    expect(harness.delivered).toHaveLength(0);
    expect(harness.rows()[0]?.abandoned_at).toBeTruthy();
  });

  // "The manifest says check this and I cannot" has one safe reading.
  it("abandons an event when the declared secret is missing on this machine", async () => {
    const body = JSON.stringify({ ok: true });
    const harness = createHarness({ channels, pages: [[signedEvent("anything", body)], []] });
    await harness.service.pollNow();
    expect(harness.delivered).toHaveLength(0);
    expect(harness.rows()[0]?.abandoned_at).toBeTruthy();
  });

  it("refuses a malformed signature header instead of throwing", () => {
    expect(verifyPluginWebhookSignature({ secret: "k", body: "b", signature: "" })).toBe(false);
    expect(verifyPluginWebhookSignature({ secret: "k", body: "b", signature: "sha256=zzz" })).toBe(false);
    // A hex string of the wrong length must be a false, never a timingSafeEqual
    // throw inside the drain loop.
    expect(verifyPluginWebhookSignature({ secret: "k", body: "b", signature: "sha256=abcd" })).toBe(false);
    const good = createHmac("sha256", "k").update("b", "utf8").digest("hex");
    expect(verifyPluginWebhookSignature({ secret: "k", body: "b", signature: `sha256=${good.toUpperCase()}` })).toBe(true);
    expect(verifyPluginWebhookSignature({ secret: "k", body: "b", signature: good })).toBe(true);
  });
});

describe("pluginWebhookIngressService retention", () => {
  // The 2026-07 daemon wedge was an ingress table with no retention at all.
  // This one is bounded on age AND on row count.
  it("prunes every row past the age cutoff", async () => {
    const harness = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    await harness.service.pollNow();
    harness.service.ack(harness.pluginId, "d-1");

    const old = new Date(Date.now() - (PLUGIN_WEBHOOK_LEDGER_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    harness.db.run("update plugin_ingress_events set stored_at = ? where delivery_id = ?", [old, "d-1"]);
    const recent = new Date().toISOString();
    harness.db.run(
      `insert into plugin_ingress_events(
        id, project_id, plugin_id, channel, delivery_id, event_type,
        received_at, stored_at, headers_json, body, attempts, acked_at, abandoned_at
      ) values ('pending-fresh', 'project-1', 'ade-cursor-cloud', 'default', 'd-fresh', 'status', ?, ?, '{}', '{}', 0, null, null)`,
      [recent, recent],
    );

    await harness.service.pollNow();
    const ids = harness.rows().map((row) => row.delivery_id);
    expect(ids).not.toContain("d-1");
    // Older than the ledger's retention and older than anything the relay can
    // still serve, so an aged pending row goes too. A fresh one stays.
    expect(ids).toContain("d-fresh");
  });

  // The row cap is a bound on a busy plugin's history, not a way to discard a
  // backlog the plugin has not seen.
  it("evicts the oldest settled rows at the cap and never a pending one", async () => {
    const harness = createHarness();
    const stamp = (offsetMs: number): string => new Date(Date.now() - offsetMs).toISOString();
    const columns = `insert into plugin_ingress_events(
      id, project_id, plugin_id, channel, delivery_id, event_type,
      received_at, stored_at, headers_json, body, attempts, acked_at, abandoned_at
    ) values `;
    const total = PLUGIN_WEBHOOK_LEDGER_ROWS_MAX + 3;
    // sqlite parses a multi-row VALUES as a compound select, so it is chunked
    // below the 500-term ceiling rather than written as one statement.
    for (let start = 0; start < total; start += 400) {
      const rows: string[] = [];
      for (let index = start; index < Math.min(start + 400, total); index += 1) {
        const at = stamp((total - index) * 1000);
        rows.push(`('bulk-${index}', 'project-1', 'ade-cursor-cloud', 'default', 'b-${index}', 'status', '${at}', '${at}', '{}', '{}', 1, '${at}', null)`);
      }
      harness.db.raw.exec(columns + rows.join(","));
    }
    const pendingAt = stamp(total * 2000);
    harness.db.raw.exec(
      `${columns}('pending-oldest', 'project-1', 'ade-cursor-cloud', 'default', 'd-pending', 'status', '${pendingAt}', '${pendingAt}', '{}', '{}', 0, null, null)`,
    );

    await harness.service.pollNow();
    const remaining = harness.rows();
    expect(remaining.length).toBeLessThanOrEqual(PLUGIN_WEBHOOK_LEDGER_ROWS_MAX);
    // The oldest row in the table by a wide margin, and still owed an attempt.
    expect(remaining.map((row) => row.delivery_id)).toContain("d-pending");
  });
});

describe("pluginWebhookIngressService ownership and status", () => {
  it("lets exactly one drain own a plugin, and frees it on stop", async () => {
    const first = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });
    const second = createHarness({ pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []] });

    await first.service.pollNow();
    await second.service.pollNow();
    // The loser polls nothing at all — not even a registration.
    expect(second.requests).toHaveLength(0);

    first.service.stop();
    await second.service.pollNow();
    expect(second.requests.length).toBeGreaterThan(0);
  });

  it("reports channel URLs, last delivery and pending count", async () => {
    const harness = createHarness({
      channels: [
        { id: "default", label: "Default" },
        { id: "billing", label: "Billing", verify: { kind: "hmac-sha256", secretRef: "SIGNING" } },
      ],
      pages: [[relayEvent({ seq: 1, eventId: "d-1" })], []],
      deliver: () => false,
    });
    await harness.service.pollNow();
    const [status] = await harness.service.getStatus(harness.pluginId);
    expect(status?.state).toBe("ready");
    expect(status?.pendingDeliveries).toBe(1);
    expect(status?.channels.map((channel) => channel.url)).toEqual([
      pluginWebhookUrl(status!.relayBaseUrl, harness.pluginId, "default"),
      pluginWebhookUrl(status!.relayBaseUrl, harness.pluginId, "billing"),
    ]);
    // A verify channel whose secret is absent says so by name rather than
    // going quiet.
    expect(status?.channels[1]?.missingSecretRef).toBe("SIGNING");
    expect(JSON.stringify(status)).not.toContain(
      harness.secretValues.get(`${harness.pluginId}:${PLUGIN_WEBHOOK_SECRET_NAME}`)!,
    );
  });

  it("answers undeclared for a plugin that declares no channel", async () => {
    const harness = createHarness();
    const [status] = await harness.service.getStatus("some-other-plugin");
    expect(status?.state).toBe("undeclared");
    expect(status?.channels).toEqual([]);
  });

  it("resolves a URL only for a declared channel", () => {
    const harness = createHarness();
    expect(harness.service.urlFor(harness.pluginId, "default")).toContain("/plugin/ade-cursor-cloud/webhook");
    expect(harness.service.urlFor(harness.pluginId, "not-declared")).toBeNull();
  });

  it("gives the default channel a URL with no channel segment", () => {
    expect(pluginWebhookUrl("https://relay.example", "graph", "default")).toBe(
      "https://relay.example/plugin/graph/webhook",
    );
    expect(pluginWebhookUrl("https://relay.example/", "graph", "billing")).toBe(
      "https://relay.example/plugin/graph/webhook/billing",
    );
  });
});

describe("pluginWebhookIngressService failure handling", () => {
  it("re-registers after the relay forgets the registration", async () => {
    const db = createDb();
    const secretValues = new Map<string, string>();
    const urls: string[] = [];
    let eventsCalls = 0;
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url.includes("/register")) return jsonResponse({ ok: true, secretId: "secret-1" });
      eventsCalls += 1;
      if (eventsCalls === 1) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      return jsonResponse({ events: [], nextCursor: null, cursorExpired: false });
    }) as unknown as typeof fetch;

    const service = createPluginWebhookIngressService({
      db,
      projectId: "project-1",
      logger: createLogger(),
      listPlugins: () => [{ pluginId: "graph", channels: DEFAULT_CHANNELS }],
      secrets: {
        get: async (id, name) => secretValues.get(`${id}:${name}`) ?? null,
        set: async (id, name, value) => {
          secretValues.set(`${id}:${name}`, value);
        },
      },
      deliver: () => true,
      fetchImpl,
    });

    await service.pollNow();
    await service.pollNow();
    expect(urls.filter((url) => url.includes("/register"))).toHaveLength(2);
    const [status] = await service.getStatus("graph");
    expect(status?.state).toBe("ready");
    expect(status?.lastError).toBeNull();
  });

  it("records a poll failure without losing the ledger", async () => {
    const db = createDb();
    const secretValues = new Map<string, string>();
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/register")) return jsonResponse({ ok: true, secretId: "secret-1" });
      throw new Error("relay unreachable");
    }) as unknown as typeof fetch;

    const service = createPluginWebhookIngressService({
      db,
      projectId: "project-1",
      logger: createLogger(),
      listPlugins: () => [{ pluginId: "graph", channels: DEFAULT_CHANNELS }],
      secrets: {
        get: async (id, name) => secretValues.get(`${id}:${name}`) ?? null,
        set: async (id, name, value) => {
          secretValues.set(`${id}:${name}`, value);
        },
      },
      deliver: () => true,
      fetchImpl,
    });

    await service.pollNow();
    const [status] = await service.getStatus("graph");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("relay unreachable");
  });
});
