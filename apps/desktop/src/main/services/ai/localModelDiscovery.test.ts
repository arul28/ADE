import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalProviderInspectionCache,
  inspectLocalProvider,
  type LocalProviderInspection,
} from "./localModelDiscovery";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  clearLocalProviderInspectionCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearLocalProviderInspectionCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    json: () => Promise.reject(new Error("not found")),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

describe("inspectLocalProvider — ollama", () => {
  it("discovers models from /api/tags response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          { name: "llama3.2:latest" },
          { name: "qwen2.5-vl:7b" },
          { name: "nomic-embed-text:latest" },
        ],
      }),
    );

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");

    expect(result.provider).toBe("ollama");
    expect(result.reachable).toBe(true);
    expect(result.health).toBe("ready");
    expect(result.loadedModels).toHaveLength(3);

    // llama3.2 — should infer tool support
    const llama = result.loadedModels.find((m) => m.modelId === "llama3.2:latest");
    expect(llama).toBeDefined();
    expect(llama!.capabilities?.tools).toBe(true);
    expect(llama!.harnessProfile).toBe("verified");
    expect(llama!.discoverySource).toBe("ollama");

    // qwen2.5-vl — should infer vision + tool support
    const qwen = result.loadedModels.find((m) => m.modelId === "qwen2.5-vl:7b");
    expect(qwen).toBeDefined();
    expect(qwen!.capabilities?.vision).toBe(true);
    expect(qwen!.capabilities?.tools).toBe(true);
    expect(qwen!.harnessProfile).toBe("verified");

    // nomic-embed — should be embedding profile
    const embed = result.loadedModels.find((m) => m.modelId === "nomic-embed-text:latest");
    expect(embed).toBeDefined();
    expect(embed!.capabilities?.tools).toBe(false);
    expect(embed!.capabilities?.vision).toBe(false);
    expect(embed!.harnessProfile).toBe("read_only");
  });

  it("returns unreachable when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");

    expect(result.reachable).toBe(false);
    expect(result.health).toBe("unreachable");
    expect(result.loadedModels).toHaveLength(0);
  });

  it("returns reachable_no_models when API returns empty list", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ models: [] }));

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");

    expect(result.reachable).toBe(true);
    expect(result.health).toBe("reachable_no_models");
    expect(result.loadedModels).toHaveLength(0);
  });

  it("infers reasoning capability from model id patterns", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          { name: "deepseek-r1:14b" },
          { name: "qwq:32b" },
          { name: "phi-4-reasoning:latest" },
        ],
      }),
    );

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");
    for (const model of result.loadedModels) {
      expect(model.capabilities?.reasoning).toBe(true);
    }
  });

  it("strips trailing slashes from endpoint", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ models: [] }));

    await inspectLocalProvider("ollama", "http://localhost:11434///");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

// ---------------------------------------------------------------------------
// LM Studio provider — REST API format
// ---------------------------------------------------------------------------

describe("inspectLocalProvider — lmstudio (REST API)", () => {
  it("discovers models from REST API with loaded_instances", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "qwen2.5-coder-7b",
            display_name: "Qwen 2.5 Coder 7B",
            type: "text",
            max_context_length: 32768,
            capabilities: {
              trained_for_tool_use: true,
              vision: false,
            },
            reasoning: false,
            loaded_instances: [
              {
                id: "qwen2.5-coder-7b-instruct",
                config: { context_length: 16384 },
              },
            ],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    expect(result.provider).toBe("lmstudio");
    expect(result.reachable).toBe(true);
    expect(result.health).toBe("ready");
    expect(result.loadedModels).toHaveLength(1);

    const model = result.loadedModels[0]!;
    expect(model.modelId).toBe("qwen2.5-coder-7b-instruct");
    expect(model.displayName).toBe("Qwen 2.5 Coder 7B");
    expect(model.contextWindow).toBe(16384);
    expect(model.capabilities?.tools).toBe(true);
    expect(model.capabilities?.vision).toBe(false);
    expect(model.capabilities?.reasoning).toBe(false);
    expect(model.harnessProfile).toBe("verified");
    expect(model.discoverySource).toBe("lmstudio-rest");
  });

  it("skips models with no loaded instances", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "not-loaded-model",
            display_name: "Not Loaded",
            type: "text",
            loaded_instances: [],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    expect(result.reachable).toBe(true);
    expect(result.health).toBe("reachable_no_models");
    expect(result.loadedModels).toHaveLength(0);
  });

  it("handles multiple loaded instances per model", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "llama-3.2-8b",
            display_name: "Llama 3.2 8B",
            type: "text",
            max_context_length: 128000,
            capabilities: {},
            loaded_instances: [
              { id: "instance-a", config: { context_length: 4096 } },
              { id: "instance-b", config: { context_length: 8192 } },
            ],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    expect(result.loadedModels).toHaveLength(2);
    // Multi-instance should append instance id in display name
    expect(result.loadedModels[0]!.displayName).toBe("Llama 3.2 8B (instance-a)");
    expect(result.loadedModels[1]!.displayName).toBe("Llama 3.2 8B (instance-b)");
    expect(result.loadedModels[0]!.contextWindow).toBe(4096);
    expect(result.loadedModels[1]!.contextWindow).toBe(8192);
  });

  it("handles reasoning config with supported tiers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "qwq-reasoning",
            display_name: "QWQ Reasoning",
            type: "text",
            capabilities: {},
            reasoning: {
              enabled: true,
              supported_efforts: ["low", "medium", "high"],
            },
            loaded_instances: [{ id: "qwq-32b", config: {} }],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    const model = result.loadedModels[0]!;
    expect(model.capabilities?.reasoning).toBe(true);
    expect(model.reasoningTiers).toEqual(["low", "medium", "high"]);
  });

  it("handles reasoning config as boolean true", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "reason-model",
            type: "text",
            capabilities: {},
            reasoning: true,
            loaded_instances: [{ id: "reason-1", config: {} }],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    const model = result.loadedModels[0]!;
    expect(model.capabilities?.reasoning).toBe(true);
    expect(model.reasoningTiers).toEqual(["low", "medium", "high"]);
  });

  it("sets embedding models to read_only harness profile", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "bge-large",
            type: "embedding",
            capabilities: {},
            loaded_instances: [{ id: "bge-large-en", config: {} }],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    const model = result.loadedModels[0]!;
    expect(model.capabilities?.tools).toBe(false);
    expect(model.harnessProfile).toBe("read_only");
  });
});

// ---------------------------------------------------------------------------
// LM Studio provider — fallback to OpenAI-compat format
// ---------------------------------------------------------------------------

describe("inspectLocalProvider — lmstudio (OpenAI-compat fallback)", () => {
  it("falls back to /v1/models when REST API returns non-object", async () => {
    // First call to /api/v1/models returns null (non-object)
    mockFetch.mockResolvedValueOnce(notFoundResponse());
    // Fallback call to /v1/models
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "llama-3.1-8b-instruct" },
          { id: "gemma-3-12b" },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    expect(result.reachable).toBe(true);
    expect(result.health).toBe("ready");
    expect(result.loadedModels).toHaveLength(2);
    expect(result.loadedModels[0]!.discoverySource).toBe("lmstudio-openai");
    expect(result.loadedModels[0]!.harnessProfile).toBe("verified"); // llama 3.1
  });

  it("returns unreachable when both REST and OpenAI endpoints fail", async () => {
    mockFetch.mockResolvedValueOnce(notFoundResponse());
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    expect(result.reachable).toBe(false);
    expect(result.health).toBe("unreachable");
    expect(result.loadedModels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe("inspectLocalProvider — caching", () => {
  it("returns cached result on second call within TTL", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "llama3.2:latest" }] }),
    );

    const first = await inspectLocalProvider("ollama", "http://localhost:11434");
    const second = await inspectLocalProvider("ollama", "http://localhost:11434");

    // fetch should only be called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same object reference
  });

  it("cache is invalidated by clearLocalProviderInspectionCache", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ models: [{ name: "llama3.2:latest" }] }),
    );

    await inspectLocalProvider("ollama", "http://localhost:11434");
    clearLocalProviderInspectionCache();
    await inspectLocalProvider("ollama", "http://localhost:11434");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses separate cache keys for different provider/endpoint combos", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "model-a" }] }),
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "model-b" }] }),
    );

    const resultA = await inspectLocalProvider("ollama", "http://localhost:11434");
    const resultB = await inspectLocalProvider("ollama", "http://localhost:11435");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(resultA.loadedModels[0]!.modelId).toBe("model-a");
    expect(resultB.loadedModels[0]!.modelId).toBe("model-b");
  });
});

// ---------------------------------------------------------------------------
// Model capability inference edge cases
// ---------------------------------------------------------------------------

describe("inspectLocalProvider — capability inference edge cases", () => {
  it("infers vision for various vision model patterns", async () => {
    const visionModels = [
      "llava-1.5-7b",
      "qwen2.5-vl-7b",
      "gemma-3-12b",
      "llama-3.2-11b-vision",
    ];

    for (const modelName of visionModels) {
      clearLocalProviderInspectionCache();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ models: [{ name: modelName }] }),
      );

      const result = await inspectLocalProvider("ollama", "http://localhost:11434");
      expect(result.loadedModels[0]!.capabilities?.vision).toBe(true);
    }
  });

  it("does not infer vision for non-vision models", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "codellama:7b" }] }),
    );

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");
    expect(result.loadedModels[0]!.capabilities?.vision).toBe(false);
  });

  it("infers guarded harness profile for unknown models", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "some-custom-model:latest" }] }),
    );

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");
    expect(result.loadedModels[0]!.harnessProfile).toBe("guarded");
  });

  it("handles models with empty or whitespace names by filtering them out", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "" }, { name: "  " }, { name: "valid-model" }] }),
    );

    const result = await inspectLocalProvider("ollama", "http://localhost:11434");
    expect(result.loadedModels).toHaveLength(1);
    expect(result.loadedModels[0]!.modelId).toBe("valid-model");
  });

  it("handles LM Studio reasoning config as array of tiers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "reasoning-model",
            type: "text",
            capabilities: {},
            reasoning: ["low", "high", "max"],
            loaded_instances: [{ id: "rm-1", config: {} }],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    const model = result.loadedModels[0]!;
    expect(model.capabilities?.reasoning).toBe(true);
    // "max" normalizes to "xhigh"
    expect(model.reasoningTiers).toEqual(["low", "high", "xhigh"]);
  });

  it("handles LM Studio reasoning config as string tier", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            key: "single-tier",
            type: "text",
            capabilities: {},
            reasoning: "high",
            loaded_instances: [{ id: "st-1", config: {} }],
          },
        ],
      }),
    );

    const result = await inspectLocalProvider("lmstudio", "http://localhost:1234");

    const model = result.loadedModels[0]!;
    expect(model.capabilities?.reasoning).toBe(true);
    expect(model.reasoningTiers).toEqual(["high"]);
  });
});
