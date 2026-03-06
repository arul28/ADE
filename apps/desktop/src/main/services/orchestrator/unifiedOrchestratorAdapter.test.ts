import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexMcpConfigFlags, createUnifiedOrchestratorAdapter } from "./unifiedOrchestratorAdapter";

describe("buildCodexMcpConfigFlags", () => {
  it("shell-escapes TOML override values so zsh does not parse brackets or spaces", () => {
    const flags = buildCodexMcpConfigFlags({
      workspaceRoot: "/Users/admin/Projects/ADE",
      runtimeRoot: "/tmp/ade-runtime",
      missionId: "mission-123",
      runId: "run-456",
      stepId: "step-789",
      attemptId: "attempt-000",
    });

    expect(flags).toEqual([
      "-c",
      "'mcp_servers.ade.command=\"npx\"'",
      "-c",
      `'mcp_servers.ade.args=["tsx", "/tmp/ade-runtime/apps/mcp-server/src/index.ts", "--project-root", "/Users/admin/Projects/ADE"]'`,
      "-c",
      `'mcp_servers.ade.env.ADE_PROJECT_ROOT="/Users/admin/Projects/ADE"'`,
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

describe("createUnifiedOrchestratorAdapter", () => {
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
    expect(startupCommand).toContain(".ade/orchestrator/worker-prompts/worker-attempt-1.txt");
    expect(startupCommand).not.toContain("Mission goal: Plan the work");
    expect(fs.readFileSync(path.join(workspaceRoot, ".ade", "orchestrator", "worker-prompts", "worker-attempt-1.txt"), "utf8"))
      .toContain("Mission goal: Plan the work");
    expect(startupCommand).not.toContain("\n");
  });

  it("forces Claude planning steps into plan mode even when worker permissions are full-auto", async () => {
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
    expect(startupCommand).toContain("--permission-mode 'plan'");
    expect(startupCommand).not.toContain("--dangerously-skip-permissions");
    expect(startupCommand).toContain(`-p "$(cat '`);
    expect(startupCommand).toContain(".ade/orchestrator/worker-prompts/worker-attempt-1.txt");
    expect(startupCommand).not.toContain("Mission goal: Plan the work");
    expect(fs.readFileSync(path.join(workspaceRoot, ".ade", "orchestrator", "worker-prompts", "worker-attempt-1.txt"), "utf8"))
      .toContain("Mission goal: Plan the work");
    expect(startupCommand).not.toContain("\n");
  });
});
