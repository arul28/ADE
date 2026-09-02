import { beforeEach, describe, expect, it } from "vitest";
import {
  descriptorsFromAgentChatModelCatalog,
  filterAcpFallbackModelsToRuntimeCatalog,
  getRuntimeCatalogModelDescriptor,
  mergeSelectorModels,
  resetRuntimeCatalogDescriptorCacheForTests,
  resolveModelDescriptorWithRuntimeCatalog,
} from "./modelCatalog";
import { sortModelItems } from "./modelOrdering";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  getSharedRuntimeCatalog,
  rememberRuntimeCatalog,
  reserveRuntimeCatalogScope,
  resetModelPickerRuntimeCatalogForTests,
  runtimeCatalogProviderIsFresh,
} from "./runtimeCatalogCache";
import type { AgentChatModelCatalog } from "../../../../shared/types";
import {
  createDynamicAcpModelDescriptor,
  createDynamicPiModelDescriptor,
} from "../../../../shared/modelRegistry";

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

  it("keeps Pi-routed models in their own provider group with provider metadata intact", () => {
    const descriptor = createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", {
      profileId: "default",
      displayName: "GPT-5.4",
    });
    const merged = mergeSelectorModels([descriptor.id], undefined, undefined, "available-only");
    const model = merged.find((entry) => entry.id === descriptor.id);
    expect(model).toBeDefined();
    expect(model?.providerRoute).toBe("pi-sdk");
    expect(model?.piProviderId).toBe("openai-codex");
    expect(model?.family).toBe("openai");
  });

  it("keeps Pi profile and upstream provider context readable in catalog subsections", () => {
    const descriptor = createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", {
      profileId: "team",
      displayName: "GPT-5.4",
    });
    const catalog: AgentChatModelCatalog = {
      fetchedAt: new Date().toISOString(),
      groups: [{
        key: "pi",
        displayName: "Pi",
        providers: [{
          key: "openai-codex",
          displayName: "OpenAI Codex",
          badgeColor: "#F97316",
          modelCount: 1,
          subsections: [{
            key: "__piprov__:team:openai-codex",
            label: "OpenAI Codex · team",
            models: [{
              id: descriptor.id,
              runtimeModelId: "openai-codex/gpt-5.4",
              provider: "pi",
              providerKey: "openai-codex",
              groupKey: "pi",
              displayName: "GPT-5.4",
              isDefault: true,
              isAvailable: true,
              supportsReasoning: true,
              supportsTools: true,
            }],
          }],
        }],
      }],
    };

    const result = descriptorsFromAgentChatModelCatalog(catalog);
    expect(result.models[0]).toMatchObject({
      family: "pi",
      subProvider: "OpenAI Codex · team",
      subProviderKey: "__piprov__:team:openai-codex",
    });
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

  it("replaces curated ACP rows with the connected provider's live models", () => {
    const qwenFallbacks = mergeSelectorModels(undefined, undefined, undefined, "all")
      .filter((model) => model.family === "qwen");
    const liveQwen = {
      ...createDynamicAcpModelDescriptor("qwen", "gpt-5.5"),
      catalogAvailable: true,
    };

    const filtered = filterAcpFallbackModelsToRuntimeCatalog(
      [...qwenFallbacks, liveQwen],
      [liveQwen],
    );

    expect(filtered.map((model) => model.id)).toEqual(["qwen/gpt-5.5"]);
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
    name: "Claude Opus 4.8",
    subProvider: "GitHub Copilot",
    aliases: ["opus-latest"],
  };

  it("builds provider-agnostic searchable text", () => {
    expect(buildModelPickerSearchText(opus))
      .toBe("claude opus 4.8 github copilot opencode opencode opus-latest");
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
      name: "Claude Opus 4.8",
      isFavorite: true,
    }, "opus 4.8");
    const nonFavoriteExactScore = scoreModelPickerSearch({
      family: "cursor",
      providerDisplayName: "Cursor",
      name: "Opus 4.8",
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

/**
 * A runtime catalog is a fact about ONE machine — its ollama/LM Studio
 * endpoints, its installed cursor-agent, its opencode inventory. The Work tab
 * shows chats from every machine on the account at once, so the cache and the
 * descriptors it feeds are bucketed per machine; a composer targeting machine B
 * must never be answered from machine A's catalog.
 */
describe("runtime catalog machine scoping", () => {
  const FOREIGN_SCOPE = "remote:target-2:project-2";

  beforeEach(() => {
    resetModelPickerRuntimeCatalogForTests();
    resetRuntimeCatalogDescriptorCacheForTests();
  });

  function localModelCatalog(modelId: string, reasoningEfforts: string[]): AgentChatModelCatalog {
    return {
      groups: [{
        key: "ollama",
        label: "Ollama",
        providers: [{
          key: "ollama",
          displayName: "Ollama",
          modelCount: 1,
          subsections: [{
            key: "ollama",
            label: "Ollama",
            models: [{
              id: modelId,
              displayName: modelId,
              family: "ollama",
              groupKey: "ollama",
              isAvailable: true,
              supportsReasoning: true,
              supportsTools: true,
              reasoningEfforts: reasoningEfforts.map((effort) => ({ effort })),
            }],
          }],
        }],
      }],
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
    } as unknown as AgentChatModelCatalog;
  }

  it("keeps each machine's catalog in its own bucket", () => {
    const bound = localModelCatalog("ollama/llama-bound", ["low"]);
    const foreign = localModelCatalog("ollama/llama-foreign", ["low"]);

    rememberRuntimeCatalog(bound, { mode: "cached" });
    rememberRuntimeCatalog(foreign, { mode: "cached", scopeKey: FOREIGN_SCOPE });

    expect(getSharedRuntimeCatalog()).toBe(bound);
    expect(getSharedRuntimeCatalog(FOREIGN_SCOPE)).toBe(foreign);
  });

  it("does not offer one machine's local models to another machine's picker", () => {
    rememberRuntimeCatalog(localModelCatalog("ollama/llama-bound", ["low"]), { mode: "cached" });
    const boundIds = descriptorsFromAgentChatModelCatalog(
      getSharedRuntimeCatalog(),
    ).availableModelIds;

    expect(boundIds).toContain("ollama/llama-bound");
    // The foreign machine has reported nothing yet, so its picker has no
    // catalog at all rather than inheriting the bound machine's rows.
    expect(getSharedRuntimeCatalog(FOREIGN_SCOPE)).toBeNull();
  });

  it("resolves thinking levels from the composer's own machine", () => {
    const sharedId = "ollama/llama-3";
    rememberRuntimeCatalog(localModelCatalog(sharedId, ["low"]), { mode: "cached" });
    rememberRuntimeCatalog(localModelCatalog(sharedId, ["low", "high"]), {
      mode: "cached",
      scopeKey: FOREIGN_SCOPE,
    });
    descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog());
    descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog(FOREIGN_SCOPE), undefined, FOREIGN_SCOPE);

    expect(resolveModelDescriptorWithRuntimeCatalog(sharedId)?.reasoningTiers).toEqual(["low"]);
    expect(resolveModelDescriptorWithRuntimeCatalog(sharedId, FOREIGN_SCOPE)?.reasoningTiers)
      .toEqual(["low", "high"]);
  });

  // Regression: the scoped lookup used to answer a miss from the bound
  // machine's bucket. That is the same cross-machine leak in a narrower place —
  // a composer on the Studio would show the ladder THIS Mac reported for the
  // same model id, whenever the Studio's catalog had not loaded yet (the normal
  // state before its picker is first opened).
  it("never answers one machine's descriptor miss from another machine's bucket", () => {
    const sharedId = "ollama/llama-3";
    rememberRuntimeCatalog(localModelCatalog(sharedId, ["low", "high", "max"]), { mode: "cached" });
    descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog());

    // The bound machine knows this model and its ladder...
    expect(resolveModelDescriptorWithRuntimeCatalog(sharedId)?.reasoningTiers)
      .toEqual(["low", "high", "max"]);
    // ...and the machine that has reported nothing must not inherit either.
    expect(getRuntimeCatalogModelDescriptor(sharedId, FOREIGN_SCOPE)).toBeUndefined();
    expect(resolveModelDescriptorWithRuntimeCatalog(sharedId, FOREIGN_SCOPE)?.reasoningTiers)
      .toBeUndefined();
  });

  // The bucket cap is a backstop, but evicting the BOUND machine would make the
  // common case refetch — it is the bucket every unpinned surface reads. Its
  // descriptors ride in the same bucket, so eviction must drop both together
  // rather than leaving a descriptor registry to grow on its own.
  it("caps machine buckets without ever evicting the bound machine", () => {
    rememberRuntimeCatalog(localModelCatalog("ollama/bound", ["low"]), { mode: "cached" });
    descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog());
    expect(getRuntimeCatalogModelDescriptor("ollama/bound")).toBeDefined();

    // Far more machines than the cap, none of them the bound one.
    for (let i = 0; i < 20; i += 1) {
      const scopeKey = `remote:target-${i}:project-${i}`;
      rememberRuntimeCatalog(localModelCatalog(`ollama/m-${i}`, ["low"]), { mode: "cached", scopeKey });
      descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog(scopeKey), undefined, scopeKey);
    }

    // The bound machine survived, catalog and descriptors together...
    expect(getSharedRuntimeCatalog()).not.toBeNull();
    expect(getRuntimeCatalogModelDescriptor("ollama/bound")).toBeDefined();
    // ...the most recent foreign machine is still cached...
    expect(getSharedRuntimeCatalog("remote:target-19:project-19")).not.toBeNull();
    // ...and the oldest foreign machine was evicted whole, leaving no orphaned
    // descriptors behind it.
    expect(getSharedRuntimeCatalog("remote:target-0:project-0")).toBeNull();
    expect(getRuntimeCatalogModelDescriptor("ollama/m-0", "remote:target-0:project-0")).toBeUndefined();
  });

  // A catalog fetch is async, so its bucket can be evicted or reset before the
  // response lands. Writing anyway would resurrect a machine the window stopped
  // tracking — and, after a reset, repopulate state something else now owns.
  it("drops a catalog response whose bucket was evicted or reset mid-flight", () => {
    const scopeKey = "remote:target-late:project-late";
    const serial = reserveRuntimeCatalogScope(scopeKey);

    // The bucket disappears while the request is in flight.
    resetModelPickerRuntimeCatalogForTests();

    const late = localModelCatalog("ollama/late", ["low"]);
    // The caller still gets the catalog back for immediate display...
    expect(rememberRuntimeCatalog(late, { mode: "cached", scopeKey, scopeSerial: serial })).toBe(late);
    // ...but the bucket is not resurrected.
    expect(getSharedRuntimeCatalog(scopeKey)).toBeNull();

    // A fresh reservation for the same key is a different bucket, and its own
    // response is written normally.
    const nextSerial = reserveRuntimeCatalogScope(scopeKey);
    expect(nextSerial).not.toBe(serial);
    const current = localModelCatalog("ollama/current", ["low"]);
    rememberRuntimeCatalog(current, { mode: "cached", scopeKey, scopeSerial: nextSerial });
    expect(getSharedRuntimeCatalog(scopeKey)).toBe(current);
  });

  it("marks provider freshness per machine so one machine's refresh cannot silence another's", () => {
    rememberRuntimeCatalog(cursorCatalog({ sdk: true, cli: true }), {
      mode: "force",
      refreshProvider: "cursor",
    });

    expect(runtimeCatalogProviderIsFresh("cursor", "sdk")).toBe(true);
    expect(runtimeCatalogProviderIsFresh("cursor", "sdk", FOREIGN_SCOPE)).toBe(false);
  });

  it("does not treat a cached OpenCode catalog as a live probe", () => {
    rememberRuntimeCatalog({
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
      groups: [{
        key: "opencode",
        displayName: "OpenCode",
        providers: [{
          key: "zen",
          displayName: "Zen",
          badgeColor: "#64748B",
          modelCount: 1,
          subsections: [{
            key: "zen",
            label: "Zen",
            models: [{
              id: "opencode/zen/ox-alpha-free",
              runtimeModelId: "zen/ox-alpha-free",
              provider: "opencode",
              providerKey: "zen",
              groupKey: "opencode",
              displayName: "ox alpha free",
              isDefault: false,
              isAvailable: true,
            }],
          }],
        }],
      }],
    } as unknown as AgentChatModelCatalog, { mode: "cached" });

    expect(runtimeCatalogProviderIsFresh("opencode")).toBe(false);

    rememberRuntimeCatalog({
      fetchedAt: "2026-05-18T00:00:01.000Z",
      stale: false,
      groups: [{
        key: "opencode",
        displayName: "OpenCode",
        providers: [{
          key: "zen",
          displayName: "Zen",
          badgeColor: "#64748B",
          modelCount: 1,
          subsections: [{
            key: "zen",
            label: "Zen",
            models: [{
              id: "opencode/zen/ox-alpha-free",
              runtimeModelId: "zen/ox-alpha-free",
              provider: "opencode",
              providerKey: "zen",
              groupKey: "opencode",
              displayName: "ox alpha free",
              isDefault: false,
              isAvailable: true,
            }],
          }],
        }],
      }],
    } as unknown as AgentChatModelCatalog, { mode: "force", refreshProvider: "opencode" });

    expect(runtimeCatalogProviderIsFresh("opencode")).toBe(true);
  });

  it("keeps live OpenCode thinking tiers in the composer machine bucket, not the unscoped one", () => {
    const liveId = "opencode/zen/ox-alpha-free";
    rememberRuntimeCatalog({
      fetchedAt: "2026-05-18T00:00:00.000Z",
      stale: false,
      groups: [{
        key: "opencode",
        displayName: "OpenCode",
        providers: [{
          key: "zen",
          displayName: "Zen",
          badgeColor: "#64748B",
          modelCount: 1,
          subsections: [{
            key: "zen",
            label: "Zen",
            models: [{
              id: liveId,
              runtimeModelId: "zen/ox-alpha-free",
              provider: "opencode",
              providerKey: "zen",
              groupKey: "opencode",
              displayName: "ox alpha free",
              isDefault: false,
              isAvailable: true,
              reasoningEfforts: ["low", "medium", "high", "max"].map((effort) => ({ effort })),
            }],
          }],
        }],
      }],
    } as unknown as AgentChatModelCatalog, { mode: "force", refreshProvider: "opencode", scopeKey: FOREIGN_SCOPE });
    descriptorsFromAgentChatModelCatalog(getSharedRuntimeCatalog(FOREIGN_SCOPE), undefined, FOREIGN_SCOPE);

    expect(resolveModelDescriptorWithRuntimeCatalog(liveId, FOREIGN_SCOPE)?.reasoningTiers)
      .toEqual(["low", "medium", "high", "max"]);
    expect(resolveModelDescriptorWithRuntimeCatalog(liveId)?.reasoningTiers).toBeUndefined();
  });
});
