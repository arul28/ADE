import fs from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "../shared/utils";

const originalFetch = global.fetch;
let dynamicSocketServer: Server | null = null;
let dynamicSocketDir: string | null = null;
let dynamicSocketPath = "/tmp/ade.sock";

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
    eventSubscribe: vi.fn(async (args?: { query?: { directory?: string } }) => {
      const sessionId = `opencode-session-${Math.max(1, nextSessionId - 1)}`;
      return {
        stream: makeStream(sessionId),
      };
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

function createLaunch(overrides: Partial<Record<string, string>> = {}) {
  return {
    mode: "bundled_proxy" as const,
    command: "node",
    cmdArgs: ["dist/main/adeMcpProxy.cjs", "--project-root", "/repo", "--workspace-root", "/repo"],
    env: {
      ADE_PROJECT_ROOT: "/repo",
      ADE_WORKSPACE_ROOT: "/repo",
      ADE_DEFAULT_ROLE: "agent",
      ...overrides,
    },
    entryPath: "dist/main/adeMcpProxy.cjs",
    runtimeRoot: null,
    socketPath: dynamicSocketPath,
    packaged: false,
    resourcesPath: null,
  };
}

function sanitizeNamePart(value: string | null | undefined, fallback: string): string {
  const normalized = (value?.trim() ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 48) : fallback;
}

function expectedDynamicServerName(args: {
  ownerKind: string;
  ownerId?: string | null;
  ownerKey?: string | null;
  sessionId?: string;
  launch: ReturnType<typeof createLaunch>;
}): string {
  const identity = sanitizeNamePart(
    args.ownerId ?? args.ownerKey ?? args.sessionId,
    "session",
  );
  const launchFingerprint = createHash("sha1")
    .update(stableStringify({
      command: args.launch.command,
      cmdArgs: args.launch.cmdArgs,
      env: args.launch.env,
    }))
    .digest("hex")
    .slice(0, 10);
  return `ade_session_${sanitizeNamePart(args.ownerKind, "owner")}_${identity}_${launchFingerprint}`;
}

describe("openCodeRuntime dynamic ADE MCP registration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockState.resetSessionIds();
    __resetOpenCodeRuntimeDiagnosticsForTests();
    global.fetch = vi.fn();
    dynamicSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-sock-"));
    dynamicSocketPath = path.join(dynamicSocketDir, "mcp.sock");
    dynamicSocketServer = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      dynamicSocketServer!.once("error", reject);
      dynamicSocketServer!.listen(dynamicSocketPath, resolve);
    });
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await new Promise<void>((resolve) => {
      if (!dynamicSocketServer) {
        resolve();
        return;
      }
      dynamicSocketServer.close(() => resolve());
    });
    dynamicSocketServer = null;
    if (dynamicSocketPath) {
      try {
        fs.unlinkSync(dynamicSocketPath);
      } catch {
        // ignore
      }
    }
    if (dynamicSocketDir) {
      try {
        fs.rmdirSync(dynamicSocketDir);
      } catch {
        // ignore
      }
    }
    dynamicSocketDir = null;
    dynamicSocketPath = "/tmp/ade.sock";
  });

  it("registers a per-session ADE MCP server on the shared OpenCode runtime and scopes tools to it", async () => {
    const launch = createLaunch({
      ADE_CHAT_SESSION_ID: "chat-1",
    });
    const serverName = expectedDynamicServerName({
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
      launch,
    });

    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("true", { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      [serverName]: { status: "connected" },
      pencil: { status: "connected" },
    }), { status: 200 }));

    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Shared chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: launch,
      ownerKind: "chat",
      ownerId: "chat-1",
      ownerKey: "chat:chat-1",
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(handle.toolSelection).toEqual(expect.objectContaining({
      "ade_session_*": false,
      [`${serverName}_*`]: true,
      "pencil_*": false,
    }));

    const enabledToolPattern = Object.entries(handle.toolSelection ?? {}).find(([, enabled]) => enabled === true)?.[0];
    expect(enabledToolPattern).toMatch(/^ade_session_chat_chat-1_[a-f0-9]{10}_\*$/);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        href: "http://127.0.0.1:4101/mcp?directory=%2Frepo",
      }),
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        href: "http://127.0.0.1:4101/mcp?directory=%2Frepo",
      }),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"name\":\"ade_session_chat_chat-1_"),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        href: `http://127.0.0.1:4101/mcp/${encodeURIComponent(serverName)}/connect?directory=%2Frepo`,
      }),
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        href: "http://127.0.0.1:4101/mcp?directory=%2Frepo",
      }),
      expect.objectContaining({
        method: "GET",
      }),
    );

    await handle.close("handle_close");

    expect(global.fetch).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        href: `http://127.0.0.1:4101/mcp/${encodeURIComponent(serverName)}/disconnect?directory=%2Frepo`,
      }),
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("reuses an already-connected ADE MCP registration without reconnecting it", async () => {
    const launch = createLaunch({
      ADE_CHAT_SESSION_ID: "chat-connected",
    });
    const serverName = expectedDynamicServerName({
      ownerKind: "chat",
      ownerId: "chat-connected",
      ownerKey: "chat:chat-connected",
      launch,
    });
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      [serverName]: { status: "connected" },
      pencil: { status: "connected" },
    }), { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      [serverName]: { status: "connected" },
      pencil: { status: "connected" },
    }), { status: 200 }));

    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Connected chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: launch,
      ownerKind: "chat",
      ownerId: "chat-connected",
      ownerKey: "chat:chat-connected",
    });

    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(handle.toolSelection).toEqual(expect.objectContaining({
      "ade_session_*": false,
      [`${serverName}_*`]: true,
      "pencil_*": false,
    }));
  });

  it("disables inherited MCP server tools for sessions without ADE MCP attached", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      pencil: { status: "connected" },
    }), { status: 200 }));

    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Lightweight chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      ownerKind: "chat",
      ownerId: "chat-light",
      ownerKey: "chat:chat-light",
    });

    expect(handle.toolSelection).toEqual({
      "pencil_*": false,
    });
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it("applies refreshed tool selection to one-shot prompts", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pencil: { status: "connected" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pencil: { status: "connected" },
      }), { status: 200 }));

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
      body: expect.objectContaining({
        tools: {
          "pencil_*": false,
        },
      }),
    }));
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
  });

  it("records dynamic MCP fallback diagnostics for observability", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.mocked(global.fetch).mockResolvedValueOnce(new Response("true", { status: 200 }));

    const successHandle = await startOpenCodeSession({
      directory: "/repo",
      title: "Success chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-success",
      }),
      ownerKind: "chat",
      ownerId: "chat-success",
      ownerKey: "chat:chat-success",
    });
    await successHandle.close("handle_close");

    vi.mocked(global.fetch).mockRejectedValue(new Error("mcp unavailable"));
    await startOpenCodeSession({
      directory: "/repo",
      title: "Fallback chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-fallback-stats",
      }),
      ownerKind: "chat",
      ownerId: "chat-fallback-stats",
      ownerKey: "chat:chat-fallback-stats",
    });

    const snapshot = getOpenCodeRuntimeSnapshot();
    expect(snapshot.sharedCount).toBe(1);
    expect(snapshot.dynamicMcp.registrationAttempts).toBe(2);
    expect(snapshot.dynamicMcp.successfulRegistrations).toBe(1);
    expect(snapshot.dynamicMcp.fallbackCount).toBe(1);
    expect(snapshot.dynamicMcp.lastFallbackOwnerKind).toBe("chat");
    expect(snapshot.dynamicMcp.lastFallbackOwnerId).toBe("chat-fallback-stats");
    expect(snapshot.dynamicMcp.lastFallbackError).toContain("mcp unavailable");
    expect(snapshot.dynamicMcp.lastFallbackAt).toEqual(expect.any(String));
  });

  it("creates distinct tool scopes for different ADE chat identities on the same shared server", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => new Response("{}", { status: 200 }));

    const handleA = await startOpenCodeSession({
      directory: "/repo",
      title: "Chat A",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-a",
      }),
      ownerKind: "chat",
      ownerId: "chat-a",
      ownerKey: "chat:chat-a",
    });

    const handleB = await startOpenCodeSession({
      directory: "/repo",
      title: "Chat B",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-b",
      }),
      ownerKind: "chat",
      ownerId: "chat-b",
      ownerKey: "chat:chat-b",
    });

    const enabledA = Object.keys(handleA.toolSelection ?? {}).find((key) => key !== "ade_session_*");
    const enabledB = Object.keys(handleB.toolSelection ?? {}).find((key) => key !== "ade_session_*");

    expect(enabledA).toBeTruthy();
    expect(enabledB).toBeTruthy();
    expect(enabledA).not.toBe(enabledB);
    expect(enabledA).toContain("chat-a");
    expect(enabledB).toContain("chat-b");
  });

  it("reuses the same dynamic ADE MCP server name when launch env key order differs", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => new Response("{}", { status: 200 }));

    const handleA = await startOpenCodeSession({
      directory: "/repo",
      title: "Chat A",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-stable",
        ADE_OWNER_ID: "owner-stable",
      }),
      ownerKind: "chat",
      ownerId: "chat-stable",
      ownerKey: "chat:chat-stable",
    });

    const handleB = await startOpenCodeSession({
      directory: "/repo",
      title: "Chat A",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: {
        ...createLaunch(),
        env: {
          ADE_OWNER_ID: "owner-stable",
          ADE_DEFAULT_ROLE: "agent",
          ADE_WORKSPACE_ROOT: "/repo",
          ADE_PROJECT_ROOT: "/repo",
          ADE_CHAT_SESSION_ID: "chat-stable",
        },
      },
      ownerKind: "chat",
      ownerId: "chat-stable",
      ownerKey: "chat:chat-stable",
    });

    const enabledA = Object.keys(handleA.toolSelection ?? {}).find((key) => key !== "ade_session_*");
    const enabledB = Object.keys(handleB.toolSelection ?? {}).find((key) => key !== "ade_session_*");

    expect(enabledA).toBeTruthy();
    expect(enabledA).toBe(enabledB);
  });

  it("falls back to a dedicated static ADE MCP launch when dynamic registration fails", async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error("mcp unavailable"));
    const logger = { warn: vi.fn() } as any;

    await startOpenCodeSession({
      directory: "/repo",
      title: "Fallback chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-fallback",
      }),
      ownerKind: "chat",
      ownerId: "chat-fallback",
      ownerKey: "chat:chat-fallback",
      logger,
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(mockState.sharedLease.close).toHaveBeenCalledWith("error");
    expect(acquireDedicatedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        mcp: expect.objectContaining({
          ade: expect.objectContaining({
            type: "local",
            environment: expect.objectContaining({
              ADE_CHAT_SESSION_ID: "chat-fallback",
            }),
          }),
        }),
      }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      "opencode.dynamic_mcp_attach_failed",
      expect.objectContaining({
        ownerKind: "chat",
        ownerId: "chat-fallback",
        fallbackStrategy: "dedicated_static",
      }),
    );
  });

  it("skips dedicated fallback and degrades to a shared session without ADE MCP tools when the socket is unavailable", async () => {
    vi.mocked(global.fetch).mockRejectedValue(
      new Error("[ade-mcp-proxy] Failed to connect: connect ENOENT /tmp/ade.sock"),
    );
    const logger = { warn: vi.fn() } as any;

    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "No MCP chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-no-mcp",
      }),
      ownerKind: "chat",
      ownerId: "chat-no-mcp",
      ownerKey: "chat:chat-no-mcp",
      logger,
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(2);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(handle.toolSelection).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "opencode.dynamic_mcp_attach_failed",
      expect.objectContaining({
        ownerKind: "chat",
        ownerId: "chat-no-mcp",
        fallbackStrategy: "shared_without_mcp",
      }),
    );
  });

  it("fails fast for coordinator sessions when ADE MCP socket startup is unrecoverable", async () => {
    vi.mocked(global.fetch).mockRejectedValue(
      new Error("local mcp startup failed: [ade-mcp-proxy] Failed to connect: connect ENOENT /tmp/ade.sock"),
    );
    const logger = { warn: vi.fn() } as any;

    await expect(startOpenCodeSession({
      directory: "/repo",
      title: "Coordinator",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_RUN_ID: "run-1",
      }),
      ownerKind: "coordinator",
      ownerId: "run-1",
      ownerKey: "coordinator:run-1",
      logger,
    })).rejects.toThrow(/local mcp startup failed/i);

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "opencode.dynamic_mcp_attach_failed",
      expect.objectContaining({
        ownerKind: "coordinator",
        ownerId: "run-1",
        fallbackStrategy: "abort",
      }),
    );
  });

  it("retries dynamic ADE MCP registration before falling back", async () => {
    vi.mocked(global.fetch)
      .mockRejectedValueOnce(new Error("server warming up"))
      .mockRejectedValueOnce(new Error("server warming up"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("true", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const handle = await startOpenCodeSession({
      directory: "/repo",
      title: "Retry chat",
      leaseKind: "shared",
      projectConfig: { ai: {} },
      dynamicMcpLaunch: createLaunch({
        ADE_CHAT_SESSION_ID: "chat-retry",
      }),
      ownerKind: "chat",
      ownerId: "chat-retry",
      ownerKey: "chat:chat-retry",
    });

    expect(acquireSharedOpenCodeServer).toHaveBeenCalledTimes(1);
    expect(acquireDedicatedOpenCodeServer).not.toHaveBeenCalled();
    expect(handle.toolSelection).toBeTruthy();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(6);
  });
});
