import { describe, expect, it } from "vitest";
import {
  createDynamicLocalModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  decodeOpenCodeRegistryId,
  droidCliLineGroupFromModelId,
  droidCliLineGroupLabel,
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
  resolveCursorCliModelVariant,
  resolveModelDescriptor,
  resolveModelDescriptorForProvider,
  resolveModelSlug,
} from "./modelRegistry";
import type { ModelDescriptor, ProviderFamily } from "./modelRegistry";
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

  it("resolveModelSlug returns canonical id for registry input and codex-hinted refs", () => {
    const byId = resolveModelSlug("  anthropic/claude-opus-4-8  ");
    expect(byId).toBe("anthropic/claude-opus-4-8");
    expect(resolveModelSlug("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(resolveModelSlug("gpt-5.5")).toBe("openai/gpt-5.5");
    expect(resolveModelSlug("gpt-5.4", "codex")).toBe("openai/gpt-5.4");
    expect(resolveModelSlug("gpt-5.5", "codex")).toBe("openai/gpt-5.5");
    expect(resolveModelSlug("")).toBeUndefined();
    expect(resolveModelSlug("   ")).toBeUndefined();
    expect(resolveModelSlug("not-a-real-model-xyz")).toBeUndefined();
  });

  it("resolveModelSlug preserves case-sensitive dynamic local ids when hinted", () => {
    const id = "lmstudio/Qwen/Qwen2.5-Coder";
    expect(resolveModelSlug(id, "opencode")).toBe(id);
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
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.3-codex",
      "openai/gpt-5.3-codex-spark",
      "openai/gpt-5.2",
    ]);

    // API-key OpenAI models are now discovered dynamically through OpenCode,
    // so the static registry yields no hits for api-key auth alone.
    expect(getAvailableModels([{ type: "api-key", provider: "openai" }]).map((model) => model.id)).toEqual([]);
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.5");
  });

  it("exposes GPT-5.5 with the real OpenAI model id and expected reasoning tiers", () => {
    expect(getModelById("openai/gpt-5.5")).toMatchObject({
      displayName: "GPT-5.5",
      providerRoute: "codex-cli",
      providerModelId: "gpt-5.5",
      reasoningTiers: ["low", "medium", "high", "xhigh"],
    });
  });

  it("exposes GPT-5.4-Mini with the expected reasoning tiers", () => {
    expect(getModelById("openai/gpt-5.4-mini")).toMatchObject({
      displayName: "GPT-5.4-Mini",
      reasoningTiers: ["low", "medium", "high", "xhigh"],
    });
  });

  it("exposes GPT-5.3-Codex-Spark as a Codex CLI model", () => {
    expect(getModelById("openai/gpt-5.3-codex-spark")).toMatchObject({
      displayName: "GPT-5.3-Codex-Spark",
      providerRoute: "codex-cli",
      providerModelId: "gpt-5.3-codex-spark",
      cliCommand: "codex",
      isCliWrapped: true,
      family: "openai",
      contextWindow: 128_000,
      capabilities: expect.objectContaining({ vision: false, reasoning: true }),
    });
    expect(resolveModelAlias("spark")?.id).toBe("openai/gpt-5.3-codex-spark");
  });

  it("exposes GPT-5.2 as a Codex CLI model", () => {
    expect(getModelById("openai/gpt-5.2")).toMatchObject({
      displayName: "GPT-5.2",
      providerRoute: "codex-cli",
      providerModelId: "gpt-5.2",
      cliCommand: "codex",
      isCliWrapped: true,
      family: "openai",
    });
    expect(resolveModelAlias("gpt-5.2-codex")?.id).toBe("openai/gpt-5.2");
  });

  it("marks CLI-wrapped models as CLI subscription in the shared model source helper", () => {
    expect(describeModelSource(getModelById("openai/gpt-5.5")!)).toBe("CLI subscription");
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

  it("resolves bare gpt-5.4 to the real OpenAI registry id", () => {
    const resolved = resolveModelAlias("gpt-5.4");
    expect(resolved?.id).toBe("openai/gpt-5.4");
  });

  it("resolves bare gpt-5.5 to the real OpenAI registry id", () => {
    const resolved = resolveModelAlias("gpt-5.5");
    expect(resolved?.id).toBe("openai/gpt-5.5");
  });

  it("resolves gpt-5.4 to the real OpenAI model when the provider is codex", () => {
    const resolved = resolveModelDescriptorForProvider("gpt-5.4", "codex");
    expect(resolved?.id).toBe("openai/gpt-5.4");
  });

  it("resolves gpt-5.5 to the real OpenAI model when the provider is codex", () => {
    const resolved = resolveModelDescriptorForProvider("gpt-5.5", "codex");
    expect(resolved?.id).toBe("openai/gpt-5.5");
  });

  it("resolves the old gpt-5.4-codex alias to the real GPT-5.4 registry id", () => {
    const resolved = resolveModelAlias("gpt-5.4-codex");
    expect(resolved).toBeTruthy();
    expect(resolved?.id).toBe("openai/gpt-5.4");
  });

  it("returns the real Codex runtime model name for GPT-5.4", () => {
    const descriptor = getModelById("openai/gpt-5.4");
    expect(descriptor).toBeTruthy();
    expect(getRuntimeModelRefForDescriptor(descriptor!, "codex")).toBe("gpt-5.4");
  });

  it("returns the real Codex app-server runtime model name for GPT-5.5", () => {
    const descriptor = getModelById("openai/gpt-5.5");
    expect(descriptor).toBeTruthy();
    expect(getRuntimeModelRefForDescriptor(descriptor!, "codex")).toBe("gpt-5.5");
  });

  it("resolves Cursor CLI abstract picker controls to concrete model ids", () => {
    const descriptor = {
      id: "cursor/claude-opus-4-7-thinking",
      shortId: "claude-opus-4-7-thinking",
      displayName: "Opus 4.7 1M Thinking",
      family: "cursor" as const,
      authTypes: ["api-key"],
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
      color: "#D97706",
      providerRoute: "cursor-sdk",
      providerModelId: "claude-opus-4-7-thinking",
      cliCommand: "cursor",
      isCliWrapped: false,
      cursorCliVariants: [
        { modelId: "claude-opus-4-7-thinking-low", reasoningEffort: "low", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-low-fast", reasoningEffort: "low", fastMode: true },
        { modelId: "claude-opus-4-7-thinking-medium", reasoningEffort: "medium", fastMode: false },
        { modelId: "claude-opus-4-7-thinking-medium-fast", reasoningEffort: "medium", fastMode: true },
      ],
    } satisfies ModelDescriptor;

    expect(resolveCursorCliModelVariant(descriptor, {
      reasoningEffort: "medium",
      fastMode: true,
    })).toBe("claude-opus-4-7-thinking-medium-fast");
    expect(resolveCursorCliModelVariant(descriptor, {
      reasoningEffort: "low",
      fastMode: false,
    })).toBe("claude-opus-4-7-thinking-low");
    expect(resolveCursorCliModelVariant(descriptor, {
      reasoningEffort: "high",
      fastMode: true,
    })).toBe("claude-opus-4-7-thinking-low-fast");
  });

  describe("Claude descriptors", () => {
    it("adds Fable 5 above Opus 4.8 in the Claude model registry", () => {
      expect(MODEL_REGISTRY.filter((model) => model.family === "anthropic").slice(0, 4).map((model) => model.id)).toEqual([
        "anthropic/claude-fable-5",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-opus-4-7-1m",
      ]);
      const fable = getModelById("anthropic/claude-fable-5");
      expect(fable).toBeTruthy();
      expect(fable).toMatchObject({
        displayName: "Claude Fable 5",
        shortId: "fable",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-fable-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 10,
        outputPricePer1M: 50,
      });
      expect(fable?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
      expect(resolveModelAlias("fable")?.id).toBe("anthropic/claude-fable-5");

      const opus = getModelById("anthropic/claude-opus-4-8");
      expect(opus).toBeTruthy();
      expect(opus).toMatchObject({
        displayName: "Claude Opus 4.8 1M",
        shortId: "opus-4.8-1m",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-opus-4-8",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 5,
        outputPricePer1M: 25,
      });
      expect(opus?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
      expect(opus?.serviceTiers).toEqual(["fast"]);
    });

    it("keeps Opus 4.7 and Opus 4.7 1M as distinct selectable models", () => {
      expect(getModelById("anthropic/claude-opus-4-7")).toMatchObject({
        displayName: "Claude Opus 4.7",
        shortId: "opus",
        providerModelId: "claude-opus-4-7",
        contextWindow: 200_000,
      });
      expect(getModelById("anthropic/claude-opus-4-7-1m")).toMatchObject({
        displayName: "Claude Opus 4.7 1M",
        shortId: "opus-1m",
        providerModelId: "claude-opus-4-7[1m]",
        contextWindow: 1_000_000,
        serviceTiers: ["fast"],
      });
      expect(resolveModelAlias("opus")?.id).toBe("anthropic/claude-opus-4-7");
      expect(resolveModelAlias("opus[1m]")?.id).toBe("anthropic/claude-opus-4-7-1m");
      expect(resolveModelAlias("anthropic/claude-opus-4-7")?.id).toBe("anthropic/claude-opus-4-7");
      expect(resolveModelAlias("anthropic/claude-opus-4-7-1m")?.id).toBe("anthropic/claude-opus-4-7-1m");
    });

    it("keeps claude-opus-4-6 ids as compatibility aliases to their existing 4.7 targets", () => {
      expect(resolveModelAlias("anthropic/claude-opus-4-6")?.id).toBe("anthropic/claude-opus-4-7");
      expect(resolveModelAlias("anthropic/claude-opus-4-6-1m")?.id).toBe("anthropic/claude-opus-4-7-1m");
      expect(getModelById("anthropic/claude-opus-4-6")?.id).toBe("anthropic/claude-opus-4-7");
      expect(getModelById("anthropic/claude-opus-4-6-1m")?.id).toBe("anthropic/claude-opus-4-7-1m");
    });

    it("does not advertise Claude Fast mode on non-Opus models", () => {
      expect(getModelById("anthropic/claude-sonnet-4-6")?.serviceTiers).toBeUndefined();
      expect(getModelById("anthropic/claude-haiku-4-5")?.serviceTiers).toBeUndefined();
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

  it("resolves dynamic droid custom model ids with parentheses", () => {
    const descriptor = getModelById("droid/custom:gpt-5.4(xhigh)");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.family).toBe("factory");
    expect(descriptor?.providerModelId).toBe("custom:gpt-5.4(xhigh)");
  });

  it("formats Droid custom thinking models with the expected display label", () => {
    const descriptor = getModelById("droid/custom:claude-sonnet-4-6-thinking-32000");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.displayName).toBe("Claude Sonnet 4.6 (High)");
  });

  it("keeps Droid custom models in their own picker group", () => {
    expect(droidCliLineGroupFromModelId("custom:claude-sonnet-4-6-thinking-32000")).toBe("custom");
    expect(droidCliLineGroupFromModelId("custom:gpt-5.4(xhigh)")).toBe("custom");
    expect(droidCliLineGroupLabel("custom")).toBe("Custom models");
  });

  it("uses compact Droid factory labels that match the CLI picker", () => {
    const descriptor = getModelById("droid/claude-sonnet-4-6");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.displayName).toBe("Sonnet 4.6 (1.2x)");
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
