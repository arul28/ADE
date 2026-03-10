import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMissionsStore, initialMissionsState, type MissionsStore } from "./useMissionsStore";

/* ── Mock window.ade ── */
const mockMissionsList = vi.fn().mockResolvedValue([]);
const mockMissionsGet = vi.fn().mockResolvedValue(null);
const mockMissionsGetDashboard = vi.fn().mockResolvedValue({ active: [], recent: [], weekly: { missions: 0, successRate: 0, avgDurationMs: 0, totalCostUsd: 0 } });
const mockGetFullMissionView = vi.fn().mockResolvedValue({
  mission: null,
  runGraph: null,
  artifacts: [],
  checkpoints: [],
  dashboard: null,
});
const mockMissionsOnEvent = vi.fn().mockReturnValue(() => {});
const mockOrchestratorListRuns = vi.fn().mockResolvedValue([]);
const mockOrchestratorGetRunGraph = vi.fn().mockResolvedValue(null);
const mockOrchestratorListArtifacts = vi.fn().mockResolvedValue([]);
const mockOrchestratorListWorkerCheckpoints = vi.fn().mockResolvedValue([]);
const mockOrchestratorOnEvent = vi.fn().mockReturnValue(() => {});
const mockProjectConfigGet = vi.fn().mockResolvedValue({
  shared: {},
  local: { ai: {} },
  effective: { ai: {} },
});
const mockProjectConfigSave = vi.fn().mockResolvedValue({
  shared: {},
  local: { ai: {} },
  effective: { ai: {} },
});

vi.stubGlobal("window", {
  ade: {
    missions: {
      list: mockMissionsList,
      get: mockMissionsGet,
      getDashboard: mockMissionsGetDashboard,
      getFullMissionView: mockGetFullMissionView,
      onEvent: mockMissionsOnEvent,
    },
    orchestrator: {
      listRuns: mockOrchestratorListRuns,
      getRunGraph: mockOrchestratorGetRunGraph,
      listArtifacts: mockOrchestratorListArtifacts,
      listWorkerCheckpoints: mockOrchestratorListWorkerCheckpoints,
      onEvent: mockOrchestratorOnEvent,
    },
    projectConfig: {
      get: mockProjectConfigGet,
      save: mockProjectConfigSave,
    },
  },
});

describe("useMissionsStore", () => {
  beforeEach(() => {
    useMissionsStore.setState(initialMissionsState);
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("has empty missions array", () => {
      const state = useMissionsStore.getState();
      expect(state.missions).toEqual([]);
    });

    it("has null selectedMissionId", () => {
      const state = useMissionsStore.getState();
      expect(state.selectedMissionId).toBeNull();
    });

    it("has chat as default active tab", () => {
      const state = useMissionsStore.getState();
      expect(state.activeTab).toBe("chat");
    });

    it("has loading true initially", () => {
      const state = useMissionsStore.getState();
      expect(state.loading).toBe(true);
    });

    it("has null runGraph initially", () => {
      const state = useMissionsStore.getState();
      expect(state.runGraph).toBeNull();
    });

    it("has null dashboard initially", () => {
      const state = useMissionsStore.getState();
      expect(state.dashboard).toBeNull();
    });

    it("has null error initially", () => {
      const state = useMissionsStore.getState();
      expect(state.error).toBeNull();
    });
  });

  describe("simple setters", () => {
    it("setSelectedMissionId updates store", () => {
      useMissionsStore.getState().setSelectedMissionId("mission-123");
      expect(useMissionsStore.getState().selectedMissionId).toBe("mission-123");
    });

    it("setActiveTab updates store", () => {
      useMissionsStore.getState().setActiveTab("plan");
      expect(useMissionsStore.getState().activeTab).toBe("plan");
    });

    it("setSearchFilter updates store", () => {
      useMissionsStore.getState().setSearchFilter("test query");
      expect(useMissionsStore.getState().searchFilter).toBe("test query");
    });

    it("setError updates store", () => {
      useMissionsStore.getState().setError("Something went wrong");
      expect(useMissionsStore.getState().error).toBe("Something went wrong");
    });

    it("setMissionListView updates store", () => {
      useMissionsStore.getState().setMissionListView("board");
      expect(useMissionsStore.getState().missionListView).toBe("board");
    });

    it("setMissionSettingsDraft accepts function updater", () => {
      useMissionsStore.getState().setMissionSettingsDraft((prev) => ({
        ...prev,
        teammatePlanMode: "off",
      }));
      expect(useMissionsStore.getState().missionSettingsDraft.teammatePlanMode).toBe("off");
    });
  });

  describe("clearSelection", () => {
    it("resets selection-related state", () => {
      useMissionsStore.setState({
        selectedMission: { id: "m1" } as any,
        runGraph: { run: { id: "r1" } } as any,
        orchestratorArtifacts: [{ id: "a1" }] as any[],
        workerCheckpoints: [{ id: "c1" }] as any[],
        coordinatorPromptInspector: { sections: [] } as any,
        originalStepCount: 5,
      });

      useMissionsStore.getState().clearSelection();
      const state = useMissionsStore.getState();

      expect(state.selectedMission).toBeNull();
      expect(state.runGraph).toBeNull();
      expect(state.orchestratorArtifacts).toEqual([]);
      expect(state.workerCheckpoints).toEqual([]);
      expect(state.coordinatorPromptInspector).toBeNull();
      expect(state.originalStepCount).toBeNull();
    });
  });

  describe("refreshMissionList", () => {
    it("calls missions.list and updates state", async () => {
      const missions = [
        { id: "m1", title: "Mission 1", status: "in_progress" },
        { id: "m2", title: "Mission 2", status: "completed" },
      ];
      mockMissionsList.mockResolvedValueOnce(missions);

      await useMissionsStore.getState().refreshMissionList();
      const state = useMissionsStore.getState();

      expect(mockMissionsList).toHaveBeenCalledWith({ limit: 300 });
      expect(state.missions).toEqual(missions);
      expect(state.loading).toBe(false);
      expect(state.refreshing).toBe(false);
      expect(state.error).toBeNull();
    });

    it("preserves selection when mission still exists", async () => {
      useMissionsStore.setState({ selectedMissionId: "m1" });
      const missions = [{ id: "m1", title: "Mission 1", status: "in_progress" }];
      mockMissionsList.mockResolvedValueOnce(missions);

      await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });
      expect(useMissionsStore.getState().selectedMissionId).toBe("m1");
    });

    it("clears selection when mission no longer exists", async () => {
      useMissionsStore.setState({ selectedMissionId: "m-gone" });
      const missions = [{ id: "m1", title: "Mission 1", status: "in_progress" }];
      mockMissionsList.mockResolvedValueOnce(missions);

      await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });
      expect(useMissionsStore.getState().selectedMissionId).toBeNull();
    });

    it("sets error on failure", async () => {
      mockMissionsList.mockRejectedValueOnce(new Error("Network error"));

      await useMissionsStore.getState().refreshMissionList();
      expect(useMissionsStore.getState().error).toBe("Network error");
      expect(useMissionsStore.getState().loading).toBe(false);
    });
  });

  describe("loadMissionDetail", () => {
    it("calls missions.get and updates selectedMission", async () => {
      const detail = { id: "m1", title: "Test Mission", status: "in_progress", prompt: "test" };
      mockMissionsGet.mockResolvedValueOnce(detail);

      await useMissionsStore.getState().loadMissionDetail("m1");
      expect(mockMissionsGet).toHaveBeenCalledWith("m1");
      expect(useMissionsStore.getState().selectedMission).toEqual(detail);
    });

    it("skips empty missionId", async () => {
      await useMissionsStore.getState().loadMissionDetail("  ");
      expect(mockMissionsGet).not.toHaveBeenCalled();
    });
  });

  describe("loadOrchestratorGraph", () => {
    it("clears runGraph for empty missionId", async () => {
      useMissionsStore.setState({ runGraph: { run: { id: "r1" } } as any });
      await useMissionsStore.getState().loadOrchestratorGraph("");
      expect(useMissionsStore.getState().runGraph).toBeNull();
    });

    it("sets runGraph null when no runs", async () => {
      mockOrchestratorListRuns.mockResolvedValueOnce([]);
      await useMissionsStore.getState().loadOrchestratorGraph("m1");
      expect(useMissionsStore.getState().runGraph).toBeNull();
    });

    it("loads run graph when runs exist", async () => {
      const run = { id: "r1", status: "active" };
      const graph = { run, steps: [{ id: "s1" }], attempts: [], claims: [], timeline: [] };
      mockOrchestratorListRuns.mockResolvedValueOnce([run]);
      mockOrchestratorGetRunGraph.mockResolvedValueOnce(graph);

      await useMissionsStore.getState().loadOrchestratorGraph("m1");
      expect(useMissionsStore.getState().runGraph).toEqual(graph);
    });

    it("sets originalStepCount on first load", async () => {
      const run = { id: "r1", status: "active" };
      const graph = { run, steps: [{ id: "s1" }, { id: "s2" }], attempts: [], claims: [], timeline: [] };
      mockOrchestratorListRuns.mockResolvedValueOnce([run]);
      mockOrchestratorGetRunGraph.mockResolvedValueOnce(graph);

      await useMissionsStore.getState().loadOrchestratorGraph("m1");
      expect(useMissionsStore.getState().originalStepCount).toBe(2);
    });
  });

  describe("loadRunArtifacts", () => {
    it("clears artifacts for empty missionId", async () => {
      useMissionsStore.setState({
        orchestratorArtifacts: [{ id: "a1" }] as any[],
        workerCheckpoints: [{ id: "c1" }] as any[],
      });
      await useMissionsStore.getState().loadRunArtifacts("", null);
      expect(useMissionsStore.getState().orchestratorArtifacts).toEqual([]);
      expect(useMissionsStore.getState().workerCheckpoints).toEqual([]);
    });
  });

  describe("selectors return correct slices", () => {
    it("each selector returns its expected field", () => {
      useMissionsStore.setState({
        missions: [{ id: "m1" }] as any[],
        selectedMissionId: "m1",
        activeTab: "plan",
        searchFilter: "hello",
        error: "some error",
      });

      const state = useMissionsStore.getState();
      expect(state.missions).toHaveLength(1);
      expect(state.selectedMissionId).toBe("m1");
      expect(state.activeTab).toBe("plan");
      expect(state.searchFilter).toBe("hello");
      expect(state.error).toBe("some error");
    });
  });

  describe("selectMission (VAL-ARCH-004)", () => {
    it("calls getFullMissionView and populates store in one shot", async () => {
      const mission = { id: "m1", title: "Test", status: "in_progress", prompt: "do stuff" };
      const runGraph = {
        run: { id: "r1", status: "active" },
        steps: [{ id: "s1" }],
        attempts: [],
        claims: [],
        timeline: [],
      };
      const artifacts = [{ id: "a1", kind: "plan", value: "plan.md" }];
      const checkpoints = [{ id: "c1" }];
      const dashboard = { active: [], recent: [], weekly: { missions: 1, successRate: 100, avgDurationMs: 0, totalCostUsd: 0 } };

      mockGetFullMissionView.mockResolvedValueOnce({
        mission,
        runGraph,
        artifacts,
        checkpoints,
        dashboard,
      });

      await useMissionsStore.getState().selectMission("m1");

      const state = useMissionsStore.getState();
      expect(mockGetFullMissionView).toHaveBeenCalledWith({ missionId: "m1" });
      expect(state.selectedMissionId).toBe("m1");
      expect(state.selectedMission).toEqual(mission);
      expect(state.runGraph).toEqual(runGraph);
      expect(state.orchestratorArtifacts).toEqual(artifacts);
      expect(state.workerCheckpoints).toEqual(checkpoints);
      expect(state.dashboard).toEqual(dashboard);
      expect(state.originalStepCount).toBe(1);
      expect(state.error).toBeNull();
    });

    it("clears selection when called with null", async () => {
      useMissionsStore.setState({
        selectedMission: { id: "m1" } as any,
        runGraph: { run: { id: "r1" } } as any,
        orchestratorArtifacts: [{ id: "a1" }] as any[],
      });

      await useMissionsStore.getState().selectMission(null);

      const state = useMissionsStore.getState();
      expect(state.selectedMissionId).toBeNull();
      expect(state.selectedMission).toBeNull();
      expect(state.runGraph).toBeNull();
      expect(state.orchestratorArtifacts).toEqual([]);
      expect(mockGetFullMissionView).not.toHaveBeenCalled();
    });

    it("sets error on failure without crashing", async () => {
      mockGetFullMissionView.mockRejectedValueOnce(new Error("IPC error"));

      await useMissionsStore.getState().selectMission("m1");

      expect(useMissionsStore.getState().error).toBe("IPC error");
      expect(useMissionsStore.getState().selectedMissionId).toBe("m1");
    });

    it("resets transient state on new selection", async () => {
      useMissionsStore.setState({
        chatJumpTarget: { kind: "coordinator", runId: "r1" } as any,
        logsFocusInterventionId: "intv-1",
        coordinatorPromptInspector: { sections: [] } as any,
      });
      mockGetFullMissionView.mockResolvedValueOnce({
        mission: null,
        runGraph: null,
        artifacts: [],
        checkpoints: [],
        dashboard: null,
      });

      await useMissionsStore.getState().selectMission("m2");

      const state = useMissionsStore.getState();
      expect(state.chatJumpTarget).toBeNull();
      expect(state.logsFocusInterventionId).toBeNull();
      expect(state.coordinatorPromptInspector).toBeNull();
    });
  });

  describe("initEventSubscriptions (VAL-ARCH-007)", () => {
    it("subscribes to mission and orchestrator events", () => {
      const cleanup = useMissionsStore.getState().initEventSubscriptions();

      expect(mockMissionsOnEvent).toHaveBeenCalledTimes(1);
      expect(mockOrchestratorOnEvent).toHaveBeenCalledTimes(1);

      // Cleanup should call the unsub fns
      cleanup();
    });

    it("returns a cleanup function that unsubscribes", () => {
      const unsubMissions = vi.fn();
      const unsubOrchestrator = vi.fn();
      mockMissionsOnEvent.mockReturnValueOnce(unsubMissions);
      mockOrchestratorOnEvent.mockReturnValueOnce(unsubOrchestrator);

      const cleanup = useMissionsStore.getState().initEventSubscriptions();
      cleanup();

      expect(unsubMissions).toHaveBeenCalledTimes(1);
      expect(unsubOrchestrator).toHaveBeenCalledTimes(1);
    });
  });
});
