import { describe, expect, it, vi } from "vitest";
import { buildCoordinatorCliOptions, CoordinatorAgent, shouldUseSdkTools } from "./coordinatorAgent";
import { buildCoordinatorMcpAllowedTools } from "./coordinatorTools";

function createTestCoordinatorAgent(args?: {
  missionInterventions?: Array<{ metadata_json: string | null }>;
}) {
  return new CoordinatorAgent({
    orchestratorService: {
      getRunGraph: vi.fn(() => ({ steps: [] })),
    } as any,
    runId: "run-1",
    missionId: "mission-1",
    missionGoal: "Test mission",
    modelId: "anthropic/claude-sonnet-4-6",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as any,
    db: {
      get: vi.fn((sql: string) => {
        if (sql.includes("SELECT status FROM orchestrator_runs")) {
          return { status: "active" };
        }
        return null;
      }),
      all: vi.fn((sql: string) => {
        if (sql.includes("from mission_interventions")) {
          return args?.missionInterventions ?? [];
        }
        return [];
      }),
    } as any,
    projectId: "project-1",
    projectRoot: "/tmp/ade-project",
    missionService: {
      get: vi.fn(() => ({ interventions: [] })),
    } as any,
    onDagMutation: vi.fn(),
  });
}

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
  it("includes coordinator observation tools in the Claude allowlist", () => {
    const allowlist = buildCoordinatorMcpAllowedTools("ade");
    expect(allowlist).toEqual(expect.arrayContaining([
      "mcp__ade__get_run_graph",
      "mcp__ade__get_step_output",
      "mcp__ade__get_timeline",
      "mcp__ade__stream_events",
      "mcp__ade__memory_search",
      "mcp__ade__memory_add",
    ]));
  });

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
        permissionMode: "acceptEdits",
        allowedTools: buildCoordinatorMcpAllowedTools("ade"),
        settingSources: [],
        debugFile: "/tmp/ade-project/.ade/logs/coordinator-run-123.claude.log",
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

describe("CoordinatorAgent planning clarification gating", () => {
  it("ignores runtime event polling while a planning clarification is open", () => {
    const agent = createTestCoordinatorAgent({
      missionInterventions: [
        {
          metadata_json: JSON.stringify({ source: "ask_user", phase: "planning" }),
        },
      ],
    }) as any;

    agent.injectEvent({
      type: "status_report",
      runId: "run-1",
    } as any, "scheduler tick");

    expect(agent.eventQueue).toHaveLength(0);
    agent.shutdown();
  });

  it("still accepts direct user messages while a planning clarification is open", () => {
    const agent = createTestCoordinatorAgent({
      missionInterventions: [
        {
          metadata_json: JSON.stringify({ source: "ask_user", phase: "planning" }),
        },
      ],
    }) as any;

    agent.injectMessage("Place the tab in the main navigation group.");

    expect(agent.eventQueue).toHaveLength(1);
    agent.shutdown();
  });
});
