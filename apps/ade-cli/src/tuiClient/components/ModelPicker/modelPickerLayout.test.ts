import { describe, expect, it } from "vitest";
import type { AgentChatModelInfo } from "../../../../../desktop/src/shared/types/chat";
import { buildModelPickerLayout, defaultSelectionFor } from "./modelPickerLayout";

function modelInfo(overrides: Partial<AgentChatModelInfo> & { id: string }): AgentChatModelInfo {
  return {
    displayName: overrides.displayName ?? overrides.id,
    isDefault: false,
    ...overrides,
  };
}

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
