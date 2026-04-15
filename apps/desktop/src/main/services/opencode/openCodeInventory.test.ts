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

  it("does not filter local providers when discovery data is absent", async () => {
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

    expect(result.modelIds).toContain("opencode/ollama/llama-3.1");
    expect(result.descriptors).toHaveLength(1);
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
