import { describe, expect, it, vi } from "vitest";
import { BrowserAccountClient } from "./client";

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

function accessToken(): string {
  const claims = Buffer.from(JSON.stringify({
    sub: "user_1",
    email: "user@example.test",
  })).toString("base64url");
  return `header.${claims}.signature`;
}

describe("BrowserAccountClient", () => {
  it("keeps tokens in memory, scrubs the callback, and surfaces directory auth expiry", async () => {
    const storage = new MemorySessionStorage();
    const assigned: string[] = [];
    const location = {
      origin: "https://app.ade.dev",
      pathname: "/work",
      search: "",
      assign: (url: string) => assigned.push(url),
    };
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
});
