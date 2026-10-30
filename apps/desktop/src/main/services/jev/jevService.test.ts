import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecideRequest, JevFeature, JevKeySkipReason, JevPriority } from "../../../shared/types/jev";

/**
 * The route chain: OpenCode's free Jev first, then the ADE bonus for every
 * feature, each call falling through on its own, and a call the bonus could
 * not take saying why. The network is the only thing stubbed.
 */

const FREE_URL = "https://opencode.ai/inference/systemone/v1/systemone";
const DIRECTORY = "https://directory.test";
const BONUS_URL = `${DIRECTORY}/jev/systemone`;

const ANSWER = { answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 300, output_tokens: 20 } };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function stubNetwork(replies: { free: Reply; bonus?: Reply }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = url === BONUS_URL ? replies.bonus ?? { status: 200, body: ANSWER } : url.startsWith("https://opencode.ai/") ? replies.free : null;
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

// Breakers and the once-a-day reports are per process: a fresh module per test.
async function makeService(account: { token?: string | null; signedIn?: boolean } = {}) {
  vi.resetModules();
  const { createJevService } = await import("./jevService");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const token = account.token === undefined ? "account-token" : account.token;
  const jev = createJevService({
    logger: logger as never,
    isEnabled: () => true,
    bonus: { baseUrl: () => DIRECTORY, accountToken: async () => token, signedIn: () => account.signedIn ?? true },
  });
  return Object.assign(jev, { logger });
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

  it.each<{
    name: string;
    free: Reply;
    bonus?: Reply;
    account?: { token?: string | null; signedIn?: boolean };
    first: JevDecideRequest;
    then?: JevDecideRequest;
    answered: boolean;
    bonusCalls: number;
    freeStaysClosed?: boolean;
    skipped?: Partial<Record<JevKeySkipReason, number>>;
    errorEvents?: string[];
    answerable?: boolean;
  }>([
    {
      name: "a settle check reaches the bonus once the free allowance is spent",
      free: { status: 429 },
      first: request("settle_nudge", "background"),
      answered: true,
      bonusCalls: 1,
    },
    {
      name: "a refused request falls through without opening the free breaker",
      free: { status: 400 },
      first: request("turn_end", "background"),
      answered: true,
      bonusCalls: 1,
      freeStaysClosed: true,
    },
    {
      name: "a spent bonus falls back to the built-in rules and says so",
      free: { status: 429, headers: { "retry-after": "3600" } },
      bonus: { status: 429, headers: { "retry-after": "3600" } },
      first: request("turn_end", "background", "1"),
      then: request("turn_end", "background", "2"),
      answered: false,
      bonusCalls: 1,
      skipped: { key_spent: 1 },
      errorEvents: [],
      answerable: false,
    },
    {
      name: "signed in without an account token: says why, and reports it once a day",
      free: { status: 429, headers: { "retry-after": "3600" } },
      account: { token: null },
      first: request("turn_end", "background", "1"),
      then: request("status_line", "background", "2"),
      answered: false,
      bonusCalls: 0,
      skipped: { no_account_token: 2 },
      errorEvents: ["jev.key_no_token"],
      answerable: true,
    },
    {
      name: "signed out: never asks the bonus, and nothing is left to answer",
      free: { status: 429, headers: { "retry-after": "3600" } },
      account: { token: null, signedIn: false },
      first: request("settle_nudge", "background"),
      answered: false,
      bonusCalls: 0,
      skipped: { signed_out: 1 },
      errorEvents: [],
      answerable: false,
    },
  ])("$name", async ({ free, bonus, account, first, then, answered, bonusCalls, freeStaysClosed, skipped, errorEvents, answerable }) => {
    const calls = stubNetwork({ free, bonus });
    const jev = await makeService(account);

    const firstAnswer = await jev.decide(first);
    const answer = then ? await jev.decide(then) : firstAnswer;
    expect(answer != null).toBe(answered);
    expect(calls.filter((url) => url === BONUS_URL)).toHaveLength(bonusCalls);
    if (freeStaysClosed) {
      expect(jev.status().routes.find((route) => route.route === "free")?.open).toBe(false);
    }
    if (skipped) expect(jev.status().today?.keySkippedByReason).toEqual(skipped);
    if (errorEvents) expect(jev.logger.error.mock.calls.map(([event]) => event)).toEqual(errorEvents);
    if (answerable !== undefined) expect(jev.status().answerable).toBe(answerable);
  });
});
