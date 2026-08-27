import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, signPluginWebhookBody, PLUGIN_WEBHOOK_STORED_HEADERS, type RelayEnv } from "../src/relay";

type StoredPluginSecret = {
  id: string;
  plugin_id: string;
  webhook_secret: string;
  account_id: string | null;
  registered_at: string;
  updated_at: string;
  unlinked_account_id: string | null;
};

type StoredPluginEvent = {
  event_seq: number;
  event_id: string;
  plugin_id: string;
  channel: string;
  event_type: string;
  received_at: string;
  headers: string;
  body: string;
  account_id: string | null;
  secret_id: string | null;
};

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakePluginD1Database,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first<T>(this.sql, this.values);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql, this.values) };
  }

  async run(): Promise<{ success: boolean }> {
    this.db.run(this.sql, this.values);
    return { success: true };
  }
}

/**
 * Minimal stand-in for the two plugin tables. It only understands the exact
 * statements relay.ts issues, which is the point: if a query's shape drifts
 * (a missing plugin_id predicate, a reordered binding) the fake stops matching
 * and the isolation tests below fail loudly instead of passing by accident.
 */
class FakePluginD1Database {
  secrets: StoredPluginSecret[] = [];
  events: StoredPluginEvent[] = [];
  nextEventSeq = 1;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("select rowid as event_seq, event_id from plugin_events")) {
      const pluginId = String(values[0]);
      const eventId = values[values.length - 1];
      const row = this.events.find((entry) => entry.plugin_id === pluginId && entry.event_id === eventId);
      return row ? ({ event_seq: row.event_seq, event_id: row.event_id } as T) : null;
    }
    if (sql.includes("select event_id from plugin_events")) {
      const row = this.events.find((entry) => entry.event_id === values[0]);
      return row ? ({ event_id: row.event_id } as T) : null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (sql.includes("from plugin_webhook_secrets")) {
      const pluginId = String(values[0]);
      return this.secrets
        .filter((entry) => entry.plugin_id === pluginId)
        .map((entry) => ({
          id: entry.id,
          webhook_secret: entry.webhook_secret,
          account_id: entry.account_id,
        } as T));
    }
    if (!sql.includes("from plugin_events")) return [];
    let rows = this.events.filter((entry) => entry.plugin_id === String(values[0]));
    if (sql.includes("secret_id = ?")) {
      const secretId = String(values[1]);
      rows = rows.filter((entry) => entry.secret_id === secretId);
    }
    if (sql.includes("account_id = ?")) {
      const accountId = String(values[1]);
      rows = rows.filter((entry) => entry.account_id === accountId);
    }
    const limit = Number(values[values.length - 1]);
    if (sql.includes("rowid >")) {
      const sequence = Number(values[values.length - 2]);
      rows = rows.filter((entry) => entry.event_seq > sequence);
    }
    const ascending = /order by rowid asc/i.test(sql);
    return [...rows]
      .sort((left, right) => (ascending ? left.event_seq - right.event_seq : right.event_seq - left.event_seq))
      .slice(0, limit)
      .map((entry) => ({
        event_seq: entry.event_seq,
        event_id: entry.event_id,
        channel: entry.channel,
        event_type: entry.event_type,
        received_at: entry.received_at,
        headers: entry.headers,
        body: entry.body,
      } as T));
  }

  run(sql: string, values: unknown[]): void {
    if (sql.includes("insert into plugin_webhook_secrets")) {
      const [id, pluginId, secret, accountId, registeredAt, updatedAt] = values;
      const existing = this.secrets.find((entry) => entry.id === String(id));
      if (existing) {
        existing.webhook_secret = String(secret);
        existing.updated_at = String(updatedAt);
        if (accountId != null) existing.account_id = String(accountId);
      } else {
        this.secrets.push({
          id: String(id),
          plugin_id: String(pluginId),
          webhook_secret: String(secret),
          account_id: accountId == null ? null : String(accountId),
          registered_at: String(registeredAt),
          updated_at: String(updatedAt),
          unlinked_account_id: null,
        });
      }
    }
    if (sql.includes("insert") && sql.includes("into plugin_events")) {
      this.events.push({
        event_seq: this.nextEventSeq++,
        event_id: String(values[0]),
        plugin_id: String(values[1]),
        channel: String(values[2]),
        event_type: String(values[3]),
        received_at: String(values[4]),
        headers: String(values[5]),
        body: String(values[6]),
        account_id: values[7] == null ? null : String(values[7]),
        secret_id: values[8] == null ? null : String(values[8]),
      });
    }
    if (sql.includes("delete from plugin_events")) {
      const cutoff = String(values[0]);
      this.events = this.events.filter((entry) => entry.received_at >= cutoff);
    }
    if (sql.includes("update plugin_events") && sql.includes("set account_id = ?")) {
      const accountId = String(values[0]);
      const secretId = String(values[1]);
      for (const event of this.events) {
        if (event.secret_id === secretId && event.account_id == null) event.account_id = accountId;
      }
    }
  }
}

function makeEnv(): RelayEnv & { DB: FakePluginD1Database } {
  return {
    DB: new FakePluginD1Database(),
    GITHUB_WEBHOOK_SECRET: "github-secret",
  } as unknown as RelayEnv & { DB: FakePluginD1Database };
}

const ALPHA_SECRET = "alpha-plugin-webhook-secret-32chars";
const BETA_SECRET = "beta-plugin-webhook-secret-32chars!";

function pluginPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "issue.created",
    timestamp: new Date().toISOString(),
    id: "issue-1",
    ...overrides,
  };
}

async function register(
  env: RelayEnv,
  pluginId: string,
  secret: string,
  init: { authorize?: boolean } = {},
): Promise<Response> {
  return handleRequest(new Request(`https://relay.test/plugin/${pluginId}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.authorize === false ? {} : { authorization: `Bearer ${secret}` }),
    },
    body: JSON.stringify({ secret }),
  }), env);
}

async function webhookRequest(args: {
  pluginId: string;
  channel?: string;
  secret?: string;
  payload?: Record<string, unknown>;
  delivery?: string;
  signature?: string | null;
  bearer?: string;
  contentLength?: string;
  extraHeaders?: Record<string, string>;
}): Promise<Request> {
  const body = JSON.stringify(args.payload ?? pluginPayload());
  const path = args.channel
    ? `https://relay.test/plugin/${args.pluginId}/webhook/${args.channel}`
    : `https://relay.test/plugin/${args.pluginId}/webhook`;
  const signature = args.signature === null
    ? null
    : args.signature ?? await signPluginWebhookBody(args.secret ?? ALPHA_SECRET, body);
  return new Request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-event": "issue.created",
      "x-webhook-id": args.delivery ?? "delivery-1",
      ...(signature ? { "x-webhook-signature": signature } : {}),
      ...(args.bearer ? { authorization: `Bearer ${args.bearer}` } : {}),
      ...(args.contentLength ? { "content-length": args.contentLength } : {}),
      ...(args.extraHeaders ?? {}),
    },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin ingress registration", () => {
  it("rejects a registration that proves neither an account nor the secret", async () => {
    const env = makeEnv();
    const response = await register(env, "alpha", ALPHA_SECRET, { authorize: false });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(env.DB.secrets).toHaveLength(0);
  });

  it("rejects missing, short, and overlong secrets", async () => {
    const env = makeEnv();
    expect((await register(env, "alpha", "")).status).toBe(400);
    expect((await register(env, "alpha", "short")).status).toBe(400);
    expect((await register(env, "alpha", "s".repeat(513))).status).toBe(400);
    expect(env.DB.secrets).toHaveLength(0);
  });

  it("returns a digest-keyed secretId and re-registering is idempotent", async () => {
    const env = makeEnv();
    const first = await register(env, "alpha", ALPHA_SECRET);
    const second = await register(env, "alpha", ALPHA_SECRET);

    const firstBody = await first.json() as { ok: boolean; secretId: string };
    const secondBody = await second.json() as { ok: boolean; secretId: string };
    expect(first.status).toBe(200);
    expect(firstBody.ok).toBe(true);
    expect(firstBody.secretId).toMatch(/^secret:[0-9a-f]{64}$/);
    expect(secondBody.secretId).toBe(firstBody.secretId);
    expect(env.DB.secrets).toHaveLength(1);
    expect(env.DB.secrets[0]).toEqual(expect.objectContaining({
      plugin_id: "alpha",
      webhook_secret: ALPHA_SECRET,
    }));
  });
});

describe("plugin ingress deliveries", () => {
  it("stores a signed delivery under the default channel", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const payload = pluginPayload();

    const response = await handleRequest(await webhookRequest({ pluginId: "alpha", payload }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: false, eventId: "delivery-1" });
    expect(env.DB.events).toHaveLength(1);
    expect(env.DB.events[0]).toEqual(expect.objectContaining({
      event_id: "delivery-1",
      plugin_id: "alpha",
      channel: "default",
      event_type: "issue.created",
      body: JSON.stringify(payload),
      secret_id: env.DB.secrets[0]?.id,
    }));
  });

  it("routes a channel segment onto the stored row", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const response = await handleRequest(
      await webhookRequest({ pluginId: "alpha", channel: "status", delivery: "delivery-status" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(env.DB.events[0]?.channel).toBe("status");
  });

  it("rejects a signature produced with the wrong secret", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const response = await handleRequest(
      await webhookRequest({ pluginId: "alpha", secret: "some-other-secret-value-32chars!!!!" }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "signature mismatch" });
    expect(env.DB.events).toHaveLength(0);
  });

  it("never lets one plugin's secret authenticate another plugin's delivery", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    await register(env, "beta", BETA_SECRET);

    const signed = await handleRequest(
      await webhookRequest({ pluginId: "beta", secret: ALPHA_SECRET, delivery: "cross-signed" }),
      env,
    );
    const bearer = await handleRequest(
      await webhookRequest({ pluginId: "beta", signature: null, bearer: ALPHA_SECRET, delivery: "cross-bearer" }),
      env,
    );

    expect(signed.status).toBe(401);
    expect(bearer.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("accepts a bearer-presented secret when the provider cannot sign bodies", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const response = await handleRequest(
      await webhookRequest({ pluginId: "alpha", signature: null, bearer: ALPHA_SECRET, delivery: "bearer-1" }),
      env,
    );
    expect(response.status).toBe(200);
    expect(env.DB.events).toHaveLength(1);
  });

  it("deduplicates a redelivery of the same event id", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const payload = pluginPayload();

    const first = await handleRequest(await webhookRequest({ pluginId: "alpha", payload }), env);
    const duplicate = await handleRequest(await webhookRequest({ pluginId: "alpha", payload }), env);

    expect(await first.json()).toEqual({ ok: true, duplicate: false, eventId: "delivery-1" });
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, eventId: "delivery-1" });
    expect(env.DB.events).toHaveLength(1);
  });

  it("rejects a delivery whose body timestamp is outside the replay window", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const response = await handleRequest(
      await webhookRequest({
        pluginId: "alpha",
        payload: pluginPayload({ timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString() }),
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "stale webhook timestamp" });
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects an oversized payload before reading it", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    const response = await handleRequest(
      await webhookRequest({ pluginId: "alpha", contentLength: String(1024 * 1024 + 1) }),
      env,
    );
    expect(response.status).toBe(413);
    expect(env.DB.events).toHaveLength(0);
  });

  it("stores only allowlisted headers", async () => {
    const env = makeEnv();
    await register(env, "alpha", ALPHA_SECRET);
    await handleRequest(
      await webhookRequest({
        pluginId: "alpha",
        extraHeaders: {
          "x-request-id": "req-42",
          "x-plugin-private-header": "should-not-persist",
          cookie: "session=should-not-persist",
        },
      }),
      env,
    );

    const stored = JSON.parse(env.DB.events[0]?.headers ?? "{}") as Record<string, string>;
    expect(stored["x-request-id"]).toBe("req-42");
    expect(stored["x-webhook-event"]).toBe("issue.created");
    expect(stored["x-plugin-private-header"]).toBeUndefined();
    expect(stored.cookie).toBeUndefined();
    expect(Object.keys(stored).every((name) => PLUGIN_WEBHOOK_STORED_HEADERS.includes(name))).toBe(true);
  });
});

describe("plugin ingress event drain", () => {
  async function seed(env: RelayEnv & { DB: FakePluginD1Database }): Promise<void> {
    await register(env, "alpha", ALPHA_SECRET);
    await register(env, "beta", BETA_SECRET);
    for (let index = 1; index <= 3; index += 1) {
      await handleRequest(
        await webhookRequest({ pluginId: "alpha", delivery: `alpha-${index}` }),
        env,
      );
    }
    await handleRequest(
      await webhookRequest({ pluginId: "beta", secret: BETA_SECRET, delivery: "beta-1" }),
      env,
    );
  }

  it("requires authorization", async () => {
    const env = makeEnv();
    await seed(env);
    const response = await handleRequest(new Request("https://relay.test/plugin/alpha/events"), env);
    expect(response.status).toBe(401);
  });

  it("scopes a bearer read to the plugin that registered the secret", async () => {
    const env = makeEnv();
    await seed(env);

    const own = await handleRequest(new Request("https://relay.test/plugin/alpha/events", {
      headers: { authorization: `Bearer ${ALPHA_SECRET}` },
    }), env);
    const foreign = await handleRequest(new Request("https://relay.test/plugin/beta/events", {
      headers: { authorization: `Bearer ${ALPHA_SECRET}` },
    }), env);

    const ownBody = await own.json() as { events: Array<{ eventId: string; channel: string }> };
    expect(own.status).toBe(200);
    expect(ownBody.events.map((event) => event.eventId).sort()).toEqual(["alpha-1", "alpha-2", "alpha-3"]);
    expect(foreign.status).toBe(401);
  });

  it("pages ascending by sequence cursor and reports an expired anchor", async () => {
    const env = makeEnv();
    await seed(env);

    const page = await handleRequest(new Request("https://relay.test/plugin/alpha/events?after=seq:1&limit=2", {
      headers: { authorization: `Bearer ${ALPHA_SECRET}` },
    }), env);
    const expired = await handleRequest(new Request("https://relay.test/plugin/alpha/events?after=alpha-pruned&limit=1", {
      headers: { authorization: `Bearer ${ALPHA_SECRET}` },
    }), env);

    const body = await page.json() as {
      events: Array<{ eventId: string; cursor: string; channel: string; headers: Record<string, string>; body: string }>;
      nextCursor: string;
      cursorExpired: boolean;
    };
    expect(body.events.map((event) => event.eventId)).toEqual(["alpha-2", "alpha-3"]);
    expect(body.events[0]?.cursor).toBe("seq:2");
    expect(body.events[0]?.channel).toBe("default");
    expect(body.events[0]?.headers["x-webhook-id"]).toBe("alpha-2");
    expect(body.nextCursor).toBe("seq:3");
    expect(body.cursorExpired).toBe(false);
    expect(await expired.json()).toEqual(expect.objectContaining({ cursorExpired: true }));
  });

  it("drains a backlog larger than one page without skipping events", async () => {
    const env = makeEnv();
    await seed(env);

    const seen: string[] = [];
    let cursor = "seq:0";
    for (let page = 0; page < 5 && cursor; page += 1) {
      const response = await handleRequest(
        new Request(`https://relay.test/plugin/alpha/events?after=${cursor}&limit=1`, {
          headers: { authorization: `Bearer ${ALPHA_SECRET}` },
        }),
        env,
      );
      const body = await response.json() as { events: Array<{ eventId: string }>; nextCursor: string | null };
      if (!body.events.length) break;
      seen.push(...body.events.map((event) => event.eventId));
      cursor = body.nextCursor ?? "";
    }

    expect(seen).toEqual(["alpha-1", "alpha-2", "alpha-3"]);
  });
});

describe("plugin ingress routing", () => {
  it("404s a malformed plugin id or channel instead of reaching a handler", async () => {
    const env = makeEnv();
    const badPlugin = await handleRequest(await webhookRequest({ pluginId: "BAD_ID" }), env);
    const badChannel = await handleRequest(await webhookRequest({ pluginId: "alpha", channel: "Bad_Channel" }), env);
    const unknownLeaf = await handleRequest(new Request("https://relay.test/plugin/alpha/nope"), env);

    expect(badPlugin.status).toBe(404);
    expect(badChannel.status).toBe(404);
    expect(unknownLeaf.status).toBe(404);
    expect(env.DB.events).toHaveLength(0);
  });

  it("leaves the legacy cursor routes reachable", async () => {
    const env = makeEnv();
    // The cursor handler answers 401 for an unauthenticated read; a 404 here
    // would mean the plugin route helper swallowed the path.
    const cursorEvents = await handleRequest(new Request("https://relay.test/cursor/events"), env);
    expect(cursorEvents.status).toBe(401);
  });
});
