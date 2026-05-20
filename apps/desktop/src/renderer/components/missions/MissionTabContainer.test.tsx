/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionDashboardSnapshot, MissionSummary } from "../../../shared/types";
import { ManageMissionDialog } from "./ManageMissionDialog";
import { MissionsHomeDashboard } from "./MissionsHomeDashboard";
import { MissionTabNavigation } from "./MissionTabContainer";
import { initialMissionsState, useMissionsStore } from "./useMissionsStore";

vi.mock("./MissionChatV2", () => ({
  MissionChatV2: () => null,
}));

function makeMission(id: string, status: MissionSummary["status"]): MissionSummary {
  return {
    id,
    title: `Mission ${id}`,
    prompt: `Prompt ${id}`,
    status,
    priority: "normal",
    executionMode: "local",
    laneId: null,
    laneName: "Primary",
    missionLaneId: null,
    missionLaneName: null,
    resultLaneId: null,
    resultLaneName: null,
    totalSteps: 0,
    completedSteps: 0,
    openInterventions: 0,
    artifactCount: 0,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
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
    recent: [
      { mission: makeMission("completed", "completed"), action: "rerun", durationMs: 12_000, costEstimateUsd: null },
      { mission: makeMission("failed", "failed"), action: "retry", durationMs: 15_000, costEstimateUsd: null },
    ],
    weekly: {
      missions: 2,
      successRate: 0.5,
      avgDurationMs: 13_500,
      totalCostUsd: 0,
    },
  };
}

describe("MissionTabNavigation", () => {
  beforeEach(() => {
    useMissionsStore.setState({ ...initialMissionsState, activeTab: "chat" });
  });

  it("exposes selected mission view state with tab semantics", () => {
    render(<MissionTabNavigation />);

    expect(screen.getByRole("tablist", { name: "Mission views" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Conversations" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));

    expect(useMissionsStore.getState().activeTab).toBe("plan");
    expect(screen.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Conversations" }).getAttribute("aria-selected")).toBe("false");
  });
});

describe("mission dashboard and management controls", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useMissionsStore.setState({ ...initialMissionsState });
    window.confirm = vi.fn(() => true);
    window.ade = {
      missions: {
        archive: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        getDashboard: vi.fn(async () => ({
          ...makeDashboard(),
          recent: [],
        })),
      },
      orchestrator: {
        listRuns: vi.fn(async () => []),
        cancelRun: vi.fn(async () => undefined),
        cleanupTeamResources: vi.fn(async () => ({
          laneIds: ["lane-1"],
          lanesArchived: ["lane-1"],
          laneErrors: [],
        })),
      },
    } as any;
  });

  it("labels recent mission actions as view because they only select the mission", () => {
    const onViewMission = vi.fn();

    render(
      <MissionsHomeDashboard
        snapshot={makeDashboard()}
        onNewMission={vi.fn()}
        onViewMission={onViewMission}
      />,
    );

    expect(screen.queryByRole("button", { name: "RERUN" })).toBeNull();
    expect(screen.queryByRole("button", { name: "RETRY" })).toBeNull();
    const viewButtons = screen.getAllByRole("button", { name: /^View mission / });
    expect(viewButtons).toHaveLength(2);

    fireEvent.click(viewButtons[1]!);

    expect(onViewMission).toHaveBeenCalledWith("failed");
  });

  it("asks before archiving and names lane cleanup when selected", () => {
    useMissionsStore.setState({
      manageMission: makeMission("mission-1", "completed"),
      manageMissionOpen: true,
    });
    window.confirm = vi.fn(() => false);

    render(<ManageMissionDialog />);

    fireEvent.click(screen.getByRole("checkbox", { name: /also archive lanes created by this mission/i }));
    fireEvent.click(screen.getByRole("button", { name: /archive mission/i }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("also archive lanes created by this mission"));
    expect(window.ade.orchestrator.cleanupTeamResources).not.toHaveBeenCalled();
    expect(window.ade.missions.archive).not.toHaveBeenCalled();
  });

  it("does not cancel a non-terminal mission when confirmation is rejected", () => {
    useMissionsStore.setState({
      manageMission: makeMission("mission-2", "in_progress"),
      manageMissionOpen: true,
    });
    window.confirm = vi.fn(() => false);

    render(<ManageMissionDialog />);

    fireEvent.click(screen.getByRole("button", { name: /cancel mission/i }));

    expect(window.confirm).toHaveBeenCalledWith("This will cancel the entire mission. Are you sure?");
    expect(window.ade.orchestrator.listRuns).not.toHaveBeenCalled();
    expect(window.ade.orchestrator.cancelRun).not.toHaveBeenCalled();
  });

  it("cancels the active run after confirmation", async () => {
    useMissionsStore.setState({
      manageMission: makeMission("mission-3", "in_progress"),
      manageMissionOpen: true,
    });
    (window.ade.orchestrator as any).listRuns = vi.fn(async () => [
      { id: "run-1", status: "active" },
    ]);

    render(<ManageMissionDialog />);

    fireEvent.click(screen.getByRole("button", { name: /cancel mission/i }));

    await waitFor(() => {
      expect(window.ade.orchestrator.cancelRun).toHaveBeenCalledWith({
        runId: "run-1",
        reason: "Canceled from Manage Mission dialog.",
      });
    });
  });
});
