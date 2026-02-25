import { describe, expect, it } from "vitest";
import type { OrchestratorAttempt, OrchestratorClaim, OrchestratorChatMessage, OrchestratorChatTarget, OrchestratorChatThread, OrchestratorStep } from "../../../shared/types";
import { collapsePlannerStreamMessages, resolveMissionChatSelection, resolveStepHeartbeatAt } from "./MissionsPage";

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

function makeMessage(overrides: Partial<OrchestratorChatMessage> = {}): OrchestratorChatMessage {
  return {
    id: "msg-1",
    missionId: "mission-1",
    role: "worker",
    content: "hello",
    timestamp: "2026-02-21T00:00:00.000Z",
    stepKey: "planner",
    threadId: "planner:mission-1",
    target: null,
    visibility: "full",
    deliveryState: "delivered",
    sourceSessionId: "planner-session-1",
    attemptId: null,
    laneId: "lane-1",
    runId: "run-1",
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

  it("falls back to step/run matches when attempt metadata is stale", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:auth",
        threadType: "worker",
        title: "Worker step-auth",
        runId: "run-1",
        stepKey: "step-auth",
        attemptId: "attempt-current",
        sessionId: "session-current"
      })
    ];
    const jumpTarget: OrchestratorChatTarget = {
      kind: "worker",
      runId: "run-1",
      stepKey: "step-auth",
      attemptId: "attempt-stale",
      sessionId: "session-stale"
    };

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "mission:mission-1",
      jumpTarget
    });

    expect(selected).toBe("worker:auth");
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

  it("keeps worker intent by picking a run-scoped worker when target metadata is stale", () => {
    const threads = [
      makeThread(),
      makeThread({
        id: "worker:older",
        threadType: "worker",
        title: "Older worker",
        runId: "run-2",
        stepKey: "step-a",
        attemptId: "attempt-a",
        updatedAt: "2026-02-21T00:01:00.000Z"
      }),
      makeThread({
        id: "worker:newer",
        threadType: "worker",
        title: "Newer worker",
        runId: "run-2",
        stepKey: "step-b",
        attemptId: "attempt-b",
        updatedAt: "2026-02-21T00:02:00.000Z"
      })
    ];
    const jumpTarget: OrchestratorChatTarget = {
      kind: "worker",
      runId: "run-2",
      stepId: "step-stale",
      stepKey: "step-stale",
      attemptId: "attempt-stale",
      sessionId: "session-stale",
      laneId: "lane-stale"
    };

    const selected = resolveMissionChatSelection({
      threads,
      selectedThreadId: "worker:missing",
      jumpTarget
    });

    expect(selected).toBe("worker:newer");
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

describe("collapsePlannerStreamMessages", () => {
  it("collapses adjacent planner stream chunks into a single message", () => {
    const messages: OrchestratorChatMessage[] = [
      makeMessage({
        id: "planner-1",
        content: "Planning output part 1",
        metadata: { planner: { stream: true } }
      }),
      makeMessage({
        id: "planner-2",
        content: "Planning output part 2",
        timestamp: "2026-02-21T00:00:02.000Z",
        metadata: { planner: { stream: true } }
      })
    ];

    const collapsed = collapsePlannerStreamMessages(messages);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.content).toContain("part 1");
    expect(collapsed[0]?.content).toContain("part 2");
    expect(collapsed[0]?.timestamp).toBe("2026-02-21T00:00:02.000Z");
  });

  it("keeps non-stream worker and orchestrator messages separate", () => {
    const messages: OrchestratorChatMessage[] = [
      makeMessage({
        id: "planner-1",
        content: "Planning chunk",
        metadata: { planner: { stream: true } }
      }),
      makeMessage({
        id: "worker-1",
        stepKey: "step-auth",
        content: "Worker update",
        metadata: null
      }),
      makeMessage({
        id: "orch-1",
        role: "orchestrator",
        stepKey: null,
        content: "Coordinator update",
        metadata: null
      })
    ];

    const collapsed = collapsePlannerStreamMessages(messages);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]?.id).toBe("planner-1");
    expect(collapsed[1]?.id).toBe("worker-1");
    expect(collapsed[2]?.id).toBe("orch-1");
  });
});

describe("resolveStepHeartbeatAt — initializing and stale detection", () => {
  it("returns null for running step with no session (initializing state)", () => {
    // When a step is running but the attempt has no executorSessionId,
    // there should be no heartbeat claims and the function returns null.
    // The UI layer interprets null heartbeat + running status as "initializing".
    const step = makeStep({ status: "running" });
    const attempt = makeAttempt({
      id: "attempt-no-session",
      status: "running",
      executorSessionId: null
    });
    // No claims exist for this attempt
    const claims: OrchestratorClaim[] = [];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [attempt],
      claims
    });

    expect(heartbeatAt).toBeNull();
  });

  it("detects stale heartbeat when claim is older than 3 minutes", () => {
    // A running step whose latest claim heartbeat is more than 3 minutes
    // old should be flagged. The function returns the stale timestamp;
    // the UI layer compares it against "now" to show a warning.
    const step = makeStep({ status: "running" });
    const attempt = makeAttempt({
      id: "attempt-stale",
      status: "running",
      executorSessionId: "session-stale"
    });
    // Heartbeat from 5 minutes ago (well beyond the 3 minute threshold)
    const staleTime = "2026-02-21T00:00:00.000Z";
    const claims: OrchestratorClaim[] = [
      makeClaim({
        id: "claim-stale",
        attemptId: "attempt-stale",
        heartbeatAt: staleTime,
        expiresAt: "2026-02-21T00:03:00.000Z"
      })
    ];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [attempt],
      claims
    });

    // The heartbeat timestamp is returned — the caller determines staleness
    // by comparing against the current time.
    expect(heartbeatAt).toBe(staleTime);
    // Verify it IS stale: 3 minutes = 180000ms
    const elapsed = Date.parse("2026-02-21T00:05:00.000Z") - Date.parse(heartbeatAt!);
    expect(elapsed).toBeGreaterThan(180_000);
  });

  it("returns recent heartbeat for healthy running step", () => {
    const step = makeStep({ status: "running" });
    const attempt = makeAttempt({
      id: "attempt-healthy",
      status: "running",
      executorSessionId: "session-healthy"
    });
    // Heartbeat from just now
    const recentTime = "2026-02-21T00:04:59.000Z";
    const claims: OrchestratorClaim[] = [
      makeClaim({
        id: "claim-healthy",
        attemptId: "attempt-healthy",
        heartbeatAt: recentTime,
        expiresAt: "2026-02-21T00:08:00.000Z"
      })
    ];

    const heartbeatAt = resolveStepHeartbeatAt({
      step,
      attempts: [attempt],
      claims
    });

    expect(heartbeatAt).toBe(recentTime);
  });
});

describe("resolveMissionChatSelection — thread identity resolution", () => {
  it("distinguishes planner thread from worker thread and keeps selection stable", () => {
    const plannerThread = makeThread({
      id: "planner:mission-1",
      threadType: "mission",
      title: "Mission Coordinator",
      stepKey: null
    });
    const workerThread = makeThread({
      id: "worker:auth",
      threadType: "worker",
      title: "Worker step-auth",
      stepKey: "step-auth",
      attemptId: "attempt-auth",
      sessionId: "session-auth"
    });

    // When planner thread is selected, it stays selected
    const plannerSelected = resolveMissionChatSelection({
      threads: [plannerThread, workerThread],
      selectedThreadId: "planner:mission-1"
    });
    expect(plannerSelected).toBe("planner:mission-1");

    // When worker thread is selected, it stays selected
    const workerSelected = resolveMissionChatSelection({
      threads: [plannerThread, workerThread],
      selectedThreadId: "worker:auth"
    });
    expect(workerSelected).toBe("worker:auth");
  });

  it("falls back to mission thread when planner thread disappears", () => {
    const missionThread = makeThread({
      id: "mission:mission-1",
      threadType: "mission",
      title: "Mission Coordinator"
    });
    const workerThread = makeThread({
      id: "worker:impl",
      threadType: "worker",
      title: "Worker impl",
      stepKey: "step-impl"
    });

    // "planner:mission-1" no longer exists in the thread list
    const selected = resolveMissionChatSelection({
      threads: [missionThread, workerThread],
      selectedThreadId: "planner:mission-1"
    });

    // Should fall back to the mission thread
    expect(selected).toBe("mission:mission-1");
  });

  it("selects correct worker thread when multiple workers exist for different steps", () => {
    const missionThread = makeThread();
    const authWorker = makeThread({
      id: "worker:auth",
      threadType: "worker",
      title: "Worker auth",
      runId: "run-1",
      stepKey: "step-auth",
      attemptId: "attempt-auth",
      sessionId: "session-auth"
    });
    const dbWorker = makeThread({
      id: "worker:db",
      threadType: "worker",
      title: "Worker db",
      runId: "run-1",
      stepKey: "step-db",
      attemptId: "attempt-db",
      sessionId: "session-db"
    });

    // Jump to the db worker specifically
    const jumpTarget: OrchestratorChatTarget = {
      kind: "worker",
      runId: "run-1",
      stepKey: "step-db",
      attemptId: "attempt-db"
    };

    const selected = resolveMissionChatSelection({
      threads: [missionThread, authWorker, dbWorker],
      selectedThreadId: "worker:auth",
      jumpTarget
    });

    expect(selected).toBe("worker:db");
  });
});
