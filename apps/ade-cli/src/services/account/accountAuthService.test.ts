import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
} from "../../../../desktop/src/shared/accountDirectory";
import {
  CREDENTIAL_STORE_LOCK_TIMEOUT_MS,
  type SyncCredentialStore,
} from "../credentials/credentialStore";
import {
  ACCOUNT_SESSION_CREDENTIAL_KEY,
  ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
  DEFAULT_REFRESH_ROTATION_WAIT_MS,
  accountTokenGeneration,
  createAccountActionDomainService,
  createAccountAuthService,
  derivePkceChallenge,
  getSignedInAccountAccessToken,
  type AccountAuthService,
  type AccountSessionRecord,
} from "./accountAuthService";

class MemoryCredentialStore implements SyncCredentialStore {
  readonly values = new Map<string, string>();
  private readonly changeListeners = new Set<() => void>();
  readState: "available" | "missing" | "unreadable" = "available";

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

  updateSync(updater: (values: Record<string, string>) => boolean | void): void {
    const values = Object.fromEntries(this.values);
    if (updater(values) === false) return;
    this.values.clear();
    for (const [key, value] of Object.entries(values)) this.values.set(key, value);
  }

  onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  notifyExternalChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  getLastReadState() {
    return this.readState;
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
  vi.useRealTimers();
  for (const service of activeServices.splice(0)) service.dispose();
});

describe("account action analytics identity", () => {
  it("identifies persisted signed-in status and resets identity for signed-out status", () => {
    const analytics = {
      identifyAccount: vi.fn(),
      resetAccountIdentity: vi.fn(),
    };
    const service = {
      getStatus: vi.fn()
        .mockReturnValueOnce({
          signedIn: true,
          userId: "user_persisted",
          email: null,
          name: null,
          expiresAt: null,
        })
        .mockReturnValueOnce({
          signedIn: false,
          userId: null,
          email: null,
          name: null,
          expiresAt: null,
        }),
    } as unknown as AccountAuthService;
    const domain = createAccountActionDomainService(service, analytics);

    expect(domain.status()).toMatchObject({ signedIn: true, userId: "user_persisted" });
    expect(analytics.identifyAccount).toHaveBeenCalledWith("user_persisted");
    expect(analytics.resetAccountIdentity).not.toHaveBeenCalled();

    expect(domain.status()).toMatchObject({ signedIn: false, userId: null });
    expect(analytics.resetAccountIdentity).toHaveBeenCalledTimes(1);
  });
});

describe("AccountAuthService persisted session notifications", () => {
  it("preserves an unreadable credential-file diagnosis when the account key is absent", () => {
    const store = new MemoryCredentialStore();
    store.readState = "unreadable";
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client" }),
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);

    expect(service.getStatus().signedIn).toBe(false);
    expect(service.getSessionReadState()).toBe("unreadable");
  });

  it("detects a sign-in persisted by another process", async () => {
    vi.useFakeTimers();
    const store = new MemoryCredentialStore();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);
    const listener = vi.fn();
    service.onSignedIn(listener);

    store.values.set(
      ACCOUNT_SESSION_CREDENTIAL_KEY,
      JSON.stringify(storedSession({ expiresAt: "2026-07-14T13:00:00.000Z" })),
    );
    store.notifyExternalChange();
    await vi.advanceTimersByTimeAsync(25);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getStatus().signedIn).toBe(true);

    store.notifyExternalChange();
    await vi.advanceTimersByTimeAsync(25);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("AccountAuthService packaged development-session policy", () => {
  const now = () => Date.parse("2026-07-14T12:00:00.000Z");
  const productionAccessToken = () => jwt({
    iss: DEFAULT_ADE_CLERK_ISSUER,
    sub: "user_old",
    exp: now() / 1000 + 3_600,
  });
  const developmentAccessToken = () => jwt({
    iss: DEVELOPMENT_ADE_CLERK_ISSUER,
    sub: "user_old",
    exp: now() / 1000 + 3_600,
  });

  function serviceWithStoredSession(args: {
    env: NodeJS.ProcessEnv;
    session: AccountSessionRecord;
  }): {
    service: AccountAuthService;
    store: MemoryCredentialStore;
    fetchImpl: ReturnType<typeof vi.fn>;
  } {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(args.session));
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: args.env,
      now,
      fetchImpl,
    });
    activeServices.push(service);
    return { service, store, fetchImpl };
  }

  it("invalidates a packaged stored development-issuer session before status, token return, or refresh", async () => {
    const { service, store, fetchImpl } = serviceWithStoredSession({
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      session: storedSession({
        accessToken: productionAccessToken(),
        oauthConfig: {
          issuer: `${DEVELOPMENT_ADE_CLERK_ISSUER}./`,
          clientId: "custom-client",
        },
      }),
    });

    expect(service.getStatus()).toMatchObject({
      signedIn: false,
      userId: null,
      source: null,
    });
    expect(service.getSessionReadState()).toBe("missing");
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
    await expect(service.getAccessToken()).rejects.toThrow(/not signed in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "development OAuth client id",
      session: storedSession({
        accessToken: productionAccessToken(),
        oauthConfig: {
          issuer: DEFAULT_ADE_CLERK_ISSUER,
          clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
        },
      }),
    },
    {
      name: "development access-token issuer claim",
      session: storedSession({
        accessToken: developmentAccessToken(),
        oauthConfig: {
          issuer: DEFAULT_ADE_CLERK_ISSUER,
          clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
        },
      }),
    },
  ])("also invalidates a packaged session identified by $name", async ({ session }) => {
    const { service, store, fetchImpl } = serviceWithStoredSession({
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      session,
    });

    expect(service.getStatus().signedIn).toBe(false);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
    await expect(service.getAccessToken()).rejects.toThrow(/not signed in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a source-checkout development session unchanged", async () => {
    const session = storedSession({
      accessToken: developmentAccessToken(),
      oauthConfig: {
        issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
        clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const { service, store, fetchImpl } = serviceWithStoredSession({
      env: {} as NodeJS.ProcessEnv,
      session,
    });

    expect(service.getStatus().signedIn).toBe(true);
    await expect(service.getAccessToken()).resolves.toBe(session.accessToken);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(JSON.stringify(session));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a packaged development session unchanged with the explicit escape hatch", async () => {
    const session = storedSession({
      accessToken: developmentAccessToken(),
      oauthConfig: {
        issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
        clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const { service, store, fetchImpl } = serviceWithStoredSession({
      env: {
        ADE_RUNTIME_PACKAGED: "1",
        ADE_ALLOW_DEVELOPMENT_CLERK: "1",
      } as NodeJS.ProcessEnv,
      session,
    });

    expect(service.getStatus().signedIn).toBe(true);
    await expect(service.getAccessToken()).resolves.toBe(session.accessToken);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(JSON.stringify(session));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a packaged production session unchanged", async () => {
    const session = storedSession({
      accessToken: productionAccessToken(),
      oauthConfig: {
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const { service, store, fetchImpl } = serviceWithStoredSession({
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      session,
    });

    expect(service.getStatus().signedIn).toBe(true);
    await expect(service.getAccessToken()).resolves.toBe(session.accessToken);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(JSON.stringify(session));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not clear a newer production session written while invalidating a development session", async () => {
    const developmentSession = storedSession({
      accessToken: developmentAccessToken(),
      oauthConfig: {
        issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
        clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const productionSession = storedSession({
      accessToken: productionAccessToken(),
      refreshToken: "production-refresh-token",
      obtainedAt: "2026-07-14T11:30:00.000Z",
      oauthConfig: {
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    class RacingCredentialStore extends MemoryCredentialStore {
      private replacementPending = true;
      accountReads = 0;

      override getSync(key: string): string | null {
        if (key === ACCOUNT_SESSION_CREDENTIAL_KEY) this.accountReads += 1;
        return super.getSync(key);
      }

      override updateSync(updater: (values: Record<string, string>) => boolean | void): void {
        if (this.replacementPending) {
          this.replacementPending = false;
          this.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(productionSession));
        }
        super.updateSync(updater);
      }
    }
    const store = new RacingCredentialStore();
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      now,
      fetchImpl,
    });
    activeServices.push(service);

    // Seed the development session after construction so this getStatus() is
    // the call that observes it, loses the compare-delete race, and must retry.
    store.accountReads = 0;
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(developmentSession));
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: productionSession.userId,
      source: "loopback",
    });
    expect(store.accountReads).toBe(2);
    await expect(service.getAccessToken()).resolves.toBe(productionSession.accessToken);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(JSON.stringify(productionSession));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects but does not delete a packaged development session when the store lacks atomic compare-and-delete", async () => {
    const developmentSession = storedSession({
      accessToken: developmentAccessToken(),
      oauthConfig: {
        issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
        clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const store = new MemoryCredentialStore();
    // A store without atomic compare-and-delete must not get-then-delete (that
    // would race a peer-written production replacement); reject on read instead.
    (store as { updateSync?: unknown }).updateSync = undefined;
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(developmentSession));
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      now,
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({ signedIn: false, source: null });
    expect(service.getSessionReadState()).toBe("missing");
    await expect(service.getAccessToken()).rejects.toThrow(/not signed in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(
      JSON.stringify(developmentSession),
    );
  });
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
      provider: "github",
    });
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) {
        expect(init).toMatchObject({
          method: "GET",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
        });
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        return jsonResponse({
          email: "person@example.com",
          name: "Person Example",
          picture: "https://images.example/person.png",
        });
      }
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-123",
        expires_in: 3600,
        token_type: "Bearer",
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x33),
      randomUUID: () => "login-session-success",
      fetchImpl,
    });
    activeServices.push(service);
    const onSignedIn = vi.fn();
    service.onSignedIn?.(onSignedIn);

    expect(service.getStatus()).toEqual({
      signedIn: false,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
      source: null,
      sessionState: "signed_out",
    });
    expect(service.getSessionReadState?.()).toBe("missing");
    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    const callback = await fetch(`${redirectUri}?code=oauth-code-123&state=${encodeURIComponent(state)}`);
    const html = await callback.text();

    expect(callback.status).toBe(200);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(html).toContain("You can close this tab — signed in to ADE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(service.getStatus().signedIn).toBe(true);
    expect(service.getSessionReadState?.()).toBe("available");
    expect(persisted).toMatchObject({
      accessToken,
      refreshToken: "refresh-123",
      expiresAt: "2026-07-14T13:00:00.000Z",
      obtainedAt: "2026-07-14T12:00:00.000Z",
      userId: "user_123",
      email: "person@example.com",
      name: "Person Example",
      provider: "github",
      imageUrl: "https://images.example/person.png",
      oauthConfig: {
        issuer: "https://clerk.example.test",
        clientId: "client-public",
      },
    });
    await expect(service.pollLogin(start.sessionId)).resolves.toEqual({
      status: "signed_in",
      message: null,
      authStatus: {
        signedIn: true,
        userId: "user_123",
        email: "person@example.com",
        name: "Person Example",
        provider: "github",
        imageUrl: "https://images.example/person.png",
        expiresAt: "2026-07-14T13:00:00.000Z",
        source: "loopback",
        sessionState: "active",
      },
    });
  });

  it("rejects a development-issued login response in a packaged build before userinfo or persistence", async () => {
    const store = new MemoryCredentialStore();
    const developmentAccessToken = jwt({
      iss: DEVELOPMENT_ADE_CLERK_ISSUER,
      sub: "development-user",
      exp: Date.parse("2026-07-14T13:00:00.000Z") / 1000,
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      access_token: developmentAccessToken,
      refresh_token: "development-refresh-token",
      expires_in: 3_600,
    }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: { ADE_RUNTIME_PACKAGED: "1" } as NodeJS.ProcessEnv,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x39),
      randomUUID: () => "login-session-development-response",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const callback = await fetch(
      `${authorizeUrl.searchParams.get("redirect_uri")}?code=development-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state")!)}`,
    );

    expect(callback.status).toBe(502);
    await expect(service.pollLogin(start.sessionId)).resolves.toMatchObject({
      status: "error",
      authStatus: { signedIn: false },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("pins loopback OAuth context across callback exchange, refresh, and token creation", async () => {
    const store = new MemoryCredentialStore();
    const configA = { issuer: "https://clerk-a.example.test/", clientId: " client-a " };
    const configB = { issuer: "https://clerk-b.example.test", clientId: "client-b" };
    let activeConfig = configA;
    const getOAuthConfig = vi.fn(() => activeConfig);
    const initialAccessToken = jwt({ sub: "config-a-user", version: 1 });
    const refreshedAccessToken = jwt({ sub: "config-a-user", version: 2 });
    const tokenRequests: Array<{ url: string; body: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      tokenRequests.push({ url: input, body });
      if (body.grant_type === "authorization_code") {
        return jsonResponse({
          access_token: initialAccessToken,
          refresh_token: "config-a-refresh",
          expires_in: 60,
        });
      }
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: "config-a-refresh-rotated",
        expires_in: 3600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x3a),
      randomUUID: () => "login-session-pinned-config",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    const state = authorizeUrl.searchParams.get("state")!;
    activeConfig = configB;

    const callback = await fetch(
      `${redirectUri}?code=config-a-code&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(200);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: initialAccessToken,
      refreshToken: "config-a-refresh",
      oauthConfig: {
        issuer: "https://clerk-a.example.test",
        clientId: "client-a",
      },
    });

    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    const durable = await service.createToken();
    const durablePayload = JSON.parse(Buffer.from(
      durable.token.slice("ade_account_v1.".length),
      "base64url",
    ).toString("utf8"));

    expect(tokenRequests).toEqual([
      {
        url: "https://clerk-a.example.test/oauth/token",
        body: {
          grant_type: "authorization_code",
          code: "config-a-code",
          code_verifier: Buffer.alloc(32, 0x3a).toString("base64url"),
          client_id: "client-a",
          redirect_uri: redirectUri,
        },
      },
      {
        url: "https://clerk-a.example.test/oauth/token",
        body: {
          grant_type: "refresh_token",
          refresh_token: "config-a-refresh",
          client_id: "client-a",
        },
      },
    ]);
    expect(durablePayload).toEqual({
      version: 1,
      refreshToken: "config-a-refresh-rotated",
      issuer: "https://clerk-a.example.test",
      clientId: "client-a",
    });
    expect(getOAuthConfig).toHaveBeenCalledTimes(1);
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
      sessionState: "signed_out",
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
        sessionState: "active",
      },
    });
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken,
      refreshToken: "device-refresh-token",
      authSource: "device",
    });
  });

  /**
   * The directory can only bind a pairing grant to a machine it was told about
   * before the human authenticated, and the machine can only spend it once. Both
   * halves live here, because both are what stop a removed machine from
   * obtaining or re-using proof it did not earn.
   */
  describe("pairing grants", () => {
    function deviceLoginService(args: {
      store: MemoryCredentialStore;
      nowMs: () => number;
      getMachineKey?: () => string | null;
      grant?: string | null;
      onDeviceCodeBody?: (body: Record<string, unknown>) => void;
    }) {
      const accessToken = jwt({ sub: "device-user", email: "device@example.com" });
      const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
        if (input.endsWith("/device/code")) {
          args.onDeviceCodeBody?.(JSON.parse(String(init?.body)));
          return jsonResponse({
            device_code: "grant-device-code",
            user_code: "GRNT-CODE",
            verification_uri: "https://directory.example.test/device",
            expires_in: 600,
            interval: 5,
          });
        }
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "device-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          ...(args.grant === undefined ? {} : { pairing_grant: args.grant }),
        });
      });
      const service = createAccountAuthService({
        credentialStore: args.store,
        getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
        getDeviceBridgeUrl: () => "https://directory.example.test/",
        getMachineKey: args.getMachineKey,
        now: args.nowMs,
        randomBytes: (size) => Buffer.alloc(size, 0x77),
        randomUUID: () => "device-session",
        fetchImpl,
      });
      activeServices.push(service);
      return service;
    }

    it("declares the machine key so the grant can be bound to this machine", async () => {
      let deviceCodeBody: Record<string, unknown> | null = null;
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
        getMachineKey: () => "machine-a",
        onDeviceCodeBody: (body) => {
          deviceCodeBody = body;
        },
      });

      await service.startDeviceLogin();

      expect(deviceCodeBody).toEqual({
        device_secret: Buffer.alloc(32, 0x77).toString("base64url"),
        machine_key: "machine-a",
      });
    });

    it("omits the machine key rather than failing when the identity is unreadable", async () => {
      let deviceCodeBody: Record<string, unknown> | null = null;
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
        getMachineKey: () => {
          throw new Error("sync-cloud-relay.json is unreadable");
        },
        onDeviceCodeBody: (body) => {
          deviceCodeBody = body;
        },
      });

      // The sign-in is the product; the grant is a recovery aid for one flow.
      await expect(service.startDeviceLogin()).resolves.toMatchObject({ userCode: "GRNT-CODE" });
      expect(deviceCodeBody).toEqual({
        device_secret: Buffer.alloc(32, 0x77).toString("base64url"),
      });
    });

    it("hands the grant to exactly one caller and never to a second", async () => {
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
        getMachineKey: () => "machine-a",
        grant: "grant-from-directory",
      });

      expect(service.consumePairingGrant()).toBeNull();
      await service.startDeviceLogin();
      await expect(service.pollDeviceLogin("device-session")).resolves.toMatchObject({
        status: "signed_in",
      });

      expect(service.consumePairingGrant()).toBe("grant-from-directory");
      // A grant is spendable once server-side, so a local second copy is only
      // ever a stale secret waiting to be sent on a request that will be refused.
      expect(service.consumePairingGrant()).toBeNull();
    });

    it("withholds a grant that has outlived the directory's window", async () => {
      let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => nowMs,
        getMachineKey: () => "machine-a",
        grant: "grant-from-directory",
      });

      await service.startDeviceLogin();
      await service.pollDeviceLogin("device-session");
      nowMs += 11 * 60_000;

      expect(service.consumePairingGrant()).toBeNull();
    });

    it("drops the grant on sign-out", async () => {
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
        getMachineKey: () => "machine-a",
        grant: "grant-from-directory",
      });

      await service.startDeviceLogin();
      await service.pollDeviceLogin("device-session");
      service.signOut();

      expect(service.consumePairingGrant()).toBeNull();
    });

    it("holds no grant when the directory minted none", async () => {
      const service = deviceLoginService({
        store: new MemoryCredentialStore(),
        nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
        getMachineKey: () => "machine-a",
      });

      await service.startDeviceLogin();
      await expect(service.pollDeviceLogin("device-session")).resolves.toMatchObject({
        status: "signed_in",
      });

      expect(service.consumePairingGrant()).toBeNull();
    });
  });

  it("coalesces concurrent polls so a one-time device code is redeemed once", async () => {
    const store = new MemoryCredentialStore();
    const accessToken = jwt({ sub: "coalesced-device-user", email: "coalesced@example.com" });
    let tokenRequests = 0;
    let resolveTokenResponse: ((response: Response) => void) | null = null;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveTokenResponse = resolve;
    });
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/device/code")) {
        return jsonResponse({
          device_code: "one-time-device-code",
          user_code: "ONCE-ONLY",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        });
      }
      tokenRequests += 1;
      if (tokenRequests === 1) return tokenResponse;
      return jsonResponse({
        error: "invalid_grant",
        error_description: "Device code was already redeemed.",
      }, 400);
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "coalesced-device-session",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    const firstPoll = service.pollDeviceLogin(start.sessionId);
    const secondPoll = service.pollDeviceLogin(start.sessionId);
    expect(tokenRequests).toBe(1);

    resolveTokenResponse!(jsonResponse({
      access_token: accessToken,
      refresh_token: "coalesced-refresh-token",
      expires_in: 3600,
    }));
    const results = await Promise.all([firstPoll, secondPoll]);

    expect(results).toEqual([
      expect.objectContaining({
        status: "signed_in",
        authStatus: expect.objectContaining({ userId: "coalesced-device-user" }),
      }),
      expect.objectContaining({
        status: "signed_in",
        authStatus: expect.objectContaining({ userId: "coalesced-device-user" }),
      }),
    ]);
    expect(tokenRequests).toBe(1);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken,
      refreshToken: "coalesced-refresh-token",
      authSource: "device",
    });
  });

  it("shares cancellation across coalesced device polls and rejects a late token", async () => {
    const store = new MemoryCredentialStore();
    let resolveTokenResponse: ((response: Response) => void) | null = null;
    const tokenResponse = new Promise<Response>((resolve) => {
      resolveTokenResponse = resolve;
    });
    let tokenRequests = 0;
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/device/code")) {
        return jsonResponse({
          device_code: "cancelled-device-code",
          user_code: "CANC-ELLD",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        });
      }
      tokenRequests += 1;
      return tokenResponse;
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "cancelled-coalesced-session",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    const firstPoll = service.pollDeviceLogin(start.sessionId);
    const secondPoll = service.pollDeviceLogin(start.sessionId);
    service.cancelLogin(start.sessionId);
    resolveTokenResponse!(jsonResponse({
      access_token: jwt({ sub: "late-device-user" }),
      refresh_token: "late-refresh-token",
      expires_in: 3600,
    }));

    await expect(Promise.all([firstPoll, secondPoll])).resolves.toEqual([
      expect.objectContaining({ status: "error", message: expect.stringContaining("cancelled") }),
      expect.objectContaining({ status: "error", message: expect.stringContaining("cancelled") }),
    ]);
    expect(tokenRequests).toBe(1);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
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

  it("persists bridge OAuth context for directory-only refresh and durable token creation", async () => {
    const store = new MemoryCredentialStore();
    let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const initialAccessToken = jwt({ sub: "directory-only-user" });
    const refreshedAccessToken = jwt({ sub: "directory-only-user", version: 2 });
    const localConfig = vi.fn(() => {
      throw new Error("local Clerk config must not be read");
    });
    const deviceFetch = vi.fn(async (input: string): Promise<Response> => input.endsWith("/device/code")
      ? jsonResponse({
          device_code: "directory-only-code",
          user_code: "DIRY-ONLY",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        })
      : jsonResponse({
          access_token: initialAccessToken,
          refresh_token: "directory-refresh-initial",
          expires_in: 60,
          oauth_issuer: "https://public-clerk.example.test/",
          oauth_client_id: "directory-public-client",
        }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: localConfig,
      getDeviceBridgeUrl: () => "https://directory.example.test",
      now: () => nowMs,
      randomUUID: () => "directory-only-session",
      fetchImpl: deviceFetch,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "signed_in",
      authStatus: { userId: "directory-only-user", source: "device" },
    });
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      refreshToken: "directory-refresh-initial",
      oauthConfig: {
        issuer: "https://public-clerk.example.test",
        clientId: "directory-public-client",
      },
    });

    nowMs += 61_000;
    const refreshFetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
      expect(input).toBe("https://public-clerk.example.test/oauth/token");
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "directory-refresh-initial",
        client_id: "directory-public-client",
      });
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: "directory-refresh-rotated",
        expires_in: 3600,
      });
    });
    const restartedService = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: localConfig,
      now: () => nowMs,
      fetchImpl: refreshFetch,
    });
    activeServices.push(restartedService);

    await expect(restartedService.getAccessToken()).resolves.toBe(refreshedAccessToken);
    const durable = await restartedService.createToken();
    const durablePayload = JSON.parse(Buffer.from(
      durable.token.slice("ade_account_v1.".length),
      "base64url",
    ).toString("utf8"));
    expect(durablePayload).toEqual({
      version: 1,
      refreshToken: "directory-refresh-rotated",
      issuer: "https://public-clerk.example.test",
      clientId: "directory-public-client",
    });
    expect(localConfig).not.toHaveBeenCalled();
    expect(refreshFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed OAuth context in a successful bridge token response", async () => {
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => input.endsWith("/device/code")
      ? jsonResponse({
          device_code: "malformed-context-code",
          user_code: "BADF-IELD",
          verification_uri: "https://directory.example.test/device",
          expires_in: 600,
          interval: 5,
        })
      : jsonResponse({
          access_token: jwt({ sub: "untrusted-context-user" }),
          refresh_token: "untrusted-context-refresh",
          expires_in: 3600,
          oauth_issuer: "http://attacker.example.test",
          oauth_client_id: "attacker-client",
        }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://local.example.test", clientId: "local-client" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      randomUUID: () => "malformed-context-session",
      fetchImpl,
    });
    activeServices.push(service);

    const start = await service.startDeviceLogin();
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "error",
      message: "ADE account device token response included invalid OAuth context.",
      authStatus: { signedIn: false },
    });
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
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
      sessionState: "active",
    });
    await expect(service.getAccessToken()).resolves.toBe(accessToken);
    await expect(service.startLogin()).rejects.toThrow(/no interactive sign-in is required/);
    await expect(service.startDeviceLogin()).rejects.toThrow(/no interactive sign-in is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it.each([
    {
      name: "development-issued access token",
      credential: jwt({
        iss: DEVELOPMENT_ADE_CLERK_ISSUER,
        sub: "env-dev-user",
        exp: Date.parse("2026-07-14T13:00:00.000Z") / 1000,
      }),
    },
    {
      name: "self-contained development refresh context",
      credential: `ade_account_v1.${Buffer.from(JSON.stringify({
        version: 1,
        refreshToken: "development-refresh-token",
        issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
        clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      }), "utf8").toString("base64url")}`,
    },
  ])("treats a packaged ADE_ACCOUNT_TOKEN with $name as absent across auth flows", async ({ credential }) => {
    const store = new MemoryCredentialStore();
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      expect(input).toBe(`${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/device/code`);
      return jsonResponse({
        device_code: `device-code-${fetchImpl.mock.calls.length}`,
        user_code: "PROD-1234",
        verification_uri: `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/device`,
        expires_in: 600,
        interval: 5,
      });
    });
    const randomUUID = vi.fn()
      .mockReturnValueOnce("packaged-loopback-session")
      .mockReturnValueOnce("packaged-device-session")
      .mockReturnValueOnce("packaged-headless-device-session");
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: {
        ADE_RUNTIME_PACKAGED: "1",
        ADE_ACCOUNT_TOKEN: credential,
      } as NodeJS.ProcessEnv,
      getDeviceBridgeUrl: () => DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      randomUUID,
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({
      signedIn: false,
      userId: null,
      source: null,
    });
    await expect(service.getAccessToken()).rejects.toThrow(/not signed in/i);

    const loopback = await service.startLogin();
    expect(new URL(loopback.authorizeUrl).origin).toBe(DEFAULT_ADE_CLERK_ISSUER);
    await expect(service.startDeviceLogin()).resolves.toMatchObject({
      sessionId: "packaged-device-session",
      verificationUri: `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/device`,
    });
    await expect(service.startDeviceLogin({ ignoreEnvCredential: true })).resolves.toMatchObject({
      sessionId: "packaged-headless-device-session",
      verificationUri: `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/device`,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("lets a stored production session win over a rejected packaged env credential", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const productionSession = storedSession({
      accessToken: jwt({
        iss: DEFAULT_ADE_CLERK_ISSUER,
        sub: "production-user",
        exp: nowMs / 1000 + 3_600,
      }),
      refreshToken: "production-refresh-token",
      userId: "production-user",
      oauthConfig: {
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      },
    });
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(productionSession));
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: DEFAULT_ADE_CLERK_ISSUER,
        clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      }),
      env: {
        ADE_RUNTIME_PACKAGED: "1",
        ADE_ACCOUNT_TOKEN: jwt({
          iss: DEVELOPMENT_ADE_CLERK_ISSUER,
          sub: "development-user",
          exp: nowMs / 1000 + 3_600,
        }),
      } as NodeJS.ProcessEnv,
      now: () => nowMs,
      fetchImpl,
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: "production-user",
      source: "loopback",
    });
    await expect(service.getAccessToken()).resolves.toBe(productionSession.accessToken);
    await expect(service.createToken()).resolves.toMatchObject({
      token: expect.stringMatching(/^ade_account_v1\./),
      source: "refresh_token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);

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
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
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
  // Regression (2026-08-05 "randomly signed out"): a definitive invalid_grant
  // used to DELETE the shared credential, so one process losing a rotating
  // grant signed the desktop, the brain and the CLI out at once and took the
  // host's relay tunnel and directory row with it. The record must survive,
  // marked needs-re-auth, and report `expired`.
  it("marks the exact rejected session dead in place after a definitive invalid_grant instead of deleting it", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl: vi.fn(async () => jsonResponse({
        error: "invalid_grant",
        error_description: "refresh token was already consumed",
      }, 400)),
      refreshRotationWaitMs: 0,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).rejects.toThrow(/already consumed/i);
    const stored = store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({
      userId: "user_old",
      refreshToken: "refresh-old",
      needsReauth: true,
      rejectedAt: "2026-07-14T12:00:00.000Z",
      rejectedReason: "invalid_grant",
    });
    expect(service.getStatus()).toMatchObject({
      signedIn: false,
      userId: null,
      source: null,
      sessionState: "expired",
    });
    expect(service.getSessionState?.()).toBe("expired");
    // The dead grant is never served again, and the words say "expired", not
    // "never signed in".
    await expect(service.getAccessToken()).rejects.toThrow(/session expired/i);
    // The rotation journal is settled, not left behind to soften the next one.
    expect(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY)).toBeNull();
  });

  it("lets a later successful sign-in overwrite a session marked needs-re-auth", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
      rejectedAt: "2026-07-14T11:59:00.000Z",
      needsReauth: true,
    })));
    const accessToken = jwt({
      sub: "device-user",
      email: "device@example.com",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      getDeviceBridgeUrl: () => "https://directory.example.test",
      fetchImpl: vi.fn(async (input: string) => (
        input.endsWith("/device/code")
          ? jsonResponse({
            device_code: "device-code",
            user_code: "USER-CODE",
            verification_uri: "https://directory.example.test/device",
            expires_in: 600,
          })
          : jsonResponse({ access_token: accessToken, refresh_token: "fresh", expires_in: 3_600 })
      )),
      now: () => nowMs,
    });
    activeServices.push(service);

    expect(service.getStatus()).toMatchObject({ signedIn: false, sessionState: "expired" });
    const start = await service.startDeviceLogin();
    await expect(service.pollDeviceLogin(start.sessionId)).resolves.toMatchObject({
      status: "signed_in",
    });
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: "device-user",
      sessionState: "active",
    });
    const stored = JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!);
    expect(stored.needsReauth).toBeUndefined();
    expect(stored.rejectedAt).toBeUndefined();
  });

  // Regression: a crash between the provider consuming the old refresh token
  // and the replacement being persisted burns the token family with nothing on
  // disk to say so. The journal left behind by the interrupted run makes the
  // next invalid_grant non-definitive, so it must NOT condemn the session.
  it("does not mark the session dead on the first invalid_grant after an interrupted rotation journal", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    const session = storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    });
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(session));
    // A previous process died mid-rotation against exactly this grant.
    store.setSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY, JSON.stringify({
      version: 1,
      oldRefreshTokenHash: accountTokenGeneration("refresh-old"),
      startedAt: "2026-07-14T11:59:59.000Z",
      pid: 4242,
      source: "desktop",
      userId: "user_old",
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: "invalid_grant",
      error_description: "refresh token was already consumed",
    }, 400));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      refreshRotationWaitMs: 0,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).rejects.toThrow(/already consumed/i);
    const afterFirst = JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!);
    expect(afterFirst.needsReauth).toBeUndefined();
    expect(afterFirst.rejectedAt).toBeUndefined();
    expect(afterFirst.refreshToken).toBe("refresh-old");
    // The account is still the machine's account: nothing was signed out.
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: "user_old",
      sessionState: "active",
    });
    // The ambiguity is spent: the journal is cleared so a genuinely dead grant
    // still reaches needs-re-auth on the next attempt.
    expect(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY)).toBeNull();

    await expect(service.getAccessToken()).rejects.toThrow(/already consumed/i);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      needsReauth: true,
      rejectedReason: "invalid_grant",
    });
  });

  it("journals the rotation before the exchange and clears it once the new pair is durable", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const journalDuringExchange: Array<string | null> = [];
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl: vi.fn(async (input: string) => {
        if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
        journalDuringExchange.push(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY));
        return jsonResponse({
          access_token: refreshedAccessToken,
          refresh_token: "refresh-rotated",
          expires_in: 3_600,
        });
      }),
      now: () => nowMs,
      pid: 777,
      sessionMutationSource: "brain",
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    // The intent was durable BEFORE the provider could consume the old token.
    expect(JSON.parse(journalDuringExchange[0]!)).toMatchObject({
      version: 1,
      oldRefreshTokenHash: accountTokenGeneration("refresh-old"),
      pid: 777,
      source: "brain",
      userId: "user_old",
    });
    // And it is gone once the replacement is durable.
    expect(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY)).toBeNull();
  });

  it("clears the journal on a store without atomic writes, whoever won the rotation", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const peerAccessToken = jwt({ sub: "user_old", exp: Math.floor((nowMs + 3_600_000) / 1000) });
    const peerSession = storedSession({
      accessToken: peerAccessToken,
      refreshToken: "refresh-peer",
    });
    const store = new MemoryCredentialStore();
    // No compare-and-swap: this is the fallback persist path.
    (store as { updateSync?: unknown }).updateSync = undefined;
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl: vi.fn(async (input: string) => {
        if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
        // A peer lands its own rotation while ours is in flight.
        store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(peerSession));
        return jsonResponse({
          access_token: jwt({ sub: "user_old", exp: Math.floor((nowMs + 3_600_000) / 1000) }),
          refresh_token: "refresh-rotated",
          expires_in: 3_600,
        });
      }),
      now: () => nowMs,
      pid: 778,
      sessionMutationSource: "brain",
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(peerAccessToken);
    // Our exchange is over either way — a journal left behind would make the
    // next refresh wait on a rotation nobody is running.
    expect(store.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY)).toBeNull();
  });

  it("waits at least the credential-store lock timeout for a peer rotation by default", () => {
    // A wait shorter than the store's lock timeout lets an impatient loser
    // condemn a winner that is still queued behind the file lock.
    expect(DEFAULT_REFRESH_ROTATION_WAIT_MS).toBeGreaterThan(CREDENTIAL_STORE_LOCK_TIMEOUT_MS);
  });

  it("emits an attributed account.session_mutation event for every stored-session mutation", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    let rejectRefresh = false;
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl: vi.fn(async (input: string) => {
        if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
        return rejectRefresh
          ? jsonResponse({ error: "invalid_grant" }, 400)
          : jsonResponse({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-rotated",
            expires_in: 3_600,
          });
      }),
      refreshRotationWaitMs: 0,
      now: () => nowMs,
      pid: 4242,
      sessionMutationSource: "cli",
      logger,
    });
    activeServices.push(service);

    const mutations = (): Array<Record<string, unknown>> => [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
    ]
      .filter(([event]) => event === "account.session_mutation")
      .map(([, meta]) => meta as Record<string, unknown>);
    const actionsSoFar = (): string[] => mutations().map((meta) => String(meta.action));

    await service.getAccessToken();
    expect(actionsSoFar()).toEqual(expect.arrayContaining([
      "rotation_journal_begin",
      "rotate",
      "rotation_journal_clear",
    ]));
    // Every line is attributed and carries a non-reversible token generation.
    for (const meta of mutations()) {
      expect(meta).toMatchObject({ pid: 4242, source: "cli" });
      expect(typeof meta.reason).toBe("string");
    }
    expect(mutations().find((meta) => meta.action === "rotate")).toMatchObject({
      tokenGeneration: accountTokenGeneration("refresh-rotated"),
      outcome: "persisted",
    });

    rejectRefresh = true;
    await expect(service.getAccessToken({ forceRefresh: true })).rejects.toThrow();
    const markDead = logger.warn.mock.calls
      .filter(([event]) => event === "account.session_mutation")
      .map(([, meta]) => meta as Record<string, unknown>)
      .find((meta) => meta.action === "mark_dead");
    expect(markDead).toMatchObject({
      reason: "refresh_grant_rejected",
      oauthErrorCode: "invalid_grant",
      pid: 4242,
      source: "cli",
      outcome: "marked_needs_reauth",
    });

    service.signOut();
    expect(actionsSoFar()).toContain("sign_out");
  });

  it("polls for a delayed cross-process refresh rotation before invalidating", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const finalAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const refreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
      const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshTokens.push(refreshToken);
      if (refreshToken === "refresh-old") {
        setTimeout(() => {
          store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
            accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs + 60_000) / 1000) }),
            refreshToken: "refresh-rotated-by-desktop",
            obtainedAt: "2026-07-14T12:00:00.010Z",
          })));
        }, 10);
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({
        access_token: finalAccessToken,
        refresh_token: "refresh-final",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      refreshRotationWaitMs: 100,
      refreshRotationPollMs: 5,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(finalAccessToken);
    expect(refreshTokens).toEqual(["refresh-old", "refresh-rotated-by-desktop"]);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      refreshToken: "refresh-final",
      userId: "user_old",
    });
  });

  it("aborts a refresh while waiting for cross-process token rotation", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: "invalid_grant",
      error_description: "refresh token was already consumed",
    }, 400));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      refreshRotationWaitMs: 6_000,
      refreshRotationPollMs: 1_000,
      now: () => nowMs,
    });
    activeServices.push(service);
    const controller = new AbortController();

    const token = service.getAccessToken({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    controller.abort(new DOMException("publisher stopped", "AbortError"));

    await expect(token).rejects.toMatchObject({
      name: "AbortError",
      message: "publisher stopped",
    });
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).not.toBeNull();
  });

  it("keeps the shared grant while a default-window peer refresh is still being persisted", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const finalAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const refreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
      const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshTokens.push(refreshToken);
      if (refreshToken === "refresh-old") {
        setTimeout(() => {
          store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
            accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs + 60_000) / 1000) }),
            refreshToken: "refresh-delayed-peer",
            obtainedAt: "2026-07-14T12:00:01.500Z",
          })));
        }, 1_500);
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({
        access_token: finalAccessToken,
        refresh_token: "refresh-final",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    const accessToken = service.getAccessToken();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(accessToken).resolves.toBe(finalAccessToken);
    expect(refreshTokens).toEqual(["refresh-old", "refresh-delayed-peer"]);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      refreshToken: "refresh-final",
      userId: "user_old",
    });
  });

  it("does not delete a peer replacement that lands during invalid_grant compare-delete", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const replacementAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const replacement = storedSession({
      accessToken: replacementAccessToken,
      refreshToken: "peer-replacement-refresh",
      expiresAt: "2026-07-14T13:00:00.000Z",
      obtainedAt: "2026-07-14T12:00:00.001Z",
    });
    class CompareDeleteRaceStore extends MemoryCredentialStore {
      replacementPending = true;

      override updateSync(updater: (values: Record<string, string>) => boolean | void): void {
        if (this.replacementPending) {
          this.replacementPending = false;
          this.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(replacement));
        }
        super.updateSync(updater);
      }
    }
    const store = new CompareDeleteRaceStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
    })));
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      refreshRotationWaitMs: 0,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(replacementAccessToken);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toEqual(replacement);
  });

  it("persists a rotated token pair before userinfo enrichment completes", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    let resolveUserinfo: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) {
        return await new Promise<Response>((resolve) => {
          resolveUserinfo = resolve;
        });
      }
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: "refresh-rotated",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    const refreshing = service.getAccessToken({ forceRefresh: true });
    await vi.waitFor(() => expect(resolveUserinfo).not.toBeNull());
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: refreshedAccessToken,
      refreshToken: "refresh-rotated",
      userId: "user_old",
      name: "Old User",
    });

    resolveUserinfo!(jsonResponse({ picture: "https://images.example/new.png" }));
    await expect(refreshing).resolves.toBe(refreshedAccessToken);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      imageUrl: "https://images.example/new.png",
      userId: "user_old",
    });
  });

  it("force-refreshes a still-current persisted access token", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const currentAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 7_200_000) / 1000),
    });
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: currentAccessToken,
      expiresAt: "2026-07-14T13:00:00.000Z",
    })));
    const fetchImpl = vi.fn(async (input: string): Promise<Response> =>
      input.endsWith("/oauth/userinfo")
        ? jsonResponse({})
        : jsonResponse({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-forced",
            expires_in: 7_200,
          }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(currentAccessToken);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.getAccessToken({ forceRefresh: true })).resolves.toBe(refreshedAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts a peer refresh winner without force-rotating its replacement again", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs + 3_600_000) / 1000) }),
    })));
    const peerAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 7_200_000) / 1000),
    });
    const peerSession = storedSession({
      accessToken: peerAccessToken,
      refreshToken: "refresh-rotated-by-peer",
      expiresAt: "2026-07-14T14:00:00.000Z",
      obtainedAt: "2026-07-14T12:00:00.100Z",
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(peerSession));
      return jsonResponse({
        access_token: jwt({ sub: "user_old", exp: Math.floor((nowMs + 3_600_000) / 1000) }),
        refresh_token: "refresh-from-losing-request",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken({ forceRefresh: true })).resolves.toBe(peerAccessToken);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toEqual(peerSession);
  });

  it.each([
    {
      name: "missing subject",
      session: storedSession({ accessToken: "opaque-access-token", userId: null }),
    },
    {
      name: "mismatched access-token subject",
      session: storedSession({
        accessToken: jwt({ sub: "different-user" }),
        userId: "user_old",
      }),
    },
  ])("never reports a persisted token with $name as signed in", ({ session }) => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(session));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl: vi.fn(),
    });
    activeServices.push(service);

    const status = service.getStatus();
    expect(status.signedIn).toBe(false);
    expect(status.userId).toBeNull();
    expect(status.source).toBeNull();
  });

  it("prefers the access-token JWT expiry over a later stored session expiry", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const staleAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs - 60_000) / 1000),
    });
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: staleAccessToken,
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const fetchImpl = vi.fn(async (input: string): Promise<Response> =>
      input.endsWith("/oauth/userinfo")
        ? jsonResponse({})
        : jsonResponse({
            access_token: refreshedAccessToken,
            refresh_token: "refresh-new",
            expires_in: 86_400,
          }));
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    expect(service.getStatus().expiresAt).toBe("2026-07-14T11:59:00.000Z");
    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: refreshedAccessToken,
      refreshToken: "refresh-new",
      expiresAt: "2026-07-14T13:00:00.000Z",
    });
  });

  it("never returns an expired JWT whose stored expiry is still in the future", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const staleAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs - 60_000) / 1000),
    });
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: staleAccessToken,
      refreshToken: null,
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const fetchImpl = vi.fn();
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    expect(service.getStatus().expiresAt).toBe("2026-07-14T11:59:00.000Z");
    await expect(service.getAccessToken()).rejects.toThrow(/account session expired/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes inside the two-minute skew and retains identity plus a non-rotated refresh token", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const refreshedAccessToken = jwt({ sub: "user_old", email: "old@example.com" });
    const fetchImpl = vi.fn(async (input: string, _init?: RequestInit): Promise<Response> =>
      input.endsWith("/oauth/userinfo")
        ? jsonResponse({ picture: "https://images.example/refreshed.png" })
        : jsonResponse({
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      imageUrl: "https://images.example/refreshed.png",
      expiresAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("re-reads a refresh token rotated by another process and retries once", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const refreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) return jsonResponse({});
      const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshTokens.push(refreshToken);
      if (refreshToken === "refresh-old") {
        store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
          accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs + 1_800_000) / 1000) }),
          refreshToken: "refresh-rotated-by-desktop",
          expiresAt: "2026-07-15T12:00:00.000Z",
        })));
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: "refresh-final",
        expires_in: 86_400,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    expect(refreshTokens).toEqual(["refresh-old", "refresh-rotated-by-desktop"]);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      accessToken: refreshedAccessToken,
      refreshToken: "refresh-final",
      expiresAt: "2026-07-14T13:00:00.000Z",
    });
  });

  it("does not retry non-invalid_grant failures with a concurrently changed token", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
      accessToken: jwt({ sub: "user_old", exp: Math.floor((nowMs - 60_000) / 1000) }),
      expiresAt: "2026-07-15T12:00:00.000Z",
    })));
    const refreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshTokens.push(refreshToken);
      store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession({
        refreshToken: "refresh-rotated-by-desktop",
      })));
      return jsonResponse({
        error: "server_error",
        error_description: "temporarily unavailable",
      }, 503);
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).rejects.toThrow("temporarily unavailable");
    expect(refreshTokens).toEqual(["refresh-old"]);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toMatchObject({
      refreshToken: "refresh-rotated-by-desktop",
    });
  });

  it("preserves a newer session written by another process while refresh succeeds", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const refreshedAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 3_600_000) / 1000),
    });
    const desktopAccessToken = jwt({
      sub: "user_old",
      exp: Math.floor((nowMs + 7_200_000) / 1000),
    });
    const desktopSession = storedSession({
      accessToken: desktopAccessToken,
      refreshToken: "refresh-rotated-by-desktop",
      expiresAt: "2026-07-14T14:00:00.000Z",
      obtainedAt: "2026-07-14T12:00:30.000Z",
    });
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) {
        store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(desktopSession));
        return jsonResponse({});
      }
      return jsonResponse({
        access_token: refreshedAccessToken,
        refresh_token: "refresh-from-stale-request",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => nowMs,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(desktopAccessToken);
    expect(JSON.parse(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)!)).toEqual(desktopSession);
  });

  it("does not resurrect a session signed out by another process during refresh", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const fetchImpl = vi.fn(async (input: string): Promise<Response> => {
      if (input.endsWith("/oauth/userinfo")) {
        store.deleteSync(ACCOUNT_SESSION_CREDENTIAL_KEY);
        return jsonResponse({});
      }
      return jsonResponse({
        access_token: jwt({ sub: "user_old" }),
        refresh_token: "refresh-from-stale-request",
        expires_in: 3_600,
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({ issuer: "https://clerk.example.test", clientId: "client-public" }),
      fetchImpl,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).rejects.toThrow("ADE is not signed in");
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("bounds userinfo enrichment and keeps token refresh best-effort", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    const refreshedAccessToken = jwt({ sub: "user_old" });
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (!input.endsWith("/oauth/userinfo")) {
        return jsonResponse({ access_token: refreshedAccessToken, expires_in: 3_600 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const service = createAccountAuthService({
      credentialStore: store,
      getOAuthConfig: () => ({
        issuer: "https://clerk.example.test",
        clientId: "client-public",
      }),
      fetchImpl,
      now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      userinfoRequestTimeoutMs: 5,
    });
    activeServices.push(service);

    await expect(service.getAccessToken()).resolves.toBe(refreshedAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toMatchObject({
      signedIn: true,
      userId: "user_old",
      email: "old@example.com",
      name: "Old User",
    });
  });

  it("uses authEpoch so sign-out cannot be overwritten by an in-flight refresh", async () => {
    const store = new MemoryCredentialStore();
    store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify(storedSession()));
    let resolveRefresh: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn((input: string) => input.endsWith("/oauth/userinfo")
      ? Promise.resolve(jsonResponse({}))
      : new Promise<Response>((resolve) => {
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
      sessionState: "signed_out",
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
