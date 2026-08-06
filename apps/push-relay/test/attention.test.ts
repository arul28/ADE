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
  machineKeyRevokedAt,
  pruneAttentionState,
  sweepAttentionState,
  type AttentionRelayEnv,
} from "../src/attention";
import { verifyAttentionBearerToken } from "../src/attentionAuth";
import {
  handleRequest,
  resetSpendGuardsForTests,
  signPushRelayRequest,
  type PushRelayEnv,
} from "../src/relay";
import { liveActivityTestInternals } from "../src/liveActivity";

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
        "../migrations/0005_activity_feed.sql",
        "../migrations/0006_machine_revocation.sql",
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

/** The value both workers hold; the directory presents it on relay hand-offs. */
const DIRECTORY_AUTH_SECRET = "directory-shared-secret";

/**
 * Everything the hourly cron does, in the order `index.ts` does it. Retention
 * assertions go through this rather than `pruneAttentionState` alone: the
 * sweeps are cron-only by design (they fan out per account into APNs pushes)
 * and must never be reachable from a user-facing request.
 */
async function runAttentionMaintenance(env: AttentionRelayEnv): Promise<void> {
  await sweepAttentionState(env);
  await pruneAttentionState(env);
}

async function accountRoute(
  database: SqliteD1Database,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  options: {
    headers?: Record<string, string>;
    env?: Omit<Partial<AttentionRelayEnv>, "DB">;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`https://push.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
    request,
    makeAttentionEnv(database, { DIRECTORY_AUTH_SECRET, ...options.env }),
    new URL(request.url),
    userId,
  );
  if (!response) throw new Error(`Attention route did not handle ${method} ${path}`);
  return response;
}

/** An account route called the way the account-directory worker calls it. */
async function directoryRoute(
  database: SqliteD1Database,
  userId: string,
  method: string,
  path: string,
): Promise<Response> {
  return accountRoute(database, userId, method, path, undefined, {
    headers: { "x-ade-directory-auth": DIRECTORY_AUTH_SECRET },
  });
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
    args.leaseExpiresAt ?? "2099-09-01T08:00:00.000Z",
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

/**
 * The `/claim` row every machine that can use the SIGNED push routes holds —
 * `assertMachineAuthorized` verifies against its secret. Those are exactly the
 * machines `machineKeyRevokedAt` can block, and `linkMachineToAccount` stamps
 * `account_user_id` on this row on every publish, so it is the record of prior
 * ownership that survives an account removal (which deletes the link row).
 */
function claimMachineForAccount(
  database: SqliteD1Database,
  accountUserId: string | null,
  machineKey = MACHINE_KEY,
): void {
  database.native.prepare(`
    insert into machines(machine_key, secret, created_at, last_seen_at, account_user_id)
    values (?, 'relay-secret', '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z', ?)
    on conflict(machine_key) do update set account_user_id = excluded.account_user_id
  `).run(machineKey, accountUserId);
}

/**
 * A phone reachable through the LEGACY machine-signed routes. These two tables
 * are keyed by machine key alone — no account id — which is exactly why they
 * have to leave when the machine changes hands.
 */
function seedLegacyMachineDelivery(
  database: SqliteD1Database,
  args: { deviceId: string; machineKey?: string },
): void {
  const machineKey = args.machineKey ?? MACHINE_KEY;
  const now = "2026-07-28T08:00:00.000Z";
  database.native.prepare(`
    insert into device_registrations(
      machine_key, device_id, apns_token, push_to_start_token, bundle_id,
      aps_environment, platform, device_name, registered_at, updated_at
    ) values (?, ?, ?, ?, 'com.ade.ios', 'sandbox', 'iOS', 'Phone', ?, ?)
  `).run(machineKey, args.deviceId, "ab".repeat(32), "ef".repeat(32), now, now);
  database.native.prepare(`
    insert into live_activity_tokens(
      machine_key, device_id, activity_id, token, updated_at
    ) values (?, ?, 'account-attention', ?, ?)
  `).run(machineKey, args.deviceId, "cd".repeat(32), now);
}

function makeLegacyRelayEnv(
  database: SqliteD1Database,
  overrides: Omit<Partial<PushRelayEnv>, "DB"> = {},
): PushRelayEnv {
  return {
    DB: database as unknown as D1Database,
    APNS_KEY_ID: "LEGACYKEY1",
    APNS_TEAM_ID: "LEGACYTEAM",
    APNS_DEFAULT_TOPIC: "com.ade.ios",
    ...overrides,
  };
}

/** A legacy machine-signed call, signed with the secret `claimMachineForAccount` stores. */
async function legacyRelayRequest(
  env: PushRelayEnv,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signPushRelayRequest("relay-secret", {
    timestamp,
    method,
    pathname,
    body: payload,
  });
  return await handleRequest(
    new Request(`https://push.example${pathname}`, {
      method,
      headers: {
        "x-ade-push-timestamp": timestamp,
        "x-ade-push-signature": signature,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : payload,
    }),
    env,
  );
}

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
    statusSince: "2026-07-28T08:00:00.000Z",
    // Keep the shared fixture live independent of the wall clock. Tests that
    // exercise expiry override this field explicitly.
    expiresAt: "2099-07-29T08:00:05.000Z",
  };
}

async function publishActivityForTest(
  env: AttentionRelayEnv,
  authorization: Awaited<ReturnType<typeof machinePublishAuthorization>>,
  payload: Record<string, unknown>,
  options: { machineKey?: string; verifiedMachineKey?: string } = {},
): Promise<Response> {
  const body = new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer;
  const machineKey = options.machineKey ?? MACHINE_KEY;
  return await handleAttentionMachinePublish(
    new Request("https://push.example/machines/activity/attention", {
      method: "POST",
      headers: { authorization: `Bearer ${authorization.token}` },
    }),
    env,
    machineKey,
    body,
    // What the relay router proves with the machine's HMAC signature before it
    // ever reaches this handler; tests default to the honest case.
    { machineKey: options.verifiedMachineKey ?? machineKey },
  );
}

function activityAgentItem(
  args: {
    sessionId: string;
    itemId: string | null;
    revision: number;
    contentFingerprint: string;
    alertFingerprint: string;
    activityTier?: "signal" | "ambient" | "idle";
    updatedAt?: string;
    expiresAt?: string | null;
    preview?: string;
    eventKind?: "agent_running" | "agent_needs_you";
    phase?: "running" | "needs_you" | "stale";
    statusSince?: string;
  },
): Record<string, unknown> {
  return {
    ...validAgentItem(),
    id: `agent:${MACHINE_KEY}:${args.sessionId}`,
    revision: args.revision,
    fingerprint: args.contentFingerprint,
    contentFingerprint: args.contentFingerprint,
    alertFingerprint: args.alertFingerprint,
    eventKind: args.eventKind ?? "agent_needs_you",
    phase: args.phase ?? "needs_you",
    ...(args.activityTier ? { activityTier: args.activityTier } : {}),
    preview: args.preview ?? "The database migration is ready for review.",
    updatedAt: args.updatedAt ?? "2026-07-28T08:00:05.000Z",
    statusSince: args.statusSince ?? "2026-07-28T08:00:00.000Z",
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    destination: {
      kind: "session",
      sessionId: args.sessionId,
      itemId: args.itemId,
      eventId: `event-${args.itemId}`,
    },
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
      statusSince: "2026-07-28T08:00:00.000Z",
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

    const invalidStatusSince = validAgentItem();
    invalidStatusSince.statusSince = "not-a-date";
    expect(attentionTestInternals.parseAttentionItem(invalidStatusSince, MACHINE_KEY)).toBeNull();
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
        projects: {
          "project-a": {
            hideDetails: true,
          },
        },
        machines: {
          [MACHINE_KEY]: {
            notificationsEnabled: false,
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
            hideDetails: true,
          },
        },
        machines: {
          [MACHINE_KEY]: {
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

  it("preserves dismissal and suppresses re-alert when only content churns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    let notificationSends = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      if (url.startsWith("https://api.sandbox.push.apple.com/")) {
        notificationSends += 1;
        return new Response(null, {
          status: 200,
          headers: { "apns-id": `content-churn-${notificationSends}` },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      insertAttentionDevice(database, {
        userId: authorization.userId,
        deviceId: "phone-content-churn",
        apnsToken: "ab".repeat(32),
      });
      const env = makeAttentionEnv(database, {
        CLERK_JWKS_URL: authorization.jwksUrl,
        CLERK_ISSUER: authorization.issuer,
        CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "CHURNKEY12",
        APNS_TEAM_ID: "CHURNTEAM1",
      });
      const firstItem = activityAgentItem({
        sessionId: "session-churn",
        itemId: "approval-stable",
        revision: 7,
        contentFingerprint: "content-before",
        alertFingerprint: "alert-stable",
        activityTier: "signal",
        updatedAt: "2026-07-28T08:00:30.000Z",
      });
      const first = await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [firstItem],
        tombstones: [],
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        protocol: 2,
        acks: [{
          itemId: `agent:${MACHINE_KEY}:session-churn`,
          seenAt: null,
          dismissedAt: null,
          sourceRevision: 7,
        }],
      });
      expect(notificationSends).toBe(1);

      const dismissedAt = "2026-07-28T08:00:40.000Z";
      const acknowledgment = await accountRoute(
        database,
        authorization.userId,
        "POST",
        "/attention/account/ack",
        {
          itemIds: [`agent:${MACHINE_KEY}:session-churn`],
          sourceRevisions: { [`agent:${MACHINE_KEY}:session-churn`]: 7 },
          expectedAccountOwnerId: authorization.userId,
          seenAt: dismissedAt,
          dismissedAt,
        },
      );
      expect(await acknowledgment.json()).toMatchObject({
        applied: [`agent:${MACHINE_KEY}:session-churn`],
        stale: [],
      });

      const churned = activityAgentItem({
        sessionId: "session-churn",
        itemId: "approval-stable",
        revision: 8,
        contentFingerprint: "content-after-preview-churn",
        alertFingerprint: "alert-stable",
        activityTier: "signal",
        preview: "Elapsed 17.2s · processed 42 files.",
        updatedAt: "2026-07-28T08:00:50.000Z",
      });
      const second = await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [churned],
        tombstones: [],
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        protocol: 2,
        acks: [{
          itemId: `agent:${MACHINE_KEY}:session-churn`,
          dismissedAt,
          sourceRevision: 8,
        }],
      });
      expect(row(database, `
        select content_fingerprint, alert_fingerprint, dismissed_at
        from attention_items
        where user_id = ? and item_id = ?
      `, authorization.userId, `agent:${MACHINE_KEY}:session-churn`)).toEqual({
        content_fingerprint: "content-after-preview-churn",
        alert_fingerprint: "alert-stable",
        dismissed_at: dismissedAt,
      });
      expect(notificationSends).toBe(1);
    } finally {
      database.close();
    }
  });

  it("resets dismissal and sends once for a new destination item identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    let notificationSends = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      if (url.startsWith("https://api.sandbox.push.apple.com/")) {
        notificationSends += 1;
        return new Response(null, {
          status: 200,
          headers: { "apns-id": `new-destination-${notificationSends}` },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      insertAttentionDevice(database, {
        userId: authorization.userId,
        deviceId: "phone-new-destination",
        apnsToken: "cd".repeat(32),
      });
      const env = makeAttentionEnv(database, {
        CLERK_JWKS_URL: authorization.jwksUrl,
        CLERK_ISSUER: authorization.issuer,
        CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "DESTKEY123",
        APNS_TEAM_ID: "DESTTEAM12",
      });
      const itemId = `agent:${MACHINE_KEY}:session-new-destination`;
      expect((await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [activityAgentItem({
          sessionId: "session-new-destination",
          itemId: "question-1",
          revision: 7,
          contentFingerprint: "destination-content-1",
          alertFingerprint: "destination-alert-1",
          activityTier: "signal",
          updatedAt: "2026-07-28T08:00:30.000Z",
        })],
        tombstones: [],
      })).status).toBe(200);
      expect(notificationSends).toBe(1);
      expect((await accountRoute(
        database,
        authorization.userId,
        "POST",
        "/attention/account/ack",
        {
          itemIds: [itemId],
          sourceRevisions: { [itemId]: 7 },
          expectedAccountOwnerId: authorization.userId,
          seenAt: "2026-07-28T08:00:40.000Z",
          dismissedAt: "2026-07-28T08:00:40.000Z",
        },
      )).status).toBe(200);

      const response = await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [activityAgentItem({
          sessionId: "session-new-destination",
          itemId: "question-2",
          revision: 8,
          contentFingerprint: "destination-content-2",
          alertFingerprint: "destination-alert-2",
          activityTier: "signal",
          updatedAt: "2026-07-28T08:00:50.000Z",
        })],
        tombstones: [],
      });
      expect(response.status).toBe(200);
      expect(row(database, `
        select seen_at, dismissed_at, alert_fingerprint
        from attention_items
        where user_id = ? and item_id = ?
      `, authorization.userId, itemId)).toEqual({
        seen_at: null,
        dismissed_at: null,
        alert_fingerprint: "destination-alert-2",
      });
      expect(notificationSends).toBe(2);
    } finally {
      database.close();
    }
  });

  it("alerts twice on needs-you re-entry and round-trips statusSince", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    let notificationSends = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      if (url.startsWith("https://api.sandbox.push.apple.com/")) {
        notificationSends += 1;
        return new Response(null, {
          status: 200,
          headers: { "apns-id": `question-reentry-${notificationSends}` },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "REENTRY123",
      APNS_TEAM_ID: "REENTRY12",
    });
    const publish = (item: Record<string, unknown>) =>
      publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [item],
        tombstones: [],
      });
    try {
      insertAttentionDevice(database, {
        userId: authorization.userId,
        deviceId: "phone-question-reentry",
        apnsToken: "ab".repeat(32),
      });
      expect((await publish(activityAgentItem({
        sessionId: "question-reentry",
        itemId: null,
        revision: 7,
        contentFingerprint: "question-content-1",
        alertFingerprint: "question-needs-you-1",
        activityTier: "signal",
        updatedAt: "2026-07-28T08:00:20.000Z",
        statusSince: "2026-07-28T08:00:10.000Z",
      }))).status).toBe(200);
      expect((await publish(activityAgentItem({
        sessionId: "question-reentry",
        itemId: null,
        revision: 8,
        contentFingerprint: "question-content-running",
        alertFingerprint: "question-running",
        activityTier: "ambient",
        eventKind: "agent_running",
        phase: "running",
        updatedAt: "2026-07-28T08:00:30.000Z",
        statusSince: "2026-07-28T08:00:30.000Z",
      }))).status).toBe(200);
      expect((await publish(activityAgentItem({
        sessionId: "question-reentry",
        itemId: null,
        revision: 9,
        contentFingerprint: "question-content-2",
        alertFingerprint: "question-needs-you-2",
        activityTier: "signal",
        updatedAt: "2026-07-28T08:00:40.000Z",
        statusSince: "2026-07-28T08:00:40.000Z",
      }))).status).toBe(200);

      const snapshot = await (await accountRoute(
        database,
        authorization.userId,
        "GET",
        "/attention/account/snapshot?since=0",
      )).json() as {
        items: Array<{ statusSince?: string | null }>;
      };
      expect(notificationSends).toBe(2);
      expect(rows(database, `
        select alert_fingerprint from attention_alert_log
        where user_id = ? order by delivered_at asc
      `, authorization.userId)).toEqual([
        { alert_fingerprint: "question-needs-you-1" },
        { alert_fingerprint: "question-needs-you-2" },
      ]);
      expect(snapshot.items[0]?.statusSince).toBe("2026-07-28T08:00:40.000Z");
    } finally {
      database.close();
    }
  });

  it("accepts a roster fallback clamped to the live source revision", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
    });
    const publish = (item: Record<string, unknown>) =>
      publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [item],
        tombstones: [],
      });
    try {
      const liveRevision = Date.parse("2026-07-28T08:00:30.000Z");
      expect((await publish(activityAgentItem({
        sessionId: "live-to-roster",
        itemId: null,
        revision: liveRevision,
        contentFingerprint: "live-content",
        alertFingerprint: "live-alert",
        activityTier: "ambient",
        eventKind: "agent_running",
        phase: "running",
      }))).status).toBe(200);

      const rosterResponse = await publish(activityAgentItem({
        sessionId: "live-to-roster",
        itemId: null,
        revision: liveRevision,
        contentFingerprint: "roster-content",
        alertFingerprint: "roster-alert",
        activityTier: "idle",
        eventKind: "agent_running",
        phase: "stale",
        updatedAt: "2026-07-01T08:00:00.000Z",
        statusSince: "2026-07-01T08:00:00.000Z",
        expiresAt: null,
      }));

      expect(rosterResponse.status).toBe(200);
      expect(await rosterResponse.json()).toMatchObject({ protocol: 2, upserted: 1 });
      expect(row(database, `
        select source_revision, phase, content_fingerprint
        from attention_items where user_id = ? and item_id = ?
      `, authorization.userId, `agent:${MACHINE_KEY}:live-to-roster`)).toEqual({
        source_revision: liveRevision,
        phase: "stale",
        content_fingerprint: "roster-content",
      });
    } finally {
      database.close();
    }
  });

  it("tombstones only rows absent from a completed paged reconcile epoch", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
    });
    const item = (sessionId: string) => activityAgentItem({
      sessionId,
      itemId: `approval-${sessionId}`,
      revision: 7,
      contentFingerprint: `content-${sessionId}`,
      alertFingerprint: `alert-${sessionId}`,
      activityTier: "idle",
      expiresAt: null,
    });
    try {
      expect((await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "reconcile",
        rosterEpoch: 10,
        page: 0,
        final: false,
        items: [item("roster-1"), item("roster-2")],
        tombstones: [],
      })).status).toBe(200);
      expect((await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "reconcile",
        rosterEpoch: 10,
        page: 1,
        final: true,
        items: [item("roster-3")],
        tombstones: [],
      })).status).toBe(200);
      expect(rows(database, `
        select item_id, roster_epoch
        from attention_items
        where user_id = ?
        order by item_id
      `, authorization.userId)).toEqual([
        { item_id: `agent:${MACHINE_KEY}:roster-1`, roster_epoch: 10 },
        { item_id: `agent:${MACHINE_KEY}:roster-2`, roster_epoch: 10 },
        { item_id: `agent:${MACHINE_KEY}:roster-3`, roster_epoch: 10 },
      ]);

      expect((await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "reconcile",
        rosterEpoch: 11,
        page: 0,
        final: false,
        items: [item("roster-3")],
        tombstones: [],
      })).status).toBe(200);
      expect((await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "reconcile",
        rosterEpoch: 11,
        page: 1,
        final: true,
        items: [item("roster-1")],
        tombstones: [],
      })).status).toBe(200);

      expect(rows(database, `
        select item_id, roster_epoch
        from attention_items
        where user_id = ?
        order by item_id
      `, authorization.userId)).toEqual([
        { item_id: `agent:${MACHINE_KEY}:roster-1`, roster_epoch: 11 },
        { item_id: `agent:${MACHINE_KEY}:roster-3`, roster_epoch: 11 },
      ]);
      expect(rows(database, `
        select item_id, revivable
        from attention_tombstones
        where user_id = ?
      `, authorization.userId)).toEqual([{
        item_id: `agent:${MACHINE_KEY}:roster-2`,
        revivable: 0,
      }]);
    } finally {
      database.close();
    }
  });

  it("alerts only fresh signal-tier items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:20:00.000Z"));
    const database = new SqliteD1Database();
    const parse = (raw: Record<string, unknown>) => {
      const parsed = attentionTestInternals.parseAttentionItem(raw, MACHINE_KEY);
      expect(parsed, "activity item must parse").not.toBeNull();
      if (!parsed) throw new Error("activity item did not parse");
      return parsed;
    };
    const idle = parse(activityAgentItem({
      sessionId: "idle-tier",
      itemId: "idle-tier",
      revision: 1,
      contentFingerprint: "idle-content",
      alertFingerprint: "idle-alert",
      activityTier: "idle",
      updatedAt: "2026-07-28T08:19:00.000Z",
    }));
    const ambient = parse(activityAgentItem({
      sessionId: "ambient-tier",
      itemId: "ambient-tier",
      revision: 1,
      contentFingerprint: "ambient-content",
      alertFingerprint: "ambient-alert",
      activityTier: "ambient",
      updatedAt: "2026-07-28T08:19:00.000Z",
    }));
    const staleRoster = parse(activityAgentItem({
      sessionId: "stale-roster-signal",
      itemId: null,
      revision: 1,
      contentFingerprint: "stale-content",
      alertFingerprint: "stale-alert",
      activityTier: "signal",
      updatedAt: "2026-07-28T08:04:59.999Z",
    }));
    const fresh = parse(activityAgentItem({
      sessionId: "fresh-signal",
      itemId: "fresh-signal",
      revision: 1,
      contentFingerprint: "fresh-content",
      alertFingerprint: "fresh-alert",
      activityTier: "signal",
      updatedAt: "2026-07-28T08:19:00.000Z",
    }));
    const sendPush = vi.fn(async () => ({
      ok: true,
      status: 200,
      apnsId: "fresh-signal-only",
      reason: null,
      tokenInvalid: false,
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-tier-gates",
        apnsToken: "ab".repeat(32),
      });
      await attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [idle, ambient, staleRoster, fresh],
          tombstones: [],
          sealCapacityTombstones: false,
          rosterEpoch: 1,
          now: "2026-07-28T08:20:00.000Z",
        },
      );
      await attentionTestInternals.deliverAttentionNotifications(
        makeAttentionEnv(database, {
          APNS_KEY: "test-key",
          APNS_KEY_ID: "TESTKEY123",
          APNS_TEAM_ID: "TESTTEAM12",
        }),
        "account-a",
        [idle, ambient, staleRoster, fresh],
        sendPush,
      );
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(rows(database, `
        select alert_fingerprint
        from attention_alert_log
        where user_id = 'account-a'
      `)).toEqual([{ alert_fingerprint: "fresh-alert" }]);
    } finally {
      database.close();
    }
  });

  it("keeps machine-muted items in snapshots while device scope wins other fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(activityAgentItem({
      sessionId: "machine-muted",
      itemId: "machine-muted",
      revision: 1,
      contentFingerprint: "machine-muted-content",
      alertFingerprint: "machine-muted-alert",
      activityTier: "signal",
      updatedAt: "2026-07-28T08:00:30.000Z",
    }), MACHINE_KEY);
    expect(parsed, "machine-muted item must parse").not.toBeNull();
    if (!parsed) throw new Error("machine-muted item did not parse");
    const sendPush = vi.fn(async () => ({
      ok: true,
      status: 200,
      apnsId: "should-not-send",
      reason: null,
      tokenInvalid: false,
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-machine-muted",
        apnsToken: "cd".repeat(32),
        preferences: { soundsEnabled: false },
      });
      await attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [parsed],
          tombstones: [],
          sealCapacityTombstones: false,
          rosterEpoch: 1,
          now: "2026-07-28T08:01:00.000Z",
        },
      );
      expect((await accountRoute(
        database,
        "account-a",
        "PATCH",
        `/attention/account/preferences/machines/${MACHINE_KEY}`,
        { notificationsEnabled: false, hideDetails: true },
      )).status).toBe(200);
      expect((await accountRoute(
        database,
        "account-a",
        "PATCH",
        "/attention/account/preferences/devices/phone-machine-muted",
        { soundsEnabled: true },
      )).status).toBe(200);
      const storedPreferences = JSON.parse(row<{ payload_json: string }>(database, `
        select payload_json
        from attention_preferences
        where user_id = 'account-a'
      `)?.payload_json ?? "{}") as Record<string, unknown>;
      expect(attentionTestInternals.resolveActivityDeliveryPreferences(
        {
          device_id: "phone-machine-muted",
          apns_token: "cd".repeat(32),
          push_to_start_token: null,
          bundle_id: "com.ade.ios",
          aps_environment: "sandbox",
          preferences_json: JSON.stringify({ soundsEnabled: false }),
          generation: "generation",
        },
        parsed,
        storedPreferences,
      )).toMatchObject({
        notificationsEnabled: false,
        hideDetails: true,
        soundsEnabled: true,
      });
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
      const snapshot = await (await accountRoute(
        database,
        "account-a",
        "GET",
        "/attention/account/snapshot?since=0",
      )).json() as { items: Array<{ id: string }> };
      expect(snapshot.items.map((item) => item.id)).toContain(parsed.id);
      expect(sendPush).not.toHaveBeenCalled();

      const tooManyMachines = Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `machine-${index}`,
          { notificationsEnabled: false },
        ]),
      );
      expect((await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/preferences",
        { machines: tooManyMachines },
      )).status).toBe(400);
    } finally {
      database.close();
    }
  });

  it("keeps durable alert history across prune and same-id device re-registration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    let notificationSends = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      if (url.startsWith("https://api.sandbox.push.apple.com/")) {
        notificationSends += 1;
        return new Response(null, {
          status: 200,
          headers: { "apns-id": `durable-alert-${notificationSends}` },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
      APNS_KEY: await generateTestP8(),
      APNS_KEY_ID: "DURABLE123",
      APNS_TEAM_ID: "DURABLE12",
    });
    const publish = (revision: number, contentFingerprint: string) =>
      publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [activityAgentItem({
          sessionId: "durable-alert",
          itemId: "durable-alert",
          revision,
          contentFingerprint,
          alertFingerprint: "durable-alert-identity",
          activityTier: "signal",
          updatedAt: "2026-07-28T08:00:30.000Z",
          expiresAt: "2099-07-29T08:00:00.000Z",
        })],
        tombstones: [],
      });
    try {
      insertAttentionDevice(database, {
        userId: authorization.userId,
        deviceId: "phone-durable-alert",
        apnsToken: "ef".repeat(32),
      });
      expect((await publish(1, "durable-content-1")).status).toBe(200);
      expect(notificationSends).toBe(1);
      database.native.prepare(`
        update attention_items
        set expires_at = '2026-07-28T07:59:00.000Z'
        where user_id = ? and item_id = ?
      `).run(authorization.userId, `agent:${MACHINE_KEY}:durable-alert`);
      database.native.prepare(`
        update attention_delivery_receipts
        set delivered_at = '2026-07-20T08:00:00.000Z'
        where user_id = ? and device_id = 'phone-durable-alert'
      `).run(authorization.userId);
      database.native.prepare(`
        update attention_alert_log
        set delivered_at = '2026-07-08T08:00:00.000Z'
        where user_id = ? and device_id = 'phone-durable-alert'
      `).run(authorization.userId);

      await runAttentionMaintenance(env);
      expect(rows(database, `
        select item_id from attention_items where user_id = ?
      `, authorization.userId)).toEqual([]);
      expect(rows(database, `
        select item_id from attention_delivery_receipts where user_id = ?
      `, authorization.userId)).toEqual([]);
      expect(rows(database, `
        select alert_fingerprint from attention_alert_log where user_id = ?
      `, authorization.userId)).toEqual([{
        alert_fingerprint: "durable-alert-identity",
      }]);

      expect((await publish(2, "durable-content-2")).status).toBe(200);
      expect(notificationSends).toBe(1);
      expect((await accountRoute(
        database,
        authorization.userId,
        "DELETE",
        "/attention/account/devices/phone-durable-alert",
        { ownershipEpoch: 1, apnsToken: "ef".repeat(32) },
      )).status).toBe(200);
      expect(rows(database, `
        select alert_fingerprint from attention_alert_log where user_id = ?
      `, authorization.userId)).toHaveLength(1);
      expect((await accountRoute(
        database,
        authorization.userId,
        "PUT",
        "/attention/account/devices/phone-durable-alert",
        {
          ownershipEpoch: 1,
          apnsToken: "ef".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
          platform: "iOS",
        },
      )).status).toBe(200);
      expect((await publish(3, "durable-content-3")).status).toBe(200);
      expect(notificationSends).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fences an acknowledgment on the alert the caller actually rendered", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const seed = async (sessionId: string, alertFingerprint: string) => {
      const parsed = attentionTestInternals.parseAttentionItem(activityAgentItem({
        sessionId,
        itemId: sessionId,
        revision: 7,
        contentFingerprint: `${sessionId}-content`,
        alertFingerprint,
        activityTier: "signal",
      }), MACHINE_KEY);
      if (!parsed) throw new Error(`${sessionId} did not parse`);
      await attentionTestInternals.commitAttentionMachineChanges(env, {
        userId: "account-a",
        machineKey: MACHINE_KEY,
        items: [parsed],
        tombstones: [],
        sealCapacityTombstones: false,
        rosterEpoch: 1,
        now: "2026-07-28T08:00:00.000Z",
      });
      return parsed.id;
    };
    try {
      const moved = await seed("moved-on", "alert-v2");
      const steady = await seed("steady", "alert-steady");
      const unquoted = await seed("unquoted", "alert-unquoted");

      const acknowledged = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [moved, steady, unquoted],
          alertFingerprints: {
            // The row flipped to a NEW question between render and tap. This is
            // the one lost update that can really happen, and the whole reason
            // the fence exists: the new question must not arrive pre-dismissed.
            [moved]: "alert-v1",
            [steady]: "alert-steady",
            // `unquoted` is deliberately absent — a sparse map, not a mismatch.
          },
          seenAt: "2026-07-28T08:01:00.000Z",
          dismissedAt: "2026-07-28T08:01:00.000Z",
        },
      );
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({
        applied: [steady, unquoted],
        stale: [moved],
      });
      expect(row(database, `
        select dismissed_at from attention_items where user_id = 'account-a' and item_id = ?
      `, moved)?.dismissed_at).toBeNull();
      expect(row(database, `
        select dismissed_at from attention_items where user_id = 'account-a' and item_id = ?
      `, steady)?.dismissed_at).toBe("2026-07-28T08:01:00.000Z");
      // Absent entry ⇒ unfenced. This is what keeps "Clear all" working for
      // legacy desktop, mobile, and TUI callers that quote nothing at all.
      expect(row(database, `
        select dismissed_at from attention_items where user_id = 'account-a' and item_id = ?
      `, unquoted)?.dismissed_at).toBe("2026-07-28T08:01:00.000Z");

      // Omitting the key entirely is the legacy shape and stays unfenced.
      const legacy = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [moved],
          sourceRevisions: { [moved]: 7 },
          seenAt: "2026-07-28T08:02:00.000Z",
          dismissedAt: "2026-07-28T08:02:00.000Z",
        },
      );
      expect(await legacy.json()).toMatchObject({ applied: [moved], stale: [] });
    } finally {
      database.close();
    }
  });

  it("rejects an alert fingerprint map that does not describe this batch", async () => {
    const database = new SqliteD1Database();
    try {
      const bad = async (alertFingerprints: unknown) => (await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: ["agent:machine:one"],
          alertFingerprints,
          seenAt: "2026-07-28T08:01:00.000Z",
          dismissedAt: null,
        },
      )).status;
      expect(await bad("not-an-object")).toBe(400);
      expect(await bad({ "agent:machine:one": 7 })).toBe(400);
      expect(await bad({ "agent:machine:one": "  " })).toBe(400);
      expect(await bad({ "agent:machine:one": "x".repeat(1025) })).toBe(400);
      // Out of batch: the two sides disagree about what is being acknowledged.
      expect(await bad({ "agent:machine:other": "alert" })).toBe(400);
      // The boundary value is accepted, and so is an empty map.
      expect(await bad({ "agent:machine:one": "x".repeat(1024) })).toBe(200);
      expect(await bad({})).toBe(200);
      expect(await bad(null)).toBe(200);
    } finally {
      database.close();
    }
  });

  it("bounds the fingerprint map by the batch rather than by its own cap", async () => {
    const database = new SqliteD1Database();
    try {
      // The map is capped ONLY by "keys must be a subset of itemIds". A second,
      // independent ceiling would 400 a legitimate full-size "Clear all" that
      // quotes a fingerprint for every id it sends.
      const full = Array.from({ length: 64 }, (_value, index) => `agent:machine:item-${index}`);
      const acknowledged = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: full,
          alertFingerprints: Object.fromEntries(
            full.map((itemId, index) => [itemId, `alert-${index}`]),
          ),
          seenAt: "2026-07-28T08:01:00.000Z",
          dismissedAt: null,
        },
      );
      expect(acknowledged.status).toBe(200);

      // 64 is the batch ceiling, and it has always been enforced on `itemIds`
      // itself — a caller that does not cap its own batch is rejected here
      // whether or not it quotes any fingerprints at all.
      for (const alertFingerprints of [undefined, {}]) {
        const oversized = await accountRoute(
          database,
          "account-a",
          "POST",
          "/attention/account/ack",
          {
            itemIds: [...full, "agent:machine:item-64"],
            ...(alertFingerprints === undefined ? {} : { alertFingerprints }),
            seenAt: "2026-07-28T08:01:00.000Z",
            dismissedAt: null,
          },
        );
        expect(oversized.status).toBe(400);
        expect(await oversized.json()).toMatchObject({ error: "invalid acknowledgment" });
      }
    } finally {
      database.close();
    }
  });

  it("acknowledges a live item whose stored revision already moved on", async () => {
    const database = new SqliteD1Database();
    const parsed = attentionTestInternals.parseAttentionItem(activityAgentItem({
      sessionId: "ack-fence",
      itemId: "ack-fence",
      revision: 7,
      contentFingerprint: "ack-content",
      alertFingerprint: "ack-alert",
      activityTier: "signal",
    }), MACHINE_KEY);
    expect(parsed, "ack-fence item must parse").not.toBeNull();
    if (!parsed) throw new Error("ack-fence item did not parse");
    try {
      await attentionTestInternals.commitAttentionMachineChanges(
        makeAttentionEnv(database),
        {
          userId: "account-a",
          machineKey: MACHINE_KEY,
          items: [parsed],
          tombstones: [],
          sealCapacityTombstones: false,
          rosterEpoch: 1,
          now: "2026-07-28T08:00:00.000Z",
        },
      );
      const mismatch = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [parsed.id],
          sourceRevisions: { [parsed.id]: 7 },
          expectedAccountOwnerId: "account-b",
          seenAt: "2026-07-28T08:01:00.000Z",
          dismissedAt: null,
        },
      );
      expect(mismatch.status).toBe(409);
      expect(row(database, `
        select seen_at from attention_items where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.seen_at).toBeNull();

      // A running agent's revision is its last-active epoch, so the client's
      // copy is always behind by the time it acks. That must still apply; only
      // an item this account has no live row for comes back stale.
      const behind = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [parsed.id, `agent:${MACHINE_KEY}:never-published`],
          sourceRevisions: {
            [parsed.id]: 6,
            [`agent:${MACHINE_KEY}:never-published`]: 6,
          },
          expectedAccountOwnerId: "account-a",
          seenAt: "2026-07-28T08:01:00.000Z",
          dismissedAt: null,
        },
      );
      expect(await behind.json()).toMatchObject({
        applied: [parsed.id],
        stale: [`agent:${MACHINE_KEY}:never-published`],
      });
      expect(row(database, `
        select seen_at from attention_items where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.seen_at).toBe("2026-07-28T08:01:00.000Z");

      // Repeat acknowledgments are idempotent and never move a mark forward,
      // which is why the revision fence guarded a lost update that cannot
      // happen.
      const repeated = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        {
          itemIds: [parsed.id],
          sourceRevisions: { [parsed.id]: 7 },
          expectedAccountOwnerId: "account-a",
          seenAt: "2026-07-28T08:02:00.000Z",
          dismissedAt: null,
        },
      );
      expect(await repeated.json()).toMatchObject({
        applied: [parsed.id],
        stale: [],
      });
      expect(row(database, `
        select seen_at from attention_items where user_id = 'account-a' and item_id = ?
      `, parsed.id)?.seen_at).toBe("2026-07-28T08:01:00.000Z");
    } finally {
      database.close();
    }
  });

  it("handles presence with one link write and no item writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:01:00.000Z"));
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      database.native.prepare(`
        insert into attention_machine_links(
          machine_key, user_id, machine_name, last_seen_at, linked_at,
          legacy_devices_imported_at
        ) values (?, ?, 'Studio', '2026-07-28T08:00:00.000Z',
          '2026-07-28T08:00:00.000Z', null)
      `).run(MACHINE_KEY, authorization.userId);
      const before = row<{ count: number }>(database, `
        select total_changes() as count
      `)?.count ?? 0;
      const response = await publishActivityForTest(
        makeAttentionEnv(database, {
          CLERK_JWKS_URL: authorization.jwksUrl,
          CLERK_ISSUER: authorization.issuer,
          CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        }),
        authorization,
        {
          machineName: "Studio refreshed",
          mode: "presence",
          rosterEpoch: 12,
          items: [],
          tombstones: [],
        },
      );
      const after = row<{ count: number }>(database, `
        select total_changes() as count
      `)?.count ?? 0;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        protocol: 2,
        upserted: 0,
        removed: 0,
        acks: [],
      });
      expect(after - before).toBe(1);
      expect(rows(database, `
        select item_id from attention_items where user_id = ?
      `, authorization.userId)).toEqual([]);
      expect(row(database, `
        select machine_name, last_seen_at
        from attention_machine_links
        where machine_key = ?
      `, MACHINE_KEY)).toEqual({
        machine_name: "Studio refreshed",
        last_seen_at: "2026-07-28T08:01:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("caps an account, reports publish eviction, and keeps exact-cap snapshots honest", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      const insertIdle = database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
          roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (?, ?, ?, 1, 0, ?, ?, ?, 'idle', 1, 'agent_completed',
          'completed', '{}', null, null, null, ?)
      `);
      for (let index = 0; index < 2_000; index += 1) {
        const fingerprint = `idle-fingerprint-${index}`;
        insertIdle.run(
          authorization.userId,
          `idle-${index.toString().padStart(4, "0")}`,
          MACHINE_KEY,
          fingerprint,
          fingerprint,
          fingerprint,
          new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        );
      }
      const response = await publishActivityForTest(
        makeAttentionEnv(database, {
          CLERK_JWKS_URL: authorization.jwksUrl,
          CLERK_ISSUER: authorization.issuer,
          CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        }),
        authorization,
        {
          machineName: "Studio",
          mode: "delta",
          rosterEpoch: 2,
          items: [activityAgentItem({
            sessionId: "cap-signal",
            itemId: "cap-signal",
            revision: 1,
            contentFingerprint: "cap-signal-content",
            alertFingerprint: "cap-signal-alert",
            activityTier: "signal",
          })],
          tombstones: [],
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ itemsTruncated: true });
      expect(row(database, `
        select count(*) as count from attention_items where user_id = ?
      `, authorization.userId)?.count).toBe(2_000);
      expect(row(database, `
        select revivable
        from attention_tombstones
        where user_id = ? and item_id = 'idle-0000'
      `, authorization.userId)?.revivable).toBe(0);
      const snapshot = await (await accountRoute(
        database,
        authorization.userId,
        "GET",
        "/attention/account/snapshot?since=0",
      )).json() as { itemsTruncated?: boolean };
      expect(snapshot.itemsTruncated).toBe(false);
    } finally {
      database.close();
    }
  });

  it("evicts legacy null-tier rows only after idle rows", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const insert = database.native.prepare(`
      insert into attention_items(
        user_id, item_id, machine_key, source_revision, account_revision,
        fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
        roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
        expires_at, updated_at
      ) values (?, ?, ?, 1, 0, ?, ?, ?, ?, 1, 'agent_running',
        'running', '{}', null, null, null, ?)
    `);
    try {
      for (let index = 0; index < 1_998; index += 1) {
        const fingerprint = `signal-${index}`;
        insert.run(
          authorization.userId,
          `signal-${index}`,
          MACHINE_KEY,
          fingerprint,
          fingerprint,
          fingerprint,
          "signal",
          "2026-07-01T00:00:02.000Z",
        );
      }
      insert.run(
        authorization.userId,
        "legacy-null",
        MACHINE_KEY,
        "legacy-null",
        "legacy-null",
        "legacy-null",
        null,
        "2026-07-01T00:00:00.000Z",
      );
      insert.run(
        authorization.userId,
        "idle-row",
        MACHINE_KEY,
        "idle-row",
        "idle-row",
        "idle-row",
        "idle",
        "2026-07-01T00:00:01.000Z",
      );
      const env = makeAttentionEnv(database, {
        CLERK_JWKS_URL: authorization.jwksUrl,
        CLERK_ISSUER: authorization.issuer,
        CLERK_OAUTH_CLIENT_ID: "attention-test-client",
      });
      const publishSignal = (sessionId: string, revision: number) =>
        publishActivityForTest(env, authorization, {
          machineName: "Studio",
          mode: "delta",
          rosterEpoch: 2,
          items: [activityAgentItem({
            sessionId,
            itemId: null,
            revision,
            contentFingerprint: `${sessionId}-content`,
            alertFingerprint: `${sessionId}-alert`,
            activityTier: "signal",
          })],
          tombstones: [],
        });

      expect(await (await publishSignal("cap-first", 2)).json())
        .toMatchObject({ itemsTruncated: true });
      expect(row(database, `
        select item_id from attention_items where user_id = ? and item_id = 'idle-row'
      `, authorization.userId)).toBeUndefined();
      expect(row(database, `
        select item_id from attention_items where user_id = ? and item_id = 'legacy-null'
      `, authorization.userId)).toEqual({ item_id: "legacy-null" });

      expect(await (await publishSignal("cap-second", 3)).json())
        .toMatchObject({ itemsTruncated: true });
      expect(row(database, `
        select item_id from attention_items where user_id = ? and item_id = 'legacy-null'
      `, authorization.userId)).toBeUndefined();
      expect(rows(database, `
        select item_id, revivable from attention_tombstones
        where user_id = ? and item_id in ('idle-row', 'legacy-null')
        order by item_id
      `, authorization.userId)).toEqual([
        { item_id: "idle-row", revivable: 0 },
        { item_id: "legacy-null", revivable: 0 },
      ]);
    } finally {
      database.close();
    }
  });

  it("reports truncation backpressure when an over-cap account has no evictable rows", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const insertSignal = database.native.prepare(`
      insert into attention_items(
        user_id, item_id, machine_key, source_revision, account_revision,
        fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
        roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
        expires_at, updated_at
      ) values (?, ?, ?, 1, 0, ?, ?, ?, 'signal', 1, 'agent_running',
        'running', '{}', null, null, null, '2026-07-01T00:00:00.000Z')
    `);
    try {
      for (let index = 0; index < 2_000; index += 1) {
        const fingerprint = `signal-only-${index}`;
        insertSignal.run(
          authorization.userId,
          `signal-only-${index}`,
          MACHINE_KEY,
          fingerprint,
          fingerprint,
          fingerprint,
        );
      }
      const response = await publishActivityForTest(
        makeAttentionEnv(database, {
          CLERK_JWKS_URL: authorization.jwksUrl,
          CLERK_ISSUER: authorization.issuer,
          CLERK_OAUTH_CLIENT_ID: "attention-test-client",
        }),
        authorization,
        {
          machineName: "Studio",
          mode: "delta",
          rosterEpoch: 2,
          items: [activityAgentItem({
            sessionId: "signal-overflow",
            itemId: null,
            revision: 2,
            contentFingerprint: "signal-overflow-content",
            alertFingerprint: "signal-overflow-alert",
            activityTier: "signal",
          })],
          tombstones: [],
        },
      );
      const body = await response.json() as { itemsTruncated?: boolean };
      expect(response.status).toBe(200);
      expect(body.itemsTruncated).toBe(true);
      expect(row(database, `
        select count(*) as count from attention_items where user_id = ?
      `, authorization.userId)?.count).toBe(2_001);
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
        { machineKey: MACHINE_KEY },
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
        applied: [],
        stale: [],
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
        delete from attention_alert_log
        where user_id = 'account-a' and alert_fingerprint = ?
      `).run(parsed.alertFingerprint);
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
        // The refresh gate is the alert fingerprint, not the content one: a
        // content-only churn deliberately does not earn an APNs push, so this
        // ownership-fencing case has to stage a real phase entry.
        alertFingerprint: "ownership-update-alert",
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
    const privateState = liveActivityTestInternals.privacyPreservingActivityContentState({
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
    expect(liveActivityTestInternals.activityRun(first)).toMatchObject({
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
    expect(liveActivityTestInternals.activityPullRequest(pullRequest)).toMatchObject({
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

      await runAttentionMaintenance(makeAttentionEnv(database));

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

  it("prunes delivery receipts by age independently of Attention item state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "active-phone",
        leaseExpiresAt: "2099-09-01T00:00:00.000Z",
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
            '2099-07-29T12:00:00.000Z', '2026-07-28T11:00:00.000Z'
          )
      `).run(MACHINE_KEY, MACHINE_KEY);
      database.native.prepare(`
        insert into attention_delivery_receipts(
          user_id, item_id, device_id, state, delivered_at
        ) values
          ('account-a', 'expired-item', 'active-phone', 'alert:expired', '2026-07-28T11:00:00.000Z'),
          ('account-a', 'active-item', 'active-phone', 'alert:active', '2026-07-28T11:00:00.000Z'),
          ('account-a', 'removed-item', 'active-phone', 'alert:removed', '2026-07-28T11:00:00.000Z'),
          ('account-a', 'old-removed-item', 'active-phone', 'alert:old', '2026-07-20T11:00:00.000Z')
      `).run();

      await runAttentionMaintenance(makeAttentionEnv(database));

      expect(rows(database, `
        select item_id
        from attention_delivery_receipts
        where user_id = 'account-a' and device_id = 'active-phone'
        order by item_id
      `)).toEqual([
        { item_id: "active-item" },
        { item_id: "expired-item" },
        { item_id: "removed-item" },
      ]);
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
      `)?.lease_expires_at).toBe("2099-09-01T00:00:00.000Z");
    } finally {
      database.close();
    }
  });
});

describe("account machine lifecycle", () => {
  function seedMachineActivity(
    database: SqliteD1Database,
    args: {
      userId: string;
      sessionId: string;
      revision?: number;
      lastSeenAt?: string;
      expiresAt?: string | null;
      activityTier?: "signal" | "ambient" | "idle";
    },
  ): Promise<number> {
    database.native.prepare(`
      insert into attention_machine_links(
        machine_key, user_id, machine_name, last_seen_at, linked_at,
        legacy_devices_imported_at
      ) values (?, ?, 'Studio', ?, ?, null)
      on conflict(machine_key) do update set
        user_id = excluded.user_id,
        last_seen_at = excluded.last_seen_at
    `).run(
      MACHINE_KEY,
      args.userId,
      args.lastSeenAt ?? "2026-07-28T08:00:00.000Z",
      args.lastSeenAt ?? "2026-07-28T08:00:00.000Z",
    );
    const parsed = attentionTestInternals.parseAttentionItem(activityAgentItem({
      sessionId: args.sessionId,
      itemId: null,
      revision: args.revision ?? 7,
      contentFingerprint: `${args.sessionId}-content`,
      alertFingerprint: `${args.sessionId}-alert`,
      activityTier: args.activityTier ?? "signal",
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
    }), MACHINE_KEY);
    if (!parsed) throw new Error(`${args.sessionId} item did not parse`);
    return attentionTestInternals.commitAttentionMachineChanges(
      makeAttentionEnv(database),
      {
        userId: args.userId,
        machineKey: MACHINE_KEY,
        items: [parsed],
        tombstones: [],
        sealCapacityTombstones: false,
        rosterEpoch: 1,
        now: args.lastSeenAt ?? "2026-07-28T08:00:00.000Z",
      },
    );
  }

  it("purges a removed machine's activity, seals tombstones, and releases its installs", async () => {
    const database = new SqliteD1Database();
    try {
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "removed-machine",
      });
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-of-removed-machine",
        sourceMachineKey: MACHINE_KEY,
      });

      const response = await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        machineKey: MACHINE_KEY,
        removedItems: 1,
      });

      expect(rows(database, `
        select item_id from attention_items where user_id = 'account-a'
      `)).toEqual([]);
      expect(row(database, `
        select revivable from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, `agent:${MACHINE_KEY}:removed-machine`)).toMatchObject({ revivable: 0 });
      expect(rows(database, `
        select machine_key from attention_machine_links where user_id = 'account-a'
      `)).toEqual([]);
      expect(rows(database, `
        select device_id from attention_devices where user_id = 'account-a'
      `)).toEqual([]);
      expect(row(database, `
        select active from attention_device_ownership where device_id = 'phone-of-removed-machine'
      `)).toMatchObject({ active: 0 });
      expect(row(database, `
        select machine_key from attention_revoked_machines
        where user_id = 'account-a' and machine_key = ?
      `, MACHINE_KEY)).toMatchObject({ machine_key: MACHINE_KEY });

      // Deltas never imply deletion, so the removal has to reach clients as a
      // tombstone or every surface keeps rendering the removed machine's rows.
      const snapshot = await accountRoute(
        database,
        "account-a",
        "GET",
        "/attention/account/snapshot?since=0",
      );
      expect(await snapshot.json()).toMatchObject({
        items: [],
        tombstones: [{ id: `agent:${MACHINE_KEY}:removed-machine` }],
      });
    } finally {
      database.close();
    }
  });

  it("rejects publishes from a revoked machine until it is paired again", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
    });
    const publish = (sessionId: string) =>
      publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [activityAgentItem({
          sessionId,
          itemId: null,
          revision: 7,
          contentFingerprint: `${sessionId}-content`,
          alertFingerprint: `${sessionId}-alert`,
          activityTier: "signal",
        })],
        tombstones: [],
      });
    try {
      expect((await publish("before-removal")).status).toBe(200);
      expect((await accountRoute(
        database,
        authorization.userId,
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);

      // A removed machine keeps a valid account token and heartbeats every 30 s;
      // without this gate it relinks and republishes itself immediately.
      const revoked = await publish("after-removal");
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ code: "machine_revoked" });
      expect(rows(database, `
        select item_id from attention_items where user_id = ?
      `, authorization.userId)).toEqual([]);
      expect(rows(database, `
        select machine_key from attention_machine_links where user_id = ?
      `, authorization.userId)).toEqual([]);

      const restored = await directoryRoute(
        database,
        authorization.userId,
        "POST",
        `/attention/account/machines/${MACHINE_KEY}/pairing`,
      );
      expect(await restored.json()).toMatchObject({ ok: true, restored: true });
      expect((await publish("after-repair")).status).toBe(200);
      expect(rows(database, `
        select item_id from attention_items where user_id = ?
      `, authorization.userId)).toEqual([
        { item_id: `agent:${MACHINE_KEY}:after-repair` },
      ]);
    } finally {
      database.close();
    }
  });

  it("never revives a sealed tombstone through an acknowledgment", async () => {
    const database = new SqliteD1Database();
    try {
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "sealed",
      });
      const itemId = `agent:${MACHINE_KEY}:sealed`;
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);

      const acknowledged = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        { itemIds: [itemId], seenAt: "2026-07-28T09:00:00.000Z", dismissedAt: null },
      );
      expect(await acknowledged.json()).toMatchObject({
        applied: [],
        stale: [itemId],
      });
      expect(rows(database, `
        select item_id from attention_items where user_id = 'account-a'
      `)).toEqual([]);

      // A row that races back in under a sealed tombstone is still deleted
      // state; acknowledging it must not turn it into a live, seen row.
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 1, 'sealed-content', 'agent_needs_you',
          'needs_you', '{}', null, null, null, '2026-07-28T08:00:00.000Z'
        )
      `).run(itemId, MACHINE_KEY);
      const raced = await accountRoute(
        database,
        "account-a",
        "POST",
        "/attention/account/ack",
        { itemIds: [itemId], seenAt: "2026-07-28T09:01:00.000Z", dismissedAt: null },
      );
      expect(await raced.json()).toMatchObject({ applied: [], stale: [itemId] });
      expect(row(database, `
        select seen_at from attention_items where user_id = 'account-a' and item_id = ?
      `, itemId)?.seen_at).toBeNull();
    } finally {
      database.close();
    }
  });

  it("retires expired idle rows from snapshots as tombstones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T08:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "aged-idle",
        activityTier: "idle",
        expiresAt: "2026-08-04T08:00:00.000Z",
        lastSeenAt: "2026-08-05T07:59:00.000Z",
      });

      // Filtering the row out of reads is not enough on its own: a client that
      // already holds it needs the tombstone to drop it.
      const beforePrune = await accountRoute(
        database,
        "account-a",
        "GET",
        "/attention/account/snapshot?since=0",
      );
      expect(await beforePrune.json()).toMatchObject({ items: [] });

      await runAttentionMaintenance(makeAttentionEnv(database));
      expect(rows(database, `
        select item_id from attention_items where user_id = 'account-a'
      `)).toEqual([]);
      const afterPrune = await accountRoute(
        database,
        "account-a",
        "GET",
        "/attention/account/snapshot?since=0",
      );
      expect(await afterPrune.json()).toMatchObject({
        tombstones: [{ id: `agent:${MACHINE_KEY}:aged-idle` }],
      });
    } finally {
      database.close();
    }
  });

  it("sweeps activity left behind by a machine that stopped reporting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T08:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "rotated-key",
        lastSeenAt: "2026-07-01T08:00:00.000Z",
      });

      await runAttentionMaintenance(makeAttentionEnv(database));

      // The epoch reconcile is machine-scoped and only runs while that machine
      // publishes, so a rotated or retired key can only be cleared account-side.
      expect(rows(database, `
        select item_id from attention_items where user_id = 'account-a'
      `)).toEqual([]);
      expect(row(database, `
        select revivable from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, `agent:${MACHINE_KEY}:rotated-key`)).toMatchObject({ revivable: 0 });
      // Retiring the rows is not a removal from the account: the machine may
      // come back and relink on its next publish.
      expect(rows(database, `
        select machine_key from attention_revoked_machines where user_id = 'account-a'
      `)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("clears the previous owner's revocation when a machine key moves to another account", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      claimMachineForAccount(database, "account-a");
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "before-the-move",
      });
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);
      // The any-account gate is what makes this durable — and what would brick
      // the key forever, since the directory only ever restores `(owner, key)`.
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).not.toBeNull();

      // The same install is signed into a different account and publishes
      // there. Removal already deleted the link row, so the prior owner is
      // recovered from the legacy `machines` claim.
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );

      // Without the clear, `handlePublish`/`handleActivityTokenUpsert` keep
      // finding `(account-a, key)` and 403 forever: alerts and Live Activities
      // dead on account B while protocol-2 Activity keeps working.
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();
      expect(rows(database, "select user_id from attention_revoked_machines")).toEqual([]);
      expect(row(database, `
        select user_id from attention_machine_links where machine_key = ?
      `, MACHINE_KEY)).toMatchObject({ user_id: "account-b" });
    } finally {
      database.close();
    }
  });

  it("clears every prior owner's revocation, not just the most recent hop", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      claimMachineForAccount(database, "account-a");
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "shared-key",
      });
      // A → C → B. `machines.account_user_id` records only the LAST linker, so
      // a clear scoped to it survives exactly one hop: account A's row would
      // outlive the move to C and terminal-403 the key on the legacy routes
      // under B forever, with no path that can reach it (the directory only
      // ever restores `(current owner, key)`).
      database.native.prepare(`
        insert into attention_revoked_machines(user_id, machine_key, revoked_at)
        values ('account-c', ?, '2026-07-01T08:00:00.000Z')
      `).run(MACHINE_KEY);
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );

      expect(rows(database, `
        select user_id from attention_revoked_machines order by user_id
      `)).toEqual([]);
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();
      expect(row(database, `
        select user_id from attention_machine_links where machine_key = ?
      `, MACHINE_KEY)).toMatchObject({ user_id: "account-b" });
    } finally {
      database.close();
    }
  });

  it("takes the previous owner's delivery targets away with the ownership", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const apnsSends: string[] = [];
    resetSpendGuardsForTests();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.sandbox.push.apple.com/")) {
        apnsSends.push(url);
        return new Response(null, { status: 200, headers: { "apns-id": "sent" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      claimMachineForAccount(database, "account-a");
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "before-the-sale",
      });
      seedLegacyMachineDelivery(database, { deviceId: "phone-of-account-a" });
      const relayEnv = makeLegacyRelayEnv(database, { APNS_KEY: await generateTestP8() });

      // Baseline: while account A owns the machine, the legacy route reaches
      // A's phone. This is the channel the rest of the test must close.
      expect((await legacyRelayRequest(relayEnv, "POST", `/machines/${MACHINE_KEY}/publish`, {
        notifications: [{ title: "Agent needs you", body: "Review the migration" }],
      })).status).toBe(200);
      expect(apnsSends).toHaveLength(1);

      // 1. Account A removes the machine. The revocation blocks the legacy
      //    route AND the delivery targets go with the removal, so a later
      //    cleared revocation has nothing left to expose.
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);
      expect(rows(database, "select device_id from device_registrations")).toEqual([]);
      expect(rows(database, "select device_id from live_activity_tokens")).toEqual([]);

      // 2. A revoked machine cannot stage a registration to be redeemed the
      //    moment the revocation lifts.
      const stagedRegistration = await legacyRelayRequest(
        relayEnv,
        "PUT",
        `/machines/${MACHINE_KEY}/devices/phone-of-account-a`,
        { bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "ab".repeat(32) },
      );
      expect(stagedRegistration.status).toBe(403);
      expect(await stagedRegistration.json()).toMatchObject({ code: "machine_revoked" });
      const stagedToken = await legacyRelayRequest(
        relayEnv,
        "POST",
        `/machines/${MACHINE_KEY}/live-activity-tokens`,
        {
          deviceId: "phone-of-account-a",
          activityId: "account-attention",
          token: "cd".repeat(32),
        },
      );
      expect(stagedToken.status).toBe(403);

      // 3. Whoever holds the machine signs into their own account and the brain
      //    publishes once. Account B has no revocation, so this succeeds and
      //    clears A's — the ownership transfer this design intends.
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();

      // 4. THE ATTACK. The legacy route is un-gated again, but it now has no
      //    targets: account A's phone is unreachable through this machine, and
      //    no Live Activity token can be re-armed against it.
      apnsSends.length = 0;
      const afterTransfer = await legacyRelayRequest(
        relayEnv,
        "POST",
        `/machines/${MACHINE_KEY}/publish`,
        { notifications: [{ title: "Anything at all", body: "attacker-controlled" }] },
      );
      expect(afterTransfer.status).toBe(200);
      expect(await afterTransfer.json()).toMatchObject({ delivered: 0 });
      expect(apnsSends).toEqual([]);
      expect(rows(database, "select device_id from device_registrations")).toEqual([]);
      expect(rows(database, "select device_id from live_activity_tokens")).toEqual([]);

      const listed = await legacyRelayRequest(
        relayEnv,
        "GET",
        `/machines/${MACHINE_KEY}/devices`,
      );
      expect(await listed.json()).toMatchObject({ devices: [] });
    } finally {
      database.close();
    }
  });

  it("refuses a publish for a machine key the caller never proved it holds", async () => {
    const database = new SqliteD1Database();
    const attacker = await machinePublishAuthorization();
    const attackerKey = "9".repeat(32);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === attacker.jwksUrl) return Response.json(attacker.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    try {
      // The victim's machine, publishing normally to its own account. Machine
      // keys are not secret: they ride published items as `accountMachineKey`
      // and appear in deeplink query strings.
      claimMachineForAccount(database, "account-victim");
      await seedMachineActivity(database, {
        userId: "account-victim",
        sessionId: "victim-session",
      });
      const env = makeAttentionEnv(database, {
        CLERK_JWKS_URL: attacker.jwksUrl,
        CLERK_ISSUER: attacker.issuer,
        CLERK_OAUTH_CLIENT_ID: "attention-test-client",
      });

      // THE ATTACK. A signed-in stranger names the victim's key on the publish
      // route. The smallest request that still reaches `linkMachineToAccount` —
      // a zero-item delta — is enough to write `(attacker, victimKey)` into
      // `attention_machine_links`, which is the first evidence the removal
      // route's guard accepts. Only the machine signature can say otherwise,
      // and the attacker can only produce one for its OWN key.
      const forged = await publishActivityForTest(
        env,
        attacker,
        { machineName: "Not mine", mode: "delta", rosterEpoch: 1, items: [], tombstones: [] },
        { machineKey: MACHINE_KEY, verifiedMachineKey: attackerKey },
      );
      expect(forged.status).toBe(403);
      expect(await forged.json()).toMatchObject({ code: "machine_key_unbound" });
      expect(rows(database, `
        select user_id from attention_machine_links where machine_key = ?
      `, MACHINE_KEY)).toEqual([{ user_id: "account-victim" }]);

      // Without that seeded evidence the removal route degrades to a no-op, so
      // the victim's machine is never terminal-403'd on the legacy routes.
      const removal = await accountRoute(
        database,
        attacker.userId,
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      );
      expect(removal.status).toBe(200);
      expect(await removal.json()).toMatchObject({ revokedAt: null });
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("stops an account that lost a machine from revoking it out from under the new owner", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      // Account A held this key and still has historical rows for it — an
      // install it seeded, and the legacy claim. Evidence is HISTORICAL, so
      // without a current-ownership check A could keep "removing" a machine
      // that now belongs to B and terminal-403 it on the legacy routes.
      claimMachineForAccount(database, "account-a");
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-seeded-by-machine",
        sourceMachineKey: MACHINE_KEY,
      });
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );

      const removal = await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      );
      expect(removal.status).toBe(200);
      expect(await removal.json()).toMatchObject({ revokedAt: null });
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();
      expect(row(database, `
        select user_id from attention_machine_links where machine_key = ?
      `, MACHINE_KEY)).toMatchObject({ user_id: "account-b" });
    } finally {
      database.close();
    }
  });

  it("keeps a machine blocked on the account that is removing it right now", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      claimMachineForAccount(database, "account-a");
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "still-mine",
      });
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);

      // Re-linking to the SAME account is not a transfer; it is exactly the
      // removed machine relinking itself, which the revocation exists to stop.
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );

      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("writes no revocation when an account removes a machine key it never held", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      // account-a owns the machine; machine keys are not secret — they ride
      // published items as `accountMachineKey` and appear in deeplinks.
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "victim",
      });

      // A stranger names it on their own removal route. Combined with the
      // any-account block, an unchecked insert would terminal-403 someone
      // else's machine: alerts and Live Activities dead, permanently.
      const response = await accountRoute(
        database,
        "account-b",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        removedItems: 0,
        revokedAt: null,
      });

      expect(rows(database, "select user_id from attention_revoked_machines")).toEqual([]);
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).toBeNull();
      // The real owner is untouched.
      expect(rows(database, `
        select item_id from attention_items where user_id = 'account-a'
      `)).toEqual([{ item_id: `agent:${MACHINE_KEY}:victim` }]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["only an install it seeded", "devices"],
    ["only items it published", "items"],
  ] as const)("still revokes a machine the account knew through %s", async (_label, evidence) => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    try {
      if (evidence === "items") {
        await seedMachineActivity(database, {
          userId: "account-a",
          sessionId: "known",
        });
        database.native
          .prepare("delete from attention_machine_links where user_id = 'account-a'")
          .run();
      } else {
        insertAttentionDevice(database, {
          userId: "account-a",
          deviceId: "phone-seeded-by-machine",
          sourceMachineKey: MACHINE_KEY,
        });
      }

      const response = await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ revokedAt: expect.any(String) });
      expect(await machineKeyRevokedAt(env, MACHINE_KEY)).not.toBeNull();
    } finally {
      database.close();
    }
  });

  it("refuses to clear a revocation for anything but the account directory", async () => {
    const database = new SqliteD1Database();
    try {
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "sold-machine",
      });
      expect((await accountRoute(
        database,
        "account-a",
        "DELETE",
        `/attention/account/machines/${MACHINE_KEY}`,
      )).status).toBe(200);

      const revoked = () => rows(database, `
        select machine_key from attention_revoked_machines
        where user_id = 'account-a' and machine_key = ?
      `, MACHINE_KEY);
      expect(revoked()).toHaveLength(1);

      // THE ATTACK. A removed machine keeps a valid account token by design, so
      // it can reach this route with exactly the credential the design assumes
      // it still holds. Un-revoking itself would put its agent titles and
      // previews back into the account feed while the directory roster row
      // stays deleted — invisible to the user who removed it.
      const bareToken = await accountRoute(
        database,
        "account-a",
        "POST",
        `/attention/account/machines/${MACHINE_KEY}/pairing`,
      );
      expect(bareToken.status).toBe(403);
      expect(await bareToken.json()).toMatchObject({ code: "directory_auth_required" });
      expect(revoked()).toHaveLength(1);

      const wrongSecret = await accountRoute(
        database,
        "account-a",
        "POST",
        `/attention/account/machines/${MACHINE_KEY}/pairing`,
        undefined,
        { headers: { "x-ade-directory-auth": "not-the-secret" } },
      );
      expect(wrongSecret.status).toBe(403);
      expect(revoked()).toHaveLength(1);

      // Unset on the relay fails CLOSED, never open: an unconfigured deployment
      // must not be a deployment where anyone can un-revoke a machine.
      const unconfigured = await accountRoute(
        database,
        "account-a",
        "POST",
        `/attention/account/machines/${MACHINE_KEY}/pairing`,
        undefined,
        {
          headers: { "x-ade-directory-auth": DIRECTORY_AUTH_SECRET },
          env: { DIRECTORY_AUTH_SECRET: undefined },
        },
      );
      expect(unconfigured.status).toBe(503);
      expect(await unconfigured.json()).toMatchObject({ code: "directory_auth_unavailable" });
      expect(revoked()).toHaveLength(1);

      // The directory's own hand-off still works.
      const fromDirectory = await directoryRoute(
        database,
        "account-a",
        "POST",
        `/attention/account/machines/${MACHINE_KEY}/pairing`,
      );
      expect(fromDirectory.status).toBe(200);
      expect(await fromDirectory.json()).toMatchObject({ ok: true, restored: true });
      expect(revoked()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps the fan-out sweeps out of the request-path prune", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T08:00:00.000Z"));
    const database = new SqliteD1Database();
    try {
      // One row that only `sweepOrphanedMachineActivity` can retire, one that
      // only `sweepExpiredAttentionItems` can.
      await seedMachineActivity(database, {
        userId: "account-a",
        sessionId: "orphaned",
        lastSeenAt: "2026-07-01T08:00:00.000Z",
      });
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-b', 'expired-item', ?, 1, 1, 'expired-fingerprint',
          'agent_needs_you', 'needs_you', '{}', null, null,
          '2026-08-05T07:00:00.000Z', '2026-08-05T07:59:00.000Z'
        )
      `).run(MACHINE_KEY);

      // The opportunistic prune that device registration and publish still run
      // inline. It must stay pure retention deletes: the sweeps commit a
      // revision per account and push an APNs frame per device, which is not
      // work a routine re-registration should be made to pay for.
      await pruneAttentionState(makeAttentionEnv(database));
      expect(rows(database, `
        select item_id from attention_items order by item_id
      `)).toEqual([
        { item_id: `agent:${MACHINE_KEY}:orphaned` },
        { item_id: "expired-item" },
      ]);

      // The cron does the expensive half.
      await sweepAttentionState(makeAttentionEnv(database));
      expect(rows(database, "select item_id from attention_items")).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe("Live Activity island tallies", () => {
  function islandItem(args: {
    sessionId: string;
    phase: string;
    eventKind?: string;
    activityTier?: "signal" | "ambient" | "idle";
    chatActivityMode?: unknown;
    alertFingerprint?: string;
    contentFingerprint?: string;
  }): Record<string, unknown> {
    return {
      ...validAgentItem(),
      id: `agent:${MACHINE_KEY}:${args.sessionId}`,
      fingerprint: args.contentFingerprint ?? `content-${args.sessionId}`,
      contentFingerprint: args.contentFingerprint ?? `content-${args.sessionId}`,
      alertFingerprint:
        args.alertFingerprint ?? `alert-${args.sessionId}-${args.phase}`,
      eventKind: args.eventKind ?? "agent_running",
      phase: args.phase,
      ...(args.activityTier ? { activityTier: args.activityTier } : {}),
      ...(args.chatActivityMode !== undefined
        ? { chatActivityMode: args.chatActivityMode }
        : {}),
      destination: {
        kind: "session",
        sessionId: args.sessionId,
        itemId: null,
        eventId: null,
      },
    };
  }

  function islandPullRequestItem(number: number, phase: string): Record<string, unknown> {
    return {
      ...validAgentItem(),
      id: `pull-request:${MACHINE_KEY}:owner:repo:${number}`,
      fingerprint: `pr-content-${number}`,
      contentFingerprint: `pr-content-${number}`,
      alertFingerprint: `pr-alert-${number}-${phase}`,
      kind: "pull_request",
      eventKind: "pr_checks_failing",
      phase,
      destination: {
        kind: "pull_request",
        repoOwner: "owner",
        repoName: "repo",
        number,
        tab: "checks",
      },
    };
  }

  function seedActivityItem(
    database: SqliteD1Database,
    userId: string,
    raw: Record<string, unknown>,
  ): void {
    const machineKey = String(
      (raw.machine as Record<string, unknown>).machineKey ?? MACHINE_KEY,
    );
    const parsed = attentionTestInternals.parseAttentionItem(raw, machineKey);
    expect(parsed, `island fixture ${String(raw.id)} must parse`).not.toBeNull();
    if (!parsed) throw new Error("island fixture did not parse");
    database.native.prepare(`
      insert into attention_items(
        user_id, item_id, machine_key, source_revision, account_revision,
        fingerprint, content_fingerprint, alert_fingerprint, activity_tier,
        roster_epoch, event_kind, phase, payload_json, seen_at, dismissed_at,
        expires_at, updated_at
      ) values (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, null, null, ?, ?)
      on conflict(user_id, item_id) do update set
        fingerprint = excluded.fingerprint,
        content_fingerprint = excluded.content_fingerprint,
        alert_fingerprint = excluded.alert_fingerprint,
        phase = excluded.phase,
        event_kind = excluded.event_kind,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      userId,
      parsed.id,
      machineKey,
      parsed.revision,
      parsed.contentFingerprint,
      parsed.contentFingerprint,
      parsed.alertFingerprint,
      parsed.activityTier ?? null,
      parsed.eventKind,
      parsed.phase,
      JSON.stringify(parsed),
      parsed.expiresAt,
      parsed.updatedAt,
    );
  }

  async function contentStateFor(
    database: SqliteD1Database,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const { contentState } = await liveActivityTestInternals.accountActivityContentState(
      makeAttentionEnv(database),
      userId,
    );
    return contentState;
  }

  it("tallies the whole account, not the three-row roster the island can see", async () => {
    const database = new SqliteD1Database();
    try {
      for (let index = 0; index < 5; index += 1) {
        seedActivityItem(database, "account-a", islandItem({
          sessionId: `run-${index}`,
          phase: "running",
          activityTier: "signal",
        }));
      }
      // The raised hand sits behind the three-row cap. Deriving from `runs`
      // would report zero of them and leave the island blue.
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "hidden-hand",
        phase: "needs_you",
        eventKind: "agent_needs_you",
        activityTier: "signal",
      }));
      const contentState = await contentStateFor(database, "account-a");
      expect(contentState.runs).toHaveLength(3);
      expect(contentState.groups).toEqual([
        { group: "needs_you", count: 1 },
        { group: "working", count: 5 },
      ]);
      expect(contentState.moreCount).toBe(3);
    } finally {
      database.close();
    }
  });

  it("counts agent rows only and files idle-tier rows as the ambient tail", async () => {
    const database = new SqliteD1Database();
    try {
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "live",
        phase: "running",
        activityTier: "signal",
      }));
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "resting",
        phase: "running",
        activityTier: "idle",
      }));
      // Pull requests are tallied separately by the clients; a PR in a failing
      // state must not inflate the agent `failed` group.
      seedActivityItem(
        database,
        "account-a",
        islandPullRequestItem(42, "checks_failing"),
      );
      const contentState = await contentStateFor(database, "account-a");
      expect(contentState.prs).toHaveLength(1);
      expect(contentState.groups).toEqual([
        { group: "working", count: 1 },
        { group: "done", count: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("derives planning from chatActivityMode and never from a phase", async () => {
    const database = new SqliteD1Database();
    try {
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "planner",
        phase: "running",
        chatActivityMode: "planning",
      }));
      // No phase says "planning", and an unrecognised mode value is treated as
      // absent rather than as a new group.
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "future-mode",
        phase: "running",
        chatActivityMode: "daydreaming",
      }));
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "plain",
        phase: "running",
      }));
      expect((await contentStateFor(database, "account-a")).groups).toEqual([
        { group: "planning", count: 1 },
        { group: "working", count: 2 },
      ]);

      expect(liveActivityTestInternals.activityStateGroup({
        phase: "starting",
        kind: "agent",
        chatActivityMode: "planning",
      } as never)).toBe("planning");
      expect(liveActivityTestInternals.activityStateGroup({
        phase: "needs_you",
        kind: "agent",
        chatActivityMode: "planning",
      } as never)).toBe("needs_you");
    } finally {
      database.close();
    }
  });

  it("omits the additive fields entirely rather than sending a confident zero", async () => {
    const database = new SqliteD1Database();
    try {
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "only-one",
        phase: "running",
      }));
      const contentState = await contentStateFor(database, "account-a");
      // The roster fits, so there is nothing left off: the key is absent, not 0.
      expect("moreCount" in contentState).toBe(false);
      expect(contentState.groups).toEqual([{ group: "working", count: 1 }]);

      const empty = await contentStateFor(database, "account-with-nothing");
      expect("groups" in empty).toBe(false);
      expect("moreCount" in empty).toBe(false);
      expect(empty).toMatchObject({ activeCount: 0, runs: [], prs: [] });
    } finally {
      database.close();
    }
  });

  it("spends an APNs push on a needs-you transition but not on per-turn churn", async () => {
    const database = new SqliteD1Database();
    const apnsBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      apnsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, {
        status: 200,
        headers: { "apns-id": `island-${apnsBodies.length}` },
      });
    }));
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-1",
        pushToStartToken: "ab".repeat(32),
        ownershipEpoch: 3,
      });
      const env = makeAttentionEnv(database, {
        APNS_KEY: await generateTestP8(),
        APNS_KEY_ID: "ISLANDKEY1",
        APNS_TEAM_ID: "ISLANDTEAM",
      });
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "turn",
        phase: "running",
        activityTier: "signal",
      }));

      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies).toHaveLength(1);
      expect(apnsBodies[0]).toMatchObject({ aps: { event: "start" } });
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values ('account-a', 'phone-1', 'agent-runs', ?, '2026-07-28T08:01:00.000Z')
      `).run("cd".repeat(32));

      // Same phase entry, new preview copy and a fresher timestamp: this is what
      // every agent turn (and every 30s heartbeat) looks like on the wire.
      seedActivityItem(database, "account-a", {
        ...islandItem({
          sessionId: "turn",
          phase: "running",
          activityTier: "signal",
          contentFingerprint: "content-turn-churned",
        }),
        preview: "Read 41,207 tokens across 12 files (18.4s elapsed).",
        updatedAt: "2026-07-28T08:02:00.000Z",
      });
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies).toHaveLength(1);

      // A second working run moves the tally but not the band it belongs to,
      // so it rides along on the next real transition rather than pushing.
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "turn-2",
        phase: "running",
        activityTier: "signal",
      }));
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies).toHaveLength(1);

      // Raising a hand is the transition the island exists for.
      seedActivityItem(database, "account-a", islandItem({
        sessionId: "turn",
        phase: "needs_you",
        eventKind: "agent_needs_you",
        activityTier: "signal",
      }));
      await attentionTestInternals.deliverAccountLiveActivity(env, "account-a");
      expect(apnsBodies).toHaveLength(2);
      expect(apnsBodies[1]).toMatchObject({
        aps: {
          event: "update",
          "content-state": {
            groups: [
              { group: "needs_you", count: 1 },
              { group: "working", count: 1 },
            ],
          },
        },
      });
    } finally {
      database.close();
    }
  });
});

/**
 * The relay owns a fourth copy of the Activity state-group rule, because it is
 * a hermetic Worker that imports nothing from the repo it ships beside. Copies
 * drift: the iOS one drifted three ways (`merge_ready`, idle-tier demotion, and
 * how `planning` is derived) in the very commit that created it. The fixture is
 * the pin — every implementation runs the same rows through its own mapper.
 *
 * Canonical source: `activityStateGroup` in
 * apps/desktop/src/renderer/components/activity/activityPresentation.ts.
 * If a case here fails, the RULE did not change — this copy did. Change the
 * renderer, regenerate the fixture, then follow with all four mappers.
 */
describe("Activity state-group conformance", () => {
  type StateGroupCase = {
    name: string;
    phase: string;
    tier: "signal" | "ambient" | "idle";
    chatActivityMode: string | null;
    expected: string;
  };

  const fixture = JSON.parse(readFileSync(
    new URL(
      "../../desktop/src/shared/attention/activityStateGroup.cases.json",
      import.meta.url,
    ),
    "utf8",
  )) as { cases: StateGroupCase[] };

  // The renderer spells the amber band `needs-you` (a CSS-friendly id) and the
  // relay spells it `needs_you` (the push wire's phase vocabulary). Same group,
  // and the ONLY spelling difference between the two — anything else must fail.
  const relayGroup = (expected: string): string =>
    expected === "needs-you" ? "needs_you" : expected;

  it("has cases to check", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of fixture.cases) {
    it(`matches the canonical table: ${testCase.name}`, () => {
      expect(liveActivityTestInternals.activityStateGroup({
        kind: "agent",
        phase: testCase.phase,
        activityTier: testCase.tier,
        ...(testCase.chatActivityMode === null
          ? {}
          : { chatActivityMode: testCase.chatActivityMode }),
      } as never)).toBe(relayGroup(testCase.expected));
    });
  }
});

describe("cross-machine project identity", () => {
  // `projectId` is a per-machine `randomUUID()`. It resolves nowhere but the
  // machine that minted it, so an account-scope reader opening an item from
  // another machine — and every deep link built from one — depends on
  // `canonicalId` surviving the relay. It did not: the parser dropped it, and
  // the fix was silently leaning on the `rootPath` fallback instead.
  it("round-trips the machine-independent project id to account readers", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
    });
    try {
      const item = activityAgentItem({
        sessionId: "canonical-id",
        itemId: null,
        revision: 1,
        contentFingerprint: "canonical-content-1",
        alertFingerprint: "canonical-alert-1",
        activityTier: "ambient",
        eventKind: "agent_running",
        phase: "running",
      });
      const published = await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [{
          ...item,
          project: {
            projectId: "db-uuid-only-meaningful-here",
            canonicalId: "project_abc123",
            name: "ADE",
            rootPath: "/projects/ade",
          },
        }],
        tombstones: [],
      });
      expect(published.status).toBe(200);

      const snapshot = await (await accountRoute(
        database,
        authorization.userId,
        "GET",
        "/attention/account/snapshot?since=0",
      )).json() as {
        items: Array<{ project: { projectId: string; canonicalId: string | null } }>;
      };
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]?.project.canonicalId).toBe("project_abc123");
      expect(snapshot.items[0]?.project.projectId).toBe("db-uuid-only-meaningful-here");
    } finally {
      database.close();
      vi.unstubAllGlobals();
    }
  });

  it("keeps an item whose publisher is too old to send a canonical id", async () => {
    const database = new SqliteD1Database();
    const authorization = await machinePublishAuthorization();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === authorization.jwksUrl) return Response.json(authorization.jwks);
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const env = makeAttentionEnv(database, {
      CLERK_JWKS_URL: authorization.jwksUrl,
      CLERK_ISSUER: authorization.issuer,
      CLERK_OAUTH_CLIENT_ID: "attention-test-client",
    });
    try {
      const published = await publishActivityForTest(env, authorization, {
        machineName: "Studio",
        mode: "delta",
        rosterEpoch: 1,
        items: [activityAgentItem({
          sessionId: "legacy-publisher",
          itemId: null,
          revision: 1,
          contentFingerprint: "legacy-content-1",
          alertFingerprint: "legacy-alert-1",
          activityTier: "ambient",
          eventKind: "agent_running",
          phase: "running",
        })],
        tombstones: [],
      });
      expect(published.status).toBe(200);

      const snapshot = await (await accountRoute(
        database,
        authorization.userId,
        "GET",
        "/attention/account/snapshot?since=0",
      )).json() as {
        items: Array<{ project: { canonicalId: string | null; rootPath: string | null } }>;
      };
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0]?.project.canonicalId ?? null).toBeNull();
      // The reader's remaining cross-machine identity must still be there.
      expect(snapshot.items[0]?.project.rootPath).toBe("/projects/ade");
    } finally {
      database.close();
      vi.unstubAllGlobals();
    }
  });
});
