import { describe, expect, it } from "vitest";
import { createDynamicDroidCliModelDescriptor } from "../../../shared/modelRegistry";
import { buildProviderGroupBlocks, createModelOrderMap } from "./providerModelSelectorGrouping";

describe("providerModelSelectorGrouping", () => {
  it("splits Droid custom models from Factory-provided family buckets", () => {
    const custom = createDynamicDroidCliModelDescriptor("custom:claude-sonnet-5-thinking-32000");
    const factoryProvided = createDynamicDroidCliModelDescriptor("claude-sonnet-5");

    const droidGroup = buildProviderGroupBlocks([custom, factoryProvided], createModelOrderMap())
      .find((group) => group.key === "droid");
    const provider = droidGroup?.providers.find((entry) => entry.key === "factory");

    expect(provider?.subsections.map((sub) => sub.label)).toEqual([
      "Anthropic (Droid)",
      "Custom models",
    ]);
    expect(provider?.subsections[0]?.models.map((model) => model.id)).toEqual(["droid/claude-sonnet-5"]);
    expect(provider?.subsections[1]?.models.map((model) => model.id)).toEqual([
      "droid/custom:claude-sonnet-5-thinking-32000",
    ]);
  });
});
