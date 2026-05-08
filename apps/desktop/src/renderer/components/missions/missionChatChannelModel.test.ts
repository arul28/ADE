import { describe, expect, it } from "vitest";
import type { OrchestratorWorkerState } from "../../../shared/types";
import { isLiveMissionWorkerState, resolveWorkerThreadChannelStatus } from "./missionChatChannelModel";

function workerState(state: OrchestratorWorkerState["state"]): OrchestratorWorkerState {
  return {
    attemptId: "attempt-1",
    stepId: "step-1",
    runId: "run-1",
    sessionId: "session-1",
    executorKind: "codex",
    state,
    lastHeartbeatAt: "2026-05-08T00:00:00.000Z",
    spawnedAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
    outcomeTags: [],
  };
}

describe("mission chat channel model", () => {
  it("treats only live worker states as live", () => {
    expect(isLiveMissionWorkerState("spawned")).toBe(true);
    expect(isLiveMissionWorkerState("initializing")).toBe(true);
    expect(isLiveMissionWorkerState("working")).toBe(true);
    expect(isLiveMissionWorkerState("waiting_input")).toBe(true);
    expect(isLiveMissionWorkerState("completed")).toBe(false);
    expect(isLiveMissionWorkerState("failed")).toBe(false);
    expect(isLiveMissionWorkerState("disposed")).toBe(false);
  });

  it("does not keep stale retry attempts in the active worker list without live state", () => {
    expect(resolveWorkerThreadChannelStatus({
      threadStatus: "active",
      workerState: undefined,
      runStatus: "active",
    })).toBe("closed");
  });

  it("keeps an active thread active when the worker state is live", () => {
    expect(resolveWorkerThreadChannelStatus({
      threadStatus: "active",
      workerState: workerState("working"),
      runStatus: "active",
    })).toBe("active");
  });
});
