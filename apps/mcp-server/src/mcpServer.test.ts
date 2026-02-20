import { describe, expect, it, vi } from "vitest";
import { createMcpRequestHandler } from "./mcpServer";

type RuntimeFixture = ReturnType<typeof createRuntime>;

function createRuntime() {
  const operationStart = vi.fn((args: any) => ({ operationId: `op-${args.kind}-${Date.now()}` }));
  const operationFinish = vi.fn();

  const laneRows = [
    {
      id: "lane-1",
      name: "Lane 1",
      laneType: "worktree",
      parentLaneId: null,
      baseRef: "main",
      branchRef: "feature/lane-1",
      worktreePath: "/tmp/project/.ade/worktrees/lane-1",
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
      worktreePath: "/tmp/project/.ade/worktrees/lane-2",
      archivedAt: null,
      stackDepth: 1,
      status: { dirty: true, ahead: 0, behind: 2 },
      tags: ["auth"]
    }
  ];

  const runtime = {
    projectRoot: "/tmp/project",
    projectId: "project-1",
    project: { rootPath: "/tmp/project", displayName: "project", baseRef: "main" },
    paths: {} as any,
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
      listOverlaps: vi.fn(async () => [])
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
        toolType: "claude"
      })
    );
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("--model");
  });

  it("routes run_tests for suite and ad-hoc command contracts", async () => {
    const fixture = createRuntime();
    const handler = createMcpRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);

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
});
