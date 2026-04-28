import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearClient } from "./linearClient";
import { createLinearCredentialService } from "./linearCredentialService";
import { createLinearOAuthService } from "./linearOAuthService";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, "utf8")),
  decryptString: vi.fn((value: Buffer) => {
    const raw = value.toString("utf8");
    return raw.startsWith("enc:") ? raw.slice(4) : raw;
  }),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
}));

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: vi.fn(),
    error: () => {},
  } as any;
}

// =====================================================================
// linearCredentialService
// =====================================================================

describe("linearCredentialService", () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReset();
    safeStorageMock.encryptString.mockReset();
    safeStorageMock.decryptString.mockReset();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(`enc:${value}`, "utf8"));
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => {
      const raw = value.toString("utf8");
      return raw.startsWith("enc:") ? raw.slice(4) : raw;
    });
  });

  it("stores token encrypted and reads it back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-cred-"));
    const adeDir = path.join(root, ".ade");
    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    service.setToken("lin_api_123");
    expect(service.getToken()).toBe("lin_api_123");
    expect(service.getStatus().tokenStored).toBe(true);

    const tokenPath = path.join(adeDir, "secrets", "linear-token.v1.bin");
    expect(fs.existsSync(tokenPath)).toBe(true);
    const onDisk = fs.readFileSync(tokenPath);
    expect(onDisk.toString("utf8")).toMatch(/^enc:/);
  });

  it("reads ADE_LINEAR_API from env as a manual token", () => {
    const previousAdeLinearApi = process.env.ADE_LINEAR_API;
    const previousLinearApiKey = process.env.LINEAR_API_KEY;
    const previousAdeLinearToken = process.env.ADE_LINEAR_TOKEN;
    const previousLinearToken = process.env.LINEAR_TOKEN;
    try {
      process.env.ADE_LINEAR_API = "lin_env_123";
      delete process.env.LINEAR_API_KEY;
      delete process.env.ADE_LINEAR_TOKEN;
      delete process.env.LINEAR_TOKEN;

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-env-"));
      const adeDir = path.join(root, ".ade");
      const service = createLinearCredentialService({
        adeDir,
        logger: createLogger(),
      });

      expect(service.getToken()).toBe("lin_env_123");
      expect(service.getStatus().authMode).toBe("manual");
    } finally {
      if (previousAdeLinearApi === undefined) delete process.env.ADE_LINEAR_API;
      else process.env.ADE_LINEAR_API = previousAdeLinearApi;
      if (previousLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousLinearApiKey;
      if (previousAdeLinearToken === undefined) delete process.env.ADE_LINEAR_TOKEN;
      else process.env.ADE_LINEAR_TOKEN = previousAdeLinearToken;
      if (previousLinearToken === undefined) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = previousLinearToken;
    }
  });

  it("imports token once from legacy local.secret.yaml when encrypted store is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-legacy-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    fs.writeFileSync(
      path.join(adeDir, "local.secret.yaml"),
      "linear:\n  token: lin_legacy_abc\n",
      "utf8"
    );

    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    expect(service.getToken()).toBe("lin_legacy_abc");

    const sentinelPath = path.join(adeDir, "secrets", "linear-token.imported.v1");
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf8")).toContain("imported");
  });

  it("reads Linear OAuth client credentials from .ade/secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-oauth-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(path.join(adeDir, "secrets"), { recursive: true });
    fs.writeFileSync(
      path.join(adeDir, "secrets", "linear-oauth.v1.json"),
      JSON.stringify({ clientId: "client-123", clientSecret: "secret-456" }),
      "utf8"
    );

    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    expect(service.getOAuthClientCredentials()).toEqual({
      clientId: "client-123",
      clientSecret: "secret-456",
    });
    expect(service.getStatus().oauthConfigured).toBe(true);
  });

  it("stores Linear OAuth client credentials without requiring a secret", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-oauth-store-"));
    const adeDir = path.join(root, ".ade");
    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    service.setOAuthClientCredentials({ clientId: "client-public" });

    expect(service.getOAuthClientCredentials()).toEqual({
      clientId: "client-public",
      clientSecret: null,
    });
    expect(service.getStatus().oauthConfigured).toBe(true);

    const clientPath = path.join(adeDir, "secrets", "linear-oauth-client.v1.bin");
    expect(fs.existsSync(clientPath)).toBe(true);
    expect(fs.readFileSync(clientPath).toString("utf8")).toMatch(/^enc:/);
  });
});

// =====================================================================
// linearOAuthService
// =====================================================================

function createCredentialsMock(overrides?: {
  clientSecret?: string | null;
}) {
  return {
    getOAuthClientCredentials: vi.fn(() => ({
      clientId: "test-client-id",
      clientSecret: overrides?.clientSecret ?? "test-client-secret",
    })),
    setOAuthToken: vi.fn(),
  };
}

/**
 * HTTP GET that tolerates early server close.
 *
 * The OAuth service calls `server.close()` immediately after writing
 * its response in error paths. Node's http client may see a socket
 * hang-up before the response is fully consumed. We capture whatever
 * status code was received; if none, resolve with statusCode 0 so
 * tests can still assert on session state via `getSession`.
 */
function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let resolved = false;
    let statusCode = 0;
    let body = "";

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
      },
      (res) => {
        statusCode = res.statusCode ?? 0;
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (!resolved) { resolved = true; resolve({ statusCode, body }); }
        });
        res.on("error", () => {
          if (!resolved) { resolved = true; resolve({ statusCode, body }); }
        });
      }
    );
    req.on("error", () => {
      if (!resolved) { resolved = true; resolve({ statusCode, body }); }
    });
    req.setTimeout(5000, () => {
      req.destroy();
      if (!resolved) { resolved = true; resolve({ statusCode: 0, body: "" }); }
    });
    req.end();
  });
}

const activeServices: Array<ReturnType<typeof createLinearOAuthService>> = [];

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionStatus(
  service: ReturnType<typeof createLinearOAuthService>,
  sessionId: string,
  expectedStatus: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = service.getSession(sessionId);
    if (session.status === expectedStatus) return;
    await waitMs(10);
  }
  const session = service.getSession(sessionId);
  expect(session.status, `Timed out waiting for session ${sessionId} to reach status '${expectedStatus}'`).toBe(expectedStatus);
}

afterEach(async () => {
  for (const svc of activeServices) {
    svc.dispose();
  }
  activeServices.length = 0;
  await waitMs(50);
});

describe("linearOAuthService", () => {
  it("throws when OAuth client credentials are not configured", async () => {
    const service = createLinearOAuthService({
      credentials: {
        getOAuthClientCredentials: vi.fn(() => null),
        setOAuthToken: vi.fn(),
      } as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    await expect(service.startSession()).rejects.toThrow("not configured");
  });

  it("starts a session and returns a valid authUrl with required OAuth params", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const result = await service.startSession();

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId.startsWith("linear-oauth-")).toBe(true);
    expect(result.authUrl).toContain("linear.app/oauth/authorize");
    expect(result.authUrl).toContain("client_id=test-client-id");
    expect(result.authUrl).toContain("response_type=code");
    expect(result.authUrl).toContain("scope=read");
    expect(result.authUrl).toContain("prompt=consent");
    expect(result.redirectUri).toContain("/oauth/callback");

    const session = service.getSession(result.sessionId);
    expect(session.status).toBe("pending");
    expect(session.error).toBeNull();
  });

  it("getSession returns expired for unknown session id", () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const session = service.getSession("nonexistent-session");
    expect(session.status).toBe("expired");
    expect(session.error).toContain("not found");
  });

  it("exchanges authorization code for access token via the callback", async () => {
    const credentials = createCredentialsMock();
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "linear-access-token-123",
        refresh_token: "linear-refresh-token-456",
        expires_in: 3600,
      }),
    })) as any;

    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
      fetchImpl: mockFetch,
    });
    activeServices.push(service);

    const { sessionId, authUrl, redirectUri } = await service.startSession();

    const stateParam = new URL(authUrl).searchParams.get("state")!;
    expect(stateParam).toBeTruthy();

    const callbackUrl = `${redirectUri}?code=test-code-123&state=${stateParam}`;
    const response = await httpGet(callbackUrl);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Linear connected");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0]![1] as { body: string };
    expect(fetchCall.body).toContain("code=test-code-123");
    expect(fetchCall.body).toContain("client_id=test-client-id");
    expect(fetchCall.body).toContain("client_secret=test-client-secret");

    expect(credentials.setOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "linear-access-token-123",
        refreshToken: "linear-refresh-token-456",
      })
    );

    const session = service.getSession(sessionId);
    expect(session.status).toBe("completed");
    expect(session.error).toBeNull();
  });

  it("handles OAuth callback with error parameter from Linear", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const { sessionId, authUrl, redirectUri } = await service.startSession();
    const stateParam = new URL(authUrl).searchParams.get("state")!;

    const callbackUrl = `${redirectUri}?error=access_denied&error_description=User+declined&state=${stateParam}`;
    await httpGet(callbackUrl);

    await waitForSessionStatus(service, sessionId, "failed");
    const session = service.getSession(sessionId);
    expect(session.error).toContain("User declined");
  });

  it("handles OAuth callback with state mismatch", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const { sessionId, redirectUri } = await service.startSession();

    const callbackUrl = `${redirectUri}?code=test-code&state=wrong-state`;
    await httpGet(callbackUrl);

    await waitForSessionStatus(service, sessionId, "failed");
    const session = service.getSession(sessionId);
    expect(session.error).toContain("state did not match");
  });

  it("handles OAuth callback without authorization code", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const { sessionId, authUrl, redirectUri } = await service.startSession();
    const stateParam = new URL(authUrl).searchParams.get("state")!;

    const callbackUrl = `${redirectUri}?state=${stateParam}`;
    await httpGet(callbackUrl);

    await waitForSessionStatus(service, sessionId, "failed");
    const session = service.getSession(sessionId);
    expect(session.error).toContain("did not include an authorization code");
  });

  it("handles token exchange failure gracefully", async () => {
    const credentials = createCredentialsMock();
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        error_description: "The authorization code has expired.",
      }),
    })) as any;

    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
      fetchImpl: mockFetch,
    });
    activeServices.push(service);

    const { sessionId, authUrl, redirectUri } = await service.startSession();
    const stateParam = new URL(authUrl).searchParams.get("state")!;

    const callbackUrl = `${redirectUri}?code=expired-code&state=${stateParam}`;
    await httpGet(callbackUrl);

    await waitForSessionStatus(service, sessionId, "failed");
    const session = service.getSession(sessionId);
    expect(session.error).toContain("expired");
  });

  it("supersedes previous pending sessions when starting a new one", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const first = await service.startSession();
    expect(service.getSession(first.sessionId).status).toBe("pending");

    const second = await service.startSession();
    expect(service.getSession(second.sessionId).status).toBe("pending");

    const firstStatus = service.getSession(first.sessionId);
    expect(firstStatus.status).toBe("expired");
    expect(firstStatus.error).toContain("Superseded");
  });

  it("dispose clears all sessions and closes servers", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    const { sessionId } = await service.startSession();

    service.dispose();

    const session = service.getSession(sessionId);
    expect(session.status).toBe("expired");
  });

  it("uses PKCE flow when no client secret is provided", async () => {
    const credentials = createCredentialsMock({ clientSecret: null });
    credentials.getOAuthClientCredentials.mockReturnValue({
      clientId: "public-client-id",
      clientSecret: null as any,
    });

    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const result = await service.startSession();
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("client_id")).toBe("public-client-id");
  });

  it("does not use PKCE when client secret is provided", async () => {
    const credentials = createCredentialsMock();
    const service = createLinearOAuthService({
      credentials: credentials as any,
      logger: createLogger(),
    });
    activeServices.push(service);

    const result = await service.startSession();
    const authUrl = new URL(result.authUrl);

    expect(authUrl.searchParams.get("code_challenge_method")).toBeNull();
    expect(authUrl.searchParams.get("code_challenge")).toBeNull();
  });
});

// =====================================================================
// linearClient
// =====================================================================

function makeIssueNode(id: string, updatedAt: string) {
  return {
    id,
    identifier: `ABC-${id}`,
    title: `Issue ${id}`,
    description: "Test issue",
    url: null,
    priority: 2,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt,
    project: { id: "proj-1", slug: "acme-platform" },
    team: { id: "team-1", key: "ACME" },
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    assignee: null,
    creator: { id: "user-1" },
    labels: { nodes: [{ id: "label-1", name: "bug" }] },
    children: { nodes: [] },
  };
}

describe("linearClient", () => {
  it("paginates issues using cursors", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: Record<string, unknown> };
      if (!body.query?.includes("IssuesByProject")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }

      const after = body.variables?.after ?? null;
      if (!after) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                nodes: [makeIssueNode("1", "2026-03-05T00:00:00.000Z")],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [makeIssueNode("2", "2026-03-05T00:01:00.000Z")],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = createLinearClient({
      credentials: {
        getTokenOrThrow: () => "Bearer test-token",
        getStatus: () => ({ authMode: "oauth" }),
      } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    const issues = await client.fetchCandidateIssues({
      projectSlugs: ["acme-platform"],
      stateTypes: ["unstarted", "started"],
    });

    expect(issues.length).toBe(2);
    expect(issues[0]?.identifier).toBe("ABC-1");
    expect(issues[1]?.identifier).toBe("ABC-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries once on rate-limit response for viewer query", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: "Rate limit exceeded" }],
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              viewer: { id: "viewer-1", name: "Alex" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    const client = createLinearClient({
      credentials: {
        getTokenOrThrow: () => "Bearer test-token",
        getStatus: () => ({ authMode: "oauth" }),
      } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    const viewer = await client.getViewer();
    expect(viewer.id).toBe("viewer-1");
    expect(viewer.name).toBe("Alex");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists projects with their owning team names", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      expect(init?.headers).toMatchObject({ authorization: "lin_api_test" });
      if (!body.query?.includes("query Projects")) {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          data: {
            projects: {
              nodes: [
                {
                  id: "project-1",
                  name: "App Platform",
                  slug: "app-platform",
                  teams: {
                    nodes: [{ name: "Platform" }],
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = createLinearClient({
      credentials: {
        getTokenOrThrow: () => "lin_api_test",
        getStatus: () => ({ authMode: "manual" }),
      } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    await expect(client.listProjects()).resolves.toEqual([
      { id: "project-1", name: "App Platform", slug: "app-platform", teamName: "Platform" },
    ]);
  });

  it("strips a pasted bearer prefix from manual API keys", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "lin_api_test" });
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "viewer-1", name: "Alex" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const client = createLinearClient({
      credentials: {
        getTokenOrThrow: () => "Bearer lin_api_test",
        getStatus: () => ({ authMode: "manual" }),
      } as any,
      fetchImpl: fetchImpl as any,
      logger: null,
    });

    await expect(client.getViewer()).resolves.toEqual({ id: "viewer-1", name: "Alex" });
  });
});
