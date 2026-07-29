import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attentionTestInternals,
  handleAttentionAccountRequest,
  handleAttentionMachinePublish,
  inspectAttentionAuthConfiguration,
  pruneAttentionState,
  type AttentionRelayEnv,
} from "../src/attention";
import { verifyAttentionBearerToken } from "../src/attentionAuth";

type NativeStatement = {
  all: (...values: unknown[]) => Array<Record<string, unknown>>;
  get: (...values: unknown[]) => Record<string, unknown> | undefined;
  run: (...values: unknown[]) => unknown;
};

type NativeDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => NativeStatement;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

describe("account authentication configuration", () => {
  const DB = {} as D1Database;

  it("distinguishes missing, partial, and complete Clerk verification bindings", () => {
    expect(inspectAttentionAuthConfiguration({})).toEqual({
      configured: false,
      primaryConfigured: false,
      secondaryConfigured: false,
      errors: ["primary_incomplete"],
    });
    expect(inspectAttentionAuthConfiguration({
      CLERK_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
    })).toMatchObject({
      configured: false,
      primaryConfigured: false,
      errors: ["primary_incomplete"],
    });
    expect(inspectAttentionAuthConfiguration({
      CLERK_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
      CLERK_ISSUER: "https://clerk.example",
      CLERK_OAUTH_CLIENT_ID: "client-prod",
      CLERK_SECONDARY_JWKS_URL: "https://clerk-dev.example/.well-known/jwks.json",
      CLERK_SECONDARY_ISSUER: "https://clerk-dev.example",
      CLERK_SECONDARY_OAUTH_CLIENT_ID: "client-dev",
    })).toEqual({
      configured: true,
      primaryConfigured: true,
      secondaryConfigured: true,
      errors: [],
    });
  });

  it("reports a relay configuration outage separately from a rejected account token", async () => {
    const response = await handleAttentionAccountRequest(
      new Request("https://push.example/attention/account/snapshot", {
        headers: { authorization: "Bearer expired-token" },
      }),
      { DB },
      new URL("https://push.example/attention/account/snapshot"),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      code: "account_auth_unavailable",
      recovery: expect.stringContaining("service owner"),
    });
  });

  it("accepts the secondary issuer only under its own audience policy", async () => {
    const accepted = await machinePublishAuthorization({
      audience: "client-dev",
      azp: "client-dev",
    });
    const rejected = await machinePublishAuthorization({
      audience: "different-client",
      azp: "different-client",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === accepted.jwksUrl) return Response.json(accepted.jwks);
      if (url === rejected.jwksUrl) return Response.json(rejected.jwks);
      if (url === "https://clerk.example/.well-known/jwks.json") {
        return Response.json({ keys: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const baseEnv = {
      CLERK_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
      CLERK_ISSUER: "https://clerk.example",
      CLERK_OAUTH_CLIENT_ID: "client-prod",
    };

    await expect(verifyAttentionBearerToken(
      new Request("https://push.example/attention/account/snapshot", {
        headers: { authorization: `Bearer ${accepted.token}` },
      }),
      {
        ...baseEnv,
        CLERK_SECONDARY_JWKS_URL: accepted.jwksUrl,
        CLERK_SECONDARY_ISSUER: accepted.issuer,
        CLERK_SECONDARY_OAUTH_CLIENT_ID: "client-dev",
      },
    )).resolves.toBe(accepted.userId);

    await expect(verifyAttentionBearerToken(
      new Request("https://push.example/attention/account/snapshot", {
        headers: { authorization: `Bearer ${rejected.token}` },
      }),
      {
        ...baseEnv,
        CLERK_SECONDARY_JWKS_URL: rejected.jwksUrl,
        CLERK_SECONDARY_ISSUER: rejected.issuer,
        CLERK_SECONDARY_OAUTH_CLIENT_ID: "client-dev",
      },
    )).resolves.toBeNull();
  });

  it("reports a Clerk JWKS outage as service unavailable instead of rejecting the user", async () => {
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ error: "upstream unavailable" }, { status: 503 })
    ));
    const response = await handleAttentionAccountRequest(
      new Request("https://push.example/attention/account/snapshot", {
        headers: { authorization: `Bearer ${authorization.token}` },
      }),
      {
        DB,
        CLERK_JWKS_URL: authorization.jwksUrl,
        CLERK_ISSUER: authorization.issuer,
        CLERK_OAUTH_CLIENT_ID: "client-prod",
      },
      new URL("https://push.example/attention/account/snapshot"),
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      code: "account_auth_unavailable",
      recovery: expect.stringContaining("Retry"),
    });
  });
});

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly database: NativeDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return {
      results: this.database.prepare(this.sql).all(...this.values) as T[],
    };
  }

  async run(): Promise<{ success: boolean }> {
    this.runSync();
    return { success: true };
  }

  runSync(): Array<Record<string, unknown>> {
    if (/\breturning\b/i.test(this.sql)) {
      return this.database.prepare(this.sql).all(...this.values);
    }
    this.database.prepare(this.sql).run(...this.values);
    return [];
  }
}

class SqliteD1Database {
  readonly native: NativeDatabase;
  private nextBatchFailureIndex: number | null = null;
  private nextBatchObservation:
    | { index: number; observe: () => Promise<void> }
    | null = null;

  constructor(path = ":memory:", migrate = true) {
    this.native = new DatabaseSync(path);
    if (migrate) {
      for (const migration of [
        "../migrations/0001_push_registrations.sql",
        "../migrations/0002_rate_and_budget.sql",
        "../migrations/0003_account_attention.sql",
        "../migrations/0004_device_registration_generation.sql",
      ]) {
        this.native.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
      }
      this.native.exec(
        readFileSync(
          new URL("../schema/attention_triggers.sql", import.meta.url),
          "utf8",
        ),
      );
    }
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.native, sql);
  }

  async batch(
    statements: SqliteD1Statement[],
  ): Promise<Array<{ success: boolean; results: Array<Record<string, unknown>> }>> {
    this.native.exec("begin immediate");
    try {
      const results: Array<{
        success: boolean;
        results: Array<Record<string, unknown>>;
      }> = [];
      for (const [index, statement] of statements.entries()) {
        if (index === this.nextBatchFailureIndex) {
          throw new Error(`injected batch failure at statement ${index}`);
        }
        results.push({ success: true, results: statement.runSync() });
        if (index === this.nextBatchObservation?.index) {
          await this.nextBatchObservation.observe();
        }
      }
      this.native.exec("commit");
      return results;
    } catch (error) {
      this.native.exec("rollback");
      throw error;
    } finally {
      this.nextBatchFailureIndex = null;
      this.nextBatchObservation = null;
    }
  }

  failNextBatchAt(index: number): void {
    this.nextBatchFailureIndex = index;
  }

  observeNextBatchAfter(index: number, observe: () => Promise<void>): void {
    this.nextBatchObservation = { index, observe };
  }

  close(): void {
    this.native.close();
  }
}

function makeAttentionEnv(
  database: SqliteD1Database,
  overrides: Omit<Partial<AttentionRelayEnv>, "DB"> = {},
): AttentionRelayEnv {
  return { DB: database as unknown as D1Database, ...overrides };
}

async function generateTestP8(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

async function attentionAccountId(issuer: string, subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${issuer}\0${subject}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function machinePublishAuthorization(args?: {
  audience?: string;
  azp?: string;
}): Promise<{
  issuer: string;
  jwksUrl: string;
  token: string;
  userId: string;
  jwks: Record<string, unknown>;
}> {
  const issuer = `https://issuer-${crypto.randomUUID()}.example`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const subject = "user-attention-test";
  const keyId = crypto.randomUUID();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  let tokenBuilder = new SignJWT(args?.azp ? { azp: args.azp } : {})
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m");
  if (args?.audience) tokenBuilder = tokenBuilder.setAudience(args.audience);
  const token = await tokenBuilder.sign(privateKey);
  return {
    issuer,
    jwksUrl,
    token,
    userId: await attentionAccountId(issuer, subject),
    jwks: {
      keys: [{
        ...publicJwk,
        alg: "RS256",
        kid: keyId,
        use: "sig",
      }],
    },
  };
}

function row<T extends Record<string, unknown>>(
  database: SqliteD1Database,
  sql: string,
  ...values: unknown[]
): T | undefined {
  return database.native.prepare(sql).get(...values) as T | undefined;
}

function rows<T extends Record<string, unknown>>(
  database: SqliteD1Database,
  sql: string,
  ...values: unknown[]
): T[] {
  return database.native.prepare(sql).all(...values) as T[];
}

async function accountRoute(
  database: SqliteD1Database,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const request = new Request(`https://push.example${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
    request,
    makeAttentionEnv(database),
    new URL(request.url),
    userId,
  );
  if (!response) throw new Error(`Attention route did not handle ${method} ${path}`);
  return response;
}

function insertAttentionDevice(
  database: SqliteD1Database,
  args: {
    userId: string;
    deviceId: string;
    apnsToken?: string | null;
    pushToStartToken?: string | null;
    preferences?: Record<string, unknown>;
    sourceMachineKey?: string | null;
    leaseExpiresAt?: string;
    ownershipEpoch?: number;
  },
): void {
  const now = "2026-07-28T08:00:00.000Z";
  database.native.prepare(`
    insert into attention_devices(
      user_id, device_id, source_machine_key, apns_token, push_to_start_token,
      bundle_id, aps_environment, platform, device_name, preferences_json,
      registered_at, updated_at, lease_expires_at, generation
    ) values (
      ?, ?, ?, ?, ?, 'com.ade.ios', 'sandbox', 'iOS', null, ?, ?, ?, ?, ?
    )
  `).run(
    args.userId,
    args.deviceId,
    args.sourceMachineKey ?? null,
    args.apnsToken ?? null,
    args.pushToStartToken ?? null,
    JSON.stringify(args.preferences ?? {}),
    now,
    now,
    args.leaseExpiresAt ?? "2026-09-01T08:00:00.000Z",
    crypto.randomUUID(),
  );
  database.native.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, apns_token, active, updated_at
    ) values (?, ?, ?, ?, 1, ?)
  `).run(
    args.deviceId,
    args.userId,
    args.ownershipEpoch ?? 1,
    args.apnsToken ?? null,
    now,
  );
}

const MACHINE_KEY = "a".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function validAgentItem(): Record<string, unknown> {
  return {
    contractVersion: 1,
    id: `agent:${MACHINE_KEY}:session-1`,
    revision: 7,
    fingerprint: "fingerprint-7",
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    title: "Approve the migration",
    preview: "The database migration is ready for review.",
    privacyPreview: "An ADE agent needs your attention.",
    detail: "Review the generated SQL before continuing.",
    recentActivity: ["Inspected the schema", "Prepared the migration"],
    planProgress: {
      completed: 2,
      total: 3,
      current: "Waiting for approval",
    },
    laneId: "lane-1",
    laneName: "attention-system",
    provider: "codex",
    model: "gpt-5",
    machine: {
      machineKey: MACHINE_KEY,
      accountMachineKey: "c".repeat(32),
      name: "Studio",
    },
    project: {
      projectId: "project-1",
      name: "ADE",
      rootPath: "/projects/ade",
    },
    destination: {
      kind: "session",
      sessionId: "session-1",
      itemId: "approval-1",
      eventId: "event-1",
    },
    actions: [
      {
        id: "approve",
        kind: "approve",
        label: "Approve",
        payload: { decision: "accept" },
      },
      {
        id: "open",
        kind: "open",
        label: "Open",
      },
    ],
    occurredAt: "2026-07-28T08:00:00.000Z",
    updatedAt: "2026-07-28T08:00:05.000Z",
    // Keep the shared fixture live independent of the wall clock. Tests that
    // exercise expiry override this field explicitly.
    expiresAt: "2099-07-29T08:00:05.000Z",
  };
}

describe("account Attention contract", () => {
  it("resolves muted sessions device override then account then registration fallback", () => {
    const device = {
      device_id: "phone-1",
      apns_token: "ab".repeat(32),
      push_to_start_token: null,
      bundle_id: "com.ade.ios",
      aps_environment: "sandbox",
      preferences_json: JSON.stringify({ mutedSessionIds: ["registration-muted"] }),
      generation: "device-generation",
    };
    expect(attentionTestInternals.resolvedMutedSessionIds(
      device,
      { mutedSessionIds: ["account-muted"] },
      { "phone-1": { mutedSessionIds: ["device-muted"] } },
    )).toEqual(["device-muted"]);
    expect(attentionTestInternals.resolvedMutedSessionIds(
      device,
      { mutedSessionIds: ["account-muted"] },
      {},
    )).toEqual(["account-muted"]);
    expect(attentionTestInternals.resolvedMutedSessionIds(
      device,
      {},
      {},
    )).toEqual(["registration-muted"]);
    expect(attentionTestInternals.resolvedMutedSessionIds(
      device,
      { mutedSessionIds: ["account-muted"] },
      { "phone-1": { mutedSessionIds: [] } },
    )).toEqual([]);
  });

  it("accepts and normalizes a bounded machine-owned agent item", () => {
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);

    expect(parsed).toMatchObject({
      id: `agent:${MACHINE_KEY}:session-1`,
      kind: "agent",
      eventKind: "agent_needs_you",
      phase: "needs_you",
      seenAt: null,
      dismissedAt: null,
      machine: {
        machineKey: MACHINE_KEY,
        name: "Studio",
        online: true,
      },
      destination: {
        kind: "session",
        sessionId: "session-1",
        itemId: "approval-1",
      },
      planProgress: {
        completed: 2,
        total: 3,
      },
    });
  });

  it("rejects cross-kind events, foreign machine ids, and invalid progress", () => {
    const wrongKind = validAgentItem();
    wrongKind.eventKind = "pr_merge_ready";
    expect(attentionTestInternals.parseAttentionItem(wrongKind, MACHINE_KEY)).toBeNull();

    const foreignId = validAgentItem();
    foreignId.id = `agent:${"b".repeat(32)}:session-1`;
    expect(attentionTestInternals.parseAttentionItem(foreignId, MACHINE_KEY)).toBeNull();

    const invalidProgress = validAgentItem();
    invalidProgress.planProgress = { completed: 4, total: 3, current: "Impossible" };
    expect(attentionTestInternals.parseAttentionItem(invalidProgress, MACHINE_KEY)).toBeNull();
  });

  it("clamps desktop-first escalation preferences to a safe relay range", () => {
    expect(attentionTestInternals.desktopEscalationDelayMs({})).toBe(30_000);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: -90,
    })).toBe(0);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: 119.6,
    })).toBe(120_000);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: 3_600,
    })).toBe(300_000);
  });

  it("resets a cursor that belongs to a different account revision stream", () => {
    expect(attentionTestInternals.normalizedSnapshotCursor(12, 40)).toBe(12);
    expect(attentionTestInternals.normalizedSnapshotCursor(40, 40)).toBe(40);
    expect(attentionTestInternals.normalizedSnapshotCursor(400, 2)).toBe(0);
    expect(
      attentionTestInternals.normalizedSnapshotCursor(12, 40, "account-a", "account-a"),
    ).toBe(12);
    expect(
      attentionTestInternals.normalizedSnapshotCursor(12, 40, "account-a", "account-b"),
    ).toBe(0);
  });

  it("does not rewrite an identical full-snapshot heartbeat", () => {
    const current = [{
      item_id: `agent:${MACHINE_KEY}:session-1`,
      source_revision: 7,
      fingerprint: "fingerprint-7",
    }];
    const incoming = [{
      id: `agent:${MACHINE_KEY}:session-1`,
      revision: 7,
      fingerprint: "fingerprint-7",
    }];
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, incoming, 0),
    ).toBe(true);
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, [
        { ...incoming[0], fingerprint: "fingerprint-8" },
      ], 0),
    ).toBe(false);
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, incoming, 1),
    ).toBe(false);
  });

  it("atomically preserves concurrent account and per-device preference updates", async () => {
    const database = new SqliteD1Database();
    try {
      database.native.prepare(`
        insert into attention_preferences(user_id, payload_json, updated_at)
        values ('account-a', ?, '2026-07-28T08:00:00.000Z')
      `).run(JSON.stringify({
        account: { notificationsEnabled: true },
        devices: {
          "phone-a": {
            celebrationsEnabled: false,
          },
        },
      }));

      const [phoneAResponse, phoneBResponse, accountResponse] = await Promise.all([
        accountRoute(
          database,
          "account-a",
          "PATCH",
          "/attention/account/preferences/devices/phone-a",
          {
            notificationsEnabled: false,
            mutedSessionIds: ["session-a"],
          },
        ),
        accountRoute(
          database,
          "account-a",
          "PATCH",
          "/attention/account/preferences/devices/phone-b",
          {
            liveActivitiesEnabled: true,
          },
        ),
        accountRoute(
          database,
          "account-a",
          "PUT",
          "/attention/account/preferences",
          {
            account: {
              notificationsEnabled: true,
              hideDetails: true,
            },
            projects: {
              "project-a": {
                notificationsEnabled: false,
              },
            },
          },
        ),
      ]);

      expect(phoneAResponse.status).toBe(200);
      expect(phoneBResponse.status).toBe(200);
      expect(accountResponse.status).toBe(200);
      const stored = row<{ payload_json: string }>(
        database,
        "select payload_json from attention_preferences where user_id = 'account-a'",
      );
      const preferences = JSON.parse(stored?.payload_json ?? "{}") as Record<string, unknown>;
      expect(preferences).toMatchObject({
        account: {
          notificationsEnabled: true,
          hideDetails: true,
        },
        projects: {
          "project-a": {
            notificationsEnabled: false,
          },
        },
        devices: {
          "phone-a": {
            celebrationsEnabled: false,
            notificationsEnabled: false,
            mutedSessionIds: ["session-a"],
          },
          "phone-b": {
            liveActivitiesEnabled: true,
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("retries a transient Live Activity start on an unchanged full-snapshot heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    const apnsBodies: Array<Record<string, unknown>> = [];
    let liveActivityAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (requestUrl === authorization.jwksUrl) {
        return Response.json(authorization.jwks);
      }
      if (requestUrl.startsWith("https://api.sandbox.push.apple.com/")) {
        liveActivityAttempts += 1;
        apnsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return liveActivityAttempts === 1
          ? Response.json({ reason: "InternalServerError" }, { status: 500 })
          : new Response(null, {
              status: 200,
              headers: { "apns-id": "live-activity-retry" },
            });
      }
      throw new Error(`Unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      insertAttentionDevice(database, {
        userId: authorization.userId,
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_preferences(user_id, payload_json, updated_at)
        values (?, ?, '2026-07-28T08:00:00.000Z')
      `).run(
        authorization.userId,
        JSON.stringify({
          account: {
            notificationsEnabled: false,
            liveActivitiesEnabled: true,
          },
        }),
      );
      const env = makeAttentionEnv(database, {
        CLERK_JWKS_URL: authorization.jwksUrl,
        CLERK_ISSUER: authorization.issuer,
        CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "RETRYKEY12",
        APNS_TEAM_ID: "RETRYTEAM1",
      });
      const payload = {
        contractVersion: 1,
        machineName: "Studio",
        fullSnapshot: true,
        items: [validAgentItem()],
        tombstones: [],
      };
      const body = new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer;
      const publish = () => handleAttentionMachinePublish(
        new Request("https://push.example/attention/machine/publish", {
          method: "POST",
          headers: { authorization: `Bearer ${authorization.token}` },
        }),
        env,
        MACHINE_KEY,
        body,
      );

      const initial = await publish();
      expect(initial.status).toBe(200);
      expect(liveActivityAttempts).toBe(1);
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = ? and device_id = 'phone-1' and activity_id = 'agent-runs'
      `, authorization.userId)).toBeUndefined();

      const retry = await publish();
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        ok: true,
        upserted: 0,
        removed: 0,
        unchanged: true,
      });
      expect(liveActivityAttempts).toBe(2);
      expect(apnsBodies).toHaveLength(2);
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = ? and device_id = 'phone-1' and activity_id = 'agent-runs'
      `, authorization.userId)?.started).toBe(1);
    } finally {
      database.close();
    }
  });

  it("claims one account Live Activity start across concurrent deliveries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const sendPush = vi.fn(async () => {
      await Promise.resolve();
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "single-concurrent-start" },
      });
    });
    vi.stubGlobal("fetch", sendPush);
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-concurrent",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "CLAIMKEY12",
        APNS_TEAM_ID: "CLAIMTEAM1",
      });

      await Promise.all([
        attentionTestInternals.deliverAccountLiveActivity(env, "account-a"),
        attentionTestInternals.deliverAccountLiveActivity(env, "account-a"),
      ]);

      expect(sendPush).toHaveBeenCalledTimes(1);
      const state = row(database, `
        select started, fingerprint
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-concurrent'
          and activity_id = 'agent-runs'
      `);
      expect(state?.started).toBe(1);
      expect(String(state?.fingerprint)).not.toMatch(/^pending:/);
    } finally {
      database.close();
    }
  });

  it("restarts active account work after the device reports no Live Activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const sendPush = vi.fn(async () =>
      new Response(null, {
        status: 200,
        headers: { "apns-id": "reconciled-start" },
      })
    );
    vi.stubGlobal("fetch", sendPush);
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-reconcile",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'phone-reconcile', 'agent-runs', 1,
          'apns-accepted-without-device-token', '2026-07-28T07:50:00.000Z'
        )
      `).run();
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "RETRYKEY12",
        APNS_TEAM_ID: "RETRYTEAM1",
      });
      const request = new Request(
        "https://push.example/attention/account/devices/phone-reconcile/activities/agent-runs",
        { method: "DELETE" },
      );

      const response =
        await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
          request,
          env,
          new URL(request.url),
          "account-a",
        );

      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ ok: true, removed: true });
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(row(database, `
        select started, fingerprint
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-reconcile'
          and activity_id = 'agent-runs'
      `)).toMatchObject({
        started: 1,
      });
    } finally {
      database.close();
    }
  });

  it("does not recreate account Live Activity state after its registration is cleared in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    let releaseUpdate!: (response: Response) => void;
    let markUpdateStarted: (() => void) | null = null;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    const updateResponse = new Promise<Response>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      markUpdateStarted?.();
      return await updateResponse;
    }));
    const env = makeAttentionEnv(database, {
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "STALEKEY12",
      APNS_TEAM_ID: "STALETEAM1",
    });
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-stale-update",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-stale-update', 'agent-runs', ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("cd".repeat(32));
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'phone-stale-update', 'agent-runs', 1,
          'outdated-fingerprint', '2026-07-28T08:00:00.000Z'
        )
      `).run();

      const delivery = attentionTestInternals.deliverAccountLiveActivity(
        env,
        "account-a",
      );
      await updateStarted;

      const clearRequest = new Request(
        "https://push.example/attention/account/devices/phone-stale-update",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownershipEpoch: 1,
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
            platform: "iOS",
            clearPushToStartToken: true,
          }),
        },
      );
      const clearResponse =
        await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
          clearRequest,
          env,
          new URL(clearRequest.url),
          "account-a",
        );
      expect(clearResponse?.status).toBe(200);
      expect(rows(database, `
        select activity_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-stale-update'
      `)).toHaveLength(0);

      releaseUpdate(new Response(null, {
        status: 200,
        headers: { "apns-id": "stale-update" },
      }));
      await delivery;

      expect(rows(database, `
        select activity_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-stale-update'
      `)).toHaveLength(0);
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-stale-update'
      `)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("commits an in-flight account Live Activity start across an unchanged registration refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    let releaseStart!: (response: Response) => void;
    let markStartStarted: (() => void) | null = null;
    const startStarted = new Promise<void>((resolve) => {
      markStartStarted = resolve;
    });
    const startResponse = new Promise<Response>((resolve) => {
      releaseStart = resolve;
    });
    const sendPush = vi.fn(async () => {
      markStartStarted?.();
      return await startResponse;
    });
    vi.stubGlobal("fetch", sendPush);
    const env = makeAttentionEnv(database, {
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "REFRESHKEY",
      APNS_TEAM_ID: "REFRESHTEAM",
    });
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-refresh",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      const generationBefore = row<{ generation: string }>(database, `
        select generation
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-refresh'
      `)?.generation;

      const delivery = attentionTestInternals.deliverAccountLiveActivity(
        env,
        "account-a",
      );
      await startStarted;

      const refreshRequest = new Request(
        "https://push.example/attention/account/devices/phone-refresh",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownershipEpoch: 1,
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
            platform: "iOS",
          }),
        },
      );
      const refreshResponse =
        await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
          refreshRequest,
          env,
          new URL(refreshRequest.url),
          "account-a",
        );
      expect(refreshResponse?.status).toBe(200);
      expect(row<{ generation: string }>(database, `
        select generation
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-refresh'
      `)?.generation).toBe(generationBefore);
      expect(sendPush).toHaveBeenCalledTimes(1);

      releaseStart(new Response(null, {
        status: 200,
        headers: { "apns-id": "refresh-start" },
      }));
      await delivery;

      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(row(database, `
        select started, fingerprint
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-refresh'
          and activity_id = 'agent-runs'
      `)).toMatchObject({
        started: 1,
      });
    } finally {
      database.close();
    }
  });

  it("replaces an in-flight account Live Activity start immediately after token rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    let releaseOldStart!: (response: Response) => void;
    let markOldStartStarted: (() => void) | null = null;
    const oldStartStarted = new Promise<void>((resolve) => {
      markOldStartStarted = resolve;
    });
    const oldStartResponse = new Promise<Response>((resolve) => {
      releaseOldStart = resolve;
    });
    const pushedUrls: string[] = [];
    const sendPush = vi.fn(async (input: RequestInfo | URL) => {
      pushedUrls.push(input instanceof Request ? input.url : String(input));
      if (pushedUrls.length === 1) {
        markOldStartStarted?.();
        return await oldStartResponse;
      }
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "replacement-start" },
      });
    });
    vi.stubGlobal("fetch", sendPush);
    const env = makeAttentionEnv(database, {
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "ROTATEKEY1",
      APNS_TEAM_ID: "ROTATETEAM",
    });
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-rotate",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      const generationBefore = row<{ generation: string }>(database, `
        select generation
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-rotate'
      `)?.generation;

      const oldDelivery = attentionTestInternals.deliverAccountLiveActivity(
        env,
        "account-a",
      );
      await oldStartStarted;

      const replacementRequest = new Request(
        "https://push.example/attention/account/devices/phone-rotate",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownershipEpoch: 1,
            pushToStartToken: "cd".repeat(32),
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
            platform: "iOS",
          }),
        },
      );
      const replacementResponse =
        await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
          replacementRequest,
          env,
          new URL(replacementRequest.url),
          "account-a",
        );
      expect(replacementResponse?.status).toBe(200);
      expect(sendPush).toHaveBeenCalledTimes(2);
      expect(pushedUrls[0]).toContain("ab".repeat(32));
      expect(pushedUrls[1]).toContain("cd".repeat(32));
      expect(row<{ generation: string }>(database, `
        select generation
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-rotate'
      `)?.generation).not.toBe(generationBefore);
      const replacementState = row<{ started: number; fingerprint: string }>(
        database,
        `
          select started, fingerprint
          from attention_activity_state
          where user_id = 'account-a' and device_id = 'phone-rotate'
            and activity_id = 'agent-runs'
        `,
      );
      expect(replacementState?.started).toBe(1);
      expect(replacementState?.fingerprint).not.toMatch(/^pending:/);

      releaseOldStart(new Response(null, {
        status: 200,
        headers: { "apns-id": "stale-start" },
      }));
      await oldDelivery;

      expect(row(database, `
        select started, fingerprint
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-rotate'
          and activity_id = 'agent-runs'
      `)).toEqual(replacementState);
    } finally {
      database.close();
    }
  });

  it("rolls back a published item when its cursor transaction fails", async () => {
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      database.failNextBatchAt(2);
      await expect(attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [parsed],
          tombstones: [],
          sealCapacityTombstones: false,
          now: "2026-07-28T08:00:00.000Z",
        },
      )).rejects.toThrow("injected batch failure at statement 2");

      expect(row(database, `
        select revision
        from attention_revisions
        where user_id = 'account-a'
      `)).toBeUndefined();
      expect(rows(database, `
        select item_id
        from attention_items
        where user_id = 'account-a'
      `)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back item deletion when its tombstone cursor transaction fails", async () => {
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T07:59:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 4, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      database.failNextBatchAt(2);
      await expect(attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [],
          tombstones: [{ id: parsed.id, revision: 7, revivable: false }],
          sealCapacityTombstones: false,
          now: "2026-07-28T08:00:00.000Z",
        },
      )).rejects.toThrow("injected batch failure at statement 2");

      expect(row(database, `
        select revision
        from attention_revisions
        where user_id = 'account-a'
      `)?.revision).toBe(4);
      expect(row(database, `
        select account_revision
        from attention_items
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.account_revision).toBe(4);
      expect(rows(database, `
        select item_id
        from attention_tombstones
        where user_id = 'account-a'
      `)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back acknowledgment rows when their cursor transaction fails", async () => {
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T07:59:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 4, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      database.failNextBatchAt(1);
      await expect(accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [parsed.id],
          seenAt: "2026-07-28T08:00:00.000Z",
          dismissedAt: null,
        },
      )).rejects.toThrow("injected batch failure at statement 1");

      expect(row(database, `
        select revision
        from attention_revisions
        where user_id = 'account-a'
      `)?.revision).toBe(4);
      expect(row(database, `
        select account_revision, seen_at
        from attention_items
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)).toMatchObject({
        account_revision: 4,
        seen_at: null,
      });
    } finally {
      database.close();
    }
  });

  it("converges out-of-order acknowledgments on the earliest seen and dismissed times", async () => {
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 1, '2026-07-28T07:59:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      for (const timestamp of [
        "2026-07-28T08:05:00.000Z",
        "2026-07-28T08:01:00.000Z",
        "2026-07-28T08:09:00.000Z",
      ]) {
        const response = await accountRoute(
          database,
          "account-a",
          "POST",
          "/attention/account/ack",
          {
            itemIds: [parsed.id],
            seenAt: timestamp,
            dismissedAt: timestamp,
          },
        );
        expect(response.status).toBe(200);
      }

      expect(row(database, `
        select seen_at, dismissed_at
        from attention_items
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)).toEqual({
        seen_at: "2026-07-28T08:01:00.000Z",
        dismissed_at: "2026-07-28T08:01:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("keeps an empty acknowledgment cursor-stable", async () => {
    const database = new SqliteD1Database();
    try {
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T07:59:00.000Z')
      `).run();

      const response = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [],
          seenAt: "2026-07-28T08:00:00.000Z",
          dismissedAt: null,
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        revision: 4,
        itemIds: [],
      });
      expect(row(database, `
        select revision
        from attention_revisions
        where user_id = 'account-a'
      `)?.revision).toBe(4);
    } finally {
      database.close();
    }
  });

  it("never exposes a cursor before its item, tombstone, or acknowledgment rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "ade-attention-atomic-"));
    const path = join(directory, "relay.sqlite");
    const database = new SqliteD1Database(path);
    const observer = new SqliteD1Database(path, false);
    const first = attentionTestInternals.parseAttentionItem(
      validAgentItem(),
      MACHINE_KEY,
    );
    const secondRaw = validAgentItem();
    secondRaw.id = `agent:${MACHINE_KEY}:session-2`;
    secondRaw.fingerprint = "fingerprint-session-2";
    secondRaw.destination = {
      kind: "session",
      sessionId: "session-2",
      itemId: "approval-2",
      eventId: "event-2",
    };
    const second = attentionTestInternals.parseAttentionItem(
      secondRaw,
      MACHINE_KEY,
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) {
      observer.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
      return;
    }
    type SnapshotBody = {
      revision: number;
      items: Array<{ id: string; seenAt: string | null }>;
      tombstones: Array<{ id: string }>;
    };
    try {
      const initialRevision = await attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [first, second],
          tombstones: [],
          sealCapacityTombstones: false,
          now: "2026-07-28T08:00:00.000Z",
        },
      );
      expect(initialRevision).toBe(1);

      const updatedRaw = validAgentItem();
      updatedRaw.revision = 8;
      updatedRaw.fingerprint = "fingerprint-8";
      updatedRaw.preview = "The migration changed while you were reviewing it.";
      updatedRaw.updatedAt = "2026-07-28T08:01:00.000Z";
      const updated = attentionTestInternals.parseAttentionItem(
        updatedRaw,
        MACHINE_KEY,
      );
      expect(updated).not.toBeNull();
      if (!updated) throw new Error("setup precondition: updated Attention item must parse");

      let duringPublish: SnapshotBody | null = null;
      database.observeNextBatchAfter(0, async () => {
        const response = await accountRoute(
          observer,
          "account-a",
          "GET",
          "/attention/account/snapshot?since=1&streamId=account-a",
        );
        duringPublish = await response.json() as SnapshotBody;
      });
      const publishRevision = await attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [updated],
          tombstones: [{ id: second.id, revision: second.revision, revivable: false }],
          sealCapacityTombstones: false,
          now: "2026-07-28T08:01:00.000Z",
        },
      );
      expect(publishRevision).toBe(2);
      expect(duringPublish).toEqual(expect.objectContaining({
        revision: 1,
        items: [],
        tombstones: [],
      }));

      const publishedDelta = await (
        await accountRoute(
          observer,
          "account-a",
          "GET",
          "/attention/account/snapshot?since=1&streamId=account-a",
        )
      ).json() as SnapshotBody;
      expect(publishedDelta.revision).toBe(2);
      expect(publishedDelta.items.map((item) => item.id)).toEqual([updated.id]);
      expect(publishedDelta.tombstones.map((item) => item.id)).toEqual([second.id]);

      let duringAcknowledgment: SnapshotBody | null = null;
      database.observeNextBatchAfter(0, async () => {
        const response = await accountRoute(
          observer,
          "account-a",
          "GET",
          "/attention/account/snapshot?since=2&streamId=account-a",
        );
        duringAcknowledgment = await response.json() as SnapshotBody;
      });
      const acknowledgment = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [updated.id],
          seenAt: "2026-07-28T08:02:00.000Z",
          dismissedAt: null,
        },
      );
      expect(acknowledgment.status).toBe(200);
      expect(await acknowledgment.json()).toMatchObject({ revision: 3 });
      expect(duringAcknowledgment).toEqual(expect.objectContaining({
        revision: 2,
        items: [],
        tombstones: [],
      }));

      const acknowledgedDelta = await (
        await accountRoute(
          observer,
          "account-a",
          "GET",
          "/attention/account/snapshot?since=2&streamId=account-a",
        )
      ).json() as SnapshotBody;
      expect(acknowledgedDelta.revision).toBe(3);
      expect(acknowledgedDelta.items).toEqual([
        expect.objectContaining({
          id: updated.id,
          seenAt: "2026-07-28T08:02:00.000Z",
        }),
      ]);
    } finally {
      observer.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("revives capacity-displaced items but seals confirmed removals", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const itemId = `agent:${MACHINE_KEY}:session-capacity`;
    try {
      const capacityTombstone = attentionTestInternals.implicitFullSnapshotTombstone({
        item_id: itemId,
        source_revision: 7,
      }, 64);
      expect(capacityTombstone).toEqual({
        id: itemId,
        revision: 7,
        revivable: true,
      });
      expect(attentionTestInternals.implicitFullSnapshotTombstone({
        item_id: itemId,
        source_revision: 7,
      }, 63).revivable).toBe(false);

      await attentionTestInternals.upsertAttentionTombstone(env, {
        userId: "account-a",
        itemId,
        sourceRevision: 7,
        accountRevision: 1,
        deletedAt: "2026-07-28T08:00:00.000Z",
        revivable: true,
      });
      const displaced = row<{ source_revision: number; revivable: number }>(database, `
        select source_revision, revivable
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId);
      expect(displaced).toMatchObject({ source_revision: 7, revivable: 1 });
      expect(attentionTestInternals.attentionTombstoneBlocksItem(displaced!, 7)).toBe(false);

      await attentionTestInternals.sealCapacityTombstones(
        env,
        "account-a",
        MACHINE_KEY,
      );
      const confirmedRemoval = row<{ source_revision: number; revivable: number }>(database, `
        select source_revision, revivable
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId);
      expect(confirmedRemoval).toMatchObject({ source_revision: 7, revivable: 0 });
      expect(
        attentionTestInternals.attentionTombstoneBlocksItem(confirmedRemoval!, 7),
      ).toBe(true);

      // A later ambiguous capacity omission cannot weaken an already
      // authoritative same-revision removal.
      await attentionTestInternals.upsertAttentionTombstone(env, {
        userId: "account-a",
        itemId,
        sourceRevision: 7,
        accountRevision: 2,
        deletedAt: "2026-07-28T08:01:00.000Z",
        revivable: true,
      });
      expect(row(database, `
        select revivable
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId)?.revivable).toBe(0);
    } finally {
      database.close();
    }
  });

  it("delays only items visible in Attention, then retries without duplicating delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const sendPush = vi.fn(async () => ({
      ok: true,
      status: 200,
      apnsId: "apns-id",
      reason: null,
      tokenInvalid: false,
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        apnsToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_presence(user_id, device_id, payload_json, observed_at)
        values (
          'account-a', 'desktop-1',
          '{"platform":"macOS","appForeground":true,"ambientSurfaceVisible":false}',
          '2026-07-28T08:00:10.000Z'
        )
      `).run();
      const env = makeAttentionEnv(database, {
        APNS_KEY: "test-key",
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      expect(sendPush).toHaveBeenCalledTimes(1);

      database.native.prepare(`
        delete from attention_delivery_receipts
        where user_id = 'account-a' and item_id = ?
      `).run(parsed.id);
      database.native.prepare(`
        update attention_presence
        set payload_json = ?
        where user_id = 'account-a' and device_id = 'desktop-1'
      `).run(JSON.stringify({
        platform: "macOS",
        appForeground: true,
        ambientSurfaceVisible: true,
        visibleItemIds: [parsed.id],
      }));
      sendPush.mockClear();

      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      expect(sendPush).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-07-28T08:00:40.000Z"));
      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(rows(database, `
        select state
        from attention_delivery_receipts
        where user_id = 'account-a' and item_id = ? and device_id = 'phone-1'
      `, parsed.id)).toHaveLength(1);

      vi.setSystemTime(new Date("2026-07-28T08:00:41.000Z"));
      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      expect(sendPush).toHaveBeenCalledTimes(1);

      database.native.prepare(`
        delete from attention_delivery_receipts
        where user_id = 'account-a' and item_id = ?
      `).run(parsed.id);
      database.native.prepare(`
        update attention_items
        set seen_at = '2026-07-28T08:00:41.000Z'
        where user_id = 'account-a' and item_id = ?
      `).run(parsed.id);
      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      expect(sendPush).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("isolates a notification transport exception to the failing device", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const sendPush = vi.fn()
      .mockRejectedValueOnce(new Error("transient APNs network failure"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        apnsId: "second-phone",
        reason: null,
        tokenInvalid: false,
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        apnsToken: "ab".repeat(32),
      });
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-2",
        apnsToken: "cd".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      await attentionTestInternals.deliverAttentionNotifications(
        makeAttentionEnv(database, {
          APNS_KEY: "test-key",
          APNS_KEY_ID: "TESTKEY123",
          APNS_TEAM_ID: "TESTTEAM12",
        }),
        "account-a",
        [parsed],
        sendPush,
      );

      expect(sendPush).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("attention_delivery_error"),
      );
      expect(rows(database, `
        select device_id
        from attention_delivery_receipts
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)).toEqual([{ device_id: "phone-2" }]);
    } finally {
      database.close();
    }
  });

  it("claims notification delivery so concurrent heartbeats cannot duplicate an alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    let finishPush: (result: {
      ok: boolean;
      status: number;
      apnsId: string;
      reason: null;
      tokenInvalid: boolean;
    }) => void = () => {};
    const sendPush = vi.fn(() => new Promise<{
      ok: boolean;
      status: number;
      apnsId: string;
      reason: null;
      tokenInvalid: boolean;
    }>((resolve) => {
      finishPush = resolve;
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        apnsToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      const env = makeAttentionEnv(database, {
        APNS_KEY: "test-key",
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      const first = attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      await vi.waitFor(() => expect(sendPush).toHaveBeenCalledTimes(1));
      const concurrent = attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendPush,
      );
      await concurrent;
      expect(sendPush).toHaveBeenCalledTimes(1);

      finishPush({
        ok: true,
        status: 200,
        apnsId: "only-alert",
        reason: null,
        tokenInvalid: false,
      });
      await first;
      expect(rows(database, `
        select state
        from attention_delivery_receipts
        where user_id = 'account-a' and item_id = ? and device_id = 'phone-1'
      `, parsed.id)).toEqual([{ state: `alert:${parsed.fingerprint.slice(0, 48)}` }]);
    } finally {
      database.close();
    }
  });

  it("continues Live Activity delivery after one device transport throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("ab".repeat(32))) {
        throw new Error("transient APNs network failure");
      }
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "second-live-activity" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
      });
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-2",
        pushToStartToken: "cd".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      await attentionTestInternals.deliverAccountLiveActivity(
        makeAttentionEnv(database, {
          APNS_KEY: await generateTestP8(),
          APNS_KEY_ID: "TESTKEY123",
          APNS_TEAM_ID: "TESTTEAM12",
        }),
        "account-a",
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toBeUndefined();
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-2'
      `)).toEqual({ started: 1 });
    } finally {
      database.close();
    }
  });

  it("restarts active work after APNs invalidates an existing Live Activity token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const apnsBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      apnsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return apnsBodies.length === 1
        ? Response.json({ reason: "Unregistered" }, { status: 410 })
        : new Response(null, {
            status: 200,
            headers: { "apns-id": "replacement-live-activity" },
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-1', 'agent-runs', ?, '2026-07-28T08:00:00.000Z'
        )
      `).run("cd".repeat(32));
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'phone-1', 'agent-runs', 1,
          'stale-fingerprint', '2026-07-28T08:00:00.000Z'
        )
      `).run();
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toBeUndefined();
      expect(row(database, `
        select token
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toBeUndefined();

      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies.map((body) =>
        (body.aps as Record<string, unknown>).event
      )).toEqual(["update", "start"]);
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toEqual({ started: 1 });
    } finally {
      database.close();
    }
  });

  it("fences every account-wide ActivityKit event to the active device ownership epoch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const apnsBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      apnsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, {
        status: 200,
        headers: { "apns-id": `ownership-${apnsBodies.length}` },
      });
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
        ownershipEpoch: 101,
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies[0]).toMatchObject({
        aps: {
          event: "start",
          attributes: {
            accountWide: true,
            ownershipEpoch: 101,
          },
          "content-state": {
            ownershipEpoch: 101,
          },
        },
      });

      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-1', 'agent-runs', ?, '2026-07-28T08:01:01.000Z'
        )
      `).run("cd".repeat(32));
      const updated = {
        ...parsed,
        fingerprint: "ownership-update",
        revision: parsed.revision + 1,
        updatedAt: "2026-07-28T08:01:02.000Z",
      };
      database.native.prepare(`
        update attention_items
        set source_revision = ?, fingerprint = ?, payload_json = ?, updated_at = ?
        where user_id = 'account-a' and item_id = ?
      `).run(
        updated.revision,
        updated.fingerprint,
        JSON.stringify(updated),
        updated.updatedAt,
        updated.id,
      );
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies[1]).toMatchObject({
        aps: {
          event: "update",
          "content-state": {
            ownershipEpoch: 101,
          },
        },
      });

      database.native.prepare(`
        update attention_items
        set seen_at = '2026-07-28T08:01:03.000Z',
          dismissed_at = '2026-07-28T08:01:03.000Z'
        where user_id = 'account-a' and item_id = ?
      `).run(parsed.id);
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies[2]).toMatchObject({
        aps: {
          event: "end",
          "content-state": {
            ownershipEpoch: 101,
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("refuses a stale prior-account device row after ownership transfers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const apnsBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      apnsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "new-owner" },
      });
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
        ownershipEpoch: 101,
      });
      for (const userId of ["account-a", "account-b"]) {
        database.native.prepare(`
          insert into attention_items(
            user_id, item_id, machine_key, source_revision, account_revision,
            fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
            expires_at, updated_at
          ) values (
            ?, ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
          )
        `).run(
          userId,
          parsed.id,
          MACHINE_KEY,
          parsed.revision,
          parsed.fingerprint,
          parsed.eventKind,
          parsed.phase,
          JSON.stringify(parsed),
          parsed.expiresAt,
          parsed.updatedAt,
        );
      }
      database.native.prepare(`
        update attention_device_ownership
        set user_id = 'account-b', ownership_epoch = 202, active = 1
        where device_id = 'phone-1'
      `).run();
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      // A delayed account-A delivery sees the stale device row but cannot join
      // it to account B's newer ownership epoch.
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies).toEqual([]);

      database.native.prepare(`
        update attention_devices
        set user_id = 'account-b'
        where user_id = 'account-a' and device_id = 'phone-1'
      `).run();
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-b");
      expect(apnsBodies[0]).toMatchObject({
        aps: {
          event: "start",
          attributes: {
            ownershipEpoch: 202,
          },
          "content-state": {
            ownershipEpoch: 202,
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("applies account delivery and privacy settings above registration defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const sendNotification = vi.fn(async () => ({
      ok: true,
      status: 200,
      apnsId: "notification-id",
      reason: null,
      tokenInvalid: false,
    }));
    const liveActivityPushes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      liveActivityPushes.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "privacy-start" },
      });
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        apnsToken: "ab".repeat(32),
        pushToStartToken: "cd".repeat(32),
        preferences: {
          enabled: true,
          liveActivitiesEnabled: true,
          hideDetails: false,
        },
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_preferences(user_id, payload_json, updated_at)
        values ('account-a', ?, '2026-07-28T08:00:00.000Z')
      `).run(JSON.stringify({
        account: {
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          hideDetails: true,
        },
        devices: {},
      }));
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "PREFSKEY12",
        APNS_TEAM_ID: "PREFSTEAM1",
      });

      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [parsed],
        sendNotification,
      );
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(sendNotification).not.toHaveBeenCalled();
      expect(liveActivityPushes).toHaveLength(0);

      database.native.prepare(`
        update attention_preferences
        set payload_json = ?
        where user_id = 'account-a'
      `).run(JSON.stringify({
        account: {
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          hideDetails: true,
        },
        devices: {
          "phone-1": {
            liveActivitiesEnabled: true,
          },
        },
      }));
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");

      expect(liveActivityPushes).toHaveLength(1);
      expect(liveActivityPushes[0]).toMatchObject({
        aps: {
          event: "start",
          alert: {
            title: "ADE activity started",
          },
          "content-state": {
            runs: [{
              title: "Agent activity",
              model: null,
              lane: null,
              detail: null,
            }],
          },
        },
      });
    } finally {
      database.close();
    }
  });

  it("does not notify for an inbound item rejected by the committed account state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const stale = attentionTestInternals.parseAttentionItem(
      validAgentItem(),
      MACHINE_KEY,
    );
    expect(stale).not.toBeNull();
    if (!stale) {
      database.close();
      return;
    }
    const currentRaw = validAgentItem();
    currentRaw.revision = stale.revision + 1;
    currentRaw.fingerprint = "newer-fingerprint";
    currentRaw.updatedAt = "2026-07-28T08:00:30.000Z";
    const current = attentionTestInternals.parseAttentionItem(
      currentRaw,
      MACHINE_KEY,
    );
    expect(current).not.toBeNull();
    if (!current) {
      database.close();
      return;
    }
    const sendPush = vi.fn(async () => ({
      ok: true,
      status: 200,
      apnsId: "apns-id",
      reason: null,
      tokenInvalid: false,
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        apnsToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 2, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        current.id,
        MACHINE_KEY,
        current.revision,
        current.fingerprint,
        current.eventKind,
        current.phase,
        JSON.stringify(current),
        current.expiresAt,
        current.updatedAt,
      );
      const env = makeAttentionEnv(database, {
        APNS_KEY: "test-key",
        APNS_KEY_ID: "TESTKEY123",
        APNS_TEAM_ID: "TESTTEAM12",
      });

      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [stale],
        sendPush,
      );
      expect(sendPush).not.toHaveBeenCalled();

      database.native.prepare(`
        delete from attention_items
        where user_id = 'account-a' and item_id = ?
      `).run(current.id);
      await attentionTestInternals.deliverAttentionNotifications(
        env,
        "account-a",
        [stale],
        sendPush,
      );
      expect(sendPush).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("redacts lock-screen content without breaking exact PR routing metadata", () => {
    const privateState = attentionTestInternals.privacyPreservingActivityContentState({
      updatedAt: 1_752_000_000,
      activeCount: 2,
      runs: [{
        id: "session-1",
        title: "Secret customer migration",
        phase: "needs_you",
        model: "gpt-5",
        lane: "secret-client",
        detail: "Approve production access",
      }],
      prs: [{
        id: "pr-42",
        prNumber: 42,
        title: "Fix private authentication bug",
        phase: "review_requested",
        lane: "security",
        repoOwner: "private-owner",
        repoName: "private-repo",
      }],
    });

    expect(privateState).toMatchObject({
      runs: [{
        id: "session-1",
        title: "Agent activity",
        phase: "needs_you",
        model: null,
        lane: null,
        detail: null,
      }],
      prs: [{
        id: "pr-42",
        prNumber: 42,
        title: "Pull request #42",
        phase: "review_requested",
        lane: null,
        repoOwner: "private-owner",
        repoName: "private-repo",
      }],
    });
  });

  it("redacts notification titles as well as bodies when previews are hidden", () => {
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("setup precondition: agent Attention item must parse");

    expect(attentionTestInternals.notificationTitle(parsed, false)).toBe(
      "Approve the migration",
    );
    expect(attentionTestInternals.notificationTitle(parsed, true)).toBe(
      "ADE agent update",
    );

    const pullRequest = {
      ...parsed,
      kind: "pull_request",
    } as typeof parsed;
    expect(attentionTestInternals.notificationTitle(pullRequest, true)).toBe(
      "ADE pull request update",
    );
  });

  it("keeps exact account-machine routing in cross-machine alerts and Live Activity rows", () => {
    const firstRaw = validAgentItem();
    const first = attentionTestInternals.parseAttentionItem(firstRaw, MACHINE_KEY);
    expect(first).not.toBeNull();
    if (!first) throw new Error("setup precondition: first Attention item must parse");

    const otherMachineKey = "b".repeat(32);
    const otherAccountMachineKey = "d".repeat(32);
    const secondRaw = {
      ...validAgentItem(),
      id: `agent:${otherMachineKey}:session-2`,
      machine: {
        machineKey: otherMachineKey,
        accountMachineKey: otherAccountMachineKey,
        name: "MacBook",
      },
      destination: {
        kind: "session",
        sessionId: "session-2",
      },
    };
    const second = attentionTestInternals.parseAttentionItem(
      secondRaw,
      otherMachineKey,
    );
    expect(second).not.toBeNull();
    if (!second) throw new Error("setup precondition: second Attention item must parse");

    const firstDeepLink = attentionTestInternals.deepLinkForItem(first);
    const secondDeepLink = attentionTestInternals.deepLinkForItem(second);
    expect(firstDeepLink).toContain(`accountMachineKey=${"c".repeat(32)}`);
    expect(secondDeepLink).toContain(`accountMachineKey=${otherAccountMachineKey}`);
    expect(
      attentionTestInternals.attentionAlertRoutingPayload(first, firstDeepLink),
    ).toMatchObject({
      accountMachineKey: "c".repeat(32),
      sessionId: "session-1",
      deepLink: firstDeepLink,
    });
    expect(
      attentionTestInternals.attentionAlertRoutingPayload(second, secondDeepLink),
    ).toMatchObject({
      accountMachineKey: otherAccountMachineKey,
      sessionId: "session-2",
      deepLink: secondDeepLink,
    });
    expect(attentionTestInternals.activityRun(first)).toMatchObject({
      id: "session-1",
      accountMachineKey: "c".repeat(32),
    });

    const pullRequestRaw = {
      ...secondRaw,
      id: `pull-request:${otherMachineKey}:private-owner:private-repo:42`,
      kind: "pull_request",
      eventKind: "pr_checks_failing",
      phase: "checks_failing",
      destination: {
        kind: "pull_request",
        repoOwner: "private-owner",
        repoName: "private-repo",
        number: 42,
        tab: "checks",
      },
    };
    const pullRequest = attentionTestInternals.parseAttentionItem(
      pullRequestRaw,
      otherMachineKey,
    );
    expect(pullRequest).not.toBeNull();
    if (!pullRequest) {
      throw new Error("setup precondition: pull request Attention item must parse");
    }
    expect(attentionTestInternals.activityPullRequest(pullRequest)).toMatchObject({
      prNumber: 42,
      accountMachineKey: otherAccountMachineKey,
    });
    const pullRequestDeepLink = attentionTestInternals.deepLinkForItem(pullRequest);
    expect(pullRequestDeepLink).toContain("tab=checks");
    expect(pullRequestDeepLink).toContain(
      `accountMachineKey=${otherAccountMachineKey}`,
    );
  });

  it("requires ownershipEpoch to be a positive safe JSON integer", async () => {
    const database = new SqliteD1Database();
    try {
      for (const ownershipEpoch of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        const response = await accountRoute(
          database,
          "account-a",
          "PUT",
          "/attention/account/devices/phone-1",
          {
            ownershipEpoch,
            apnsToken: "90".repeat(32),
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
          },
        );
        expect(response.status).toBe(400);
      }
    } finally {
      database.close();
    }
  });

  it("preserves an omitted account push-to-start token and clears it explicitly", async () => {
    const database = new SqliteD1Database();
    const path = "/attention/account/devices/phone-token-clear";
    const register = (body: Record<string, unknown>) => accountRoute(
      database,
      "account-a",
      "PUT",
      path,
      {
        ownershipEpoch: 1,
        bundleId: "com.ade.ios",
        apsEnvironment: "sandbox",
        ...body,
      },
    );
    try {
      expect((await register({ pushToStartToken: "ab".repeat(32) })).status).toBe(200);
      expect((await register({})).status).toBe(200);
      expect(row(database, `
        select push_to_start_token
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-token-clear'
      `)?.push_to_start_token).toBe("ab".repeat(32));

      expect((await register({ clearPushToStartToken: true })).status).toBe(200);
      expect(row(database, `
        select push_to_start_token
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-token-clear'
      `)?.push_to_start_token).toBeNull();

      expect((await register({
        pushToStartToken: "cd".repeat(32),
        clearPushToStartToken: true,
      })).status).toBe(400);
    } finally {
      database.close();
    }
  });

  it("atomically clears account Live Activity state and starts unchanged work after re-registration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:10.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    const liveActivityPushes: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      liveActivityPushes.push({
        url: input instanceof Request ? input.url : String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(null, {
        status: 200,
        headers: { "apns-id": "re-enabled-start" },
      });
    }));
    const env = makeAttentionEnv(database, {
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "REENABLE12",
      APNS_TEAM_ID: "REENABLE1",
    });
    const register = async (body: Record<string, unknown>): Promise<Response> => {
      const request = new Request(
        "https://push.example/attention/account/devices/phone-reenable",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownershipEpoch: 1,
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
            platform: "iOS",
            ...body,
          }),
        },
      );
      const response = await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
        request,
        env,
        new URL(request.url),
        "account-a",
      );
      if (!response) throw new Error("Attention device route was not handled");
      return response;
    };

    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-reenable",
        pushToStartToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?
        )
      `).run(
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-reenable', 'agent-runs', ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("ef".repeat(32));
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'phone-reenable', 'agent-runs', 1, ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("old-fingerprint");

      database.failNextBatchAt(3);
      await expect(register({ clearPushToStartToken: true })).rejects.toThrow(
        "injected batch failure at statement 3",
      );
      expect(row(database, `
        select push_to_start_token
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)?.push_to_start_token).toBe("ab".repeat(32));
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)).toHaveLength(1);
      expect(rows(database, `
        select activity_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)).toHaveLength(1);

      expect((await register({ clearPushToStartToken: true })).status).toBe(200);
      expect(row(database, `
        select push_to_start_token
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)?.push_to_start_token).toBeNull();
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)).toHaveLength(0);
      expect(rows(database, `
        select activity_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-reenable'
      `)).toHaveLength(0);
      expect(liveActivityPushes).toHaveLength(0);

      expect((await register({ pushToStartToken: "cd".repeat(32) })).status).toBe(200);
      expect(liveActivityPushes).toHaveLength(1);
      expect(liveActivityPushes[0]?.url).toContain("cd".repeat(32));
      expect(liveActivityPushes[0]?.body).toMatchObject({
        aps: {
          event: "start",
          "input-push-token": 1,
        },
      });
      expect(row(database, `
        select started
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'phone-reenable'
          and activity_id = 'agent-runs'
      `)?.started).toBe(1);
    } finally {
      database.close();
    }
  });

  it("accepts the ownership epoch future boundary and rejects values beyond it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      const maximumAcceptedEpoch = Date.now() + 5 * 60 * 1_000;
      const accepted = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-boundary",
        {
          ownershipEpoch: maximumAcceptedEpoch,
          apnsToken: "91".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(accepted.status).toBe(200);

      const rejected = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-too-far",
        {
          ownershipEpoch: maximumAcceptedEpoch + 1,
          apnsToken: "92".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        ok: false,
        error: "invalid ownership epoch",
      });
    } finally {
      database.close();
    }
  });

  it("persists only the consumed presence fields", async () => {
    const database = new SqliteD1Database();
    try {
      const observedAt = "2026-07-28T08:00:00.000Z";
      const response = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/presence",
        {
          deviceId: "desktop-1",
          deviceName: "Studio",
          platform: "macOS",
          appForeground: true,
          ambientSurfaceVisible: true,
          visibleItemIds: ["agent-1", "", "agent-2"],
          observedAt,
          untrusted: "x".repeat(300_000),
        },
      );
      expect(response.status).toBe(200);

      const presence = row<{ payload_json: string }>(database, `
        select payload_json
        from attention_presence
        where user_id = 'account-a' and device_id = 'desktop-1'
      `);
      expect(JSON.parse(presence?.payload_json ?? "{}")).toEqual({
        deviceId: "desktop-1",
        platform: "macOS",
        appForeground: true,
        observedAt,
        visibleItemIds: ["agent-1", "agent-2"],
      });
      expect(presence?.payload_json.length).toBeLessThan(1_000);
    } finally {
      database.close();
    }
  });

  it("imports legacy routes once without reclaiming a phone that changed accounts", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const legacyToken = "ab".repeat(32);
    try {
      database.native.prepare(`
        insert into machines(machine_key, secret, created_at, last_seen_at)
        values (?, 'relay-secret', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY);
      database.native.prepare(`
        insert into device_registrations(
          machine_key, device_id, apns_token, push_to_start_token, bundle_id,
          aps_environment, platform, device_name, registered_at, updated_at
        ) values (?, 'phone-1', ?, null, 'com.ade.ios', 'sandbox', 'iOS',
          'Phone', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY, legacyToken);
      database.native.prepare(`
        insert into live_activity_tokens(
          machine_key, device_id, activity_id, token, updated_at
        ) values (?, 'phone-1', 'account-attention', ?, '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY, "cd".repeat(32));

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_machine_key
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-1'
      `)?.source_machine_key).toBe(MACHINE_KEY);
      expect(row(database, `
        select legacy_devices_imported_at
        from attention_machine_links
        where machine_key = ?
      `, MACHINE_KEY)?.legacy_devices_imported_at).toEqual(expect.any(String));
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toHaveLength(1);

      const transfer = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        {
          ownershipEpoch: 2,
          apnsToken: legacyToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
          platform: "iOS",
        },
      );
      expect(transfer.status).toBe(200);

      // A later machine heartbeat cannot use stale machine pairing data to
      // transfer the phone or its Live Activity route back to account A.
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-b");
      expect(rows(database, `
        select *
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("preserves source revisions on relink tombstones and permits a fresh-owner revival", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const itemId = `agent:${MACHINE_KEY}:session-1`;
    try {
      database.native.prepare(`
        insert into machines(machine_key, secret, created_at, last_seen_at)
        values (?, 'relay-secret', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY);
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T08:00:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 4, 'fingerprint-7', 'agent_running',
          'running', '{}', null, null, null, '2026-07-28T08:00:00.000Z'
        )
      `).run(itemId, MACHINE_KEY);

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_revision
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId)?.source_revision).toBe(7);

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_revision
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back machine-transfer tombstones with their prior-account cursor", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const parsed = attentionTestInternals.parseAttentionItem(
      validAgentItem(),
      MACHINE_KEY,
    );
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T07:59:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (?, ?, ?, ?, 4, ?, ?, ?, ?, null, null, ?, ?)
      `).run(
        "account-a",
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      database.failNextBatchAt(2);
      await expect(attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      )).rejects.toThrow("injected batch failure at statement 2");

      expect(row(database, `
        select revision
        from attention_revisions
        where user_id = 'account-a'
      `)?.revision).toBe(4);
      expect(row(database, `
        select account_revision
        from attention_items
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.account_revision).toBe(4);
      expect(rows(database, `
        select item_id
        from attention_tombstones
        where user_id = 'account-a'
      `)).toEqual([]);
      expect(row(database, `
        select user_id
        from attention_machine_links
        where machine_key = ?
      `, MACHINE_KEY)?.user_id).toBe("account-a");
    } finally {
      database.close();
    }
  });

  it("ends the previous account aggregate when a linked machine transfers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:00.000Z"));
    const database = new SqliteD1Database();
    const sendPush = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(null, {
      status: 200,
      headers: { "apns-id": "transfer-end" },
    }));
    vi.stubGlobal("fetch", sendPush);
    const env = makeAttentionEnv(database, {
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "MOVEKEY123",
      APNS_TEAM_ID: "MOVETEAM1",
    });
    const parsed = attentionTestInternals.parseAttentionItem(
      validAgentItem(),
      MACHINE_KEY,
    );
    expect(parsed).not.toBeNull();
    if (!parsed) {
      database.close();
      return;
    }
    try {
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "remaining-phone",
        apnsToken: "ab".repeat(32),
      });
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'remaining-phone', 'agent-runs', 1, 'old-fingerprint',
          '2026-07-28T08:00:00.000Z'
        )
      `).run();
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'remaining-phone', 'agent-runs', ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("cd".repeat(32));
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (?, ?, ?, ?, 1, ?, ?, ?, ?, null, null, ?, ?)
      `).run(
        "account-a",
        parsed.id,
        MACHINE_KEY,
        parsed.revision,
        parsed.fingerprint,
        parsed.eventKind,
        parsed.phase,
        JSON.stringify(parsed),
        parsed.expiresAt,
        parsed.updatedAt,
      );

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );

      expect(sendPush).toHaveBeenCalledTimes(1);
      const request = sendPush.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        aps: {
          event: "end",
          "content-state": {
            activeCount: 0,
            runs: [],
            prs: [],
          },
        },
      });
      expect(rows(database, `
        select *
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'remaining-phone'
      `)).toHaveLength(0);
      expect(row(database, `
        select revivable
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.revivable).toBe(0);
    } finally {
      database.close();
    }
  });

  it("checks destination quota before an atomic ownership transfer and renews the lease", async () => {
    const database = new SqliteD1Database();
    const transferToken = "ef".repeat(32);
    try {
      for (let index = 0; index < 32; index += 1) {
        insertAttentionDevice(database, {
          userId: "account-b",
          deviceId: `existing-${index}`,
        });
      }
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      database.native.prepare(`
        insert into attention_presence(user_id, device_id, payload_json, observed_at)
        values ('account-a', 'phone-transfer', '{}', '2026-07-28T08:00:00.000Z')
      `).run();

      const rejected = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(rejected.status).toBe(409);
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select device_id from attention_devices where user_id = 'account-b'
      `)).toHaveLength(32);
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(1);

      database.native.prepare(`
        delete from attention_devices
        where user_id = 'account-b' and device_id = 'existing-31'
      `).run();
      const transferred = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(transferred.status).toBe(200);
      const transferredRow = row<{
        user_id: string;
        lease_expires_at: string;
      }>(database, `
        select user_id, lease_expires_at
        from attention_devices
        where device_id = 'phone-transfer'
      `);
      expect(transferredRow?.user_id).toBe("account-b");
      expect(Date.parse(transferredRow?.lease_expires_at ?? "")).toBeGreaterThan(
        Date.now() + 29 * 24 * 60 * 60 * 1_000,
      );
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back the previous owner when the destination insert fails", async () => {
    const database = new SqliteD1Database();
    const transferToken = "12".repeat(32);
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-transfer', 'account-attention', ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("34".repeat(32));
      database.native.exec(`
        create trigger reject_account_b_device
        before insert on attention_devices
        when new.user_id = 'account-b'
        begin
          select raise(abort, 'simulated destination failure');
        end
      `);

      await expect(accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      )).rejects.toThrow("simulated destination failure");
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rolls back a transfer if the destination fills after the quota precheck", async () => {
    const database = new SqliteD1Database();
    const transferToken = "56".repeat(32);
    try {
      for (let index = 0; index < 31; index += 1) {
        insertAttentionDevice(database, {
          userId: "account-b",
          deviceId: `existing-${index}`,
        });
      }
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      const originalBatch = database.batch.bind(database);
      let injectedConcurrentRegistration = false;
      database.batch = async (statements) => {
        if (!injectedConcurrentRegistration) {
          injectedConcurrentRegistration = true;
          insertAttentionDevice(database, {
            userId: "account-b",
            deviceId: "concurrent-phone",
          });
        }
        return await originalBatch(statements);
      };

      const response = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );

      expect(response.status).toBe(409);
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select device_id from attention_devices where user_id = 'account-b'
      `)).toHaveLength(32);
      expect(row(database, `
        select user_id, ownership_epoch
        from attention_device_ownership
        where device_id = 'phone-transfer'
      `)).toMatchObject({
        user_id: "account-a",
        ownership_epoch: 1,
      });
    } finally {
      database.close();
    }
  });

  it("atomically rejects an ownership switch superseded during its precheck", async () => {
    const database = new SqliteD1Database();
    const apnsToken = "67".repeat(32);
    const registration = {
      apnsToken,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    };
    try {
      const firstOwner = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(firstOwner.status).toBe(200);

      const originalBatch = database.batch.bind(database);
      let injectedNewerOwner = false;
      database.batch = async (statements) => {
        if (!injectedNewerOwner) {
          injectedNewerOwner = true;
          database.batch = originalBatch;
          const newer = await accountRoute(
            database,
            "account-c",
            "PUT",
            "/attention/account/devices/phone-1",
            { ...registration, ownershipEpoch: 3 },
          );
          expect(newer.status).toBe(200);
        }
        return await originalBatch(statements);
      };

      const superseded = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(superseded.status).toBe(409);
      expect(await superseded.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 3,
      });
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-c");
      expect(row(database, `
        select user_id, ownership_epoch, active
        from attention_device_ownership
        where device_id = 'phone-1'
      `)).toMatchObject({
        user_id: "account-c",
        ownership_epoch: 3,
        active: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects delayed old-account PUT and DELETE after switch, deletion, and revival", async () => {
    const database = new SqliteD1Database();
    const apnsToken = "78".repeat(32);
    const registration = {
      apnsToken,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    };
    try {
      const firstOwner = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(firstOwner.status).toBe(200);

      const equalEpochOtherOwner = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(equalEpochOtherOwner.status).toBe(409);
      expect(await equalEpochOtherOwner.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 1,
      });

      const switched = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(switched.status).toBe(200);

      const removed = await accountRoute(
        database,
        "account-b",
        "DELETE",
        "/attention/account/devices/phone-1",
        { ownershipEpoch: 2, apnsToken },
      );
      expect(removed.status).toBe(200);
      expect(row(database, `
        select user_id, ownership_epoch, active
        from attention_device_ownership
        where device_id = 'phone-1'
      `)).toMatchObject({
        user_id: "account-b",
        ownership_epoch: 2,
        active: 0,
      });
      expect(rows(database, `
        select device_id from attention_devices where device_id = 'phone-1'
      `)).toHaveLength(0);

      const revived = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(revived.status).toBe(200);

      const delayedPut = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(delayedPut.status).toBe(409);
      expect(await delayedPut.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 2,
      });

      // A changed local install id still cannot reclaim a newer APNs route.
      const delayedRoutePut = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/reinstalled-phone",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(delayedRoutePut.status).toBe(409);
      expect((await delayedRoutePut.json()) as Record<string, unknown>).toMatchObject({
        ownershipEpoch: 2,
      });

      const staleDelete = await accountRoute(
        database,
        "account-a",
        "DELETE",
        "/attention/account/devices/phone-1",
        { ownershipEpoch: 1, apnsToken },
      );
      expect(staleDelete.status).toBe(409);
      expect((await staleDelete.json()) as Record<string, unknown>).toMatchObject({
        ownershipEpoch: 2,
      });
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-b");
    } finally {
      database.close();
    }
  });

  it("prunes an expired lease and all device-owned account state", async () => {
    const database = new SqliteD1Database();
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "expired-phone",
        leaseExpiresAt: "2026-01-01T00:00:00.000Z",
      });
      database.native.prepare(`
        insert into attention_presence(user_id, device_id, payload_json, observed_at)
        values ('account-a', 'expired-phone', '{}', '2026-07-28T08:00:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'expired-phone', 'account-attention', 1, null,
          '2026-07-28T08:00:00.000Z'
        )
      `).run();

      await pruneAttentionState(makeAttentionEnv(database));

      expect(rows(database, `
        select device_id
        from attention_devices
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(rows(database, `
        select device_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(row(database, `
        select ownership_epoch, active
        from attention_device_ownership
        where device_id = 'expired-phone'
      `)).toMatchObject({
        ownership_epoch: 1,
        active: 0,
      });
    } finally {
      database.close();
    }
  });

  it("prunes delivery receipts without live Attention state for renewed devices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "active-phone",
        leaseExpiresAt: "2026-09-01T00:00:00.000Z",
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values
          (
            'account-a', 'expired-item', ?, 1, 1, 'expired-fingerprint',
            'agent_needs_you', 'needs_you', '{}', null, null,
            '2026-07-28T11:59:59.000Z', '2026-07-28T11:00:00.000Z'
          ),
          (
            'account-a', 'active-item', ?, 1, 2, 'active-fingerprint',
            'agent_needs_you', 'needs_you', '{}', null, null,
            '2026-07-29T12:00:00.000Z', '2026-07-28T11:00:00.000Z'
          )
      `).run(MACHINE_KEY, MACHINE_KEY);
      database.native.prepare(`
        insert into attention_delivery_receipts(
          user_id, item_id, device_id, state, delivered_at
        ) values
          ('account-a', 'expired-item', 'active-phone', 'alert:expired', '2026-07-28T11:00:00.000Z'),
          ('account-a', 'active-item', 'active-phone', 'alert:active', '2026-07-28T11:00:00.000Z'),
          ('account-a', 'removed-item', 'active-phone', 'alert:removed', '2026-07-28T11:00:00.000Z')
      `).run();

      await pruneAttentionState(makeAttentionEnv(database));

      expect(rows(database, `
        select item_id
        from attention_delivery_receipts
        where user_id = 'account-a' and device_id = 'active-phone'
        order by item_id
      `)).toEqual([{ item_id: "active-item" }]);
      expect(rows(database, `
        select item_id
        from attention_items
        where user_id = 'account-a'
        order by item_id
      `)).toEqual([{ item_id: "active-item" }]);
      expect(row(database, `
        select lease_expires_at
        from attention_devices
        where user_id = 'account-a' and device_id = 'active-phone'
      `)?.lease_expires_at).toBe("2026-09-01T00:00:00.000Z");
    } finally {
      database.close();
    }
  });
});
