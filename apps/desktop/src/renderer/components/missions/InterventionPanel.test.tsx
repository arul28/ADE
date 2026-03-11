// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterventionPanel } from "./InterventionPanel";
import { initialMissionsState, useMissionsStore } from "./useMissionsStore";

const mockSteerMission = vi.fn();

function makeIntervention(overrides: Record<string, unknown> = {}) {
  return {
    id: "intervention-1",
    missionId: "mission-1",
    interventionType: "policy_block",
    status: "open",
    title: "Mission launch failed",
    body: "ADE could not finish mission launch during mission memory initialization.",
    requestedAction: "Review the launch failure details, fix the runtime or configuration issue, then restart the mission run.",
    resolutionNote: null,
    laneId: null,
    createdAt: "2026-03-11T16:50:46.320Z",
    updatedAt: "2026-03-11T16:50:46.320Z",
    resolvedAt: null,
    metadata: null,
    ...overrides,
  };
}

describe("InterventionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMissionsStore.setState(initialMissionsState);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        orchestrator: {
          steerMission: mockSteerMission,
        },
      },
    });
    useMissionsStore.setState({
      refreshMissionList: vi.fn().mockResolvedValue(undefined),
      loadMissionDetail: vi.fn().mockResolvedValue(undefined),
      loadOrchestratorGraph: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it("prioritizes launch failures over coordinator noise and shows technical details", () => {
    useMissionsStore.setState({
      selectedMission: {
        id: "mission-1",
        interventions: [
          makeIntervention({
            id: "coordinator-open",
            interventionType: "failed_step",
            title: "Coordinator unavailable",
            body: "Coordinator agent is not available for this run.",
            requestedAction: "Resume after coordinator runtime is healthy, or restart the mission run.",
            updatedAt: "2026-03-11T16:50:49.963Z",
            metadata: {
              runId: "run-1",
              reasonCode: "coordinator_unavailable",
            },
          }),
          makeIntervention({
            id: "launch-root-cause",
            interventionType: "unrecoverable_error",
            metadata: {
              runId: "run-1",
              reasonCode: "mission_launch_failed",
              failureStage: "memory_init",
              failureStageLabel: "mission memory initialization",
              rootError: "Wrong API use : tried to bind a value of an unknown type (undefined).",
              rootErrorStack: "Error: Wrong API use",
              coordinatorState: "not_started",
            },
          }),
        ],
      } as any,
    });

    render(<InterventionPanel compact={false} />);

    expect(screen.getByText("Mission launch failed")).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByText(/Stage: mission memory initialization/)).toBeTruthy();
    expect(screen.getByText(/Error: Wrong API use : tried to bind a value of an unknown type \(undefined\)\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /view details/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy error/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /resolve/i })).toBeNull();
  });

  it("does not route non-manual interventions through steerMission", () => {
    useMissionsStore.setState({
      selectedMission: {
        id: "mission-1",
        interventions: [
          makeIntervention({
            id: "launch-root-cause",
            interventionType: "unrecoverable_error",
            metadata: {
              runId: "run-1",
              reasonCode: "mission_launch_failed",
              failureStage: "memory_init",
              rootError: "Mission memory boot failed.",
            },
          }),
        ],
      } as any,
    });

    render(<InterventionPanel compact={false} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));

    expect(mockSteerMission).not.toHaveBeenCalled();
    expect(useMissionsStore.getState().activeTab).toBe("history");
    expect(useMissionsStore.getState().logsFocusInterventionId).toBe("launch-root-cause");
  });

  it("keeps manual-input interventions on the steering flow", async () => {
    useMissionsStore.setState({
      selectedMission: {
        id: "mission-1",
        interventions: [
          makeIntervention({
            id: "manual-question",
            interventionType: "manual_input",
            title: "Need clarification",
            body: "Which sidebar section should host this tab?",
            requestedAction: "Reply with placement guidance.",
            metadata: {
              canProceedWithoutAnswer: false,
            },
          }),
        ],
      } as any,
    });

    render(<InterventionPanel compact={false} />);
    fireEvent.change(screen.getByPlaceholderText("Type your response..."), {
      target: { value: "Put it in the main navigation group." },
    });
    fireEvent.click(screen.getByRole("button", { name: /resolve/i }));

    await waitFor(() =>
      expect(mockSteerMission).toHaveBeenCalledWith({
        missionId: "mission-1",
        interventionId: "manual-question",
        directive: "Put it in the main navigation group.",
        priority: "instruction",
      })
    );
  });
});
