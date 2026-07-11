import { describe, it, expect } from "vitest";
import { toUsageViewModel, formatContextTokens, latestContextUsageInput } from "./contextUsageModel";

const envelope = (sequence: number, event: any) => ({
  sessionId: "session-1",
  timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
  sequence,
  event,
});

describe("toUsageViewModel", () => {
  it("returns null for null input", () => {
    expect(toUsageViewModel(null)).toBeNull();
  });

  it("uses codex last.inputTokens as occupancy (not lifetime total)", () => {
    const vm = toUsageViewModel({
      kind: "codex",
      provider: "codex",
      usage: {
        last: { inputTokens: 100_000, outputTokens: 500, cacheReadTokens: 40_000 },
        total: { totalTokens: 999_999 },
        modelContextWindow: 200_000,
      },
    });
    expect(vm).not.toBeNull();
    expect(vm!.usedTokens).toBe(100_000); // last.input, not total.totalTokens
    expect(vm!.contextWindow).toBe(200_000);
    expect(vm!.ratio).toBeCloseTo(0.5, 5);
    expect(vm!.windowSource).toBe("runtime");
    expect(vm!.cacheReadTokens).toBe(40_000);
  });

  it("sums input + cache for generic (non-codex) providers", () => {
    const vm = toUsageViewModel({
      kind: "generic",
      provider: "claude",
      usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 5_000, cacheWriteTokens: 2_000 },
      contextWindow: 100_000,
    });
    expect(vm!.usedTokens).toBe(8_000); // 1000 + 5000 + 2000
    expect(vm!.ratio).toBeCloseTo(0.08, 5);
    expect(vm!.windowSource).toBe("runtime");
  });

  it("falls back to the registry context window when the runtime reports none", () => {
    const vm = toUsageViewModel(
      { kind: "generic", provider: "cursor", usage: { inputTokens: 50_000 } },
      200_000,
    );
    expect(vm!.contextWindow).toBe(200_000);
    expect(vm!.windowSource).toBe("registry");
    expect(vm!.ratio).toBeCloseTo(0.25, 5);
  });

  it("prefers a runtime-reported window over the registry fallback", () => {
    const vm = toUsageViewModel(
      { kind: "codex", provider: "codex", usage: { last: { inputTokens: 1_000 }, modelContextWindow: 50_000 } },
      200_000,
    );
    expect(vm!.contextWindow).toBe(50_000);
    expect(vm!.windowSource).toBe("runtime");
  });

  it("returns a tokens-only VM (null ratio) when no window is known", () => {
    const vm = toUsageViewModel({ kind: "generic", provider: "droid", usage: { inputTokens: 1_234 } });
    expect(vm).not.toBeNull();
    expect(vm!.contextWindow).toBeNull();
    expect(vm!.ratio).toBeNull();
    expect(vm!.usedTokens).toBe(1_234);
    expect(vm!.windowSource).toBeNull();
  });

  it("returns null when there are no tokens at all", () => {
    expect(toUsageViewModel({ kind: "generic", provider: "cursor", usage: {} }, 200_000)).toBeNull();
  });

  it("clamps the ratio to [0, 1] when occupancy exceeds the window", () => {
    const vm = toUsageViewModel({
      kind: "codex",
      provider: "codex",
      usage: { last: { inputTokens: 300_000 }, modelContextWindow: 200_000 },
    });
    expect(vm!.ratio).toBe(1);
  });

  it("carries reasoning tokens through for the tooltip", () => {
    const vm = toUsageViewModel({
      kind: "generic",
      provider: "opencode",
      usage: { inputTokens: 10_000, outputTokens: 1_000, reasoningTokens: 4_100 },
      contextWindow: 128_000,
    });
    expect(vm!.reasoningTokens).toBe(4_100);
  });

  it("uses an exact zero-token compaction snapshot", () => {
    const vm = toUsageViewModel({
      kind: "generic",
      provider: "claude",
      usage: { usedTokens: 0 },
      contextWindow: 200_000,
    });
    expect(vm!.usedTokens).toBe(0);
    expect(vm!.ratio).toBe(0);
    expect(vm!.contextWindow).toBe(200_000);
  });
});

describe("latestContextUsageInput", () => {
  it.each(["claude", "opencode", "cursor", "droid"])(
    "invalidates stale same-turn %s usage after compaction",
    (provider) => {
      const events = [
        envelope(1, { type: "done", turnId: "turn-1", status: "completed", usage: { inputTokens: 200_000, contextWindow: 200_000 } }),
        envelope(2, { type: "context_compact", trigger: "auto", state: "completed", turnId: "turn-1" }),
        envelope(3, { type: "done", turnId: "turn-1", status: "completed", usage: { inputTokens: 200_000, contextWindow: 200_000 } }),
      ] as any;
      const before = toUsageViewModel(latestContextUsageInput(events.slice(0, 1), provider));
      expect(before?.usedTokens).toBe(200_000);
      expect(before?.ratio).toBe(1);
      expect(latestContextUsageInput(events, provider)).toBeNull();
    },
  );

  it("uses Claude postTokens at the compaction boundary", () => {
    const events = [
      envelope(1, { type: "done", turnId: "turn-1", status: "completed", usage: { inputTokens: 190_000, contextWindow: 200_000 } }),
      envelope(2, { type: "context_compact", trigger: "auto", state: "completed", turnId: "turn-1", postTokens: 24_000 }),
      envelope(3, { type: "done", turnId: "turn-1", status: "completed", usage: { inputTokens: 210_000, contextWindow: 200_000 } }),
    ] as any;
    const input = latestContextUsageInput(events, "claude");
    const viewModel = toUsageViewModel(input, 200_000);
    expect(viewModel?.usedTokens).toBe(24_000);
    expect(viewModel?.contextWindow).toBe(200_000);
    expect(viewModel?.ratio).toBe(0.12);
  });

  it("allows an exact Codex usage update from the compaction turn", () => {
    const events = [
      envelope(1, { type: "codex_token_usage", usage: { last: { inputTokens: 190_000 }, modelContextWindow: 200_000 }, turnId: "turn-1" }),
      envelope(2, { type: "context_compact", trigger: "auto", state: "completed", turnId: "turn-1" }),
      envelope(3, { type: "codex_token_usage", usage: { last: { inputTokens: 26_000 }, modelContextWindow: 200_000 }, turnId: "turn-1" }),
    ] as any;
    const input = latestContextUsageInput(events, "codex");
    const viewModel = toUsageViewModel(input, 200_000);
    expect(viewModel?.usedTokens).toBe(26_000);
    expect(viewModel?.contextWindow).toBe(200_000);
    expect(viewModel?.ratio).toBe(0.13);
  });

  it("ignores metadata-only Codex usage after compaction but accepts an explicit zero", () => {
    const metadataOnlyEvents = [
      envelope(1, { type: "codex_token_usage", usage: { last: { inputTokens: 190_000 }, modelContextWindow: 200_000 }, turnId: "turn-1" }),
      envelope(2, { type: "context_compact", trigger: "auto", state: "completed", turnId: "turn-1" }),
      envelope(3, { type: "codex_token_usage", usage: { modelContextWindow: 200_000 }, turnId: "turn-1" }),
      envelope(4, { type: "done", turnId: "turn-1", status: "completed", usage: { inputTokens: 190_000, contextWindow: 200_000 } }),
    ] as any;
    expect(latestContextUsageInput(metadataOnlyEvents, "codex")).toBeNull();

    const explicitZero = latestContextUsageInput([
      envelope(1, { type: "context_compact", trigger: "auto", state: "completed", turnId: "turn-1" }),
      envelope(2, { type: "codex_token_usage", usage: { last: { inputTokens: 0 }, modelContextWindow: 200_000 }, turnId: "turn-1" }),
    ] as any, "codex");
    const viewModel = toUsageViewModel(explicitZero);
    expect(viewModel?.usedTokens).toBe(0);
    expect(viewModel?.contextWindow).toBe(200_000);
    expect(viewModel?.ratio).toBe(0);
  });

  it("prefers Claude's exact context_usage snapshot", () => {
    const input = latestContextUsageInput([
      envelope(1, { type: "context_usage", usage: { categories: [], totalTokens: 31_000, maxTokens: 200_000, percentage: 15.5 } }),
    ] as any, "claude");
    const viewModel = toUsageViewModel(input);
    expect(viewModel?.usedTokens).toBe(31_000);
    expect(viewModel?.contextWindow).toBe(200_000);
    expect(viewModel?.ratio).toBeCloseTo(0.155, 5);
  });
});

describe("formatContextTokens", () => {
  it("formats thousands and millions", () => {
    expect(formatContextTokens(132_700)).toBe("132.7k");
    expect(formatContextTokens(1_200_000)).toBe("1.2M");
    expect(formatContextTokens(972)).toBe("972");
  });

  it("returns null for non-positive / missing values", () => {
    expect(formatContextTokens(0)).toBe("0");
    expect(formatContextTokens(null)).toBeNull();
    expect(formatContextTokens(undefined)).toBeNull();
    expect(formatContextTokens(-5)).toBeNull();
  });
});
