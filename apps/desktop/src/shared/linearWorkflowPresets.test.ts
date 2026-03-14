import { describe, expect, it } from "vitest";
import type { LinearWorkflowTargetType } from "./types";
import {
  createWorkflowPreset,
  defaultCompletionContract,
  deriveVisualPlan,
  rebuildWorkflowSteps,
} from "./linearWorkflowPresets";

describe("linearWorkflowPresets", () => {
  it("defaults delegated workflows to fresh dedicated lanes and explicit ADE completion", () => {
    const employeeWorkflow = createWorkflowPreset("employee_session");
    const workerWorkflow = createWorkflowPreset("worker_run");

    expect(employeeWorkflow.target.laneSelection).toBe("fresh_issue_lane");
    expect(employeeWorkflow.target.sessionReuse).toBe("fresh_session");
    expect(defaultCompletionContract("employee_session")).toBe("wait_for_explicit_completion");
    expect(employeeWorkflow.steps.find((step) => step.type === "wait_for_target_status")?.targetStatus).toBe("explicit_completion");

    expect(workerWorkflow.target.laneSelection).toBe("fresh_issue_lane");
    expect(defaultCompletionContract("worker_run")).toBe("wait_for_explicit_completion");
    expect(workerWorkflow.steps.find((step) => step.type === "wait_for_target_status")?.targetStatus).toBe("explicit_completion");
  });

  it("keeps generated workflows aligned with the visual editor round-trip", () => {
    const targetTypes: LinearWorkflowTargetType[] = [
      "employee_session",
      "worker_run",
      "mission",
      "pr_resolution",
      "review_gate",
    ];

    for (const targetType of targetTypes) {
      const preset = createWorkflowPreset(targetType);
      const plan = deriveVisualPlan(preset);
      const rebuilt = rebuildWorkflowSteps(preset, plan);

      expect(rebuilt.target).toEqual(preset.target);
      expect(rebuilt.steps).toEqual(preset.steps);
      expect(rebuilt.closeout?.reviewReadyWhen).toBe(preset.closeout?.reviewReadyWhen);
      expect(deriveVisualPlan(rebuilt)).toEqual(plan);
    }
  });
});
