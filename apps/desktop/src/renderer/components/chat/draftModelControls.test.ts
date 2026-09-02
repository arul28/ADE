import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { reconcileDraftModelControls } from "./draftModelControls";

function descriptor(overrides: Partial<ModelDescriptor>): ModelDescriptor {
  return {
    id: "cursor/test-model",
    shortId: "test-model",
    displayName: "Test Model",
    family: "cursor",
    authTypes: ["api-key"],
    contextWindow: 100000,
    maxOutputTokens: 8000,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    color: "#A78BFA",
    providerRoute: "cursor-sdk",
    providerModelId: "test-model",
    isCliWrapped: false,
    ...overrides,
  };
}

describe("reconcileDraftModelControls", () => {
  it("clears the thinking level when the model exposes no tiers", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: [] }),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBeNull();
  });

  it("clears the thinking level when the model omits tiers entirely", () => {
    const result = reconcileDraftModelControls(
      descriptor({}),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBeNull();
  });

  it("keeps a thinking level the model still lists", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium", "high", "xhigh"] }),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBe("xhigh");
  });

  it("matches a thinking level case-insensitively and returns the model's spelling", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium", "high"] }),
      { reasoningEffort: " HIGH ", fastMode: false },
    );
    expect(result.reasoningEffort).toBe("high");
  });

  it("falls back to the advertised default when the level is not listed", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium", "high"], defaultReasoningEffort: "medium" }),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBe("medium");
  });

  it("clears the level when the advertised default is not a real tier", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium"], defaultReasoningEffort: "ultra" }),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBeNull();
  });

  it("clears the level when the model advertises no default", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium"] }),
      { reasoningEffort: "xhigh", fastMode: false },
    );
    expect(result.reasoningEffort).toBeNull();
  });

  it("keeps an auto (null) level as auto", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low", "medium"], defaultReasoningEffort: "medium" }),
      { reasoningEffort: null, fastMode: false },
    );
    expect(result.reasoningEffort).toBeNull();
  });

  it("turns fast mode off when the model exposes no service tiers", () => {
    const result = reconcileDraftModelControls(
      descriptor({ reasoningTiers: ["low"] }),
      { reasoningEffort: "low", fastMode: true },
    );
    expect(result.fastMode).toBe(false);
  });

  it("turns fast mode off when the model lists service tiers without fast", () => {
    const result = reconcileDraftModelControls(
      descriptor({ serviceTiers: ["priority"] }),
      { reasoningEffort: null, fastMode: true },
    );
    expect(result.fastMode).toBe(false);
  });

  it("keeps fast mode when the model advertises the fast service tier", () => {
    const result = reconcileDraftModelControls(
      descriptor({ serviceTiers: ["fast"] }),
      { reasoningEffort: null, fastMode: true },
    );
    expect(result.fastMode).toBe(true);
  });

  it("leaves both controls untouched when the descriptor does not resolve", () => {
    const current = { reasoningEffort: "xhigh", fastMode: true };
    expect(reconcileDraftModelControls(undefined, current)).toEqual(current);
    expect(reconcileDraftModelControls(null, current)).toEqual(current);
  });
});
