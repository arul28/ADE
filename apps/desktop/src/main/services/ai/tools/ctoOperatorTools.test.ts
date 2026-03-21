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
    fileService: null,
    processService: null,
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
      navigation: { surface: "work", laneId: "lane-1", sessionId: "chat-1", href: "/work?laneId=lane-1&sessionId=chat-1" },
      navigationSuggestions: [{ surface: "work", laneId: "lane-1", sessionId: "chat-1", href: "/work?laneId=lane-1&sessionId=chat-1" }],
      requestedTitle: "Backend follow-up",
    });
  });

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
      navigation: { surface: "lanes", laneId: "lane-2", href: "/lanes?laneId=lane-2" },
    });
    expect(startedMission).toMatchObject({
      success: true,
      navigation: { surface: "missions", laneId: "lane-2", missionId: "mission-7", href: "/missions?missionId=mission-7&laneId=lane-2" },
    });
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

  it.each(["approve", "reject", "retry", "complete"] as const)(
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
});
