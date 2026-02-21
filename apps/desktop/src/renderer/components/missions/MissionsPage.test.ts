import { describe, expect, it } from "vitest";
import type { OrchestratorAttempt, OrchestratorClaim, OrchestratorStep } from "../../../shared/types";
import { resolveStepHeartbeatAt } from "./MissionsPage";

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
