import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRequestHandler, _resetGlobalAskUserRateLimit } from "./mcpServer";

type RuntimeFixture = ReturnType<typeof createRuntime>;

function createRuntime() {
  const operationStart = vi.fn((args: any) => ({ operationId: `op-${args.kind}-${Date.now()}` }));
  const operationFinish = vi.fn();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mcp-test-"));
  fs.mkdirSync(path.join(projectRoot, ".ade", "orchestrator"), { recursive: true });
  const teamMembers: Array<Record<string, unknown>> = [];
  const threadRows: Array<Record<string, unknown>> = [];
  const threadMessages = new Map<string, Array<Record<string, unknown>>>();
  let messageCounter = 0;

  const ensureThread = (input: { missionId: string; attemptId: string; runId?: string | null }): Record<string, unknown> => {
    const existing = threadRows.find(
      (thread) => thread.missionId === input.missionId && thread.attemptId === input.attemptId
    );
    if (existing) return existing;
    const thread = {
      id: `thread-${input.attemptId}`,
      missionId: input.missionId,
      threadType: "worker",
      runId: input.runId ?? "run-1",
      attemptId: input.attemptId
    };
    threadRows.push(thread);
    threadMessages.set(thread.id, []);
    return thread;
  };

  const appendThreadMessage = (threadId: string, entry: Record<string, unknown>): void => {
    const existing = threadMessages.get(threadId) ?? [];
    existing.push(entry);
    threadMessages.set(threadId, existing);
  };

  const laneRows = [
    {
      id: "lane-1",
      name: "Lane 1",
      laneType: "worktree",
      parentLaneId: null,
      baseRef: "main",
      branchRef: "feature/lane-1",
      worktreePath: path.join(projectRoot, ".ade", "worktrees", "lane-1"),
      archivedAt: null,
      stackDepth: 0,
      status: { dirty: false, ahead: 1, behind: 0 },
      tags: ["auth", "payments"]
    },
    {
      id: "lane-2",
      name: "Lane 2",
      laneType: "worktree",
      parentLaneId: "lane-1",
      baseRef: "feature/lane-1",
      branchRef: "feature/lane-2",
      worktreePath: path.join(projectRoot, ".ade", "worktrees", "lane-2"),
      archivedAt: null,
      stackDepth: 1,
      status: { dirty: true, ahead: 0, behind: 2 },
      tags: ["auth"]
    }
  ];

  const runtime = {
    projectRoot,
    projectId: "project-1",
    project: { rootPath: projectRoot, displayName: "project", baseRef: "main" },
    paths: {
      adeDir: path.join(projectRoot, ".ade"),
      logsDir: path.join(projectRoot, ".ade", "logs"),
      processLogsDir: path.join(projectRoot, ".ade", "logs", "processes"),
      testLogsDir: path.join(projectRoot, ".ade", "logs", "tests"),
      transcriptsDir: path.join(projectRoot, ".ade", "transcripts"),
      worktreesDir: path.join(projectRoot, ".ade", "worktrees"),
      packsDir: path.join(projectRoot, ".ade", "packs"),
      dbPath: path.join(projectRoot, ".ade", "ade.db")
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: {
      get: vi.fn((sql: string) => {
        if (sql.includes("orchestrator_evaluations") && sql.includes("SELECT")) {
          return {
            id: "eval-1", run_id: "run-1", mission_id: "mission-1", evaluator_id: "evaluator-1",
            scores_json: '{"planQuality":8}', issues_json: '[]', summary: "Good run",
            improvements_json: '[]', metadata_json: '{}', evaluated_at: new Date().toISOString()
          };
        }
        return { count: 0 };
      }),
      all: vi.fn((sql: string) => {
        if (sql.includes("from missions")) return [{ id: "mission-1" }];
        if (sql.includes("orchestrator_evaluations")) return [{
          id: "eval-1", run_id: "run-1", mission_id: "mission-1", evaluator_id: "evaluator-1",
          scores_json: '{"planQuality":8}', issues_json: '[]', summary: "Good run",
          improvements_json: null, metadata_json: null, evaluated_at: new Date().toISOString()
        }];
        return [];
      }),
      run: vi.fn((sql: string, params?: unknown[]) => {
        if (
          sql.toLowerCase().includes("insert into orchestrator_team_members")
          && Array.isArray(params)
          && params.length >= 12
        ) {
          const metadataRaw = params[9];
          const metadata = typeof metadataRaw === "string" && metadataRaw.length > 0
            ? JSON.parse(metadataRaw)
            : {};
          teamMembers.push({
            id: params[0],
            runId: params[1],
            missionId: params[2],
            provider: params[3],
            model: params[4],
            role: params[5],
            sessionId: params[6],
            status: params[7],
            source: typeof metadata.source === "string" ? metadata.source : "claude-native",
            parentWorkerId: typeof metadata.parentWorkerId === "string" ? metadata.parentWorkerId : null,
            metadata
          });
        }
      })
    },
    laneService: {
      list: vi.fn(async () => laneRows),
      getLaneBaseAndBranch: vi.fn((laneId: string) => {
        const lane = laneRows.find((row) => row.id === laneId) ?? laneRows[0]!;
        return {
          baseRef: lane.baseRef,
          branchRef: lane.branchRef,
          worktreePath: lane.worktreePath,
          laneType: lane.laneType
        };
      }),
      create: vi.fn(async ({ name }: { name: string }) => ({
        ...laneRows[0],
        id: "lane-new",
        name,
        branchRef: "feature/lane-new",
        worktreePath: "/tmp/project/.ade/worktrees/lane-new"
      })),
      delete: vi.fn(async () => {})
    },
    sessionService: {
      get: vi.fn(),
      readTranscriptTail: vi.fn(() => "")
    },
    operationService: {
      start: operationStart,
      finish: operationFinish
    },
    projectConfigService: {} as any,
    packService: {
      getProjectExport: vi.fn(async () => ({ header: { scope: "project" }, content: "project", warnings: [] })),
      getLaneExport: vi.fn(async ({ laneId }: { laneId: string }) => ({ header: { scope: "lane", laneId }, content: "lane", warnings: [] })),
      getFeatureExport: vi.fn(async ({ featureKey }: { featureKey: string }) => ({ header: { scope: "feature", featureKey }, content: "feature", warnings: [] })),
      getConflictExport: vi.fn(async ({ laneId, peerLaneId }: { laneId: string; peerLaneId?: string }) => ({ header: { scope: "conflict", laneId, peerLaneId: peerLaneId ?? null }, content: "conflict", warnings: [] })),
      getPlanExport: vi.fn(async ({ laneId }: { laneId: string }) => ({ header: { scope: "plan", laneId }, content: "plan", warnings: [] })),
      getMissionExport: vi.fn(async ({ missionId }: { missionId: string }) => ({ header: { scope: "mission", missionId }, content: "mission", warnings: [] }))
    },
    conflictService: {
      runPrediction: vi.fn(async () => ({ lanes: [], matrix: [], overlaps: [] })),
      getLaneStatus: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "merge-ready" })),
      listOverlaps: vi.fn(async () => []),
      rebaseLane: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "clean", conflictedFiles: [] }))
    },
    gitService: {
      getConflictState: vi.fn(async () => ({ laneId: "lane-1", kind: null, inProgress: false, conflictedFiles: [], canContinue: false, canAbort: false })),
      stageAll: vi.fn(async () => ({ success: true })),
      commit: vi.fn(async () => ({ success: true })),
      listRecentCommits: vi.fn(async () => [{ sha: "abc123", subject: "test" }])
    },
    diffService: {
      getChanges: vi.fn(async () => ({ unstaged: [], staged: [] }))
    },
    missionService: {
      addIntervention: vi.fn(({ missionId, title, body }: { missionId: string; title: string; body: string }) => ({
        id: "intervention-1",
        missionId,
        status: "open",
        title,
        body
      })),
      get: vi.fn((missionId: string) => ({
        id: missionId,
        prompt: "test mission",
        status: "running",
        interventions: []
      })),
      create: vi.fn(({ prompt }: any) => ({ id: "mission-new", prompt, status: "planned" })),
      resolveIntervention: vi.fn(({ missionId, interventionId, status }: any) => ({
        id: interventionId, missionId, status
      }))
    },
    ptyService: {
      create: vi.fn(async () => ({ ptyId: "pty-1", sessionId: "session-1" })),
      dispose: vi.fn()
    },
    testService: {
      run: vi.fn(async () => ({ id: "test-run-1", status: "running" })),
      listRuns: vi.fn(() => [{ id: "test-run-1", status: "running" }]),
      stop: vi.fn(),
      getLogTail: vi.fn(() => "")
    },
    prService: {
      simulateIntegration: vi.fn(async () => ({ steps: [], conflicts: [], clean: true })),
      createQueuePrs: vi.fn(async () => ({ groupId: "group-1", prs: [] })),
      createIntegrationPr: vi.fn(async () => ({ prId: "pr-int-1", url: "https://github.com/pr/1" })),
      getPrHealth: vi.fn(async (prId: string) => ({ prId, healthy: true, checks: "pass", reviews: "approved" })),
      landQueueNext: vi.fn(async () => ({ landed: true, prId: "pr-1", sha: "def456" }))
    },
    memoryService: {
      addMemory: vi.fn(() => ({
        id: "memory-1",
        category: "fact",
        content: "x",
        importance: "medium",
        createdAt: new Date().toISOString()
      })),
      addSharedFact: vi.fn(() => ({
        id: "shared-fact-1"
      })),
      searchMemories: vi.fn(() => [])
    } as any,
    orchestratorService: {
      listRuns: vi.fn(() => []),
      pauseRun: vi.fn(({ runId }: any) => ({ id: runId, status: "paused" })),
      resumeRun: vi.fn(({ runId }: any) => ({ id: runId, status: "running" })),
      getRunGraph: vi.fn(({ runId }: any) => ({
        run: { id: runId, missionId: "mission-1", status: "running" },
        steps: [{ id: "step-1", stepKey: "step-a", laneId: "lane-1", status: "completed" }],
        attempts: [{ id: "attempt-1", stepId: "step-1", status: "completed" }],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [{ id: "tl-1", runId, eventType: "step_started", reason: "started" }],
        runtimeEvents: [],
        completionEvaluation: { complete: true }
      })),
      listTimeline: vi.fn(({ runId }: any) => [
        { id: "tl-1", runId, stepId: null, eventType: "run_started", reason: "started" },
        { id: "tl-2", runId, stepId: "step-1", eventType: "step_started", reason: "started" }
      ]),
      listAttempts: vi.fn(() => []),
      addSteps: vi.fn(({ steps }: { steps: Array<Record<string, unknown>> }) =>
        steps.map((step, index) => ({
          id: `step-created-${index + 1}`,
          runId: "run-1",
          missionStepId: null,
          stepKey: String(step.stepKey ?? `step-created-${index + 1}`),
          stepIndex: Number(step.stepIndex ?? index),
          title: String(step.title ?? "Created step"),
          laneId: typeof step.laneId === "string" ? step.laneId : null,
          status: "pending",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          metadata: step.metadata ?? {}
        }))
      ),
      createHandoff: vi.fn(),
      startReadyAutopilotAttempts: vi.fn(async () => 0),
      skipStep: vi.fn(),
      completeAttempt: vi.fn(),
      updateStepMetadata: vi.fn(),
      supersedeStep: vi.fn(),
      updateStepDependencies: vi.fn(),
      appendRuntimeEvent: vi.fn(),
      appendTimelineEvent: vi.fn()
    } as any,
    aiOrchestratorService: {
      startMissionRun: vi.fn(async ({ missionId }: any) => ({
        blockedByPlanReview: false,
        started: { run: { id: "run-1", missionId, status: "running" }, steps: [] },
        mission: { id: missionId }
      })),
      cancelRunGracefully: vi.fn(async ({ runId }: any) => ({ cancelled: true, runId })),
      steerMission: vi.fn(({ missionId }: any) => ({ acknowledged: true, appliedAt: new Date().toISOString() })),
      approveMissionPlan: vi.fn(async ({ missionId }: any) => ({
        blockedByPlanReview: false,
        started: { run: { id: "run-1", missionId, status: "running" }, steps: [] },
        mission: { id: missionId }
      })),
      getWorkerStates: vi.fn(({ runId }: any) => [
        { attemptId: "a-1", stepId: "s-1", runId, state: "running" }
      ]),
      getMissionMetrics: vi.fn(({ missionId }: any) => ({ missionId, samples: [] })),
      getTeamMembers: vi.fn(() => teamMembers),
      listChatThreads: vi.fn(({ missionId }: any) =>
        threadRows.filter((thread) => thread.missionId === missionId)
      ),
      getThreadMessages: vi.fn(({ threadId, limit }: any) => {
        const entries = threadMessages.get(String(threadId)) ?? [];
        const max = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : entries.length;
        return entries.slice(-max);
      }),
      sendAgentMessage: vi.fn(({ missionId, fromAttemptId, toAttemptId, content, metadata }: any) => {
        const sourceThread = ensureThread({ missionId, attemptId: String(fromAttemptId), runId: "run-1" });
        const targetThread = ensureThread({ missionId, attemptId: String(toAttemptId), runId: "run-1" });
        const timestamp = new Date().toISOString();
        const sourceEntry = {
          id: `msg-${++messageCounter}`,
          role: "agent",
          content,
          timestamp,
          threadId: sourceThread.id,
          attemptId: fromAttemptId,
          target: { targetAttemptId: toAttemptId },
          metadata: metadata ?? null
        };
        const deliveryEntry = {
          id: `msg-${++messageCounter}`,
          role: "agent",
          content,
          timestamp,
          threadId: targetThread.id,
          attemptId: fromAttemptId,
          target: { targetAttemptId: toAttemptId },
          metadata: { ...(metadata ?? {}), interAgentDelivery: true }
        };
        appendThreadMessage(String(sourceThread.id), sourceEntry);
        appendThreadMessage(String(targetThread.id), deliveryEntry);
        return sourceEntry;
      }),
      dispose: vi.fn()
    } as any,
    eventBuffer: {
      push: vi.fn(),
      drain: vi.fn((cursor: number, limit?: number) => ({
        events: [
          { id: cursor + 1, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "test" } }
        ],
        nextCursor: cursor + 1,
        hasMore: false
      })),
      size: vi.fn(() => 1)
    } as any,
    dispose: vi.fn()
  } as any;

  return {
    runtime,
    operationStart,
    operationFinish
  };
}

async function initialize(handler: ReturnType<typeof createMcpRequestHandler>, identity?: Record<string, unknown>) {
  await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: identity ? { identity } : {}
  });
}

async function callTool(
  handler: ReturnType<typeof createMcpRequestHandler>,
  name: string,
  argumentsPayload: Record<string, unknown>
): Promise<any> {
  return await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name,
      arguments: argumentsPayload
    }
  });
}

describe("mcpServer", () => {
  it("lists the full tool surface including coordinator orchestration tools", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler);
    const result = (await handler({ jsonrpc: "2.0", id: 3, method: "tools/list" })) as any;

    const names = (result.tools ?? []).map((tool: any) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "read_context",
        "create_lane",
        "check_conflicts",
        "merge_lane",
        "ask_user",
        "memory_add",
        "memory_search",
        "run_tests",
        "get_lane_status",
        "list_lanes",
        "commit_changes",
        "create_mission",
        "start_mission",
        "pause_mission",
        "resume_mission",
        "cancel_mission",
        "steer_mission",
        "approve_plan",
        "resolve_intervention",
        "get_mission",
        "get_run_graph",
        "stream_events",
        "get_step_output",
        "get_worker_states",
        "get_timeline",
        "get_mission_metrics",
        "get_final_diff",
        "evaluate_run",
        "list_evaluations",
        "get_evaluation_report",
        "spawn_worker",
        "delegate_parallel",
        "read_mission_status",
        "revise_plan",
        "retry_step",
        "skip_step",
        "message_worker",
        "report_status",
        "report_result",
        "report_validation",
        "update_tool_profiles",
        "transfer_lane",
        "request_specialist",
        "read_file",
        "search_files",
        "get_project_context"
      ])
    );
    expect(names.length).toBeGreaterThan(38);
  });

  it("supports read_context contracts for all pack scopes", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler);

    const scopes: Array<{ scope: string; args: Record<string, unknown> }> = [
      { scope: "project", args: {} },
      { scope: "lane", args: { laneId: "lane-1" } },
      { scope: "feature", args: { featureKey: "auth" } },
      { scope: "conflict", args: { laneId: "lane-1", peerLaneId: "lane-2" } },
      { scope: "plan", args: { laneId: "lane-1" } },
      { scope: "mission", args: { missionId: "mission-1" } }
    ];

    for (const item of scopes) {
      const response = await callTool(handler, "read_context", { scope: item.scope, level: "standard", ...item.args });
      expect(response?.isError).toBeUndefined();
      expect(response?.structuredContent?.export).toBeTruthy();
    }
  });

  it("routes spawn_agent to lane-scoped tracked pty sessions", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      prompt: "Implement API wiring",
      title: "Orchestrator Spawn"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        cols: 120,
        rows: 36,
        tracked: true,
        toolType: "claude-orchestrated"
      })
    );
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("--model");
    expect(response.structuredContent.startupCommand).toContain("--permission-mode");
    expect(response.structuredContent.permissionMode).toBe("edit");
    expect(response.structuredContent.contextRef?.path).toBeNull();
  });

  it("routes coordinator report_status via MCP and mutates run metadata through coordinator tools", async () => {
    const fixture = createRuntime();
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-worker-1",
          runId: "run-1",
          missionStepId: null,
          stepKey: "worker-1",
          stepIndex: 0,
          title: "Worker 1",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "coord-1", role: "orchestrator", missionId: "mission-1", runId: "run-1" });
    const response = await callTool(handler, "report_status", {
      workerId: "worker-1",
      progressPct: 45,
      blockers: [],
      confidence: 0.82,
      nextAction: "continue implementation",
      laneId: "lane-1",
      details: "working through API edge cases"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.ok).toBe(true);
    expect(fixture.runtime.orchestratorService.updateStepMetadata).toHaveBeenCalled();
    expect(fixture.runtime.orchestratorService.appendRuntimeEvent).toHaveBeenCalled();
  });

  it("forwards sub-agent report_status updates to parent and emits worker_status_reported runtime events", async () => {
    const fixture = createRuntime();
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        },
        {
          id: "step-child",
          runId: "run-1",
          missionStepId: null,
          stepKey: "child-worker",
          stepIndex: 1,
          title: "Child Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-child",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {
            isSubAgent: true,
            parentWorkerId: "parent-worker"
          }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() },
        { id: "attempt-child", stepId: "step-child", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "attempt-child",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-child",
      attemptId: "attempt-child"
    });
    const response = await callTool(handler, "report_status", {
      workerId: "child-worker",
      progressPct: 45,
      blockers: [],
      confidence: 0.8,
      nextAction: "Continue implementation",
      laneId: "lane-1"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.ok).toBe(true);
    expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "runtime",
        payload: expect.objectContaining({
          type: "worker_status_reported",
          runId: "run-1",
          reason: "report_status"
        })
      })
    );
    expect(fixture.runtime.aiOrchestratorService.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        fromAttemptId: "attempt-child",
        toAttemptId: "attempt-parent",
        content: expect.stringContaining("[sub-agent:Child Worker]"),
        metadata: expect.objectContaining({
          source: "subagent_status_rollup",
          parentWorkerId: "parent-worker"
        })
      })
    );
  });

  it("auto-registers unknown native callers as claude-native teammates under the parent worker", async () => {
    const fixture = createRuntime();
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: {
        id: "run-1",
        missionId: "mission-1",
        status: "running",
        metadata: { autopilot: { parallelismCap: 6 } }
      },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: { modelId: "anthropic/claude-sonnet-4-6" }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "native-worker-1",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-parent",
      attemptId: "attempt-parent"
    });
    const response = await callTool(handler, "report_status", {
      workerId: "parent-worker",
      progressPct: 10,
      blockers: [],
      confidence: 0.7,
      nextAction: "Running native sub-task"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.ok).toBe(true);
    const insertCall = fixture.runtime.db.run.mock.calls.find((call: any[]) =>
      String(call[0] ?? "").toLowerCase().includes("insert into orchestrator_team_members")
    );
    expect(insertCall).toBeTruthy();
    const metadataJson = String(insertCall?.[1]?.[9] ?? "{}");
    const metadata = JSON.parse(metadataJson);
    expect(metadata).toMatchObject({
      source: "claude-native",
      parentWorkerId: "parent-worker",
      parentStepId: "step-parent",
      nativeCallerId: "native-worker-1"
    });
  });

  it("blocks unknown native reports when parent allocation cap is exceeded", async () => {
    const fixture = createRuntime();
    fixture.runtime.aiOrchestratorService.getTeamMembers = vi.fn(() => [
      { id: "native-1", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-2", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-3", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-4", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } }
    ]);
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "native-worker-over-cap",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-parent",
      attemptId: "attempt-parent"
    });
    const response = await callTool(handler, "report_status", {
      workerId: "parent-worker",
      progressPct: 30,
      blockers: [],
      confidence: 0.6,
      nextAction: "Still running"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("allocation cap exceeded");
    const insertCalls = fixture.runtime.db.run.mock.calls.filter((call: any[]) =>
      String(call[0] ?? "").toLowerCase().includes("insert into orchestrator_team_members")
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("surfaces forwarded status rollups through get_pending_messages for parent workers", async () => {
    const fixture = createRuntime();
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        },
        {
          id: "step-child",
          runId: "run-1",
          missionStepId: null,
          stepKey: "child-worker",
          stepIndex: 1,
          title: "Child Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-child",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {
            isSubAgent: true,
            parentWorkerId: "parent-worker"
          }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() },
        { id: "attempt-child", stepId: "step-child", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));

    const childHandler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(childHandler, {
      callerId: "attempt-child",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-child",
      attemptId: "attempt-child"
    });
    const statusResponse = await callTool(childHandler, "report_status", {
      workerId: "child-worker",
      progressPct: 60,
      blockers: [],
      confidence: 0.84,
      nextAction: "Finalize patch set"
    });
    expect(statusResponse?.isError).toBeUndefined();

    const parentHandler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(parentHandler, {
      callerId: "attempt-parent",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-parent",
      attemptId: "attempt-parent"
    });
    const pending = await callTool(parentHandler, "get_pending_messages", {});

    expect(pending?.isError).toBeUndefined();
    expect(pending.structuredContent.workerAttemptId).toBe("attempt-parent");
    expect(pending.structuredContent.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "agent",
          content: expect.stringContaining("[sub-agent:Child Worker]"),
          metadata: expect.objectContaining({
            source: "subagent_status_rollup"
          })
        })
      ])
    );
  });

  it("surfaces native terminal rollups through get_pending_messages after report_result", async () => {
    const fixture = createRuntime();
    fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));

    const nativeHandler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(nativeHandler, {
      callerId: "native-worker-result",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-parent",
      attemptId: "attempt-parent"
    });
    const resultResponse = await callTool(nativeHandler, "report_result", {
      workerId: "parent-worker",
      outcome: "succeeded",
      summary: "Native child done.",
      artifacts: [],
      filesChanged: [],
      testsRun: null
    });
    expect(resultResponse?.isError).toBeUndefined();

    const parentHandler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(parentHandler, {
      callerId: "attempt-parent",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-parent",
      attemptId: "attempt-parent"
    });
    const pending = await callTool(parentHandler, "get_pending_messages", {});

    expect(pending?.isError).toBeUndefined();
    expect(pending.structuredContent.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "agent",
          content: expect.stringContaining("completed (succeeded): Native child done."),
          metadata: expect.objectContaining({
            source: "subagent_result_rollup"
          })
        })
      ])
    );
  });

  it("uses initialize identity context for shared-fact writes (proxy-mode identity forwarding path)", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "worker-1",
      role: "agent",
      missionId: "mission-1",
      runId: "run-from-identity",
      stepId: "step-from-identity",
      attemptId: "attempt-from-identity"
    });
    const response = await callTool(handler, "memory_add", {
      content: "Cache layer requires warm-up before benchmark runs.",
      category: "fact",
      importance: "high"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.memoryService.addSharedFact).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-from-identity",
        stepId: "step-from-identity",
      })
    );
    expect(response.structuredContent.sharedFact.written).toBe(true);
  });

  it("materializes compact context manifests for spawn_agent to keep prompts lightweight", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "codex",
      permissionMode: "plan",
      runId: "run-123",
      stepId: "step-abc",
      attemptId: "attempt-xyz",
      prompt: "Investigate failing CI and propose a fix plan before editing.",
      context: {
        profile: "orchestrator_deterministic_v1",
        packs: [
          { scope: "project", packKey: "project", level: "lite", approxTokens: 850, summary: "Project pack summary" },
          { scope: "lane", packKey: "lane:lane-1", level: "standard", approxTokens: 1200, summary: "Lane summary" }
        ],
        docs: [{ path: "docs/PRD.md", sha256: "abc", bytes: 1024 }],
        handoffDigest: { summarizedCount: 4, byType: { attempt_succeeded: 3, attempt_failed: 1 } }
      }
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.permissionMode).toBe("plan");
    expect(response.structuredContent.startupCommand).toContain("--sandbox");
    expect(response.structuredContent.startupCommand).toContain("read-only");
    const contextPath = response.structuredContent.contextRef?.path as string | null;
    expect(contextPath).toBeTruthy();
    expect(contextPath?.includes("/.ade/orchestrator/mcp-context/run-123/")).toBe(true);
    if (!contextPath) {
      throw new Error("Expected context manifest path");
    }
    expect(fs.existsSync(contextPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    expect(manifest.schema).toBe("ade.mcp.spawnAgentContext.v1");
    expect(manifest.mission.runId).toBe("run-123");
    expect(Array.isArray(manifest.context.packs)).toBe(true);
    expect(response.structuredContent.contextRef?.approxTokens).toBeGreaterThan(0);
  });

  it("routes run_tests for suite and ad-hoc command contracts", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });

    const suiteResult = await callTool(handler, "run_tests", {
      laneId: "lane-1",
      suiteId: "unit",
      waitForCompletion: false
    });
    expect(suiteResult?.isError).toBeUndefined();
    expect(suiteResult?.structuredContent?.run?.id).toBe("test-run-1");

    const commandResult = await callTool(handler, "run_tests", {
      laneId: "lane-1",
      command: "npm test",
      waitForCompletion: false
    });
    expect(commandResult?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        cols: 120,
        rows: 36,
        startupCommand: "npm test"
      })
    );
    expect(commandResult.structuredContent.mode).toBe("command");
  });

  it("routes ask_user to mission interventions", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "ask_user", {
      missionId: "mission-1",
      title: "Need decision",
      body: "Choose the merge order"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.missionService.addIntervention).toHaveBeenCalledTimes(1);
    expect(response.structuredContent.awaitingUserResponse).toBe(true);
  });

  it("allows mutations for any session", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "commit_changes", {
      laneId: "lane-1",
      message: "commit message"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.stageAll).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.gitService.commit).toHaveBeenCalledTimes(1);
    expect(response.structuredContent.commit.sha).toBe("abc123");
  });

  it("returns resources for packs, lane status/conflicts, and mission/feature contexts", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const result = (await handler({ jsonrpc: "2.0", id: 4, method: "resources/list", params: {} })) as any;
    const uris = (result.resources ?? []).map((entry: any) => entry.uri);

    expect(uris).toContain("ade://pack/project/standard");
    expect(uris).toContain("ade://pack/lane/lane-1/standard");
    expect(uris).toContain("ade://pack/plan/lane-1/standard");
    expect(uris).toContain("ade://pack/feature/auth/standard");
    expect(uris).toContain("ade://pack/mission/mission-1/standard");
    expect(uris).toContain("ade://lane/lane-1/status");
    expect(uris).toContain("ade://lane/lane-1/conflicts");
  });

  it("reads lane/status resource with the correct URI parser semantics", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const result = (await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "ade://lane/lane-1/status" }
    })) as any;

    const payload = JSON.parse(result.contents[0].text);
    expect(payload.lane.id).toBe("lane-1");
    expect(payload.rebaseStatus).toBe("idle");
  });

  it("reads feature/plan/mission pack resources", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);

    const feature = (await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "ade://pack/feature/auth/standard" }
    })) as any;
    expect(feature.contents[0].text).toContain("feature");

    const plan = (await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "ade://pack/plan/lane-1/standard" }
    })) as any;
    expect(plan.contents[0].text).toContain("plan");

    const mission = (await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "resources/read",
      params: { uri: "ade://pack/mission/mission-1/standard" }
    })) as any;
    expect(mission.contents[0].text).toContain("mission");
  });

  it("records succeeded audit metadata for read-only tools", async () => {
    const { runtime, operationStart, operationFinish } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "list_lanes", {});

    expect(response.isError).toBeUndefined();
    expect(operationStart).toHaveBeenCalledTimes(1);
    expect(operationFinish).toHaveBeenCalledTimes(1);
    const finishArgs = operationFinish.mock.calls[0]?.[0] ?? {};
    expect(finishArgs.status).toBe("succeeded");
    expect(finishArgs.metadataPatch?.resultStatus).toBe("success");
  });

  // ---------- Rate limit tests ----------

  afterEach(() => {
    _resetGlobalAskUserRateLimit();
  });

  it("enforces global ask_user rate limit across sessions", async () => {
    _resetGlobalAskUserRateLimit();

    // Create two independent sessions (simulating session recycling)
    const fixture1 = createRuntime();
    const handler1 = createMcpRequestHandler({ runtime: fixture1.runtime, serverVersion: "test" });
    await initialize(handler1);

    const fixture2 = createRuntime();
    const handler2 = createMcpRequestHandler({ runtime: fixture2.runtime, serverVersion: "test" });
    await initialize(handler2);

    // Fire 6 calls from session 1 (per-session limit)
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler1, "ask_user", {
        missionId: "mission-1",
        title: `Question ${i}`,
        body: `Body ${i}`
      });
      expect(r?.isError).toBeUndefined();
    }

    // Session 1 should be rate-limited (per-session: 6/min)
    const overLimit = await callTool(handler1, "ask_user", {
      missionId: "mission-1",
      title: "Over limit",
      body: "Should fail"
    });
    expect(overLimit.isError).toBe(true);
    expect(JSON.stringify(overLimit.structuredContent ?? {})).toContain("rate limit");

    // Session 2 can still fire up to its per-session limit (6)
    // but global limit is 20, so with 6 from session 1, session 2 can do 6 more
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler2, "ask_user", {
        missionId: "mission-1",
        title: `S2 Question ${i}`,
        body: `S2 Body ${i}`
      });
      expect(r?.isError).toBeUndefined();
    }
  });

  // ---------- Issue 3: Coverage for previously untested tools ----------

  it("routes get_lane_status and returns lane/diff/conflict info", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_lane_status", { laneId: "lane-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.lane.id).toBe("lane-1");
    expect(response.structuredContent.diff).toBeDefined();
    expect(response.structuredContent.rebaseStatus).toBe("idle");
    expect(fixture.runtime.diffService.getChanges).toHaveBeenCalledWith("lane-1");
    expect(fixture.runtime.conflictService.getLaneStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
  });

  it("routes check_conflicts with a single laneId", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "check_conflicts", { laneId: "lane-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.assessment).toBeDefined();
    expect(fixture.runtime.conflictService.runPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1" })
    );
  });

  it("routes create_lane with authorization and returns lane summary", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_lane", { name: "new-feature" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.lane.id).toBe("lane-new");
    expect(response.structuredContent.lane.name).toBe("new-feature");
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-feature" })
    );
  });

  it("routes simulate_integration as a read-only dry-merge", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "simulate_integration", {
      sourceLaneIds: ["lane-1", "lane-2"],
      baseBranch: "main"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.simulateIntegration).toHaveBeenCalledWith({
      sourceLaneIds: ["lane-1", "lane-2"],
      baseBranch: "main"
    });
  });

  it("routes create_queue with authorization", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_queue", {
      laneIds: ["lane-1", "lane-2"],
      targetBranch: "main"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createQueuePrs).toHaveBeenCalledWith(
      expect.objectContaining({
        laneIds: ["lane-1", "lane-2"],
        targetBranch: "main"
      })
    );
  });

  it("routes create_integration with authorization", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_integration", {
      sourceLaneIds: ["lane-1"],
      integrationLaneName: "integration-branch",
      baseBranch: "main",
      title: "Integration PR"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createIntegrationPr).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLaneIds: ["lane-1"],
        integrationLaneName: "integration-branch",
        baseBranch: "main",
        title: "Integration PR"
      })
    );
  });

  it("routes rebase_lane with authorization", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "rebase_lane", {
      laneId: "lane-1",
      aiAssisted: true
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.conflictService.rebaseLane).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", aiAssisted: true })
    );
  });

  it("routes get_pr_health as a read-only tool", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_pr_health", { prId: "pr-123" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.prId).toBe("pr-123");
    expect(fixture.runtime.prService.getPrHealth).toHaveBeenCalledWith("pr-123");
  });

  it("routes land_queue_next with authorization", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "land_queue_next", {
      groupId: "group-1",
      method: "squash"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.landQueueNext).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "group-1", method: "squash" })
    );
  });

  it("get_lane_status returns error for unknown lane", async () => {
    const fixture = createRuntime();
    fixture.runtime.laneService.list = vi.fn(async () => []);
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_lane_status", { laneId: "nonexistent" });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Lane not found");
  });

  it("run_tests requires either suiteId or command", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "run_tests", { laneId: "lane-1" });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("suiteId or command");
  });

  // ---------- Mission Lifecycle Tools ----------

  it("routes create_mission with orchestration authorization", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "create_mission", {
      prompt: "Build the authentication module",
      title: "Auth Module",
      priority: "high"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.mission.id).toBe("mission-new");
    expect(response.structuredContent.mission.prompt).toBe("Build the authentication module");
    expect(response.structuredContent.mission.status).toBe("planned");
    expect(fixture.runtime.missionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Build the authentication module", title: "Auth Module", priority: "high" })
    );
    expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "mission",
        payload: expect.objectContaining({ type: "mission_created", missionId: "mission-new" })
      })
    );
  });

  it("routes start_mission and returns run info", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "start_mission", {
      missionId: "mission-1",
      runMode: "autopilot"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.started.run.status).toBe("running");
    expect(fixture.runtime.aiOrchestratorService.startMissionRun).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-1", runMode: "autopilot" })
    );
    expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "mission",
        payload: expect.objectContaining({ type: "mission_started", missionId: "mission-1", runId: "run-1" })
      })
    );
  });

  it("routes pause_mission to orchestratorService.pauseRun", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "pause_mission", {
      runId: "run-1",
      reason: "User requested pause"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.run.id).toBe("run-1");
    expect(response.structuredContent.run.status).toBe("paused");
    expect(fixture.runtime.orchestratorService.pauseRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reason: "User requested pause" })
    );
  });

  it("routes resume_mission to orchestratorService.resumeRun", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "resume_mission", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.run.id).toBe("run-1");
    expect(response.structuredContent.run.status).toBe("running");
    expect(fixture.runtime.orchestratorService.resumeRun).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("routes cancel_mission to aiOrchestratorService.cancelRunGracefully", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "cancel_mission", {
      runId: "run-1",
      reason: "No longer needed"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.cancelled).toBe(true);
    expect(response.structuredContent.runId).toBe("run-1");
    expect(fixture.runtime.aiOrchestratorService.cancelRunGracefully).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reason: "No longer needed" })
    );
  });

  it("routes steer_mission with directive", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "steer_mission", {
      missionId: "mission-1",
      directive: "Focus on API layer first",
      targetStepKey: "step-a",
      priority: "instruction"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.acknowledged).toBe(true);
    expect(fixture.runtime.aiOrchestratorService.steerMission).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        directive: "Focus on API layer first",
        priority: "instruction",
        targetStepKey: "step-a"
      })
    );
  });

  it("routes approve_plan for approved plans", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "approve_plan", {
      missionId: "mission-1",
      approved: true
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.approved).toBe(true);
    expect(fixture.runtime.aiOrchestratorService.approveMissionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-1" })
    );
  });

  it("routes approve_plan rejection with feedback", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "approve_plan", {
      missionId: "mission-1",
      approved: false,
      feedback: "Plan needs more detail"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.approved).toBe(false);
    expect(response.structuredContent.intervention).toBeDefined();
    expect(fixture.runtime.missionService.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        title: "Plan rejected",
        body: "Plan needs more detail"
      })
    );
  });

  it("routes resolve_intervention with status", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "resolve_intervention", {
      missionId: "mission-1",
      interventionId: "intervention-1",
      status: "resolved",
      note: "Issue addressed"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.intervention.id).toBe("intervention-1");
    expect(response.structuredContent.intervention.status).toBe("resolved");
    expect(fixture.runtime.missionService.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        interventionId: "intervention-1",
        status: "resolved",
        note: "Issue addressed"
      })
    );
  });

  // ---------- Observation Tools ----------

  it("routes get_mission to missionService.get", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_mission", { missionId: "mission-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.mission.id).toBe("mission-1");
    expect(fixture.runtime.missionService.get).toHaveBeenCalledWith("mission-1");
  });

  it("routes get_run_graph to orchestratorService.getRunGraph", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_run_graph", { runId: "run-1", timelineLimit: 50 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.graph.run.id).toBe("run-1");
    expect(response.structuredContent.graph.steps).toHaveLength(1);
    expect(response.structuredContent.graph.completionEvaluation.complete).toBe(true);
    expect(fixture.runtime.orchestratorService.getRunGraph).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", timelineLimit: 50 })
    );
  });

  it("routes stream_events to eventBuffer.drain", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 0, limit: 50 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(1);
    expect(response.structuredContent.nextCursor).toBe(1);
    expect(response.structuredContent.hasMore).toBe(false);
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(0, 50);
  });

  it("routes get_step_output and filters attempts by step", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_step_output", {
      runId: "run-1",
      stepKey: "step-a"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.step.stepKey).toBe("step-a");
    expect(response.structuredContent.attempts).toHaveLength(1);
    expect(response.structuredContent.attempts[0].stepId).toBe("step-1");
    expect(fixture.runtime.orchestratorService.getRunGraph).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", timelineLimit: 0 })
    );
  });

  it("routes get_step_output returns error for unknown step", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_step_output", {
      runId: "run-1",
      stepKey: "nonexistent-step"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Step not found");
  });

  it("routes get_worker_states to aiOrchestratorService.getWorkerStates", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_worker_states", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.workers).toHaveLength(1);
    expect(response.structuredContent.workers[0].state).toBe("running");
    expect(fixture.runtime.aiOrchestratorService.getWorkerStates).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("routes get_timeline to orchestratorService.listTimeline", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_timeline", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.timeline).toHaveLength(2);
    expect(response.structuredContent.timeline[0].eventType).toBe("run_started");
    expect(fixture.runtime.orchestratorService.listTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", limit: 300 })
    );
  });

  it("routes get_timeline with stepId filter", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_timeline", { runId: "run-1", stepId: "step-1" });

    expect(response?.isError).toBeUndefined();
    // Only the entry with stepId "step-1" should be returned
    expect(response.structuredContent.timeline).toHaveLength(1);
    expect(response.structuredContent.timeline[0].stepId).toBe("step-1");
  });

  it("routes get_mission_metrics to aiOrchestratorService.getMissionMetrics", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_mission_metrics", { missionId: "mission-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.metrics.missionId).toBe("mission-1");
    expect(response.structuredContent.metrics.samples).toEqual([]);
    expect(fixture.runtime.aiOrchestratorService.getMissionMetrics).toHaveBeenCalledWith({ missionId: "mission-1" });
  });

  it("routes get_final_diff with per-lane diffs", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_final_diff", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    // The mock graph has one step with laneId "lane-1", so we should get diffs for that lane
    expect(response.structuredContent.diffs["lane-1"]).toBeDefined();
    expect(fixture.runtime.diffService.getChanges).toHaveBeenCalledWith("lane-1");
  });

  // ---------- Evaluation Tools ----------

  it("routes evaluate_run with evaluator authorization and writes to DB", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "evaluate_run", {
      runId: "run-1",
      missionId: "mission-1",
      scores: {
        planQuality: 8,
        parallelism: 7,
        coordinatorDecisions: 9,
        resourceEfficiency: 6,
        outcomeQuality: 8
      },
      issues: [
        {
          category: "planning",
          severity: "minor",
          description: "Could have parallelized more",
          recommendation: "Use wider lanes"
        }
      ],
      summary: "Good overall execution with minor planning gaps",
      improvements: ["Increase lane parallelism"],
      metadata: { evaluatorVersion: "1.0" }
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.missionId).toBe("mission-1");
    expect(response.structuredContent.scores.planQuality).toBe(8);
    expect(response.structuredContent.summary).toBe("Good overall execution with minor planning gaps");
    expect(response.structuredContent.id).toBeTruthy();
    expect(response.structuredContent.evaluatedAt).toBeTruthy();
    expect(fixture.runtime.db.run).toHaveBeenCalledTimes(1);
    // Verify the INSERT call has the correct SQL and the run_id parameter
    const runCallArgs = fixture.runtime.db.run.mock.calls[0];
    expect(runCallArgs[0]).toContain("INSERT INTO orchestrator_evaluations");
    expect(runCallArgs[1]).toContain("run-1");
    expect(runCallArgs[1]).toContain("mission-1");
  });

  it("routes list_evaluations and returns summaries", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "list_evaluations", {
      missionId: "mission-1",
      limit: 10
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.evaluations).toHaveLength(1);
    expect(response.structuredContent.evaluations[0].id).toBe("eval-1");
    expect(response.structuredContent.evaluations[0].scores.planQuality).toBe(8);
    expect(response.structuredContent.evaluations[0].issueCount).toBe(0);
    expect(response.structuredContent.evaluations[0].summary).toBe("Good run");
    expect(fixture.runtime.db.all).toHaveBeenCalled();
  });

  it("routes get_evaluation_report with run context", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_evaluation_report", { evaluationId: "eval-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.evaluation.id).toBe("eval-1");
    expect(response.structuredContent.evaluation.runId).toBe("run-1");
    expect(response.structuredContent.evaluation.scores.planQuality).toBe(8);
    expect(response.structuredContent.evaluation.summary).toBe("Good run");
    // run context should be populated from orchestratorService.getRunGraph
    expect(response.structuredContent.runContext).toBeDefined();
    expect(response.structuredContent.runContext.run.id).toBe("run-1");
    expect(response.structuredContent.runContext.stepCount).toBe(1);
    expect(response.structuredContent.runContext.attemptCount).toBe(1);
  });

  it("evaluator gets reads + orchestration + evaluation", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });

    // Read-only observation tool should work
    const readResponse = await callTool(handler, "get_mission", { missionId: "mission-1" });
    expect(readResponse?.isError).toBeUndefined();

    // Orchestration tool should work
    const orchResponse = await callTool(handler, "pause_mission", { runId: "run-1" });
    expect(orchResponse?.isError).toBeUndefined();

    // Evaluation tool should work
    const evalResponse = await callTool(handler, "evaluate_run", {
      runId: "run-1",
      missionId: "mission-1",
      scores: { planQuality: 8, parallelism: 7, coordinatorDecisions: 9, resourceEfficiency: 6, outcomeQuality: 8 },
      issues: [],
      summary: "Test"
    });
    expect(evalResponse?.isError).toBeUndefined();
  });

  it("any session can access observation tools", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });

    // Observation tools should be accessible
    const missionResp = await callTool(handler, "get_mission", { missionId: "mission-1" });
    expect(missionResp?.isError).toBeUndefined();

    const graphResp = await callTool(handler, "get_run_graph", { runId: "run-1" });
    expect(graphResp?.isError).toBeUndefined();

    const timelineResp = await callTool(handler, "get_timeline", { runId: "run-1" });
    expect(timelineResp?.isError).toBeUndefined();

    // Evaluation read tools should also be accessible
    const listResp = await callTool(handler, "list_evaluations", {});
    expect(listResp?.isError).toBeUndefined();

    const reportResp = await callTool(handler, "get_evaluation_report", { evaluationId: "eval-1" });
    expect(reportResp?.isError).toBeUndefined();
  });

  // ---------- Event Streaming Tests ----------

  it("stream_events returns events after cursor", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 5, limit: 100 });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(5, 100);
    // The drain mock returns cursor + 1 as the event id
    expect(response.structuredContent.events[0].id).toBe(6);
    expect(response.structuredContent.nextCursor).toBe(6);
  });

  it("stream_events with empty drain returns same cursor", async () => {
    const fixture = createRuntime();
    // Override drain to return empty events
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [],
      nextCursor: cursor,
      hasMore: false
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 10 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(0);
    expect(response.structuredContent.nextCursor).toBe(10);
    expect(response.structuredContent.hasMore).toBe(false);
  });

  it("stream_events respects category filter", async () => {
    const fixture = createRuntime();
    // Return events with different categories
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [
        { id: cursor + 1, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "step_started" } },
        { id: cursor + 2, timestamp: new Date().toISOString(), category: "mission", payload: { type: "mission_created" } },
        { id: cursor + 3, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "step_completed" } }
      ],
      nextCursor: cursor + 3,
      hasMore: false
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {
      cursor: 0,
      limit: 100,
      category: "orchestrator"
    });

    expect(response?.isError).toBeUndefined();
    // Should only return orchestrator events (2 out of 3)
    expect(response.structuredContent.events).toHaveLength(2);
    expect(response.structuredContent.events.every((e: any) => e.category === "orchestrator")).toBe(true);
  });

  it("stream_events returns runtime validation contract events when requested", async () => {
    const fixture = createRuntime();
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [
        {
          id: cursor + 1,
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: "validation_contract_unfulfilled",
            runId: "run-1",
            stepId: "step-1"
          }
        },
        {
          id: cursor + 2,
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: "validation_self_check_reminder",
            runId: "run-1",
            stepId: "step-2"
          }
        },
        {
          id: cursor + 3,
          timestamp: new Date().toISOString(),
          category: "mission",
          payload: { type: "mission_created" }
        }
      ],
      nextCursor: cursor + 3,
      hasMore: false
    }));
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {
      cursor: 0,
      limit: 100,
      category: "runtime"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(2);
    expect(response.structuredContent.events.every((e: any) => e.category === "runtime")).toBe(true);
    const eventTypes = response.structuredContent.events.map((event: any) => event.payload?.type);
    expect(eventTypes).toContain("validation_contract_unfulfilled");
    expect(eventTypes).toContain("validation_self_check_reminder");
  });

  it("stream_events defaults cursor to 0 and limit to 100", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {});

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(0, 100);
  });
});
