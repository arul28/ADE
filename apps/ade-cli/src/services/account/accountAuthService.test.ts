import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../credentials/credentialStore";
import {
  ACCOUNT_SESSION_CREDENTIAL_KEY,
  createAccountAuthService,
  derivePkceChallenge,
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
});
