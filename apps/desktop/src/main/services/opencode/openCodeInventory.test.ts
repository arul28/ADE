import { beforeEach, describe, expect, it, vi } from "vitest";

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
  clearOpenCodeInventoryCache,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
  shutdownInventoryServer,
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

    expect(result.catalogModelIds).toContain("opencode/anthropic/claude-sonnet-4-6");
    expect(result.modelIds).not.toContain("opencode/anthropic/claude-sonnet-4-6");
    expect(result.providers.find((provider) => provider.id === "anthropic")?.connected).toBe(false);
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
