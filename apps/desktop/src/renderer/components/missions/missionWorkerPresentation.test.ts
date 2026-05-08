import { describe, expect, it } from "vitest";
import type { MissionRunViewWorkerSummary } from "../../../shared/types";
import {
  selectCurrentMissionWorkers,
  sortMissionWorkers,
} from "./missionWorkerPresentation";

function makeWorker(
  overrides: Partial<MissionRunViewWorkerSummary> = {},
): MissionRunViewWorkerSummary {
  return {
    attemptId: "attempt-1",
    stepId: "step-1",
    stepKey: "implement-feature",
    stepTitle: "Implement feature",
    laneId: "lane-1",
    sessionId: "session-1",
    executorKind: "agent",
    state: "working",
    status: "active",
    lastHeartbeatAt: "2026-05-07T10:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("selectCurrentMissionWorkers", () => {
  it("collapses retry attempts to the current worker for each step", () => {
    const current = makeWorker({
      attemptId: "attempt-current",
      sessionId: "session-current",
      status: "active",
      state: "working",
      lastHeartbeatAt: "2026-05-07T10:03:00.000Z",
    });
    const oldFailed = makeWorker({
      attemptId: "attempt-old",
      sessionId: "session-old",
      status: "failed",
      state: "failed",
      completedAt: "2026-05-07T10:04:00.000Z",
      lastHeartbeatAt: null,
    });
    const otherStep = makeWorker({
      attemptId: "attempt-other",
      stepId: "step-2",
      stepKey: "test-feature",
      stepTitle: "Test feature",
      status: "completed",
      state: "completed",
      completedAt: "2026-05-07T10:02:00.000Z",
    });

    expect(selectCurrentMissionWorkers([oldFailed, current, otherStep])).toEqual([current, otherStep]);
  });

  it("keeps the newest failed attempt when a step has no active retry", () => {
    const olderFailed = makeWorker({
      attemptId: "attempt-older",
      status: "failed",
      state: "failed",
      completedAt: "2026-05-07T10:01:00.000Z",
    });
    const latestFailed = makeWorker({
      attemptId: "attempt-latest",
      status: "failed",
      state: "failed",
      completedAt: "2026-05-07T10:02:00.000Z",
    });

    expect(selectCurrentMissionWorkers([olderFailed, latestFailed])).toEqual([latestFailed]);
  });
});

describe("sortMissionWorkers", () => {
  it("orders actionable workers before completed and failed workers", () => {
    const failed = makeWorker({
      attemptId: "failed",
      stepId: "failed-step",
      stepTitle: "Failed",
      status: "failed",
      state: "failed",
      completedAt: "2026-05-07T10:05:00.000Z",
    });
    const active = makeWorker({
      attemptId: "active",
      stepId: "active-step",
      stepTitle: "Active",
      status: "active",
      state: "working",
    });
    const completed = makeWorker({
      attemptId: "completed",
      stepId: "completed-step",
      stepTitle: "Completed",
      status: "completed",
      state: "completed",
      completedAt: "2026-05-07T10:06:00.000Z",
    });

    expect(sortMissionWorkers([failed, completed, active]).map((worker) => worker.attemptId)).toEqual([
      "active",
      "completed",
      "failed",
    ]);
  });
});
