import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleRequest, verifyCallerToken, type Env } from "../src/directory";

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
  rows: StoredMachine[] = [];

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    const normalized = sql.toLowerCase();
    if (!normalized.includes("from machines")) return null;
    const [userId, machineKey] = values;
    return (this.rows.find((row) => row.user_id === userId && row.machine_key === machineKey) ?? null) as T | null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (!sql.toLowerCase().includes("from machines")) return [];
    const [userId] = values;
    return this.rows.filter((row) => row.user_id === userId) as T[];
  }

  run(sql: string, values: unknown[]): void {
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
      return;
    }
    if (normalized.includes("delete from machines")) {
      const [userId, machineKey] = values;
      this.rows = this.rows.filter((row) => row.user_id !== userId || row.machine_key !== machineKey);
    }
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
    ["wrong issuer", { issuer: "https://wrong-issuer.test" }],
    ["expired", { expired: true }],
    ["bad signature", { useBadKey: true }],
    ["missing sub", { sub: null }],
    ["unapproved audience", { audience: "different-client", azp: "different-client" }],
  ] as const)("returns 401 for %s", async (_label, tokenArgs) => {
    const env = makeEnv();
    const token = await mintToken(tokenArgs);

    const response = await handleRequest(request("GET", "/account/machines", token), env);

    expect(response.status).toBe(401);
  });

  it("returns 401 when the bearer token is absent", async () => {
    const response = await handleRequest(request("GET", "/account/machines"), makeEnv());
    expect(response.status).toBe(401);
  });
});

describe("machine directory", () => {
  it("serves an unauthenticated health check", async () => {
    const response = await handleRequest(request("GET", "/health"), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
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
  });
});
