import { describe, expect, it } from "vitest";
import {
  createDynamicLocalModelDescriptor,
  getAvailableModels,
  getDefaultModelDescriptor,
  getModelById,
  listModelDescriptorsForProvider,
  resolveModelDescriptor,
} from "./modelRegistry";

describe("modelRegistry", () => {
  it("resolves runtime-discovered local model ids", () => {
    const descriptor = resolveModelDescriptor("ollama/qwen2.5-coder:32b");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.family).toBe("ollama");
    expect(descriptor?.sdkModelId).toBe("qwen2.5-coder:32b");
    expect(descriptor?.displayName).toBe("qwen2.5-coder:32b (Ollama)");
  });

  it("returns dynamic local descriptors from getModelById", () => {
    const descriptor = getModelById("lmstudio/meta-llama-3.1-70b-instruct");
    expect(descriptor).toBeTruthy();
    expect(descriptor?.family).toBe("lmstudio");
    expect(descriptor?.sdkProvider).toBe("@ai-sdk/openai-compatible");
    expect(descriptor?.authTypes).toEqual(["local"]);
  });

  it("creates stable descriptor ids for local models", () => {
    const descriptor = createDynamicLocalModelDescriptor("vllm", "Qwen/Qwen2.5-Coder");
    expect(descriptor.id).toBe("vllm/Qwen/Qwen2.5-Coder");
    expect(descriptor.sdkModelId).toBe("Qwen/Qwen2.5-Coder");
  });

  it("keeps only the allowed OpenAI chat models in the registry defaults", () => {
    expect(listModelDescriptorsForProvider("codex").map((model) => model.id)).toEqual([
      "openai/gpt-5.4-codex",
      "openai/gpt-5.3-codex",
      "openai/gpt-5.3-codex-spark",
      "openai/gpt-5.2-codex",
      "openai/gpt-5.1-codex-max",
      "openai/gpt-5.1-codex-mini",
    ]);

    expect(getAvailableModels([{ type: "api-key", provider: "openai" }]).map((model) => model.id)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.2",
    ]);
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.4-codex");
    expect(getDefaultModelDescriptor("unified")?.id).toBe("openai/gpt-5.4");
  });

  it("exposes GPT-5.4-Mini with the expected reasoning tiers", () => {
    expect(getModelById("openai/gpt-5.4-mini")).toMatchObject({
      displayName: "GPT-5.4-Mini",
      reasoningTiers: ["low", "medium", "high", "xhigh"],
    });
  });
});
