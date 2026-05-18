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
});
