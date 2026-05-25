import { describe, expect, it } from "vitest";
import { failedStepInterventionsMatch } from "./failedStepInterventionMatching";

describe("failedStepInterventionsMatch", () => {
  it("matches worker and terminal-sync metadata for the same failed step", () => {
    const workerMetadata = {
      runId: "run-1",
      stepId: "orchestrator-step-1",
      stepKey: "implement-api",
      reasonCode: "retry_exhausted",
    };
    expect(
      failedStepInterventionsMatch(workerMetadata, {
        missionStepId: "mission-step-1",
        orchestratorStepId: "orchestrator-step-1",
        stepKey: "implement-api",
        runId: "run-1",
      }),
    ).toBe(true);
  });

  it("matches mission-step ids from terminal sync", () => {
    expect(
      failedStepInterventionsMatch(
        { stepId: "mission-step-1", stepKey: "implement-api", runId: "run-1" },
        { missionStepId: "mission-step-1", orchestratorStepId: "orchestrator-step-1", runId: "run-1" },
      ),
    ).toBe(true);
  });

  it("does not match different failed steps", () => {
    expect(
      failedStepInterventionsMatch(
        { stepId: "mission-step-1", stepKey: "first-step", runId: "run-1" },
        { missionStepId: "mission-step-2", stepKey: "second-step", runId: "run-1" },
      ),
    ).toBe(false);
  });

  it("does not match the same step key across different runs", () => {
    expect(
      failedStepInterventionsMatch(
        { stepKey: "implement-api", runId: "run-1" },
        { stepKey: "implement-api", runId: "run-2" },
      ),
    ).toBe(false);
  });
});
