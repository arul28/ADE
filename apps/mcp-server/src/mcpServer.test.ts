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
      get: vi.fn(() => ({ count: 0 })),
      all: vi.fn((sql: string) => {
        if (sql.includes("from missions")) return [{ id: "mission-1" }];
        return [];
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
      get: vi.fn()
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
  it("lists the full Phase 2 tool surface", async () => {
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
        "run_tests",
        "get_lane_status",
        "list_lanes",
        "commit_changes"
      ])
    );
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });

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

  it("denies mutation tools without claims and writes failed audit record", async () => {
    const { runtime, operationStart, operationFinish } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "commit_changes", {
      laneId: "lane-1",
      message: "test"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
    expect(operationStart).toHaveBeenCalledTimes(1);
    expect(operationFinish).toHaveBeenCalledTimes(1);
    expect(operationFinish.mock.calls[0]?.[0]?.status).toBe("failed");
  });

  it("allows mutations when identity grants allowMutations", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });

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

  // ---------- Issue 1: Consolidated authorization tests ----------

  it("denies run_tests without mutation authorization", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "run_tests", {
      laneId: "lane-1",
      suiteId: "unit",
      waitForCompletion: false
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
  });

  it("denies create_queue without mutation authorization", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "create_queue", {
      laneIds: ["lane-1"],
      targetBranch: "main"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
  });

  it("denies create_integration without mutation authorization", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "create_integration", {
      sourceLaneIds: ["lane-1"],
      integrationLaneName: "integration",
      baseBranch: "main",
      title: "Integration PR"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
  });

  it("denies rebase_lane without mutation authorization", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "rebase_lane", {
      laneId: "lane-1"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
  });

  it("denies land_queue_next without mutation authorization", async () => {
    const { runtime } = createRuntime();
    const handler = createMcpRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent", allowMutations: false });

    const response = await callTool(handler, "land_queue_next", {
      groupId: "group-1",
      method: "merge"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Policy denied");
  });

  // ---------- Issue 2: Global rate limit tests ----------

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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
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

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator", allowMutations: true });
    const response = await callTool(handler, "run_tests", { laneId: "lane-1" });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("suiteId or command");
  });
});
