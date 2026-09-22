import { describe, expect, it, vi } from "vitest";
import {
  cursorStateDbPath,
  localQuotaAccountId,
  parseCopilotQuota,
  cursorSessionCookie,
  parseCursorUsageSummary,
  parseGrokCredits,
  parseOpenCodeGoUsage,
  pollCopilotQuota,
  pollCursorQuota,
  pollGrokQuota,
  pollOpenCodeQuota,
  readCopilotTokenFromHosts,
  readGrokBearer,
  readOpenCodeApiKey,
  wholePercent,
} from "./extraProviderQuota";

const NOW = Date.parse("2026-09-21T16:00:00.000Z");

function jwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, ...extra })).toString("base64url");
  return `e30.${payload}.sig`;
}

describe("extra provider quota parsers", () => {
  it("keeps a 1% OpenCode window at 1%, including zero", () => {
    expect(wholePercent(1)).toBe(1);
    const windows = parseOpenCodeGoUsage({
      usage: {
        rolling: { percent: 3, resetInSec: 3600 },
        weekly: { percent: 1, resetInSec: 86_400 },
        monthly: { percent: 0, resetInSec: 86_400 * 10 },
      },
    }, NOW);
    expect(windows.map((window) => [window.windowType, window.percentUsed])).toEqual([
      ["five_hour", 3],
      ["weekly", 1],
      ["monthly", 0],
    ]);
    expect(windows[0]?.resetsAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  it("reads Cursor plan percent and the billing-cycle reset", () => {
    const parsed = parseCursorUsageSummary({
      membershipType: "pro",
      email: "Ada@Example.com",
      billingCycleEnd: "2026-10-01T00:00:00.000Z",
      individualUsage: { plan: { totalPercentUsed: 40, used: 1, limit: 2 } },
    }, NOW);
    expect(parsed.plan).toBe("pro");
    expect(parsed.windows).toEqual([expect.objectContaining({
      provider: "cursor",
      windowType: "monthly",
      percentUsed: 40,
      resetsAt: "2026-10-01T00:00:00.000Z",
      accountId: localQuotaAccountId("cursor", "Ada@Example.com"),
    })]);
  });

  it("turns Copilot premium remaining into used percent and omits a missing reset", () => {
    const parsed = parseCopilotQuota({
      copilotPlan: "pro",
      quota_snapshots: { premium_interactions: { percent_remaining: 40 } },
    }, NOW);
    expect(parsed.plan).toBe("pro");
    expect(parsed.windows[0]).toMatchObject({
      provider: "copilot",
      windowType: "monthly",
      percentUsed: 60,
      resetsAt: "",
      accountId: "copilot:local",
    });
  });

  it("labels a 7-day Grok period weekly and a longer one monthly", () => {
    const weekly = parseGrokCredits({
      config: {
        creditUsagePercent: 12,
        currentPeriod: {
          start: "2026-09-15T00:00:00.000Z",
          end: "2026-09-22T00:00:00.000Z",
        },
      },
    }, NOW);
    expect(weekly.windows[0]).toMatchObject({ windowType: "weekly", percentUsed: 12 });

    const monthly = parseGrokCredits({
      credit_usage_percent: 8,
      billing_period_end: "2026-10-21T00:00:00.000Z",
    }, NOW);
    expect(monthly.windows[0]).toMatchObject({ windowType: "monthly", percentUsed: 8 });
  });

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
