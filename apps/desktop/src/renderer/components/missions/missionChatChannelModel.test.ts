import { describe, expect, it } from "vitest";
import type { OrchestratorChatThread, OrchestratorWorkerState } from "../../../shared/types";
import {
  isLiveMissionWorkerState,
  resolveChatTargetChannelId,
  resolveWorkerThreadChannelStatus,
  shouldShowWorkerStreamingIndicator,
} from "./missionChatChannelModel";

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

function thread(overrides: Partial<OrchestratorChatThread>): OrchestratorChatThread {
  return {
    id: "thread-1",
    missionId: "mission-1",
    threadType: "worker",
    title: "Worker",
    runId: "run-1",
    stepId: "step-1",
    stepKey: "step-key",
    attemptId: "attempt-1",
    sessionId: "session-1",
    laneId: "lane-1",
    status: "active",
    unreadCount: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    metadata: null,
    ...overrides,
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

  it("resolves worker jump targets to hydrated thread channel ids", () => {
    expect(resolveChatTargetChannelId({
      target: { kind: "worker", attemptId: "attempt-1" },
      threads: [thread({ id: "worker-thread-1" })],
    })).toBe("thread:worker-thread-1");
  });

  it("prefers exact worker identifiers over broad lane matches", () => {
    expect(resolveChatTargetChannelId({
      target: {
        kind: "worker",
        stepId: "planning-step",
        stepKey: "planning-worker",
        laneId: "shared-lane",
      },
      threads: [
        thread({
          id: "testing-thread",
          title: "Testing worker",
          stepId: "testing-step",
          stepKey: "testing-worker",
          laneId: "shared-lane",
        }),
        thread({
          id: "planning-thread",
          title: "Planning worker",
          stepId: "planning-step",
          stepKey: "planning-worker",
          laneId: "shared-lane",
        }),
      ],
    })).toBe("thread:planning-thread");
  });

  it("does not use a shared lane fallback when a precise worker target misses", () => {
    expect(resolveChatTargetChannelId({
      target: {
        kind: "worker",
        stepId: "missing-step",
        laneId: "shared-lane",
      },
      threads: [
        thread({
          id: "testing-thread",
          stepId: "testing-step",
          laneId: "shared-lane",
        }),
      ],
    })).toBeNull();
  });

  it("waits for worker threads to hydrate before selecting a worker target", () => {
    expect(resolveChatTargetChannelId({
      target: { kind: "worker", attemptId: "attempt-1" },
      threads: [],
    })).toBeNull();
  });

  it("does not show a streaming indicator for closed worker history", () => {
    expect(shouldShowWorkerStreamingIndicator({
      channelKind: "worker",
      channelStatus: "closed",
      attemptId: "attempt-1",
      workerState: "working",
    })).toBe(false);
  });

  it("shows a streaming indicator only for active live worker threads", () => {
    expect(shouldShowWorkerStreamingIndicator({
      channelKind: "worker",
      channelStatus: "active",
      attemptId: "attempt-1",
      workerState: "working",
    })).toBe(true);
    expect(shouldShowWorkerStreamingIndicator({
      channelKind: "worker",
      channelStatus: "active",
      attemptId: "attempt-1",
      workerState: "completed",
    })).toBe(false);
  });
});
