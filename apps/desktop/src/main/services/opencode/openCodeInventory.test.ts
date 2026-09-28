import { describe, expect, it } from "vitest";
import { classifyOpenCodeVariants } from "./openCodeInventory";

describe("OpenCode provider inventory", () => {
  it("maps OpenCode 2.0 model variants to ADE effort and service tiers", () => {
    const variants = classifyOpenCodeVariants({
      variants: [
        { id: "default" },
        { id: "medium" },
        { id: "xhigh" },
        { id: "high-fast" },
        { id: "fast" },
        { id: "free" },
        { id: "budget" },
      ],
    });

    expect(variants).toEqual({
      reasoningTiers: ["medium", "xhigh", "free", "budget"],
      serviceTiers: ["fast"],
      variantKeys: {},
      fastVariantKeys: { high: "high-fast" },
    });
    expect(classifyOpenCodeVariants({}).reasoningTiers).toEqual([]);
    expect(classifyOpenCodeVariants({ variants: [{ id: "default" }] }).serviceTiers).toEqual([]);
  });
});
