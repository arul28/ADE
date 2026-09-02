import { describe, expect, it } from "vitest";
import {
  buildProviderGroupBlocks,
  createModelOrderMap,
  MODEL_PICKER_PROVIDER_ORDER,
} from "./modelCatalog";
import { createDynamicPiModelDescriptor, MODEL_REGISTRY } from "./modelRegistry";

describe("model picker provider order", () => {
  it("keeps the canonical provider sequence after favorites and recents", () => {
    expect(MODEL_PICKER_PROVIDER_ORDER).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "pi",
      "copilot",
      "grok",
      "droid",
      "kimi",
      "qwen",
      "ollama",
      "lmstudio",
    ]);
  });

  it("sorts populated catalog groups in canonical order", () => {
    const groups = buildProviderGroupBlocks(MODEL_REGISTRY, createModelOrderMap(), undefined, false);
    const present = groups.map((group) => group.key);

    expect(present).toEqual(MODEL_PICKER_PROVIDER_ORDER.filter((group) => present.includes(group)));
  });
});

describe("Pi model catalog grouping", () => {
  it("keeps branded provider labels in the Pi rail and subsection", () => {
    const model = createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", {
      profileId: "work",
    });

    const group = buildProviderGroupBlocks([model], createModelOrderMap())
      .find((candidate) => candidate.key === "pi");

    expect(group?.key).toBe("pi");
    expect(group?.label).toBe("Pi");
    expect(group?.providers[0]?.label).toBe("OpenAI Codex");
    expect(group?.providers[0]?.subsections[0]?.label).toBe("OpenAI Codex · work");
    expect(group?.providers[0]?.subsections[0]?.models[0]?.id).toBe(model.id);
  });

  it("keeps Pi profiles in separate readable subsections", () => {
    const models = [
      createDynamicPiModelDescriptor("openai-codex", "gpt-5.4", { profileId: "default" }),
      createDynamicPiModelDescriptor("openai-codex", "gpt-5.5", { profileId: "team" }),
    ];

    const group = buildProviderGroupBlocks(models, createModelOrderMap())
      .find((candidate) => candidate.key === "pi");
    const subsections = group?.providers[0]?.subsections ?? [];

    expect(subsections).toHaveLength(2);
    expect(new Set(subsections.map((section) => section.key)).size).toBe(2);
    expect(subsections.map((section) => section.label)).toEqual([
      "OpenAI Codex",
      "OpenAI Codex · team",
    ]);
  });
});
