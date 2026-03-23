import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeReadOnlyWorkerAllowedTools,
  buildCodexMcpConfigFlags,
  createUnifiedOrchestratorAdapter,
  resolveAdeMcpServerLaunch,
} from "./unifiedOrchestratorAdapter";

describe("buildCodexMcpConfigFlags", () => {
  it("shell-escapes TOML override values so zsh does not parse brackets or spaces", () => {
    const flags = buildCodexMcpConfigFlags({
      workspaceRoot: "/Users/admin/Projects/ADE",
      runtimeRoot: "/tmp/ade-runtime",
      preferBundledProxy: false,
      missionId: "mission-123",
      runId: "run-456",
      stepId: "step-789",
      attemptId: "attempt-000",
    });

    expect(flags).toEqual([
      "-c",
      "'mcp_servers.ade.command=\"npx\"'",
      "-c",
      `'mcp_servers.ade.args=["tsx", "/tmp/ade-runtime/apps/mcp-server/src/index.ts", "--project-root", "/Users/admin/Projects/ADE", "--workspace-root", "/Users/admin/Projects/ADE"]'`,
      "-c",
      `'mcp_servers.ade.env.ADE_PROJECT_ROOT="/Users/admin/Projects/ADE"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_WORKSPACE_ROOT="/Users/admin/Projects/ADE"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_MCP_SOCKET_PATH="/Users/admin/Projects/ADE/.ade/mcp.sock"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_MISSION_ID="mission-123"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_RUN_ID="run-456"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_STEP_ID="step-789"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_ATTEMPT_ID="attempt-000"'`,
      "-c",
      `'mcp_servers.ade.env.ADE_DEFAULT_ROLE="agent"'`,
    ]);
  });
});

describe("resolveAdeMcpServerLaunch", () => {
  it("prefers the packaged dist entry when the built MCP server exists", () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-runtime-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-project-"));
    const workspaceRoot = path.join(projectRoot, "workspace");
    const builtEntry = path.join(runtimeRoot, "apps", "mcp-server", "dist", "index.cjs");

    fs.mkdirSync(path.dirname(builtEntry), { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(builtEntry, "module.exports = {};\n", "utf8");

    const launch = resolveAdeMcpServerLaunch({
      projectRoot,
      workspaceRoot,
      runtimeRoot,
      preferBundledProxy: false,
      missionId: "mission-123",
      runId: "run-456",
      stepId: "step-789",
      attemptId: "attempt-000",
      defaultRole: "external",
    });

    expect(launch.command).toBe("node");
    expect(launch.cmdArgs).toEqual([
      builtEntry,
      "--project-root",
      path.resolve(projectRoot),
      "--workspace-root",
      path.resolve(workspaceRoot),
    ]);
    expect(launch.env).toMatchObject({
      ADE_PROJECT_ROOT: path.resolve(projectRoot),
      ADE_WORKSPACE_ROOT: path.resolve(workspaceRoot),
      ADE_MCP_SOCKET_PATH: path.join(path.resolve(projectRoot), ".ade", "mcp.sock"),
      ADE_MISSION_ID: "mission-123",
      ADE_RUN_ID: "run-456",
      ADE_STEP_ID: "step-789",
      ADE_ATTEMPT_ID: "attempt-000",
      ADE_DEFAULT_ROLE: "external",
    });
  });
});

describe("buildClaudeReadOnlyWorkerAllowedTools", () => {
  it("includes only safe native read tools plus ADE reporting/status tools and memory tools", () => {
    expect(buildClaudeReadOnlyWorkerAllowedTools()).toEqual([
      "Read",
      "Glob",
      "Grep",
      "mcp__ade__get_mission",
      "mcp__ade__get_run_graph",
      "mcp__ade__stream_events",
      "mcp__ade__get_timeline",
      "mcp__ade__get_pending_messages",
      "mcp__ade__get_computer_use_backend_status",
      "mcp__ade__list_computer_use_artifacts",
      "mcp__ade__ingest_computer_use_artifacts",
      "mcp__ade__report_status",
      "mcp__ade__report_result",
      "mcp__ade__ask_user",
      "mcp__ade__memory_search",
      "mcp__ade__memory_add",
    ]);
  });

  it("VAL-PLAN-003: planning worker allowlist includes mcp__ade__ask_user for runtime clarifications", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools();
    expect(tools).toContain("mcp__ade__ask_user");
    expect(tools).toContain("mcp__ade__memory_search");
    expect(tools).toContain("mcp__ade__memory_add");
  });

  it("adds ADE-proxied external MCP tools to the allowlist for read-only Claude workers", () => {
    expect(buildClaudeReadOnlyWorkerAllowedTools("ade", ["ext.notion.search"])).toContain(
      "mcp__ade__ext.notion.search",
    );
  });
});

describe("createUnifiedOrchestratorAdapter", () => {
  it("creates managed chat sessions for orchestrated workers when agent chat is available", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-managed-"));
    const createSession = vi.fn(async () => ({ id: "session-managed-1" }));
    const adapter = createUnifiedOrchestratorAdapter({
      workspaceRoot,
      runtimeRoot: path.join(workspaceRoot, "runtime"),
      agentChatService: {
        createSession,
      } as any,
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: {
          missionGoal: "Implement the worker step",
        },
      } as any,
      step: {
        id: "step-1",
        title: "Implementation worker",
        stepKey: "implementation-worker",
        laneId: "lane-1",
        metadata: {
          modelId: "openai/gpt-5.3-codex",
          stepType: "implementation",
        },
        dependencyStepIds: [],
        joinPolicy: "all_success",
      } as any,
      attempt: { id: "attempt-1" } as any,
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "" } as any,
      docsRefs: [],
      fullDocs: [],
      permissionConfig: {
        _providers: {
          codex: "full-auto",
        },
      } as any,
      createTrackedSession: vi.fn(),
    } as any);

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
    }));
    expect(result).toMatchObject({
      status: "accepted",
      sessionId: "session-managed-1",
      launch: expect.objectContaining({
        displayText: 'Execute worker step "Implementation worker".',
      }),
      metadata: expect.objectContaining({
        workerSessionKind: "managed_chat",
        workerStreamSource: "agent_chat",
        startupCommandPreview: "[managed chat session]",
      }),
    });
  });

  it("forces Codex planning steps into a read-only sandbox", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-codex-"));
    const adapter = createUnifiedOrchestratorAdapter({
      workspaceRoot,
      runtimeRoot: path.join(workspaceRoot, "runtime"),
    });

    let startupCommand = "";
    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: { missionGoal: "Plan the work" },
      } as any,
      step: {
        id: "step-1",
        title: "Planning worker",
        stepKey: "planning-worker",
        laneId: "lane-1",
        metadata: {
          modelId: "openai/gpt-5.3-codex",
          readOnlyExecution: true,
        },
        dependencyStepIds: [],
        joinPolicy: "all_success",
      } as any,
      attempt: { id: "attempt-1" } as any,
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "" } as any,
      docsRefs: [],
      fullDocs: [],
      permissionConfig: {
        _providers: {
          codex: "full-auto",
          codexSandbox: "workspace-write",
          writablePaths: ["/tmp/project"],
        },
        cli: {
          sandboxPermissions: "workspace-write",
          writablePaths: ["/tmp/project"],
        },
      } as any,
      createTrackedSession: async ({ startupCommand: command }: { startupCommand: string }) => {
        startupCommand = command;
        return { ptyId: "pty-1", sessionId: "session-1" };
      },
    } as any);

    expect(result.status).toBe("accepted");
    expect(startupCommand).toContain("-a 'untrusted'");
    expect(startupCommand).toContain("-s 'read-only'");
    expect(startupCommand).not.toContain("-s 'workspace-write'");
    expect(startupCommand).not.toContain("--add-dir");
    expect(startupCommand).toContain(" exec -");
    expect(startupCommand).toContain(".ade/cache/orchestrator/worker-prompts/worker-attempt-1.txt");
    expect(startupCommand).not.toContain("Mission goal: Plan the work");
    expect(fs.readFileSync(path.join(workspaceRoot, ".ade", "cache", "orchestrator", "worker-prompts", "worker-attempt-1.txt"), "utf8"))
      .toContain("Mission goal: Plan the work");
    expect(startupCommand).not.toContain("\n");
  });

  it("keeps Claude planning steps in read-only default mode instead of native plan mode", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-claude-"));
    const adapter = createUnifiedOrchestratorAdapter({
      workspaceRoot,
      runtimeRoot: path.join(workspaceRoot, "runtime"),
    });

    let startupCommand = "";
    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: { missionGoal: "Plan the work" },
      } as any,
      step: {
        id: "step-1",
        title: "Planning worker",
        stepKey: "planning-worker",
        laneId: "lane-1",
        metadata: {
          modelId: "anthropic/claude-sonnet-4-6",
          readOnlyExecution: true,
        },
        dependencyStepIds: [],
        joinPolicy: "all_success",
      } as any,
      attempt: { id: "attempt-1" } as any,
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "" } as any,
      docsRefs: [],
      fullDocs: [],
      permissionConfig: {
        _providers: {
          claude: "full-auto",
        },
      } as any,
      createTrackedSession: async ({ startupCommand: command }: { startupCommand: string }) => {
        startupCommand = command;
        return { ptyId: "pty-1", sessionId: "session-1" };
      },
    } as any);

    expect(result.status).toBe("accepted");
    expect(startupCommand).toContain("--permission-mode 'default'");
    expect(startupCommand).not.toContain("--dangerously-skip-permissions");
    expect(startupCommand).toContain("mcp__ade__get_computer_use_backend_status");
    expect(startupCommand).toContain("mcp__ade__list_computer_use_artifacts");
    expect(startupCommand).toContain("mcp__ade__ingest_computer_use_artifacts");
    expect(startupCommand).not.toContain("Bash");
    expect(startupCommand).toContain(`-p "$(cat '`);
    expect(startupCommand).toContain(".ade/cache/orchestrator/worker-prompts/worker-attempt-1.txt");
    expect(startupCommand).not.toContain("Mission goal: Plan the work");
    expect(fs.readFileSync(path.join(workspaceRoot, ".ade", "cache", "orchestrator", "worker-prompts", "worker-attempt-1.txt"), "utf8"))
      .toContain("Mission goal: Plan the work");
    expect(startupCommand).not.toContain("\n");
  });

  it("exposes read-only ADE-proxied external MCP tools to Claude planning workers", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-external-mcp-"));
    let startupCommand = "";
    const adapter = createUnifiedOrchestratorAdapter({
      workspaceRoot,
      runtimeRoot: path.join(workspaceRoot, "runtime"),
      externalMcpService: {
        getSnapshots: () => [
          {
            tools: [
              { namespacedName: "ext.notion.search", enabled: true, safety: "read" },
              { namespacedName: "ext.notion.update", enabled: true, safety: "write" },
            ],
          },
        ],
      },
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: {
          missionGoal: "Plan the work",
        },
      } as any,
      step: {
        id: "step-1",
        title: "Planning worker",
        stepKey: "planning-worker",
        laneId: "lane-1",
        metadata: {
          modelId: "anthropic/claude-sonnet-4-6",
          requiresPlanApproval: true,
        },
        dependencyStepIds: [],
        joinPolicy: "all_success",
      } as any,
      attempt: { id: "attempt-1" } as any,
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "" } as any,
      docsRefs: [],
      fullDocs: [],
      permissionConfig: {
        _providers: {
          claude: "full-auto",
        },
      } as any,
      createTrackedSession: async ({ startupCommand: command }: { startupCommand: string }) => {
        startupCommand = command;
        return { ptyId: "pty-1", sessionId: "session-1" };
      },
    } as any);

    expect(result.status).toBe("accepted");
    expect(startupCommand).toContain("mcp__ade__ext.notion.search");
    expect(startupCommand).not.toContain("mcp__ade__ext.notion.update");
  });

  it("writes worker MCP launch config with canonical project root and lane workspace root", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-project-root-"));
    const laneWorktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-lane-root-"));
    const adapter = createUnifiedOrchestratorAdapter({
      projectRoot,
      workspaceRoot: projectRoot,
      runtimeRoot: path.join(projectRoot, "runtime"),
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: { missionGoal: "Plan the work" },
      } as any,
      step: {
        id: "step-1",
        title: "Planning worker",
        stepKey: "planning-worker",
        laneId: "lane-1",
        metadata: {
          modelId: "anthropic/claude-sonnet-4-6",
          readOnlyExecution: true,
          laneWorktreePath,
        },
        dependencyStepIds: [],
        joinPolicy: "all_success",
      } as any,
      attempt: { id: "attempt-1" } as any,
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "" } as any,
      docsRefs: [],
      fullDocs: [],
      permissionConfig: {
        _providers: {
          claude: "full-auto",
        },
      } as any,
      createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
    } as any);

    expect(result.status).toBe("accepted");
    const configPath = path.join(projectRoot, ".ade", "cache", "orchestrator", "mcp-configs", "worker-attempt-1.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers.ade.args.slice(-4)).toEqual([
      "--project-root",
      projectRoot,
      "--workspace-root",
      laneWorktreePath,
    ]);
    if (config.mcpServers.ade.command === process.execPath) {
      expect(config.mcpServers.ade.args[0]).toMatch(/adeMcpProxy\.cjs$/);
      expect(config.mcpServers.ade.env.ELECTRON_RUN_AS_NODE).toBe("1");
    } else {
      expect(config.mcpServers.ade.args).toEqual([
        "tsx",
        path.join(projectRoot, "runtime", "apps", "mcp-server", "src", "index.ts"),
        "--project-root",
        projectRoot,
        "--workspace-root",
        laneWorktreePath,
      ]);
    }
    expect(config.mcpServers.ade.env).toMatchObject({
      ADE_PROJECT_ROOT: projectRoot,
      ADE_WORKSPACE_ROOT: laneWorktreePath,
      ADE_MISSION_ID: "mission-1",
      ADE_RUN_ID: "run-1",
      ADE_STEP_ID: "step-1",
      ADE_ATTEMPT_ID: "attempt-1",
    });
  });
});
