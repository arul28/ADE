import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, signCursorWebhookBody, type RelayEnv } from "../src/relay";

type StoredCursorSecret = {
  id: string;
  webhook_secret: string;
  account_id: string | null;
  registered_at: string;
  updated_at: string;
  unlinked_account_id: string | null;
};

type StoredCursorEvent = {
  event_seq: number;
  event_id: string;
  event_type: string;
  status: string;
  agent_id: string;
  received_at: string;
  body: string;
  account_id: string | null;
  secret_id: string | null;
};

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeCursorD1Database,
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

class FakeCursorD1Database {
  secrets: StoredCursorSecret[] = [];
  events: StoredCursorEvent[] = [];
  nextEventSeq = 1;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("select event_id from cursor_events")) {
      const row = this.events.find((entry) => entry.event_id === values[0]);
      return row ? ({ event_id: row.event_id } as T) : null;
    }
    if (sql.includes("select rowid as event_seq, event_id from cursor_events")) {
      const eventId = values[values.length - 1];
      const row = this.events.find((entry) => entry.event_id === eventId);
      return row ? ({ event_seq: row.event_seq, event_id: row.event_id } as T) : null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (sql.includes("from cursor_webhook_secrets") && sql.includes("select id, webhook_secret")) {
      return this.secrets.map((entry) => ({
        id: entry.id,
        webhook_secret: entry.webhook_secret,
        account_id: entry.account_id,
      } as T));
    }
    if (!sql.includes("from cursor_events")) return [];
    let rows = [...this.events];
    let limit = Number(values[values.length - 1]);
    if (sql.includes("secret_id = ?")) {
      const secretId = String(values[0]);
      rows = rows.filter((entry) => entry.secret_id === secretId);
    }
    if (sql.includes("account_id = ?")) {
      const accountId = String(values[0]);
      rows = rows.filter((entry) => entry.account_id === accountId);
    }
    if (sql.includes("rowid >")) {
      const sequence = Number(values[values.length - 2]);
      rows = rows.filter((entry) => entry.event_seq > sequence);
      limit = Number(values[values.length - 1]);
    }
    const ascending = /order by rowid asc/i.test(sql);
    return [...rows]
      .sort((left, right) => (ascending ? left.event_seq - right.event_seq : right.event_seq - left.event_seq))
      .slice(0, limit)
      .map((entry) => ({
        event_seq: entry.event_seq,
        event_id: entry.event_id,
        event_type: entry.event_type,
        status: entry.status,
        agent_id: entry.agent_id,
        received_at: entry.received_at,
        body: entry.body,
      } as T));
  }

  run(sql: string, values: unknown[]): void {
    if (sql.includes("insert into cursor_webhook_secrets")) {
      const [id, secret, accountId, registeredAt, updatedAt] = values;
      const existing = this.secrets.find((entry) => entry.id === String(id));
      if (existing) {
        existing.webhook_secret = String(secret);
        existing.updated_at = String(updatedAt);
        if (accountId != null) existing.account_id = String(accountId);
      } else {
        this.secrets.push({
          id: String(id),
          webhook_secret: String(secret),
          account_id: accountId == null ? null : String(accountId),
          registered_at: String(registeredAt),
          updated_at: String(updatedAt),
          unlinked_account_id: null,
        });
      }
    }
    if (sql.includes("insert") && sql.includes("into cursor_events")) {
      this.events.push({
        event_seq: this.nextEventSeq++,
        event_id: String(values[0]),
        event_type: String(values[1]),
        status: String(values[2]),
        agent_id: String(values[3]),
        received_at: String(values[4]),
        body: String(values[5]),
        account_id: values[6] == null ? null : String(values[6]),
        secret_id: values[7] == null ? null : String(values[7]),
      });
    }
    if (sql.includes("delete from cursor_events")) {
      const cutoff = String(values[0]);
      this.events = this.events.filter((entry) => entry.received_at >= cutoff);
    }
    if (sql.includes("update cursor_events") && sql.includes("set account_id")) {
      const accountId = String(values[0]);
      const secretId = String(values[1]);
      for (const event of this.events) {
        if (event.secret_id === secretId && event.account_id == null) event.account_id = accountId;
      }
    }
  }
}

function makeEnv(): RelayEnv & { DB: FakeCursorD1Database } {
  return {
    DB: new FakeCursorD1Database(),
    GITHUB_WEBHOOK_SECRET: "github-secret",
  } as unknown as RelayEnv & { DB: FakeCursorD1Database };
}

const WEBHOOK_SECRET = "cursor-cloud-webhook-secret-32chars";

function cursorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "statusChange",
    timestamp: new Date().toISOString(),
    id: "bc-agent-1",
    status: "FINISHED",
    target: {
      url: "https://github.com/ade/ade",
      branchName: "cursor/cloud-branch",
      prUrl: "https://github.com/ade/ade/pull/1",
    },
    summary: "Cloud agent finished",
    ...overrides,
  };
}

async function registerSecret(env: RelayEnv, secret = WEBHOOK_SECRET): Promise<Response> {
  return handleRequest(new Request("https://relay.test/cursor/register", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ secret }),
  }), env);
}

async function cursorWebhookRequest(
  payload: Record<string, unknown>,
  args: { delivery?: string; secret?: string; signature?: string; contentLength?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = args.signature
    ?? await signCursorWebhookBody(args.secret ?? WEBHOOK_SECRET, body);
  return new Request("https://relay.test/cursor/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Cursor-Agent-Webhook/1.0",
      "x-webhook-event": "statusChange",
      "x-webhook-id": args.delivery ?? "delivery-1",
      "x-webhook-signature": signature,
      ...(args.contentLength ? { "content-length": args.contentLength } : {}),
    },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cursor Cloud webhook relay", () => {
  it("registers a webhook secret that proves possession via Bearer", async () => {
    const env = makeEnv();
    const response = await registerSecret(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true }));
    expect(env.DB.secrets).toEqual([expect.objectContaining({
      webhook_secret: WEBHOOK_SECRET,
    })]);
  });

  it("rejects missing, short, and overlong webhook secrets", async () => {
    const env = makeEnv();
    const request = (secret: string) => handleRequest(new Request("https://relay.test/cursor/register", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret || "placeholder-secret-value-32chars!!"}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret }),
    }), env);

    expect((await request("")).status).toBe(400);
    expect((await request("short")).status).toBe(400);
    expect((await request("s".repeat(513))).status).toBe(400);
    expect(env.DB.secrets).toHaveLength(0);
  });

  it("rejects registration without proving the secret", async () => {
    const env = makeEnv();
    const response = await handleRequest(new Request("https://relay.test/cursor/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: WEBHOOK_SECRET }),
    }), env);
    expect(response.status).toBe(401);
    expect(env.DB.secrets).toHaveLength(0);
  });

  it("stores one valid delivery and deduplicates a redelivery", async () => {
    const env = makeEnv();
    await registerSecret(env);
    const payload = cursorPayload();

    const first = await handleRequest(await cursorWebhookRequest(payload), env);
    const duplicate = await handleRequest(await cursorWebhookRequest(payload), env);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false, eventId: "delivery-1" });
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, eventId: "delivery-1" });
    expect(env.DB.events).toHaveLength(1);
    expect(env.DB.events[0]).toEqual(expect.objectContaining({
      event_id: "delivery-1",
      event_type: "statusChange",
      status: "FINISHED",
      agent_id: "bc-agent-1",
      body: JSON.stringify(payload),
    }));
  });

  it("rejects a bad HMAC signature with 401", async () => {
    const env = makeEnv();
    await registerSecret(env);

    const response = await handleRequest(
      await cursorWebhookRequest(cursorPayload(), { signature: "sha256=" + "0".repeat(64) }),
      env,
    );

    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects a missing signature with 401", async () => {
    const env = makeEnv();
    await registerSecret(env);
    const response = await handleRequest(new Request("https://relay.test/cursor/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-id": "delivery-1" },
      body: JSON.stringify(cursorPayload()),
    }), env);
    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects a stale webhook timestamp", async () => {
    const env = makeEnv();
    await registerSecret(env);
    const response = await handleRequest(
      await cursorWebhookRequest(cursorPayload({
        timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      })),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects an oversized payload before storing it", async () => {
    const env = makeEnv();
    const response = await handleRequest(
      await cursorWebhookRequest(cursorPayload(), { contentLength: String(1024 * 1024 + 1) }),
      env,
    );
    expect(response.status).toBe(413);
    expect(env.DB.events).toHaveLength(0);
  });

  it("accepts env-configured secrets without prior registration", async () => {
    const env = makeEnv();
    (env as { CURSOR_WEBHOOK_SECRET?: string }).CURSOR_WEBHOOK_SECRET = "env-cursor-secret-value-32chars!!";
    const response = await handleRequest(
      await cursorWebhookRequest(cursorPayload(), {
        delivery: "env-delivery-1",
        secret: "env-cursor-secret-value-32chars!!",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: false, eventId: "env-delivery-1" });
    expect(env.DB.events).toHaveLength(1);
  });

  it("enforces read auth and pages by sequence oldest-first", async () => {
    const env = makeEnv();
    await registerSecret(env);
    for (let index = 1; index <= 3; index += 1) {
      await handleRequest(
        await cursorWebhookRequest(cursorPayload({ id: `bc-agent-${index}` }), { delivery: `delivery-${index}` }),
        env,
      );
    }

    const missingAuth = await handleRequest(new Request("https://relay.test/cursor/events"), env);
    const page = await handleRequest(
      new Request("https://relay.test/cursor/events?after=seq:1&limit=2", {
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
      }),
      env,
    );
    const expired = await handleRequest(
      new Request("https://relay.test/cursor/events?after=delivery-pruned&limit=1", {
        headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
      }),
      env,
    );

    expect(missingAuth.status).toBe(401);
    expect(page.status).toBe(200);
    const body = await page.json() as {
      events: Array<{ eventId: string; cursor: string; body: string }>;
      nextCursor: string;
      cursorExpired: boolean;
    };
    expect(body.events.map((event) => event.eventId)).toEqual(["delivery-2", "delivery-3"]);
    expect(body.nextCursor).toBe("seq:3");
    expect(body.cursorExpired).toBe(false);
    expect(await expired.json()).toEqual(expect.objectContaining({
      cursorExpired: true,
      nextCursor: "seq:3",
    }));
  });

  it("drains a backlog larger than one page without skipping events", async () => {
    const env = makeEnv();
    await registerSecret(env);
    for (let index = 1; index <= 3; index += 1) {
      await handleRequest(
        await cursorWebhookRequest(cursorPayload({ id: `bc-agent-${index}` }), { delivery: `delivery-${index}` }),
        env,
      );
    }

    const seen: string[] = [];
    let cursor = "seq:0";
    for (let page = 0; page < 5 && cursor; page += 1) {
      const response = await handleRequest(
        new Request(`https://relay.test/cursor/events?after=${cursor}&limit=1`, {
          headers: { authorization: `Bearer ${WEBHOOK_SECRET}` },
        }),
        env,
      );
      const body = await response.json() as { events: Array<{ eventId: string }>; nextCursor: string | null };
      if (!body.events.length) break;
      seen.push(...body.events.map((event) => event.eventId));
      cursor = body.nextCursor ?? "";
    }

    expect(seen).toEqual(["delivery-1", "delivery-2", "delivery-3"]);
  });

  it("prunes Cursor events beyond the configured retention window after a write", async () => {
    const env = makeEnv();
    env.EVENT_RETENTION_DAYS = "1";
    await registerSecret(env);
    env.DB.events.push({
      event_seq: env.DB.nextEventSeq++,
      event_id: "delivery-old",
      event_type: "statusChange",
      status: "FINISHED",
      agent_id: "bc-old",
      received_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      body: JSON.stringify(cursorPayload()),
      account_id: null,
      secret_id: env.DB.secrets[0]?.id ?? null,
    });

    await handleRequest(
      await cursorWebhookRequest(cursorPayload(), { delivery: "delivery-current" }),
      env,
    );

    expect(env.DB.events.map((event) => event.event_id)).toEqual(["delivery-current"]);
  });
});
