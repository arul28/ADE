import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, signLinearWebhookBody, type RelayEnv } from "../src/relay";

type StoredLinearOrganization = {
  org_id: string;
  webhook_secret: string;
  registered_at: string;
  updated_at: string;
};

type StoredLinearEvent = {
  event_seq: number;
  org_id: string;
  event_id: string;
  event_type: string;
  action: string;
  received_at: string;
  body: string;
};

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeLinearD1Database,
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

class FakeLinearD1Database {
  organizations: StoredLinearOrganization[] = [];
  events: StoredLinearEvent[] = [];
  nextEventSeq = 1;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("select webhook_secret from linear_organizations")) {
      const row = this.organizations.find((entry) => entry.org_id === values[0]);
      return row ? ({ webhook_secret: row.webhook_secret } as T) : null;
    }
    if (sql.includes("select event_id from linear_events")) {
      const [organizationId, eventId] = values;
      const row = this.events.find((entry) => entry.org_id === organizationId && entry.event_id === eventId);
      return row ? ({ event_id: row.event_id } as T) : null;
    }
    if (sql.includes("select rowid as event_seq, event_id from linear_events")) {
      const [organizationId, eventId] = values;
      const row = this.events.find((entry) => entry.org_id === organizationId && entry.event_id === eventId);
      return row ? ({ event_seq: row.event_seq, event_id: row.event_id } as T) : null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (!sql.includes("from linear_events")) return [];
    const [organizationId] = values;
    let rows = this.events.filter((entry) => entry.org_id === organizationId);
    let limit = Number(values[1]);
    if (sql.includes("rowid >")) {
      const [, sequence, requestedLimit] = values;
      rows = rows.filter((entry) => entry.event_seq > Number(sequence));
      limit = Number(requestedLimit);
    }
    return [...rows]
      .sort((left, right) => right.event_seq - left.event_seq)
      .slice(0, limit)
      .map((entry) => ({
        event_seq: entry.event_seq,
        event_id: entry.event_id,
        event_type: entry.event_type,
        action: entry.action,
        received_at: entry.received_at,
        body: entry.body,
      } as T));
  }

  run(sql: string, values: unknown[]): void {
    if (sql.includes("insert into linear_organizations")) {
      const [organizationId, secret, registeredAt, updatedAt] = values.map(String);
      const existing = this.organizations.find((entry) => entry.org_id === organizationId);
      if (existing) {
        existing.webhook_secret = secret!;
        existing.updated_at = updatedAt!;
      } else {
        this.organizations.push({
          org_id: organizationId!,
          webhook_secret: secret!,
          registered_at: registeredAt!,
          updated_at: updatedAt!,
        });
      }
    }
    if (sql.includes("insert") && sql.includes("into linear_events")) {
      this.events.push({
        event_seq: this.nextEventSeq++,
        org_id: String(values[0]),
        event_id: String(values[1]),
        event_type: String(values[2]),
        action: String(values[3]),
        received_at: String(values[4]),
        body: String(values[5]),
      });
    }
    if (sql.includes("delete from linear_events")) {
      const cutoff = String(values[0]);
      this.events = this.events.filter((entry) => entry.received_at >= cutoff);
    }
  }
}

function makeEnv(): RelayEnv & { DB: FakeLinearD1Database } {
  return {
    DB: new FakeLinearD1Database(),
    GITHUB_WEBHOOK_SECRET: "github-secret",
    LINEAR_API_BASE_URL: "https://linear.test/graphql",
  } as unknown as RelayEnv & { DB: FakeLinearD1Database };
}

function stubLinearViewer(tokens: Record<string, string>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://linear.test/graphql");
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    const organizationId = tokens[authorization];
    if (!organizationId) {
      return new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: { viewer: { organization: { id: organizationId } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function registerOrganization(
  env: RelayEnv,
  args: { token?: string; secret?: string } = {},
): Promise<Response> {
  return handleRequest(new Request("https://relay.test/linear/orgs/register", {
    method: "POST",
    headers: {
      authorization: args.token ?? "lin_api_register",
      "content-type": "application/json",
    },
    body: JSON.stringify({ secret: args.secret ?? "linear-webhook-secret" }),
  }), env);
}

function linearPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "update",
    type: "Issue",
    organizationId: "org-1",
    webhookTimestamp: Date.now(),
    webhookId: "webhook-1",
    data: { id: "issue-1", identifier: "ADE-1", title: "Linear relay" },
    updatedFrom: { title: "Old title" },
    ...overrides,
  };
}

async function linearWebhookRequest(
  payload: Record<string, unknown>,
  args: { delivery?: string; secret?: string; signature?: string; contentLength?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request("https://relay.test/linear/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": args.delivery ?? "delivery-1",
      "linear-event": String(payload.type ?? "Issue"),
      "linear-signature": args.signature ?? await signLinearWebhookBody(args.secret ?? "linear-webhook-secret", body),
      ...(args.contentLength ? { "content-length": args.contentLength } : {}),
    },
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Linear webhook relay", () => {
  it("registers the viewer organization and forwards API-key authorization unchanged", async () => {
    const env = makeEnv();
    const fetchMock = stubLinearViewer({ lin_api_register_ok: "org-1" });

    const response = await registerOrganization(env, { token: "lin_api_register_ok" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizationId: "org-1" });
    expect(env.DB.organizations).toEqual([expect.objectContaining({
      org_id: "org-1",
      webhook_secret: "linear-webhook-secret",
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad Linear token during registration", async () => {
    const env = makeEnv();
    stubLinearViewer({});

    const response = await registerOrganization(env, { token: "lin_api_bad_register" });

    expect(response.status).toBe(401);
    expect(env.DB.organizations).toHaveLength(0);
  });

  it("rejects missing and overlong webhook secrets", async () => {
    const env = makeEnv();
    stubLinearViewer({ lin_api_register_secret_validation: "org-1" });
    const request = (secret: string) => handleRequest(new Request("https://relay.test/linear/orgs/register", {
      method: "POST",
      headers: {
        authorization: "lin_api_register_secret_validation",
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret }),
    }), env);

    const missing = await request("");
    const overlong = await request("s".repeat(513));

    expect(missing.status).toBe(400);
    expect(overlong.status).toBe(400);
    expect(env.DB.organizations).toHaveLength(0);
  });

  it("stores one valid delivery and deduplicates a redelivery", async () => {
    const env = makeEnv();
    stubLinearViewer({ lin_api_ingest_dedup: "org-1" });
    await registerOrganization(env, { token: "lin_api_ingest_dedup" });
    const payload = linearPayload();

    const first = await handleRequest(await linearWebhookRequest(payload), env);
    const duplicate = await handleRequest(await linearWebhookRequest(payload), env);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false, eventId: "delivery-1" });
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, eventId: "delivery-1" });
    expect(env.DB.events).toHaveLength(1);
    expect(env.DB.events[0]).toEqual(expect.objectContaining({
      org_id: "org-1",
      event_id: "delivery-1",
      event_type: "Issue",
      action: "update",
      body: JSON.stringify(payload),
    }));
  });

  it("rejects a bad signature", async () => {
    const env = makeEnv();
    stubLinearViewer({ lin_api_ingest_bad_sig: "org-1" });
    await registerOrganization(env, { token: "lin_api_ingest_bad_sig" });

    const response = await handleRequest(
      await linearWebhookRequest(linearPayload(), { signature: "0".repeat(64) }),
      env,
    );

    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects a stale webhook timestamp", async () => {
    const env = makeEnv();
    stubLinearViewer({ lin_api_ingest_stale: "org-1" });
    await registerOrganization(env, { token: "lin_api_ingest_stale" });

    const response = await handleRequest(
      await linearWebhookRequest(linearPayload({ webhookTimestamp: Date.now() - 60_001 })),
      env,
    );

    expect(response.status).toBe(401);
    expect(env.DB.events).toHaveLength(0);
  });

  it("acknowledges an unregistered organization without storing the payload", async () => {
    const env = makeEnv();

    const response = await handleRequest(
      await linearWebhookRequest(linearPayload({ organizationId: "org-unregistered" })),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: "unregistered" });
    expect(env.DB.events).toHaveLength(0);
  });

  it("rejects an oversized payload before storing it", async () => {
    const env = makeEnv();

    const response = await handleRequest(
      await linearWebhookRequest(linearPayload(), { contentLength: String(1024 * 1024 + 1) }),
      env,
    );

    expect(response.status).toBe(413);
    expect(env.DB.events).toHaveLength(0);
  });

  it("enforces read auth, rejects a token from another organization, and pages by sequence", async () => {
    const env = makeEnv();
    const fetchMock = stubLinearViewer({
      "Bearer lin_oauth_read_org_1": "org-1",
      "Bearer lin_oauth_read_org_2": "org-2",
    });
    await registerOrganization(env, { token: "Bearer lin_oauth_read_org_1" });
    for (let index = 1; index <= 3; index += 1) {
      await handleRequest(
        await linearWebhookRequest(linearPayload({ data: { id: `issue-${index}` } }), { delivery: `delivery-${index}` }),
        env,
      );
    }

    const missingAuth = await handleRequest(
      new Request("https://relay.test/linear/orgs/org-1/events"),
      env,
    );
    const wrongOrg = await handleRequest(
      new Request("https://relay.test/linear/orgs/org-1/events", {
        headers: { authorization: "Bearer lin_oauth_read_org_2" },
      }),
      env,
    );
    const page = await handleRequest(
      new Request("https://relay.test/linear/orgs/org-1/events?after=seq:1&limit=2", {
        headers: { authorization: "Bearer lin_oauth_read_org_1" },
      }),
      env,
    );
    const expired = await handleRequest(
      new Request("https://relay.test/linear/orgs/org-1/events?after=delivery-pruned&limit=1", {
        headers: { authorization: "Bearer lin_oauth_read_org_1" },
      }),
      env,
    );

    expect(missingAuth.status).toBe(401);
    expect(wrongOrg.status).toBe(403);
    expect(page.status).toBe(200);
    const body = await page.json() as {
      events: Array<{ eventId: string; cursor: string; body: string }>;
      nextCursor: string;
      cursorExpired: boolean;
    };
    expect(body.events.map((event) => event.eventId)).toEqual(["delivery-3", "delivery-2"]);
    expect(body.events[0]?.body).toContain("issue-3");
    expect(body.nextCursor).toBe("seq:3");
    expect(body.cursorExpired).toBe(false);
    expect(await expired.json()).toEqual(expect.objectContaining({
      cursorExpired: true,
      nextCursor: "seq:3",
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prunes Linear events beyond the configured retention window after a write", async () => {
    const env = makeEnv();
    env.EVENT_RETENTION_DAYS = "1";
    stubLinearViewer({ lin_api_retention: "org-1" });
    await registerOrganization(env, { token: "lin_api_retention" });
    env.DB.events.push({
      event_seq: env.DB.nextEventSeq++,
      org_id: "org-1",
      event_id: "delivery-old",
      event_type: "Issue",
      action: "update",
      received_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      body: JSON.stringify(linearPayload()),
    });

    await handleRequest(
      await linearWebhookRequest(linearPayload(), { delivery: "delivery-current" }),
      env,
    );

    expect(env.DB.events.map((event) => event.event_id)).toEqual(["delivery-current"]);
  });
});
