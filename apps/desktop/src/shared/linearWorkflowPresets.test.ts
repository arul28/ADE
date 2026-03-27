import { describe, expect, it } from "vitest";
import type { LinearWorkflowTargetType } from "./types";
import {
  completionContractUsesPrGate,
  createDefaultLinearWorkflowConfig,
  createWorkflowPreset,
  defaultCompletionContract,
  defaultWorkflowName,
  deriveVisualPlan,
  rebuildWorkflowSteps,
  resolveWorkflowTargetWaitStatus,
  reviewReadyWhenForContract,
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

describe("defaultCompletionContract", () => {
  it("returns correct contracts for each target type", () => {
    expect(defaultCompletionContract("mission")).toBe("wait_for_runtime_success");
    expect(defaultCompletionContract("pr_resolution")).toBe("wait_for_pr_created");
    expect(defaultCompletionContract("employee_session")).toBe("wait_for_explicit_completion");
    expect(defaultCompletionContract("worker_run")).toBe("wait_for_explicit_completion");
    expect(defaultCompletionContract("review_gate")).toBe("complete_on_launch");
  });
});

describe("completionContractUsesPrGate", () => {
  it("returns true for PR-gated contracts", () => {
    expect(completionContractUsesPrGate("wait_for_pr_created")).toBe(true);
    expect(completionContractUsesPrGate("wait_for_review_ready")).toBe(true);
  });

  it("returns false for non-PR-gated contracts", () => {
    expect(completionContractUsesPrGate("complete_on_launch")).toBe(false);
    expect(completionContractUsesPrGate("wait_for_explicit_completion")).toBe(false);
    expect(completionContractUsesPrGate("wait_for_runtime_success")).toBe(false);
  });
});

describe("reviewReadyWhenForContract", () => {
  it("maps contracts to review readiness conditions", () => {
    expect(reviewReadyWhenForContract("wait_for_review_ready")).toBe("pr_ready");
    expect(reviewReadyWhenForContract("wait_for_pr_created")).toBe("pr_created");
    expect(reviewReadyWhenForContract("complete_on_launch")).toBe("work_complete");
    expect(reviewReadyWhenForContract("wait_for_explicit_completion")).toBe("work_complete");
    expect(reviewReadyWhenForContract("wait_for_runtime_success")).toBe("work_complete");
  });
});

describe("defaultWorkflowName", () => {
  it("returns human-readable names for each target type", () => {
    expect(defaultWorkflowName("employee_session")).toContain("employee");
    expect(defaultWorkflowName("mission")).toContain("Mission");
    expect(defaultWorkflowName("worker_run")).toContain("Worker");
    expect(defaultWorkflowName("pr_resolution")).toContain("PR");
    expect(defaultWorkflowName("review_gate")).toContain("review");
  });
});

describe("resolveWorkflowTargetWaitStatus", () => {
  it("returns undefined for non-wait_for_target_status steps", () => {
    const workflow = createWorkflowPreset("mission");
    const launchStep = workflow.steps.find((s) => s.type === "launch_target")!;
    expect(resolveWorkflowTargetWaitStatus(workflow, launchStep)).toBeUndefined();
  });

  it("returns undefined when no step is provided", () => {
    const workflow = createWorkflowPreset("mission");
    expect(resolveWorkflowTargetWaitStatus(workflow, undefined)).toBeUndefined();
  });

  it("returns runtime_completed for mission wait steps", () => {
    const workflow = createWorkflowPreset("mission");
    const waitStep = workflow.steps.find((s) => s.type === "wait_for_target_status")!;
    expect(resolveWorkflowTargetWaitStatus(workflow, waitStep)).toBe("runtime_completed");
  });

  it("returns explicit_completion for employee session wait steps", () => {
    const workflow = createWorkflowPreset("employee_session");
    const waitStep = workflow.steps.find((s) => s.type === "wait_for_target_status")!;
    expect(resolveWorkflowTargetWaitStatus(workflow, waitStep)).toBe("explicit_completion");
  });
});

describe("createWorkflowPreset", () => {
  const targetTypes: LinearWorkflowTargetType[] = [
    "employee_session",
    "worker_run",
    "mission",
    "pr_resolution",
    "review_gate",
  ];

  for (const targetType of targetTypes) {
    it(`creates a valid workflow for ${targetType}`, () => {
      const workflow = createWorkflowPreset(targetType);

      expect(workflow.id).toBeTruthy();
      expect(workflow.name).toBeTruthy();
      expect(workflow.enabled).toBe(true);
      expect(workflow.target.type).toBe(targetType);
      expect(workflow.steps.length).toBeGreaterThan(0);
      expect(workflow.steps[workflow.steps.length - 1]!.type).toBe("complete_issue");
      expect(workflow.retry?.maxAttempts).toBeGreaterThan(0);
      expect(workflow.concurrency?.maxActiveRuns).toBeGreaterThan(0);
    });
  }

  it("includes human review for review_gate workflows", () => {
    const workflow = createWorkflowPreset("review_gate");
    expect(workflow.humanReview?.required).toBe(true);
    expect(workflow.humanReview?.reviewers).toContain("cto");
    expect(workflow.steps.some((s) => s.type === "request_human_review")).toBe(true);
  });

  it("includes PR wait step for pr_resolution workflows", () => {
    const workflow = createWorkflowPreset("pr_resolution");
    expect(workflow.steps.some((s) => s.type === "wait_for_pr")).toBe(true);
    expect(workflow.target.prStrategy).toBeTruthy();
  });

  it("accepts custom options", () => {
    const workflow = createWorkflowPreset("mission", {
      id: "custom-id",
      name: "Custom Name",
      description: "Custom description",
      source: "repo",
      triggerLabels: ["custom-label"],
      triggerAssignees: ["custom-assignee"],
    });
    expect(workflow.id).toBe("custom-id");
    expect(workflow.name).toBe("Custom Name");
    expect(workflow.description).toBe("Custom description");
    expect(workflow.source).toBe("repo");
    expect(workflow.triggers.labels).toEqual(["custom-label"]);
    expect(workflow.triggers.assignees).toEqual(["custom-assignee"]);
  });
});

describe("createDefaultLinearWorkflowConfig", () => {
  it("creates a valid default config", () => {
    const config = createDefaultLinearWorkflowConfig();

    expect(config.version).toBe(1);
    expect(config.source).toBe("generated");
    expect(config.intake.activeStateTypes).toBeTruthy();
    expect(config.intake.terminalStateTypes).toBeTruthy();
    expect(config.settings.ctoLinearAssigneeName).toBe("CTO");
    expect(config.workflows).toHaveLength(1);
    expect(config.workflows[0]!.target.type).toBe("pr_resolution");
    expect(config.migration?.needsSave).toBe(true);
  });
});

describe("deriveVisualPlan", () => {
  it("detects supervisor mode from review step position", () => {
    const reviewGate = createWorkflowPreset("review_gate");
    const plan = deriveVisualPlan(reviewGate);
    // review_gate has review step after launch but before complete, so it's after_work
    expect(plan.supervisorMode).not.toBe("none");
  });

  it("extracts start state from set_linear_state step", () => {
    const workflow = createWorkflowPreset("employee_session");
    const plan = deriveVisualPlan(workflow);
    expect(plan.startState).toBe("in_progress");
  });

  it("detects notification status", () => {
    const workflow = createWorkflowPreset("employee_session");
    const plan = deriveVisualPlan(workflow);
    expect(plan.notificationEnabled).toBe(true);
  });

  it("returns no notification for review_gate", () => {
    const reviewGate = createWorkflowPreset("review_gate");
    const plan = deriveVisualPlan(reviewGate);
    expect(plan.notificationEnabled).toBe(false);
  });
});

describe("rebuildWorkflowSteps", () => {
  it("toggles notification on and off", () => {
    const workflow = createWorkflowPreset("employee_session");
    const withoutNotification = rebuildWorkflowSteps(workflow, { notificationEnabled: false });
    expect(withoutNotification.steps.some((s) => s.type === "emit_app_notification")).toBe(false);

    const withNotification = rebuildWorkflowSteps(withoutNotification, { notificationEnabled: true });
    expect(withNotification.steps.some((s) => s.type === "emit_app_notification")).toBe(true);
  });

  it("changes start state", () => {
    const workflow = createWorkflowPreset("employee_session");
    const rebuilt = rebuildWorkflowSteps(workflow, { startState: "blocked" });
    const stateStep = rebuilt.steps.find((s) => s.type === "set_linear_state");
    expect(stateStep?.state).toBe("blocked");
  });

  it("changes supervisor mode", () => {
    const workflow = createWorkflowPreset("employee_session");
    const withReview = rebuildWorkflowSteps(workflow, { supervisorMode: "after_work" });
    expect(withReview.steps.some((s) => s.type === "request_human_review")).toBe(true);
    expect(withReview.humanReview?.required).toBe(true);

    const withoutReview = rebuildWorkflowSteps(withReview, { supervisorMode: "none" });
    expect(withoutReview.steps.some((s) => s.type === "request_human_review")).toBe(false);
  });

  it("always ends with complete_issue step", () => {
    const targetTypes: LinearWorkflowTargetType[] = ["employee_session", "mission", "worker_run", "pr_resolution", "review_gate"];
    for (const targetType of targetTypes) {
      const workflow = createWorkflowPreset(targetType);
      const rebuilt = rebuildWorkflowSteps(workflow, {});
      const lastStep = rebuilt.steps[rebuilt.steps.length - 1];
      expect(lastStep?.type, `${targetType} should end with complete_issue`).toBe("complete_issue");
    }
  });
});
