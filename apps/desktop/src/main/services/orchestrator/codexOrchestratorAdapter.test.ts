import { describe, expect, it, vi } from "vitest";
import { createCodexOrchestratorAdapter } from "./codexOrchestratorAdapter";
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
      metadata: { missionGoal: "Fix the auth bug" }
    },
    step: {
      id: "step-1",
      runId: "run-1",
      missionStepId: null,
      stepKey: "fix-auth",
      stepIndex: 0,
      title: "Fix authentication",
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
        instructions: "Fix the login token refresh",
        filePatterns: ["src/auth/**"],
        model: "o4-mini",
        approvalMode: "full-auto"
      }
    },
    attempt: {
      id: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      attemptNumber: 1,
      status: "running",
      executorKind: "codex",
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
      content: "Lane context",
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
      content: "Project context",
      approxTokens: 20,
      maxTokens: 500,
      truncated: false,
      warnings: [],
      clipReason: null,
      omittedSections: null
    },
    docsRefs: [],
    fullDocs: [{ path: "docs/PRD.md", content: "# PRD", truncated: false }],
    createTrackedSession: vi.fn().mockResolvedValue({ ptyId: "pty-1", sessionId: "session-codex-1" }),
    ...overrides
  };
}

describe("codexOrchestratorAdapter", () => {
  it("creates adapter with kind 'codex'", () => {
    const adapter = createCodexOrchestratorAdapter();
    expect(adapter.kind).toBe("codex");
  });

  it("returns accepted with sessionId on successful start", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs();
    const result = await adapter.start(args);

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.sessionId).toBe("session-codex-1");
    expect(result.metadata?.adapterKind).toBe("codex");
    expect(result.metadata?.model).toBe("o4-mini");
    expect(result.metadata?.approvalMode).toBe("full-auto");
  });

  it("constructs startup command with codex CLI format", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    expect(createSession).toHaveBeenCalledTimes(1);
    const sessionArgs = createSession.mock.calls[0][0];
    expect(sessionArgs.toolType).toBe("codex-orchestrated");
    expect(sessionArgs.title).toContain("Fix authentication");
    expect(sessionArgs.startupCommand).toContain("codex");
    expect(sessionArgs.startupCommand).toContain("--approval-mode");
    expect(sessionArgs.startupCommand).toContain("o4-mini");
  });

  it("uses default model o4-mini when not specified in metadata", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs({
      step: {
        ...buildMockArgs().step,
        metadata: { instructions: "Do something" }
      }
    });
    const result = await adapter.start(args);

    if (result.status !== "accepted") throw new Error("Expected accepted");
    expect(result.metadata?.model).toBe("o4-mini");
    expect(result.metadata?.approvalMode).toBe("full-auto");
  });

  it("includes full docs in prompt when available", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("PRD");
  });

  it("includes file ownership fence", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs();
    await adapter.start(args);

    const createSession = args.createTrackedSession as ReturnType<typeof vi.fn>;
    const command = createSession.mock.calls[0][0].startupCommand as string;
    expect(command).toContain("src/auth/**");
    expect(command).toContain("Do not modify files outside this scope");
  });

  it("fails when step has no laneId", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs({
      step: { ...buildMockArgs().step, laneId: null }
    });
    const result = await adapter.start(args);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed");
    expect(result.errorClass).toBe("policy");
  });

  it("returns failed when createTrackedSession throws", async () => {
    const adapter = createCodexOrchestratorAdapter();
    const args = buildMockArgs({
      createTrackedSession: vi.fn().mockRejectedValue(new Error("Session creation failed"))
    });
    const result = await adapter.start(args);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed");
    expect(result.errorClass).toBe("executor_failure");
    expect(result.errorMessage).toContain("Session creation failed");
  });
});
