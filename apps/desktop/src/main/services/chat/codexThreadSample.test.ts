import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import {
  buildCodexSamplePrompt,
  createCodexThreadSampler,
} from "./codexThreadSample";

/** Half of a UTF-16 surrogate pair on its own: what a byte cut can leave behind. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function harness() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const sampler = createCodexThreadSampler({ logger, isTimeoutError: () => false });
  const request = vi.fn();
  const target = {
    threadId: "thread-1",
    request,
    effort: "low",
    isCurrent: () => true,
  };
  const sample = (overrides: Partial<Parameters<typeof sampler.sample>[0]> = {}) => sampler.sample({
    sessionId: "session-1",
    accountKey: "account-1",
    turnId: "turn-1",
    prompt: "Suggest the next message.",
    timeoutMs: 15_000,
    purpose: "prompt_suggestion",
    prepare: () => target,
    ...overrides,
  });
  return { sample, request };
}

describe("codex thread sample", () => {
  it("keeps the prompt inside Codex's byte cap without cutting the request or a character in half", () => {
    const request = "Name the next message.";
    // Emoji first, so the cut lands inside a four-byte character.
    const prompt = buildCodexSamplePrompt(request, `${"🙂".repeat(1_000)}${"ü".repeat(2_000)}`);
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(4_000);
    expect(prompt).toContain(request);
    expect(prompt).not.toMatch(LONE_SURROGATE);
  });

  it.each([
    ["sample source changed", "stale"],
    ["thread/sample: method not found", "unsupported"],
    ["connection reset by peer", "failed"],
  ] as const)("reports a %j failure as %s, so the caller knows whether to try again", async (message, kind) => {
    const { sample, request } = harness();
    request.mockRejectedValueOnce(new Error(message));
    const outcome = await sample();
    expect(outcome).toMatchObject({ kind, reason: message });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("pauses an account's sampling after a rate limit instead of spending the next real turn's budget", async () => {
    const { sample, request } = harness();
    // Codex counts samples against the same per-turn limit as real turns.
    request.mockRejectedValueOnce(new Error("429 Too Many Requests (retry-after 282)"));
    expect((await sample()).kind).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);

    // Same account while the Retry-After window runs: answered without an RPC.
    expect((await sample({ turnId: "turn-2" })).kind).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);

    // A rate limit in the helper the sample was replacing spends nothing either.
    expect((await sample({ turnId: "turn-3", accountKey: "account-2", helperError: "429 too many requests" })).kind)
      .toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);

    // Another account has its own budget.
    expect((await sample({ turnId: "turn-4", accountKey: "account-3" })).kind).toBe("answered");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
