import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cursorStateDbPath,
  fetchFactorySessionCredits,
  openCodeAuthPaths,
  cursorSessionCookie,
  pollCopilotQuota,
  pollCursorQuota,
  pollGrokQuota,
  pollKimiQuota,
  pollOpenCodeQuota,
  readCopilotTokenFromHosts,
  readGrokBearer,
  readKimiAccessToken,
  readOpenCodeApiKey,
  readOpenCodeConsoleAccountFromDisk,
  resetQuotaIdentityCacheForTests,
} from "./extraProviderQuota";

const NOW = Date.parse("2026-09-21T16:00:00.000Z");

const kimiHomes: string[] = [];

/** A real `$KIMI_CODE_HOME`: the login resolver reads `config.toml` and the slot from disk. */
function kimiHome(files: Record<string, string>): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "ade-kimi-quota-"));
  kimiHomes.push(home);
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    writeFileSync(path.join(home, relative), text);
  }
  return home;
}

afterEach(() => {
  for (const home of kimiHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function jwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, ...extra })).toString("base64url");
  return `e30.${payload}.sig`;
}

describe("extra provider credential readers", () => {
  it("reads a Grok bearer and rejects management keys, cookies, and expired sessions", () => {
    const auth = {
      "https://auth.x.ai::super": {
        key: "good-token",
        email: "ada@example.com",
        expires_at: "2026-09-28T00:00:00.000Z",
      },
      "https://accounts.x.ai/sign-in": { key: "xai-management" },
    };
    expect(readGrokBearer(auth, NOW)).toEqual({ token: "good-token", email: "ada@example.com" });
    expect(readGrokBearer({
      key: "session=abc",
      expires_at: "2026-09-28T00:00:00.000Z",
    }, NOW)).toBeNull();
    expect(readGrokBearer({
      key: "expired",
      expires_at: "2026-09-01T00:00:00.000Z",
    }, NOW, "pasted-bearer")).toEqual({ token: "pasted-bearer", email: null });
  });

  it("reads Copilot and OpenCode credentials without taking another provider's key", () => {
    expect(readCopilotTokenFromHosts(JSON.stringify({
      "github.com": { oauth_token: "gho_example" },
    }))).toBe("gho_example");
    expect(readOpenCodeApiKey({
      anthropic: { type: "api", key: "sk-ant-not-this" },
      opencode: { type: "api", key: "oc-key" },
    })).toBe("oc-key");
  });
});

describe("extra provider quota polls", () => {
  const home = "/tmp/ade-extra-quota-home";
  const env = {} as NodeJS.ProcessEnv;

  beforeEach(() => {
    resetQuotaIdentityCacheForTests();
  });

  function fetchMock(body: unknown, status = 200) {
    return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }));
  }

  it("does not call the network when Cursor has no local session", async () => {
    const fetchImpl = fetchMock({});
    const result = await pollCursorQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readCursorSession: async () => ({ token: null, unreadable: false }),
    });
    expect(result).toEqual({ disposition: "not_signed_in", windows: [], errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips an expired Cursor session token", async () => {
    const fetchImpl = fetchMock({});
    const result = await pollCursorQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readCursorSession: async () => ({ token: jwt(Math.floor(NOW / 1000) - 120), unreadable: false }),
    });
    expect(result.disposition).toBe("not_signed_in");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the Cursor session as a cookie and never echoes it in an error", async () => {
    const token = "super-secret-cursor-token";
    const fetchImpl = fetchMock({}, 401);
    const result = await pollCursorQuota({ reason: "user" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "linux",
      fetchImpl,
      readCursorSession: async () => ({ token, unreadable: false }),
    });
    expect(result.errors.join(" ")).not.toContain(token);
    expect(result.errorKind).toBe("auth");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.stringify(init?.headers)).toContain(encodeURIComponent(token));
    expect(init?.credentials).toBe("omit");
  });

  it("sends a Cursor access token as userId::token, which is the cookie the API accepts", async () => {
    const token = jwt(Math.floor(NOW / 1000) + 3600, { sub: "github|12345678" });
    expect(cursorSessionCookie(token)).toBe(`12345678::${token}`);
    expect(cursorSessionCookie(`12345678::${token}`)).toBe(`12345678::${token}`);
    expect(cursorSessionCookie("opaque-token")).toBe("opaque-token");

    const fetchImpl = fetchMock({
      membershipType: "pro",
      individualUsage: { plan: { totalPercentUsed: 29 } },
    });
    const result = await pollCursorQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readCursorSession: async () => ({ token, unreadable: false }),
    });
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Cookie).toBe(`WorkosCursorSessionToken=${encodeURIComponent(`12345678::${token}`)}`);
    expect(result.windows[0]?.percentUsed).toBe(29);
    expect(result.errors.join(" ")).not.toContain(token);
  });

  it("polls Copilot only after a token exists, and skips gh when nothing is installed", async () => {
    const fetchImpl = fetchMock({});
    const readGhToken = vi.fn(async () => "gh-token");
    const absent = await pollCopilotQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readText: async () => null,
      readGhToken,
    });
    expect(absent.disposition).toBe("not_signed_in");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readGhToken).not.toHaveBeenCalled();

    const authed = await pollCopilotQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env: { ...env, GH_TOKEN: "gho_from_env" },
      homeDir: home,
      platform: "darwin",
      fetchImpl: fetchMock({ quotaSnapshots: { premiumInteractions: { percentRemaining: 80 } } }),
      readText: async () => null,
      readGhToken,
    });
    expect(authed.windows[0]?.percentUsed).toBe(20);
  });

  it("polls Kimi from its credentials file, honors the region, and stamps its identity", async () => {
    const kimiCodeHome = kimiHome({
      "credentials/kimi-code.json": JSON.stringify({ access_token: "kimi-access", expires_at: "2026-09-28T00:00:00.000Z" }),
      region: "global\n",
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/usages")) {
        return new Response(JSON.stringify({
          limits: [{
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { used: 2, limit: 10, resetTime: "2026-09-21T20:00:00.000Z" },
          }],
        }));
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer kimi-access");
      return new Response(JSON.stringify({ email: "kimi@example.com", name: "Kimi User" }));
    });
    const result = await pollKimiQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env: { KIMI_CODE_HOME: kimiCodeHome },
      homeDir: home,
      platform: "darwin",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.kimi.ai/coding/v1/usages",
      "https://api.kimi.ai/coding/v1/me",
    ]);
    expect(result.windows[0]).toMatchObject({
      provider: "kimi",
      windowType: "five_hour",
      percentUsed: 20,
      accountId: "kimi:kimi@example.com",
    });
    expect(result.accountEmail).toBe("kimi@example.com");
  });

  // The bug: a `kimi login --region global` token lives in its own scoped file
  // named by `config.toml`, and ADE read only `kimi-code.json`.
  it("polls a --region global Kimi login from the slot config.toml names", async () => {
    const kimiCodeHome = kimiHome({
      "config.toml": [
        "[providers.\"managed:kimi-code\"]",
        "type = \"kimi\"",
        "base_url = \"https://api.kimi.ai/coding/v1\"",
        "",
        "[providers.\"managed:kimi-code\".oauth]",
        "storage = \"file\"",
        "key = \"oauth/kimi-code-env-0e4f99c69cc27850\"",
        "oauth_host = \"https://auth.kimi.ai\"",
        "",
      ].join("\n"),
      "credentials/kimi-code-env-0e4f99c69cc27850.json": JSON.stringify({ access_token: "global-access" }),
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer global-access");
      return new Response(JSON.stringify(url.endsWith("/usages") ? { usage: { used: 1, limit: 4 } } : { email: "g@example.com" }));
    });
    const result = await pollKimiQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env: { KIMI_CODE_HOME: kimiCodeHome },
      homeDir: home,
      platform: "linux",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.kimi.ai/coding/v1/usages",
      "https://api.kimi.ai/coding/v1/me",
    ]);
    expect(result.windows[0]).toMatchObject({ windowType: "weekly", percentUsed: 25, accountId: "kimi:g@example.com" });
  });

  // The bug: a failed identity call stamped the windows `<provider>:local`, a
  // different account to the burn-rate history, which lost the join for its
  // whole retention window.
  it("keeps the last known identity when the identity call fails", async () => {
    const kimiCodeHome = kimiHome({ "credentials/kimi-code.json": JSON.stringify({ access_token: "kimi-access" }) });
    const kimiIo = (meStatus: number) => ({
      nowMs: NOW,
      env: { KIMI_CODE_HOME: kimiCodeHome },
      homeDir: home,
      platform: "darwin" as const,
      fetchImpl: vi.fn(async (url: string) => url.endsWith("/usages")
        ? new Response(JSON.stringify({ usage: { used: "30", limit: "100", resetTime: "2026-09-28T00:00:00.000Z" } }))
        : new Response(JSON.stringify({ user_id: "u1", email: "kimi@example.com" }), { status: meStatus })),
    });
    await pollKimiQuota({ reason: "automatic" }, kimiIo(200));
    const kimi = await pollKimiQuota({ reason: "automatic" }, kimiIo(503));
    expect(kimi.windows[0]).toMatchObject({ windowType: "weekly", percentUsed: 30, accountId: "kimi:kimi@example.com" });
    expect(kimi.accountEmail).toBe("kimi@example.com");

    const copilotIo = (userStatus: number) => ({
      nowMs: NOW,
      env: { GH_TOKEN: "gho-test" },
      homeDir: home,
      platform: "darwin" as const,
      readText: async () => null,
      readGhToken: async () => null,
      fetchImpl: vi.fn(async (url: string) => url.includes("copilot_internal")
        ? new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { percent_remaining: 75 } } }))
        : new Response(JSON.stringify({ login: "ada", email: "ada@example.com" }), { status: userStatus })),
    });
    await pollCopilotQuota({ reason: "automatic" }, copilotIo(200));
    const copilot = await pollCopilotQuota({ reason: "automatic" }, copilotIo(500));
    expect(copilot.windows[0]?.accountId).toBe("copilot:ada@example.com");
    expect(copilot.accountEmail).toBe("ada@example.com");
  });

  // The bug: the remembered identity was keyed only by provider, so switching
  // accounts and then one failed `/me` or `/user` stamped the new account with
  // the old account's email.
  it("never reuses a remembered identity for a different credential", async () => {
    const kimiCodeHome = kimiHome({ "credentials/kimi-code.json": JSON.stringify({ access_token: "first-account" }) });
    const kimiIo = (meStatus: number) => ({
      nowMs: NOW,
      env: { KIMI_CODE_HOME: kimiCodeHome },
      homeDir: home,
      platform: "darwin" as const,
      fetchImpl: vi.fn(async (url: string) => url.endsWith("/usages")
        ? new Response(JSON.stringify({ usage: { used: 1, limit: 10 } }))
        : new Response(JSON.stringify({ email: "first@example.com" }), { status: meStatus })),
    });
    await pollKimiQuota({ reason: "automatic" }, kimiIo(200));
    writeFileSync(path.join(kimiCodeHome, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "second-account" }));
    const kimi = await pollKimiQuota({ reason: "automatic" }, kimiIo(503));
    expect(kimi.windows[0]?.accountId).toBe("kimi:local");
    expect(kimi.accountEmail).toBeUndefined();

    const copilotIo = (token: string, userStatus: number) => ({
      nowMs: NOW,
      env: { GH_TOKEN: token },
      homeDir: home,
      platform: "darwin" as const,
      readText: async () => null,
      readGhToken: async () => null,
      fetchImpl: vi.fn(async (url: string) => url.includes("copilot_internal")
        ? new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { percent_remaining: 75 } } }))
        : new Response(JSON.stringify({ email: "first@example.com" }), { status: userStatus })),
    });
    await pollCopilotQuota({ reason: "automatic" }, copilotIo("gho-first", 200));
    const copilot = await pollCopilotQuota({ reason: "automatic" }, copilotIo("gho-second", 500));
    expect(copilot.windows[0]?.accountId).toBe("copilot:local");
    expect(copilot.accountEmail).toBeUndefined();
  });

  it("forgets a remembered identity once the provider is signed out", async () => {
    const kimiCodeHome = kimiHome({});
    const credentialPath = path.join(kimiCodeHome, "credentials", "kimi-code.json");
    const signIn = () => {
      mkdirSync(path.dirname(credentialPath), { recursive: true });
      writeFileSync(credentialPath, JSON.stringify({ access_token: "kimi-access" }));
    };
    const io = (meStatus: number) => ({
      nowMs: NOW,
      env: { KIMI_CODE_HOME: kimiCodeHome },
      homeDir: home,
      platform: "darwin" as const,
      fetchImpl: vi.fn(async (url: string) => url.endsWith("/usages")
        ? new Response(JSON.stringify({ usage: { used: 1, limit: 10 } }))
        : new Response(JSON.stringify({ email: "kimi@example.com" }), { status: meStatus })),
    });
    signIn();
    await pollKimiQuota({ reason: "automatic" }, io(200));
    rmSync(credentialPath);
    expect((await pollKimiQuota({ reason: "automatic" }, io(200))).disposition).toBe("not_signed_in");
    signIn();
    const result = await pollKimiQuota({ reason: "automatic" }, io(503));
    expect(result.windows[0]?.accountId).toBe("kimi:local");
    expect(result.accountEmail).toBeUndefined();
  });

  it("uses the same Copilot token for GitHub account identity and reset date", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("copilot_internal")
        ? {
          quota_snapshots: { premium_interactions: { percent_remaining: 75 } },
          quota_reset_date: "2026-10-01",
        }
        : { login: "ada-lovelace", email: "ada@example.com" },
    )));
    const result = await pollCopilotQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env: { GH_TOKEN: "gho-test" },
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readText: async () => null,
      readGhToken: async () => null,
    });
    expect(result.accountEmail).toBe("ada@example.com");
    expect(result.windows[0]).toMatchObject({
      percentUsed: 25,
      resetsAt: "2026-10-01",
      accountId: "copilot:ada@example.com",
    });
  });

  it("polls Grok from auth.json and OpenCode from OPENCODE_API_KEY", async () => {
    const grokFetch = fetchMock({
      config: {
        creditUsagePercent: 15,
        subscriptionTier: "SuperGrok",
        currentPeriod: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
      },
    });
    const grok = await pollGrokQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl: grokFetch,
      readText: async () => JSON.stringify({
        "https://auth.x.ai::s": {
          key: "grok-bearer",
          email: "ada@example.com",
          expires_at: "2026-09-28T00:00:00.000Z",
        },
      }),
    });
    expect(grok.windows[0]).toMatchObject({
      provider: "grok",
      percentUsed: 15,
      accountId: "grok:ada@example.com",
    });
    expect(grok.accountEmail).toBe("ada@example.com");
    expect(grok.accountPlan).toBe("SuperGrok");
    const grokInit = grokFetch.mock.calls[0]?.[1];
    expect(JSON.stringify(grokInit?.headers)).toContain("Bearer grok-bearer");

    const openCodeFetch = fetchMock({
      usage: { rolling: { percent: 1, resetInSec: 10 }, weekly: { percent: 1 }, monthly: { percent: 1 } },
    });
    const openCode = await pollOpenCodeQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env: { OPENCODE_API_KEY: "oc-live" },
      homeDir: home,
      platform: "win32",
      fetchImpl: openCodeFetch,
      readText: async () => {
        throw new Error("should not read auth.json when the env key is set");
      },
    });
    expect(openCode.windows.map((window) => window.percentUsed)).toEqual([1, 1, 1]);
    expect(String(openCodeFetch.mock.calls[0]?.[0])).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("falls back to the OpenCode console login for OpenCode Go when no API key exists", async () => {
    const fetchImpl = fetchMock({
      product: "go",
      access: {
        endsAt: "2026-10-25T18:37:51.000Z",
        meters: {
          fiveHour: { resetsAt: "2026-09-26T00:18:07.400Z", limitMicroCents: "1200000000", usedMicroCents: "600000000" },
          week: { resetsAt: "2026-09-28T00:00:00.000Z", limitMicroCents: "3000000000", usedMicroCents: "300000000" },
          month: { limitMicroCents: "6000000000", usedMicroCents: "1200000000" },
        },
      },
    });
    const result = await pollOpenCodeQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readText: async () => null,
      readOpenCodeConsoleAccount: async () => ({
        accessToken: "st_console-token",
        orgId: "org_123",
        email: "ada@example.com",
      }),
    });
    expect(result.windows.map((window) => window.percentUsed)).toEqual([50, 10, 20]);
    expect(result.windows[0]?.accountId).toBe("opencode:ada@example.com");
    expect(result.accountEmail).toBe("ada@example.com");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://opencode.ai/console/api/go/status");
    expect(JSON.stringify(init?.headers)).toContain("Bearer st_console-token");
    expect(JSON.stringify(init?.headers)).toContain("org_123");
  });

  it("treats an OpenCode console account without a Go plan as signed out, not an error", async () => {
    const fetchImpl = fetchMock({ access: null });
    const result = await pollOpenCodeQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readText: async () => null,
      readOpenCodeConsoleAccount: async () => ({
        accessToken: "st_console-token",
        orgId: "org_123",
        email: "ada@example.com",
      }),
    });
    expect(result).toEqual({ disposition: "not_signed_in", windows: [], errors: [] });
  });

  it("keeps a malformed OpenCode console 200 from clearing existing limits", async () => {
    const fetchImpl = fetchMock({ unexpected: true });
    const result = await pollOpenCodeQuota({ reason: "automatic" }, {
      nowMs: NOW,
      env,
      homeDir: home,
      platform: "darwin",
      fetchImpl,
      readText: async () => null,
      readOpenCodeConsoleAccount: async () => ({
        accessToken: "st_console-token",
        orgId: "org_123",
        email: "ada@example.com",
      }),
    });
    expect(result.disposition).toBeUndefined();
    expect(result.errorKind).toBe("invalid_response");
  });

  it("fetches a Droid session's Factory credits, without treating a missing key as an error", async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify({ tokenUsage: { factoryCredits: 3.5 } })));
    const io = {
      nowMs: NOW,
      env: {},
      homeDir: home,
      platform: "darwin" as const,
      fetchImpl,
      readFactoryApiKey: () => "fk-test",
    };
    await expect(fetchFactorySessionCredits("session/123", io)).resolves.toBe(3.5);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v0/sessions/session%2F123");
    await expect(fetchFactorySessionCredits("session/123", { ...io, readFactoryApiKey: () => null })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("looks for OpenCode's auth.json where OpenCode keeps its data, XDG first", () => {
    expect(openCodeAuthPaths({ homeDir: "/home/ada", platform: "linux", env: {} })).toEqual([
      path.join("/home/ada", ".local", "share", "opencode", "auth.json"),
    ]);
    expect(openCodeAuthPaths({ homeDir: "/home/ada", platform: "linux", env: { XDG_DATA_HOME: "/xdg/data" } })).toEqual([
      path.join("/xdg/data", "opencode", "auth.json"),
      path.join("/home/ada", ".local", "share", "opencode", "auth.json"),
    ]);
    expect(openCodeAuthPaths({ homeDir: "/Users/ada", platform: "darwin", env: {} })).toEqual([
      path.join("/Users/ada", ".local", "share", "opencode", "auth.json"),
      path.join("/Users/ada", "Library", "Application Support", "opencode", "auth.json"),
    ]);
  });

  it("does not use an expired Kimi access token", () => {
    expect(readKimiAccessToken({
      access_token: "expired",
      expires_at: "2026-09-21T15:00:00.000Z",
    }, NOW)).toBeNull();
  });

  it("places the Cursor session database per platform", () => {
    expect(cursorStateDbPath({ homeDir: "/Users/ada", platform: "darwin", env: {} })).toContain(
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
    expect(cursorStateDbPath({
      homeDir: "/home/ada",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/xdg" },
    })).toBe("/xdg/Cursor/User/globalStorage/state.vscdb");
    expect(cursorStateDbPath({
      homeDir: "C:\\Users\\ada",
      platform: "win32",
      env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    })).toContain("Cursor");
  });
});

describe("OpenCode console account reader", () => {
  const requireForTest = createRequire(path.join(process.cwd(), "extra-quota-test.cjs"));

  /** A minimal `opencode.db`: the two tables the console account lives in. */
  function writeOpenCodeDb(
    dbPath: string,
    accounts: Array<{ id: string; email: string; token: string; expiry: number; updated: number }>,
    activeId: string,
    orgId: string,
  ): void {
    const { DatabaseSync } = requireForTest("node:sqlite") as {
      DatabaseSync: new (dbPath: string, options?: Record<string, unknown>) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec("create table account (id text, email text, access_token text, refresh_token text, token_expiry integer, time_created integer, time_updated integer);");
    db.exec("create table account_state (id integer, active_account_id text, active_org_id text);");
    const insert = db.prepare("insert into account values (?, ?, ?, ?, ?, ?, ?)");
    for (const account of accounts) {
      insert.run(account.id, account.email, account.token, "rt", account.expiry, account.updated, account.updated);
    }
    db.prepare("insert into account_state values (1, ?, ?)").run(activeId, orgId);
    db.close();
  }

  it("prefers the active OpenCode account over a more recently updated inactive one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ade-oc-console-"));
    try {
      const dbPath = path.join(dir, "opencode.db");
      writeOpenCodeDb(dbPath, [
        { id: "user_a", email: "active@example.com", token: "st_active", expiry: NOW + 86_400_000, updated: 1 },
        { id: "user_b", email: "inactive@example.com", token: "st_inactive", expiry: NOW + 86_400_000, updated: 99 },
      ], "user_a", "org_a");
      await expect(readOpenCodeConsoleAccountFromDisk(dbPath, NOW)).resolves.toEqual({
        accessToken: "st_active",
        orgId: "org_a",
        email: "active@example.com",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores an expired console token instead of sending it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ade-oc-console-"));
    try {
      const dbPath = path.join(dir, "opencode.db");
      writeOpenCodeDb(dbPath, [
        { id: "user_a", email: "active@example.com", token: "st_expired", expiry: NOW - 1_000, updated: 99 },
      ], "user_a", "org_a");
      await expect(readOpenCodeConsoleAccountFromDisk(dbPath, NOW)).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads no account from a missing database", async () => {
    await expect(readOpenCodeConsoleAccountFromDisk("/tmp/ade-oc-missing-dir/opencode.db", NOW)).resolves.toBeNull();
  });
});
