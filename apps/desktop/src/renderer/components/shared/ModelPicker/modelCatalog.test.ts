import { describe, expect, it } from "vitest";
import { mergeSelectorModels } from "./modelCatalog";

describe("mergeSelectorModels", () => {
  it("re-buckets OpenCode-routed models into the 'opencode' family so they appear under one rail", () => {
    const ids = [
      "opencode/anthropic/claude-sonnet-4-6",
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
    const ids = ["opencode/anthropic/claude-sonnet-4-6"];
    const merged = mergeSelectorModels(ids, undefined, undefined, "available-only");
    const model = merged.find((m) => m.id === "opencode/anthropic/claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model?.openCodeProviderId).toBe("anthropic");
  });

  it("does not change the family of non-OpenCode models", () => {
    const ids = ["anthropic/claude-sonnet-4-6"];
    const merged = mergeSelectorModels(ids, undefined, undefined, "available-only");
    const model = merged.find((m) => m.id === "anthropic/claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model?.family).toBe("anthropic");
  });

  it("surfaces canonical Droid descriptors when no Droid models are discovered (catalog 'all')", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const droidModels = merged.filter((m) => m.family === "factory");
    // Canonical list has at least Claude/OpenAI/Gemini/Droid Core entries.
    expect(droidModels.length).toBeGreaterThanOrEqual(10);
    // Specific representatives from DROID_CANONICAL_MODEL_IDS.
    expect(droidModels.some((m) => m.id === "droid/claude-sonnet-4-6")).toBe(true);
    expect(droidModels.some((m) => m.id === "droid/gpt-5.4")).toBe(true);
    expect(droidModels.some((m) => m.id === "droid/glm-5")).toBe(true);
  });

  it("surfaces canonical Cursor descriptors when no Cursor models are discovered (catalog 'all')", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const cursorModels = merged.filter((m) => m.family === "cursor");
    expect(cursorModels.some((m) => m.id === "cursor/auto")).toBe(true);
    expect(cursorModels.some((m) => m.id === "cursor/composer-2")).toBe(true);
  });

  it("surfaces canonical OpenCode descriptors when no OpenCode models are discovered (catalog 'all')", () => {
    const merged = mergeSelectorModels(undefined, undefined, undefined, "all");
    const opencodeModels = merged.filter((m) => m.family === "opencode");
    // At least one canonical entry per upstream provider should appear.
    expect(opencodeModels.length).toBeGreaterThanOrEqual(8);
    expect(opencodeModels.some((m) => m.openCodeProviderId === "anthropic")).toBe(true);
    expect(opencodeModels.some((m) => m.openCodeProviderId === "google")).toBe(true);
  });

  it("skips canonical injection for a family when real discovered models exist", () => {
    // Discovery output for Droid — should suppress canonical Droid catalog.
    const merged = mergeSelectorModels(["droid/some-custom-model"], undefined, undefined, "all");
    const droidModels = merged.filter((m) => m.family === "factory");
    // Only the discovered model survives — canonical list is suppressed.
    expect(droidModels.length).toBe(1);
    expect(droidModels[0]!.id).toBe("droid/some-custom-model");
  });

  it("preserves canonical entries for other dynamic providers when one is discovered", () => {
    // Only Droid is discovered — Cursor/OpenCode canonical lists still surface.
    const merged = mergeSelectorModels(["droid/some-model"], undefined, undefined, "all");
    const cursorModels = merged.filter((m) => m.family === "cursor");
    const opencodeModels = merged.filter((m) => m.family === "opencode");
    expect(cursorModels.length).toBeGreaterThanOrEqual(2);
    expect(opencodeModels.length).toBeGreaterThanOrEqual(8);
  });
});
