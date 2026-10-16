import { describe, expect, it } from "vitest";

import { parseDevinModels } from "./devinModelsDiscovery";

const FIXTURE = JSON.stringify({
  families: [
    {
      family_label: "Adaptive",
      slug: "adaptive",
      aliases: [],
      variants: [
        { model_uid: "adaptive", label: "Adaptive", max_context_tokens: 200_000, max_output_tokens: 64_000 },
      ],
    },
    {
      family_label: "SWE-2",
      slug: "swe-2",
      aliases: ["swe"],
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", max_context_tokens: 262_000, max_output_tokens: 128_000 },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium", max_context_tokens: 262_000, max_output_tokens: 128_000 },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
    {
      family_label: "Legacy",
      slug: "legacy",
      aliases: [],
      variants: [{ model_uid: "MODEL_PRIVATE_11", label: "Internal" }],
    },
  ],
});

describe("parseDevinModels", () => {
  it("maps one row per family, preferring the -medium variant", () => {
    const models = parseDevinModels(FIXTURE);
    expect(models.map((model) => model.id)).toEqual(["devin/adaptive", "devin/swe-2-medium"]);

    const swe = models.find((model) => model.id === "devin/swe-2-medium")!;
    expect(swe.providerModelId).toBe("swe-2-medium");
    expect(swe.displayName).toBe("SWE-2 Medium");
    expect(swe.family).toBe("devin");
    expect(swe.isCliWrapped).toBe(true);
    expect(swe.contextWindow).toBe(262_000);
    expect(swe.maxOutputTokens).toBe(128_000);
    // Family label and alias are nameable, the variant uid is the provider id.
    expect(swe.aliases).toEqual(expect.arrayContaining(["swe", "swe-2"]));
  });

  it("drops families whose only variants are internal enum names", () => {
    const models = parseDevinModels(FIXTURE);
    expect(models.some((model) => model.providerModelId.startsWith("MODEL_"))).toBe(false);
    expect(models.some((model) => model.id === "devin/legacy")).toBe(false);
  });

  it("returns an empty list for malformed output instead of throwing", () => {
    expect(parseDevinModels("not json")).toEqual([]);
    expect(parseDevinModels("{}")).toEqual([]);
  });
});
