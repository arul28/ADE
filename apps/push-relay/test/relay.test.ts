import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, resetSpendGuardsForTests, signPushRelayRequest, type PushRelayEnv } from "../src/relay";
import { resetApnsJwtCache } from "../src/apns";

type MachineRow = { machine_key: string; secret: string; created_at: string; last_seen_at: string };
type DeviceRow = {
  machine_key: string;
  device_id: string;
  apns_token: string | null;
  push_to_start_token: string | null;
  bundle_id: string;
  aps_environment: string;
  platform: string | null;
  device_name: string | null;
  registered_at: string;
  updated_at: string;
  generation: string | null;
};
type ActivityTokenRow = { machine_key: string; device_id: string; activity_id: string; token: string; updated_at: string };
type SuppressionRow = { machine_key: string; suppression_key: string; content_hash: string; published_at: string };

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeD1Database,
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

class FakeD1Database {
  machines: MachineRow[] = [];
  devices: DeviceRow[] = [];
  activityTokens: ActivityTokenRow[] = [];
  suppressions: SuppressionRow[] = [];
  rateCounters = new Map<string, { window_start: number; count: number; updated_at: string }>();
  private nextBatchFailureIndex: number | null = null;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ success: boolean }>> {
    const snapshot = {
      machines: this.machines.map((row) => ({ ...row })),
      devices: this.devices.map((row) => ({ ...row })),
      activityTokens: this.activityTokens.map((row) => ({ ...row })),
      suppressions: this.suppressions.map((row) => ({ ...row })),
      rateCounters: new Map(
        [...this.rateCounters].map(([key, value]) => [key, { ...value }]),
      ),
    };
    try {
      const results: Array<{ success: boolean }> = [];
      for (const [index, statement] of statements.entries()) {
        if (index === this.nextBatchFailureIndex) {
          throw new Error(`injected batch failure at statement ${index}`);
        }
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.machines = snapshot.machines;
      this.devices = snapshot.devices;
      this.activityTokens = snapshot.activityTokens;
      this.suppressions = snapshot.suppressions;
      this.rateCounters = snapshot.rateCounters;
      throw error;
    } finally {
      this.nextBatchFailureIndex = null;
    }
  }

  failNextBatchAt(index: number): void {
    this.nextBatchFailureIndex = index;
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("from machines")) {
      const [machineKey] = values;
      return (this.machines.find((row) => row.machine_key === machineKey) ?? null) as T | null;
    }
    if (sql.includes("from publish_suppression")) {
      const [machineKey, suppressionKey] = values;
      const row = this.suppressions.find(
        (entry) => entry.machine_key === machineKey && entry.suppression_key === suppressionKey,
      );
      return (row ? { content_hash: row.content_hash } : null) as T | null;
    }
    if (sql.startsWith("insert into rate_counters") && sql.includes("returning count")) {
      if (sql.includes("case when")) {
        // Rate-limit path: atomic increment with inline window rollover; the
        // WHERE guard makes an over-limit window a no-op (no write, no row).
        const [bucket, nowSeconds, updatedAt, windowSeconds, limit] = values as [string, number, string, number, number];
        const existing = this.rateCounters.get(bucket);
        if (!existing || nowSeconds - existing.window_start >= windowSeconds) {
          this.rateCounters.set(bucket, { window_start: nowSeconds, count: 1, updated_at: updatedAt });
          return { count: 1 } as T;
        }
        if (existing.count < limit) {
          existing.count += 1;
          existing.updated_at = updatedAt;
          return { count: existing.count } as T;
        }
        return null; // WHERE guard suppressed the update → rejected, no write
      }
      // Budget path: atomic increment-and-read (no window rollover).
      const [bucket, windowStart, updatedAt] = values as [string, number, string];
      const existing = this.rateCounters.get(bucket);
      if (!existing) {
        this.rateCounters.set(bucket, { window_start: windowStart, count: 1, updated_at: updatedAt });
        return { count: 1 } as T;
      }
      existing.count += 1;
      existing.updated_at = updatedAt;
      return { count: existing.count } as T;
    }
    if (sql.includes("from rate_counters")) {
      const [bucket] = values as string[];
      const row = this.rateCounters.get(bucket);
      return (row ? { window_start: row.window_start, count: row.count } : null) as T | null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (sql.includes("from device_registrations")) {
      const [machineKey] = values;
      return this.devices
        .filter((row) => row.machine_key === machineKey)
        .map((row) => ({ ...row })) as T[];
    }
    if (sql.includes("from live_activity_tokens")) {
      const [machineKey, activityId] = values;
      return this.activityTokens
        .filter(
          (row) => row.machine_key === machineKey && row.activity_id === activityId,
        )
        .map((row) => ({ ...row })) as T[];
    }
    return [];
  }

  run(sql: string, values: unknown[]): void {
    if (sql.startsWith("insert into rate_counters")) {
      const [bucket, windowStart, updatedAt] = values as [string, number, string];
      const existing = this.rateCounters.get(bucket);
      if (!existing) {
        this.rateCounters.set(bucket, { window_start: windowStart, count: 1, updated_at: updatedAt });
        return;
      }
      if (sql.includes("count = rate_counters.count + 1")) {
        existing.count += 1;
        existing.updated_at = updatedAt;
      } else {
        existing.window_start = windowStart;
        existing.count = 1;
        existing.updated_at = updatedAt;
      }
      return;
    }
    if (sql.startsWith("update rate_counters set count = count + 1")) {
      const [updatedAt, bucket] = values as [string, string];
      const existing = this.rateCounters.get(bucket);
      if (existing) {
        existing.count += 1;
        existing.updated_at = updatedAt;
      }
      return;
    }
    if (sql.startsWith("delete from rate_counters")) {
      return; // prune — not asserted in tests
    }
    if (sql.startsWith("insert into machines")) {
      const [machineKey, secret, createdAt, lastSeenAt] = values as string[];
      // Mirror `on conflict(machine_key) do nothing`: the primary key is unique.
      if (this.machines.some((row) => row.machine_key === machineKey)) return;
      this.machines.push({ machine_key: machineKey, secret, created_at: createdAt, last_seen_at: lastSeenAt });
      return;
    }
    if (sql.startsWith("update machines set last_seen_at")) {
      const [lastSeenAt, machineKey] = values as string[];
      const machine = this.machines.find((row) => row.machine_key === machineKey);
      if (machine) machine.last_seen_at = lastSeenAt;
      return;
    }
    if (sql.includes("insert into device_registrations")) {
      const [
        machineKey,
        deviceId,
        apnsToken,
        pushToStartToken,
        bundleId,
        apsEnvironment,
        platform,
        deviceName,
        registeredAt,
        updatedAt,
        generation,
        clearPushToStartToken,
      ] =
        values as Array<string | number | null>;
      const existing = this.devices.find(
        (row) => row.machine_key === machineKey && row.device_id === deviceId,
      );
      if (existing) {
        existing.apns_token = (apnsToken as string | null) ?? existing.apns_token;
        existing.push_to_start_token = clearPushToStartToken === 1
          ? null
          : (pushToStartToken as string | null) ?? existing.push_to_start_token;
        existing.bundle_id = bundleId as string;
        existing.aps_environment = apsEnvironment as string;
        existing.platform = (platform as string | null) ?? existing.platform;
        existing.device_name = (deviceName as string | null) ?? existing.device_name;
        existing.updated_at = updatedAt as string;
        existing.generation = generation as string;
        return;
      }
      this.devices.push({
        machine_key: machineKey as string,
        device_id: deviceId as string,
        apns_token: apnsToken as string | null,
        push_to_start_token: pushToStartToken as string | null,
        bundle_id: bundleId as string,
        aps_environment: apsEnvironment as string,
        platform: platform as string | null,
        device_name: deviceName as string | null,
        registered_at: registeredAt as string,
        updated_at: updatedAt as string,
        generation: generation as string,
      });
      return;
    }
    if (sql.startsWith("update device_registrations set apns_token = null")) {
      const [, machineKey, deviceId] = values as string[];
      const device = this.devices.find((row) => row.machine_key === machineKey && row.device_id === deviceId);
      if (device) device.apns_token = null;
      return;
    }
    if (sql.startsWith("update device_registrations set push_to_start_token = null")) {
      const [, machineKey, deviceId] = values as string[];
      const device = this.devices.find((row) => row.machine_key === machineKey && row.device_id === deviceId);
      if (device) device.push_to_start_token = null;
      return;
    }
    if (sql.startsWith("delete from device_registrations where machine_key = ? and device_id = ?")) {
      const [machineKey, deviceId] = values as string[];
      this.devices = this.devices.filter(
        (row) => !(row.machine_key === machineKey && row.device_id === deviceId),
      );
      return;
    }
    if (sql.includes("insert into live_activity_tokens")) {
      const [machineKey, deviceId, activityId, token, updatedAt] = values as string[];
      const existing = this.activityTokens.find(
        (row) => row.machine_key === machineKey && row.device_id === deviceId && row.activity_id === activityId,
      );
      if (existing) {
        existing.token = token;
        existing.updated_at = updatedAt;
        return;
      }
      this.activityTokens.push({
        machine_key: machineKey,
        device_id: deviceId,
        activity_id: activityId,
        token,
        updated_at: updatedAt,
      });
      return;
    }
    if (sql.startsWith("delete from live_activity_tokens where machine_key = ? and device_id = ? and activity_id = ?")) {
      const [machineKey, deviceId, activityId] = values as string[];
      this.activityTokens = this.activityTokens.filter(
        (row) => !(row.machine_key === machineKey && row.device_id === deviceId && row.activity_id === activityId),
      );
      return;
    }
    if (sql.startsWith("delete from live_activity_tokens where machine_key = ? and device_id = ?")) {
      const [machineKey, deviceId] = values as string[];
      this.activityTokens = this.activityTokens.filter(
        (row) => !(row.machine_key === machineKey && row.device_id === deviceId),
      );
      return;
    }
    if (sql.includes("insert into publish_suppression")) {
      const [
        machineKey,
        suppressionKey,
        contentHash,
        publishedAt,
        expectedMachineKey,
        expectedDeviceId,
        expectedGeneration,
      ] = values as string[];
      if (expectedMachineKey) {
        const currentDevice = this.devices.find(
          (row) =>
            row.machine_key === expectedMachineKey
            && row.device_id === expectedDeviceId,
        );
        if (!currentDevice || currentDevice.generation !== expectedGeneration) {
          return;
        }
      }
      const existing = this.suppressions.find(
        (row) => row.machine_key === machineKey && row.suppression_key === suppressionKey,
      );
      if (existing) {
        existing.content_hash = contentHash;
        existing.published_at = publishedAt;
        return;
      }
      this.suppressions.push({
        machine_key: machineKey,
        suppression_key: suppressionKey,
        content_hash: contentHash,
        published_at: publishedAt,
      });
      return;
    }
    if (
      sql.startsWith("delete from publish_suppression")
      && sql.includes("substr(suppression_key")
    ) {
      const [machineKey, prefixLength, prefix] = values as [string, number, string];
      this.suppressions = this.suppressions.filter(
        (row) =>
          row.machine_key !== machineKey
          || row.suppression_key.slice(0, prefixLength) !== prefix,
      );
      return;
    }
    // Retention deletes are exercised implicitly; the fake keeps them no-ops.
  }
}

const MACHINE_KEY = "a".repeat(32);
const SECRET = "s".repeat(48);
const P8_TEST_KEY = ""; // populated in beforeEach with a fresh generated key

async function generateTestP8(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

function makeEnv(db: FakeD1Database, apnsKey: string | undefined): PushRelayEnv {
  return {
    DB: db as unknown as D1Database,
    APNS_KEY: apnsKey,
    APNS_KEY_ID: apnsKey ? "TESTKEY123" : undefined,
    APNS_TEAM_ID: apnsKey ? "TESTTEAM12" : undefined,
  };
}

async function signedRequest(args: {
  method: string;
  path: string;
  body?: unknown;
  secret?: string;
  timestamp?: string;
}): Promise<Request> {
  const bodyText = args.body === undefined ? "" : JSON.stringify(args.body);
  const timestamp = args.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = await signPushRelayRequest(args.secret ?? SECRET, {
    timestamp,
    method: args.method,
    pathname: args.path,
    body: bodyText,
  });
  return new Request(`https://push.example${args.path}`, {
    method: args.method,
    headers: {
      "content-type": "application/json",
      "x-ade-push-timestamp": timestamp,
      "x-ade-push-signature": signature,
    },
    body: args.body === undefined ? undefined : bodyText,
  });
}

function ipRequest(path: string, ip: string, init: RequestInit = {}): Request {
  return new Request(`https://push.example${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), "cf-connecting-ip": ip },
  });
}

async function claimMachine(db: FakeD1Database, env: PushRelayEnv): Promise<void> {
  const response = await handleRequest(
    new Request(`https://push.example/machines/${MACHINE_KEY}/claim`, {
      method: "POST",
      body: JSON.stringify({ secret: SECRET }),
    }),
    env,
  );
  expect(response.status).toBe(201);
}

describe("push relay", () => {
  let db: FakeD1Database;
  let apnsKey: string;

  beforeEach(async () => {
    db = new FakeD1Database();
    apnsKey = P8_TEST_KEY || (await generateTestP8());
    resetApnsJwtCache();
    resetSpendGuardsForTests();
  });

  it("reports account authentication readiness without exposing binding values", async () => {
    const env: PushRelayEnv = {
      ...makeEnv(db, undefined),
      CLERK_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
      CLERK_ISSUER: "https://clerk.example",
      CLERK_OAUTH_CLIENT_ID: "prod-client",
      CLERK_SECONDARY_JWKS_URL: "https://clerk-dev.example/.well-known/jwks.json",
      CLERK_SECONDARY_ISSUER: "https://clerk-dev.example",
      CLERK_SECONDARY_OAUTH_CLIENT_ID: "dev-client",
    };
    const response = await handleRequest(new Request("https://push.example/health"), env);
    expect(response.status).toBe(200);
    const health = await response.json() as Record<string, unknown>;
    expect(health).toMatchObject({
      ok: true,
      accountAuthConfigured: true,
      primaryAccountAuthConfigured: true,
      secondaryAccountAuthConfigured: true,
      accountAuthConfigurationErrors: [],
    });
    expect(JSON.stringify(health)).not.toContain("clerk.example");
    expect(JSON.stringify(health)).not.toContain("prod-client");
  });

  it("allows only the configured hosted origin to preflight account Attention", async () => {
    const env: PushRelayEnv = {
      ...makeEnv(db, undefined),
      WEB_CLIENT_ORIGIN: "https://app.ade-app.dev",
    };
    const allowed = await handleRequest(
      new Request("https://push.example/attention/account/snapshot", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.ade-app.dev",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
      env,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin"))
      .toBe("https://app.ade-app.dev");

    const hostile = await handleRequest(
      new Request("https://push.example/attention/account/snapshot", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      }),
      env,
    );
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps allowed browser account errors readable across early relay gates", async () => {
    const env: PushRelayEnv = {
      ...makeEnv(db, undefined),
      WEB_CLIENT_ORIGIN: "https://app.ade-app.dev",
    };
    const response = await handleRequest(
      new Request("https://push.example/attention/account/ack", {
        method: "POST",
        headers: {
          origin: "https://app.ade-app.dev",
          "content-length": String(2 * 1024 * 1024),
        },
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://app.ade-app.dev");
    expect(await response.json()).toMatchObject({ error: "payload too large" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("matches the cross-app golden signature vector (must equal ade-cli's)", async () => {
    // Pinned in BOTH apps (see apps/ade-cli/src/services/push/
    // pushPublisherService.test.ts). If either side's canonical string
    // drifts, exactly one of the two tests breaks.
    const signature = await signPushRelayRequest("ade-parity-secret-0123456789abcdef0123456789", { // gitleaks:allow — golden test vector
      timestamp: "1751712000",
      method: "POST",
      pathname: "/machines/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/publish",
      body: '{"notifications":[{"title":"parity","phase":"waiting"}]}',
    });
    expect(signature).toBe("sha256=5c5c3a3081a0c6bec96c4191a88ab17b59382b902c6071672ea6d8daa30764f3"); // gitleaks:allow
  });

  it("rolls back the fake D1 batch when a later statement fails", async () => {
    db.failNextBatchAt(1);
    await expect(db.batch([
      db.prepare("insert into machines(machine_key, secret, created_at, last_seen_at) values (?, ?, ?, ?)")
        .bind(MACHINE_KEY, SECRET, "2026-07-28T08:00:00.000Z", "2026-07-28T08:00:00.000Z"),
      db.prepare("insert into publish_suppression(machine_key, suppression_key, content_hash, published_at) values (?, ?, ?, ?)")
        .bind(MACHINE_KEY, "attention", "fingerprint", "2026-07-28T08:00:00.000Z"),
    ])).rejects.toThrow("injected batch failure at statement 1");

    expect(db.machines).toEqual([]);
    expect(db.suppressions).toEqual([]);
  });

  it("claims a machine once and allows an idempotent re-claim", async () => {
    const env = makeEnv(db, undefined);
    await claimMachine(db, env);

    const reclaim = await handleRequest(
      new Request(`https://push.example/machines/${MACHINE_KEY}/claim`, {
        method: "POST",
        body: JSON.stringify({ secret: SECRET }),
      }),
      env,
    );
    expect(reclaim.status).toBe(200);

    const conflict = await handleRequest(
      new Request(`https://push.example/machines/${MACHINE_KEY}/claim`, {
        method: "POST",
        body: JSON.stringify({ secret: "x".repeat(48) }),
      }),
      env,
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects unsigned and badly signed device registrations", async () => {
    const env = makeEnv(db, undefined);
    await claimMachine(db, env);

    const unsigned = await handleRequest(
      new Request(`https://push.example/machines/${MACHINE_KEY}/devices/phone-1`, {
        method: "PUT",
        body: JSON.stringify({ bundleId: "com.ade.ios", apsEnvironment: "sandbox" }),
      }),
      env,
    );
    expect(unsigned.status).toBe(401);

    const badSecret = await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { bundleId: "com.ade.ios", apsEnvironment: "sandbox" },
        secret: "wrong".padEnd(48, "w"),
      }),
      env,
    );
    expect(badSecret.status).toBe(401);

    const staleTimestamp = await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { bundleId: "com.ade.ios", apsEnvironment: "sandbox" },
        timestamp: String(Math.floor(Date.now() / 1000) - 3600),
      }),
      env,
    );
    expect(staleTimestamp.status).toBe(401);
  });

  it("registers a device and lists it back", async () => {
    const env = makeEnv(db, undefined);
    await claimMachine(db, env);

    const register = await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: {
          apnsToken: "ab".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
          platform: "iOS",
          deviceName: "Arul iPhone",
        },
      }),
      env,
    );
    expect(register.status).toBe(200);

    const list = await handleRequest(
      await signedRequest({ method: "GET", path: `/machines/${MACHINE_KEY}/devices` }),
      env,
    );
    const payload = (await list.json()) as { devices: Array<{ deviceId: string; hasApnsToken: boolean }> };
    expect(payload.devices).toHaveLength(1);
    expect(payload.devices[0]).toMatchObject({ deviceId: "phone-1", hasApnsToken: true });
  });

  it("preserves an omitted push-to-start token and clears it only explicitly", async () => {
    const env = makeEnv(db, undefined);
    await claimMachine(db, env);
    const path = `/machines/${MACHINE_KEY}/devices/phone-1`;
    const route = async (body: Record<string, unknown>) => handleRequest(
      await signedRequest({ method: "PUT", path, body }),
      env,
    );

    expect((await route({
      pushToStartToken: "cd".repeat(32),
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    })).status).toBe(200);
    expect((await route({
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    })).status).toBe(200);
    expect(db.devices[0]?.push_to_start_token).toBe("cd".repeat(32));

    expect((await route({
      clearPushToStartToken: true,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    })).status).toBe(200);
    expect(db.devices[0]?.push_to_start_token).toBeNull();

    expect((await route({
      pushToStartToken: "ef".repeat(32),
      clearPushToStartToken: true,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    })).status).toBe(400);
  });

  it("publishes an alert push with phase TTL and clears dead tokens", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { apnsToken: "ab".repeat(32), bundleId: "com.ade.ios", apsEnvironment: "sandbox" },
      }),
      env,
    );

    const apnsCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("push.apple.com")) {
        apnsCalls.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: String(init?.body ?? ""),
        });
        return new Response(null, { status: 200, headers: { "apns-id": "apns-1" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const publish = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          notifications: [{
            title: "Claude needs input",
            body: "fix-login-flow · approve the plan",
            deepLink: "ade://session/abc123",
            phase: "waiting",
            collapseId: "session-abc123",
          }],
        },
      }),
      env,
    );
    expect(publish.status).toBe(200);
    const result = (await publish.json()) as { delivered: number };
    expect(result.delivered).toBe(1);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0]?.url).toContain("api.sandbox.push.apple.com");
    expect(apnsCalls[0]?.headers["apns-topic"]).toBe("com.ade.ios");
    expect(apnsCalls[0]?.headers["apns-push-type"]).toBe("alert");
    const expiration = Number(apnsCalls[0]?.headers["apns-expiration"]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(expiration).toBeGreaterThan(nowSeconds + 23 * 60 * 60);
    expect(expiration).toBeLessThan(nowSeconds + 25 * 60 * 60);
    const body = JSON.parse(apnsCalls[0]?.body ?? "{}") as { aps: { alert: { title: string } }; deepLink: string };
    expect(body.aps.alert.title).toBe("Claude needs input");
    expect(body.deepLink).toBe("ade://session/abc123");

    // Dead token: next publish returns 410 and the registration's token clears.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("push.apple.com")) {
        return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const second = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: { notifications: [{ title: "Turn failed", phase: "terminal" }] },
      }),
      env,
    );
    expect(second.status).toBe(200);
    expect(db.devices[0]?.apns_token).toBeNull();
  });

  it("passes actionable fields through: category into aps, sessionId/itemId top-level, badge count", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { apnsToken: "ab".repeat(32), bundleId: "com.ade.ios", apsEnvironment: "sandbox" },
      }),
      env,
    );

    const apnsCalls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      apnsCalls.push({ body: String(init?.body ?? "") });
      return new Response(null, { status: 200 });
    }));

    const publish = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          notifications: [{
            title: "Claude needs your approval",
            deepLink: "ade://session/s-1",
            sessionId: "s-1",
            itemId: "item-42",
            category: "ADE_APPROVAL",
            badge: 2,
            phase: "waiting",
          }],
        },
      }),
      env,
    );
    expect(publish.status).toBe(200);
    const body = JSON.parse(apnsCalls[0]?.body ?? "{}") as {
      aps: { category?: string; badge?: number };
      sessionId?: string;
      itemId?: string;
    };
    expect(body.aps.category).toBe("ADE_APPROVAL");
    expect(body.aps.badge).toBe(2);
    expect(body.sessionId).toBe("s-1");
    expect(body.itemId).toBe("item-42");
  });

  it("delivers a silent badge-only item (no title) and rejects a bare empty item", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { apnsToken: "ab".repeat(32), bundleId: "com.ade.ios", apsEnvironment: "sandbox" },
      }),
      env,
    );

    const apnsCalls: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      apnsCalls.push({ body: String(init?.body ?? "") });
      return new Response(null, { status: 200 });
    }));

    const badgeOnly = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: { notifications: [{ title: "", sound: null, badge: 0, phase: "terminal" }] },
      }),
      env,
    );
    expect(badgeOnly.status).toBe(200);
    expect(((await badgeOnly.json()) as { delivered: number }).delivered).toBe(1);
    const body = JSON.parse(apnsCalls[0]?.body ?? "{}") as { aps: { badge?: number; alert?: unknown; sound?: unknown } };
    expect(body.aps.badge).toBe(0);
    expect(body.aps.alert).toBeUndefined();
    expect(body.aps.sound).toBeUndefined();

    // Title-less AND badge-less item is invalid → nothing to publish.
    const empty = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: { notifications: [{ body: "no title", phase: "waiting" }] },
      }),
      env,
    );
    expect(empty.status).toBe(400);
  });

  it("suppresses redundant publishes by dedupe key content hash", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: { apnsToken: "ab".repeat(32), bundleId: "com.ade.ios", apsEnvironment: "production" },
      }),
      env,
    );

    let sends = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      sends += 1;
      return new Response(null, { status: 200 });
    }));

    const publishOnce = async () => handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          notifications: [{
            title: "Awaiting input",
            body: "same content",
            dedupeKey: "session-abc123:awaiting",
            phase: "waiting",
          }],
        },
      }),
      env,
    );

    const first = (await (await publishOnce()).json()) as { delivered: number; suppressed: number };
    expect(first.delivered).toBe(1);
    const second = (await (await publishOnce()).json()) as { delivered: number; suppressed: number };
    expect(second.suppressed).toBe(1);
    expect(sends).toBe(1);
  });

  it("routes live activity start to push-to-start and update to activity tokens", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: {
          pushToStartToken: "cd".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      }),
      env,
    );

    const apnsCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      apnsCalls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body ?? ""),
      });
      return new Response(null, { status: 200 });
    }));

    const start = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            event: "start",
            activityId: "agent-runs",
            attributesType: "ADEAgentRunsAttributes",
            attributes: { machineName: "MacBook" },
            contentState: { runs: [{ title: "fix-login", phase: "running" }] },
            phase: "running",
          }],
        },
      }),
      env,
    );
    expect(start.status).toBe(200);
    expect(apnsCalls).toHaveLength(1);
    expect(apnsCalls[0]?.headers["apns-topic"]).toBe("com.ade.ios.push-type.liveactivity");
    expect(apnsCalls[0]?.headers["apns-push-type"]).toBe("liveactivity");
    const startBody = JSON.parse(apnsCalls[0]?.body ?? "{}") as { aps: Record<string, unknown> };
    expect(startBody.aps.event).toBe("start");
    expect(startBody.aps["attributes-type"]).toBe("ADEAgentRunsAttributes");

    // Phone reports the per-activity token; update targets it.
    const tokenUpsert = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/live-activity-tokens`,
        body: { deviceId: "phone-1", activityId: "agent-runs", token: "ef".repeat(32) },
      }),
      env,
    );
    expect(tokenUpsert.status).toBe(200);

    const update = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            event: "update",
            activityId: "agent-runs",
            contentState: { runs: [{ title: "fix-login", phase: "waiting_for_input" }] },
            phase: "waiting",
          }],
        },
      }),
      env,
    );
    expect(update.status).toBe(200);
    expect(apnsCalls).toHaveLength(2);
    expect(apnsCalls[1]?.url).toContain(`/3/device/${"ef".repeat(32)}`);

    // End removes the stored activity token.
    const end = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            event: "end",
            activityId: "agent-runs",
            contentState: { runs: [] },
            dismissalDate: Math.floor(Date.now() / 1000) + 60,
            phase: "terminal",
          }],
        },
      }),
      env,
    );
    expect(end.status).toBe(200);
    expect(db.activityTokens).toHaveLength(0);
  });

  it("suppresses Live Activity content per device so a failed phone can retry", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    for (const [deviceId, token] of [
      ["phone-1", "ab".repeat(32)],
      ["phone-2", "cd".repeat(32)],
    ]) {
      const registration = await handleRequest(
        await signedRequest({
          method: "PUT",
          path: `/machines/${MACHINE_KEY}/devices/${deviceId}`,
          body: {
            pushToStartToken: token,
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
          },
        }),
        env,
      );
      expect(registration.status).toBe(200);
    }

    let phone2Attempts = 0;
    const apnsCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      apnsCalls.push(url);
      if (url.endsWith("cd".repeat(32))) {
        phone2Attempts += 1;
        if (phone2Attempts === 1) {
          return Response.json({ reason: "InternalServerError" }, { status: 500 });
        }
      }
      return new Response(null, { status: 200 });
    }));

    const publish = async (deviceIds: string[]) => handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            deviceIds,
            event: "start",
            activityId: "agent-runs",
            attributesType: "ADEAgentRunsAttributes",
            attributes: { machineName: "Studio" },
            contentState: { runs: [{ title: "fix-login", phase: "running" }] },
            dedupeKey: "agent-runs",
            phase: "running",
          }],
        },
      }),
      env,
    );

    const first = await publish(["phone-1", "phone-2"]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ delivered: 1, failed: 1 });

    const retry = await publish(["phone-2"]);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      delivered: 1,
      failed: 0,
      suppressed: 0,
    });

    const alreadyDelivered = await publish(["phone-1"]);
    expect(alreadyDelivered.status).toBe(200);
    expect(await alreadyDelivered.json()).toMatchObject({
      delivered: 0,
      suppressed: 1,
    });

    const phone1Path = `/machines/${MACHINE_KEY}/devices/phone-1`;
    expect((await handleRequest(
      await signedRequest({
        method: "PUT",
        path: phone1Path,
        body: {
          clearPushToStartToken: true,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      }),
      env,
    )).status).toBe(200);
    expect((await handleRequest(
      await signedRequest({
        method: "PUT",
        path: phone1Path,
        body: {
          pushToStartToken: "ab".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      }),
      env,
    )).status).toBe(200);

    const replacementStart = await publish(["phone-1"]);
    expect(replacementStart.status).toBe(200);
    expect(await replacementStart.json()).toMatchObject({
      delivered: 1,
      suppressed: 0,
    });
    expect(apnsCalls).toHaveLength(4);
  });

  it("retains a Live Activity token until a transient end retry succeeds", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    expect((await handleRequest(
      await signedRequest({
        method: "PUT",
        path: `/machines/${MACHINE_KEY}/devices/phone-1`,
        body: {
          pushToStartToken: "ab".repeat(32),
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      }),
      env,
    )).status).toBe(200);
    expect((await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/live-activity-tokens`,
        body: {
          deviceId: "phone-1",
          activityId: "agent-runs",
          token: "ef".repeat(32),
        },
      }),
      env,
    )).status).toBe(200);

    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ reason: "InternalServerError" }, { status: 500 })
        : new Response(null, { status: 200 });
    }));
    const publishEnd = async () => handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            deviceIds: ["phone-1"],
            event: "end",
            activityId: "agent-runs",
            contentState: { runs: [] },
            dedupeKey: "agent-runs",
            phase: "terminal",
          }],
        },
      }),
      env,
    );

    const first = await publishEnd();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ delivered: 0, failed: 1 });
    expect(db.activityTokens).toHaveLength(1);

    const retry = await publishEnd();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ delivered: 1, failed: 0 });
    expect(db.activityTokens).toHaveLength(0);
  });

  it("does not recreate cleared suppression from an in-flight APNs response", async () => {
    const env = makeEnv(db, apnsKey);
    await claimMachine(db, env);
    const path = `/machines/${MACHINE_KEY}/devices/phone-1`;
    const register = async (body: Record<string, unknown>) => handleRequest(
      await signedRequest({
        method: "PUT",
        path,
        body: {
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
          ...body,
        },
      }),
      env,
    );
    expect((await register({ pushToStartToken: "ab".repeat(32) })).status).toBe(200);

    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let completeOldSend!: () => void;
    const oldSendCompletion = new Promise<void>((resolve) => {
      completeOldSend = resolve;
    });
    let sends = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      sends += 1;
      if (sends === 1) {
        markSendStarted();
        await oldSendCompletion;
      }
      return new Response(null, { status: 200 });
    }));
    const publish = async () => handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: {
          liveActivity: [{
            deviceIds: ["phone-1"],
            event: "start",
            activityId: "agent-runs",
            attributesType: "ADEAgentRunsAttributes",
            attributes: { machineName: "Studio" },
            contentState: { runs: [{ title: "fix-login", phase: "running" }] },
            dedupeKey: "agent-runs",
            phase: "running",
          }],
        },
      }),
      env,
    );

    const oldPublish = publish();
    await sendStarted;
    expect((await register({ clearPushToStartToken: true })).status).toBe(200);
    expect((await register({ pushToStartToken: "ab".repeat(32) })).status).toBe(200);
    completeOldSend();
    expect((await oldPublish).status).toBe(200);

    const replacement = await publish();
    expect(replacement.status).toBe(200);
    expect(await replacement.json()).toMatchObject({
      delivered: 1,
      suppressed: 0,
    });
    expect(sends).toBe(2);
  });

  it("returns 503 from publish when the APNs key is not configured", async () => {
    const env = makeEnv(db, undefined);
    await claimMachine(db, env);
    const publish = await handleRequest(
      await signedRequest({
        method: "POST",
        path: `/machines/${MACHINE_KEY}/publish`,
        body: { notifications: [{ title: "x" }] },
      }),
      env,
    );
    expect(publish.status).toBe(503);
  });

  it("rate limits /claim per IP and stops writing new machine rows past the limit", async () => {
    const env: PushRelayEnv = { ...makeEnv(db, undefined), CLAIM_RATE_LIMIT_PER_MIN: "3", IP_RATE_LIMIT_PER_MIN: "1000" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const key = "a".repeat(39) + i; // 40 hex chars, distinct machine per attempt
      const res = await handleRequest(
        ipRequest(`/machines/${key}/claim`, "9.9.9.9", { method: "POST", body: JSON.stringify({ secret: SECRET }) }),
        env,
      );
      statuses.push(res.status);
    }
    // First 3 claims succeed (201, new machine each); the rest are rate-limited.
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    // The 429s never reached the DB insert — the machines table stopped growing.
    expect(db.machines).toHaveLength(3);
  });

  it("uses one fail-closed bucket when cf-connecting-ip is absent (never bypasses the claim gate)", async () => {
    const env: PushRelayEnv = { ...makeEnv(db, undefined), CLAIM_RATE_LIMIT_PER_MIN: "2", IP_RATE_LIMIT_PER_MIN: "1000" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const key = "b".repeat(39) + (i % 10);
      const res = await handleRequest(
        new Request(`https://push.example/machines/${key}/claim`, { method: "POST", body: JSON.stringify({ secret: "x" }) }),
        env,
      );
      statuses.push(res.status);
    }
    // No IP header → shared `unknown` bucket, still gated. On the real edge
    // Cloudflare always sets the header; off-edge (dev) we fail closed so the
    // unauthenticated /claim write is never bypassed.
    expect(statuses).toEqual([400, 400, 429, 429, 429]);
  });

  it("counts rate-limited requests against the daily budget (the cap bounds abuse traffic)", async () => {
    // A flooding IP is 429'd by the IP gate, but each 429 still ran the Worker —
    // so it must advance the budget. With budget 3 and IP limit 1, the 4th
    // request from the same IP flips from a rate-limit 429 to a budget 429.
    const env: PushRelayEnv = { ...makeEnv(db, undefined), IP_RATE_LIMIT_PER_MIN: "1", DAILY_REQUEST_BUDGET: "3" };
    const ping = () =>
      handleRequest(ipRequest(`/machines/${"e".repeat(40)}/devices`, "8.8.8.8", { method: "GET" }), env);
    const bodies: unknown[] = [];
    for (let i = 0; i < 4; i += 1) bodies.push(await (await ping()).json());
    // First request passes the IP gate (then 401); #2 and #3 are rate-limited;
    // #4 is over the daily budget — proving 429s were counted against the cap.
    expect(bodies[1]).toMatchObject({ error: "rate limited" });
    expect(bodies[2]).toMatchObject({ error: "rate limited" });
    expect(bodies[3]).toMatchObject({ error: "relay daily budget reached" });
  });

  it("rate limits a flooding IP without affecting a different IP", async () => {
    const env: PushRelayEnv = { ...makeEnv(db, undefined), IP_RATE_LIMIT_PER_MIN: "2", CLAIM_RATE_LIMIT_PER_MIN: "1000" };
    const hit = (ip: string) =>
      handleRequest(ipRequest(`/machines/${"c".repeat(40)}/devices`, ip, { method: "GET" }), env);
    // Under the limit the IP gate passes; auth then rejects with 401 (not 429).
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    expect((await hit("1.1.1.1")).status).not.toBe(429);
    expect((await hit("1.1.1.1")).status).toBe(429); // 3rd from this IP is over limit 2
    expect((await hit("2.2.2.2")).status).not.toBe(429); // a different IP is unaffected
  });

  it("enforces the daily request budget and then rejects every source", async () => {
    const env: PushRelayEnv = {
      ...makeEnv(db, undefined),
      DAILY_REQUEST_BUDGET: "2",
      IP_RATE_LIMIT_PER_MIN: "1000",
      CLAIM_RATE_LIMIT_PER_MIN: "1000",
    };
    const ping = (ip: string) =>
      handleRequest(ipRequest(`/machines/${"d".repeat(40)}/devices`, ip, { method: "GET" }), env);
    expect((await ping("5.5.5.5")).status).not.toBe(429);
    expect((await ping("6.6.6.6")).status).not.toBe(429);
    // Budget of 2 is now exceeded — the 3rd request is rejected regardless of IP.
    const blown = await ping("7.7.7.7");
    expect(blown.status).toBe(429);
    expect(await blown.json()).toMatchObject({ error: "relay daily budget reached" });
    // /health always bypasses every gate so monitoring never trips the budget.
    const health = await handleRequest(new Request("https://push.example/health"), env);
    expect(health.status).toBe(200);
  });
});
