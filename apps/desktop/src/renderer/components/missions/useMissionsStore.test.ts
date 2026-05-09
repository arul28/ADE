/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialMissionsState, useMissionsStore } from "./useMissionsStore";
import type { MissionDashboardSnapshot, MissionSummary } from "../../../shared/types";

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
});
