import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  acquireSharedOpenCodeServer: vi.fn(async () => ({
    url: "http://127.0.0.1:4101",
    release: vi.fn(),
    close: vi.fn(),
    touch: vi.fn(),
    setBusy: vi.fn(),
    setEvictionHandler: vi.fn(),
  })),
  shutdownOpenCodeServers: vi.fn(),
  providerList: vi.fn(async () => ({
    data: {
      connected: ["openai"],
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.4": {
              id: "gpt-5.4",
              name: "GPT-5.4",
              tool_call: true,
              reasoning: true,
              limit: { context: 200000, output: 4000 },
            },
          },
        },
      ],
    },
  })),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({
    provider: {
      list: mockState.providerList,
    },
  })),
}));

vi.mock("./openCodeRuntime", () => ({
  resolveOpenCodeExecutablePath: vi.fn(() => "/Users/admin/.opencode/bin/opencode"),
  buildOpenCodeMergedConfig: vi.fn(() => ({
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    provider: { openai: { options: { apiKey: "test" } } },
  })),
  buildSharedOpenCodeServerKey: vi.fn(() => "shared:test-config"),
}));

vi.mock("./openCodeServerManager", () => ({
  acquireSharedOpenCodeServer: mockState.acquireSharedOpenCodeServer,
  shutdownOpenCodeServers: mockState.shutdownOpenCodeServers,
}));

import {
  __setOpenCodeInventoryPersistencePathForTests,
  clearOpenCodeInventoryCache,
  loadPersistedOpenCodeInventory,
  peekOpenCodeInventoryCache,
  persistOpenCodeInventory,
  probeOpenCodeProviderInventory,
  shutdownInventoryServer,
  type OpenCodeProviderInfo,
} from "./openCodeInventory";

describe("openCodeInventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenCodeInventoryCache();
  });

  it("reuses the same shared OpenCode server key as live sessions", async () => {
    const logger = { warn: vi.fn() } as any;

    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    expect(mockState.acquireSharedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      key: "shared:test-config",
      ownerKind: "inventory",
      ownerId: "/repo",
    }));
  });

  it("only clears cache when shutting down inventory state", () => {
    shutdownInventoryServer();
    expect(mockState.shutdownOpenCodeServers).toHaveBeenCalledWith({ leaseKind: "shared", ownerKind: "inventory" });
  });

  it("invalidates cached inventory when custom provider config changes", async () => {
    const logger = { warn: vi.fn() } as any;

    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: {
        ai: {
          customProviders: [{
            id: "acme",
            name: "Acme",
            baseURL: "https://old.example.test/v1",
            models: ["old-model"],
          }],
        },
      },
      logger,
      force: true,
    });
    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: {
        ai: {
          customProviders: [{
            id: "acme",
            name: "Acme",
            baseURL: "https://new.example.test/v1",
            models: ["new-model"],
          }],
        },
      },
      logger,
    });

    expect(mockState.providerList).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached inventory when custom model slugs change", async () => {
    const logger = { warn: vi.fn() } as any;

    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: { customModelSlugs: ["acme/old-model"] } },
      logger,
      force: true,
    });
    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: { customModelSlugs: ["acme/new-model"] } },
      logger,
    });

    expect(mockState.providerList).toHaveBeenCalledTimes(2);
  });

  it("filters local providers when discovery data is absent", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["ollama"],
        all: [
          {
            id: "ollama",
            name: "Ollama",
            models: {
              "llama-3.1": {
                id: "llama-3.1",
                name: "Llama 3.1",
                tool_call: true,
                reasoning: true,
                limit: { context: 128000, output: 4096 },
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: { localProviders: { ollama: { enabled: true } } } },
      logger,
      force: true,
    });

    expect(result.modelIds).not.toContain("opencode/ollama/llama-3.1");
    expect(result.catalogModelIds).not.toContain("opencode/ollama/llama-3.1");
    expect(result.descriptors).toHaveLength(0);
  });

  it("keeps unconnected cloud providers in the browseable catalog", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-5.4": {
                id: "gpt-5.4",
                name: "GPT-5.4",
                tool_call: true,
                reasoning: true,
              },
            },
          },
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-sonnet-4-6": {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                tool_call: true,
                reasoning: true,
                limit: { context: 200000, output: 32000 },
              },
              "claude-sonnet-5": {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                tool_call: true,
                reasoning: true,
              },
              "claude-opus-4-7": {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                tool_call: true,
                reasoning: true,
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    expect(result.catalogModelIds).toContain("opencode/anthropic/claude-sonnet-5");
    expect(result.catalogModelIds).toContain("opencode/anthropic/claude-opus-4-8");
    expect(result.catalogModelIds).not.toContain("opencode/anthropic/claude-sonnet-4-6");
    expect(result.catalogModelIds).not.toContain("opencode/anthropic/claude-opus-4-7");
    expect(result.descriptors.find((descriptor) => descriptor.id === "opencode/anthropic/claude-sonnet-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(result.modelIds).not.toContain("opencode/anthropic/claude-sonnet-5");
    expect(result.providers.find((provider) => provider.id === "anthropic")?.connected).toBe(false);
  });

  it("prefers canonical OpenCode model rows over normalized retired aliases", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["anthropic"],
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-sonnet-4-6": {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              "claude-sonnet-5": {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                capabilities: {
                  reasoning: true,
                  toolcall: true,
                  input: { image: true },
                },
                variants: {
                  high: {},
                  fast: {},
                },
              },
              "claude-opus-4-7": {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              "claude-opus-4-6": {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              "opus-4-6": {
                id: "opus-4-6",
                name: "Opus 4.6",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              "opus-4.6": {
                id: "opus-4.6",
                name: "Opus 4.6",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              opus: {
                id: "opus",
                name: "Opus",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
                variants: {
                  stale: {},
                },
              },
              "claude-opus-5": {
                id: "claude-opus-5",
                name: "Claude Opus 5",
                capabilities: {
                  reasoning: true,
                  toolcall: true,
                  input: { image: true },
                },
                variants: {
                  high: {},
                  fast: {},
                },
              },
              "claude-opus-4-8": {
                id: "claude-opus-4-8",
                name: "Claude Opus 4.8 1M",
                capabilities: {
                  reasoning: true,
                  toolcall: true,
                  input: { image: true },
                },
                variants: {
                  max: {},
                  fast: {},
                },
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    const descriptor = result.descriptors.find((entry) => entry.id === "opencode/anthropic/claude-sonnet-5");
    const opus5Descriptor = result.descriptors.find((entry) => entry.id === "opencode/anthropic/claude-opus-5");
    const opusDescriptor = result.descriptors.find((entry) => entry.id === "opencode/anthropic/claude-opus-4-8");
    expect(result.descriptors.filter((entry) => entry.id === "opencode/anthropic/claude-sonnet-5")).toHaveLength(1);
    expect(result.descriptors.filter((entry) => entry.id === "opencode/anthropic/claude-opus-5")).toHaveLength(1);
    expect(result.descriptors.filter((entry) => entry.id === "opencode/anthropic/claude-opus-4-8")).toHaveLength(1);
    expect(result.modelIds).not.toContain("opencode/anthropic/claude-opus-4-6");
    expect(result.modelIds).not.toContain("opencode/anthropic/opus-4-6");
    expect(result.modelIds).not.toContain("opencode/anthropic/opus-4.6");
    expect(descriptor?.capabilities).toMatchObject({
      tools: true,
      vision: true,
      reasoning: true,
    });
    expect(descriptor?.reasoningTiers).toEqual(["high"]);
    expect(descriptor?.serviceTiers).toEqual(["fast"]);
    expect(opus5Descriptor).toMatchObject({
      displayName: "Claude Opus 5",
      openCodeModelId: "claude-opus-5",
      providerModelId: "anthropic/claude-opus-5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningTiers: ["high"],
      defaultReasoningEffort: "high",
      serviceTiers: ["fast"],
    });
    expect(opusDescriptor?.capabilities).toMatchObject({
      tools: true,
      vision: true,
      reasoning: true,
    });
    expect(opusDescriptor?.reasoningTiers).toEqual(["max"]);
    expect(opusDescriptor?.serviceTiers).toEqual(["fast"]);
  });

  it("normalizes retired-only Anthropic display ids while routing through advertised aliases", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["anthropic"],
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-sonnet-4-6": {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
              },
              "opus": {
                id: "opus",
                name: "Opus",
                capabilities: {
                  reasoning: false,
                  toolcall: false,
                },
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    expect(result.modelIds).toContain("opencode/anthropic/claude-sonnet-5");
    expect(result.modelIds).toContain("opencode/anthropic/claude-opus-5");
    expect(result.modelIds).not.toContain("opencode/anthropic/claude-sonnet-4-6");
    expect(result.modelIds).not.toContain("opencode/anthropic/opus");
    expect(result.descriptors.find((entry) => entry.id === "opencode/anthropic/claude-sonnet-5")).toMatchObject({
      displayName: "Claude Sonnet 5",
      openCodeModelId: "claude-sonnet-4-6",
      providerModelId: "anthropic/claude-sonnet-4-6",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({
        tools: true,
        vision: true,
        reasoning: true,
      }),
      reasoningTiers: ["low", "medium", "high", "max"],
    });
    expect(result.descriptors.find((entry) => entry.id === "opencode/anthropic/claude-opus-5")).toMatchObject({
      displayName: "Claude Opus 5",
      openCodeModelId: "opus",
      providerModelId: "anthropic/opus",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: expect.objectContaining({
        tools: true,
        vision: true,
        reasoning: true,
      }),
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      serviceTiers: ["fast"],
    });
  });

  it("classifies OpenCode SDK model variants and v2 capabilities", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-5.4": {
                id: "gpt-5.4",
                name: "GPT-5.4",
                capabilities: {
                  reasoning: true,
                  toolcall: true,
                  input: { image: true },
                },
                variants: {
                  low: {},
                  high: {},
                  fast: {},
                  disabled: { disabled: true },
                },
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    const descriptor = result.descriptors.find((entry) => entry.id === "opencode/openai/gpt-5.4");
    expect(descriptor?.reasoningTiers).toEqual(["low", "high"]);
    expect(descriptor?.serviceTiers).toEqual(["fast"]);
    expect(descriptor?.capabilities).toMatchObject({
      tools: true,
      vision: true,
      reasoning: true,
    });
  });

  it("treats OpenCode attachment-capable models as vision-capable", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-5.4": {
                id: "gpt-5.4",
                name: "GPT-5.4",
                attachment: true,
                capabilities: {
                  toolcall: true,
                },
              },
            },
          },
        ],
      },
    } as any);

    const result = await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: {} },
      logger,
      force: true,
    });

    const descriptor = result.descriptors.find((entry) => entry.id === "opencode/openai/gpt-5.4");
    expect(descriptor?.capabilities.vision).toBe(true);
  });

  it("allows passive cache reads after a probe warmed inventory with discovered local models", async () => {
    const logger = { warn: vi.fn() } as any;
    mockState.providerList.mockResolvedValueOnce({
      data: {
        connected: ["openai", "ollama"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-5.4": {
                id: "gpt-5.4",
                name: "GPT-5.4",
                tool_call: true,
                reasoning: true,
                limit: { context: 200000, output: 4000 },
              },
            },
          },
          {
            id: "ollama",
            name: "Ollama",
            models: {
              "llama-3.1": {
                id: "llama-3.1",
                name: "Llama 3.1",
                tool_call: true,
                reasoning: true,
                limit: { context: 128000, output: 4096 },
              },
            },
          },
        ],
      },
    } as any);

    await probeOpenCodeProviderInventory({
      projectRoot: "/repo",
      projectConfig: { ai: { localProviders: { ollama: { enabled: true } } } },
      logger,
      force: true,
      discoveredLocalModels: [
        {
          provider: "ollama",
          modelId: "llama-3.1",
          loaded: true,
        },
      ],
    });

    expect(peekOpenCodeInventoryCache({
      projectRoot: "/repo",
      projectConfig: { ai: { localProviders: { ollama: { enabled: true } } } },
    })).toEqual(expect.objectContaining({
      modelIds: expect.arrayContaining([
        "opencode/openai/gpt-5.4",
        "opencode/ollama/llama-3.1",
      ]),
    }));
  });
});

describe("openCode inventory persistence", () => {
  let cacheFile: string;

  const providers: OpenCodeProviderInfo[] = [
    { id: "openai", name: "OpenAI", connected: true, modelCount: 12 },
    { id: "moonshotai", name: "Moonshot", connected: false, modelCount: 4 },
  ];

  beforeEach(() => {
    cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-inv-")), "inventory.json");
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);
  });

  afterEach(() => {
    __setOpenCodeInventoryPersistencePathForTests(null);
    try {
      fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  it("persists a probe's provider list and reloads it from disk on a cold read", () => {
    persistOpenCodeInventory("/repo", providers);

    // Drop the in-memory memo so the read comes straight from disk (cold path).
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);

    expect(loadPersistedOpenCodeInventory("/repo")).toEqual(providers);
  });

  it("keeps provider lists isolated per project root", () => {
    persistOpenCodeInventory("/repo", providers);
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);

    expect(loadPersistedOpenCodeInventory("/other")).toEqual([]);
  });

  it("returns an empty list when nothing has been persisted", () => {
    expect(loadPersistedOpenCodeInventory("/repo")).toEqual([]);
  });

  it("discards malformed persisted entries while preserving valid projects", () => {
    fs.writeFileSync(cacheFile, JSON.stringify({
      "/valid": { providers, savedAt: Date.now() },
      "/providers-not-array": { providers: "invalid", savedAt: Date.now() },
      "/invalid-provider": {
        providers: [{ id: "openai", name: "OpenAI", connected: "yes", modelCount: 12 }],
        savedAt: Date.now(),
      },
      "/invalid-timestamp": { providers, savedAt: "yesterday" },
    }), "utf8");
    __setOpenCodeInventoryPersistencePathForTests(cacheFile);

    expect(loadPersistedOpenCodeInventory("/valid")).toEqual(providers);
    expect(loadPersistedOpenCodeInventory("/providers-not-array")).toEqual([]);
    expect(loadPersistedOpenCodeInventory("/invalid-provider")).toEqual([]);
    expect(loadPersistedOpenCodeInventory("/invalid-timestamp")).toEqual([]);
  });
});
