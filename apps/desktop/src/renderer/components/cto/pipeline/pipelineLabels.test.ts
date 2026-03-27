import { describe, expect, it } from "vitest";
import type { LinearWorkflowDefinition } from "../../../../shared/types/linearSync";
import {
  FIELD_LABELS,
  TARGET_TYPE_LABELS,
  RUN_MODE_LABELS,
  LANE_SELECTION_LABELS,
  SESSION_REUSE_LABELS,
  PR_TIMING_LABELS,
  PR_STRATEGY_KIND_LABELS,
  COMPLETION_CONTRACT_LABELS,
  SUPERVISOR_MODE_LABELS,
  REJECT_ACTION_LABELS,
  WORKER_SELECTOR_MODE_LABELS,
  EXECUTOR_KIND_LABELS,
  ARTIFACT_MODE_LABELS,
  REVIEW_READY_WHEN_LABELS,
  NOTIFY_ON_LABELS,
  STEP_TYPE_LABELS,
  ISSUE_STATE_LABELS,
  STAGE_COLORS,
  PRESET_TEMPLATE_DESCRIPTIONS,
  enumLabel,
  enumDescription,
  fieldLabel,
  fieldDescription,
  generateWorkflowSummary,
} from "./pipelineLabels";

/* ── Helpers ── */

function makeWorkflow(overrides: Partial<LinearWorkflowDefinition> = {}): LinearWorkflowDefinition {
  return {
    id: "wf-1",
    name: "Test Workflow",
    enabled: true,
    priority: 100,
    source: "generated",
    triggers: {
      assignees: [],
      labels: [],
      projectSlugs: [],
      teamKeys: [],
      priority: [],
      stateTransitions: [],
      owner: [],
      creator: [],
      metadataTags: [],
    },
    target: {
      type: "worker_run",
      runMode: "autopilot",
      laneSelection: "fresh_issue_lane",
    },
    steps: [],
    ...overrides,
  };
}

/* ── Label constants ── */

describe("label constants", () => {
  it("TARGET_TYPE_LABELS covers all target types", () => {
    const expectedTypes = ["employee_session", "worker_run", "mission", "pr_resolution", "review_gate"];
    for (const type of expectedTypes) {
      expect(TARGET_TYPE_LABELS[type], `missing label for target type: ${type}`).toBeDefined();
      expect(TARGET_TYPE_LABELS[type].displayName).toBeTruthy();
    }
  });

  it("RUN_MODE_LABELS covers all run modes", () => {
    const modes = ["autopilot", "assisted", "manual"];
    for (const mode of modes) {
      expect(RUN_MODE_LABELS[mode], `missing label for run mode: ${mode}`).toBeDefined();
      expect(RUN_MODE_LABELS[mode].displayName).toBeTruthy();
    }
  });

  it("LANE_SELECTION_LABELS covers all lane options", () => {
    const selections = ["primary", "fresh_issue_lane", "operator_prompt"];
    for (const sel of selections) {
      expect(LANE_SELECTION_LABELS[sel], `missing label for lane selection: ${sel}`).toBeDefined();
    }
  });

  it("SESSION_REUSE_LABELS covers session options", () => {
    expect(SESSION_REUSE_LABELS.reuse_existing.displayName).toBeTruthy();
    expect(SESSION_REUSE_LABELS.fresh_session.displayName).toBeTruthy();
  });

  it("PR_TIMING_LABELS covers all timing options", () => {
    const timings = ["none", "after_start", "after_target_complete"];
    for (const timing of timings) {
      expect(PR_TIMING_LABELS[timing]).toBeDefined();
    }
  });

  it("PR_STRATEGY_KIND_LABELS covers all PR strategy kinds", () => {
    const kinds = ["per-lane", "integration", "queue", "manual"];
    for (const kind of kinds) {
      expect(PR_STRATEGY_KIND_LABELS[kind]).toBeDefined();
    }
  });

  it("STAGE_COLORS maps all target types to hex colors", () => {
    const types = ["employee_session", "worker_run", "mission", "pr_resolution", "review_gate"];
    for (const type of types) {
      expect(STAGE_COLORS[type], `missing color for: ${type}`).toBeTruthy();
      expect(STAGE_COLORS[type]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("PRESET_TEMPLATE_DESCRIPTIONS covers all target types", () => {
    const types = ["employee_session", "mission", "worker_run", "pr_resolution", "review_gate"];
    for (const type of types) {
      expect(PRESET_TEMPLATE_DESCRIPTIONS[type], `missing description for: ${type}`).toBeTruthy();
    }
  });

  it("FIELD_LABELS has entries for trigger fields", () => {
    const triggerFields = [
      "triggers.assignees",
      "triggers.labels",
      "triggers.projectSlugs",
      "triggers.teamKeys",
      "triggers.priority",
      "triggers.stateTransitions",
    ];
    for (const field of triggerFields) {
      expect(FIELD_LABELS[field], `missing label for: ${field}`).toBeDefined();
      expect(FIELD_LABELS[field].displayName).toBeTruthy();
      expect(FIELD_LABELS[field].description).toBeTruthy();
      expect(["essential", "advanced", "expert", "hidden"]).toContain(FIELD_LABELS[field].tier);
    }
  });

  it("STEP_TYPE_LABELS covers all step types", () => {
    const stepTypes = [
      "set_linear_state",
      "comment_linear",
      "set_linear_assignee",
      "apply_linear_label",
      "launch_target",
      "wait_for_target_status",
      "wait_for_pr",
      "request_human_review",
      "emit_app_notification",
      "complete_issue",
      "attach_artifacts",
      "reopen_issue",
    ];
    for (const type of stepTypes) {
      expect(STEP_TYPE_LABELS[type], `missing label for step: ${type}`).toBeDefined();
      expect(STEP_TYPE_LABELS[type].displayName).toBeTruthy();
    }
  });

  it("ISSUE_STATE_LABELS covers common states", () => {
    const states = ["todo", "in_progress", "in_review", "done", "canceled", "blocked"];
    for (const state of states) {
      expect(ISSUE_STATE_LABELS[state], `missing label for state: ${state}`).toBeDefined();
      expect(ISSUE_STATE_LABELS[state].displayName).toBeTruthy();
    }
  });

  it("COMPLETION_CONTRACT_LABELS covers all contract types", () => {
    const contracts = [
      "complete_on_launch",
      "wait_for_explicit_completion",
      "wait_for_runtime_success",
      "wait_for_pr_created",
      "wait_for_review_ready",
    ];
    for (const c of contracts) {
      expect(COMPLETION_CONTRACT_LABELS[c]).toBeDefined();
    }
  });

  it("SUPERVISOR_MODE_LABELS covers all modes", () => {
    const modes = ["none", "after_work", "before_pr", "after_pr"];
    for (const mode of modes) {
      expect(SUPERVISOR_MODE_LABELS[mode]).toBeDefined();
    }
  });

  it("REJECT_ACTION_LABELS covers all actions", () => {
    const actions = ["loop_back", "reopen_issue", "cancel"];
    for (const action of actions) {
      expect(REJECT_ACTION_LABELS[action]).toBeDefined();
    }
  });

  it("WORKER_SELECTOR_MODE_LABELS covers all modes", () => {
    const modes = ["none", "slug", "id", "capability"];
    for (const mode of modes) {
      expect(WORKER_SELECTOR_MODE_LABELS[mode]).toBeDefined();
    }
  });

  it("EXECUTOR_KIND_LABELS covers all executor kinds", () => {
    expect(EXECUTOR_KIND_LABELS.cto.displayName).toBe("CTO Agent");
    expect(EXECUTOR_KIND_LABELS.employee.displayName).toBe("Named Agent");
    expect(EXECUTOR_KIND_LABELS.worker.displayName).toBe("Background Worker");
  });

  it("ARTIFACT_MODE_LABELS covers all modes", () => {
    expect(ARTIFACT_MODE_LABELS.links.displayName).toBeTruthy();
    expect(ARTIFACT_MODE_LABELS.attachments.displayName).toBeTruthy();
  });

  it("REVIEW_READY_WHEN_LABELS covers all options", () => {
    const options = ["work_complete", "pr_created", "pr_ready"];
    for (const opt of options) {
      expect(REVIEW_READY_WHEN_LABELS[opt]).toBeDefined();
    }
  });

  it("NOTIFY_ON_LABELS covers all notification events", () => {
    const events = ["delegated", "pr_linked", "review_ready", "completed", "failed"];
    for (const event of events) {
      expect(NOTIFY_ON_LABELS[event]).toBeDefined();
    }
  });
});

/* ── enumLabel ── */

describe("enumLabel", () => {
  it("returns the display name for a known value", () => {
    expect(enumLabel(TARGET_TYPE_LABELS, "worker_run")).toBe("Background Worker");
  });

  it("returns the raw value for an unknown key", () => {
    expect(enumLabel(TARGET_TYPE_LABELS, "unknown_type")).toBe("unknown_type");
  });

  it("returns empty string for null or undefined", () => {
    expect(enumLabel(TARGET_TYPE_LABELS, null)).toBe("");
    expect(enumLabel(TARGET_TYPE_LABELS, undefined)).toBe("");
  });
});

/* ── enumDescription ── */

describe("enumDescription", () => {
  it("returns the description for a known value", () => {
    const desc = enumDescription(TARGET_TYPE_LABELS, "worker_run");
    expect(desc).toBeTruthy();
    expect(desc).toContain("worker");
  });

  it("returns empty string for unknown key", () => {
    expect(enumDescription(TARGET_TYPE_LABELS, "nope")).toBe("");
  });

  it("returns empty string for null or undefined", () => {
    expect(enumDescription(TARGET_TYPE_LABELS, null)).toBe("");
    expect(enumDescription(TARGET_TYPE_LABELS, undefined)).toBe("");
  });
});

/* ── fieldLabel ── */

describe("fieldLabel", () => {
  it("returns the display name for a known field path", () => {
    expect(fieldLabel("name")).toBe("Workflow Name");
    expect(fieldLabel("triggers.labels")).toBe("Issue Labels");
    expect(fieldLabel("target.type")).toBe("Action Type");
  });

  it("returns the raw path for an unknown field", () => {
    expect(fieldLabel("unknown.path")).toBe("unknown.path");
  });
});

/* ── fieldDescription ── */

describe("fieldDescription", () => {
  it("returns the description for a known field path", () => {
    expect(fieldDescription("name")).toContain("name");
  });

  it("returns empty string for an unknown field", () => {
    expect(fieldDescription("no.such.field")).toBe("");
  });
});

/* ── generateWorkflowSummary ── */

describe("generateWorkflowSummary", () => {
  it("generates a summary for a basic worker_run workflow", () => {
    const wf = makeWorkflow();
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("When");
    expect(summary).toContain("an issue");
    expect(summary).toContain("background worker");
    expect(summary).toMatch(/\.$/); // ends with period
  });

  it("includes assignee names in the trigger clause", () => {
    const wf = makeWorkflow({
      triggers: {
        assignees: ["alice"],
        labels: [],
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("alice");
  });

  it("includes labels in the trigger clause", () => {
    const wf = makeWorkflow({
      triggers: {
        assignees: [],
        labels: ["bug", "urgent"],
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("bug");
    expect(summary).toContain("urgent");
  });

  it("includes both assignees and labels", () => {
    const wf = makeWorkflow({
      triggers: {
        assignees: ["CTO"],
        labels: ["employee-session"],
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("CTO");
    expect(summary).toContain("employee-session");
  });

  it("includes the lane selection for non-primary lanes", () => {
    const wf = makeWorkflow({
      target: {
        type: "employee_session",
        runMode: "assisted",
        laneSelection: "fresh_issue_lane",
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("dedicated lane");
  });

  it("omits lane info for primary lane selection", () => {
    const wf = makeWorkflow({
      target: {
        type: "worker_run",
        runMode: "autopilot",
        laneSelection: "primary",
      },
    });
    const summary = generateWorkflowSummary(wf);
    // Should not include a lane clause
    expect(summary).not.toContain("primary lane");
  });

  it("includes completion waiting step when present", () => {
    const wf = makeWorkflow({
      steps: [
        { id: "s1", type: "launch_target" },
        { id: "s2", type: "wait_for_target_status", targetStatus: "completed" },
        { id: "s3", type: "complete_issue" },
      ],
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("wait for completion");
  });

  it("includes success state when closeout is configured", () => {
    const wf = makeWorkflow({
      closeout: {
        successState: "done",
        failureState: "todo",
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("Done");
  });

  it("uses article 'an' before vowel-starting type names", () => {
    const wf = makeWorkflow({
      target: {
        type: "employee_session",
        runMode: "assisted",
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("an agent chat session");
  });

  it("handles a fully-loaded workflow", () => {
    const wf = makeWorkflow({
      triggers: {
        assignees: ["alice", "bob"],
        labels: ["feature"],
      },
      target: {
        type: "worker_run",
        runMode: "autopilot",
        laneSelection: "fresh_issue_lane",
      },
      steps: [
        { id: "s1", type: "launch_target" },
        { id: "s2", type: "wait_for_target_status" },
      ],
      closeout: {
        successState: "in_review",
      },
    });
    const summary = generateWorkflowSummary(wf);
    expect(summary).toContain("alice");
    expect(summary).toContain("feature");
    expect(summary).toContain("background worker");
    expect(summary).toContain("wait for completion");
    expect(summary).toContain("In Review");
    expect(summary).toMatch(/\.$/);
  });
});
