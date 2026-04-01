import { describe, expect, it, vi } from "vitest";
import { createCtoOperatorTools, type CtoOperatorToolDeps } from "./ctoOperatorTools";

const baseSession = {
  id: "chat-1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5",
  modelId: "openai/gpt-5-chat-latest",
  status: "idle",
  createdAt: "2026-03-16T00:00:00.000Z",
  lastActivityAt: "2026-03-16T00:00:00.000Z",
} as const;

const issueFixture = {
  id: "issue-1",
  identifier: "ADE-42",
  title: "Fix workflow regression",
  description: "Regression details",
  url: "https://linear.app/acme/issue/ADE-42",
  projectSlug: "ade",
  stateName: "Todo",
  priorityLabel: "high",
  labels: ["bug"],
  assigneeName: "CTO",
  teamKey: "ADE",
};

function buildDeps(overrides: Partial<CtoOperatorToolDeps> = {}): CtoOperatorToolDeps {
  return {
    currentSessionId: "cto-current",
    defaultLaneId: "lane-1",
    defaultModelId: "openai/gpt-5-chat-latest",
    defaultReasoningEffort: "medium",
    resolveExecutionLane: vi.fn().mockResolvedValue("lane-1"),
    laneService: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    } as any,
    missionService: null,
    aiOrchestratorService: null,
    workerAgentService: null,
    workerHeartbeatService: null,
    linearDispatcherService: null,
    flowPolicyService: null,
    prService: null,
    issueInventoryService: null,
    fileService: null,
    processService: null,
    sessionService: {
      updateMeta: vi.fn(),
    } as any,
    issueTracker: null,
    listChats: vi.fn().mockResolvedValue([]),
    getChatStatus: vi.fn().mockResolvedValue(null),
    getChatTranscript: vi.fn().mockResolvedValue({
      sessionId: "chat-1",
      entries: [{ role: "user", text: "status?", timestamp: "2026-03-16T00:00:00.000Z" }],
      truncated: false,
      totalEntries: 1,
    }),
    createChat: vi.fn().mockResolvedValue(baseSession),
    updateChatSession: vi.fn().mockResolvedValue(baseSession),
    sendChatMessage: vi.fn().mockResolvedValue(undefined),
    interruptChat: vi.fn().mockResolvedValue(undefined),
    resumeChat: vi.fn().mockResolvedValue(baseSession),
    disposeChat: vi.fn().mockResolvedValue(undefined),
    ensureCtoSession: vi.fn().mockResolvedValue({ ...baseSession, id: "cto-session" }),
    ...overrides,
  };
}

describe("createCtoOperatorTools", () => {
  // ── Tool set structure ──────────────────────────────────────────

  it("returns all expected operator tool keys", () => {
    const deps = buildDeps();
    const tools = createCtoOperatorTools(deps);
    const toolKeys = Object.keys(tools);

    // Core chat tools
    expect(toolKeys).toContain("listChats");
    expect(toolKeys).toContain("spawnChat");
    expect(toolKeys).toContain("sendChatMessage");
    expect(toolKeys).toContain("interruptChat");
    expect(toolKeys).toContain("resumeChat");
    expect(toolKeys).toContain("endChat");
    expect(toolKeys).toContain("getChatStatus");
    expect(toolKeys).toContain("getChatTranscript");

    // Lane tools
    expect(toolKeys).toContain("listLanes");
    expect(toolKeys).toContain("inspectLane");
    expect(toolKeys).toContain("createLane");

    // Linear workflow tools
    expect(toolKeys).toContain("listLinearWorkflows");
    expect(toolKeys).toContain("getLinearRunStatus");
    expect(toolKeys).toContain("resolveLinearRunAction");
    expect(toolKeys).toContain("cancelLinearRun");
    expect(toolKeys).toContain("rerouteLinearRun");

    // Mission tools
    expect(toolKeys).toContain("listMissions");
    expect(toolKeys).toContain("startMission");
    expect(toolKeys).toContain("getMissionStatus");
    expect(toolKeys).toContain("updateMission");
    expect(toolKeys).toContain("launchMissionRun");
    expect(toolKeys).toContain("resolveMissionIntervention");
    expect(toolKeys).toContain("getMissionRunView");
    expect(toolKeys).toContain("getMissionLogs");
    expect(toolKeys).toContain("listMissionWorkerDigests");
    expect(toolKeys).toContain("steerMission");

    // Worker tools
    expect(toolKeys).toContain("listWorkers");
    expect(toolKeys).toContain("createWorker");
    expect(toolKeys).toContain("updateWorkerStatus");
    expect(toolKeys).toContain("wakeWorker");
    expect(toolKeys).toContain("getWorkerStatus");

    // PR tools
    expect(toolKeys).toContain("listPullRequests");
    expect(toolKeys).toContain("getPullRequestStatus");
    expect(toolKeys).toContain("commentOnPullRequest");
    expect(toolKeys).toContain("updatePullRequestTitle");
    expect(toolKeys).toContain("updatePullRequestBody");
    expect(toolKeys).toContain("getPullRequestConvergence");
    expect(toolKeys).toContain("updatePullRequestConvergencePipeline");
    expect(toolKeys).toContain("updatePullRequestConvergenceRuntime");
    expect(toolKeys).toContain("startPullRequestConvergenceRound");
    expect(toolKeys).toContain("stopPullRequestConvergence");

    // Linear issue routing / issue tools
    expect(toolKeys).toContain("routeLinearIssueToCto");
    expect(toolKeys).toContain("routeLinearIssueToMission");
    expect(toolKeys).toContain("routeLinearIssueToWorker");
    expect(toolKeys).toContain("commentOnLinearIssue");
    expect(toolKeys).toContain("updateLinearIssueState");

    // Process tools
    expect(toolKeys).toContain("listManagedProcesses");
    expect(toolKeys).toContain("startManagedProcess");
    expect(toolKeys).toContain("stopManagedProcess");
    expect(toolKeys).toContain("getManagedProcessLog");

    // File workspace tools
    expect(toolKeys).toContain("listFileWorkspaces");
    expect(toolKeys).toContain("readWorkspaceFile");
    expect(toolKeys).toContain("searchWorkspaceText");

    // PR creation & management tools
    expect(toolKeys).toContain("createPrFromLane");
    expect(toolKeys).toContain("landPullRequest");
    expect(toolKeys).toContain("closePullRequest");
    expect(toolKeys).toContain("requestPrReviewers");

    // Lane management tools
    expect(toolKeys).toContain("deleteLane");

    // Worker management tools
    expect(toolKeys).toContain("removeWorker");
    expect(toolKeys).toContain("updateWorker");

    // Test management tools
    expect(toolKeys).toContain("listTestSuites");
    expect(toolKeys).toContain("runTests");
    expect(toolKeys).toContain("stopTestRun");
    expect(toolKeys).toContain("listTestRuns");
    expect(toolKeys).toContain("getTestLog");

    // Terminal management tools
    expect(toolKeys).toContain("createTerminal");

    // Linear issue discovery tools
    expect(toolKeys).toContain("listLinearIssues");
    expect(toolKeys).toContain("getLinearIssue");
    expect(toolKeys).toContain("updateLinearIssueAssignee");
    expect(toolKeys).toContain("addLinearIssueLabel");

    // Automation management tools
    expect(toolKeys).toContain("listAutomations");
    expect(toolKeys).toContain("triggerAutomation");
    expect(toolKeys).toContain("listAutomationRuns");
  });

  // ── Chat tools ──────────────────────────────────────────────────

  describe("chat tools", () => {
    it("returns bounded chat transcript reads through the chat service helper", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatTranscript as any).execute({
        sessionId: "chat-1",
        limit: 5,
        maxChars: 500,
      });

      expect(deps.getChatTranscript).toHaveBeenCalledWith({ sessionId: "chat-1", limit: 5, maxChars: 500 });
      expect(result).toMatchObject({
        success: true,
        sessionId: "chat-1",
        count: 1,
        truncated: false,
      });
    });

    it("persists a requested chat title and returns navigation metadata when spawning chats", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.spawnChat as any).execute({
        title: "Backend follow-up",
        initialPrompt: "Inspect the failing tests.",
        openInUi: true,
      });

      expect(deps.createChat).toHaveBeenCalled();
      expect(deps.resolveExecutionLane).toHaveBeenCalledWith(expect.objectContaining({
        requestedLaneId: undefined,
        purpose: "Backend follow-up",
      }));
      expect(deps.updateChatSession).toHaveBeenCalledWith({
        sessionId: "chat-1",
        title: "Backend follow-up",
      });
      expect(deps.sendChatMessage).toHaveBeenCalledWith({
        sessionId: "chat-1",
        text: "Inspect the failing tests.",
      });
      expect(result).toMatchObject({
        success: true,
        sessionId: "chat-1",
        navigation: {
          surface: "work",
          laneId: "lane-1",
          sessionId: "chat-1",
          href: "/work?laneId=lane-1&sessionId=chat-1",
          label: "Open in Work",
        },
        navigationSuggestions: [{
          surface: "work",
          laneId: "lane-1",
          sessionId: "chat-1",
          href: "/work?laneId=lane-1&sessionId=chat-1",
          label: "Open in Work",
        }],
        requestedTitle: "Backend follow-up",
      });
    });

    it("spawns a chat without title or initial prompt", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.spawnChat as any).execute({
        openInUi: false,
      });

      expect(result.success).toBe(true);
      expect(deps.updateChatSession).not.toHaveBeenCalled();
      expect(deps.sendChatMessage).not.toHaveBeenCalled();
      expect(result.requestedTitle).toBeNull();
    });

    it("lists chats with default options", async () => {
      const chatList = [{ id: "chat-1", status: "idle" }];
      const deps = buildDeps({
        listChats: vi.fn().mockResolvedValue(chatList),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listChats as any).execute({});

      expect(result).toMatchObject({ success: true, count: 1, chats: chatList });
    });

    it("lists chats filtered by lane", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      await (tools.listChats as any).execute({ laneId: "lane-2", includeIdentity: true });

      expect(deps.listChats).toHaveBeenCalledWith("lane-2", expect.objectContaining({
        includeAutomation: false,
      }));
    });

    it("sends a message to a chat session", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.sendChatMessage as any).execute({
        sessionId: "chat-1",
        text: "Hello from CTO",
      });

      expect(deps.sendChatMessage).toHaveBeenCalledWith({
        sessionId: "chat-1",
        text: "Hello from CTO",
      });
      expect(result).toMatchObject({ success: true, sessionId: "chat-1" });
    });

    it("interrupts a chat session", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.interruptChat as any).execute({
        sessionId: "chat-1",
      });

      expect(deps.interruptChat).toHaveBeenCalledWith({ sessionId: "chat-1" });
      expect(result).toMatchObject({ success: true, sessionId: "chat-1" });
    });

    it("resumes a chat session and returns navigation", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.resumeChat as any).execute({
        sessionId: "chat-1",
      });

      expect(deps.resumeChat).toHaveBeenCalledWith({ sessionId: "chat-1" });
      expect(result).toMatchObject({
        success: true,
        sessionId: "chat-1",
        navigation: expect.objectContaining({ surface: "work" }),
      });
    });

    it("ends a chat session", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.endChat as any).execute({
        sessionId: "chat-1",
      });

      expect(deps.disposeChat).toHaveBeenCalledWith({ sessionId: "chat-1" });
      expect(result).toMatchObject({ success: true, sessionId: "chat-1" });
    });

    it("gets chat status and returns not found for missing sessions", async () => {
      const deps = buildDeps({
        getChatStatus: vi.fn().mockResolvedValue(null),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatStatus as any).execute({
        sessionId: "nonexistent",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Chat not found") });
    });

    it("gets chat status successfully", async () => {
      const session = { id: "chat-1", status: "idle" };
      const deps = buildDeps({
        getChatStatus: vi.fn().mockResolvedValue(session),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatStatus as any).execute({
        sessionId: "chat-1",
      });

      expect(result).toMatchObject({ success: true, session });
    });
  });

  // ── Lane tools ──────────────────────────────────────────────────

  describe("lane tools", () => {
    it("lists lanes", async () => {
      const lane = { id: "lane-1", name: "primary", status: "active" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listLanes as any).execute({ includeArchived: false });

      expect(result).toMatchObject({ success: true, count: 1 });
      expect(result.lanes[0]).toMatchObject({ id: "lane-1", name: "primary" });
    });

    it("inspects a lane by ID and returns not found for missing lanes", async () => {
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.inspectLane as any).execute({ laneId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Lane not found") });
    });

    it("inspects a lane successfully", async () => {
      const lane = { id: "lane-1", name: "primary", branchRef: "refs/heads/primary" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.inspectLane as any).execute({ laneId: "lane-1" });

      expect(result).toMatchObject({ success: true, lane });
    });

    it("returns lane and mission navigation suggestions for operator-created ADE objects", async () => {
      const lane = { id: "lane-2", name: "ops", branchRef: "refs/heads/ops" };
      const mission = { id: "mission-7", title: "Mission", laneId: "lane-2" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn().mockResolvedValue(lane),
        } as any,
        missionService: {
          create: vi.fn().mockReturnValue(mission),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const createdLane = await (tools.createLane as any).execute({
        name: "ops",
      });
      const startedMission = await (tools.startMission as any).execute({
        prompt: "Investigate the failing deploy path.",
        laneId: "lane-2",
        launch: false,
      });

      expect(createdLane).toMatchObject({
        success: true,
        navigation: {
          surface: "lanes",
          laneId: "lane-2",
          sessionId: null,
          href: "/lanes?laneId=lane-2",
          label: "Open lane",
        },
      });
      expect(startedMission).toMatchObject({
        success: true,
        navigation: {
          surface: "missions",
          laneId: "lane-2",
          missionId: "mission-7",
          href: "/missions?missionId=mission-7&laneId=lane-2",
          label: "Open mission",
        },
      });
    });

    it("handles lane creation errors gracefully", async () => {
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockRejectedValue(new Error("Branch conflict")),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.createLane as any).execute({ name: "conflict-lane" });

      expect(result).toMatchObject({ success: false, error: "Branch conflict" });
    });
  });

  // ── Mission tools ───────────────────────────────────────────────

  describe("mission tools", () => {
    it("updates missions, relaunches runs, and resolves interventions through stable services", async () => {
      const mission = { id: "mission-1", title: "Mission" };
      const intervention = { id: "int-1", status: "resolved" };
      const deps = buildDeps({
        missionService: {
          update: vi.fn().mockReturnValue(mission),
          get: vi.fn().mockReturnValue(mission),
          resolveIntervention: vi.fn().mockReturnValue(intervention),
        } as any,
        aiOrchestratorService: {
          startMissionRun: vi.fn().mockResolvedValue({ started: { run: { id: "run-1" } }, mission }),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const updated = await (tools.updateMission as any).execute({
        missionId: "mission-1",
        title: "Updated title",
        status: "in_progress",
        outcomeSummary: "Working",
      });
      const launched = await (tools.launchMissionRun as any).execute({
        missionId: "mission-1",
        runMode: "manual",
      });
      const resolved = await (tools.resolveMissionIntervention as any).execute({
        missionId: "mission-1",
        interventionId: "int-1",
        status: "resolved",
        resolutionKind: "answer_provided",
        note: "Use the existing implementation.",
      });

      expect((deps.missionService as any).update).toHaveBeenCalledWith({
        missionId: "mission-1",
        title: "Updated title",
        status: "in_progress",
        outcomeSummary: "Working",
      });
      expect((deps.aiOrchestratorService as any).startMissionRun).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: "mission-1",
          runMode: "manual",
          metadata: { launchSource: "cto_operator_tools.launchMissionRun" },
        }),
      );
      expect((deps.missionService as any).resolveIntervention).toHaveBeenCalledWith({
        missionId: "mission-1",
        interventionId: "int-1",
        status: "resolved",
        resolutionKind: "answer_provided",
        note: "Use the existing implementation.",
      });
      expect(updated).toMatchObject({ success: true, mission });
      expect(launched).toMatchObject({ success: true, mission });
      expect(resolved).toMatchObject({ success: true, intervention });
    });

    it("returns error when mission service is not available for listMissions", async () => {
      const deps = buildDeps({ missionService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listMissions as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Mission service") });
    });

    it("lists missions with filters", async () => {
      const missions = [{ id: "m-1", status: "in_progress" }];
      const deps = buildDeps({
        missionService: {
          list: vi.fn().mockReturnValue(missions),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listMissions as any).execute({ status: "in_progress" });

      expect(result).toMatchObject({ success: true, count: 1, missions });
    });

    it("returns error when mission not found for getMissionStatus", async () => {
      const deps = buildDeps({
        missionService: {
          get: vi.fn().mockReturnValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getMissionStatus as any).execute({ missionId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Mission not found") });
    });

    it("returns error when mission not found for launchMissionRun", async () => {
      const deps = buildDeps({
        missionService: {
          get: vi.fn().mockReturnValue(null),
        } as any,
        aiOrchestratorService: {} as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.launchMissionRun as any).execute({ missionId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Mission not found") });
    });

    it("surfaces mission runtime view, logs, worker digests, and steering through aiOrchestratorService", async () => {
      const runView = { missionId: "mission-1", displayStatus: "running" };
      const logs = { entries: [{ id: "log-1" }], nextCursor: null, total: 1 };
      const digests = [{ id: "digest-1" }];
      const steerResult = { acknowledged: true, appliedAt: "2026-03-16T00:00:00.000Z" };
      const deps = buildDeps({
        aiOrchestratorService: {
          getRunView: vi.fn().mockResolvedValue(runView),
          getMissionLogs: vi.fn().mockResolvedValue(logs),
          listWorkerDigests: vi.fn().mockReturnValue(digests),
          steerMission: vi.fn().mockReturnValue(steerResult),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const view = await (tools.getMissionRunView as any).execute({ missionId: "mission-1" });
      const missionLogs = await (tools.getMissionLogs as any).execute({
        missionId: "mission-1",
        channels: ["runtime"],
        limit: 25,
      });
      const workerDigests = await (tools.listMissionWorkerDigests as any).execute({
        missionId: "mission-1",
        limit: 10,
      });
      const steered = await (tools.steerMission as any).execute({
        missionId: "mission-1",
        directive: "Pause on migration cleanup and summarize the risk.",
        priority: "override",
      });

      expect(view).toMatchObject({ success: true, view: runView });
      expect(missionLogs).toMatchObject({ success: true, total: 1 });
      expect(workerDigests).toMatchObject({ success: true, count: 1, digests });
      expect(steered).toMatchObject({ success: true, result: steerResult });
    });

    it("returns error when aiOrchestratorService is null for getMissionRunView", async () => {
      const deps = buildDeps({ aiOrchestratorService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getMissionRunView as any).execute({ missionId: "m-1" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Mission runtime service") });
    });

    it("returns error when run view is null for getMissionRunView", async () => {
      const deps = buildDeps({
        aiOrchestratorService: {
          getRunView: vi.fn().mockResolvedValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getMissionRunView as any).execute({ missionId: "m-1" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Mission run view not found") });
    });
  });

  // ── Worker tools ────────────────────────────────────────────────

  describe("worker tools", () => {
    it("lists workers", async () => {
      const workers = [{ id: "w-1", name: "Alice", role: "engineer" }];
      const deps = buildDeps({
        workerAgentService: {
          listAgents: vi.fn().mockReturnValue(workers),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listWorkers as any).execute({ includeDeleted: false });

      expect(result).toMatchObject({ success: true, count: 1, workers });
    });

    it("returns error when worker service is not available for listWorkers", async () => {
      const deps = buildDeps({ workerAgentService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listWorkers as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Worker service") });
    });

    it("creates a worker", async () => {
      const worker = { id: "w-2", name: "Bob", role: "qa" };
      const deps = buildDeps({
        workerAgentService: {
          saveAgent: vi.fn().mockReturnValue(worker),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.createWorker as any).execute({
        name: "Bob",
        role: "qa",
      });

      expect(result).toMatchObject({ success: true, worker });
    });

    it("updates worker status", async () => {
      const deps = buildDeps({
        workerAgentService: {
          setAgentStatus: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updateWorkerStatus as any).execute({
        agentId: "w-1",
        status: "paused",
      });

      expect(result).toMatchObject({ success: true, agentId: "w-1", status: "paused" });
    });

    it("wakes a worker with a task prompt", async () => {
      const wakeResult = { dispatched: true };
      const deps = buildDeps({
        workerHeartbeatService: {
          triggerWakeup: vi.fn().mockResolvedValue(wakeResult),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.wakeWorker as any).execute({
        agentId: "w-1",
        prompt: "Run the test suite.",
      });

      expect(result).toMatchObject({ success: true, dispatched: true });
    });

    it("returns error when workerHeartbeatService is null for wakeWorker", async () => {
      const deps = buildDeps({ workerHeartbeatService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.wakeWorker as any).execute({
        agentId: "w-1",
        prompt: "test",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Worker heartbeat service") });
    });

    it("gets worker status with core memory and recent runs", async () => {
      const worker = { id: "w-1", name: "Alice", status: "active" };
      const coreMemory = { notes: ["some note"] };
      const runs = [{ id: "run-1" }];
      const deps = buildDeps({
        workerAgentService: {
          getAgent: vi.fn().mockReturnValue(worker),
          getCoreMemory: vi.fn().mockReturnValue(coreMemory),
        } as any,
        workerHeartbeatService: {
          listRuns: vi.fn().mockReturnValue(runs),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getWorkerStatus as any).execute({ agentId: "w-1" });

      expect(result).toMatchObject({
        success: true,
        worker,
        statusSummary: "Worker is active.",
        coreMemory,
        recentRuns: runs,
      });
    });

    it("returns not found for missing worker", async () => {
      const deps = buildDeps({
        workerAgentService: {
          getAgent: vi.fn().mockReturnValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getWorkerStatus as any).execute({ agentId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Worker not found") });
    });
  });

  // ── PR tools ────────────────────────────────────────────────────

  describe("PR tools", () => {
    it("lists pull requests", async () => {
      const prs = [{ id: "pr-1", title: "Fix bug" }];
      const deps = buildDeps({
        prService: {
          refresh: vi.fn().mockResolvedValue(prs),
          listAll: vi.fn().mockReturnValue(prs),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listPullRequests as any).execute({ refresh: true });

      expect(result).toMatchObject({ success: true, count: 1, prs });
    });

    it("returns error when prService is null", async () => {
      const deps = buildDeps({ prService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listPullRequests as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("PR service") });
    });

    it("comments on a pull request", async () => {
      const comment = { id: "comment-1", body: "LGTM" };
      const deps = buildDeps({
        prService: {
          addComment: vi.fn().mockResolvedValue(comment),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnPullRequest as any).execute({
        prId: "pr-1",
        body: "LGTM",
      });

      expect(result).toMatchObject({ success: true, comment });
    });

    it("updates pull request title", async () => {
      const deps = buildDeps({
        prService: {
          updateTitle: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updatePullRequestTitle as any).execute({
        prId: "pr-1",
        title: "New title",
      });

      expect(result).toMatchObject({ success: true, prId: "pr-1", title: "New title" });
    });

    it("updates pull request body", async () => {
      const deps = buildDeps({
        prService: {
          updateDescription: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updatePullRequestBody as any).execute({
        prId: "pr-1",
        body: "New description",
      });

      expect(result).toMatchObject({ success: true, prId: "pr-1" });
    });

    it("reads PR convergence runtime, pipeline settings, and inventory summary", async () => {
      const snapshot = {
        prId: "pr-1",
        items: [
          {
            id: "item-1",
            prId: "pr-1",
            source: "unknown",
            type: "review_thread",
            externalId: "review-thread:thread-1",
            state: "new",
            round: 2,
            filePath: "src/app.ts",
            line: 12,
            severity: "major",
            headline: "Fix the null check",
            body: "Please handle null.",
            author: "Reviewer",
            url: "https://github.com/acme/repo/pull/1#discussion_r1",
            dismissReason: null,
            agentSessionId: null,
            threadCommentCount: 2,
            threadLatestCommentId: "c-2",
            threadLatestCommentAuthor: "Reviewer",
            threadLatestCommentAt: "2026-03-16T00:00:00.000Z",
            threadLatestCommentSource: "unknown",
            createdAt: "2026-03-16T00:00:00.000Z",
            updatedAt: "2026-03-16T00:00:00.000Z",
          },
        ],
        convergence: {
          currentRound: 2,
          maxRounds: 5,
          issuesPerRound: [{ round: 2, newCount: 1, fixedCount: 0, dismissedCount: 0 }],
          totalNew: 1,
          totalFixed: 0,
          totalDismissed: 0,
          totalEscalated: 0,
          totalSentToAgent: 0,
          isConverging: false,
          canAutoAdvance: true,
        },
      };
      const runtime = {
        prId: "pr-1",
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "waiting_for_comments",
        currentRound: 2,
        activeSessionId: "session-1",
        activeLaneId: "lane-1",
        activeHref: "/work?laneId=lane-1&sessionId=session-1",
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: "2026-03-16T00:00:00.000Z",
        lastPolledAt: null,
        lastPausedAt: null,
        lastStoppedAt: null,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      };
      const pipelineSettings = {
        autoMerge: true,
        mergeMethod: "squash",
        maxRounds: 4,
        onRebaseNeeded: "pause",
      };
      const deps = buildDeps({
        prService: {
          listAll: vi.fn().mockReturnValue([issueFixture, { ...issueFixture, id: "pr-1", title: "Path to merge", laneId: "lane-1" }]),
          getStatus: vi.fn().mockResolvedValue({
            prId: "pr-1",
            state: "open",
            checksStatus: "pending",
            reviewStatus: "changes_requested",
            isMergeable: false,
            mergeConflicts: false,
            behindBaseBy: 0,
          }),
          getChecks: vi.fn().mockResolvedValue([{ name: "CI", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null }]),
          getReviewThreads: vi.fn().mockResolvedValue([{ id: "thread-1", isResolved: false, isOutdated: false, path: "src/app.ts", line: 12, originalLine: 12, startLine: null, originalStartLine: null, diffSide: "RIGHT", url: "https://github.com/acme/repo/pull/1#discussion_r1", createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z", comments: [{ id: "c-1", author: "Reviewer", authorAvatarUrl: null, body: "Please handle null.", url: null, createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z" }, { id: "c-2", author: "Reviewer", authorAvatarUrl: null, body: "Still needs a guard.", url: null, createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z" }] }]),
          getComments: vi.fn().mockResolvedValue([{ id: "comment-1", author: "Reviewer", authorAvatarUrl: null, body: "Please handle null.", source: "issue", url: null, path: "src/app.ts", line: 12, createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z" }]),
        } as any,
        issueInventoryService: {
          syncFromPrData: vi.fn().mockReturnValue(snapshot),
          getConvergenceRuntime: vi.fn().mockReturnValue(runtime),
          getPipelineSettings: vi.fn().mockReturnValue(pipelineSettings),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getPullRequestConvergence as any).execute({ prId: "pr-1" });

      expect((deps.issueInventoryService as any).syncFromPrData).toHaveBeenCalledWith(
        "pr-1",
        expect.any(Array),
        expect.any(Array),
        expect.any(Array),
      );
      expect(result).toMatchObject({
        success: true,
        pr: expect.objectContaining({ id: "pr-1", title: "Path to merge" }),
        runtime,
        pipelineSettings,
        inventory: {
          summary: expect.objectContaining({
            currentRound: 2,
            totalNew: 1,
          }),
          items: [expect.objectContaining({
            id: "item-1",
            latestComment: expect.objectContaining({ id: "c-2", author: "Reviewer" }),
          })],
        },
      });
    });

    it("updates convergence pipeline and runtime state", async () => {
      const deps = buildDeps({
        issueInventoryService: {
          savePipelineSettings: vi.fn(),
          getPipelineSettings: vi.fn().mockReturnValue({
            autoMerge: true,
            mergeMethod: "merge",
            maxRounds: 3,
            onRebaseNeeded: "auto_rebase",
          }),
          saveConvergenceRuntime: vi.fn().mockReturnValue({
            prId: "pr-1",
            autoConvergeEnabled: true,
            status: "running",
            pollerStatus: "scheduled",
            currentRound: 3,
            activeSessionId: "session-1",
            activeLaneId: "lane-1",
            activeHref: "/work?laneId=lane-1&sessionId=session-1",
            pauseReason: null,
            errorMessage: null,
            lastStartedAt: null,
            lastPolledAt: null,
            lastPausedAt: null,
            lastStoppedAt: null,
            createdAt: "2026-03-16T00:00:00.000Z",
            updatedAt: "2026-03-16T00:00:00.000Z",
          }),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const pipeline = await (tools.updatePullRequestConvergencePipeline as any).execute({
        prId: "pr-1",
        autoMerge: true,
        mergeMethod: "merge",
        maxRounds: 3,
        onRebaseNeeded: "auto_rebase",
      });
      const runtime = await (tools.updatePullRequestConvergenceRuntime as any).execute({
        prId: "pr-1",
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "scheduled",
        currentRound: 3,
        activeSessionId: "session-1",
        activeLaneId: "lane-1",
        activeHref: "/work?laneId=lane-1&sessionId=session-1",
      });

      expect((deps.issueInventoryService as any).savePipelineSettings).toHaveBeenCalledWith("pr-1", {
        autoMerge: true,
        mergeMethod: "merge",
        maxRounds: 3,
        onRebaseNeeded: "auto_rebase",
      });
      expect((deps.issueInventoryService as any).saveConvergenceRuntime).toHaveBeenCalledWith("pr-1", expect.objectContaining({
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "scheduled",
        currentRound: 3,
      }));
      expect(pipeline).toMatchObject({ success: true, pipelineSettings: { autoMerge: true, mergeMethod: "merge" } });
      expect(runtime).toMatchObject({ success: true, runtime: expect.objectContaining({ currentRound: 3 }) });
    });

    it("launches and stops a PR convergence round through chat services", async () => {
      const deps = buildDeps({
        prService: {
          listAll: vi.fn().mockReturnValue([{ ...issueFixture, id: "pr-1", laneId: "lane-1" }]),
          getStatus: vi.fn().mockResolvedValue({
            prId: "pr-1",
            state: "open",
            checksStatus: "failing",
            reviewStatus: "changes_requested",
            isMergeable: false,
            mergeConflicts: false,
            behindBaseBy: 0,
          }),
          getChecks: vi.fn().mockResolvedValue([]),
          getReviewThreads: vi.fn().mockResolvedValue([{ id: "thread-1", isResolved: false, isOutdated: false, path: "src/app.ts", line: 12, originalLine: 12, startLine: null, originalStartLine: null, diffSide: "RIGHT", url: "https://github.com/acme/repo/pull/1#discussion_r1", createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z", comments: [{ id: "c-1", author: "Reviewer", authorAvatarUrl: null, body: "Please handle null.", url: null, createdAt: "2026-03-16T00:00:00.000Z", updatedAt: "2026-03-16T00:00:00.000Z" }] }]),
          getComments: vi.fn().mockResolvedValue([]),
          getDetail: vi.fn().mockResolvedValue(null),
          getFiles: vi.fn().mockResolvedValue([]),
          getActionRuns: vi.fn().mockResolvedValue([]),
        } as any,
        laneService: {
          list: vi.fn().mockResolvedValue([{ id: "lane-1", worktreePath: "/tmp", archivedAt: null }]),
          getLaneBaseAndBranch: vi.fn().mockResolvedValue({ baseBranch: "main", headBranch: "feature" }),
        } as any,
        issueInventoryService: {
          syncFromPrData: vi.fn().mockReturnValue({
            prId: "pr-1",
            items: [
              {
                id: "inventory-item-1",
                prId: "pr-1",
                source: "unknown",
                type: "review_thread",
                externalId: "review-thread:thread-1",
                state: "new",
                round: 1,
                filePath: "src/app.ts",
                line: 12,
                severity: "major",
                headline: "Please handle null.",
                body: "Please handle null.",
                author: "Reviewer",
                url: "https://github.com/acme/repo/pull/1#discussion_r1",
                dismissReason: null,
                agentSessionId: null,
                threadCommentCount: 1,
                threadLatestCommentId: "c-1",
                threadLatestCommentAuthor: "Reviewer",
                threadLatestCommentAt: "2026-03-16T00:00:00.000Z",
                threadLatestCommentSource: "unknown",
                createdAt: "2026-03-16T00:00:00.000Z",
                updatedAt: "2026-03-16T00:00:00.000Z",
              },
            ],
            convergence: {
              currentRound: 1,
              maxRounds: 5,
              issuesPerRound: [{ round: 1, newCount: 1, fixedCount: 0, dismissedCount: 0 }],
              totalNew: 1,
              totalFixed: 0,
              totalDismissed: 0,
              totalEscalated: 0,
              totalSentToAgent: 0,
              isConverging: false,
              canAutoAdvance: true,
            },
          }),
          getNewItems: vi.fn().mockReturnValue([{ id: "inventory-item-1" }]),
          markSentToAgent: vi.fn(),
          getConvergenceRuntime: vi.fn().mockReturnValue({
            prId: "pr-1",
            autoConvergeEnabled: true,
            status: "running",
            pollerStatus: "waiting_for_comments",
            currentRound: 1,
            activeSessionId: null,
            activeLaneId: null,
            activeHref: null,
            pauseReason: null,
            errorMessage: null,
            lastStartedAt: null,
            lastPolledAt: null,
            lastPausedAt: null,
            lastStoppedAt: null,
            createdAt: "2026-03-16T00:00:00.000Z",
            updatedAt: "2026-03-16T00:00:00.000Z",
          }),
          getPipelineSettings: vi.fn().mockReturnValue({
            autoMerge: true,
            mergeMethod: "merge",
            maxRounds: 5,
            onRebaseNeeded: "pause",
          }),
          saveConvergenceRuntime: vi.fn().mockReturnValue({
            prId: "pr-1",
            autoConvergeEnabled: true,
            status: "running",
            pollerStatus: "waiting_for_comments",
            currentRound: 2,
            activeSessionId: "session-2",
            activeLaneId: "lane-1",
            activeHref: "/work?laneId=lane-1&sessionId=session-2",
            pauseReason: null,
            errorMessage: null,
            lastStartedAt: "2026-03-16T00:00:00.000Z",
            lastPolledAt: null,
            lastPausedAt: null,
            lastStoppedAt: null,
            createdAt: "2026-03-16T00:00:00.000Z",
            updatedAt: "2026-03-16T00:00:00.000Z",
          }),
        } as any,
        sessionService: {
          updateMeta: vi.fn(),
        } as any,
        createChat: vi.fn().mockResolvedValue({ ...baseSession, id: "session-2", laneId: "lane-1" }),
        sendChatMessage: vi.fn().mockResolvedValue(undefined),
        interruptChat: vi.fn().mockResolvedValue(undefined),
      });
      const tools = createCtoOperatorTools(deps);

      const started = await (tools.startPullRequestConvergenceRound as any).execute({
        prId: "pr-1",
        scope: "comments",
        modelId: "openai/gpt-5.4",
        additionalInstructions: "Be concise.",
      });
      const stopped = await (tools.stopPullRequestConvergence as any).execute({
        prId: "pr-1",
        sessionId: "session-2",
        reason: "Stop for now.",
      });

      expect(started).toMatchObject({ success: true });
      expect((deps.issueInventoryService as any).markSentToAgent).toHaveBeenCalledWith(
        "pr-1",
        ["inventory-item-1"],
        "session-2",
        2,
      );
      expect((deps.interruptChat as any)).toHaveBeenCalledWith({ sessionId: "session-2" });
      expect((deps.issueInventoryService as any).saveConvergenceRuntime).toHaveBeenCalledWith("pr-1", expect.objectContaining({
        status: "stopped",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
      }));
      expect(started).toMatchObject({
        success: true,
        sessionId: "session-2",
        laneId: "lane-1",
        href: "/work?laneId=lane-1&sessionId=session-2",
      });
      expect(stopped).toMatchObject({
        success: true,
        sessionId: "session-2",
      });
    });
  });

  // ── Linear workflow tools ───────────────────────────────────────

  describe("Linear workflow tools", () => {
    it.each(["approve", "reject", "retry", "resume", "complete"] as const)(
      "resolves Linear run actions for %s",
      async (action) => {
        const deps = buildDeps({
          flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
          linearDispatcherService: {
            resolveRunAction: vi.fn().mockResolvedValue({ id: "run-1", status: "queued" }),
          } as any,
        });
        const tools = createCtoOperatorTools(deps);

        const result = await (tools.resolveLinearRunAction as any).execute({
          runId: "run-1",
          action,
          note: "operator note",
        });

        expect((deps.linearDispatcherService as any).resolveRunAction).toHaveBeenCalledWith(
          "run-1",
          action,
          "operator note",
          { workflows: [] },
          undefined,
          undefined,
        );
        expect(result).toMatchObject({ success: true, run: { id: "run-1" } });
      },
    );

    it("cancels Linear runs and returns refreshed detail", async () => {
      const detail = { run: { id: "run-1", status: "cancelled" } };
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          cancelRun: vi.fn().mockResolvedValue(undefined),
          getRunDetail: vi.fn().mockResolvedValue(detail),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.cancelLinearRun as any).execute({
        runId: "run-1",
        reason: "Need to reassign.",
      });

      expect((deps.linearDispatcherService as any).cancelRun).toHaveBeenCalledWith("run-1", "Need to reassign.", { workflows: [] });
      expect(result).toMatchObject({ success: true, runId: "run-1", detail });
    });

    it("returns error when Linear services are not available for listLinearWorkflows", async () => {
      const deps = buildDeps({ linearDispatcherService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listLinearWorkflows as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Linear dispatcher") });
    });

    it("lists active and queued Linear workflows", async () => {
      const activeRuns = [{ id: "run-1" }];
      const queuedRuns = [{ id: "run-2" }];
      const deps = buildDeps({
        linearDispatcherService: {
          listActiveRuns: vi.fn().mockReturnValue(activeRuns),
          listQueue: vi.fn().mockReturnValue(queuedRuns),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listLinearWorkflows as any).execute({});

      expect(result).toMatchObject({ success: true, activeRuns, queuedRuns });
    });

    it("gets Linear run status", async () => {
      const detail = { run: { id: "run-1", status: "in_progress" } };
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue(detail),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getLinearRunStatus as any).execute({ runId: "run-1" });

      expect(result).toMatchObject({ success: true, detail });
    });

    it("returns error when Linear run is not found", async () => {
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getLinearRunStatus as any).execute({ runId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Workflow run not found") });
    });

    it("returns error when resolveRunAction returns null", async () => {
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          resolveRunAction: vi.fn().mockResolvedValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.resolveLinearRunAction as any).execute({
        runId: "nonexistent",
        action: "approve",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Workflow run not found") });
    });

    it("reroutes active Linear runs by cancelling first and then routing to a mission", async () => {
      const mission = { id: "mission-9" };
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        missionService: {
          create: vi.fn().mockReturnValue(mission),
        } as any,
        aiOrchestratorService: {
          startMissionRun: vi.fn().mockResolvedValue({ started: { run: { id: "run-2" } }, mission }),
        } as any,
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue({
            run: { id: "run-1", issueId: "issue-1", status: "awaiting_delegation" },
            issue: { id: "issue-1" },
          }),
          cancelRun: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.rerouteLinearRun as any).execute({
        runId: "run-1",
        target: "mission",
        reason: "Delegate through mission planning instead.",
        runMode: "autopilot",
      });

      expect((deps.linearDispatcherService as any).cancelRun).toHaveBeenCalledWith(
        "run-1",
        "Delegate through mission planning instead. (rerouted by CTO)",
        { workflows: [] },
      );
      expect((deps.missionService as any).create).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        cancelledExistingRun: true,
        rerouted: { success: true, mission },
      });
    });

    it("reroutes terminal Linear runs without cancelling and can hand them back to the CTO session", async () => {
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue({
            run: { id: "run-1", issueId: "issue-1", status: "failed" },
            issue: { id: "issue-1" },
          }),
          cancelRun: vi.fn().mockResolvedValue(undefined),
        } as any,
        ensureCtoSession: vi.fn().mockResolvedValue({ ...baseSession, id: "cto-recovery" }),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.rerouteLinearRun as any).execute({
        runId: "run-1",
        target: "cto",
        reason: "Escalate back to the operator.",
        reuseExisting: false,
      });

      expect((deps.linearDispatcherService as any).cancelRun).not.toHaveBeenCalled();
      expect(deps.ensureCtoSession).toHaveBeenCalled();
      expect(deps.sendChatMessage).toHaveBeenCalledWith({
        sessionId: "cto-recovery",
        text: expect.stringContaining("ADE-42: Fix workflow regression"),
      });
      expect(result).toMatchObject({
        success: true,
        cancelledExistingRun: false,
        rerouted: {
          success: true,
          navigation: { surface: "cto", laneId: "lane-1", sessionId: "cto-recovery", href: "/cto" },
        },
      });
    });

    it("returns error when rerouteLinearRun finds no issue on the run", async () => {
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue({
            run: { id: "run-1", issueId: "", status: "failed" },
            issue: null,
          }),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.rerouteLinearRun as any).execute({
        runId: "run-1",
        target: "cto",
        reason: "test",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("no associated issue") });
    });

    it("returns error when rerouteLinearRun cannot find the run", async () => {
      const deps = buildDeps({
        flowPolicyService: { getPolicy: vi.fn().mockReturnValue({ workflows: [] }) } as any,
        linearDispatcherService: {
          getRunDetail: vi.fn().mockResolvedValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.rerouteLinearRun as any).execute({
        runId: "nonexistent",
        target: "cto",
        reason: "test",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Workflow run not found") });
    });
  });

  // ── Linear issue routing tools ──────────────────────────────────

  describe("Linear issue routing tools", () => {
    it("routes a Linear issue to the CTO session", async () => {
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        ensureCtoSession: vi.fn().mockResolvedValue({ ...baseSession, id: "cto-session" }),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToCto as any).execute({
        issueId: "issue-1",
      });

      expect(result).toMatchObject({ success: true });
      expect(deps.ensureCtoSession).toHaveBeenCalled();
    });

    it("routes a Linear issue to a mission", async () => {
      const mission = { id: "m-1", laneId: "lane-1" };
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        missionService: {
          create: vi.fn().mockReturnValue(mission),
        } as any,
        aiOrchestratorService: {
          startMissionRun: vi.fn().mockResolvedValue({ mission }),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToMission as any).execute({
        issueId: "issue-1",
      });

      expect(result).toMatchObject({ success: true, mission });
    });

    it("returns error when issue tracker is not available for routing", async () => {
      const deps = buildDeps({ issueTracker: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToCto as any).execute({
        issueId: "issue-1",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("issue tracker") });
    });

    it("returns error when issue is not found for routing", async () => {
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(null),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToCto as any).execute({
        issueId: "nonexistent",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Issue not found") });
    });

    it("routes a Linear issue to a worker", async () => {
      const wakeResult = { dispatched: true };
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        workerHeartbeatService: {
          triggerWakeup: vi.fn().mockResolvedValue(wakeResult),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToWorker as any).execute({
        issueId: "issue-1",
        agentId: "w-1",
      });

      expect(result).toMatchObject({ success: true, dispatched: true });
    });

    it("returns error when agentId is empty for routing to worker", async () => {
      const deps = buildDeps({
        issueTracker: {
          fetchIssueById: vi.fn().mockResolvedValue(issueFixture),
        } as any,
        workerHeartbeatService: {} as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.routeLinearIssueToWorker as any).execute({
        issueId: "issue-1",
        agentId: "  ",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("agentId is required") });
    });
  });

  // ── Linear issue tools ──────────────────────────────────────────

  describe("Linear issue tools", () => {
    it("comments on a Linear issue", async () => {
      const comment = { id: "comment-1" };
      const deps = buildDeps({
        issueTracker: {
          createComment: vi.fn().mockResolvedValue(comment),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnLinearIssue as any).execute({
        issueId: "issue-1",
        body: "Working on it.",
      });

      expect(result).toMatchObject({ success: true, comment });
    });

    it("returns error when issue tracker is not available for commenting", async () => {
      const deps = buildDeps({ issueTracker: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnLinearIssue as any).execute({
        issueId: "issue-1",
        body: "test",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("issue tracker") });
    });

    it("updates a Linear issue state by stateId", async () => {
      const deps = buildDeps({
        issueTracker: {
          updateIssueState: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updateLinearIssueState as any).execute({
        issueId: "issue-1",
        stateId: "state-done",
      });

      expect(result).toMatchObject({ success: true, issueId: "issue-1", stateId: "state-done" });
    });

    it("returns error when neither stateId nor stateName is provided", async () => {
      const deps = buildDeps({
        issueTracker: {} as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updateLinearIssueState as any).execute({
        issueId: "issue-1",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Provide either stateId or stateName") });
    });
  });

  // ── Process tools ───────────────────────────────────────────────

  describe("process tools", () => {
    it("lists managed processes", async () => {
      const defs = [{ id: "proc-1" }];
      const runtime = [{ id: "proc-1", status: "running" }];
      const deps = buildDeps({
        processService: {
          listDefinitions: vi.fn().mockReturnValue(defs),
          listRuntime: vi.fn().mockReturnValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listManagedProcesses as any).execute({});

      expect(result).toMatchObject({ success: true, definitions: defs, runtime });
    });

    it("returns error when processService is null", async () => {
      const deps = buildDeps({ processService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listManagedProcesses as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Process service") });
    });

    it("starts a managed process", async () => {
      const runtime = { id: "proc-1", status: "running" };
      const deps = buildDeps({
        processService: {
          start: vi.fn().mockResolvedValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.startManagedProcess as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, runtime });
    });

    it("stops a managed process", async () => {
      const runtime = { id: "proc-1", status: "stopped" };
      const deps = buildDeps({
        processService: {
          stop: vi.fn().mockResolvedValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.stopManagedProcess as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, runtime });
    });

    it("reads bounded process log tail", async () => {
      const deps = buildDeps({
        processService: {
          getLogTail: vi.fn().mockReturnValue("line 1\nline 2\n"),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getManagedProcessLog as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, content: "line 1\nline 2\n" });
    });
  });

  // ── File workspace tools ────────────────────────────────────────

  describe("file workspace tools", () => {
    it("lists file workspaces", async () => {
      const workspaces = [{ id: "ws-1", laneId: "lane-1" }];
      const deps = buildDeps({
        fileService: {
          listWorkspaces: vi.fn().mockReturnValue(workspaces),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listFileWorkspaces as any).execute({});

      expect(result).toMatchObject({ success: true, count: 1, workspaces });
    });

    it("returns error when fileService is null", async () => {
      const deps = buildDeps({ fileService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listFileWorkspaces as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("File service") });
    });
  });
});
