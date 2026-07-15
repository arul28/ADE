import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleRequest, verifyAccountToken, type RelayEnv } from "../src/relay";

type RepositoryRow = {
  repository_key: string;
  repository_full_name: string;
  owner: string;
  name: string;
  installation_id: number | null;
  repository_selection: string | null;
  installed: number;
  last_seen_at: string;
  removed_at: string | null;
  account_id: string | null;
};

type GitHubEventRow = {
  event_seq: number;
  event_id: string;
  github_event: string;
  github_delivery: string | null;
  repository_full_name: string;
  summary: string;
  payload_json: string;
  received_at: string;
  account_id: string | null;
};

type LinearOrganizationRow = {
  org_id: string;
  webhook_secret: string;
  registered_at: string;
  updated_at: string;
  account_id: string | null;
};

type LinearEventRow = {
  event_seq: number;
  org_id: string;
  event_id: string;
  event_type: string;
  action: string;
  received_at: string;
  body: string;
  account_id: string | null;
};

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeAccountD1,
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

class FakeAccountD1 {
  repositories: RepositoryRow[] = [];
  githubEvents: GitHubEventRow[] = [];
  linearOrganizations: LinearOrganizationRow[] = [];
  linearEvents: LinearEventRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this);
  }

  first<T>(sql: string, values: unknown[]): T | null {
    if (sql.includes("json_extract(payload_json, '$.hook.events')") || sql.includes("where github_event = 'meta'")) {
      return null;
    }
    if (sql.includes("from github_app_repositories")) {
      const repositoryKey = String(values[0]);
      const row = this.repositories.find((entry) => entry.repository_key === repositoryKey);
      if (!row) return null;
      return (sql.includes("select account_id") ? { account_id: row.account_id } : row) as T;
    }
    if (sql.includes("select webhook_secret from linear_organizations")) {
      const row = this.linearOrganizations.find((entry) => entry.org_id === values[0]);
      return row ? ({ webhook_secret: row.webhook_secret } as T) : null;
    }
    if (sql.includes("select account_id from linear_organizations")) {
      const row = this.linearOrganizations.find((entry) => entry.org_id === values[0]);
      return row ? ({ account_id: row.account_id } as T) : null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    if (sql.includes("from github_app_repositories")) {
      const accountId = String(values[0]);
      return this.repositories
        .filter((row) => row.account_id === accountId)
        .sort((left, right) => left.repository_full_name.localeCompare(right.repository_full_name)) as T[];
    }
    if (sql.includes("from github_events")) {
      const repositoryFullName = String(values[0]).toLowerCase();
      const limit = Number(values.at(-1));
      return this.githubEvents
        .filter((row) => row.repository_full_name.toLowerCase() === repositoryFullName)
        .sort((left, right) => right.event_seq - left.event_seq)
        .slice(0, limit) as T[];
    }
    if (sql.includes("from linear_organizations")) {
      const accountId = String(values[0]);
      return this.linearOrganizations.filter((row) => row.account_id === accountId) as T[];
    }
    if (sql.includes("from linear_events")) {
      const organizationId = String(values[0]);
      const limit = Number(values.at(-1));
      return this.linearEvents
        .filter((row) => row.org_id === organizationId)
        .sort((left, right) => right.event_seq - left.event_seq)
        .slice(0, limit) as T[];
    }
    return [];
  }

  run(sql: string, values: unknown[]): void {
    if (sql.includes("insert into linear_organizations")) {
      const [organizationId, secret, registeredAt, updatedAt, accountId] = values;
      const existing = this.linearOrganizations.find((row) => row.org_id === organizationId);
      if (existing) {
        existing.webhook_secret = String(secret);
        existing.updated_at = String(updatedAt);
        if (accountId != null) existing.account_id = String(accountId);
      } else {
        this.linearOrganizations.push({
          org_id: String(organizationId),
          webhook_secret: String(secret),
          registered_at: String(registeredAt),
          updated_at: String(updatedAt),
          account_id: accountId == null ? null : String(accountId),
        });
      }
      return;
    }
    if (sql.includes("update github_app_repositories set account_id = ?")) {
      const [accountId, repositoryKey] = values;
      const row = this.repositories.find((entry) => entry.repository_key === repositoryKey);
      if (row) row.account_id = String(accountId);
      return;
    }
    if (sql.includes("update github_events set account_id = ?")) {
      const [accountId, repositoryFullName] = values;
      for (const row of this.githubEvents) {
        if (row.repository_full_name.toLowerCase() === String(repositoryFullName).toLowerCase()) {
          row.account_id = String(accountId);
        }
      }
      return;
    }
    if (sql.includes("update linear_events set account_id = ?")) {
      const [accountId, organizationId] = values;
      for (const row of this.linearEvents) {
        if (row.org_id === organizationId) row.account_id = String(accountId);
      }
      return;
    }
    if (sql.includes("set account_id = null where account_id = ?")) {
      const accountId = String(values[0]);
      const rows = sql.includes("github_app_repositories")
        ? this.repositories
        : sql.includes("github_events")
          ? this.githubEvents
          : sql.includes("linear_organizations")
            ? this.linearOrganizations
            : this.linearEvents;
      for (const row of rows) {
        if (row.account_id === accountId) row.account_id = null;
      }
    }
  }
}

const ISSUER = "https://clerk.test";
const OAUTH_CLIENT_ID = "client_ade";
let jwksServer: Server;
let jwksUrl = "";
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  signingKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  const jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "account-test", use: "sig" }] };
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
  vi.unstubAllGlobals();
});

async function mintToken(sub: string, audience = OAUTH_CLIENT_ID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ azp: audience })
    .setProtectedHeader({ alg: "RS256", kid: "account-test" })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(signingKey);
}

function makeEnv(): RelayEnv & { DB: FakeAccountD1 } {
  return {
    DB: new FakeAccountD1(),
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITHUB_API_BASE_URL: "https://github.test",
    LINEAR_API_BASE_URL: "https://linear.test/graphql",
    CLERK_JWKS_URL: jwksUrl,
    CLERK_ISSUER: ISSUER,
    CLERK_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
  } as unknown as RelayEnv & { DB: FakeAccountD1 };
}

function seedRepository(db: FakeAccountD1, accountId: string | null): void {
  db.repositories.push({
    repository_key: "acme/repo",
    repository_full_name: "acme/repo",
    owner: "acme",
    name: "repo",
    installation_id: 42,
    repository_selection: "selected",
    installed: 1,
    last_seen_at: "2026-07-15T00:00:00.000Z",
    removed_at: null,
    account_id: accountId,
  });
  db.githubEvents.push({
    event_seq: 1,
    event_id: "github-delivery-1",
    github_event: "pull_request",
    github_delivery: "github-delivery-1",
    repository_full_name: "acme/repo",
    summary: "GitHub pull_request · opened · acme/repo",
    payload_json: JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" } }),
    received_at: "2026-07-15T00:00:00.000Z",
    account_id: accountId,
  });
}

function seedLinear(db: FakeAccountD1, accountId: string | null): void {
  db.linearOrganizations.push({
    org_id: "org-1",
    webhook_secret: "linear-secret",
    registered_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    account_id: accountId,
  });
  db.linearEvents.push({
    event_seq: 1,
    org_id: "org-1",
    event_id: "linear-delivery-1",
    event_type: "Issue",
    action: "update",
    received_at: "2026-07-15T00:00:00.000Z",
    body: JSON.stringify({ organizationId: "org-1", type: "Issue", action: "update" }),
    account_id: accountId,
  });
}

function stubLegacyApis(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://github.test/")) {
      return new Response(JSON.stringify({
        id: 101,
        permissions: { admin: false, push: true, pull: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://linear.test/graphql") {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization !== "lin_admin") {
        return new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      const payload = query.includes("webhooks(")
        ? { data: { webhooks: { nodes: [] } } }
        : { data: { viewer: { organization: { id: "org-1" } } } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

function request(pathname: string, args: {
  method?: string;
  authorization?: string;
  accountToken?: string;
  body?: unknown;
} = {}): Request {
  return new Request(`https://relay.test${pathname}`, {
    method: args.method ?? "GET",
    headers: {
      ...(args.authorization ? { authorization: args.authorization } : {}),
      ...(args.accountToken ? { "x-ade-account-token": args.accountToken } : {}),
      ...(args.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
  });
}

describe("account integration re-keying", () => {
  it("reuses the directory Worker Clerk JWKS issuer, subject, and audience checks", async () => {
    const env = makeEnv();
    await expect(verifyAccountToken(await mintToken("user_1"), env)).resolves.toBe("user_1");
    await expect(verifyAccountToken(await mintToken("user_1", "wrong-client"), env)).rejects.toThrow(
      "Token audience is not allowed",
    );
  });

  it("keeps NULL account mappings on the byte-identical legacy register, status, and poll paths", async () => {
    const env = makeEnv();
    seedRepository(env.DB, null);
    stubLegacyApis();

    const status = await handleRequest(request("/github/repos/acme/repo/status", {
      authorization: "Bearer ghp_repo_token",
    }), env);
    const githubEvents = await handleRequest(request("/github/repos/acme/repo/events", {
      authorization: "Bearer ghp_repo_token",
    }), env);
    const linearRegister = await handleRequest(request("/linear/orgs/register", {
      method: "POST",
      authorization: "lin_admin",
      body: { secret: "linear-secret" },
    }), env);
    const linearEvents = await handleRequest(request("/linear/orgs/org-1/events", {
      authorization: "lin_admin",
    }), env);

    expect(status.status).toBe(200);
    expect(await githubEvents.json()).toEqual({
      events: [expect.objectContaining({ eventId: "github-delivery-1" })],
      nextCursor: "seq:1",
      cursorExpired: false,
    });
    expect(await linearRegister.json()).toEqual({ organizationId: "org-1" });
    expect(await linearEvents.json()).toEqual({ events: [], nextCursor: null, cursorExpired: false });
    expect(env.DB.repositories[0]?.account_id).toBeNull();
    expect(env.DB.linearOrganizations[0]?.account_id).toBeNull();
  });

  it("stamps account mappings, isolates account lists, supports both auth keys, and revokes only account access", async () => {
    const env = makeEnv();
    seedRepository(env.DB, null);
    env.DB.linearEvents.push({
      event_seq: 1,
      org_id: "org-1",
      event_id: "linear-delivery-1",
      event_type: "Issue",
      action: "update",
      received_at: "2026-07-15T00:00:00.000Z",
      body: JSON.stringify({ organizationId: "org-1", type: "Issue", action: "update" }),
      account_id: null,
    });
    stubLegacyApis();
    const accountToken = await mintToken("user_1");
    const otherAccountToken = await mintToken("user_2");

    const status = await handleRequest(request("/github/repos/acme/repo/status", {
      authorization: "Bearer ghp_repo_token",
      accountToken,
    }), env);
    const registration = await handleRequest(request("/linear/orgs/register", {
      method: "POST",
      authorization: "lin_admin",
      accountToken,
      body: { secret: "linear-secret" },
    }), env);
    expect(status.status).toBe(200);
    expect(registration.status).toBe(200);
    expect(env.DB.repositories[0]?.account_id).toBe("user_1");
    expect(env.DB.githubEvents[0]?.account_id).toBe("user_1");
    expect(env.DB.linearOrganizations[0]?.account_id).toBe("user_1");
    expect(env.DB.linearEvents[0]?.account_id).toBe("user_1");

    const accountStatus = await handleRequest(request("/github/repos/acme/repo/status", { accountToken }), env);
    const accountGitHub = await handleRequest(request("/github/repos/acme/repo/events", { accountToken }), env);
    const legacyGitHub = await handleRequest(request("/github/repos/acme/repo/events", {
      authorization: "Bearer ghp_repo_token",
    }), env);
    const accountLinear = await handleRequest(request("/linear/orgs/org-1/events", { accountToken }), env);
    const legacyLinear = await handleRequest(request("/linear/orgs/org-1/events", {
      authorization: "lin_admin",
    }), env);
    expect(accountStatus.status).toBe(200);
    expect(accountGitHub.status).toBe(200);
    expect(legacyGitHub.status).toBe(200);
    expect(accountLinear.status).toBe(200);
    expect(legacyLinear.status).toBe(200);

    const otherGitHub = await handleRequest(request("/github/repos/acme/repo/events", {
      accountToken: otherAccountToken,
    }), env);
    const otherLinear = await handleRequest(request("/linear/orgs/org-1/events", {
      accountToken: otherAccountToken,
    }), env);
    expect(otherGitHub.status).toBe(401);
    expect(otherLinear.status).toBe(401);

    const integrations = await handleRequest(request("/account/integrations", {
      authorization: `Bearer ${accountToken}`,
    }), env);
    const otherIntegrations = await handleRequest(request("/account/integrations", {
      authorization: `Bearer ${otherAccountToken}`,
    }), env);
    expect(await integrations.json()).toEqual({
      repositories: [{
        owner: "acme",
        name: "repo",
        fullName: "acme/repo",
        installationId: 42,
        repositorySelection: "selected",
        installed: true,
      }],
      linearOrganizations: [{ organizationId: "org-1" }],
    });
    expect(await otherIntegrations.json()).toEqual({ repositories: [], linearOrganizations: [] });

    const revoked = await handleRequest(request("/account/integrations", {
      method: "DELETE",
      authorization: `Bearer ${accountToken}`,
    }), env);
    expect(await revoked.json()).toEqual({ ok: true });
    expect(env.DB.repositories[0]?.account_id).toBeNull();
    expect(env.DB.githubEvents[0]?.account_id).toBeNull();
    expect(env.DB.linearOrganizations[0]?.account_id).toBeNull();
    expect(env.DB.linearEvents[0]?.account_id).toBeNull();

    const revokedGitHub = await handleRequest(request("/github/repos/acme/repo/events", { accountToken }), env);
    const revokedLinear = await handleRequest(request("/linear/orgs/org-1/events", { accountToken }), env);
    expect(revokedGitHub.status).toBe(401);
    expect(revokedLinear.status).toBe(401);
    expect((await handleRequest(request("/github/repos/acme/repo/events", {
      authorization: "Bearer ghp_repo_token",
    }), env)).status).toBe(200);
    expect((await handleRequest(request("/linear/orgs/org-1/events", {
      authorization: "lin_admin",
    }), env)).status).toBe(200);
  });
});
