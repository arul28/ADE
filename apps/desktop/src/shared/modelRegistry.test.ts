import { describe, expect, it } from "vitest";
import {
  createDynamicLocalModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  decodeOpenCodeRegistryId,
  encodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
  getAvailableModels,
  getDefaultModelDescriptor,
  getModelById,
  getModelDescriptorForPermissionMode,
  getRuntimeModelRefForDescriptor,
  listModelDescriptorsForProvider,
  MODEL_REGISTRY,
  resolveModelAlias,
  resolveModelDescriptor,
  resolveModelDescriptorForProvider,
} from "./modelRegistry";
import type { ProviderFamily } from "./modelRegistry";
import { describeModelSource } from "../renderer/lib/modelOptions";

describe("modelRegistry", () => {
  it("round-trips OpenCode registry ids with slashes inside model ids", () => {
    const id = encodeOpenCodeRegistryId("lmstudio", "openai/gpt-oss-20b");
    expect(id).toMatch(/^opencode\/lmstudio\//);
    expect(decodeOpenCodeRegistryId(id)).toEqual({
      openCodeProviderId: "lmstudio",
      openCodeModelId: "openai/gpt-oss-20b",
    });
    const d = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "lmstudio",
      openCodeModelId: "openai/gpt-oss-20b",
      displayName: "GPT OSS 20B",
    });
    expect(d.id).toBe(id);
    expect(d.openCodeProviderId).toBe("lmstudio");
    expect(d.openCodeModelId).toBe("openai/gpt-oss-20b");
  });

  it("resolves runtime-discovered local model ids", () => {
    const descriptor = resolveModelDescriptor("ollama/qwen2.5-coder:32b");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.family).toBe("ollama");
    expect(descriptor?.providerModelId).toBe("qwen2.5-coder:32b");
    expect(descriptor?.displayName).toBe("qwen2.5-coder:32b (Ollama)");
  });

  it("returns dynamic local descriptors from getModelById", () => {
    const descriptor = getModelById("lmstudio/meta-llama-3.1-70b-instruct");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.family).toBe("lmstudio");
    expect(descriptor?.providerRoute).toBe("openai-compatible");
    expect(descriptor?.authTypes).toEqual(["local"]);
  });

  it("creates stable descriptor ids for local models", () => {
    const descriptor = createDynamicLocalModelDescriptor("lmstudio", "Qwen/Qwen2.5-Coder");
    expect(descriptor.id).toBe("lmstudio/Qwen/Qwen2.5-Coder");
    expect(descriptor.providerModelId).toBe("Qwen/Qwen2.5-Coder");
  });

  it("keeps only the allowed OpenAI chat models in the registry defaults", () => {
    expect(listModelDescriptorsForProvider("codex").map((model) => model.id)).toEqual([
      "openai/gpt-5.4-codex",
      "openai/gpt-5.4-mini-codex",
      "openai/gpt-5.3-codex",
      "openai/gpt-5.3-codex-spark",
      "openai/gpt-5.2-codex",
      "openai/gpt-5.1-codex-max",
      "openai/gpt-5.1-codex-mini",
    ]);

    // API-key OpenAI models are now discovered dynamically through OpenCode,
    // so the static registry yields no hits for api-key auth alone.
    expect(getAvailableModels([{ type: "api-key", provider: "openai" }]).map((model) => model.id)).toEqual([]);
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.4-codex");
  });

  it("exposes GPT-5.4-Mini-Codex with the expected reasoning tiers", () => {
    expect(getModelById("openai/gpt-5.4-mini-codex")).toMatchObject({
      displayName: "GPT-5.4-Mini",
      reasoningTiers: ["low", "medium", "high", "xhigh"],
    });
  });

  it("marks CLI-wrapped models as CLI subscription in the shared model source helper", () => {
    expect(describeModelSource(getModelById("openai/gpt-5.4-codex")!)).toBe("CLI subscription");
  });

  it("returns undefined for unknown model IDs", () => {
    expect(getModelById("openai/gpt-99")).toBeUndefined();
    expect(resolveModelDescriptor("nonexistent/model-id")).toBeUndefined();
  });

  it("getModelDescriptorForPermissionMode matches getModelById for known locals", () => {
    const id = "ollama/qwen2.5-coder:32b";
    expect(getModelDescriptorForPermissionMode(id)).toEqual(getModelById(id));
  });

  it("getModelDescriptorForPermissionMode yields guarded local for ollama/auto when getModelById is undefined", () => {
    expect(getModelById("ollama/auto")).toBeUndefined();
    const perm = getModelDescriptorForPermissionMode("ollama/auto");
    expect(perm?.family).toBe("ollama");
    expect(perm?.harnessProfile).toBe("guarded");
    expect(perm?.authTypes).toContain("local");
  });

  it("returns undefined for bare gpt-5.4 alias since API-key variants are now OpenCode-dynamic", () => {
    const resolved = resolveModelAlias("gpt-5.4");
    expect(resolved).toBeUndefined();
  });

  it("resolves gpt-5.4 to the Codex wrapper when the provider is codex", () => {
    const resolved = resolveModelDescriptorForProvider("gpt-5.4", "codex");
    expect(resolved?.id).toBe("openai/gpt-5.4-codex");
  });

  it("resolves gpt-5.4-codex shortId to the codex variant", () => {
    const resolved = resolveModelAlias("gpt-5.4-codex");
    expect(resolved).toBeTruthy();
    expect(resolved?.id).toBe("openai/gpt-5.4-codex");
  });

  it("returns the real Codex runtime model name for wrapped GPT-5.4", () => {
    const descriptor = getModelById("openai/gpt-5.4-codex");
    expect(descriptor).toBeTruthy();
    expect(getRuntimeModelRefForDescriptor(descriptor!, "codex")).toBe("gpt-5.4");
  });

  describe("Claude Opus 4.7 descriptors", () => {
    it("exposes the standard Opus 4.7 with the expected context window and pricing", () => {
      const opus = getModelById("anthropic/claude-opus-4-7");
      expect(opus).toBeTruthy();
      expect(opus).toMatchObject({
        displayName: "Claude Opus 4.7",
        shortId: "opus",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-opus-4-7",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 5,
        outputPricePer1M: 25,
      });
    });

    it("exposes the 1M Opus 4.7 variant with the xhigh reasoning tier and legacy aliases", () => {
      const opus1m = getModelById("anthropic/claude-opus-4-7-1m");
      expect(opus1m).toBeTruthy();
      expect(opus1m).toMatchObject({
        shortId: "opus-1m",
        displayName: "Claude Opus 4.7 1M",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        providerModelId: "claude-opus-4-7[1m]",
      });
      expect(opus1m?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(opus1m?.aliases).toContain("opus[1m]");
      expect(opus1m?.aliases).toContain("claude-opus-4-7[1m]");
    });

    it("resolves the legacy opus[1m] alias to the 4.7 1M descriptor", () => {
      const resolved = resolveModelAlias("opus[1m]");
      expect(resolved?.id).toBe("anthropic/claude-opus-4-7-1m");
    });

    it("no longer exposes any claude-opus-4-6 ids in the registry", () => {
      const legacyIds = MODEL_REGISTRY.filter((m) => m.id.includes("claude-opus-4-6")).map((m) => m.id);
      expect(legacyIds).toEqual([]);
      expect(getModelById("anthropic/claude-opus-4-6")).toBeUndefined();
      expect(getModelById("anthropic/claude-opus-4-6-1m")).toBeUndefined();
    });
  });

  it("does not contain groq, together, or meta provider families", () => {
    const families = new Set<ProviderFamily>(MODEL_REGISTRY.map((m) => m.family));
    expect(families.has("groq" as ProviderFamily)).toBe(false);
    expect(families.has("together" as ProviderFamily)).toBe(false);
    expect(families.has("meta" as ProviderFamily)).toBe(false);
  });

  it("filters out deprecated models from getAvailableModels", () => {
    const allAuth = [
      { type: "api-key" as const, provider: "openai" },
      { type: "api-key" as const, provider: "anthropic" },
      { type: "cli-subscription" as const },
      { type: "local" as const },
      { type: "openrouter" as const },
    ];
    const available = getAvailableModels(allAuth);
    const deprecatedIds = MODEL_REGISTRY.filter((m) => m.deprecated).map((m) => m.id);
    for (const id of deprecatedIds) {
      expect(available.find((m) => m.id === id)).toBeUndefined();
    }
  });

  it("returns undefined for empty string, undefined-like, and whitespace aliases", () => {
    expect(resolveModelAlias("")).toBeUndefined();
    expect(resolveModelAlias("   ")).toBeUndefined();
    expect(resolveModelDescriptor("")).toBeUndefined();
    expect(resolveModelDescriptor("   ")).toBeUndefined();
  });

  describe("ensureOpenCodeBaseURL", () => {
    it("appends /v1 when missing", () => {
      expect(ensureOpenCodeBaseURL("http://localhost:1234")).toBe("http://localhost:1234/v1");
    });
    it("strips trailing slash before appending /v1", () => {
      expect(ensureOpenCodeBaseURL("http://localhost:1234/")).toBe("http://localhost:1234/v1");
    });
    it("preserves existing /v1 suffix", () => {
      expect(ensureOpenCodeBaseURL("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    });
    it("strips trailing slash from /v1/", () => {
      expect(ensureOpenCodeBaseURL("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
    });
  });
});
