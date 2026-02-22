import { describe, expect, it, vi } from "vitest";
import { createClaudeOrchestratorAdapter } from "./claudeOrchestratorAdapter";
import type { OrchestratorExecutorStartArgs } from "./orchestratorService";

function buildMockArgs(overrides: Partial<OrchestratorExecutorStartArgs> = {}): OrchestratorExecutorStartArgs {
  return {
    run: {
      id: "run-1",
      missionId: "mission-1",
      projectId: "proj-1",
      status: "running",
      contextProfile: "orchestrator_deterministic_v1",
      schedulerState: "active",
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
      startedAt: "2026-02-20T00:00:00.000Z",
      completedAt: null,
      lastError: null,
      metadata: { missionGoal: "Build a feature" }
    },
    step: {
      id: "step-1",
      runId: "run-1",
      missionStepId: null,
      stepKey: "implement",
      stepIndex: 0,
      title: "Implement feature",
      laneId: "lane-1",
      status: "running",
      joinPolicy: "all_success",
      quorumCount: null,
      dependencyStepIds: [],
      retryLimit: 2,
      retryCount: 0,
      lastAttemptId: null,
      createdAt: "2026-02-20T00:00:00.000Z",
      updatedAt: "2026-02-20T00:00:00.000Z",
      startedAt: "2026-02-20T00:00:00.000Z",
      completedAt: null,
      metadata: {
        instructions: "Build the login page",
        filePatterns: ["src/login/**", "src/auth/**"],
        model: "opus",
        permissionMode: "dontAsk"
      }
    },
    attempt: {
      id: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      attemptNumber: 1,
      status: "running",
      executorKind: "claude",
      executorSessionId: null,
      trackedSessionEnforced: true,
      contextProfile: "orchestrator_deterministic_v1",
      contextSnapshotId: null,
      errorClass: "none",
      errorMessage: null,
      retryBackoffMs: 0,
      createdAt: "2026-02-20T00:00:00.000Z",
      startedAt: "2026-02-20T00:00:00.000Z",
      completedAt: null,
      resultEnvelope: null,
      metadata: null
    },
    contextProfile: {
      id: "orchestrator_deterministic_v1",
      includeNarrative: false,
      docsMode: "digest_refs",
      laneExportLevel: "standard",
      projectExportLevel: "lite",
      maxDocBytes: 120_000
    },
    laneExport: {
      packKey: "lane:lane-1",
      packType: "lane",
      level: "standard",
      header: {} as any,
      content: "Lane context content",
      approxTokens: 20,
      maxTokens: 500,
      truncated: false,
      warnings: [],
      clipReason: null,
      omittedSections: null
    },
    projectExport: {
      packKey: "project",
      packType: "project",
      level: "lite",
      header: {} as any,
      content: "Project context content",
      approxTokens: 20,
      maxTokens: 500,
      truncated: false,
      warnings: [],
      clipReason: null,
      omittedSections: null
    },
    docsRefs: [
      { path: "docs/PRD.md", sha256: "abc12345", bytes: 100, truncated: false, mode: "digest_ref" }
    ],
    fullDocs: [],
    createTrackedSession: vi.fn().mockResolvedValue({ ptyId: "pty-1", sessionId: "session-1" }),
    ...overrides
  };
}

describe("claudeOrchestratorAdapter", () => {
  it("creates adapter with kind 'claude'", () => {
    const adapter = createClaudeOrchestratorAdapter();
    expect(adapter.kind).toBe("claude");
  });

  it("returns accepted with sessionId on successful start", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs();
    const result = await adapter.start(args);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.sessionId).toBe("session-1");
    expect(result.metadata?.adapterKind).toBe("claude");
    expect(result.metadata?.model).toBe("opus");
    expect(result.metadata?.permissionMode).toBe("dontAsk");
  });

  it("constructs startup command with correct model and permission mode", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    expect(createSession).toHaveBeenCalledTimes(1);
    const sessionArgs = createSession.mock.calls[0][0];
    expect(sessionArgs.toolType).toBe("claude-orchestrated");
    expect(sessionArgs.title).toContain("Implement feature");
    expect(sessionArgs.startupCommand).toContain("claude");
    expect(sessionArgs.startupCommand).toContain("opus");
    expect(sessionArgs.startupCommand).toContain("dontAsk");
  });

  it("includes file ownership fence in prompt", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("src/login/**");
    expect(command).toContain("src/auth/**");
    expect(command).toContain("Do not modify files outside this scope");
  });

  it("includes handoff summaries in prompt when present", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: {
          instructions: "Continue from upstream",
          handoffSummaries: ["Step A completed with 3 files modified", "Step B added new tests"]
        }
      }
    });
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("Step A completed");
    expect(command).toContain("Step B added");
  });

  it("injects steering directives into worker prompt", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: {
          instructions: "Follow operator guidance",
          steeringDirectives: [
            {
              directive: "Prioritize failing auth tests before refactors.",
              priority: "instruction",
              targetStepKey: "implement"
            }
          ]
        }
      }
    });
    const result = await adapter.start(args);
    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.steeringDirectiveCount).toBe(1);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("Active operator steering directives");
    expect(command).toContain("Prioritize failing auth tests before refactors");
  });

  it("derives file ownership fence from claim scope metadata when filePatterns are absent", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: {
          instructions: "Scope from claim policy only",
          policy: {
            claimScopes: [
              { scopeKind: "file", scopeValue: "glob:src/auth/**" },
              { scopeKind: "env", scopeValue: "NODE_ENV" }
            ]
          }
        }
      }
    });
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("src/auth/**");
    expect(command).toContain("Do not modify files outside this scope");
  });

  it("uses default model and permission mode when not specified", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      }
    });
    const result = await adapter.start(args);

    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.model).toBe("sonnet");
    expect(result.metadata?.permissionMode).toBe("acceptEdits");
  });

  it("fails when step has no laneId", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: { ...buildMockArgs().step, laneId: null }
    });
    const result = await adapter.start(args);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed");
    expect(result.errorClass).toBe("policy");
    expect(result.errorMessage).toContain("laneId");
  });

  it("returns failed when createTrackedSession throws", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      createTrackedSession: vi.fn().mockRejectedValue(new Error("PTY spawn failed"))
    });
    const result = await adapter.start(args);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed");
    expect(result.errorClass).toBe("executor_failure");
    expect(result.errorMessage).toContain("PTY spawn failed");
  });

  it("includes mission goal in prompt", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("Build a feature");
  });

  it("reads permission mode from config when step metadata does not specify it", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      },
      permissionConfig: {
        claude: { permissionMode: "plan" }
      }
    });
    const result = await adapter.start(args);

    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.permissionMode).toBe("plan");

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("--permission-mode");
    expect(command).toContain("plan");
  });

  it("step metadata wins over config for permission mode", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: {
          instructions: "Do something",
          permissionMode: "bypassPermissions"
        }
      },
      permissionConfig: {
        claude: { permissionMode: "plan" }
      }
    });
    const result = await adapter.start(args);

    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.permissionMode).toBe("bypassPermissions");
  });

  it("adds --dangerously-skip-permissions when config says so", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      },
      permissionConfig: {
        claude: { dangerouslySkipPermissions: true }
      }
    });
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("--permission-mode");
  });

  it("does not add --dangerously-skip-permissions when config is false", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      },
      permissionConfig: {
        claude: { dangerouslySkipPermissions: false, permissionMode: "plan" }
      }
    });
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).toContain("--permission-mode");
    expect(command).toContain("plan");
  });

  it("adds --allowedTools flags when config specifies them", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      },
      permissionConfig: {
        claude: { allowedTools: ["Read", "Write", "Bash"] }
      }
    });
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("--allowedTools");
    expect(command).toContain("Read");
    expect(command).toContain("Write");
    expect(command).toContain("Bash");
  });

  it("falls back to hardcoded defaults when no config or step metadata", async () => {
    const adapter = createClaudeOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      }
    });
    const result = await adapter.start(args);

    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.permissionMode).toBe("acceptEdits");

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("--permission-mode");
    expect(command).toContain("acceptEdits");
    expect(command).not.toContain("--dangerously-skip-permissions");
  });
});
