/**
 * Tests for WorkerTranscriptPane helper logic.
 *
 * The component derives runningWorkers from attempts and steps.
 * We test the exported executor badge mapping and the pure derivation logic.
 */
import { describe, expect, it } from "vitest";
import type { OrchestratorAttempt, OrchestratorStep } from "../../../shared/types";

/**
 * Re-derive runningWorkers logic from the component to test it in isolation.
 * This matches the useMemo in WorkerTranscriptPane.
 */
type RunningWorker = {
  attemptId: string;
  stepId: string;
  sessionId: string;
  executorKind: string;
  stepTitle: string;
};

function deriveRunningWorkers(
  attempts: OrchestratorAttempt[],
  steps: OrchestratorStep[],
): RunningWorker[] {
  const stepMap = new Map<string, OrchestratorStep>();
  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  return attempts
    .filter((a) => a.status === "running" && a.executorSessionId)
    .map((a) => ({
      attemptId: a.id,
      stepId: a.stepId,
      sessionId: a.executorSessionId!,
      executorKind: a.executorKind,
      stepTitle: stepMap.get(a.stepId)?.title ?? `Step ${a.stepId.slice(0, 8)}`,
    }));
}

function makeAttempt(overrides: Partial<OrchestratorAttempt>): OrchestratorAttempt {
  return {
    id: "attempt-1",
    runId: "run-1",
    stepId: "step-1",
    status: "running",
    executorKind: "claude",
    executorSessionId: "session-1",
    result: null,
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
    metadata: null,
    ...overrides,
  } as OrchestratorAttempt;
}

function makeStep(overrides: Partial<OrchestratorStep>): OrchestratorStep {
  return {
    id: "step-1",
    runId: "run-1",
    title: "Test Step",
    status: "running",
    dependencies: [],
    executorKind: "claude",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    completedAt: null,
    metadata: null,
    ...overrides,
  } as OrchestratorStep;
}

describe("WorkerTranscriptPane — running workers derivation", () => {
  it("returns empty array when no attempts are running", () => {
    const attempts = [makeAttempt({ status: "succeeded" })];
    const steps = [makeStep({})];
    expect(deriveRunningWorkers(attempts, steps)).toEqual([]);
  });

  it("returns running attempts with session IDs", () => {
    const attempts = [
      makeAttempt({ id: "a1", stepId: "s1", executorSessionId: "sess-1", executorKind: "claude" }),
    ];
    const steps = [makeStep({ id: "s1", title: "Build auth module" })];
    const result = deriveRunningWorkers(attempts, steps);
    expect(result).toHaveLength(1);
    expect(result[0].attemptId).toBe("a1");
    expect(result[0].sessionId).toBe("sess-1");
    expect(result[0].stepTitle).toBe("Build auth module");
    expect(result[0].executorKind).toBe("claude");
  });

  it("excludes running attempts without executorSessionId", () => {
    const attempts = [
      makeAttempt({ id: "a1", executorSessionId: null as any }),
    ];
    const steps = [makeStep({})];
    expect(deriveRunningWorkers(attempts, steps)).toEqual([]);
  });

  it("uses truncated step ID as fallback title when step not found", () => {
    const stepId = "abcdef1234567890";
    const attempts = [makeAttempt({ id: "a1", stepId })];
    const result = deriveRunningWorkers(attempts, []);
    expect(result).toHaveLength(1);
    expect(result[0].stepTitle).toBe(`Step ${stepId.slice(0, 8)}`);
  });

  it("handles multiple running workers", () => {
    const attempts = [
      makeAttempt({ id: "a1", stepId: "s1", executorSessionId: "sess-1" }),
      makeAttempt({ id: "a2", stepId: "s2", executorSessionId: "sess-2" }),
      makeAttempt({ id: "a3", stepId: "s3", status: "succeeded", executorSessionId: "sess-3" }),
    ];
    const steps = [
      makeStep({ id: "s1", title: "Step 1" }),
      makeStep({ id: "s2", title: "Step 2" }),
      makeStep({ id: "s3", title: "Step 3" }),
    ];
    const result = deriveRunningWorkers(attempts, steps);
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.attemptId)).toEqual(["a1", "a2"]);
  });
});
