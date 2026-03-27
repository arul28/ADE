import http from "node:http";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createLinearOAuthService } from "./linearOAuthService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: vi.fn(),
    error: () => {},
  } as any;
}

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
      // Server closed before we could read the full response.
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
  // Final check that will throw a clear assertion error
  const session = service.getSession(sessionId);
  expect(session.status, `Timed out waiting for session ${sessionId} to reach status '${expectedStatus}'`).toBe(expectedStatus);
}

afterEach(async () => {
  for (const svc of activeServices) {
    svc.dispose();
  }
  activeServices.length = 0;
  // Allow port to fully release between tests
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

    // Extract the state parameter from the authUrl
    const stateParam = new URL(authUrl).searchParams.get("state")!;
    expect(stateParam).toBeTruthy();

    // Simulate the OAuth callback
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

    // The server may close before the HTTP response is fully consumed,
    // so we wait for the session state to transition.
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

    // First session should be superseded
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
    // Do NOT push to activeServices since we call dispose manually
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

    // PKCE params should not be present when client_secret is available
    expect(authUrl.searchParams.get("code_challenge_method")).toBeNull();
    expect(authUrl.searchParams.get("code_challenge")).toBeNull();
  });
});
