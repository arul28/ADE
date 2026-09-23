import { describe, expect, it } from "vitest";
import {
  applyModelManifest,
  BUNDLED_MODEL_MANIFEST,
  getAppDefaultModelDescriptor,
  createDynamicAcpModelDescriptor,
  clearDynamicAcpModelDescriptors,
  createDynamicDroidCliModelDescriptor,
  replaceDynamicAcpModelDescriptors,
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
  listAcpModelDescriptorsForProvider,
  listModelDescriptorsForProvider,
  mergeDynamicAcpModelDescriptors,
  MODEL_REGISTRY,
  resolveAcpModelDescriptor,
  replaceDynamicPiModelDescriptors,
  resolveModelAlias,
  resolveCursorCliModelVariant,
  resolveCliProviderForModel,
  resolveProviderGroupForModel,
  resolveModelDescriptor,
  resolveModelDescriptorForProvider,
  resolveModelSlug,
  selectSupportedReasoningEffort,
  normalizeAnthropicRuntimeAlias,
  openCodeRegistryIdFor,
  resolveOpenCodeFastEffortSelection,
  usesCodexNamedEffortLabels,
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

  it("routes every ACP provider's curated rows to its own group", () => {
    const expectations = [
      { provider: "qwen", family: "qwen" },
      { provider: "kimi", family: "moonshot" },
      { provider: "grok", family: "xai" },
      { provider: "copilot", family: "github-copilot" },
    ] as const;
    for (const { provider, family } of expectations) {
      const models = listModelDescriptorsForProvider(provider);
      expect(models.length).toBeGreaterThan(0);
      for (const descriptor of models) {
        expect(descriptor.family).toBe(family);
        expect(descriptor.isCliWrapped).toBe(true);
        expect(resolveCliProviderForModel(descriptor)).toBe(provider);
        expect(resolveProviderGroupForModel(descriptor)).toBe(provider);
        // The CLI flag needs the provider's own id, never ADE's registry id.
        expect(getRuntimeModelRefForDescriptor(descriptor)).toBe(descriptor.providerModelId);
      }
      expect(getDefaultModelDescriptor(provider)).toBe(models[0]);
    }
  });

  it("prefers a Qwen model discovered from the CLI settings over curated Alibaba rows", () => {
    try {
      replaceDynamicAcpModelDescriptors("qwen", [
        createDynamicAcpModelDescriptor("qwen", "gpt-5.5"),
      ]);
      const models = listModelDescriptorsForProvider("qwen");
      expect(models[0]?.providerModelId).toBe("gpt-5.5");
      expect(getDefaultModelDescriptor("qwen")?.providerModelId).toBe("gpt-5.5");
      expect(models.some((model) => model.providerModelId === "qwen3-coder-plus")).toBe(true);
    } finally {
      clearDynamicAcpModelDescriptors();
    }
  });

  it("shows a live Grok report of a curated model as the curated row, with the live efforts", () => {
    const liveTiers = ["low", "medium", "high", "xhigh"];
    try {
      // The live session names the model by its provider id, which registers as
      // `xai/grok-4.5`; the curated row for the same model is `xai/grok-4-5`.
      mergeDynamicAcpModelDescriptors("grok", [
        createDynamicAcpModelDescriptor("grok", "grok-4.5", { reasoningTiers: liveTiers }),
        createDynamicAcpModelDescriptor("grok", "grok-4.7", { reasoningTiers: ["low", "high"] }),
      ]);
      const rows = listModelDescriptorsForProvider("grok");
      expect(rows.filter((row) => row.providerModelId === "grok-4.5")).toHaveLength(1);
      expect(rows.find((row) => row.providerModelId === "grok-4.5")).toMatchObject({
        id: "xai/grok-4-5",
        displayName: "Grok 4.5",
        contextWindow: 500_000,
        color: "#B91C1C",
        reasoningTiers: liveTiers,
        defaultReasoningEffort: "high",
      });
      // An uncurated live model is still its own row.
      expect(rows.some((row) => row.id === "xai/grok-4.7")).toBe(true);
      // A chat that picked the live row resolves to the curated one.
      expect(getModelById("xai/grok-4.5")?.id).toBe("xai/grok-4-5");
      expect(resolveModelAlias("grok-4.5")?.reasoningTiers).toEqual(liveTiers);
      expect(resolveAcpModelDescriptor("grok", "grok-4.5")?.reasoningTiers).toEqual(liveTiers);

      // A later report that does not mention the model keeps what was learned.
      mergeDynamicAcpModelDescriptors("grok", [
        createDynamicAcpModelDescriptor("grok", "grok-4.7", { reasoningTiers: ["low", "high"] }),
      ]);
      expect(getModelById("xai/grok-4-5")?.reasoningTiers).toEqual(liveTiers);
    } finally {
      clearDynamicAcpModelDescriptors();
    }
    expect(getModelById("xai/grok-4-5")?.reasoningTiers).toEqual(["low", "medium", "high"]);
    expect(getModelById("xai/grok-4.5")).toBeUndefined();
  });

  it("serves a curated row's live efforts to every lookup, scan, and default", () => {
    const liveTiers = ["low", "medium", "high", "xhigh"];
    try {
      mergeDynamicAcpModelDescriptors("grok", [
        createDynamicAcpModelDescriptor("grok", "grok-4.5", { reasoningTiers: liveTiers }),
      ]);
      expect(resolveModelDescriptorForProvider("grok-4.5", "grok")?.reasoningTiers).toEqual(liveTiers);
      expect(resolveModelDescriptorForProvider("xai/grok-4-5", "grok")?.reasoningTiers).toEqual(liveTiers);
      expect(resolveModelSlug("grok-4.5", "grok")).toBe("xai/grok-4-5");
      const available = getAvailableModels([{ type: "cli-subscription", cli: "grok", authenticated: true }]);
      expect(available.find((model) => model.id === "xai/grok-4-5")?.reasoningTiers).toEqual(liveTiers);
      applyModelManifest({
        version: 1,
        updatedAt: "2030-01-01T00:00:00Z",
        models: [],
        defaults: { app: [{ model: "xai/grok-4-5" }] },
      });
      expect(getAppDefaultModelDescriptor()?.reasoningTiers).toEqual(liveTiers);
    } finally {
      applyModelManifest(BUNDLED_MODEL_MANIFEST);
      clearDynamicAcpModelDescriptors();
    }
    expect(resolveModelDescriptorForProvider("grok-4.5", "grok")?.reasoningTiers).toEqual(["low", "medium", "high"]);
    // The overlay never writes into the curated registry itself.
    expect(MODEL_REGISTRY.find((model) => model.id === "xai/grok-4-5")?.reasoningTiers).toEqual(["low", "medium", "high"]);
  });

  it("keeps a curated ACP row's researched efforts when the live report names none", () => {
    try {
      replaceDynamicAcpModelDescriptors("grok", [createDynamicAcpModelDescriptor("grok", "grok-4.6")]);
      expect(listModelDescriptorsForProvider("grok").filter((row) => row.providerModelId === "grok-4.6")).toHaveLength(1);
      expect(getModelById("xai/grok-4-6")?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh"]);
      expect(getModelById("xai/grok-4-6")?.defaultReasoningEffort).toBe("high");
    } finally {
      clearDynamicAcpModelDescriptors();
    }
  });

  it("uses configured Qwen model ids instead of presenting unrelated curated rows", () => {
    try {
      replaceDynamicAcpModelDescriptors("qwen", [
        createDynamicAcpModelDescriptor("qwen", "gpt-5.5"),
      ]);
      expect(listAcpModelDescriptorsForProvider("qwen", {
        configuredModelIds: ["gpt-5.5"],
      }).map((model) => model.providerModelId)).toEqual(["gpt-5.5"]);
    } finally {
      clearDynamicAcpModelDescriptors();
    }
  });

  it("keeps OpenCode-routed xAI and Moonshot models out of the Grok and Kimi groups", () => {
    // Family alone would misroute these: only `isCliWrapped` separates a Grok
    // CLI row from an OpenCode-routed xAI row that shares its family.
    for (const family of ["xai", "moonshot"] as const) {
      const routed = MODEL_REGISTRY.filter((m) => m.family === family && !m.isCliWrapped);
      for (const descriptor of routed) {
        expect(resolveCliProviderForModel(descriptor)).toBeNull();
        expect(resolveProviderGroupForModel(descriptor)).toBe("opencode");
      }
    }
  });

  it("marks only the preview-tier ACP providers and leaves first-class ones unmarked", () => {
    for (const provider of ["copilot"] as const) {
      expect(listModelDescriptorsForProvider(provider).every((m) => m.previewTier === true)).toBe(true);
    }
    for (const provider of ["qwen", "kimi", "grok"] as const) {
      expect(listModelDescriptorsForProvider(provider).some((m) => m.previewTier === true)).toBe(false);
    }
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
      id: "opencode/anthropic/claude-opus-5",
      displayName: "Claude Opus 5",
      providerModelId: "anthropic/claude-opus-5",
      openCodeModelId: "claude-opus-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({ tools: true, vision: true, reasoning: true }),
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(currentOpus).toMatchObject({
      id: "opencode/anthropic/claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      providerModelId: "anthropic/claude-opus-5-5",
      openCodeModelId: "claude-opus-5-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    });
    // With no inventory, Fast is not guessed: OpenCode runs it through a
    // `-fast` sibling model, and only an inventory names one.
    expect(opus?.serviceTiers).toBeUndefined();
    expect(currentOpus?.serviceTiers).toBeUndefined();
  });

  it("gives an inventory-built OpenCode row only the tiers OpenCode reported", () => {
    // `opus` is an alias of Claude Opus 5.5, whose canonical ladder is
    // low..max with `medium` by default and Fast. OpenCode reported only `high`.
    const alias = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "anthropic",
      openCodeModelId: "opus",
      reasoningTiers: ["high"],
      reportedTiers: true,
    });
    expect(alias).toMatchObject({ id: "opencode/anthropic/claude-opus-5-5", reasoningTiers: ["high"] });
    expect(alias.defaultReasoningEffort).toBeUndefined();
    expect(alias.serviceTiers).toBeUndefined();

    const bare = createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "anthropic",
      openCodeModelId: "opus",
      reportedTiers: true,
    });
    expect(bare.reasoningTiers).toBeUndefined();
    expect(bare.defaultReasoningEffort).toBeUndefined();

    // The canonical default stays when OpenCode reported it.
    expect(createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "anthropic",
      openCodeModelId: "claude-opus-5-5",
      reasoningTiers: ["medium", "high"],
      reportedTiers: true,
    }).defaultReasoningEffort).toBe("medium");
  });

  it("names an OpenCode model with one registry id for requests and served models", () => {
    // OpenRouter model ids carry a `/`; the row id encodes it.
    expect(openCodeRegistryIdFor("openrouter", "anthropic/claude-opus-4.7"))
      .toBe("opencode/openrouter/anthropic%2Fclaude-opus-4.7");
    expect(openCodeRegistryIdFor("openrouter", "anthropic/claude-opus-4.7")).toBe(createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "openrouter",
      openCodeModelId: "anthropic/claude-opus-4.7",
    }).id);
    // Anthropic aliases take the canonical row's id, as the row does.
    expect(openCodeRegistryIdFor("anthropic", "opus")).toBe("opencode/anthropic/claude-opus-5-5");
    expect(openCodeRegistryIdFor("anthropic", "opus")).toBe(createDynamicOpenCodeModelDescriptor("", {
      openCodeProviderId: "anthropic",
      openCodeModelId: "opus",
    }).id);
  });

  describe("resolveOpenCodeFastEffortSelection", () => {
    const row = (patch: Partial<ModelDescriptor>): ModelDescriptor => ({
      ...createDynamicOpenCodeModelDescriptor("", {
        displayName: "GPT-5.4",
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5.4",
        reasoningTiers: ["low", "medium", "high"],
        serviceTiers: ["fast"],
        reportedTiers: true,
      }),
      ...patch,
    });

    it("runs Fast with an effort as the fast sibling model plus the effort variant", () => {
      const descriptor = row({
        openCodeVariantKeys: { high: "High" },
        openCodeFast: {
          withoutEffort: { modelId: "gpt-5.4-fast" },
          byEffort: { high: { modelId: "gpt-5.4-fast", variant: "High" } },
        },
      });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: "high" }))
        .toEqual({ modelId: "gpt-5.4-fast", variant: "High", fastApplied: true });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: null }))
        .toEqual({ modelId: "gpt-5.4-fast", variant: null, fastApplied: true });
      // An effort the model does not list counts as no effort.
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: "ultra" }))
        .toEqual({ modelId: "gpt-5.4-fast", variant: null, fastApplied: true });
      // Fast off sends the row's own model and OpenCode's key for the effort.
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: false, reasoningEffort: "high" }))
        .toEqual({ modelId: "gpt-5.4", variant: "High", fastApplied: false });
    });

    it("uses a combined key, then a plain fast key, and otherwise keeps the effort", () => {
      const descriptor = row({
        openCodeFast: {
          withoutEffort: { variant: "fast" },
          byEffort: { high: { variant: "high-fast" } },
        },
      });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: "high" }))
        .toEqual({ modelId: "gpt-5.4", variant: "high-fast", fastApplied: true });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: null }))
        .toEqual({ modelId: "gpt-5.4", variant: "fast", fastApplied: true });
      // `low` has no combined key and `fast` is one variant, so the effort wins.
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: "low" })).toEqual({
        modelId: "gpt-5.4",
        variant: "low",
        fastApplied: false,
        fastUnavailableReason: "OpenCode cannot run GPT-5.4 in Fast mode at low effort.",
      });
    });

    it("treats a fast service tier with no routes as a plain fast variant", () => {
      const descriptor = row({ openCodeVariantKeys: { fast: "Fast" } });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true }))
        .toEqual({ modelId: "gpt-5.4", variant: "Fast", fastApplied: true });
      expect(resolveOpenCodeFastEffortSelection(descriptor, { fastMode: true, reasoningEffort: "medium" }))
        .toMatchObject({ variant: "medium", fastApplied: false });
    });

    it("explains Fast on a row that has none, or needs an effort", () => {
      expect(resolveOpenCodeFastEffortSelection(row({ serviceTiers: undefined }), { fastMode: true, reasoningEffort: "low" }))
        .toEqual({
          modelId: "gpt-5.4",
          variant: "low",
          fastApplied: false,
          fastUnavailableReason: "OpenCode has no Fast mode for GPT-5.4.",
        });
      expect(resolveOpenCodeFastEffortSelection(
        row({ openCodeFast: { byEffort: { high: { variant: "high-fast" } } } }),
        { fastMode: true },
      )).toMatchObject({
        variant: null,
        fastApplied: false,
        fastUnavailableReason: "OpenCode runs GPT-5.4 in Fast mode only with an effort level.",
      });
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
    expect(byId).toBe("anthropic/claude-opus-5");
    expect(resolveModelSlug("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(resolveModelSlug("gpt-5.5")).toBe("openai/gpt-5.5");
    expect(resolveModelSlug("sol", "codex")).toBe("openai/gpt-6-sol");
    expect(resolveModelSlug("gpt-5.6-sol", "codex")).toBe("openai/gpt-5.6-sol");
    expect(resolveModelSlug("astra", "codex")).toBe("openai/gpt-6-astra");
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
      "openai/gpt-6-astra",
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
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
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-6-astra");
  });

  it("exposes GPT-6 Astra as the Codex flagship with the API effort ladder", () => {
    expect(getModelById("openai/gpt-6-astra")).toMatchObject({
      displayName: "GPT-6 Astra",
      providerModelId: "gpt-6-astra",
      contextWindow: 1_050_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "low",
      serviceTiers: ["fast"],
    });
    expect(resolveModelAlias("astra")?.id).toBe("openai/gpt-6-astra");
    expect(getRuntimeModelRefForDescriptor(getModelById("openai/gpt-6-astra")!, "codex")).toBe("gpt-6-astra");
    expect(usesCodexNamedEffortLabels("gpt-6-astra")).toBe(true);
    expect(usesCodexNamedEffortLabels("openai/gpt-6-astra")).toBe(true);
    expect(usesCodexNamedEffortLabels("gpt-5.6-sol")).toBe(true);
    expect(usesCodexNamedEffortLabels("gpt-5.5")).toBe(false);
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
    // The bare family names follow the newest generation (model-manifest.json).
    expect(resolveModelAlias("sol")?.id).toBe("openai/gpt-6-sol");
    expect(resolveModelAlias("gpt-5.6-sol")?.id).toBe("openai/gpt-5.6-sol");
    expect(resolveModelAlias("terra")?.id).toBe("openai/gpt-5.6-terra");
    expect(resolveModelAlias("luna")?.id).toBe("openai/gpt-6-luna");
    expect(resolveModelAlias("gpt-5.6-luna")?.id).toBe("openai/gpt-5.6-luna");
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
      expect(MODEL_REGISTRY.filter((model) => model.family === "anthropic").slice(0, 5).map((model) => model.id)).toEqual([
        "anthropic/claude-fable-5-1",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-opus-5",
      ]);
      const fable = getModelById("anthropic/claude-fable-5-1");
      expect(fable).toBeTruthy();
      expect(fable).toMatchObject({
        displayName: "Claude Fable 5.1",
        shortId: "fable",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-fable-5-1",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 10,
        outputPricePer1M: 50,
        defaultReasoningEffort: "high",
      });
      expect(fable?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
      expect(resolveModelAlias("fable")?.id).toBe("anthropic/claude-fable-5-1");
      expect(resolveModelAlias("claude-fable-5")?.id).toBe("anthropic/claude-fable-5-1");

      const opus55 = getModelById("anthropic/claude-opus-5-5");
      expect(opus55).toBeTruthy();
      expect(opus55).toMatchObject({
        displayName: "Claude Opus 5.5",
        shortId: "opus",
        family: "anthropic",
        providerRoute: "claude-cli",
        providerModelId: "claude-opus-5-5",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputPricePer1M: 4,
        outputPricePer1M: 20,
        defaultReasoningEffort: "medium",
      });
      expect(opus55?.reasoningTiers).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(opus55?.serviceTiers).toEqual(["fast"]);
      expect(resolveModelAlias("opus")?.id).toBe("anthropic/claude-opus-5-5");
      expect(getRuntimeModelRefForDescriptor(opus55!, "claude")).toBe("claude-opus-5-5");

      const opus5 = getModelById("anthropic/claude-opus-5");
      expect(opus5).toBeTruthy();
      expect(opus5).toMatchObject({
        displayName: "Claude Opus 5",
        shortId: "opus-5",
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
      expect(resolveModelAlias("opus-5")?.id).toBe("anthropic/claude-opus-5");
      expect(getRuntimeModelRefForDescriptor(opus5!, "claude")).toBe("claude-opus-5");
      // model-manifest.json makes Opus 5.5 the Claude default.
      expect(getDefaultModelDescriptor("claude")?.id).toBe("anthropic/claude-opus-5-5");
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

    it("drops Opus 4.8 entirely and forwards its aliases to Opus 5", () => {
      expect(MODEL_REGISTRY.some((model) => model.id === "anthropic/claude-opus-4-8")).toBe(false);
      expect(MODEL_REGISTRY.some((model) => model.id === "anthropic/claude-opus-4-7")).toBe(false);
      expect(MODEL_REGISTRY.some((model) => model.id === "anthropic/claude-opus-4-7-1m")).toBe(false);
      expect(resolveModelAlias("opus[1m]")?.id).toBe("anthropic/claude-opus-5");
      expect(resolveModelAlias("anthropic/claude-opus-4-6")?.id).toBe("anthropic/claude-opus-5");
      expect(resolveModelAlias("anthropic/claude-opus-4-7")?.id).toBe("anthropic/claude-opus-5");
      expect(resolveModelAlias("anthropic/claude-opus-4-8")?.id).toBe("anthropic/claude-opus-5");
      expect(resolveModelAlias("anthropic/claude-opus-4-6-1m")?.id).toBe("anthropic/claude-opus-5");
      expect(resolveModelAlias("anthropic/claude-opus-4-7-1m")?.id).toBe("anthropic/claude-opus-5");
      expect(getModelById("claude-opus-4-6")?.id).toBe("anthropic/claude-opus-5");
      expect(getModelById("claude-opus-4-8")?.id).toBe("anthropic/claude-opus-5");
      expect(getModelById("claude-opus-4-6[1m]")?.id).toBe("anthropic/claude-opus-5");
    });

    it("canonicalizes Anthropic runtime aliases including retired Opus 4.8 forms", () => {
      expect(normalizeAnthropicRuntimeAlias("claude-fable-5")?.modelId).toBe("claude-fable-5-1");
      expect(normalizeAnthropicRuntimeAlias("fable-5.0")?.modelId).toBe("claude-fable-5-1");
      expect(normalizeAnthropicRuntimeAlias("opus")?.modelId).toBe("claude-opus-5-5");
      expect(normalizeAnthropicRuntimeAlias("claude-opus-5-5")?.wasAlias).toBe(false);
      expect(normalizeAnthropicRuntimeAlias("opus-5")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("opus-4.8")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("opus-4.8-1m")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("claude-opus-4-8-1m")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("claude-opus-4-8[1m]")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("anthropic/claude-opus-4-8-1m")?.modelId).toBe("claude-opus-5");
      expect(normalizeAnthropicRuntimeAlias("claude-opus-4-8")?.wasAlias).toBe(true);
      expect(normalizeAnthropicRuntimeAlias("claude-opus-5")?.wasAlias).toBe(false);
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
      id: "droid/claude-opus-5",
      providerModelId: "claude-opus-5",
      displayName: "Opus 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(opus?.serviceTiers).toBeUndefined();
    expect(getModelById("droid/claude-opus-4-6-fast")).toMatchObject({
      id: "droid/claude-opus-5",
      providerModelId: "claude-opus-5",
      displayName: "Opus 5",
    });
    expect(opus5).toMatchObject({
      id: "droid/claude-opus-5-5",
      providerModelId: "claude-opus-5-5",
      displayName: "Opus 5.5",
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
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
