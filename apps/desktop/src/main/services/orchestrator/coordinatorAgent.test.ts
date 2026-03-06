import { describe, expect, it } from "vitest";
import { buildCoordinatorCliOptions, shouldUseSdkTools } from "./coordinatorAgent";

describe("shouldUseSdkTools", () => {
  it("keeps SDK tools enabled for Codex CLI models", () => {
    expect(shouldUseSdkTools("openai/gpt-5.3-codex")).toBe(true);
  });

  it("disables SDK tools for Claude CLI models", () => {
    expect(shouldUseSdkTools("anthropic/claude-sonnet-4-6")).toBe(false);
  });

  it("keeps SDK tools enabled for direct API models", () => {
    expect(shouldUseSdkTools("anthropic/claude-sonnet-4-6-api")).toBe(true);
  });
});

describe("buildCoordinatorCliOptions", () => {
  it("configures Claude coordinators for headless MCP execution", () => {
    const cli = buildCoordinatorCliOptions({
      modelId: "anthropic/claude-sonnet-4-6",
      projectRoot: "/tmp/ade-project",
      runId: "run-123",
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });

    expect(cli).toEqual({
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
      claude: {
        permissionMode: "bypassPermissions",
        allowedTools: ["mcp__ade"],
        settingSources: [],
        debugFile: "/tmp/ade-project/.ade/logs/coordinator-run-123.claude.log",
        sessionId: "run-123",
      },
    });
  });

  it("does not inject Claude-only settings for Codex coordinators", () => {
    const cli = buildCoordinatorCliOptions({
      modelId: "openai/gpt-5.3-codex",
      projectRoot: "/tmp/ade-project",
      runId: "run-456",
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });

    expect(cli).toEqual({
      mcpServers: {
        ade: {
          command: "node",
          args: ["/tmp/mcp-server.js"],
        },
      },
    });
  });
});
