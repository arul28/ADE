import { describe, it, expect } from "vitest";
import { toUsageViewModel, formatContextTokens } from "./contextUsageModel";

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
});

describe("formatContextTokens", () => {
  it("formats thousands and millions", () => {
    expect(formatContextTokens(132_700)).toBe("132.7k");
    expect(formatContextTokens(1_200_000)).toBe("1.2M");
    expect(formatContextTokens(972)).toBe("972");
  });

  it("returns null for non-positive / missing values", () => {
    expect(formatContextTokens(0)).toBeNull();
    expect(formatContextTokens(null)).toBeNull();
    expect(formatContextTokens(undefined)).toBeNull();
    expect(formatContextTokens(-5)).toBeNull();
  });
});
