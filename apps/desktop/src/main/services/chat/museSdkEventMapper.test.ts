import { describe, expect, it } from "vitest";
import type { SessionTokenUsageParams, TokenUsage } from "@muse-code/sdk/dist/src/msp.js";
import type { MuseNotification } from "./museSdkHost";
import {
  addUsage,
  createMuseEventMapperState,
  mapMuseNotification,
  museCompletionUsage,
  museTurnAggregateUsage,
  museUsageToDoneUsage,
} from "./museSdkEventMapper";

function tokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { cachedTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, ...overrides };
}

function tokenUsageNotification(
  promptTokens: number,
  usage: TokenUsage,
  turnId = "turn-1",
): MuseNotification {
  return {
    method: "session/tokenUsage",
    params: { promptTokens, usage, turnId, modelId: null } as unknown as SessionTokenUsageParams,
  };
}

describe("museCompletionUsage", () => {
  it.each([
    ["derives uncached input from the counted-once prompt total", 100, tokenUsage({ cachedTokens: 30, outputTokens: 5 }), 70, 30],
    ["prefers explicit cache write/read splits over the provider's cachedTokens", 100, tokenUsage({ cachedTokens: 99, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 5 }), 70, 20],
    ["clamps uncached input at zero rather than going negative", 10, tokenUsage({ cacheReadTokens: 20, outputTokens: 5 }), 0, 20],
  ])("%s", (_label, promptTokens, usage, expectedInput, expectedCacheRead) => {
    const mapped = museCompletionUsage({ promptTokens, usage });

    expect(mapped.inputTokens).toBe(expectedInput);
    expect(mapped.cacheReadTokens).toBe(expectedCacheRead);
    expect(mapped.cacheWriteTokens).toBe(usage.cacheWriteTokens ?? 0);
    expect(mapped.reasoningTokens).toBe(usage.reasoningTokens);
  });
});

describe("addUsage", () => {
  it("starts from the first completion and sums every counter", () => {
    const first = museCompletionUsage({ promptTokens: 100, usage: tokenUsage({ cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20, reasoningTokens: 2 }) });
    const second = museCompletionUsage({ promptTokens: 50, usage: tokenUsage({ cacheReadTokens: 4, outputTokens: 8, reasoningTokens: 1 }) });

    expect(addUsage(null, first)).toEqual(first);
    expect(addUsage(first, second)).toEqual({
      inputTokens: 85 + 46,
      outputTokens: 28,
      cacheReadTokens: 14,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
    });
  });
});

describe("museTurnAggregateUsage", () => {
  it("falls back to the provider input count when no counted-once prompt total exists", () => {
    const aggregate = museTurnAggregateUsage(tokenUsage({ inputTokens: 100, cachedTokens: 30, outputTokens: 7, reasoningTokens: 3 }));

    expect(aggregate).toEqual({
      inputTokens: 70,
      outputTokens: 7,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    });
  });
});

describe("mapMuseNotification session/tokenUsage", () => {
  it("accumulates the turn's usage across completions and emits each completion's tokens", () => {
    const state = createMuseEventMapperState();
    const context = { activeTurnId: "turn-1", cwd: "/workspace" };

    const first = mapMuseNotification(tokenUsageNotification(100, tokenUsage({ cachedTokens: 30, outputTokens: 20 })), context, state);
    const second = mapMuseNotification(tokenUsageNotification(50, tokenUsage({ cacheReadTokens: 4, outputTokens: 8 })), context, state);

    expect(first).toEqual([expect.objectContaining({ type: "tokens", turnId: "turn-1", inputTokens: 70, outputTokens: 20 })]);
    expect(second).toEqual([expect.objectContaining({ type: "tokens", turnId: "turn-1", inputTokens: 46, outputTokens: 8 })]);
    // The per-completion events sum to the turn total emitted on `done`.
    expect(state.turnUsage).toMatchObject({ inputTokens: 116, outputTokens: 28, cacheReadTokens: 34 });
    expect(museUsageToDoneUsage(state.turnUsage, 200_000)).toMatchObject({
      inputTokens: 116,
      outputTokens: 28,
      cacheReadTokens: 34,
      contextWindow: 200_000,
    });
  });
});
