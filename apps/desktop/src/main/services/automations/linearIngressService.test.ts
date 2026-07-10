import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import type { Logger } from "../logging/logger";
import { buildLinearAutomationDispatches } from "./linearAutomationDispatch";
import { createLinearIngressService, type LinearIngressServiceDeps } from "./linearIngressService";
import {
  LINEAR_RELAY_LAST_EVENT_AT_REF,
  LINEAR_RELAY_ORGANIZATION_ID_REF,
  LINEAR_RELAY_SECRET_REF,
  LINEAR_RELAY_WEBHOOK_ID_REF,
  LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY,
} from "./linearRelayConfig";

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
    if (sql.includes("insert into linear_ingress_events")) this.ingressRows.push(params);
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

function makeWebhook(id = "webhook-1") {
  return {
    id,
    url: "https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/webhook",
    enabled: true,
    label: "ADE automations",
    resourceTypes: ["Issue", "Comment", "IssueLabel"],
    allPublicTeams: true,
  };
}

function createHarness(options: { enabled?: boolean; fetchImpl?: typeof fetch; adeApp?: boolean } = {}) {
  const db = new FakeDb();
  const credentials = new FakeCredentialStore();
  const cursorBySource = new Map<string, string | null>();
  const dispatched: LinearIngressEventRecord[] = [];
  const webhooks: ReturnType<typeof makeWebhook>[] = [];
  const client = {
    listWebhooks: vi.fn(async () => [...webhooks]),
    createWebhook: vi.fn(async (params: {
      url: string;
      secret: string;
      label?: string;
      resourceTypes?: string[];
      allPublicTeams?: boolean;
    }) => {
      const webhook = { ...makeWebhook(), url: params.url };
      webhooks.push(webhook);
      return webhook;
    }),
    deleteWebhook: vi.fn(async (webhookId: string) => {
      const index = webhooks.findIndex((webhook) => webhook.id === webhookId);
      if (index >= 0) webhooks.splice(index, 1);
    }),
  };
  const deps: LinearIngressServiceDeps = {
    db: db as LinearIngressServiceDeps["db"],
    projectId: "project-1",
    credentialStore: credentials,
    getLinearClient: () => client,
    getLinearAccessToken: () => "Bearer linear-oauth-token",
    cursorStore: {
      get: (source) => cursorBySource.get(source) ?? null,
      set: ({ source, cursor }) => cursorBySource.set(source, cursor),
    },
    dispatch: (record) => { dispatched.push(record); },
    logger: createLogger(),
    hasEnabledLinearRules: () => options.enabled !== false,
    ...(options.adeApp ? { isAdeAppConnection: () => true } : {}),
    fetchImpl: options.fetchImpl ?? vi.fn(async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch,
  };
  return {
    db,
    credentials,
    cursorBySource,
    dispatched,
    webhooks,
    client,
    deps,
    service: createLinearIngressService(deps),
  };
}

function configureReady(harness: ReturnType<typeof createHarness>): void {
  harness.db.setJson(LINEAR_RELAY_WEBHOOK_ID_REF, "webhook-1");
  harness.db.setJson(LINEAR_RELAY_ORGANIZATION_ID_REF, "org-1");
  harness.db.setJson(LINEAR_RELAY_SECRET_REF, LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY);
  harness.credentials.setSync(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY, "signing-secret");
}

function relayEvent(args: {
  sequence: number;
  deliveryId: string;
  payload: Record<string, unknown>;
}) {
  return {
    cursor: `seq:${args.sequence}`,
    eventId: args.deliveryId,
    eventType: String(args.payload.type ?? "Issue"),
    action: String(args.payload.action ?? "update"),
    createdAt: String(args.payload.createdAt ?? "2026-07-09T12:00:00.000Z"),
    body: JSON.stringify(args.payload),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("linearIngressService", () => {
  it("creates a webhook, registers the organization, and persists only the secret reference in KV", async () => {
    let registeredSecret = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/orgs/register");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer linear-oauth-token");
      registeredSecret = String((JSON.parse(String(init?.body)) as { secret: string }).secret);
      return new Response(JSON.stringify({ organizationId: "org-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });

    const status = await harness.service.setup();

    expect(status.state).toBe("ready");
    expect(harness.client.createWebhook).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/webhook",
      label: "ADE automations",
      resourceTypes: ["Issue", "Comment", "IssueLabel"],
      allPublicTeams: true,
    }));
    expect(registeredSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.credentials.getSync(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY)).toBe(registeredSecret);
    expect(harness.db.getJson(LINEAR_RELAY_WEBHOOK_ID_REF)).toBe("webhook-1");
    expect(harness.db.getJson(LINEAR_RELAY_ORGANIZATION_ID_REF)).toBe("org-1");
    expect(harness.db.getJson(LINEAR_RELAY_SECRET_REF)).toBe(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY);
    expect(Array.from(harness.db.kv.values())).not.toContain(registeredSecret);
  });

  it("reuses an existing relay webhook and re-registers the stored signing secret", async () => {
    const registeredSecrets: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      registeredSecrets.push((JSON.parse(String(init?.body)) as { secret: string }).secret);
      return new Response(JSON.stringify({ organizationId: "org-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });

    await harness.service.setup();
    await harness.service.setup();

    expect(harness.client.createWebhook).toHaveBeenCalledTimes(1);
    expect(harness.client.deleteWebhook).not.toHaveBeenCalled();
    expect(registeredSecrets).toHaveLength(2);
    expect(registeredSecrets[1]).toBe(registeredSecrets[0]);
  });

  it("polls oldest-first, persists records, and preserves payloads for the real Linear dispatch fan-out", async () => {
    const created = {
      action: "create",
      type: "Issue",
      organizationId: "org-1",
      createdAt: "2026-07-09T12:00:01.000Z",
      data: { id: "issue-1", identifier: "ADE-1", title: "Created issue" },
    };
    const updated = {
      action: "update",
      type: "Issue",
      organizationId: "org-1",
      createdAt: "2026-07-09T12:00:02.000Z",
      data: { id: "issue-1", identifier: "ADE-1", title: "Updated issue" },
      updatedFrom: { title: "Created issue" },
    };
    const labeled = {
      action: "update",
      type: "Issue",
      organizationId: "org-1",
      createdAt: "2026-07-09T12:00:03.000Z",
      data: {
        id: "issue-1",
        identifier: "ADE-1",
        title: "Labeled issue",
        labelIds: ["label-1", "label-2"],
        labels: [
          { id: "label-1", name: "bug" },
          { id: "label-2", name: "ready-for-ade" },
        ],
      },
      updatedFrom: { labelIds: ["label-1"] },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/linear/orgs/org-1/events");
      expect(url.searchParams.get("limit")).toBe("500");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer linear-oauth-token");
      return new Response(JSON.stringify({
        events: [
          relayEvent({ sequence: 3, deliveryId: "delivery-3", payload: labeled }),
          relayEvent({ sequence: 2, deliveryId: "delivery-2", payload: updated }),
          relayEvent({ sequence: 1, deliveryId: "delivery-1", payload: created }),
        ],
        nextCursor: "seq:3",
        cursorExpired: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);

    await harness.service.pollNow();

    expect(harness.dispatched.map((record) => record.deliveryId)).toEqual([
      "delivery-1",
      "delivery-2",
      "delivery-3",
    ]);
    expect(harness.dispatched.flatMap(buildLinearAutomationDispatches).map((dispatch) => dispatch.triggerType)).toEqual([
      "linear.issue_created",
      "linear.issue_updated",
      "linear.issue_labeled",
    ]);
    expect(harness.db.ingressRows).toHaveLength(3);
    expect(harness.cursorBySource.get("linear-relay")).toBe("seq:3");
    expect(harness.db.getJson(LINEAR_RELAY_LAST_EVENT_AT_REF)).toBe("2026-07-09T12:00:03.000Z");
  });

  it("does not poll when no enabled Linear automation rules exist", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const harness = createHarness({ enabled: false, fetchImpl });
    configureReady(harness);

    await harness.service.pollNow();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.service.getStatus().state).toBe("disabled");
  });

  it("advances directly to the newest cursor without replaying an expired backlog", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      events: [relayEvent({
        sequence: 99,
        deliveryId: "delivery-backlog",
        payload: {
          action: "create",
          type: "Issue",
          data: { id: "issue-old", identifier: "ADE-OLD", title: "Old backlog" },
        },
      })],
      nextCursor: "seq:99",
      cursorExpired: true,
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const harness = createHarness({ fetchImpl });
    configureReady(harness);
    harness.cursorBySource.set("linear-relay", "delivery-pruned");

    await harness.service.pollNow();

    expect(harness.dispatched).toHaveLength(0);
    expect(harness.db.ingressRows).toHaveLength(0);
    expect(harness.cursorBySource.get("linear-relay")).toBe("seq:99");
  });

  it("self-configures app-connected workspaces on the first poll without creating a webhook", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/linear/orgs/register")) {
        return new Response(JSON.stringify({ organizationId: "org-app" }), { status: 200 });
      }
      // events poll
      return new Response(JSON.stringify({ events: [], nextCursor: null, cursorExpired: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const harness = createHarness({ adeApp: true, fetchImpl });

    await harness.service.pollNow();

    const status = harness.service.getStatus();
    expect(status.state).toBe("ready");
    expect(status.organizationId).toBe("org-app");
    expect(status.appManaged).toBe(true);
    expect(harness.client.createWebhook).not.toHaveBeenCalled();
    expect(harness.client.listWebhooks).not.toHaveBeenCalled();

    // Teardown clears local state but never deletes the app's webhook.
    await harness.service.teardown();
    expect(harness.client.deleteWebhook).not.toHaveBeenCalled();
    expect(harness.service.getStatus().organizationId).toBe(null);
  });

  it("deletes the Linear webhook and clears relay state, cursor, and encrypted secret", async () => {
    const harness = createHarness();
    configureReady(harness);
    harness.webhooks.push(makeWebhook());
    harness.cursorBySource.set("linear-relay", "seq:12");

    const status = await harness.service.teardown();

    expect(harness.client.deleteWebhook).toHaveBeenCalledWith("webhook-1");
    expect(harness.credentials.getSync(LINEAR_WEBHOOK_SECRET_CREDENTIAL_KEY)).toBeNull();
    expect(harness.db.getJson(LINEAR_RELAY_WEBHOOK_ID_REF)).toBeNull();
    expect(harness.db.getJson(LINEAR_RELAY_ORGANIZATION_ID_REF)).toBeNull();
    expect(harness.cursorBySource.get("linear-relay")).toBeNull();
    expect(status.state).toBe("unconfigured");
  });
});
