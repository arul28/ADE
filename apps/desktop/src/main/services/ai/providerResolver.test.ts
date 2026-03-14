import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedAuth } from "./authDetector";
import { normalizeCliMcpServers, resolveModel } from "./providerResolver";

const { createCodexCliMock } = vi.hoisted(() => ({
  createCodexCliMock: vi.fn(),
}));

vi.mock("ai-sdk-provider-codex-cli", () => ({
  createCodexCli: createCodexCliMock,
}));

describe("providerResolver codex CLI", () => {
  beforeEach(() => {
    createCodexCliMock.mockReset();
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
          },
        },
      },
    });

    expect(createCodexCliMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultSettings: expect.objectContaining({
          cwd: "/tmp/worktree",
          mcpServers: {
            ade: {
              transport: "stdio",
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

  it("normalizes ADE MCP server config for both Claude and Codex CLI providers", () => {
    const raw = {
      ade: {
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
      },
    };

    expect(normalizeCliMcpServers("codex", raw)).toEqual({
      ade: {
        transport: "stdio",
        command: "node",
        args: ["/tmp/mcp-server.js"],
        env: { ADE_RUN_ID: "run-1" },
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
});
