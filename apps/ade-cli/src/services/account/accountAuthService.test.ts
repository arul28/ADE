import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../credentials/credentialStore";
import {
  ACCOUNT_SESSION_CREDENTIAL_KEY,
  createAccountAuthService,
  derivePkceChallenge,
  getSignedInAccountAccessToken,
  type AccountAuthService,
  type AccountSessionRecord,
} from "./accountAuthService";

class MemoryCredentialStore implements SyncCredentialStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

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

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storedSession(overrides: Partial<AccountSessionRecord> = {}): AccountSessionRecord {
  return {
    accessToken: jwt({ sub: "user_old", email: "old@example.com", name: "Old User" }),
    refreshToken: "refresh-old",
    tokenType: "Bearer",
    expiresAt: "2026-07-14T12:01:00.000Z",
    obtainedAt: "2026-07-14T11:00:00.000Z",
    userId: "user_old",
    email: "old@example.com",
    name: "Old User",
    ...overrides,
  };
}

const activeServices: AccountAuthService[] = [];

afterEach(() => {
  for (const service of activeServices.splice(0)) service.dispose();
});

describe("AccountAuthService CLERK_ISSUER scheme enforcement", () => {
  function serviceForIssuer(issuer: string): AccountAuthService {
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer, clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x11),
      randomUUID: () => "login-session-scheme",
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);
    return service;
  }

  it("rejects a non-loopback http issuer (plaintext would leak the code/token)", async () => {
    await expect(serviceForIssuer("http://clerk.example.test").startLogin()).rejects.toThrow(
      /https/i,
    );
  });

  it("accepts an https issuer", async () => {
    const start = await serviceForIssuer("https://clerk.example.test").startLogin();
    expect(new URL(start.authorizeUrl).protocol).toBe("https:");
  });

  it("accepts an http://localhost issuer for local development", async () => {
    const start = await serviceForIssuer("http://localhost:3000").startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    expect(authorizeUrl.protocol).toBe("http:");
    expect(authorizeUrl.host).toBe("localhost:3000");
  });
});

describe("AccountAuthService OAuth PKCE login", () => {
  it("derives the S256 challenge and constructs the exact loopback authorize URL", async () => {
    const verifierBytes = Buffer.alloc(32, 0x11);
    const stateBytes = Buffer.alloc(32, 0x22);
    const randomBytes = vi.fn()
      .mockReturnValueOnce(verifierBytes)
      .mockReturnValueOnce(stateBytes);
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test/", clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes,
      randomUUID: () => "login-session-1",
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const verifier = verifierBytes.toString("base64url");

    expect(start.sessionId).toBe("login-session-1");
    expect(start.expiresAt).toBe("2026-07-14T12:05:00.000Z");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://clerk.example.test/oauth/authorize");
    expect(Object.fromEntries(authorizeUrl.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-public",
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      code_challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
      code_challenge_method: "S256",
      state: stateBytes.toString("base64url"),
      scope: "openid profile email offline_access",
    });
    expect(start.authorizeUrl).toContain("scope=openid%20profile%20email%20offline_access");
    expect(derivePkceChallenge(verifier)).toBe(
      createHash("sha256").update(verifier, "ascii").digest("base64url"),
    );
  });

  it("exchanges the callback code, persists the session, and returns the close-tab page", async () => {
    const store = new MemoryCredentialStore();
    const accessToken = jwt({
      sub: "user_123",
      email: "person@example.com",
      name: "Person Example",
    });
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => jsonResponse({
      access_token: accessToken,
      refresh_token: "refresh-123",
      expires_in: 3600,
      token_type: "Bearer",
    }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x33),
      randomUUID: () => "login-session-success",
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toEqual({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
      source: null,
    });
    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    const callback = await fetch(`${redirectUri}?code=oauth-code-123&state=${encodeURIComponent(state)}`);
    const html = await callback.text();

    expect(callback.status).toBe(200);
    expect(html).toContain("You can close this tab — signed in to ADE");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = fetchImpl.mock.calls[0]!;
    expect(tokenUrl).toBe("https://clerk.example.test/oauth/token");
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "oauth-code-123",
      code_verifier: Buffer.alloc(32, 0x33).toString("base64url"),
      client_id: "client-public",
      redirect_uri: redirectUri,
    });

    const persisted = JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!) as AccountSessionRecord;
    expect(persisted).toMatchObject({
      accessToken,
      refreshToken: "refresh-123",
      expiresAt: "2026-07-14T13:00:00.000Z",
      obtainedAt: "2026-07-14T12:00:00.000Z",
      userId: "user_123",
      email: "person@example.com",
      name: "Person Example",
    });
    await expect(service.pollLogin(start.sessionId)).resolves.toEqual({
      status: "signed_in",
      message: null,
      authStatus: {
        signedIn: true,
        userId: "user_123",
        email: "person@example.com",
        name: "Person Example",
        expiresAt: "2026-07-14T13:00:00.000Z",
        source: "loopback",
      },
    });
  });

  it("cancelLogin closes the loopback listener so a late completion cannot sign in", async () => {
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x55),
      randomUUID: () => "login-session-cancel",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;

    service.cancelLogin(start.sessionId);

    // The loopback listener is closed, so a browser tab that completes AFTER the
    // CLI timed out can no longer reach it to exchange the authorization code.
    await expect(
      fetch(`${redirectUri}?code=late-code&state=${encodeURIComponent(state)}`),
    ).rejects.toThrow();

    // Cancel must not exchange a token, must not persist a session, and must
    // leave the machine signed out.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
    expect(service.getStatus()).toEqual({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
      source: null,
    });

    // The pending session is gone; polling reports it was not found rather than
    // ever transitioning to signed_in.
    await expect(service.pollLogin(start.sessionId)).resolves.toMatchObject({
      status: "error",
      authStatus: { signedIn: false },
    });

    // Idempotent: cancelling again, or an unknown id, is a harmless no-op.
    expect(() => service.cancelLogin(start.sessionId)).not.toThrow();
    expect(() => service.cancelLogin("unknown-session")).not.toThrow();
  });

  it("cancelLogin leaves an already signed-in account untouched", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x66),
      randomUUID: () => "login-session-cancel-existing",
      fetchImpl,
    });
    activeServices.push(service);

    const before = store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
    const start = await service.startLogin();
    service.cancelLogin(start.sessionId);

    // Cancelling a pending login must NOT sign out the existing account: the
    // persisted session is byte-for-byte intact and still reported signed in.
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(before);
    expect(service.getStatus()).toMatchObject({ signedIn: true, email: "old@example.com" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a state mismatch without exchanging or resolving the pending login", async () => {
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      randomBytes: (size) => Buffer.alloc(size, 0x44),
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const redirectUri = new URL(start.authorizeUrl).searchParams.get("redirect_uri")!;
    const callback = await fetch(`${redirectUri}?code=stolen-code&state=wrong-state`);

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("ADE sign-in failed");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
    await expect(service.pollLogin(start.sessionId)).resolves.toMatchObject({
      status: "pending",
      authStatus: { signedIn: false },
    });
  });
});

describe("AccountAuthService device authorization", () => {
  it("starts through the bridge, polls, and stores the approved session with device source", async () => {
    const store = new MemoryCredentialStore();
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const accessToken = jwt({ sub: "device-user", email: "device@example.com" });
    let tokenPolls = 0;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/device/code")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          device_secret: Buffer.alloc(32, 0x77).toString("base64url"),
        });
        return jsonResponse({
          device_code: "bridge-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://directory.example.test/device",
          verification_uri_complete: "https://directory.example.test/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        });
      }
      expect(input).toBe("https://directory.example.test/device/token");
      expect(JSON.parse(String(init?.body))).toEqual({
        device_code: "bridge-device-code",
        device_secret: Buffer.alloc(32, 0x77).toString("base64url"),
      });
      tokenPolls += 1;
      return tokenPolls === 1
        ? jsonResponse({ error: "authorization_pending", interval: 5 }, 400)
        : jsonResponse({
            access_token: accessToken,
            refresh_token: "device-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test/",
      now: () => nowMs,
      randomBytes: (size) => Buffer.alloc(size, 0x77),
      randomUUID: () => "device-session",
      fetchImpl,
    });
    activeServices.push(service);

    await expect(service.startDeviceLogin()).resolves.toEqual({
      sessionId: "device-session",
      userCode: "ABCD-EFGH",
      verificationUri: "https://directory.example.test/device",
      verificationUriComplete: "https://directory.example.test/device?user_code=ABCD-EFGH",
      expiresAt: "2026-07-14T12:10:00.000Z",
      intervalSec: 5,
    });
    await expect(service.pollDeviceLogin("device-session")).resolves.toMatchObject({
      status: "pending",
      intervalSec: 5,
      authStatus: { signedIn: false, source: null },
    });
    await expect(service.pollDeviceLogin("device-session")).resolves.toEqual({
      status: "signed_in",
      message: null,
      intervalSec: null,
      authStatus: {
        signedIn: true,
        userId: "device-user",
        email: "device@example.com",
        name: null,
        expiresAt: "2026-07-14T13:00:00.000Z",
        source: "device",
      },
    });
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken,
      refreshToken: "device-refresh-token",
      authSource: "device",
    });
  });

  it("keeps an explicit device identity active instead of reverting to inherited env auth", async () => {
    const store = new MemoryCredentialStore();
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const inheritedAccessToken = jwt({
      sub: "inherited-user",
      email: "inherited@example.com",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const deviceAccessToken = jwt({ sub: "device-user", email: "device@example.com" });
    const env = { ADE_ACCOUNT_TOKEN: inheritedAccessToken } as NodeJS.ProcessEnv;
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => input.endsWith("/device/code")
      ? jsonResponse({
          device_code: "explicit-device-code",
          user_code: "EXPL-ICIT",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        })
      : jsonResponse({
          access_token: deviceAccessToken,
          refresh_token: "explicit-device-refresh",
          expires_in: 3600,
        }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      env,
      now: () => nowMs,
      randomUUID: () => "explicit-device-session",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin({ ignoreEnvCredential: true });
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "signed_in",
      authStatus: {
        userId: "device-user",
        email: "device@example.com",
        source: "device",
      },
    });
    expect(env.ADE_ACCOUNT_TOKEN).toBe(inheritedAccessToken);
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: "device-user",
      email: "device@example.com",
      source: "device",
    });
    await expect(service.getAccessToken()).resolves.toBe(deviceAccessToken);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: deviceAccessToken,
      authSource: "device",
      suppressEnvCredential: true,
    });

    const restartedService = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env,
      now: () => nowMs,
      fetchImpl: vi.fn(),
    });
    activeServices.push(restartedService);
    expect(restartedService.getStatus()).toMatchObject({
      signedIn: true,
      userId: "device-user",
      email: "device@example.com",
      source: "device",
    });
    await expect(restartedService.getAccessToken()).resolves.toBe(deviceAccessToken);

    restartedService.signOut();
    expect(restartedService.getStatus()).toMatchObject({
      signedIn: true,
      userId: "inherited-user",
      email: "inherited@example.com",
      source: "env-token",
    });
  });

  it("pins concurrent device sessions to the bridge that created each code", async () => {
    let activeBridge = "https://directory-a.example.test";
    const getDeviceBridgeUrl = vi.fn(() => activeBridge);
    const randomUUID = vi.fn()
      .mockReturnValueOnce("device-session-a")
      .mockReturnValueOnce("device-session-b");
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const bridge = url.hostname.startsWith("directory-a") ? "a" : "b";
      if (url.pathname === "/device/code") {
        return jsonResponse({
          device_code: `device-code-${bridge}`,
          user_code: bridge === "a" ? "AAAA-AAAA" : "BBBB-BBBB",
          verification_uri: `${url.origin}/device`,
          expires_in: 600,
          interval: 5,
        });
      }
      expect(url.pathname).toBe("/device/token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        device_code: `device-code-${bridge}`,
      });
      return jsonResponse({ error: "authorization_pending", interval: 5 }, 400);
    });
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl,
      randomUUID,
      fetchImpl,
    });
    activeServices.push(service);

    const first = await service.startDeviceLogin();
    activeBridge = "https://directory-b.example.test";
    const second = await service.startDeviceLogin();

    await expect(service.pollDeviceLogin(first.sessionId)).resolves.toMatchObject({ status: "pending" });
    await expect(service.pollDeviceLogin(second.sessionId)).resolves.toMatchObject({ status: "pending" });
    expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
      "https://directory-a.example.test/device/code",
      "https://directory-b.example.test/device/code",
      "https://directory-a.example.test/device/token",
      "https://directory-b.example.test/device/token",
    ]);
    expect(getDeviceBridgeUrl).toHaveBeenCalledTimes(2);
  });

  it("cancels daemon-held device redemption state without changing an existing session", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      device_code: "bridge-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://directory.example.test/device",
      expires_in: 600,
      interval: 5,
    }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "device-session-cancel",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    service.cancelLogin(start.sessionId);

    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({ status: "error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({ signedIn: true, source: "loopback" });
  });

  it("bounds device bridge requests and preserves the session after a polling timeout", async () => {
    const accessToken = jwt({ sub: "device-timeout-user" });
    let tokenPolls = 0;
    const fetchImpl = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (input.endsWith("/device/code")) {
        return Promise.resolve(jsonResponse({
          device_code: "device-timeout-code",
          user_code: "TIME-OUT1",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 1,
        }));
      }
      tokenPolls += 1;
      if (tokenPolls === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("response body aborted")), {
              once: true,
            });
          }),
        } as Response);
      }
      return Promise.resolve(jsonResponse({ access_token: accessToken, expires_in: 3600 }));
    });
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "device-timeout-session",
      fetchImpl,
      deviceBridgeRequestTimeoutMs: 5,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "pending",
      intervalSec: 1,
    });
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "signed_in",
      authStatus: { userId: "device-timeout-user" },
    });
  });

  it("preserves device sessions across retryable 429 and 5xx bridge responses", async () => {
    const accessToken = jwt({ sub: "device-retry-user" });
    const tokenResponses = [
      jsonResponse({ error: "rate_limited" }, 429),
      jsonResponse({ error: "temporarily_unavailable" }, 503),
      jsonResponse({ access_token: accessToken, expires_in: 3600 }),
    ];
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/device/code")) {
        return jsonResponse({
          device_code: "device-retry-code",
          user_code: "RETR-Y123",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        });
      }
      return tokenResponses.shift()!;
    });
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "device-retry-session",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "slow_down",
      intervalSec: 10,
    });
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "pending",
      intervalSec: 10,
    });
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "signed_in",
      authStatus: { userId: "device-retry-user" },
    });
  });
});

describe("AccountAuthService ADE_ACCOUNT_TOKEN", () => {
  it("uses a non-expired access token directly without a flow or disk write", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const accessToken = jwt({
      sub: "env-user",
      email: "env@example.com",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env: { ADE_ACCOUNT_TOKEN: accessToken } as NodeJS.ProcessEnv,
      now: () => nowMs,
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toEqual({
      signedIn: true,
      userId: "env-user",
      email: "env@example.com",
      name: null,
      expiresAt: "2026-07-14T13:00:00.000Z",
      source: "env-token",
    });
    await expect(service.getAccessToken()).resolves.toBe(accessToken);
    await expect(service.startLogin()).rejects.toThrow(/no interactive sign-in is required/);
    await expect(service.startDeviceLogin()).rejects.toThrow(/no interactive sign-in is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("refreshes a newly provisioned token without local OAuth configuration", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const issuingStore = new MemoryCredentialStore();
    issuingStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const issuingService = createAccountAuthService({
      credentialStore: issuingStore,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env: {} as NodeJS.ProcessEnv,
      now: () => nowMs,
    });
    activeServices.push(issuingService);
    const provisioned = await issuingService.createToken();
    expect(provisioned.token).toMatch(/^ade_account_v1\./);
    expect(provisioned.token).not.toContain("refresh-old");

    const localConfig = vi.fn(() => {
      throw new Error("local Clerk config must not be read");
    });
    const refreshedAccessToken = jwt({
      sub: "env-self-contained-user",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      expect(input).toBe("https://clerk.example.test/oauth/token");
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-old",
        client_id: "client-public",
      });
      return jsonResponse({ access_token: refreshedAccessToken, expires_in: 3600 });
    });
    const consumingService = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: localConfig,
      env: { ADE_ACCOUNT_TOKEN: provisioned.token } as NodeJS.ProcessEnv,
      now: () => nowMs,
      fetchImpl,
    });
    activeServices.push(consumingService);

    expect(consumingService.getStatus()).toMatchObject({
      signedIn: false,
      source: "env-token",
      expiresAt: null,
    });
    await expect(getSignedInAccountAccessToken(consumingService)).resolves.toBe(refreshedAccessToken);
    expect(localConfig).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rejectedService = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: localConfig,
      env: { ADE_ACCOUNT_TOKEN: provisioned.token } as NodeJS.ProcessEnv,
      fetchImpl: vi.fn(async () => jsonResponse({
        error: "invalid_grant",
        error_description: "rejected refresh-old",
      }, 400)),
    });
    activeServices.push(rejectedService);
    let rejected: unknown;
    try {
      await rejectedService.getAccessToken();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/ADE_ACCOUNT_TOKEN refresh failed/);
    expect(JSON.stringify(rejected)).not.toContain("refresh-old");
    expect(JSON.stringify(rejected)).not.toContain(provisioned.token);
  });

  it("keeps legacy opaque refresh tokens working with local config and never persists or logs them", async () => {
    const envRefreshToken = "refresh-secret-that-must-not-be-logged";
    const loggerEvents: unknown[] = [];
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const refreshedAccessToken = jwt({
      sub: "env-refresh-user",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: "refresh_token",
        refresh_token: envRefreshToken,
        client_id: "client-public",
      });
      return jsonResponse({ access_token: refreshedAccessToken, expires_in: 3600 });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env: { ADE_ACCOUNT_TOKEN: envRefreshToken } as NodeJS.ProcessEnv,
      now: () => nowMs,
      fetchImpl,
      logger: {
        info: (message, meta) => loggerEvents.push([message, meta]),
        warn: (message, meta) => loggerEvents.push([message, meta]),
      },
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({ signedIn: false, source: "env-token", expiresAt: null });
    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      source: "env-token",
      userId: "env-refresh-user",
      expiresAt: "2026-07-14T13:00:00.000Z",
    });
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
    expect(JSON.stringify(loggerEvents)).not.toContain(envRefreshToken);
  });

  it("gives migration guidance when a legacy opaque refresh token has no local config", async () => {
    const legacyRefreshToken = "legacy-refresh-secret";
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "", clientId: "" }),
      env: { ADE_ACCOUNT_TOKEN: legacyRefreshToken } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({ signedIn: false, source: "env-token" });
    await expect(service.getAccessToken()).rejects.toThrow(
      /Legacy ADE_ACCOUNT_TOKEN.*ade account token create/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never lets an older in-flight refresh overwrite or return another env credential", async () => {
    const env = { ADE_ACCOUNT_TOKEN: "refresh-account-a" } as NodeJS.ProcessEnv;
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const accountAAccessToken = jwt({
      sub: "account-a",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    const accountBAccessToken = jwt({
      sub: "account-b",
      exp: Math.floor((nowMs + 3600_000) / 1000),
    });
    let resolveAccountA: ((response: Response) => void) | null = null;
    const refreshBodies: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      refreshBodies.push(body);
      if (body.refresh_token === "refresh-account-a") {
        return new Promise<Response>((resolve) => {
          resolveAccountA = resolve;
        });
      }
      return jsonResponse({
        access_token: accountBAccessToken,
        refresh_token: "refresh-account-b-rotated",
        expires_in: 3600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env,
      now: () => nowMs,
      fetchImpl,
    });
    activeServices.push(service);

    const accountARefresh = service.getAccessToken();
    await vi.waitFor(() => expect(resolveAccountA).not.toBeNull());
    env.ADE_ACCOUNT_TOKEN = "refresh-account-b";
    const accountBRefresh = service.getAccessToken();
    await expect(accountBRefresh).resolves.toBe(accountBAccessToken);
    resolveAccountA!(jsonResponse({
      access_token: accountAAccessToken,
      refresh_token: "refresh-account-a-rotated",
      expires_in: 3600,
    }));

    await expect(accountARefresh).resolves.toBe(accountBAccessToken);
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      source: "env-token",
      userId: "account-b",
    });
    expect(refreshBodies.map((body) => body.refresh_token)).toEqual([
      "refresh-account-a",
      "refresh-account-b",
    ]);
  });

  it("surfaces access-token expiry instead of attempting an interactive flow", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const expired = jwt({ exp: Math.floor((nowMs - 60_000) / 1000) });
    const service = createAccountAuthService({
      credentialStore: new MemoryCredentialStore(),
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env: { ADE_ACCOUNT_TOKEN: expired } as NodeJS.ProcessEnv,
      now: () => nowMs,
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({
      signedIn: false,
      source: "env-token",
      expiresAt: "2026-07-14T11:59:00.000Z",
    });
    await expect(service.getAccessToken()).rejects.toThrow(/ADE_ACCOUNT_TOKEN access token expired/);
  });
});

describe("AccountAuthService refresh and sign-out", () => {
  it("refreshes inside the two-minute skew and retains identity plus a non-rotated refresh token", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const refreshedAccessToken = jwt({ sub: "user_old", email: "old@example.com" });
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => jsonResponse({
      access_token: refreshedAccessToken,
      expires_in: 86_400,
      token_type: "Bearer",
    }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
      client_id: "client-public",
    });
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: refreshedAccessToken,
      refreshToken: "refresh-old",
      userId: "user_old",
      email: "old@example.com",
      name: "Old User",
      expiresAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("uses authEpoch so sign-out cannot be overwritten by an in-flight refresh", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    let resolveRefresh: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
    });
    activeServices.push(service);

    const refresh = service.getAccessToken();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(service.signOut()).toEqual({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
      source: null,
    });
    resolveRefresh!(jsonResponse({
      access_token: jwt({ sub: "user_new" }),
      refresh_token: "refresh-new",
      expires_in: 3600,
    }));

    await expect(refresh).rejects.toThrow("ADE is not signed in");
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("clears the shared credential on sign-out", () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({ signedIn: true, email: "old@example.com" });
    expect(service.signOut()).toMatchObject({ signedIn: false, email: null });
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("returns an account relay token only for a usable signed-in account", async () => {
    const getAccessToken = vi.fn(async () => "clerk-access-token");
    await expect(getSignedInAccountAccessToken({
      getStatus: () => ({ signedIn: true, userId: "user_1", email: null, name: null, expiresAt: null }),
      getAccessToken,
    })).resolves.toBe("clerk-access-token");
    await expect(getSignedInAccountAccessToken({
      getStatus: () => ({ signedIn: false, userId: null, email: null, name: null, expiresAt: null }),
      getAccessToken,
    })).resolves.toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy integration auth available when account token refresh fails", async () => {
    await expect(getSignedInAccountAccessToken({
      getStatus: () => ({ signedIn: true, userId: "user_1", email: null, name: null, expiresAt: null }),
      getAccessToken: async () => { throw new Error("refresh failed"); },
    })).resolves.toBeNull();
  });

  it("creates a durable agent token only from an interactive refresh-token session", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      authSource: "device",
    })));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      env: {} as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    await expect(service.createToken()).resolves.toEqual({
      token: expect.stringMatching(/^ade_account_v1\./),
      source: "refresh_token",
      guidance: expect.stringContaining("self-contained secret as ADE_ACCOUNT_TOKEN"),
    });
  });
});
