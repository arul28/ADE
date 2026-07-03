import { describe, expect, it } from "vitest";
import { buildModelPickerLayoutInput, modelPickerRefreshProvider } from "../modelPickerController";
import type { AdeCodeModelState, ModelPickerRightPaneContent } from "../types";

const modelState: Pick<AdeCodeModelState, "modelId" | "reasoningEffort" | "interfaceMode"> = {
  modelId: "openai/gpt-5.5",
  reasoningEffort: "medium",
  interfaceMode: "chat",
};

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
