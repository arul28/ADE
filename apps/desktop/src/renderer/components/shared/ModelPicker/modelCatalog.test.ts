import { beforeEach, describe, expect, it } from "vitest";
import {
  descriptorsFromAgentChatModelCatalog,
  mergeSelectorModels,
  resetRuntimeCatalogDescriptorCacheForTests,
  resolveModelDescriptorWithRuntimeCatalog,
} from "./modelCatalog";
import { sortModelItems } from "./modelOrdering";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  rememberRuntimeCatalog,
  resetModelPickerRuntimeCatalogForTests,
  runtimeCatalogProviderIsFresh,
} from "./runtimeCatalogCache";
import type { AgentChatModelCatalog } from "../../../../shared/types";

describe("mergeSelectorModels", () => {
  beforeEach(() => {
    resetRuntimeCatalogDescriptorCacheForTests();
  });

  it("re-buckets OpenCode-routed models into the 'opencode' family so they appear under one rail", () => {
    const ids = [
      "opencode/anthropic/claude-sonnet-5",
      "opencode/openai/gpt-5.4",
    ];
    const merged = mergeSelectorModels(ids, undefined, undefined, "available-only");
    const opencodeRouted = merged.filter((model) => model.providerRoute === "opencode");
    expect(opencodeRouted.length).toBeGreaterThanOrEqual(2);
    for (const model of opencodeRouted) {
      expect(model.family).toBe("opencode");
    }
  });

  it("keeps openCodeProviderId intact so rows can render per-sub-provider logos", () => {
    const ids = ["opencode/anthropic/claude-sonnet-5"];
    const merged = mergeSelectorModels(ids, undefined, undefined, "available-only");
    const model = merged.find((m) => m.id === "opencode/anthropic/claude-sonnet-5");
    expect(model).toBeDefined();
    expect(model?.openCodeProviderId).toBe("anthropic");
  });

  it("does not change the family of non-OpenCode models", () => {
    const ids = ["anthropic/claude-sonnet-5"];
    const merged = mergeSelectorModels(ids, undefined, undefined, "available-only");
    const model = merged.find((m) => m.id === "anthropic/claude-sonnet-5");
    expect(model).toBeDefined();
    expect(model?.family).toBe("anthropic");
  });

  it("does not surface any Droid descriptors when no Droid models are discovered (no canonical previews)", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const droidModels = merged.filter((m) => m.family === "factory");
    expect(droidModels.length).toBe(0);
  });

  it("does not surface any Cursor descriptors when no Cursor models are discovered (no canonical previews)", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const cursorModels = merged.filter((m) => m.family === "cursor");
    expect(cursorModels.length).toBe(0);
  });

  it("does not surface any OpenCode descriptors when no OpenCode models are discovered (no canonical previews)", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const opencodeModels = merged.filter((m) => m.family === "opencode");
    expect(opencodeModels.length).toBe(0);
  });

  it("surfaces only the discovered Droid model — no canonical entries are injected", () => {
    const merged = mergeSelectorModels(["droid/some-custom-model"], undefined, undefined, "all");
    const droidModels = merged.filter((m) => m.family === "factory");
    expect(droidModels.length).toBe(1);
    expect(droidModels[0]!.id).toBe("droid/some-custom-model");
  });

  it("preserves runtime catalog reasoning and service tiers as a descriptor overlay", () => {
    const catalog: AgentChatModelCatalog = {
      fetchedAt: new Date().toISOString(),
      groups: [
        {
          key: "cursor",
          displayName: "Cursor",
          providers: [
            {
              key: "cursor",
              displayName: "Cursor",
              badgeColor: "#60A5FA",
              modelCount: 1,
              subsections: [
                {
                  key: "cursor",
                  label: "Cursor",
                  models: [
                    {
                      id: "cursor/composer-2",
                      runtimeModelId: "cursor/composer-2",
                      provider: "cursor",
                      providerKey: "cursor",
                      groupKey: "cursor",
                      displayName: "Composer 2",
                      isDefault: true,
                      isAvailable: true,
                      reasoningEfforts: [{ effort: "high", description: "High" }],
                      defaultReasoningEffort: "high",
                      serviceTiers: ["fast"],
                      supportsReasoning: true,
                      supportsTools: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = descriptorsFromAgentChatModelCatalog(catalog);
    expect(result.models[0]).toMatchObject({
      id: "cursor/composer-2",
      reasoningTiers: ["high"],
      defaultReasoningEffort: "high",
      serviceTiers: ["fast"],
      capabilities: expect.objectContaining({ reasoning: true, tools: true }),
    });
    expect(resolveModelDescriptorWithRuntimeCatalog("cursor/composer-2")?.reasoningTiers).toEqual(["high"]);
  });

  it("preserves the complete GPT-5.6 app-server effort ladders", () => {
    const model = (
      id: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna",
      efforts: string[],
    ) => ({
      id,
      runtimeModelId: id,
      provider: "codex" as const,
      providerKey: "openai",
      groupKey: "codex",
      displayName: id,
      isDefault: id === "gpt-5.6-sol",
      isAvailable: true,
      reasoningEfforts: efforts.map((effort) => ({ effort, description: effort })),
      supportsReasoning: true,
      supportsTools: true,
    });
    const catalog: AgentChatModelCatalog = {
      fetchedAt: new Date().toISOString(),
      groups: [{
        key: "codex",
        displayName: "Codex",
        providers: [{
          key: "openai",
          displayName: "OpenAI",
          badgeColor: "#10A37F",
          modelCount: 3,
          subsections: [{
            key: "models",
            label: "Models",
            models: [
              model("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]),
              model("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]),
              model("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]),
            ],
          }],
        }],
      }],
    };

    const result = descriptorsFromAgentChatModelCatalog(catalog);
    expect(result.models.map(({ id, reasoningTiers }) => ({ id, reasoningTiers }))).toEqual([
      { id: "gpt-5.6-sol", reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { id: "gpt-5.6-terra", reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { id: "gpt-5.6-luna", reasoningTiers: ["low", "medium", "high", "xhigh", "max"] },
    ]);
  });

  it("uses Cursor catalog subsections as picker sub-provider groups", () => {
    const catalog: AgentChatModelCatalog = {
      fetchedAt: new Date().toISOString(),
      groups: [
        {
          key: "cursor",
          displayName: "Cursor",
          providers: [
            {
              key: "cursor",
              displayName: "Cursor",
              badgeColor: "#60A5FA",
              modelCount: 1,
              subsections: [
                {
                  key: "__cursor_line__:anthropic",
                  label: "Anthropic",
                  models: [
                    {
                      id: "cursor/claude-sonnet-4.6",
                      runtimeModelId: "cursor/claude-sonnet-4.6",
                      provider: "cursor",
                      providerKey: "cursor",
                      groupKey: "cursor",
                      displayName: "Claude Sonnet 5",
                      isDefault: false,
                      isAvailable: true,
                      supportsReasoning: true,
                      supportsTools: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = descriptorsFromAgentChatModelCatalog(catalog);

    expect(result.models[0]).toMatchObject({
      id: "cursor/claude-sonnet-4.6",
      subProvider: "Anthropic",
      subProviderKey: "__cursor_line__:anthropic",
    });
  });
});

describe("model picker ordering", () => {
  it("preserves source order unless favorites or explicit ordering apply", () => {
    const items = [
      { modelId: "a" },
      { modelId: "b" },
      { modelId: "c" },
      { modelId: "d" },
    ];

    expect(sortModelItems(items).map((item) => item.modelId)).toEqual(["a", "b", "c", "d"]);
    expect(sortModelItems(items, { modelIdOrder: ["c", "a"] }).map((item) => item.modelId))
      .toEqual(["c", "a", "b", "d"]);
    expect(sortModelItems(items, {
      favoriteModelIds: new Set(["c"]),
      groupFavorites: true,
      modelIdOrder: ["b", "d"],
    }).map((item) => item.modelId)).toEqual(["c", "b", "d", "a"]);
  });

  it("moves favorites only when grouping is enabled", () => {
    const items = [{ modelId: "x" }, { modelId: "y" }];

    expect(sortModelItems(items, {
      favoriteModelIds: ["y"],
      groupFavorites: false,
    }).map((item) => item.modelId)).toEqual(["x", "y"]);
    expect(sortModelItems(items, {
      favoriteModelIds: new Set(["y"]),
      groupFavorites: true,
    }).map((item) => item.modelId)).toEqual(["y", "x"]);
  });
});

describe("model picker search", () => {
  const opus = {
    family: "opencode" as const,
    providerDisplayName: "opencode",
    name: "Claude Opus 4.8 1M",
    subProvider: "GitHub Copilot",
    aliases: ["opus-latest"],
  };

  it("builds provider-agnostic searchable text", () => {
    expect(buildModelPickerSearchText(opus))
      .toBe("claude opus 4.8 1m github copilot opencode opencode opus-latest");
  });

  it("requires every query token while tolerating typos", () => {
    expect(scoreModelPickerSearch(opus, "coplt op")).not.toBeNull();
    expect(scoreModelPickerSearch({
      family: "openai",
      providerDisplayName: "Codex",
      name: "GPT-5 Codex",
    }, "coplt op")).toBeNull();
    expect(scoreModelPickerSearch(opus, "")).toBe(0);
  });

  it("ranks exact text above fuzzy text and favorite boosts", () => {
    const exactScore = scoreModelPickerSearch(opus, "copilot opus");
    const fuzzyScore = scoreModelPickerSearch(opus, "coplt op");
    const favoriteScore = scoreModelPickerSearch({
      family: "anthropic",
      providerDisplayName: "Claude",
      name: "Claude Opus 4.8 1M",
      isFavorite: true,
    }, "opus 4.8");
    const nonFavoriteExactScore = scoreModelPickerSearch({
      family: "cursor",
      providerDisplayName: "Cursor",
      name: "Opus 4.8 1M",
    }, "opus 4.8");

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });

  it("matches provider names and discovered aliases", () => {
    expect(scoreModelPickerSearch({
      family: "openai",
      providerDisplayName: "Codex Personal",
      name: "GPT-5 Codex",
    }, "personal")).not.toBeNull();
    expect(scoreModelPickerSearch({
      family: "cursor",
      providerDisplayName: "Cursor",
      name: "Composer 2",
      aliases: ["composer-latest"],
    }, "composer-latest")).not.toBeNull();
  });
});

function cursorCatalog(availability: { sdk: boolean; cli: boolean }): AgentChatModelCatalog {
  return {
    fetchedAt: new Date().toISOString(),
    groups: [{
      key: "cursor",
      displayName: "Cursor",
      providers: [{
        key: "cursor",
        displayName: "Cursor",
        badgeColor: "#60A5FA",
        modelCount: 1,
        subsections: [{
          key: "cursor",
          label: "Cursor",
          models: [{
            id: "cursor/composer-2",
            runtimeModelId: "cursor/composer-2",
            provider: "cursor",
            providerKey: "cursor",
            groupKey: "cursor",
            displayName: "Composer 2",
            isDefault: true,
            isAvailable: true,
            supportsReasoning: true,
            supportsTools: true,
            cursorAvailability: availability,
          }],
        }],
      }],
    }],
  };
}

describe("runtime catalog cache flavor-aware cursor freshness", () => {
  beforeEach(() => {
    resetModelPickerRuntimeCatalogForTests();
  });

  it("keeps CLI stale after an SDK-only refresh", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: false }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });

  it("tracks the probed source even when rows support both flavors", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
      cursorSource: "sdk",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
  });

  it("marks both surfaces fresh after a full dual-capable refresh", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(true);
  });

  it("starts stale for every cursor flavor", () => {
    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor", "cli")).toBe(false);
    expect(runtimeCatalogProviderIsFresh("cursor")).toBe(false);
  });
});
