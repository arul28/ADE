import { describe, expect, it } from "vitest";
import {
  createDynamicLocalModelDescriptor,
  getModelById,
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
});
