import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import {
  createCursorCloudIngressService,
  mapCursorCloudRelayEventToRecord,
  type CursorCloudIngressEventRecord,
  type CursorCloudIngressServiceDeps,
} from "./cursorCloudIngressService";
import {
  CURSOR_CLOUD_RELAY_CONFIGURED_REF,
  CURSOR_CLOUD_RELAY_SECRET_REF,
  CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY,
} from "./cursorCloudRelayConfig";

class FakeDb {
  readonly kv = new Map<string, unknown>();
  readonly ingressRows: unknown[][] = [];

  getJson<T>(key: string): T | null {
    return this.kv.has(key) ? this.kv.get(key) as T : null;
  }

  setJson(key: string, value: unknown): void {
    this.kv.set(key, value);
  }

  get<T extends Record<string, unknown>>(_sql: string, params: unknown[] = []): T | null {
    const deliveryId = params[1];
    const row = this.ingressRows.find((entry) => entry[3] === deliveryId);
    return row ? ({ id: row[0] } as unknown as T) : null;
  }

  run(sql: string, params: unknown[] = []): void {
    if (sql.includes("insert into cursor_cloud_ingress_events")) this.ingressRows.push(params);
  }
}

class FakeCredentialStore {
  readonly values = new Map<string, string>();

  getSync(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteSync(key: string): void {
    this.values.delete(key);
  }
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHarness(options: {
  fetchImpl?: typeof fetch;
  accountToken?: string | null;
} = {}) {
  const db = new FakeDb();
  const credentials = new FakeCredentialStore();
  const cursorBySource = new Map<string, string | null>();
  const dispatched: CursorCloudIngressEventRecord[] = [];
  const deps: CursorCloudIngressServiceDeps = {
    db: db as CursorCloudIngressServiceDeps["db"],
    projectId: "project-1",
    credentialStore: credentials,
    ...(options.accountToken ? { getAccountAccessToken: async () => options.accountToken ?? null } : {}),
    cursorStore: {
      get: (source) => cursorBySource.get(source) ?? null,
      set: ({ source, cursor }) => cursorBySource.set(source, cursor),
    },
    dispatch: (record) => { dispatched.push(record); },
    logger: createLogger(),
    fetchImpl: options.fetchImpl ?? vi.fn(async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch,
  };
  return {
    db,
    credentials,
    cursorBySource,
    dispatched,
    deps,
    service: createCursorCloudIngressService(deps),
  };
}

function configureReady(harness: ReturnType<typeof createHarness>, secret = "cursor-cloud-webhook-secret-32chars"): void {
  harness.db.setJson(CURSOR_CLOUD_RELAY_CONFIGURED_REF, true);
  harness.db.setJson(CURSOR_CLOUD_RELAY_SECRET_REF, CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY);
  harness.credentials.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY, secret);
}

function relayEvent(args: {
  sequence: number;
  deliveryId: string;
  payload: Record<string, unknown>;
}) {
  return {
    cursor: `seq:${args.sequence}`,
    eventId: args.deliveryId,
    eventType: "statusChange",
    status: String(args.payload.status ?? "FINISHED"),
    agentId: String(args.payload.id ?? "bc-agent-1"),
    createdAt: String(args.payload.timestamp ?? "2026-08-13T12:00:00.000Z"),
    body: JSON.stringify(args.payload),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("cursorCloudIngressService", () => {
  it("registers a >=32-char secret and persists only the secret reference in KV", async () => {
    let registeredSecret = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://ade-github-webhook-relay.arulsharma1028.workers.dev/cursor/register");
      const headers = new Headers(init?.headers);
      registeredSecret = String((JSON.parse(String(init?.body)) as { secret: string }).secret);
      expect(headers.get("authorization")).toBe(`Bearer ${registeredSecret}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl, accountToken: "clerk-account-token" });

    const status = await harness.service.setup();

    expect(status.state).toBe("ready");
    expect(registeredSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(registeredSecret.length).toBeGreaterThanOrEqual(32);
    expect(harness.credentials.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY)).toBe(registeredSecret);
    expect(harness.db.getJson(CURSOR_CLOUD_RELAY_SECRET_REF)).toBe(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY);
    expect(Array.from(harness.db.kv.values())).not.toContain(registeredSecret);
  });

  it("reuses the create-time webhook secret from the credential store", async () => {
    const existing = "create-time-webhook-secret-32chars!!";
    let registeredSecret = "";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      registeredSecret = String((JSON.parse(String(init?.body)) as { secret: string }).secret);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    harness.credentials.setSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY, existing);

    await harness.service.setup();

    expect(registeredSecret).toBe(existing);
    expect(harness.credentials.getSync(CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY)).toBe(existing);
  });

  it("polls even when no automation rules exist and dispatches FINISHED events", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.pathname).toBe("/cursor/events");
      expect(headers.get("authorization")).toBe("Bearer cursor-cloud-webhook-secret-32chars");
      expect(headers.get("x-ade-account-token")).toBe("clerk-account-token");
      return new Response(JSON.stringify({
        events: [relayEvent({
          sequence: 1,
          deliveryId: "delivery-1",
          payload: {
            event: "statusChange",
            id: "bc-agent-1",
            status: "FINISHED",
            timestamp: "2026-08-13T12:00:00.000Z",
            summary: "done",
            target: { branchName: "cursor/cloud-branch", prUrl: null, url: "https://github.com/ade/ade" },
          },
        })],
        nextCursor: "seq:1",
        cursorExpired: false,
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl, accountToken: "clerk-account-token" });
    configureReady(harness);

    await harness.service.pollNow();

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toEqual(expect.objectContaining({
      agentId: "bc-agent-1",
      status: "FINISHED",
      branchName: "cursor/cloud-branch",
      deliveryId: "delivery-1",
    }));
    expect(harness.cursorBySource.get("cursor-relay")).toBe("seq:1");
  });

  it("does not re-dispatch a replayed delivery", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      events: [relayEvent({
        sequence: 1,
        deliveryId: "delivery-1",
        payload: { id: "bc-agent-1", status: "ERROR", timestamp: "2026-08-13T12:00:00.000Z" },
      })],
      nextCursor: "seq:1",
      cursorExpired: false,
    }), { status: 200 })) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    await harness.service.pollNow();
    await harness.service.pollNow();

    expect(harness.dispatched).toHaveLength(1);
  });
});

describe("mapCursorCloudRelayEventToRecord", () => {
  it("reads agent id, status, and target branch from the Cursor payload", () => {
    const record = mapCursorCloudRelayEventToRecord({
      cursor: "seq:4",
      eventId: "wh-1",
      eventType: "statusChange",
      status: "FINISHED",
      agentId: "bc-fallback",
      createdAt: "2026-08-13T12:00:00.000Z",
      body: JSON.stringify({
        event: "statusChange",
        id: "bc-agent-9",
        status: "FINISHED",
        timestamp: "2026-08-13T12:00:01.000Z",
        summary: "shipped",
        target: { url: "https://github.com/ade/ade", branchName: "cursor/work", prUrl: "https://github.com/ade/ade/pull/9" },
      }),
    });
    expect(record).toEqual(expect.objectContaining({
      agentId: "bc-agent-9",
      status: "FINISHED",
      branchName: "cursor/work",
      prUrl: "https://github.com/ade/ade/pull/9",
      summary: "shipped",
    }));
  });
});
