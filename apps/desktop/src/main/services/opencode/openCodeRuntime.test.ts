import { afterEach, describe, expect, it, vi } from "vitest";

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
  getOpenCodeRuntimeSnapshot,
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
    expect(handle.toolSelection).toBeNull();

    await handle.close("handle_close");
    expect(mockState.sharedLease.close).toHaveBeenCalledWith("handle_close");
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
