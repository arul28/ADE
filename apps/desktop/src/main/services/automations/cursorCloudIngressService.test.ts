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
  CURSOR_CLOUD_RELAY_LAST_ERROR_REF,
  CURSOR_CLOUD_RELAY_SECRET_REF,
  CURSOR_CLOUD_WEBHOOK_SECRET_CREDENTIAL_KEY,
} from "./cursorCloudRelayConfig";

class FakeDb {
  readonly kv = new Map<string, unknown>();
  readonly ingressRows: unknown[][] = [];
  /**
   * Statements attempted after `close`, which must stay at zero once the
   * service is stopped. The real store throws "database is not open" here, and
   * a throw from a detached poll ends the process instead of failing a call.
   */
  accessesAfterClose = 0;
  private open = true;

  close(): void {
    this.open = false;
  }

  private assertOpen(): void {
    if (this.open) return;
    this.accessesAfterClose += 1;
    throw new Error("database is not open");
  }

  getJson<T>(key: string): T | null {
    this.assertOpen();
    return this.kv.has(key) ? this.kv.get(key) as T : null;
  }

  setJson(key: string, value: unknown): void {
    this.assertOpen();
    this.kv.set(key, value);
  }

  get<T extends Record<string, unknown>>(_sql: string, params: unknown[] = []): T | null {
    this.assertOpen();
    const deliveryId = params[1];
    const row = this.ingressRows.find((entry) => entry[3] === deliveryId);
    return row ? ({ id: row[0] } as unknown as T) : null;
  }

  run(sql: string, params: unknown[] = []): void {
    this.assertOpen();
    if (sql.includes("insert into cursor_cloud_ingress_events")) this.ingressRows.push(params);
  }
}

/** A gate that lets a test hold a poll open across `stop` and the store close. */
function createFetchGate() {
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    release: () => release(),
    onFetch: async () => {
      reached();
      await held;
    },
  };
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
  it("skips every write and never rejects when the store closes mid-poll", async () => {
    // The reported crash: the headless CLI runtime opens this service per
    // command, `start` polls immediately, and the command finishes while that
    // poll is still awaiting the relay. `stop` then runs and the database
    // closes, so the poll's own error handler wrote to a closed store and the
    // resulting rejection had no owner -- `ade plugin doctor` exited 1 and
    // printed nothing.
    const gate = createFetchGate();
    const fetchImpl = vi.fn(async () => {
      await gate.onFetch();
      throw new Error("relay unreachable");
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    const polling = harness.service.pollNow();
    await gate.entered;
    harness.service.stop();
    harness.db.close();
    gate.release();

    await expect(polling).resolves.toBeUndefined();
    expect(harness.db.accessesAfterClose).toBe(0);
    expect(harness.db.kv.has(CURSOR_CLOUD_RELAY_LAST_ERROR_REF)).toBe(false);
  });

  it("does not persist, dispatch, or acknowledge a page that arrives after stop", async () => {
    const gate = createFetchGate();
    const fetchImpl = vi.fn(async () => {
      await gate.onFetch();
      return new Response(JSON.stringify({
        events: [relayEvent({
          sequence: 1,
          deliveryId: "delivery-late",
          payload: { id: "bc-agent-late", status: "FINISHED", timestamp: "2026-08-13T12:00:00.000Z" },
        })],
        nextCursor: "seq:1",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    const polling = harness.service.pollNow();
    await gate.entered;
    harness.service.stop();
    harness.db.close();
    gate.release();

    await expect(polling).resolves.toBeUndefined();
    expect(harness.db.accessesAfterClose).toBe(0);
    expect(harness.db.ingressRows).toHaveLength(0);
    expect(harness.dispatched).toHaveLength(0);
    // The cursor stays put, so the delivery replays on the next runtime rather
    // than being acknowledged against a store that is going away.
    expect(harness.cursorBySource.get("cursor-relay")).toBeUndefined();
  });

  it("does not poll again after stop, even if start is called", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    harness.service.stop();
    harness.service.start();
    await harness.service.pollNow();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still records a poll failure while the service is running", async () => {
    // The guard above must not cost the ordinary error path its status write.
    const fetchImpl = vi.fn(async () => {
      throw new Error("relay unreachable");
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    await harness.service.pollNow();

    expect(harness.db.kv.get(CURSOR_CLOUD_RELAY_LAST_ERROR_REF)).toBe("relay unreachable");
    expect(harness.service.getStatus().lastError).toBe("relay unreachable");
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
