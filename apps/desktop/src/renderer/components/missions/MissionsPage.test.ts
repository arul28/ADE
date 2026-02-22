import { describe, expect, it } from "vitest";
import type { OrchestratorAttempt, OrchestratorClaim, OrchestratorChatTarget, OrchestratorChatThread, OrchestratorStep } from "../../../shared/types";
import { resolveMissionChatSelection, resolveStepHeartbeatAt } from "./MissionsPage";

function makeStep(overrides: Partial<OrchestratorStep> = {}): OrchestratorStep {
  return {
    id: "step-1",
    runId: "run-1",
    missionStepId: null,
    stepKey: "step-key-1",
    stepIndex: 0,
    title: "Step 1",
    laneId: "lane-1",
    status: "running",
    joinPolicy: "all_success",
    quorumCount: null,
    dependencyStepIds: [],
    retryLimit: 1,
    retryCount: 0,
    lastAttemptId: null,
    createdAt: "2026-02-21T00:00:00.000Z",
    updatedAt: "2026-02-21T00:00:00.000Z",
    startedAt: "2026-02-21T00:00:00.000Z",
    completedAt: null,
    metadata: null,
    ...overrides
  };
}

function makeAttempt(overrides: Partial<OrchestratorAttempt> = {}): OrchestratorAttempt {
  return {
    id: "attempt-1",
    runId: "run-1",
    stepId: "step-1",
    attemptNumber: 1,
    status: "running",
    executorKind: "codex",
    executorSessionId: "session-1",
    trackedSessionEnforced: true,
    contextProfile: "orchestrator_deterministic_v1",
    contextSnapshotId: null,
    errorClass: "none",
    errorMessage: null,
    retryBackoffMs: 0,
    createdAt: "2026-02-21T00:00:00.000Z",
    startedAt: "2026-02-21T00:00:00.000Z",
    completedAt: null,
    resultEnvelope: null,
    metadata: null,
    ...overrides
  };
}

function makeClaim(overrides: Partial<OrchestratorClaim> = {}): OrchestratorClaim {
  return {
    id: "claim-1",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    ownerId: "owner-1",
    scopeKind: "lane",
    scopeValue: "lane:lane-1",
    state: "active",
    acquiredAt: "2026-02-21T00:00:00.000Z",
    heartbeatAt: "2026-02-21T00:01:00.000Z",
    expiresAt: "2026-02-21T00:03:00.000Z",
    releasedAt: null,
    policy: null,
    metadata: null,
    ...overrides
  };
}

function makeThread(overrides: Partial<OrchestratorChatThread> = {}): OrchestratorChatThread {
  return {
    id: "mission:mission-1",
    missionId: "mission-1",
    threadType: "mission",
    title: "Mission Coordinator",
    runId: "run-1",
    stepId: null,
    stepKey: null,
    attemptId: null,
    sessionId: null,
    laneId: "lane-1",
    status: "active",
    unreadCount: 0,
    createdAt: "2026-02-21T00:00:00.000Z",
    updatedAt: "2026-02-21T00:00:00.000Z",
    metadata: null,
    ...overrides
  };
}

describe("resolveStepHeartbeatAt", () => {
  it("prefers heartbeat from the latest attempt when present", () => {
    const step = makeStep();
    const latestAttempt = makeAttempt({ id: "attempt-latest", attemptNumber: 2 });
    const previousAttempt = makeAttempt({ id: "attempt-prev", attemptNumber: 1 });
    const claims: OrchestratorClaim[] = [
      makeClaim({ id: "claim-prev", attemptId: "attempt-prev", heartbeatAt: "2026-02-21T00:09:00.000Z" }),
      makeClaim({ id: "claim-latest", attemptId: "attempt-latest", heartbeatAt: "2026-02-21T00:05:00.000Z" })
    ];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [latestAttempt, previousAttempt],
      claims
    });

    expect(heartbeatAt).toBe("2026-02-21T00:05:00.000Z");
  });

  it("falls back to a step-scoped heartbeat when attempt-scoped claims are missing", () => {
    const step = makeStep();
    const attempt = makeAttempt({ id: "attempt-2" });
    const claims: OrchestratorClaim[] = [
      makeClaim({
        id: "claim-step-only",
        attemptId: null,
        stepId: "step-1",
        heartbeatAt: "2026-02-21T00:04:00.000Z"
      })
    ];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [attempt],
      claims
    });

    expect(heartbeatAt).toBe("2026-02-21T00:04:00.000Z");
  });

  it("returns null when no matching claim heartbeat exists", () => {
    const step = makeStep();
    const attempt = makeAttempt({ id: "attempt-3" });
    const claims: OrchestratorClaim[] = [
      makeClaim({ id: "claim-other-step", stepId: "step-2", attemptId: "attempt-9" })
    ];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [attempt],
      claims
    });

    expect(heartbeatAt).toBeNull();
  });
});

describe("resolveMissionChatSelection", () => {
  it("keeps the selected thread when it still exists", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:1",
        threadType: "worker",
        title: "Worker step-auth",
        stepKey: "step-auth",
        attemptId: "attempt-auth"
      })
    ];

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "worker:1"
    });

    expect(selected).toBe("worker:1");
  });

  it("jumps to the matching worker thread when given a worker target", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:auth",
        threadType: "worker",
        title: "Worker step-auth",
        stepKey: "step-auth",
        attemptId: "attempt-auth",
        sessionId: "session-auth"
      }),
      makeThread({
        id: "worker:billing",
        threadType: "worker",
        title: "Worker step-billing",
        stepKey: "step-billing",
        attemptId: "attempt-billing",
        sessionId: "session-billing"
      })
    ];
    const jumpTarget: OrchestratorChatTarget = {
      kind: "worker",
      stepKey: "step-billing",
      attemptId: "attempt-billing"
    };

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "mission:mission-1",
      jumpTarget
    });

    expect(selected).toBe("worker:billing");
  });

  it("does not jump to a worker thread from a different run", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:run-1",
        threadType: "worker",
        title: "Worker run 1",
        runId: "run-1",
        stepKey: "step-shared",
        attemptId: "attempt-run-1"
      }),
      makeThread({
        id: "worker:run-2",
        threadType: "worker",
        title: "Worker run 2",
        runId: "run-2",
        stepKey: "step-shared",
        attemptId: "attempt-run-2"
      })
    ];
    const jumpTarget: OrchestratorChatTarget = {
      kind: "worker",
      runId: "run-2",
      stepKey: "step-shared"
    };

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "worker:run-1",
      jumpTarget
    });

    expect(selected).toBe("worker:run-2");
  });

  it("ignores broadcast worker targets for direct thread jumps and keeps current selection", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:run-1",
        threadType: "worker",
        title: "Worker run 1",
        runId: "run-1",
        stepKey: "step-shared",
        attemptId: "attempt-run-1"
      })
    ];
    const jumpTarget: OrchestratorChatTarget = {
      kind: "workers",
      runId: "run-1"
    };

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "worker:run-1",
      jumpTarget
    });

    expect(selected).toBe("worker:run-1");
  });

  it("falls back to mission thread when selected thread no longer exists", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:1",
        threadType: "worker",
        title: "Worker one"
      })
    ];

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "worker:missing"
    });

    expect(selected).toBe("mission:mission-1");
  });
});
