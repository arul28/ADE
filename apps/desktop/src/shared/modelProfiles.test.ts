import { describe, expect, it } from "vitest";
import { findModel, getModelsForProvider, getThinkingLevels, MODEL_PRICING, modelConfigToServiceModel, thinkingLevelToReasoningEffort, updateModelPricing } from "./modelProfiles";

describe("findModel", () => {
  it("finds a known model and returns undefined for an unknown or empty id", () => {
    expect(findModel("anthropic/claude-sonnet-5")?.provider).toBe("claude");
    expect(findModel("nonexistent/model")).toBeUndefined();
    expect(findModel("")).toBeUndefined();
  });
});

describe("getModelsForProvider", () => {
  it.each(["claude", "codex"])("returns only %s models", (provider) => {
    const models = getModelsForProvider(provider);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(m.provider).toBe(provider);
  });

  it("returns an empty array for an unknown provider", () => {
    expect(getModelsForProvider("nonexistent")).toEqual([]);
  });
});

describe("getThinkingLevels", () => {
  it("returns a 3-level default for unknown providers", () => {
    expect(getThinkingLevels("unknown-provider").map((t) => t.value)).toEqual(["low", "medium", "high"]);
  });
});

describe("modelConfigToServiceModel", () => {
  it.each([
    ["a non-empty model id", { modelId: "anthropic/claude-opus-4-8" }, "anthropic/claude-opus-4-8"],
    ["an empty id on claude", { provider: "claude", modelId: "" }, "anthropic/claude-opus-5-5"],
    ["a whitespace id on claude", { provider: "claude", modelId: "   " }, "anthropic/claude-opus-5-5"],
    ["an empty id on an unknown provider", { provider: "unknown", modelId: "" }, "anthropic/claude-opus-5-5"],
  ])("resolves %s", (_name, config, expected) => {
    expect(modelConfigToServiceModel(config)).toBe(expected);
  });

  it("falls back to the default Codex model for an empty id on codex", () => {
    expect(modelConfigToServiceModel({ provider: "codex", modelId: "" })).toMatch(/^openai\//);
  });
});

describe("thinkingLevelToReasoningEffort", () => {
  it.each([
    ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"],
    ["max", "max"], ["ultracode", "ultracode"], ["ultra", "ultra"],
    ["none", "low"], ["minimal", "low"], [null, "low"], [undefined, "low"],
  ])("maps %s to %s", (level, effort) => {
    expect(thinkingLevelToReasoningEffort(level as never)).toBe(effort);
  });
});

describe("MODEL_PRICING and updateModelPricing", () => {
  it("serves known pricing, not unknown, and reflects updates", () => {
    expect(typeof MODEL_PRICING["claude-sonnet-5"]?.input).toBe("number");
    expect(MODEL_PRICING["nonexistent-model-xyz"]).toBeUndefined();
    expect(updateModelPricing({ "test-model-a": { input: 1, output: 2 }, "test-proxy-model": { input: 10, output: 20 } })).toBe(2);
    expect(MODEL_PRICING["test-proxy-model"]).toEqual({ input: 10, output: 20 });
  });
});
