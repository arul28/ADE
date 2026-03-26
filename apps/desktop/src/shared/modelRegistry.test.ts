import { describe, expect, it } from "vitest";
import {
  createDynamicLocalModelDescriptor,
  getAvailableModels,
  getDefaultModelDescriptor,
  getModelById,
  getRuntimeModelRefForDescriptor,
  listModelDescriptorsForProvider,
  MODEL_REGISTRY,
  resolveModelAlias,
  resolveModelDescriptor,
  resolveModelDescriptorForProvider,
} from "./modelRegistry";
import type { ProviderFamily } from "./modelRegistry";
import { describeModelSource } from "../renderer/lib/modelOptions";

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
      "openai/gpt-5.4-mini-codex",
      "openai/gpt-5.3-codex",
      "openai/gpt-5.3-codex-spark",
      "openai/gpt-5.2-codex",
      "openai/gpt-5.1-codex-max",
      "openai/gpt-5.1-codex-mini",
    ]);

    expect(getAvailableModels([{ type: "api-key", provider: "openai" }]).map((model) => model.id)).toEqual([
      "openai/gpt-5.4-pro",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.2",
      "openai/o4-mini",
    ]);
    expect(getDefaultModelDescriptor("codex")?.id).toBe("openai/gpt-5.4-codex");
    expect(getDefaultModelDescriptor("unified")?.id).toBe("openai/gpt-5.4-pro");
  });

  it("exposes GPT-5.4-Mini with the expected reasoning tiers", () => {
    expect(getModelById("openai/gpt-5.4-mini")).toMatchObject({
      displayName: "GPT-5.4-Mini",
      reasoningTiers: ["low", "medium", "high", "xhigh"],
    });
  });

  it("marks API-key models as API only in the shared model source helper", () => {
    expect(describeModelSource(getModelById("openai/gpt-5.4-mini")!)).toBe("API only");
    expect(describeModelSource(getModelById("openai/gpt-5.4-codex")!)).toBe("CLI subscription");
  });

  it("returns undefined for unknown model IDs", () => {
    expect(getModelById("openai/gpt-99")).toBeUndefined();
    expect(resolveModelDescriptor("nonexistent/model-id")).toBeUndefined();
  });

  it("resolves gpt-5.4 shortId to the API-key variant, not the codex variant", () => {
    const resolved = resolveModelAlias("gpt-5.4");
    expect(resolved).toBeTruthy();
    expect(resolved?.id).toBe("openai/gpt-5.4");
  });

  it("resolves gpt-5.4 to the Codex wrapper when the provider is codex", () => {
    const resolved = resolveModelDescriptorForProvider("gpt-5.4", "codex");
    expect(resolved?.id).toBe("openai/gpt-5.4-codex");
  });

  it("resolves gpt-5.4-codex shortId to the codex variant", () => {
    const resolved = resolveModelAlias("gpt-5.4-codex");
    expect(resolved).toBeTruthy();
    expect(resolved?.id).toBe("openai/gpt-5.4-codex");
  });

  it("returns the real Codex runtime model name for wrapped GPT-5.4", () => {
    const descriptor = getModelById("openai/gpt-5.4-codex");
    expect(descriptor).toBeTruthy();
    expect(getRuntimeModelRefForDescriptor(descriptor!, "codex")).toBe("gpt-5.4");
  });

  it("does not contain groq, together, or meta provider families", () => {
    const families = new Set<ProviderFamily>(MODEL_REGISTRY.map((m) => m.family));
    expect(families.has("groq" as ProviderFamily)).toBe(false);
    expect(families.has("together" as ProviderFamily)).toBe(false);
    expect(families.has("meta" as ProviderFamily)).toBe(false);
  });

  it("filters out deprecated models from getAvailableModels", () => {
    const allAuth = [
      { type: "api-key" as const, provider: "openai" },
      { type: "api-key" as const, provider: "anthropic" },
      { type: "cli-subscription" as const },
      { type: "local" as const },
      { type: "openrouter" as const },
    ];
    const available = getAvailableModels(allAuth);
    const deprecatedIds = MODEL_REGISTRY.filter((m) => m.deprecated).map((m) => m.id);
    for (const id of deprecatedIds) {
      expect(available.find((m) => m.id === id)).toBeUndefined();
    }
  });

  it("returns undefined for empty string, undefined-like, and whitespace aliases", () => {
    expect(resolveModelAlias("")).toBeUndefined();
    expect(resolveModelAlias("   ")).toBeUndefined();
    expect(resolveModelDescriptor("")).toBeUndefined();
    expect(resolveModelDescriptor("   ")).toBeUndefined();
  });
});
