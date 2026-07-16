import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleRequest, verifyCallerToken, type Env } from "../src/directory";
import worker from "../src/index";

type StoredMachine = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  name: string | null;
  platform: string | null;
  device_type: string | null;
  pubkey: string | null;
  reachable_endpoints: string | null;
  last_seen_at: number | null;
  created_at: number | null;
};

type StoredDeviceAuthorization = {
  device_code: string;
  user_code: string;
  device_secret_hash: string;
  status: "pending" | "approved" | "consumed" | "expired" | "error";
  code_verifier: string | null;
  oauth_state_hash: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  expires_in: number | null;
  error_message: string | null;
  poll_interval_seconds: number;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  consumed_at: number | null;
};

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
    const result = this.db.first<T>(this.sql, this.values);
    await this.db.waitForConcurrentReads(this.sql);
    return result;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql, this.values) };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const changes = this.db.run(this.sql, this.values);
    return { success: true, meta: { changes } };
  }
}

class FakeD1Database {
  rows: StoredMachine[] = [];
  deviceRows: StoredDeviceAuthorization[] = [];
  approvalRateLimits = new Map<string, { window_started_at: number; attempts: number }>();
  private rateLimitReadBarrier: {
    remaining: number;
    promise: Promise<void>;
    release: () => void;
  } | null = null;
  private oauthStateReadBarrier: {
    remaining: number;
    promise: Promise<void>;
    release: () => void;
  } | null = null;

  synchronizeRateLimitReads(expectedReads: number): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rateLimitReadBarrier = { remaining: expectedReads, promise, release };
  }

  synchronizeOAuthStateReads(expectedReads: number): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.oauthStateReadBarrier = { remaining: expectedReads, promise, release };
  }

  async waitForConcurrentReads(sql: string): Promise<void> {
    const normalized = sql.toLowerCase();
    const barrier = normalized.includes("from device_approval_rate_limits")
      ? this.rateLimitReadBarrier
      : normalized.includes("from device_authorizations") && normalized.includes("where oauth_state_hash")
        ? this.oauthStateReadBarrier
        : null;
    if (!barrier) return;
    barrier.remaining -= 1;
    if (barrier.remaining === 0) barrier.release();
    await barrier.promise;
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    const normalized = sql.toLowerCase();
    if (normalized.includes("from machines")) {
      const [userId, machineKey] = values;
      return (this.rows.find((row) => row.user_id === userId && row.machine_key === machineKey) ?? null) as T | null;
    }
    if (normalized.includes("from device_authorizations")) {
      const [value] = values;
      const key = normalized.includes("where device_code")
        ? "device_code"
        : normalized.includes("where user_code")
          ? "user_code"
          : "oauth_state_hash";
      return (this.deviceRows.find((row) => row[key] === value) ?? null) as T | null;
    }
    if (normalized.includes("from device_approval_rate_limits")) {
      return (this.approvalRateLimits.get(String(values[0])) ?? null) as T | null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (!sql.toLowerCase().includes("from machines")) return [];
    const [userId] = values;
    return this.rows.filter((row) => row.user_id === userId) as T[];
  }

  run(sql: string, values: unknown[]): number {
    const normalized = sql.toLowerCase();
    if (normalized.includes("insert into machines")) {
      const row: StoredMachine = {
        user_id: String(values[0]),
        machine_key: String(values[1]),
        device_id: values[2] == null ? null : String(values[2]),
        name: values[3] == null ? null : String(values[3]),
        platform: values[4] == null ? null : String(values[4]),
        device_type: values[5] == null ? null : String(values[5]),
        pubkey: values[6] == null ? null : String(values[6]),
        reachable_endpoints: values[7] == null ? null : String(values[7]),
        last_seen_at: values[8] == null ? null : Number(values[8]),
        created_at: values[9] == null ? null : Number(values[9]),
      };
      const existing = this.rows.find((entry) =>
        entry.user_id === row.user_id && entry.machine_key === row.machine_key
      );
      if (existing) {
        Object.assign(existing, row, { created_at: existing.created_at });
      } else {
        this.rows.push(row);
      }
      return 1;
    }
    if (normalized.includes("delete from machines")) {
      const [userId, machineKey] = values;
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => row.user_id !== userId || row.machine_key !== machineKey);
      return before - this.rows.length;
    }
    if (normalized.includes("delete from device_authorizations")) {
      const cutoff = Number(values[0]);
      const before = this.deviceRows.length;
      this.deviceRows = this.deviceRows.filter((row) =>
        row.expires_at > cutoff || !["expired", "consumed", "error"].includes(row.status)
      );
      return before - this.deviceRows.length;
    }
    if (normalized.includes("delete from device_approval_rate_limits")) {
      const cutoff = Number(values[0]);
      let changes = 0;
      for (const [clientHash, record] of this.approvalRateLimits) {
        if (record.window_started_at > cutoff) continue;
        this.approvalRateLimits.delete(clientHash);
        changes += 1;
      }
      return changes;
    }
    if (normalized.includes("insert into device_authorizations")) {
      const userCode = String(values[1]);
      if (this.deviceRows.some((row) => row.user_code === userCode)) {
        throw new Error("UNIQUE constraint failed: device_authorizations.user_code");
      }
      this.deviceRows.push({
        device_code: String(values[0]),
        user_code: userCode,
        device_secret_hash: String(values[2]),
        status: "pending",
        code_verifier: null,
        oauth_state_hash: null,
        access_token: null,
        refresh_token: null,
        token_type: null,
        expires_in: null,
        error_message: null,
        poll_interval_seconds: Number(values[3]),
        last_polled_at: null,
        created_at: Number(values[4]),
        expires_at: Number(values[5]),
        approved_at: null,
        consumed_at: null,
      });
      return 1;
    }
    if (normalized.includes("insert into device_approval_rate_limits")) {
      const clientHash = String(values[0]);
      const now = Number(values[1]);
      const windowMs = Number(values[2]);
      const maxAttempts = Number(values[5]);
      const record = this.approvalRateLimits.get(clientHash);
      if (!record) {
        this.approvalRateLimits.set(clientHash, { window_started_at: now, attempts: 1 });
        return 1;
      }
      if (now - record.window_started_at >= windowMs) {
        record.window_started_at = now;
        record.attempts = 1;
        return 1;
      }
      if (record.attempts >= maxAttempts) return 0;
      record.attempts += 1;
      return 1;
    }
    if (normalized.includes("update device_authorizations")) {
      if (normalized.includes("where expires_at <= ?")) {
        const now = Number(values[0]);
        let changes = 0;
        for (const row of this.deviceRows) {
          if (row.expires_at > now || (row.status !== "pending" && row.status !== "approved")) continue;
          row.status = "expired";
          row.code_verifier = null;
          row.oauth_state_hash = null;
          row.access_token = null;
          row.refresh_token = null;
          changes += 1;
        }
        return changes;
      }
      if (normalized.includes("set code_verifier")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[2]
          && entry.status === "pending"
          && entry.expires_at > Number(values[3])
        );
        if (!row) return 0;
        row.code_verifier = String(values[0]);
        row.oauth_state_hash = String(values[1]);
        return 1;
      }
      if (normalized.includes("set oauth_state_hash = null")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[0]
          && entry.status === "pending"
          && entry.oauth_state_hash === values[1]
          && entry.code_verifier !== null
          && entry.expires_at > Number(values[2])
        );
        if (!row) return 0;
        row.oauth_state_hash = null;
        return 1;
      }
      if (normalized.includes("set status = 'approved'")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[5]
          && entry.status === "pending"
          && entry.expires_at > Number(values[6])
        );
        if (!row) return 0;
        row.status = "approved";
        row.access_token = String(values[0]);
        row.refresh_token = values[1] == null ? null : String(values[1]);
        row.token_type = String(values[2]);
        row.expires_in = Number(values[3]);
        row.approved_at = Number(values[4]);
        row.code_verifier = null;
        row.oauth_state_hash = null;
        return 1;
      }
      if (normalized.includes("set status = 'consumed'")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[1]
          && entry.device_secret_hash === values[2]
          && entry.status === "approved"
        );
        if (!row) return 0;
        row.status = "consumed";
        row.consumed_at = Number(values[0]);
        row.access_token = null;
        row.refresh_token = null;
        return 1;
      }
      if (normalized.includes("set status = 'error'")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[1] && entry.status === "pending");
        if (!row) return 0;
        row.status = "error";
        row.error_message = String(values[0]);
        return 1;
      }
      if (normalized.includes("set status = 'expired'")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[0]);
        const pendingOnly = /status\s*=\s*'pending'/.test(normalized);
        const pendingOrApproved = /status\s+in\s*\(\s*'pending'\s*,\s*'approved'\s*\)/.test(normalized);
        if (
          !row
          || (pendingOnly && row.status !== "pending")
          || (pendingOrApproved && row.status !== "pending" && row.status !== "approved")
        ) return 0;
        row.status = "expired";
        row.code_verifier = null;
        row.oauth_state_hash = null;
        row.access_token = null;
        row.refresh_token = null;
        return 1;
      }
      if (normalized.includes("set last_polled_at = ?, poll_interval_seconds = ?")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[2]);
        if (!row) return 0;
        row.last_polled_at = Number(values[0]);
        row.poll_interval_seconds = Number(values[1]);
        return 1;
      }
      if (normalized.includes("set last_polled_at = ?")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[1]);
        if (!row) return 0;
        row.last_polled_at = Number(values[0]);
        return 1;
      }
    }
    return 0;
  }
}

const ISSUER = "https://clerk.test";
const OAUTH_CLIENT_ID = "client_ade";
let jwksServer: Server;
let jwksUrl = "";
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let badSigningKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const bad = await generateKeyPair("RS256", { extractable: true });
  signingKey = primary.privateKey;
  badSigningKey = bad.privateKey;
  const publicJwk = await exportJWK(primary.publicKey);
  const jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }] };

  jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const address = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((error) => error ? reject(error) : resolve());
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(overrides: Partial<Env> = {}): Env & { DB: FakeD1Database } {
  return {
    DB: new FakeD1Database(),
    CLERK_JWKS_URL: jwksUrl,
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
    ...overrides,
  } as unknown as Env & { DB: FakeD1Database };
}

async function mintToken(args: {
  sub?: string | null;
  issuer?: string;
  audience?: string | string[];
  azp?: string;
  expired?: boolean;
  useBadKey?: boolean;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT(args.azp === undefined ? {} : { azp: args.azp })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(args.issuer ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(args.expired ? now - 60 : now + 600);
  if (args.sub !== null) token = token.setSubject(args.sub ?? "user_1");
  if (args.audience !== undefined) token = token.setAudience(args.audience);
  return token.sign(args.useBadKey ? badSigningKey : signingKey);
}

function registerBody(machineKey: string, endpoints: unknown = [{ kind: "lan", host: "mac.local", port: 8787 }]) {
  return {
    machineKey,
    deviceId: `device-${machineKey}`,
    name: `Machine ${machineKey}`,
    platform: "macOS",
    deviceType: "desktop",
    pubkey: `pubkey-${machineKey}`,
    reachableEndpoints: endpoints,
  };
}

function request(
  method: string,
  pathname: string,
  token?: string,
  body?: unknown,
): Request {
  return new Request(`https://directory.test${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function deviceConfirmationRequest(
  userCode: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://directory.test/device", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://directory.test",
      ...headers,
    },
    body: new URLSearchParams({ user_code: userCode }),
  });
}

async function register(
  env: Env,
  token: string,
  machineKey: string,
  endpoints?: unknown,
): Promise<Response> {
  return handleRequest(request("POST", "/account/machines/register", token, registerBody(machineKey, endpoints)), env);
}

describe("Clerk JWKS authentication", () => {
  it("extracts sub from a valid OAuth token whose aud is the Clerk client id", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_oauth", audience: OAUTH_CLIENT_ID, azp: OAUTH_CLIENT_ID });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_oauth");
  });

  it("accepts native session tokens with no aud even when azp is origin-based", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_native", azp: "https://desktop.ade.dev" });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_native");
  });

  it("accepts an OAuth token authorized to the Clerk client through azp", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_oauth", audience: "clerk-api", azp: OAUTH_CLIENT_ID });

    await expect(verifyCallerToken(token, env)).resolves.toBe("user_oauth");
  });

  it.each([
    ["wrong issuer", { issuer: "https://wrong-issuer.test" }, "invalid issuer"],
    ["expired", { expired: true }, "token expired"],
    ["bad signature", { useBadKey: true }, "invalid token"],
    ["missing sub", { sub: null }, "missing token subject"],
    ["unapproved audience", { audience: "different-client", azp: "different-client" }, "invalid audience"],
  ] as const)("returns a classified 401 for %s", async (_label, tokenArgs, expectedError) => {
    const env = makeEnv();
    const token = await mintToken(tokenArgs);

    const response = await handleRequest(request("GET", "/account/machines", token), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expectedError });
  });

  it("returns 401 when the bearer token is absent", async () => {
    const response = await handleRequest(request("GET", "/account/machines"), makeEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing bearer token" });
  });
});

describe("device authorization bridge", () => {
  it("creates, approves with Clerk OAuth + PKCE, and one-time redeems a secret-bound device code", async () => {
    const env = makeEnv();
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    const deviceSecret = "daemon-device-secret-with-at-least-32-bytes";
    const created = await handleRequest(
      request("POST", "/device/code", undefined, { device_secret: deviceSecret }),
      env,
      { now: () => now },
    );
    expect(created.status).toBe(200);
    const device = await created.json() as Record<string, unknown>;
    expect(device).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      verification_uri: "https://directory.test/device",
      verification_uri_complete: expect.stringContaining("https://directory.test/device?user_code="),
      expires_in: 600,
      interval: 5,
    });

    const pending = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now },
    );
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending", interval: 5 });

    const approval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    expect(approval.status).toBe(302);
    const clerkAuthorizeUrl = new URL(approval.headers.get("location")!);
    expect(clerkAuthorizeUrl.origin + clerkAuthorizeUrl.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(clerkAuthorizeUrl.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(clerkAuthorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(clerkAuthorizeUrl.searchParams.get("redirect_uri")).toBe("https://directory.test/device/callback");
    const state = clerkAuthorizeUrl.searchParams.get("state")!;
    const duplicateApproval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    expect(duplicateApproval.status).toBe(409);
    expect(await duplicateApproval.text()).toContain("Sign-in already started");
    const tokenExchange = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        code: "clerk-authorization-code",
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: "https://directory.test/device/callback",
      });
      expect(body.code_verifier).toEqual(expect.any(String));
      return new Response(JSON.stringify({
        access_token: "approved-access-token",
        refresh_token: "approved-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const callback = await handleRequest(
      new Request(`https://directory.test/device/callback?code=clerk-authorization-code&state=${encodeURIComponent(state)}`),
      env,
      { now: () => now, fetchImpl: tokenExchange as typeof fetch },
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Signed in to ADE");

    const wrongSecret = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: "wrong-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toEqual({ error: "invalid_grant" });

    now += 6_000;
    const redeemed = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now },
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({
      access_token: "approved-access-token",
      refresh_token: "approved-refresh-token",
      token_type: "Bearer",
      expires_in: 3594,
      oauth_issuer: ISSUER,
      oauth_client_id: OAUTH_CLIENT_ID,
    });
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "consumed",
      access_token: null,
      refresh_token: null,
    });

    const replay = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now + 6_000 },
    );
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });

    const expiredReplay = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => now + 595_000 },
    );
    expect(expiredReplay.status).toBe(400);
    expect(await expiredReplay.json()).toEqual({ error: "expired" });
    expect(env.DB.deviceRows[0]?.status).toBe("consumed");
  });

  it("claims concurrent duplicate callbacks before the one-time OAuth exchange", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    const approval = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    const state = new URL(approval.headers.get("location")!).searchParams.get("state")!;
    const callbackUrl = `https://directory.test/device/callback?code=one-time-code&state=${encodeURIComponent(state)}`;
    env.DB.synchronizeOAuthStateReads(2);

    let resolveSuccessfulExchange: ((response: Response) => void) | null = null;
    const successfulExchange = new Promise<Response>((resolve) => {
      resolveSuccessfulExchange = resolve;
    });
    let exchangeCalls = 0;
    const fetchImpl = vi.fn((): Promise<Response> => {
      exchangeCalls += 1;
      return exchangeCalls === 1
        ? successfulExchange
        : Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }));
    });

    const callbacks = Promise.all([
      handleRequest(new Request(callbackUrl), env, { now: () => now, fetchImpl: fetchImpl as typeof fetch }),
      handleRequest(new Request(callbackUrl), env, { now: () => now, fetchImpl: fetchImpl as typeof fetch }),
    ]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    resolveSuccessfulExchange!(new Response(JSON.stringify({
      access_token: "winner-access-token",
      refresh_token: "winner-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const responses = await callbacks;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "approved",
      access_token: "winner-access-token",
      refresh_token: "winner-refresh-token",
      error_message: null,
      code_verifier: null,
      oauth_state_hash: null,
    });
  });

  it("keeps verification-link GET previews read-only until explicit confirmation", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const created = await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => now },
    );
    const device = await created.json() as Record<string, unknown>;
    const rowBeforePreview = { ...env.DB.deviceRows[0]! };
    const limitsBeforePreview = Array.from(
      env.DB.approvalRateLimits,
      ([key, value]) => [key, { ...value }] as const,
    );

    const firstPreview = await handleRequest(
      new Request(String(device.verification_uri_complete)),
      env,
      { now: () => now },
    );
    const repeatedPreview = await handleRequest(
      new Request(String(device.verification_uri_complete)),
      env,
      { now: () => now },
    );

    expect([firstPreview.status, repeatedPreview.status]).toEqual([200, 200]);
    expect(await firstPreview.text()).toContain('form method="post" action="/device"');
    expect(env.DB.deviceRows[0]).toEqual(rowBeforePreview);
    expect(Array.from(env.DB.approvalRateLimits)).toEqual(limitsBeforePreview);

    const crossSiteSubmit = await handleRequest(
      deviceConfirmationRequest(String(device.user_code), { origin: "https://preview.test" }),
      env,
      { now: () => now },
    );
    expect(crossSiteSubmit.status).toBe(403);
    expect(env.DB.deviceRows[0]).toEqual(rowBeforePreview);
    expect(Array.from(env.DB.approvalRateLimits)).toEqual(limitsBeforePreview);

    const confirmed = await handleRequest(
      deviceConfirmationRequest(String(device.user_code)),
      env,
      { now: () => now },
    );
    expect(confirmed.status).toBe(302);
    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "pending",
      code_verifier: expect.any(String),
      oauth_state_hash: expect.any(String),
    });
    expect(env.DB.approvalRateLimits.size).toBe(2);
  });

  it("returns expired for a device code after its short TTL", async () => {
    const env = makeEnv();
    const startedAt = Date.parse("2026-07-14T12:00:00.000Z");
    const deviceSecret = "daemon-device-secret-with-at-least-32-bytes";
    const created = await handleRequest(
      request("POST", "/device/code", undefined, { device_secret: deviceSecret }),
      env,
      { now: () => startedAt },
    );
    const device = await created.json() as Record<string, unknown>;

    const expired = await handleRequest(
      request("POST", "/device/token", undefined, {
        device_code: device.device_code,
        device_secret: deviceSecret,
      }),
      env,
      { now: () => startedAt + 601_000 },
    );
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "expired" });
    expect(env.DB.deviceRows[0]?.status).toBe("expired");
  });

  it("clears expired approved credentials from the scheduled worker without client polling", async () => {
    const env = makeEnv();
    const startedAt = Date.parse("2026-07-14T12:00:00.000Z");
    await handleRequest(
      request("POST", "/device/code", undefined, {
        device_secret: "daemon-device-secret-with-at-least-32-bytes",
      }),
      env,
      { now: () => startedAt },
    );
    Object.assign(env.DB.deviceRows[0]!, {
      status: "approved",
      code_verifier: "temporary-pkce-verifier",
      oauth_state_hash: "temporary-state-hash",
      access_token: "abandoned-access-token",
      refresh_token: "abandoned-refresh-token",
    });
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 601_000);
    let cleanup: Promise<unknown> | undefined;

    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;

    expect(env.DB.deviceRows[0]).toMatchObject({
      status: "expired",
      code_verifier: null,
      oauth_state_hash: null,
      access_token: null,
      refresh_token: null,
    });
    expect(env.DB.approvalRateLimits.size).toBe(0);

    vi.mocked(Date.now).mockReturnValue(startedAt + 4_201_000);
    cleanup = undefined;
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: (promise) => { cleanup = promise; } } as ExecutionContext,
    );
    await cleanup;
    expect(env.DB.deviceRows).toHaveLength(0);
  });

  it("rate-limits device-code issuance separately from approval lookups", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const headers = {
      "cf-connecting-ip": "203.0.113.8",
      "content-type": "application/json",
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleRequest(
        new Request("https://directory.test/device/code", {
          method: "POST",
          headers,
          body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
        }),
        env,
        { now: () => now },
      );
      expect(response.status).toBe(200);
    }

    const blocked = await handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers,
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(env.DB.deviceRows).toHaveLength(10);

    const approval = await handleRequest(
      deviceConfirmationRequest("ZZZZ-ZZZZ", { "cf-connecting-ip": "203.0.113.8" }),
      env,
      { now: () => now },
    );
    expect(approval.status).toBe(404);
    expect(env.DB.approvalRateLimits.size).toBe(2);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts).sort()).toEqual([1, 10]);
  });

  it("atomically admits at most ten concurrent device-code issuances per client", async () => {
    const env = makeEnv();
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    env.DB.synchronizeRateLimitReads(25);
    const responses = await Promise.all(Array.from({ length: 25 }, () => handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    )));

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200, 429]));
    expect(env.DB.deviceRows).toHaveLength(10);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts)).toEqual([10]);

    now += 60_000;
    const nextWindow = await handleRequest(
      new Request("https://directory.test/device/code", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          "content-type": "application/json",
        },
        body: JSON.stringify({ device_secret: "daemon-device-secret-with-at-least-32-bytes" }),
      }),
      env,
      { now: () => now },
    );
    expect(nextWindow.status).toBe(200);
    expect(env.DB.deviceRows).toHaveLength(11);
    expect(Array.from(env.DB.approvalRateLimits.values(), (entry) => entry.attempts)).toEqual([1]);
  });

  it("rate-limits user-code confirmations on the hosted approval page", async () => {
    const env = makeEnv();
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleRequest(
        deviceConfirmationRequest("ABCD-EFGH", { "cf-connecting-ip": "203.0.113.7" }),
        env,
        { now: () => now },
      );
      expect(response.status).toBe(404);
    }
    const blocked = await handleRequest(
      deviceConfirmationRequest("ABCD-EFGH", { "cf-connecting-ip": "203.0.113.7" }),
      env,
      { now: () => now },
    );
    expect(blocked.status).toBe(429);
  });
});

describe("machine directory", () => {
  it("serves an unauthenticated health check", async () => {
    const response = await handleRequest(request("GET", "/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("allows only the configured hosted origin to preflight and read the directory", async () => {
    const env = makeEnv({ WEB_CLIENT_ORIGIN: "https://app.ade.dev" });
    const token = await mintToken();
    const preflight = await handleRequest(new Request("https://directory.test/account/machines", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.ade.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.ade.dev");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization");

    const allowed = await handleRequest(new Request("https://directory.test/account/machines", {
      headers: { origin: "https://app.ade.dev", authorization: `Bearer ${token}` },
    }), env);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.ade.dev");

    const hostilePreflight = await handleRequest(new Request("https://directory.test/account/machines", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }), env);
    expect(hostilePreflight.status).toBe(403);
    const hostileRead = await handleRequest(new Request("https://directory.test/account/machines", {
      headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
    }), env);
    expect(hostileRead.status).toBe(403);
    expect(hostileRead.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("upserts registration heartbeats and isolates rows by Clerk sub", async () => {
    const env = makeEnv();
    const firstToken = await mintToken({ sub: "user_1" });
    const secondToken = await mintToken({ sub: "user_2" });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(now - 5_000);

    const first = await register(env, firstToken, "machine-a", [{ kind: "lan", host: "old.local", port: 8787 }]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      lastSeenAt: now - 5_000,
      createdAt: now - 5_000,
      reachableEndpoints: [{ kind: "lan", host: "old.local", port: 8787 }],
    }));

    dateNow.mockReturnValue(now);
    const second = await register(env, firstToken, "machine-a", [{ kind: "relay", url: "wss://relay.test/machine-a" }]);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expect.objectContaining({
      machineKey: "machine-a",
      lastSeenAt: now,
      createdAt: now - 5_000,
      reachableEndpoints: [{ kind: "relay", url: "wss://relay.test/machine-a" }],
    }));
    expect(env.DB.rows).toHaveLength(1);

    const otherUserList = await handleRequest(request("GET", "/account/machines", secondToken), env);
    expect(await otherUserList.json()).toEqual({ machines: [] });
  });

  it("returns online and offline machines, online first and newest first", async () => {
    const env = makeEnv();
    const token = await mintToken({ sub: "user_1" });
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");

    dateNow.mockReturnValue(now - 120_000);
    await register(env, token, "offline");
    dateNow.mockReturnValue(now - 70_000);
    await register(env, token, "online-old");
    dateNow.mockReturnValue(now - 10_000);
    await register(env, token, "online-new");
    dateNow.mockReturnValue(now);

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.machines.map((machine) => machine.machineKey)).toEqual(["online-new", "online-old", "offline"]);
    expect(body.machines.map((machine) => machine.online)).toEqual([true, true, false]);
    expect(body.machines[2]).toEqual(expect.objectContaining({
      lastSeenAt: now - 120_000,
      reachableEndpoints: [{ kind: "lan", host: "mac.local", port: 8787 }],
    }));
  });

  it("honors an environment override for the online window", async () => {
    const env = makeEnv({ ONLINE_WINDOW_MS: "5000" });
    const token = await mintToken();
    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(now - 10_000);
    await register(env, token, "machine-a");
    dateNow.mockReturnValue(now);

    const response = await handleRequest(request("GET", "/account/machines", token), env);
    const body = await response.json() as { machines: Array<{ online: boolean }> };
    expect(body.machines[0]?.online).toBe(false);
  });

  it("deletes only the caller's row for a shared machine key", async () => {
    const env = makeEnv();
    const firstToken = await mintToken({ sub: "user_1" });
    const secondToken = await mintToken({ sub: "user_2" });
    await register(env, firstToken, "shared-machine");
    await register(env, secondToken, "shared-machine");

    const deleted = await handleRequest(
      request("DELETE", "/account/machines/shared-machine", firstToken),
      env,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, machineKey: "shared-machine" });

    const firstList = await handleRequest(request("GET", "/account/machines", firstToken), env);
    const secondList = await handleRequest(request("GET", "/account/machines", secondToken), env);
    expect(await firstList.json()).toEqual({ machines: [] });
    expect(await secondList.json()).toEqual({
      machines: [expect.objectContaining({ machineKey: "shared-machine" })],
    });

    const removed = await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
      .bind("user_2", "shared-machine")
      .run();
    const missing = await env.DB.prepare("delete from machines where user_id = ? and machine_key = ?")
      .bind("user_2", "shared-machine")
      .run();
    expect(removed.meta.changes).toBe(1);
    expect(missing.meta.changes).toBe(0);
    expect(env.DB.rows).toHaveLength(0);
  });
});
