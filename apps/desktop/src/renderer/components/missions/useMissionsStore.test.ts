/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialMissionsState, useMissionsStore } from "./useMissionsStore";
import type { MissionDashboardSnapshot, MissionDetail, MissionIntervention, MissionSummary } from "../../../shared/types";

function makeMission(id: string, status: MissionSummary["status"]): MissionSummary {
  return {
    id,
    title: `Mission ${id}`,
    prompt: `Prompt ${id}`,
    status,
    priority: "normal",
    executionMode: "local",
    laneId: null,
    laneName: null,
    missionLaneId: null,
    missionLaneName: null,
    resultLaneId: null,
    resultLaneName: null,
    totalSteps: 0,
    completedSteps: 0,
    openInterventions: 0,
    artifactCount: 0,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    lastError: null,
    outcomeSummary: null,
    targetMachineId: null,
  };
}

function makeDashboard(): MissionDashboardSnapshot {
  return {
    active: [],
    recent: [],
    weekly: {
      missions: 1,
      successRate: 1,
      avgDurationMs: 120_000,
      totalCostUsd: 0,
    },
  };
}

function makeMissionDetail(id: string, status: MissionSummary["status"]): MissionDetail {
  return {
    ...makeMission(id, status),
    steps: [],
    events: [],
    artifacts: [],
    interventions: [],
  };
}

function makeManualInputIntervention(missionId: string): MissionIntervention {
  return {
    id: "intervention-1",
    missionId,
    interventionType: "manual_input",
    status: "open",
    resolutionKind: null,
    title: "Planner question ready",
    body: "Should this be documentation-only?",
    requestedAction: "Answer the planning question.",
    resolutionNote: null,
    laneId: null,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    resolvedAt: null,
    metadata: { reasonCode: "planner_natural_question" },
  };
}

describe("useMissionsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMissionsStore.setState({ ...initialMissionsState });
    window.ade = {
      missions: {
        list: vi.fn(async () => [makeMission("mission-1", "completed")]),
        getDashboard: vi.fn(async () => makeDashboard()),
      },
    } as any;
  });

  it("can refresh the mission list and dashboard together for manual refresh", async () => {
    await useMissionsStore.getState().refreshMissionList({
      preserveSelection: true,
      refreshDashboard: true,
    });

    expect(window.ade.missions.list).toHaveBeenCalledWith({ limit: 300 });
    expect(window.ade.missions.getDashboard).toHaveBeenCalledTimes(1);
    expect(useMissionsStore.getState().missions[0]?.status).toBe("completed");
    expect(useMissionsStore.getState().dashboard?.active).toEqual([]);
  });

  it("keeps dashboard refresh opt-in so initial list loading stays staged", async () => {
    await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });

    expect(window.ade.missions.list).toHaveBeenCalledWith({ limit: 300 });
    expect(window.ade.missions.getDashboard).not.toHaveBeenCalled();
  });

  it("refreshes the selected mission summary while preserving hydrated detail fields", async () => {
    useMissionsStore.setState({
      selectedMissionId: "mission-1",
      selectedMission: makeMissionDetail("mission-1", "in_progress"),
    });

    await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });

    const selected = useMissionsStore.getState().selectedMission;
    expect(selected?.status).toBe("completed");
    expect(selected?.completedAt).toBe(null);
    expect(selected?.interventions).toEqual([]);
  });

  it("rehydrates selected mission detail when open intervention counts diverge", async () => {
    const summaryWithIntervention = {
      ...makeMission("mission-1", "intervention_required"),
      openInterventions: 1,
    };
    const detailWithIntervention = {
      ...makeMissionDetail("mission-1", "intervention_required"),
      openInterventions: 1,
      interventions: [makeManualInputIntervention("mission-1")],
    };
    window.ade.missions.list = vi.fn(async () => [summaryWithIntervention]);
    window.ade.missions.getFullMissionView = vi.fn(async () => ({
      mission: detailWithIntervention,
      runGraph: null,
      artifacts: [],
      checkpoints: [],
      dashboard: null,
    }));
    useMissionsStore.setState({
      selectedMissionId: "mission-1",
      selectedMission: makeMissionDetail("mission-1", "planning"),
    });

    await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });

    expect(window.ade.missions.getFullMissionView).toHaveBeenCalledWith({ missionId: "mission-1" });
    expect(useMissionsStore.getState().selectedMission?.interventions).toHaveLength(1);
  });

  it("rehydrates selected mission detail when an open intervention changes without changing the count", async () => {
    const staleDetail = {
      ...makeMissionDetail("mission-1", "intervention_required"),
      openInterventions: 1,
      interventions: [makeManualInputIntervention("mission-1")],
    };
    const summaryWithNewerIntervention = {
      ...makeMission("mission-1", "intervention_required"),
      openInterventions: 1,
      updatedAt: "2026-05-07T00:01:00.000Z",
    };
    const phaseApprovalIntervention = {
      ...makeManualInputIntervention("mission-1"),
      id: "intervention-2",
      interventionType: "phase_approval" as const,
      title: "Approve transition from Planning phase",
      body: "Approve Planning output.",
      metadata: { source: "phase_approval_gate" },
      updatedAt: "2026-05-07T00:01:00.000Z",
    };
    const refreshedDetail = {
      ...makeMissionDetail("mission-1", "intervention_required"),
      openInterventions: 1,
      updatedAt: "2026-05-07T00:01:00.000Z",
      interventions: [phaseApprovalIntervention],
    };
    window.ade.missions.list = vi.fn(async () => [summaryWithNewerIntervention]);
    window.ade.missions.getFullMissionView = vi.fn(async () => ({
      mission: refreshedDetail,
      runGraph: null,
      artifacts: [],
      checkpoints: [],
      dashboard: null,
    }));
    useMissionsStore.setState({
      selectedMissionId: "mission-1",
      selectedMission: staleDetail,
    });

    await useMissionsStore.getState().refreshMissionList({ preserveSelection: true });

    expect(window.ade.missions.getFullMissionView).toHaveBeenCalledWith({ missionId: "mission-1" });
    expect(useMissionsStore.getState().selectedMission?.interventions[0]?.id).toBe("intervention-2");
  });

  it("hydrates Smart Budget mission settings from project config", async () => {
    window.ade.projectConfig = {
      get: vi.fn(async () => ({
        shared: {},
        local: {
          ai: {
            orchestrator: {
              smartBudget: {
                enabled: true,
                fiveHourThresholdUsd: 12,
                weeklyThresholdUsd: 90,
                modelDowngradeThresholdPct: 60,
              },
            },
          },
        },
        effective: { ai: { orchestrator: {} } },
      })),
    } as any;

    await useMissionsStore.getState().loadMissionSettings();

    expect(useMissionsStore.getState().missionSettingsDraft.smartBudget).toEqual({
      enabled: true,
      fiveHourThresholdUsd: 12,
      weeklyThresholdUsd: 90,
      modelDowngradeThresholdPct: 60,
    });
  });

  it("persists Smart Budget mission settings to local project config", async () => {
    const baseSnapshot = {
      shared: {},
      local: { ai: { orchestrator: {}, permissions: {} } },
      effective: { ai: { orchestrator: {}, permissions: {} } },
    };
    const save = vi.fn(async (candidate) => ({
      ...baseSnapshot,
      ...candidate,
      effective: candidate.local,
    }));
    window.ade.projectConfig = {
      get: vi.fn(async () => baseSnapshot),
      save,
    } as any;
    useMissionsStore.getState().setMissionSettingsDraft((draft) => ({
      ...draft,
      smartBudget: {
        enabled: true,
        fiveHourThresholdUsd: 18,
        weeklyThresholdUsd: 140,
        fiveHourHardStopPercent: 70,
      },
    }));

    await useMissionsStore.getState().saveMissionSettings();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      local: expect.objectContaining({
        ai: expect.objectContaining({
          orchestrator: expect.objectContaining({
            smartBudget: {
              enabled: true,
              fiveHourThresholdUsd: 18,
              weeklyThresholdUsd: 140,
              fiveHourHardStopPercent: 70,
            },
          }),
        }),
      }),
    }));
    expect(useMissionsStore.getState().missionSettingsNotice).toBe("Mission settings saved to .ade/local.yaml.");
  });
});
