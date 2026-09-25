import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeClaudeResetCredit,
  parseClaudeResetCredits,
  readClaudeResetCredits,
} from "./claudeResetCredits";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const CLI_VERSION = "2.1.0";

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const tempDirs: string[] = [];
function writeLogin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-reset-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "oauth-token" },
  }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
    oauthAccount: { organizationUuid: "org-1" },
  }));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseClaudeResetCredits", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(parseClaudeResetCredits({
      eligible: true,
      next_grant_id: "grant_a",
      grants: [
        grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
        grant({ id: "paused", paused: true }),
        grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
        grant({ id: "garbled", ends_at: "not a date" }),
        grant({ id: "date_only", ends_at: "2026-10-01" }),
        grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
        grant({ id: "empty", ends_at: "" }),
        grant({ id: "Not Valid" }),
        grant({ id: "grant_b", resets_left: 3, usable_now: false }),
      ],
    }, NOW)).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(parseClaudeResetCredits(
      { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
      NOW,
    )).toEqual({ availableCount: 0 });
    expect(parseClaudeResetCredits({ eligible: true, grants: [grant()] }, NOW))
      .toEqual({ availableCount: 0 });
    expect(parseClaudeResetCredits({ eligible: false, grants: [grant()] }, NOW)).toBeNull();
    expect(parseClaudeResetCredits(undefined, NOW)).toBeNull();
  });
});

describe("readClaudeResetCredits", () => {
  it("reads the grants with the CLI's request", async () => {
    const configHome = writeLogin();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
      );
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer oauth-token");
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(headers["user-agent"]).toBe(`claude-cli/${CLI_VERSION} (external, cli)`);
      return new Response(JSON.stringify({
        cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant()] },
      }), { status: 200 });
    });
    await expect(readClaudeResetCredits({
      configHome,
      nowMs: NOW,
      platform: "linux",
      cliVersion: CLI_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual({ availableCount: 1, nextCreditId: "grant_a" });
  });

  it("reads nothing on macOS, without a login, or from a failed request", async () => {
    const configHome = writeLogin();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(readClaudeResetCredits({
      configHome,
      nowMs: NOW,
      platform: "darwin",
      cliVersion: CLI_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readClaudeResetCredits({
      configHome: path.join(configHome, "missing"),
      nowMs: NOW,
      platform: "linux",
      cliVersion: CLI_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
    await expect(readClaudeResetCredits({
      configHome,
      nowMs: NOW,
      platform: "linux",
      cliVersion: CLI_VERSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBeNull();
  });
});

describe("consumeClaudeResetCredit", () => {
  const consume = (fetchImpl: typeof fetch, ids = { grantId: "grant_a", requestId: "r-1" }) =>
    consumeClaudeResetCredit({
      configHome: writeLogin(),
      platform: "linux",
      cliVersion: CLI_VERSION,
      fetchImpl,
      ...ids,
    });

  it("claims the grant for the organization", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        program: "cedar_ember",
        grant_id: "grant_a",
        request_id: "r-1",
      });
      return new Response(JSON.stringify({ result: "reset" }), { status: 200 });
    });
    await expect(consume(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      result: { ok: true, status: "reset" },
      retrySameClaim: false,
    });
  });

  it("maps each answer to an outcome or a failure", async () => {
    const answer = (result: string) =>
      vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 })) as unknown as typeof fetch;
    await expect(consume(answer("not_limited")))
      .resolves.toMatchObject({ result: { status: "nothingToReset" }, retrySameClaim: false });
    await expect(consume(answer("already_used")))
      .resolves.toMatchObject({ result: { status: "alreadyRedeemed" }, retrySameClaim: false });
    await expect(consume(answer("ineligible")))
      .resolves.toMatchObject({ result: { status: "noCredit" }, retrySameClaim: false });
    // Claude answered, so a retry is a new claim.
    for (const result of ["cooldown"]) {
      await expect(consume(answer(result)))
        .resolves.toMatchObject({ result: { status: "failure" }, retrySameClaim: false });
    }
    for (const status of [429, 401, 403]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
      await expect(consume(fetchImpl))
        .resolves.toMatchObject({ result: { status: "failure" }, retrySameClaim: false });
    }
    // No answer, or Claude could not confirm the claim: a retry is the same claim.
    for (const [status, body] of [[500, {}], [200, { result: "unavailable" }]] as const) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
      await expect(consume(fetchImpl))
        .resolves.toMatchObject({ result: { status: "failure" }, retrySameClaim: true });
    }
  });

  it("refuses malformed ids without sending anything", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(consume(fetchImpl, { grantId: "Bad Grant", requestId: "r-1" }))
      .resolves.toMatchObject({ result: { status: "failure" }, retrySameClaim: false });
    await expect(consume(fetchImpl, { grantId: "grant_a", requestId: "has space" }))
      .resolves.toMatchObject({ result: { status: "failure" }, retrySameClaim: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
