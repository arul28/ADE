import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
} from "../../../shared/accountDirectory";
import { BrowserAccountClient, readBrowserAccountConfig } from "./client";

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

function accessToken(subject = "user_1"): string {
  const claims = Buffer.from(JSON.stringify({
    sub: subject,
    email: "user@example.test",
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

  it("keeps tokens in memory, scrubs the callback, and surfaces directory auth expiry", async () => {
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
    const refreshedToken = accessToken("refreshed");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://directory.example/account/machines") {
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
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
      now: () => now,
    });
    await completeSignIn(client, location, assigned);
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

    now += 1_000;
    await expect(client.getAccessToken()).rejects.toThrow("temporary network failure");
    expect(client.getSnapshot().state).toBe("signed_in");
    await expect(client.getAccessToken()).resolves.toBe(refreshedToken);
    expect(refreshAttempts).toBe(3);
  });

  it("expires the browser session only for a confirmed refresh rejection", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = browserLocation(assigned);
    let now = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://directory.example/account/machines") {
        return new Response(JSON.stringify({ machines: [] }), { status: 200 });
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
      now: () => now,
    });
    await completeSignIn(client, location, assigned);
    now = 3_500_000;

    await expect(client.getAccessToken()).rejects.toThrow("session expired");
    expect(client.getSnapshot()).toMatchObject({ state: "auth_expired", machines: [] });
  });
});
