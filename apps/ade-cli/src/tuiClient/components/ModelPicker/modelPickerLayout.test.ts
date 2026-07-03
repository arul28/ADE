import { describe, expect, it } from "vitest";
import type { AgentChatModelCatalog, AgentChatModelInfo } from "../../../../../desktop/src/shared/types/chat";
import { buildModelPickerLayoutInput, modelPickerRefreshProvider } from "../../modelPickerController";
import type { AdeCodeModelState, ModelPickerRightPaneContent } from "../../types";
import { buildModelPickerLayout, defaultSelectionFor } from "./modelPickerLayout";

function modelInfo(overrides: Partial<AgentChatModelInfo> & { id: string }): AgentChatModelInfo {
  return {
    displayName: overrides.displayName ?? overrides.id,
    isDefault: false,
    ...overrides,
  };
}

const modelState: Pick<AdeCodeModelState, "modelId" | "reasoningEffort" | "interfaceMode"> = {
  modelId: "openai/gpt-5.5",
  reasoningEffort: "medium",
  interfaceMode: "chat",
};

describe("buildModelPickerLayout", () => {
  const models: AgentChatModelInfo[] = [
    modelInfo({ id: "anthropic/claude-opus-4-8", displayName: "Claude Opus 4.8 1M" }),
    modelInfo({ id: "anthropic/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }),
    modelInfo({ id: "openai/gpt-5", displayName: "GPT-5" }),
  ];

  it("emits favorites + recents + provider rails", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "favorites" },
      focusedIndex: 0,
      searchMode: false,
    });
    expect(layout.railEntries[0]?.kind).toBe("favorites");
    expect(layout.railEntries[1]?.kind).toBe("recents");
    expect(layout.railEntries.some((entry) => entry.kind === "provider")).toBe(true);
  });

  it("scopes the entry list to the selected provider", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "codex" },
      focusedIndex: 0,
      searchMode: false,
    });
    expect(layout.entries.every((entry) => entry.family === "codex")).toBe(true);
  });

  it("gates Cursor model availability on the interface mode", () => {
    const cursorModels: AgentChatModelInfo[] = [
      modelInfo({ id: "cursor/sdk-only", displayName: "Cursor SDK Only", family: "cursor", cursorAvailability: { sdk: true, cli: false } }),
      modelInfo({ id: "cursor/cli-only", displayName: "Cursor CLI Only", family: "cursor", cursorAvailability: { sdk: false, cli: true } }),
    ];
    const build = (interfaceMode: "chat" | "cli") => {
      const layout = buildModelPickerLayout({
        models: cursorModels,
        favorites: [],
        recents: [],
        activeModelId: null,
        query: "",
        selection: { kind: "provider", provider: "cursor" },
        focusedIndex: 0,
        searchMode: false,
        interfaceMode,
      });
      const byId = new Map(layout.entries.map((entry) => [entry.modelId, entry] as const));
      return {
        sdkOnly: byId.get("cursor/sdk-only")?.isAvailable,
        cliOnly: byId.get("cursor/cli-only")?.isAvailable,
      };
    };

    // Chat interface: SDK-capable models available, CLI-only disabled.
    expect(build("chat")).toEqual({ sdkOnly: true, cliOnly: false });
    // CLI interface: the mirror image.
    expect(build("cli")).toEqual({ sdkOnly: false, cliOnly: true });
  });

  it("shows static Anthropic rows immediately before the runtime catalog warms", () => {
    const layout = buildModelPickerLayout({
      models: [modelInfo({ id: "openai/gpt-5", displayName: "GPT-5" })],
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "claude" },
      focusedIndex: 0,
      searchMode: false,
    });
    expect(layout.entries.length).toBeGreaterThan(0);
    expect(layout.entries.every((entry) => entry.family === "claude")).toBe(true);
    expect(layout.entries.some((entry) => entry.displayName.includes("Claude"))).toBe(true);
  });

  it("normalizes catalog provider aliases like anthropic into the Anthropic rail", () => {
    const catalog: AgentChatModelCatalog = {
      fetchedAt: "2026-05-29T00:00:00.000Z",
      groups: [{
        key: "anthropic",
        displayName: "Anthropic",
        providers: [{
          key: "anthropic",
          displayName: "Anthropic",
          badgeColor: "#D97757",
          modelCount: 1,
          subsections: [{
            key: "default",
            label: "Anthropic",
            models: [{
              id: "anthropic/claude-sonnet-4-6",
              runtimeModelId: "claude-sonnet-4-6",
              provider: "anthropic",
              providerKey: "anthropic",
              groupKey: "anthropic",
              displayName: "Claude Sonnet 4.6",
              isDefault: true,
              isAvailable: true,
            }],
          }],
        }],
      }],
    };

    const layout = buildModelPickerLayout({
      models: [],
      catalog,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "claude" },
      focusedIndex: 0,
      searchMode: false,
    });
    expect(layout.entries.some((entry) => entry.modelId === "anthropic/claude-sonnet-4-6")).toBe(true);
    expect(layout.entries.every((entry) => entry.family === "claude")).toBe(true);
  });

  it("orders recents by insertion order", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: [],
      recents: ["openai/gpt-5", "anthropic/claude-opus-4-8"],
      activeModelId: null,
      query: "",
      selection: { kind: "recents" },
      focusedIndex: 0,
      searchMode: false,
    });
    expect(layout.entries.map((entry) => entry.modelId)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("treats a non-empty query as cross-provider search", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "opus",
      selection: { kind: "provider", provider: "codex" },
      focusedIndex: 0,
      searchMode: true,
    });
    expect(layout.entries.length).toBeGreaterThan(0);
    expect(layout.entries[0]?.displayName.toLowerCase()).toContain("opus");
  });

  it("marks favorites on the resulting entries", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: ["anthropic/claude-opus-4-8"],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "claude" },
      focusedIndex: 0,
      searchMode: false,
    });
    const opus = layout.entries.find((entry) => entry.modelId === "anthropic/claude-opus-4-8");
    expect(opus?.isFavorite).toBe(true);
  });

  it("preserves Cursor fast and availability metadata from the runtime catalog", () => {
    const catalog: AgentChatModelCatalog = {
      fetchedAt: "2026-05-29T00:00:00.000Z",
      groups: [{
        key: "cursor",
        displayName: "Cursor",
        providers: [{
          key: "cursor",
          displayName: "Cursor",
          badgeColor: "#8B5CF6",
          modelCount: 1,
          subsections: [{
            key: "cursor",
            label: "Cursor",
            models: [{
              id: "cursor/composer-2.5",
              runtimeModelId: "composer-2.5",
              provider: "cursor",
              providerKey: "cursor",
              groupKey: "cursor",
              family: "cursor",
              displayName: "Composer 2.5",
              isDefault: true,
              isAvailable: true,
              serviceTiers: ["fast"],
              cursorAvailability: { cli: true, sdk: true },
            }],
          }],
        }],
      }],
    };

    const layout = buildModelPickerLayout({
      models: [],
      catalog,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "cursor" },
      focusedIndex: 0,
      searchMode: false,
    });

    expect(layout.entries[0]).toMatchObject({
      modelId: "cursor/composer-2.5",
      serviceTiers: ["fast"],
      cursorAvailability: { cli: true, sdk: true },
    });
  });

  it("preserves Cursor fast and availability metadata from direct model results", () => {
    const layout = buildModelPickerLayout({
      models: [
        modelInfo({
          id: "cursor/composer-2.5",
          modelId: "cursor/composer-2.5",
          family: "cursor",
          displayName: "Composer 2.5",
          serviceTiers: ["fast"],
          cursorAvailability: { cli: true, sdk: false },
        }),
      ],
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "cursor" },
      focusedIndex: 0,
      searchMode: false,
    });

    expect(layout.entries[0]).toMatchObject({
      modelId: "cursor/composer-2.5",
      serviceTiers: ["fast"],
      cursorAvailability: { cli: true, sdk: false },
    });
  });

  it("clamps focusedIndex into the visible range", () => {
    const layout = buildModelPickerLayout({
      models,
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "provider", provider: "claude" },
      focusedIndex: 99,
      searchMode: false,
    });
    expect(layout.focusedIndex).toBe(Math.max(0, layout.entries.length - 1));
  });
});

describe("modelPickerController", () => {
  it("only refreshes dynamic model catalog providers", () => {
    expect(modelPickerRefreshProvider("opencode")).toBe("opencode");
    expect(modelPickerRefreshProvider("cursor")).toBe("cursor");
    expect(modelPickerRefreshProvider("droid")).toBe("droid");
    expect(modelPickerRefreshProvider("lmstudio")).toBe("lmstudio");
    expect(modelPickerRefreshProvider("ollama")).toBe("ollama");
    expect(modelPickerRefreshProvider("codex")).toBeNull();
    expect(modelPickerRefreshProvider("claude")).toBeNull();
  });

  it("builds the shared layout input from picker and model state", () => {
    const picker: ModelPickerRightPaneContent = {
      kind: "model-picker",
      surface: "chat",
      query: "sonnet",
      searchMode: true,
      selection: { kind: "provider", provider: "claude" },
      providerTabKey: "anthropic",
      focusedIndex: 2,
      footerFocus: "reasoning",
      settingsRows: [{ kind: "reasoning", label: "Reasoning", value: "high" }],
      laneLabel: "purpose-lane",
    };

    expect(buildModelPickerLayoutInput({
      picker,
      models: [],
      catalog: null,
      favorites: ["openai/gpt-5.5"],
      recents: ["anthropic/claude-sonnet-4-6"],
      modelState,
      aiStatus: null,
    })).toMatchObject({
      query: "sonnet",
      searchMode: true,
      selection: { kind: "provider", provider: "claude" },
      providerTabKey: "anthropic",
      focusedIndex: 2,
      footerFocus: "reasoning",
      activeModelId: "openai/gpt-5.5",
      activeReasoningEffort: "medium",
      interfaceMode: "chat",
      laneLabel: "purpose-lane",
    });
  });
});

describe("defaultSelectionFor", () => {
  it("prefers recents when present", () => {
    const layout = buildModelPickerLayout({
      models: [],
      favorites: [],
      recents: ["openai/gpt-5"],
      activeModelId: null,
      query: "",
      selection: { kind: "favorites" },
      focusedIndex: 0,
      searchMode: false,
    });
    const selection = defaultSelectionFor(null, ["openai/gpt-5"], layout.railEntries);
    expect(selection.kind).toBe("recents");
  });

  it("falls back to the first provider rail when no recents and no active model", () => {
    const layout = buildModelPickerLayout({
      models: [modelInfo({ id: "openai/gpt-5" })],
      favorites: [],
      recents: [],
      activeModelId: null,
      query: "",
      selection: { kind: "favorites" },
      focusedIndex: 0,
      searchMode: false,
    });
    const selection = defaultSelectionFor(null, [], layout.railEntries);
    expect(selection.kind).toBe("provider");
  });
});
