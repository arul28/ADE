import { describe, expect, it } from "vitest";
import {
  createDynamicDroidCliModelDescriptor,
  createDynamicLocalModelDescriptor,
  createDynamicOpenCodeModelDescriptor,
  createDynamicPiModelDescriptor,
  classifyWorkerExecutionPath,
  decodeOpenCodeRegistryId,
  decodePiRegistryId,
  droidCliLineGroupFromModelId,
  droidCliLineGroupLabel,
  encodeOpenCodeRegistryId,
  encodePiRegistryId,
  formatPiProviderLabel,
  ensureOpenCodeBaseURL,
  getAvailableModels,
  getDefaultModelDescriptor,
  getModelById,
  getModelDescriptorForPermissionMode,
  getRuntimeModelRefForDescriptor,
  listModelDescriptorsForProvider,
  MODEL_REGISTRY,
  replaceDynamicPiModelDescriptors,
  resolveModelAlias,
  resolveCursorCliModelVariant,
  resolveCliProviderForModel,
  resolveModelDescriptor,
  resolveModelDescriptorForProvider,
  resolveModelSlug,
  selectSupportedReasoningEffort,
} from "./modelRegistry";
import type { ModelDescriptor, ProviderFamily } from "./modelRegistry";
import { describeModelSource } from "../renderer/lib/modelOptions";

describe("modelRegistry", () => {
  it("selects only supported reasoning preferences and defaults", () => {
    const tiers = ["low", "medium", "high"];
    expect(selectSupportedReasoningEffort({ tiers, preferred: "high", advertisedDefault: "low" })).toBe("high");
    expect(selectSupportedReasoningEffort({ tiers, preferred: "ultra", advertisedDefault: "low" })).toBe("low");
    expect(selectSupportedReasoningEffort({ tiers, advertisedDefault: "ultra", fallback: "high" })).toBe("high");
    expect(selectSupportedReasoningEffort({ tiers: ["low", "high"] })).toBe("low");
    expect(selectSupportedReasoningEffort({ tiers: [] })).toBeNull();
  });

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

  it("round-trips Pi registry ids and preserves the upstream provider", () => {
    const id = encodePiRegistryId("default", "openai-codex", "gpt-5.4");
    expect(id).toBe("pi/default/openai-codex/gpt-5.4");
    expect(decodePiRegistryId(id)).toEqual({
      profileId: "default",
      providerId: "openai-codex",
      modelId: "gpt-5.4",
    });
    const descriptor = createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", {
      profileId: "default",
      displayName: "GPT-5.4",
    });
    expect(descriptor.id).toBe(id);
    expect(descriptor.providerRoute).toBe("pi-sdk");
    expect(resolveCliProviderForModel(descriptor)).toBe("pi");
    expect(classifyWorkerExecutionPath(descriptor)).toBe("api");
    expect(descriptor.piProviderId).toBe("openai-codex");
    expect(descriptor.piModelId).toBe("gpt-5.4");
    expect(descriptor.family).toBe("openai");
  });

  it("rejects ambiguous or incomplete Pi registry components", () => {
    expect(() => encodePiRegistryId("default", "", "gpt-5.4")).toThrow("Pi provider id is required");
    expect(() => encodePiRegistryId("default", "openai/codex", "gpt-5.4")).toThrow("cannot contain");
    expect(() => encodePiRegistryId("default", "openai-codex", "")).toThrow("Pi model id is required");
  });

  it("matches provider-scoped Pi OAuth only to its upstream provider", () => {
    const openAiPi = createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", {
      profileId: "team",
      displayName: "Team GPT-5.4",
    });
    const anthropicPi = createDynamicPiModelDescriptor("anthropic", "claude-sonnet-4-6", {
      profileId: "team",
      displayName: "Team Claude Sonnet",
    });
    // Keep the registry's dynamic map isolated from other tests while proving
    // that one provider's OAuth does not unlock another provider's Pi rows.
    replaceDynamicPiModelDescriptors([openAiPi, anthropicPi]);
    try {
      const anthropicAuth = getAvailableModels([{ type: "oauth", provider: "anthropic" }]);
      expect(anthropicAuth.map((model) => model.id)).toContain(anthropicPi.id);
      expect(anthropicAuth.map((model) => model.id)).not.toContain(openAiPi.id);

      const openAiAuth = getAvailableModels([{ type: "oauth", provider: "openai-codex" }]);
      expect(openAiAuth.map((model) => model.id)).toContain(openAiPi.id);
      expect(openAiAuth.map((model) => model.id)).not.toContain(anthropicPi.id);
    } finally {
      replaceDynamicPiModelDescriptors([]);
    }
  });

  it("humanizes Pi provider ids without losing branded names", () => {
    expect(formatPiProviderLabel("openai-codex")).toBe("OpenAI Codex");
    expect(formatPiProviderLabel("google-gemini-cli")).toBe("Google Gemini CLI");
    expect(formatPiProviderLabel("custom-provider")).toBe("Custom Provider");
  });

  it("canonicalizes persisted OpenCode Anthropic aliases before launch", () => {
    const sonnet = getModelById("opencode/anthropic/claude-sonnet-4-6");
    const currentOpus = getModelById("opencode/anthropic/opus");
    const opus = getModelById("opencode/anthropic/opus-4.6");

    expect(sonnet).toMatchObject({
      id: "opencode/anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      providerModelId: "anthropic/claude-sonnet-5",
      openCodeModelId: "claude-sonnet-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({ tools: true, vision: true, reasoning: true }),
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(opus).toMatchObject({
      id: "opencode/anthropic/claude-opus-4-8",
      displayName: "Claude Opus 4.8 1M",
      providerModelId: "anthropic/claude-opus-4-8",
      openCodeModelId: "claude-opus-4-8",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({ tools: true, vision: true, reasoning: true }),
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      serviceTiers: ["fast"],
    });
    expect(currentOpus).toMatchObject({
      id: "opencode/anthropic/claude-opus-5",
      displayName: "Claude Opus 5",
      providerModelId: "anthropic/claude-opus-5",
      openCodeModelId: "claude-opus-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      serviceTiers: ["fast"],
    });
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
    expect(resolveModelSlug("sol", "codex")).toBe("openai/gpt-5.6-sol");
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
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
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
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.6-sol");
  });

  it("exposes the exact GPT-5.6 Codex effort ladders and defaults", () => {
    expect(getModelById("openai/gpt-5.6-sol")).toMatchObject({
      displayName: "GPT-5.6 Sol",
      providerModelId: "gpt-5.6-sol",
      contextWindow: 372_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "low",
      serviceTiers: ["fast"],
    });
    expect(getModelById("openai/gpt-5.6-terra")).toMatchObject({
      displayName: "GPT-5.6 Terra",
      providerModelId: "gpt-5.6-terra",
      contextWindow: 372_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      serviceTiers: ["fast"],
    });
    expect(getModelById("openai/gpt-5.6-luna")).toMatchObject({
      displayName: "GPT-5.6 Luna",
      providerModelId: "gpt-5.6-luna",
      contextWindow: 372_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: ["fast"],
    });
    expect(resolveModelAlias("sol")?.id).toBe("openai/gpt-5.6-sol");
    expect(resolveModelAlias("terra")?.id).toBe("openai/gpt-5.6-terra");
    expect(resolveModelAlias("luna")?.id).toBe("openai/gpt-5.6-luna");
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

  it("returns the exact Codex app-server runtime names for GPT-5.6", () => {
    for (const slug of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const descriptor = getModelById(`openai/${slug}`);
      expect(descriptor).toBeTruthy();
      expect(getRuntimeModelRefForDescriptor(descriptor!, "codex")).toBe(slug);
    }
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
    it("orders the Claude model registry for picker display", () => {
      expect(MODEL_REGISTRY.filter((model) => model.family === "anthropic").slice(0, 6).map((model) => model.id)).toEqual([
        "anthropic/claude-fable-5",
        "anthropic/claude-opus-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-4-8",
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

      const opus5 = getModelById("anthropic/claude-opus-5");
      expect(opus5).toBeTruthy();
      expect(opus5).toMatchObject({
        displayName: "Claude Opus 5",
        shortId: "opus",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-opus-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 5,
        outputPricePer1M: 25,
        defaultReasoningEffort: "high",
      });
      expect(opus5?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(opus5?.serviceTiers).toEqual(["fast"]);
      expect(resolveModelAlias("opus")?.id).toBe("anthropic/claude-opus-5");
      expect(getRuntimeModelRefForDescriptor(opus5!, "claude")).toBe("claude-opus-5");

      const opus48 = getModelById("anthropic/claude-opus-4-8");
      expect(opus48).toBeTruthy();
      expect(opus48).toMatchObject({
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
      expect(opus48?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
      expect(opus48?.serviceTiers).toEqual(["fast"]);
      expect(getDefaultModelDescriptor("claude")?.id).toBe("anthropic/claude-fable-5");
    });

    it("uses the exact Claude Sonnet 5 runtime model id", () => {
      const sonnet = getModelById("anthropic/claude-sonnet-5");
      expect(sonnet).toBeTruthy();
      expect(sonnet).toMatchObject({
        displayName: "Claude Sonnet 5",
        shortId: "sonnet",
        providerModelId: "claude-sonnet-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      });
      expect(getRuntimeModelRefForDescriptor(sonnet!, "claude")).toBe("claude-sonnet-5");
    });

    it("removes Opus 4.7 basic while keeping Opus 4.7 1M selectable", () => {
      expect(MODEL_REGISTRY.some((model) => model.id === "anthropic/claude-opus-4-7")).toBe(false);
      expect(getModelById("anthropic/claude-opus-4-7-1m")).toMatchObject({
        displayName: "Claude Opus 4.7 1M",
        shortId: "opus-1m",
        providerModelId: "claude-opus-4-7[1m]",
        contextWindow: 1_000_000,
        serviceTiers: ["fast"],
      });
      expect(resolveModelAlias("opus[1m]")?.id).toBe("anthropic/claude-opus-4-7-1m");
      expect(resolveModelAlias("anthropic/claude-opus-4-6")?.id).toBe("anthropic/claude-opus-4-8");
      expect(resolveModelAlias("anthropic/claude-opus-4-7")?.id).toBe("anthropic/claude-opus-4-8");
      expect(resolveModelAlias("anthropic/claude-opus-4-6-1m")?.id).toBe("anthropic/claude-opus-4-7-1m");
      expect(resolveModelAlias("anthropic/claude-opus-4-7-1m")?.id).toBe("anthropic/claude-opus-4-7-1m");
      expect(getModelById("claude-opus-4-6")?.id).toBe("anthropic/claude-opus-4-8");
      expect(getModelById("claude-opus-4-6[1m]")?.id).toBe("anthropic/claude-opus-4-7-1m");
    });

    it("maps removed Sonnet aliases forward without listing Sonnet 4.6 as a row", () => {
      expect(MODEL_REGISTRY.some((model) => model.id === "anthropic/claude-sonnet-4-6")).toBe(false);
      expect(resolveModelAlias("anthropic/claude-sonnet-4-6")?.id).toBe("anthropic/claude-sonnet-5");
      expect(getModelById("anthropic/claude-sonnet-4-6")?.id).toBe("anthropic/claude-sonnet-5");
    });

    it("does not advertise Claude Fast mode on non-Opus models", () => {
      expect(getModelById("anthropic/claude-sonnet-5")?.serviceTiers).toBeUndefined();
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
    const descriptor = getModelById("droid/custom:claude-sonnet-5-thinking-32000");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.displayName).toBe("Claude Sonnet 5 (High)");
  });

  it("canonicalizes persisted Droid Anthropic aliases before launch", () => {
    const sonnet = getModelById("droid/claude-sonnet-4-6");
    const opus = getModelById("droid/opus-4-6");
    const opus5 = getModelById("droid/opus");

    expect(sonnet).toMatchObject({
      id: "droid/claude-sonnet-5",
      providerModelId: "claude-sonnet-5",
      displayName: "Sonnet 5 (1.2x)",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(opus).toMatchObject({
      id: "droid/claude-opus-4-8",
      providerModelId: "claude-opus-4-8",
      displayName: "Opus 4.8 1M",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      serviceTiers: ["fast"],
    });
    expect(getModelById("droid/claude-opus-4-6-fast")).toMatchObject({
      id: "droid/claude-opus-4-8",
      providerModelId: "claude-opus-4-8",
      displayName: "Opus 4.8 1M",
    });
    expect(opus5).toMatchObject({
      id: "droid/claude-opus-5",
      providerModelId: "claude-opus-5",
      displayName: "Opus 5",
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(opus5?.serviceTiers).toBeUndefined();
  });

  it("does not advertise unsupported Fast mode for Droid Opus 5 custom proxies", () => {
    const descriptor = createDynamicDroidCliModelDescriptor(
      "custom:claude-opus-5",
      "Opus 5",
      {
        customProxy: true,
        reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "high",
        serviceTiers: ["fast"],
      },
    );

    expect(descriptor).toMatchObject({
      id: "droid/custom:claude-opus-5",
      providerModelId: "custom:claude-opus-5",
      customProxy: true,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(descriptor.serviceTiers).toBeUndefined();
  });


  it("keeps Droid custom models in their own picker group", () => {
    expect(droidCliLineGroupFromModelId("custom:claude-sonnet-5-thinking-32000")).toBe("custom");
    expect(droidCliLineGroupFromModelId("custom:gpt-5.4(xhigh)")).toBe("custom");
    expect(droidCliLineGroupLabel("custom")).toBe("Custom models");
  });

  it("uses compact Droid factory labels that match the CLI picker", () => {
    const descriptor = getModelById("droid/claude-sonnet-5");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.displayName).toBe("Sonnet 5 (1.2x)");
  });

  it("keeps Sonnet 5 registry pricing aligned with current intro pricing", () => {
    expect(getModelById("anthropic/claude-sonnet-5")).toMatchObject({
      inputPricePer1M: 2,
      outputPricePer1M: 10,
    });
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
