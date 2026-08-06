import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  let nextSessionId = 1;
  const makeStream = (sessionId: string) => (async function* () {
    yield {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${sessionId}`,
          sessionID: sessionId,
          type: "text",
          text: "pong",
        },
        delta: "pong",
      },
    };
    yield {
      type: "message.part.updated",
      properties: {
        part: {
          id: `step-${sessionId}`,
          sessionID: sessionId,
          type: "step-finish",
          tokens: {
            input: 1,
            output: 1,
            cache: { read: 0, write: 0 },
          },
        },
      },
    };
    yield {
      type: "session.idle",
      properties: {
        sessionID: sessionId,
      },
    };
  })();
  const makeLease = (url: string) => ({
    url,
    release: vi.fn(),
    close: vi.fn(),
    touch: vi.fn(),
    setBusy: vi.fn(),
    setEvictionHandler: vi.fn(),
  });

  return {
    resetSessionIds: () => {
      nextSessionId = 1;
    },
    sharedLease: makeLease("http://127.0.0.1:4101"),
    dedicatedLease: makeLease("http://127.0.0.1:4102"),
    createSession: vi.fn(async () => ({
      data: { id: `opencode-session-${nextSessionId++}` },
    })),
    promptAsync: vi.fn(async () => ({})),
    eventSubscribe: vi.fn(async () => {
      const sessionId = `opencode-session-${Math.max(1, nextSessionId - 1)}`;
      return { stream: makeStream(sessionId) };
    }),
    getSession: vi.fn(async () => {
      throw new Error("session not found");
    }),
  };
});

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({
    event: {
      subscribe: mockState.eventSubscribe,
    },
    session: {
      create: mockState.createSession,
      get: mockState.getSession,
      promptAsync: mockState.promptAsync,
    },
  })),
}));

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(() => ({
    question: {
      reply: vi.fn(),
      reject: vi.fn(),
    },
    permission: {
      reply: vi.fn(),
    },
  })),
}));

const apiKeyState = vi.hoisted(() => ({ keys: {} as Record<string, string> }));

vi.mock("../ai/apiKeyStore", () => ({
  getAllApiKeys: () => ({ ...apiKeyState.keys }),
  getApiKey: (id: string) => apiKeyState.keys[id.trim().toLowerCase()] ?? null,
}));

vi.mock("./openCodeBinaryManager", () => ({
  resolveOpenCodeBinaryPath: vi.fn(() => "/Users/admin/.opencode/bin/opencode"),
}));

vi.mock("./openCodeServerManager", () => ({
  acquireSharedOpenCodeServer: vi.fn(async () => mockState.sharedLease),
  acquireDedicatedOpenCodeServer: vi.fn(async () => mockState.dedicatedLease),
  getOpenCodeRuntimeDiagnostics: vi.fn(() => ({
    sharedCount: 1,
    dedicatedCount: 0,
    entries: [],
  })),
}));

import {
  __resetOpenCodeRuntimeDiagnosticsForTests,
  buildOpenCodeConfig,
  getOpenCodeRuntimeSnapshot,
  refreshOpenCodeSessionToolSelection,
  runOpenCodeTextPrompt,
  startOpenCodeSession,
} from "./openCodeRuntime";
import {
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
} from "./openCodeServerManager";

describe("openCodeRuntime", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockState.resetSessionIds();
    __resetOpenCodeRuntimeDiagnosticsForTests();
  });

  it("starts a shared OpenCode session without per-session ADE tool registration", async () => {
    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Shared chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(acquireSharedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        agent: expect.objectContaining({
          "ade-plan": expect.objectContaining({
            tools: expect.objectContaining({ code_search: false, web_search: false }),
            permission: expect.objectContaining({ question: "allow" }),
          }),
          "ade-helper": expect.objectContaining({
            permission: expect.objectContaining({ question: "deny" }),
          }),
        }),
      }),
    }));
    expect(handle.toolSelection).toBeNull();

    await handle.close("handle_close");
    expect(mockState.sharedLease.close).toHaveBeenCalledWith("handle_close");
  });

  it("passes lead isolation through to a dedicated OpenCode server", async () => {
    await startOpenCodeSession({
      directory: "/repo",
      title: "Lead chat",
      leaseKind: "dedicated",
      isolatedConfig: true,
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "lead-1",
      ownerKey: "chat:lead-1",
    });

    expect(acquireDedicatedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      isolatedConfig: true,
      ownerKey: "chat:lead-1",
    }));
  });

  it("omits the session title when ADE wants OpenCode to auto-name", async () => {
    await startOpenCodeSession({
      directory: "/repo",
      title: null,
      leaseKind: "shared",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
    });

    expect(mockState.createSession).toHaveBeenCalledWith(expect.objectContaining({
      body: {},
    }));
  });

  it("applies no scoped tool selection to one-shot prompts", async () => {
    const result = await runOpenCodeTextPrompt({
      directory: "/repo",
      title: "One-shot prompt",
      modelDescriptor: {
        id: "opencode/openai/gpt-5-mini",
        family: "openai",
        providerRoute: "opencode",
        providerModelId: "openai/gpt-5-mini",
        openCodeProviderId: "openai",
        openCodeModelId: "gpt-5-mini",
      } as any,
      prompt: "ping",
      projectConfig: { ai: {} },
    });

    expect(result.text).toBe("pong");
    expect(mockState.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.not.objectContaining({
        tools: expect.anything(),
      }),
    }));
  });

  it("reports OpenCode runtime diagnostics for shared and dedicated sessions", () => {
    const snapshot = getOpenCodeRuntimeSnapshot();

    expect(snapshot.sharedCount).toBe(1);
    expect(snapshot.dedicatedCount).toBe(0);
    expect(Object.keys(snapshot).sort()).toEqual(["dedicatedCount", "entries", "sharedCount"]);
  });
});

describe("buildOpenCodeConfig provider injection", () => {
  beforeEach(() => {
    apiKeyState.keys = {};
  });

  const providerOf = (ai: Record<string, unknown>): Record<string, any> =>
    (buildOpenCodeConfig({ projectConfig: { ai } as any }).provider ?? {}) as Record<string, any>;

  it("emits a full provider block for each custom provider", () => {
    const provider = providerOf({
      customProviders: [
        {
          id: "acme",
          name: "Acme AI",
          baseURL: "https://acme.example/v1",
          models: ["acme-large", "acme-small"],
        },
      ],
    });

    expect(provider.acme).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Acme AI",
      options: { baseURL: "https://acme.example/v1" },
      models: { "acme-large": {}, "acme-small": {} },
    });
  });

  it("honors an explicit npm package and injects the configured api key", () => {
    // Key injection is asserted through the project-config path: the encrypted
    // key store resolves via a CJS require that vitest's ESM mocks can't
    // intercept (it degrades to a no-op here by design), and both paths merge
    // through the same provider options object.
    const provider = providerOf({
      apiKeys: { acme: "sk-acme" },
      customProviders: [
        {
          id: "acme",
          name: "Acme",
          baseURL: "https://acme.example/v1",
          npm: "@ai-sdk/anthropic",
          models: ["m1"],
        },
      ],
    });

    expect(provider.acme.npm).toBe("@ai-sdk/anthropic");
    expect(provider.acme.options).toEqual({
      baseURL: "https://acme.example/v1",
      apiKey: "sk-acme",
    });
  });

  it("skips custom providers missing an id, baseURL, or models", () => {
    const provider = providerOf({
      customProviders: [
        { id: "", name: "no id", baseURL: "https://x/v1", models: ["m"] },
        { id: "nourl", name: "no url", baseURL: "  ", models: ["m"] },
        { id: "nomodels", name: "no models", baseURL: "https://x/v1", models: [] },
      ],
    });

    expect(provider[""]).toBeUndefined();
    expect(provider.nourl).toBeUndefined();
    expect(provider.nomodels).toBeUndefined();
  });

  it("merges a custom model slug into an existing custom provider", () => {
    const provider = providerOf({
      customProviders: [
        { id: "acme", name: "Acme", baseURL: "https://acme.example/v1", models: ["m1"] },
      ],
      customModelSlugs: ["acme/m2"],
    });

    expect(Object.keys(provider.acme.models).sort()).toEqual(["m1", "m2"]);
  });

  it("materializes a bare block for a known-catalog provider slug", () => {
    const provider = providerOf({ customModelSlugs: ["openai/o5-preview"] });
    expect(provider.openai).toEqual({ models: { "o5-preview": {} } });
  });

  it("keeps model ids that contain slashes intact", () => {
    const provider = providerOf({ customModelSlugs: ["openrouter/anthropic/claude-x"] });
    expect(provider.openrouter).toEqual({ models: { "anthropic/claude-x": {} } });
  });

  it("drops malformed and unknown-provider slugs", () => {
    const provider = providerOf({ customModelSlugs: ["noslash", "mysteryco/model"] });
    expect(provider.noslash).toBeUndefined();
    expect(provider.mysteryco).toBeUndefined();
  });
});

describe("refreshOpenCodeSessionToolSelection", () => {
  const handleOf = () => ({ toolSelection: null } as { toolSelection: Record<string, boolean> | null });

  it("withholds OpenCode's native write and shell tools from an orchestrator lead", async () => {
    const handle = handleOf();
    const selection = await refreshOpenCodeSessionToolSelection(
      handle as never,
      { orchestrationLead: true },
    );
    // These are OpenCode's own built-ins, not ADE's toolset — they are what a
    // lead could otherwise use to edit code or run shell directly.
    expect(selection).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      patch: false,
      task: false,
    });
    // Reads stay available so the lead can still plan.
    expect(selection).not.toHaveProperty("read");
    expect(selection).not.toHaveProperty("grep");
    expect(selection).not.toHaveProperty("glob");
    // The handle carries the same map, so a resumed prompt cannot drop it.
    expect(handle.toolSelection).toEqual(selection);
  });

  it("leaves workers and validators on OpenCode's default toolset", async () => {
    for (const options of [undefined, { orchestrationLead: false }]) {
      const handle = handleOf();
      await expect(refreshOpenCodeSessionToolSelection(handle as never, options)).resolves.toBeNull();
      expect(handle.toolSelection).toBeNull();
    }
  });
});
