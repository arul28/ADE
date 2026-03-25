import { describe, expect, it } from "vitest";
import {
  ALL_MODELS,
  BUILT_IN_PROFILES,
  CLAUDE_MODELS,
  CLAUDE_THINKING_LEVELS,
  CODEX_MODELS,
  CODEX_THINKING_LEVELS,
  findModel,
  getModelsForProvider,
  getProfileById,
  getThinkingLevels,
  MODEL_PRICING,
  modelConfigToServiceModel,
  ORCHESTRATOR_CALL_TYPES,
  resolveCallTypeModel,
  thinkingLevelToReasoningEffort,
  updateModelPricing,
} from "./modelProfiles";

// ---------------------------------------------------------------------------
// Model catalogs
// ---------------------------------------------------------------------------

describe("model catalogs", () => {
  it("CLAUDE_MODELS contains only anthropic CLI-wrapped models", () => {
    expect(CLAUDE_MODELS.length).toBeGreaterThan(0);
    for (const m of CLAUDE_MODELS) {
      expect(m.provider).toBe("claude");
      expect(m.modelId).toMatch(/^anthropic\//);
    }
  });

  it("CODEX_MODELS contains only codex-provider models", () => {
    expect(CODEX_MODELS.length).toBeGreaterThan(0);
    for (const m of CODEX_MODELS) {
      expect(m.provider).toBe("codex");
      expect(m.modelId).toMatch(/^openai\//);
    }
  });

  it("ALL_MODELS contains entries from multiple providers", () => {
    const providers = new Set(ALL_MODELS.map((m) => m.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
    expect(providers.has("claude")).toBe(true);
    expect(providers.has("codex")).toBe(true);
  });

  it("every ModelEntry has the required shape", () => {
    for (const m of ALL_MODELS) {
      expect(typeof m.provider).toBe("string");
      expect(typeof m.modelId).toBe("string");
      expect(typeof m.displayName).toBe("string");
      expect(["low", "medium", "high", "very_high"]).toContain(m.costTier);
    }
  });

  it("marks exactly one Claude model as recommended", () => {
    const recommended = CLAUDE_MODELS.filter((m) => m.recommended);
    expect(recommended.length).toBe(1);
  });

  it("marks exactly one Codex model as recommended", () => {
    const recommended = CODEX_MODELS.filter((m) => m.recommended);
    expect(recommended.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findModel
// ---------------------------------------------------------------------------

describe("findModel", () => {
  it("returns a ModelEntry for a known model", () => {
    const entry = findModel("anthropic/claude-sonnet-4-6");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("claude");
    expect(entry!.displayName).toContain("Sonnet");
  });

  it("returns undefined for an unknown model ID", () => {
    expect(findModel("nonexistent/model")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(findModel("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getModelsForProvider
// ---------------------------------------------------------------------------

describe("getModelsForProvider", () => {
  it("returns only claude models for 'claude'", () => {
    const models = getModelsForProvider("claude");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.provider).toBe("claude");
    }
  });

  it("returns only codex models for 'codex'", () => {
    const models = getModelsForProvider("codex");
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.provider).toBe("codex");
    }
  });

  it("returns an empty array for an unknown provider", () => {
    expect(getModelsForProvider("nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Thinking levels
// ---------------------------------------------------------------------------

describe("thinking levels", () => {
  it("CLAUDE_THINKING_LEVELS has three levels", () => {
    expect(CLAUDE_THINKING_LEVELS).toHaveLength(3);
    expect(CLAUDE_THINKING_LEVELS.map((t) => t.value)).toEqual(["low", "medium", "high"]);
  });

  it("CODEX_THINKING_LEVELS has four levels including xhigh", () => {
    expect(CODEX_THINKING_LEVELS).toHaveLength(4);
    expect(CODEX_THINKING_LEVELS.map((t) => t.value)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("getThinkingLevels returns claude levels for 'claude'", () => {
    expect(getThinkingLevels("claude")).toBe(CLAUDE_THINKING_LEVELS);
  });

  it("getThinkingLevels returns codex levels for 'codex'", () => {
    expect(getThinkingLevels("codex")).toBe(CODEX_THINKING_LEVELS);
  });

  it("getThinkingLevels returns a 3-level default for unknown providers", () => {
    const levels = getThinkingLevels("unknown-provider");
    expect(levels).toHaveLength(3);
    expect(levels.map((t) => t.value)).toEqual(["low", "medium", "high"]);
  });
});

// ---------------------------------------------------------------------------
// ORCHESTRATOR_CALL_TYPES
// ---------------------------------------------------------------------------

describe("ORCHESTRATOR_CALL_TYPES", () => {
  it("contains coordinator and chat_response entries", () => {
    const keys = ORCHESTRATOR_CALL_TYPES.map((c) => c.key);
    expect(keys).toContain("coordinator");
    expect(keys).toContain("chat_response");
  });

  it("every entry has a label, description, and defaultProvider", () => {
    for (const ct of ORCHESTRATOR_CALL_TYPES) {
      expect(typeof ct.label).toBe("string");
      expect(ct.label.length).toBeGreaterThan(0);
      expect(typeof ct.description).toBe("string");
      expect(ct.description.length).toBeGreaterThan(0);
      expect(typeof ct.defaultProvider).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

describe("BUILT_IN_PROFILES", () => {
  it("has exactly 5 built-in profiles", () => {
    expect(BUILT_IN_PROFILES).toHaveLength(5);
  });

  const expectedIds = ["standard", "fast-cheap", "max-quality", "codex-only", "claude-only"];

  it.each(expectedIds)("contains the '%s' profile", (id) => {
    const profile = BUILT_IN_PROFILES.find((p) => p.id === id);
    expect(profile).toBeDefined();
    expect(profile!.isBuiltIn).toBe(true);
  });

  it("every profile has a valid structure", () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(typeof profile.id).toBe("string");
      expect(typeof profile.name).toBe("string");
      expect(typeof profile.description).toBe("string");
      expect(profile.isBuiltIn).toBe(true);
      expect(profile.orchestratorModel).toBeDefined();
      expect(profile.orchestratorModel.modelId).toBeTruthy();
      expect(profile.phaseDefaults).toBeDefined();
      expect(profile.phaseDefaults.planning).toBeDefined();
      expect(profile.phaseDefaults.implementation).toBeDefined();
      expect(profile.phaseDefaults.testing).toBeDefined();
      expect(profile.phaseDefaults.validation).toBeDefined();
      expect(profile.phaseDefaults.codeReview).toBeDefined();
      expect(profile.phaseDefaults.testReview).toBeDefined();
      expect(profile.intelligenceConfig).toBeDefined();
    }
  });

  it("codex-only profile uses only codex-provider models", () => {
    const profile = getProfileById("codex-only")!;
    expect(profile.orchestratorModel.provider).toBe("codex");
    expect(profile.phaseDefaults.planning.provider).toBe("codex");
    expect(profile.phaseDefaults.implementation.provider).toBe("codex");
  });

  it("claude-only profile uses only claude-provider models", () => {
    const profile = getProfileById("claude-only")!;
    expect(profile.orchestratorModel.provider).toBe("claude");
    expect(profile.phaseDefaults.planning.provider).toBe("claude");
    expect(profile.phaseDefaults.implementation.provider).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// getProfileById
// ---------------------------------------------------------------------------

describe("getProfileById", () => {
  it("returns the standard profile by id", () => {
    const profile = getProfileById("standard");
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("Standard");
  });

  it("returns undefined for an unknown profile id", () => {
    expect(getProfileById("nonexistent")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getProfileById("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveCallTypeModel
// ---------------------------------------------------------------------------

describe("resolveCallTypeModel", () => {
  it("returns explicit config when present in intelligenceConfig", () => {
    const config = { provider: "codex" as const, modelId: "openai/gpt-5.4-codex", thinkingLevel: "high" as const };
    const result = resolveCallTypeModel("coordinator", { coordinator: config });
    expect(result).toBe(config);
  });

  it("falls back to fallbackModel when intelligenceConfig has no entry", () => {
    const fallback = { provider: "claude" as const, modelId: "anthropic/claude-haiku-4-5", thinkingLevel: "low" as const };
    const result = resolveCallTypeModel("coordinator", {}, fallback);
    expect(result).toBe(fallback);
  });

  it("falls back to fallbackModel when intelligenceConfig is null", () => {
    const fallback = { provider: "codex" as const, modelId: "openai/gpt-5.4-codex" };
    const result = resolveCallTypeModel("chat_response", null, fallback);
    expect(result).toBe(fallback);
  });

  it("falls back to fallbackModel when intelligenceConfig is undefined", () => {
    const fallback = { provider: "codex" as const, modelId: "openai/gpt-5.4-codex" };
    const result = resolveCallTypeModel("coordinator", undefined, fallback);
    expect(result).toBe(fallback);
  });

  it("returns ultimate fallback (Claude Sonnet) when no config or fallback", () => {
    const result = resolveCallTypeModel("coordinator");
    expect(result.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(result.provider).toBe("claude");
  });

  it("returns ultimate fallback when both intelligenceConfig and fallback are null", () => {
    const result = resolveCallTypeModel("chat_response", null, null);
    expect(result.modelId).toBe("anthropic/claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// modelConfigToServiceModel
// ---------------------------------------------------------------------------

describe("modelConfigToServiceModel", () => {
  it("returns the modelId when it is a non-empty string", () => {
    expect(modelConfigToServiceModel({ modelId: "anthropic/claude-opus-4-6" })).toBe("anthropic/claude-opus-4-6");
  });

  it("falls back to default codex model when modelId is empty and provider is codex", () => {
    const result = modelConfigToServiceModel({ provider: "codex", modelId: "" });
    expect(result).toMatch(/^openai\//);
  });

  it("falls back to claude-sonnet-4-6 when modelId is empty and provider is claude", () => {
    expect(modelConfigToServiceModel({ provider: "claude", modelId: "" })).toBe("anthropic/claude-sonnet-4-6");
  });

  it("falls back to claude-sonnet-4-6 when modelId is whitespace only", () => {
    expect(modelConfigToServiceModel({ provider: "claude", modelId: "   " })).toBe("anthropic/claude-sonnet-4-6");
  });

  it("falls back to claude-sonnet-4-6 when provider is unknown and modelId is empty", () => {
    expect(modelConfigToServiceModel({ provider: "unknown", modelId: "" })).toBe("anthropic/claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// thinkingLevelToReasoningEffort
// ---------------------------------------------------------------------------

describe("thinkingLevelToReasoningEffort", () => {
  it("maps 'low' to 'low'", () => {
    expect(thinkingLevelToReasoningEffort("low")).toBe("low");
  });

  it("maps 'medium' to 'medium'", () => {
    expect(thinkingLevelToReasoningEffort("medium")).toBe("medium");
  });

  it("maps 'high' to 'high'", () => {
    expect(thinkingLevelToReasoningEffort("high")).toBe("high");
  });

  it("maps 'xhigh' to 'xhigh'", () => {
    expect(thinkingLevelToReasoningEffort("xhigh")).toBe("xhigh");
  });

  it("maps 'none' to 'low'", () => {
    expect(thinkingLevelToReasoningEffort("none")).toBe("low");
  });

  it("maps 'minimal' to 'low'", () => {
    expect(thinkingLevelToReasoningEffort("minimal")).toBe("low");
  });

  it("maps 'max' to 'high'", () => {
    expect(thinkingLevelToReasoningEffort("max")).toBe("high");
  });

  it("returns 'low' for null", () => {
    expect(thinkingLevelToReasoningEffort(null)).toBe("low");
  });

  it("returns 'low' for undefined", () => {
    expect(thinkingLevelToReasoningEffort(undefined)).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// MODEL_PRICING (Proxy)
// ---------------------------------------------------------------------------

describe("MODEL_PRICING", () => {
  it("returns pricing for a known sdkModelId via proxy get", () => {
    const pricing = MODEL_PRICING["sonnet"];
    expect(pricing).toBeDefined();
    expect(typeof pricing.input).toBe("number");
    expect(typeof pricing.output).toBe("number");
  });

  it("returns undefined for an unknown sdkModelId", () => {
    expect(MODEL_PRICING["nonexistent-model-xyz"]).toBeUndefined();
  });

  it("supports 'in' operator via has trap", () => {
    expect("sonnet" in MODEL_PRICING).toBe(true);
    expect("nonexistent-model-xyz" in MODEL_PRICING).toBe(false);
  });

  it("getOwnPropertyDescriptor returns pricing for known models", () => {
    const desc = Object.getOwnPropertyDescriptor(MODEL_PRICING, "sonnet");
    expect(desc).toBeDefined();
    expect(desc!.value).toEqual(expect.objectContaining({ input: expect.any(Number), output: expect.any(Number) }));
  });

  it("getOwnPropertyDescriptor returns undefined for unknown models", () => {
    const desc = Object.getOwnPropertyDescriptor(MODEL_PRICING, "nonexistent-model-xyz");
    expect(desc).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateModelPricing
// ---------------------------------------------------------------------------

describe("updateModelPricing", () => {
  it("returns the count of updated entries", () => {
    const count = updateModelPricing({
      "test-model-a": { input: 1, output: 2 },
      "test-model-b": { input: 3, output: 4 },
    });
    expect(count).toBe(2);
  });

  it("makes updated pricing accessible through MODEL_PRICING proxy", () => {
    updateModelPricing({ "test-proxy-model": { input: 10, output: 20 } });
    expect(MODEL_PRICING["test-proxy-model"]).toEqual({ input: 10, output: 20 });
  });
});
