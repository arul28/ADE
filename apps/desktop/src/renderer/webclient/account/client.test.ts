import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
} from "../../../shared/accountDirectory";
import { MemoryStorage } from "../sync/envStore";
import { BrowserAccountClient, readBrowserAccountConfig } from "./client";
import { BrowserAccountSessionStore } from "./sessionStore";

class MemorySessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function accessToken(
  subject = "user_1",
  extraClaims: Record<string, unknown> = { email: "user@example.test" },
): string {
  const claims = Buffer.from(JSON.stringify({
    sub: subject,
    ...extraClaims,
  })).toString("base64url");
  return `header.${claims}.signature`;
}

function browserLocation(assigned: string[]) {
  return {
    origin: "https://app.ade.dev",
    pathname: "/work",
    search: "",
    assign: (url: string) => assigned.push(url),
  };
}

async function completeSignIn(
  client: BrowserAccountClient,
  location: ReturnType<typeof browserLocation>,
  assigned: string[],
): Promise<void> {
  await client.startSignIn();
  const authorize = new URL(assigned[0]!);
  location.pathname = "/account/callback";
  location.search = `?code=oauth-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`;
  await client.bootstrap();
}

describe("BrowserAccountClient", () => {
  it("uses production defaults for a hosted build and development defaults locally", () => {
    expect(readBrowserAccountConfig({ DEV: false })).toMatchObject({
      issuer: DEFAULT_ADE_CLERK_ISSUER,
      clientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
      directoryBaseUrl: DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    });
    expect(readBrowserAccountConfig({ DEV: true })).toMatchObject({
      issuer: DEVELOPMENT_ADE_CLERK_ISSUER,
      clientId: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
      directoryBaseUrl: DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
    });
  });

  it("uses the hosted account directory when the web build has no override", () => {
    expect(readBrowserAccountConfig({
      VITE_ADE_CLERK_ISSUER: "https://clerk.example",
      VITE_ADE_CLERK_OAUTH_CLIENT_ID: "client_ade",
      VITE_ADE_ACCOUNT_DIRECTORY_URL: "   ",
    })).toMatchObject({
      directoryBaseUrl: DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    });
  });

  it("keeps tokens out of web storage and URLs, scrubs the callback, and surfaces directory auth expiry", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    const replaced: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const token = accessToken();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://clerk.example/oauth/token") {
        return new Response(JSON.stringify({
          access_token: token,
          refresh_token: "refresh-secret",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: (_data, _unused, url) => replaced.push(String(url)) },
      storage,
      sessionStore: new BrowserAccountSessionStore(new MemoryStorage()),
    });

    await client.startSignIn();
    const authorize = new URL(assigned[0]!);
    expect(authorize.origin + authorize.pathname).toBe("https://clerk.example/oauth/authorize");
    expect(authorize.search).not.toContain("access_token");
    expect(authorize.search).not.toContain("refresh-secret");
    expect([...storage.values.values()].join(" ")).not.toContain("secret");

    location.pathname = "/account/callback";
    location.search = `?code=oauth-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`;
    const snapshot = await client.bootstrap();

    expect(snapshot).toMatchObject({ state: "auth_expired", machines: [] });
    expect(replaced).toEqual(["/work"]);
    expect(storage.values.size).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "https://clerk.example/oauth/token",
      "https://clerk.example/oauth/userinfo",
      "https://directory.example/account/machines",
    ]);
    expect(requests.every((request) => !request.url.includes(token) && !request.url.includes("refresh-secret"))).toBe(true);
    expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("rejects non-HTTPS OAuth and directory configuration", () => {
    const client = new BrowserAccountClient({
      config: null,
    });
    expect(client.getSnapshot()).toMatchObject({
      state: "unconfigured",
      machines: [],
    });
  });

  it("decodes non-ASCII identity claims from JWT UTF-8 bytes", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    const token = accessToken("user_unicode", {
      email: "josé@example.test",
      name: "李 雷",
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://clerk.example/oauth/token") {
        return new Response(JSON.stringify({
          access_token: token,
          refresh_token: "refresh-secret",
          expires_in: 3600,
        }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        return new Response(null, { status: 503 });
      }
      return new Response(JSON.stringify({ machines: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage,
      sessionStore: new BrowserAccountSessionStore(new MemoryStorage()),
    });

    await completeSignIn(client, location, assigned);

    expect(client.getSnapshot()).toMatchObject({
      state: "signed_in",
      userId: "user_unicode",
      email: "josé@example.test",
      name: "李 雷",
    });
  });

  it("deduplicates concurrent refreshes and keeps transient failures retryable", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    let now = 0;
    let refreshAttempts = 0;
    let releaseRefresh: ((response: Response) => void) | null = null;
    const refreshResponse = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    const initialToken = accessToken("initial");
    const refreshedToken = accessToken("initial");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://directory.example/account/machines") {
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        return new Response(JSON.stringify({ email: "user@example.test" }), { status: 200 });
      }
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") === "authorization_code") {
        return new Response(JSON.stringify({
          access_token: initialToken,
          refresh_token: "refresh-secret",
          expires_in: 3600,
        }), { status: 200 });
      }
      refreshAttempts += 1;
      if (refreshAttempts === 1) return await refreshResponse;
      if (refreshAttempts === 2) throw new Error("temporary network failure");
      return new Response(JSON.stringify({
        access_token: refreshedToken,
        refresh_token: "rotated-refresh-secret",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage,
      sessionStore: new BrowserAccountSessionStore(new MemoryStorage()),
      now: () => now,
    });
    await completeSignIn(client, location, assigned);
    const initialLease = client.captureSessionLease();
    expect(initialLease).not.toBeNull();
    now = 3_500_000;

    const first = client.getAccessToken();
    const second = client.getAccessToken();
    expect(refreshAttempts).toBe(1);
    releaseRefresh!(new Response(JSON.stringify({
      access_token: refreshedToken,
      refresh_token: "rotated-refresh-secret",
      expires_in: 1,
    }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([refreshedToken, refreshedToken]);
    expect(refreshAttempts).toBe(1);
    expect(client.isSessionLeaseCurrent(initialLease!)).toBe(false);

    now += 1_000;
    await expect(client.getAccessToken()).rejects.toThrow("temporary network failure");
    expect(client.getSnapshot().state).toBe("signed_in");
    await expect(client.getAccessToken()).resolves.toBe(refreshedToken);
    expect(refreshAttempts).toBe(3);
  });

  it("keeps the prior in-memory session when the refreshed session write fails", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    const persistedStorage = new MemoryStorage();
    const sessionStore = new BrowserAccountSessionStore(persistedStorage);
    let now = 0;
    const initialToken = accessToken("user_atomic", {
      email: "before@example.test",
      name: "Before Write",
    });
    const refreshedToken = accessToken("user_atomic", {
      email: "after@example.test",
      name: "After Write",
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://directory.example/account/machines") {
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        return new Response(null, { status: 503 });
      }
      const grantType = new URLSearchParams(String(init?.body ?? "")).get("grant_type");
      return new Response(JSON.stringify({
        access_token: grantType === "refresh_token" ? refreshedToken : initialToken,
        refresh_token: grantType === "refresh_token" ? "refresh-rotated" : "refresh-original",
        expires_in: 3600,
      }), { status: 200 });
    }) as typeof fetch;
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage,
      sessionStore,
      now: () => now,
    });
    await completeSignIn(client, location, assigned);
    const priorSnapshot = client.getSnapshot();
    const priorLease = client.captureSessionLease();
    expect(priorLease).not.toBeNull();
    vi.spyOn(persistedStorage, "put").mockRejectedValueOnce(new Error("IndexedDB write failed."));
    now = 3_500_000;

    await expect(client.getAccessToken()).rejects.toThrow("IndexedDB write failed.");

    expect(client.getSnapshot()).toEqual(priorSnapshot);
    expect(client.isSessionLeaseCurrent(priorLease!)).toBe(true);
    await expect(sessionStore.load()).resolves.toMatchObject({
      refreshToken: "refresh-original",
      email: "before@example.test",
      name: "Before Write",
    });
  });

  it("expires the browser session only for a confirmed refresh rejection", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    let now = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://directory.example/account/machines") {
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        return new Response(JSON.stringify({ email: "user@example.test" }), { status: 200 });
      }
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("grant_type") === "authorization_code") {
        return new Response(JSON.stringify({
          access_token: accessToken(),
          refresh_token: "refresh-secret",
          expires_in: 3600,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;
    const persistedStorage = new MemoryStorage();
    const sessionStore = new BrowserAccountSessionStore(persistedStorage);
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage,
      sessionStore,
      now: () => now,
    });
    await completeSignIn(client, location, assigned);
    now = 3_500_000;

    await expect(client.getAccessToken()).rejects.toThrow("session expired");
    expect(client.getSnapshot()).toMatchObject({ state: "auth_expired", machines: [] });
    await expect(sessionStore.load()).resolves.toBeNull();
  });

  it("refreshes from the JWT exp claim before using a stale access token", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    const now = 1_800_000_000_000;
    const staleToken = accessToken("user_exp", {
      exp: Math.floor((now - 60_000) / 1000),
    });
    const freshToken = accessToken("user_exp", {
      exp: Math.floor((now + 3_600_000) / 1000),
    });
    const requestOrder: string[] = [];
    const userinfoTokens: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://clerk.example/oauth/token") {
        const grantType = new URLSearchParams(String(init?.body ?? "")).get("grant_type");
        requestOrder.push(`token:${grantType}`);
        return new Response(JSON.stringify({
          access_token: grantType === "refresh_token" ? freshToken : staleToken,
          refresh_token: "refresh-secret",
          // The JWT exp must win over this optimistic OAuth lifetime.
          expires_in: 86_400,
        }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        requestOrder.push("userinfo");
        userinfoTokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ email: "exp@example.test" }), { status: 200 });
      }
      requestOrder.push("directory");
      return new Response(JSON.stringify({ machines: [] }), { status: 200 });
    }) as typeof fetch;
    const client = new BrowserAccountClient({
      config: {
        issuer: "https://clerk.example",
        clientId: "client_ade",
        directoryBaseUrl: "https://directory.example",
        relayBaseUrls: ["wss://relay.example"],
      },
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage,
      sessionStore: new BrowserAccountSessionStore(new MemoryStorage()),
      now: () => now,
    });

    await completeSignIn(client, location, assigned);

    expect(requestOrder).toEqual([
      "token:authorization_code",
      "token:refresh_token",
      "userinfo",
      "directory",
    ]);
    expect(userinfoTokens).toEqual([`Bearer ${freshToken}`]);
    expect(client.getSnapshot()).toMatchObject({
      state: "signed_in",
      email: "exp@example.test",
    });
  });

  it("persists, restores, refreshes, and explicitly clears the browser session", async () => {
    const persistedStorage = new MemoryStorage();
    const sessionStore = new BrowserAccountSessionStore(persistedStorage);
    const pendingStorage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    const requestOrder: string[] = [];
    const initialToken = accessToken("user_3GYkProfileOnly", {});
    const restoredToken = accessToken("user_3GYkProfileOnly", {});
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://clerk.example/oauth/token") {
        const grantType = new URLSearchParams(String(init?.body ?? "")).get("grant_type");
        requestOrder.push(`token:${grantType}`);
        return new Response(JSON.stringify({
          access_token: grantType === "refresh_token" ? restoredToken : initialToken,
          refresh_token: grantType === "refresh_token" ? "refresh-rotated" : "refresh-original",
          expires_in: 3600,
        }), { status: 200 });
      }
      if (url === "https://clerk.example/oauth/userinfo") {
        requestOrder.push("userinfo");
        return new Response(JSON.stringify({
          sub: "user_3GYkProfileOnly",
          email: "profile@example.test",
          name: "Profile Owner",
          picture: "https://img.clerk.com/profile.png",
        }), { status: 200 });
      }
      requestOrder.push("directory");
      return new Response(JSON.stringify({ machines: [] }), { status: 200 });
    }) as typeof fetch;
    const config = {
      issuer: "https://clerk.example",
      clientId: "client_ade",
      directoryBaseUrl: "https://directory.example",
      relayBaseUrls: ["wss://relay.example"],
    };
    const firstClient = new BrowserAccountClient({
      config,
      fetchImpl,
      location,
      history: { replaceState: () => {} },
      storage: pendingStorage,
      sessionStore,
    });

    await completeSignIn(firstClient, location, assigned);
    await expect(sessionStore.load()).resolves.toMatchObject({
      refreshToken: "refresh-original",
      issuer: config.issuer,
      clientId: config.clientId,
      email: "profile@example.test",
      imageUrl: "https://img.clerk.com/profile.png",
    });

    requestOrder.length = 0;
    const restoredClient = new BrowserAccountClient({
      config,
      fetchImpl,
      location: browserLocation([]),
      history: { replaceState: () => {} },
      storage: new MemorySessionStorage(),
      sessionStore,
    });
    const restored = await restoredClient.bootstrap();

    expect(requestOrder).toEqual(["token:refresh_token", "userinfo", "directory"]);
    expect(restored).toMatchObject({
      state: "signed_in",
      userId: "user_3GYkProfileOnly",
      email: "profile@example.test",
      imageUrl: "https://img.clerk.com/profile.png",
    });
    await expect(sessionStore.load()).resolves.toMatchObject({ refreshToken: "refresh-rotated" });
    const hostedHeaders = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(hostedHeaders).toContain("img-src 'self' data: blob: https://img.clerk.com");

    vi.spyOn(sessionStore, "clear").mockRejectedValueOnce(new Error("IndexedDB unavailable."));
    await expect(restoredClient.signOut()).resolves.toMatchObject({
      state: "signed_out",
      userId: null,
    });
    expect(restoredClient.getSnapshot()).toMatchObject({ state: "signed_out", userId: null });

    await restoredClient.signOut();
    await expect(sessionStore.load()).resolves.toBeNull();
  });
});
