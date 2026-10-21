import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecideRequest, JevFeature, JevPriority } from "../../../shared/types/jev";

/**
 * The route chain: OpenCode's free Jev first, then the ADE bonus, each call
 * falling through on its own, with the bonus kept for the right callers.
 * The network is the only thing stubbed.
 */

const FREE_URL = "https://opencode.ai/inference/systemone/v1/systemone";
const DIRECTORY = "https://directory.test";
const BONUS_URL = `${DIRECTORY}/jev/systemone`;

const ANSWER = { answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 300, output_tokens: 20 } };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function stubNetwork(replies: { free: Reply; bonus: Reply }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = url === BONUS_URL ? replies.bonus : url.startsWith("https://opencode.ai/") ? replies.free : null;
    if (!reply) return new Response("unexpected", { status: 500 });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
  }));
  return calls;
}

function request(feature: JevFeature, priority: JevPriority, text = "a"): JevDecideRequest {
  return {
    feature,
    priority,
    state: `the state ${text}`,
    questions: { ok: { type: "noul", instructions: "Is it ok?" } },
  };
}

// Breakers and the bonus's remaining count are per process: a fresh module per test.
async function makeService() {
  vi.resetModules();
  const { createJevService } = await import("./jevService");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createJevService({
    logger: logger as never,
    isEnabled: () => true,
    bonus: { baseUrl: () => DIRECTORY, accountToken: async () => "account-token" },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jevService routes", () => {
  it("hands a call the free allowance refuses to the bonus, and skips free until it resets", async () => {
    const calls = stubNetwork({
      free: { status: 429, headers: { "retry-after": "3600" } },
      bonus: { status: 200, body: ANSWER, headers: { "x-ade-jev-remaining": "250" } },
    });
    const jev = await makeService();

    expect(await jev.decide(request("turn_end", "background", "1"))).toEqual({ ok: { type: "noul", noul: 0.9 } });
    expect(calls).toEqual([FREE_URL, BONUS_URL]);

    // The free route's breaker is open: the next call goes straight to the bonus.
    expect(await jev.decide(request("turn_end", "background", "2"))).not.toBeNull();
    expect(calls).toEqual([FREE_URL, BONUS_URL, BONUS_URL]);
    expect(jev.status().routes.find((route) => route.route === "free")).toMatchObject({ open: true, reason: "rate_limited" });
    expect(jev.status().today).toMatchObject({ answeredByRoute: { bonus: 2 } });
  });

  it.each([
    {
      name: "a settle check never uses the bonus",
      free: { status: 429 },
      first: request("settle_nudge", "background"),
      answered: false,
      bonusCalls: 0,
    },
    {
      name: "background calls leave the bonus's last calls to interactive ones",
      free: { status: 429 },
      remaining: "20",
      first: request("palette", "interactive", "warm"),
      then: request("status_line", "background"),
      answered: false,
      bonusCalls: 1,
    },
    {
      name: "an interactive call still gets one of the last bonus calls",
      free: { status: 429 },
      remaining: "20",
      first: request("palette", "interactive", "warm"),
      then: request("model_hint", "interactive"),
      answered: true,
      bonusCalls: 2,
    },
    {
      name: "a refused request falls through without opening the free breaker",
      free: { status: 400 },
      first: request("turn_end", "background"),
      answered: true,
      bonusCalls: 1,
      freeStaysClosed: true,
    },
  ])("$name", async ({ free, remaining, first, then, answered, bonusCalls, freeStaysClosed }) => {
    const calls = stubNetwork({
      free,
      bonus: { status: 200, body: ANSWER, headers: remaining ? { "x-ade-jev-remaining": remaining } : {} },
    });
    const jev = await makeService();

    const firstAnswer = await jev.decide(first);
    const answer = then ? await jev.decide(then) : firstAnswer;
    expect(answer != null).toBe(answered);
    expect(calls.filter((url) => url === BONUS_URL)).toHaveLength(bonusCalls);
    if (freeStaysClosed) {
      expect(jev.status().routes.find((route) => route.route === "free")?.open).toBe(false);
    }
  });
});
