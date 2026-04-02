import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedAuth } from "./authDetector";
import { normalizeCliMcpServers, resolveAutoModelIdFromOpenAiCompatibleEndpoint, resolveModel } from "./providerResolver";

const { createCodexCliMock } = vi.hoisted(() => ({
  createCodexCliMock: vi.fn(),
}));

const { createClaudeCodeMock } = vi.hoisted(() => ({
  createClaudeCodeMock: vi.fn(),
}));

vi.mock("ai-sdk-provider-codex-cli", () => ({
  createCodexCli: createCodexCliMock,
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  createClaudeCode: createClaudeCodeMock,
}));

vi.mock("./claudeCodeExecutable", () => ({
  resolveClaudeCodeExecutable: () => ({
    path: "/mock/bin/claude",
    source: "auth",
  }),
}));

vi.mock("./codexExecutable", () => ({
  resolveCodexExecutable: () => ({
    path: "/mock/bin/codex",
    source: "auth",
  }),
}));

describe("providerResolver codex CLI", () => {
  beforeEach(() => {
    createCodexCliMock.mockReset();
    createClaudeCodeMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("resolves Codex CLI models through the community provider with MCP settings", async () => {
    const sdkModel = { modelId: "mock-codex-model" } as any;
    const providerInstance = vi.fn(() => sdkModel);
    createCodexCliMock.mockReturnValue(providerInstance);

    const auth: DetectedAuth[] = [
      {
        type: "cli-subscription",
        cli: "codex",
        path: "/usr/local/bin/codex",
        authenticated: true,
        verified: true,
      },
    ];

    const resolved = await resolveModel("openai/gpt-5.3-codex", auth, {
      middleware: false,
      cwd: "/tmp/worktree",
      cli: {
        mcpServers: {
          ade: {
            command: "node",
            args: ["/tmp/mcp-server.js"],
            env: {
              ADE_RUN_ID: "run-1",
            },
            required: true,
            startup_timeout_sec: 30,
            tool_timeout_sec: 120,
          },
        },
      },
    });

    expect(createCodexCliMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSettings: expect.objectContaining({
          cwd: "/tmp/worktree",
          codexPath: "/mock/bin/codex",
          mcpServers: {
            ade: {
              transport: "stdio",
              command: "node",
              args: ["/tmp/mcp-server.js"],
              env: {
                ADE_RUN_ID: "run-1",
              },
              required: true,
              startup_timeout_sec: 30,
              tool_timeout_sec: 120,
            },
          },
        }),
      }),
    );
    expect(providerInstance).toHaveBeenCalledWith("gpt-5.3-codex");
    expect(resolved).toBe(sdkModel);
  });

  it("returns a clear auth/subscription error when Codex CLI is unavailable", async () => {
    const auth: DetectedAuth[] = [];

    await expect(
      resolveModel("openai/gpt-5.3-codex", auth, {
        middleware: false,
      }),
    ).rejects.toThrow("Codex CLI is required");

    expect(createCodexCliMock).not.toHaveBeenCalled();
  });

  it("resolves Claude CLI models through the provider with an explicit executable path", async () => {
    const sdkModel = { modelId: "mock-claude-model" } as any;
    const providerInstance = vi.fn(() => sdkModel);
    createClaudeCodeMock.mockReturnValue(providerInstance);

    const auth: DetectedAuth[] = [
      {
        type: "cli-subscription",
        cli: "claude",
        path: "/opt/homebrew/bin/claude",
        authenticated: true,
        verified: true,
      },
    ];

    const resolved = await resolveModel("anthropic/claude-haiku-4-5", auth, {
      middleware: false,
      cwd: "/tmp/worktree",
      cli: {
        mcpServers: {
          ade: {
            command: "node",
            args: ["/tmp/mcp-server.js"],
            env: {
              ADE_RUN_ID: "run-1",
            },
          },
        },
      },
    });

    expect(createClaudeCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSettings: expect.objectContaining({
          cwd: "/tmp/worktree",
          pathToClaudeCodeExecutable: "/mock/bin/claude",
          mcpServers: {
            ade: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-server.js"],
              env: {
                ADE_RUN_ID: "run-1",
              },
            },
          },
        }),
      }),
    );
    expect(providerInstance).toHaveBeenCalledWith("haiku");
    expect(resolved).toBe(sdkModel);
  });

  it("normalizes ADE MCP server config for both Claude and Codex CLI providers", () => {
    const raw = {
      ade: {
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
        required: true,
        startup_timeout_sec: 30,
        tool_timeout_sec: 120,
      },
    };

    expect(normalizeCliMcpServers("codex", raw)).toEqual({
      ade: {
        transport: "stdio",
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
        required: true,
        startup_timeout_sec: 30,
        tool_timeout_sec: 120,
      },
    });

    expect(
      normalizeCliMcpServers("claude", {
        ade: {
          transport: "stdio",
          command: "node",
          args: ["/tmp/mcp-server.js"],
          env: { ADE_RUN_ID: "run-1" },
        },
      }),
    ).toEqual({
      ade: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
      },
    });
  });

  it("uses the saved preferred local model without probing /v1/models", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const resolved = await resolveAutoModelIdFromOpenAiCompatibleEndpoint(
      "http://localhost:1234",
      "lmstudio",
      "lmstudio/qwen2.5-coder:32b",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolved).toBe("qwen2.5-coder:32b");
  });

  it("requires explicit selection when a local runtime reports multiple loaded models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "meta-llama-3.1-70b-instruct" },
          { id: "qwen2.5-coder:32b" },
        ],
      }), { status: 200 }),
    ));

    await expect(
      resolveAutoModelIdFromOpenAiCompatibleEndpoint("http://localhost:1234", "lmstudio"),
    ).rejects.toThrow("Choose a specific model or save a preferred local model");
  });
});
