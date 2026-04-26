import type { LinearWorkflowDefinition } from "../../../../shared/types/linearSync";
import type { LinearWorkflowTarget } from "../../../../shared/types/linearSync";
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
import {
  flattenTargetChain,
  rebuildTargetChain,
  countStages,
  getStageAt,
  insertStageAt,
  removeStageAt,
  updateStageAt,
  createDefaultStage,
  type PipelineStage,
} from "./pipelineHelpers";
import { describe, expect, it } from "vitest";

describe("pipelineHelpers (file group)", () => {

  /* ── Helpers ── */

  function makeTarget(overrides: Partial<LinearWorkflowTarget> = {}): LinearWorkflowTarget {
    return {
      type: "worker_run",
      runMode: "autopilot",
      workerSelector: { mode: "none" },
      laneSelection: "fresh_issue_lane",
      prTiming: "none",
      ...overrides,
    };
  }

  function makeChain(length: number): LinearWorkflowTarget {
    const types: LinearWorkflowTarget["type"][] = [
      "worker_run",
      "employee_session",
      "mission",
      "pr_resolution",
      "review_gate",
    ];
    let chain: LinearWorkflowTarget | null = null;
    for (let i = length - 1; i >= 0; i--) {
      const stage: LinearWorkflowTarget = {
        type: types[i % types.length],
        runMode: "autopilot",
      };
      if (chain) {
        stage.downstreamTarget = chain;
      }
      chain = stage;
    }
    return chain!;
  }

  /* ── flattenTargetChain ── */

  describe("flattenTargetChain", () => {
    it("returns a single-element array for a target with no downstream", () => {
      const target = makeTarget();
      const stages = flattenTargetChain(target);
      expect(stages).toHaveLength(1);
      expect(stages[0].type).toBe("worker_run");
      expect("downstreamTarget" in stages[0]).toBe(false);
    });

    it("flattens a two-stage chain", () => {
      const target = makeTarget({
        downstreamTarget: {
          type: "review_gate",
          runMode: "manual",
        },
      });
      const stages = flattenTargetChain(target);
      expect(stages).toHaveLength(2);
      expect(stages[0].type).toBe("worker_run");
      expect(stages[1].type).toBe("review_gate");
      expect(stages[1].runMode).toBe("manual");
    });

    it("flattens a deep chain of 5 stages", () => {
      const target = makeChain(5);
      const stages = flattenTargetChain(target);
      expect(stages).toHaveLength(5);
      expect(stages.every((s) => !("downstreamTarget" in s))).toBe(true);
    });

    it("strips downstreamTarget from each stage", () => {
      const target = makeTarget({
        downstreamTarget: {
          type: "mission",
          runMode: "autopilot",
          missionTemplate: "default",
        },
      });
      const stages = flattenTargetChain(target);
      for (const stage of stages) {
        expect(stage).not.toHaveProperty("downstreamTarget");
      }
    });
  });

  /* ── rebuildTargetChain ── */

  describe("rebuildTargetChain", () => {
    it("throws on empty array", () => {
      expect(() => rebuildTargetChain([])).toThrow("Cannot build target chain from empty array");
    });

    it("rebuilds a single stage with no downstreamTarget", () => {
      const stage: PipelineStage = { type: "worker_run", runMode: "autopilot" };
      const chain = rebuildTargetChain([stage]);
      expect(chain.type).toBe("worker_run");
      expect(chain.downstreamTarget).toBeUndefined();
    });

    it("rebuilds a two-stage chain with correct nesting", () => {
      const stages: PipelineStage[] = [
        { type: "worker_run", runMode: "autopilot" },
        { type: "review_gate", runMode: "manual" },
      ];
      const chain = rebuildTargetChain(stages);
      expect(chain.type).toBe("worker_run");
      expect(chain.downstreamTarget).toBeDefined();
      expect(chain.downstreamTarget!.type).toBe("review_gate");
    });

    it("is the inverse of flattenTargetChain", () => {
      const original = makeChain(4);
      const flat = flattenTargetChain(original);
      const rebuilt = rebuildTargetChain(flat);
      // Re-flatten and compare
      const reflat = flattenTargetChain(rebuilt);
      expect(reflat).toEqual(flat);
    });
  });

  /* ── countStages ── */

  describe("countStages", () => {
    it("returns 1 for a single target", () => {
      expect(countStages(makeTarget())).toBe(1);
    });

    it("returns 3 for a 3-stage chain", () => {
      expect(countStages(makeChain(3))).toBe(3);
    });
  });

  /* ── getStageAt ── */

  describe("getStageAt", () => {
    it("returns the stage at the given index", () => {
      const target = makeChain(3);
      const stage = getStageAt(target, 1);
      expect(stage).not.toBeNull();
      expect(stage!.type).toBe("employee_session");
    });

    it("returns null for out-of-bounds index", () => {
      const target = makeTarget();
      expect(getStageAt(target, 5)).toBeNull();
      expect(getStageAt(target, -1)).toBeNull();
    });

    it("returns the first stage at index 0", () => {
      const target = makeChain(3);
      const stage = getStageAt(target, 0);
      expect(stage).not.toBeNull();
      expect(stage!.type).toBe("worker_run");
    });
  });

  /* ── insertStageAt ── */

  describe("insertStageAt", () => {
    it("inserts at the beginning (index 0)", () => {
      const target = makeTarget();
      const newStage: PipelineStage = { type: "review_gate", runMode: "manual" };
      const result = insertStageAt(target, 0, newStage);
      const flat = flattenTargetChain(result);
      expect(flat).toHaveLength(2);
      expect(flat[0].type).toBe("review_gate");
      expect(flat[1].type).toBe("worker_run");
    });

    it("appends at the end", () => {
      const target = makeTarget();
      const newStage: PipelineStage = { type: "mission", runMode: "autopilot" };
      const result = insertStageAt(target, 1, newStage);
      const flat = flattenTargetChain(result);
      expect(flat).toHaveLength(2);
      expect(flat[0].type).toBe("worker_run");
      expect(flat[1].type).toBe("mission");
    });

    it("inserts in the middle of a 3-stage chain", () => {
      const target = makeChain(3);
      const newStage: PipelineStage = { type: "pr_resolution", runMode: "autopilot" };
      const result = insertStageAt(target, 1, newStage);
      const flat = flattenTargetChain(result);
      expect(flat).toHaveLength(4);
      expect(flat[1].type).toBe("pr_resolution");
    });

    it("throws for out-of-bounds index", () => {
      const target = makeTarget();
      const newStage: PipelineStage = { type: "mission", runMode: "autopilot" };
      expect(() => insertStageAt(target, -1, newStage)).toThrow("out of range");
      expect(() => insertStageAt(target, 5, newStage)).toThrow("out of range");
    });
  });

  /* ── removeStageAt ── */

  describe("removeStageAt", () => {
    it("removes a stage from a two-stage chain", () => {
      const target = makeChain(2);
      const result = removeStageAt(target, 1);
      const flat = flattenTargetChain(result);
      expect(flat).toHaveLength(1);
      expect(flat[0].type).toBe("worker_run");
    });

    it("removes the first stage", () => {
      const target = makeChain(2);
      const result = removeStageAt(target, 0);
      const flat = flattenTargetChain(result);
      expect(flat).toHaveLength(1);
      expect(flat[0].type).toBe("employee_session");
    });

    it("throws when removing the only stage", () => {
      const target = makeTarget();
      expect(() => removeStageAt(target, 0)).toThrow("Cannot remove the only stage");
    });

    it("throws for out-of-bounds index", () => {
      const target = makeChain(2);
      expect(() => removeStageAt(target, -1)).toThrow("out of range");
      expect(() => removeStageAt(target, 5)).toThrow("out of range");
    });
  });

  /* ── updateStageAt ── */

  describe("updateStageAt", () => {
    it("updates a stage in place", () => {
      const target = makeChain(3);
      const result = updateStageAt(target, 1, (stage) => ({
        ...stage,
        runMode: "manual",
      }));
      const flat = flattenTargetChain(result);
      expect(flat[1].runMode).toBe("manual");
      // Other stages unchanged
      expect(flat[0].type).toBe("worker_run");
      expect(flat[2].type).toBe("mission");
    });

    it("throws for out-of-bounds index", () => {
      const target = makeTarget();
      expect(() => updateStageAt(target, 5, (s) => s)).toThrow("out of range");
      expect(() => updateStageAt(target, -1, (s) => s)).toThrow("out of range");
    });

    it("preserves chain length", () => {
      const target = makeChain(4);
      const result = updateStageAt(target, 2, (stage) => ({
        ...stage,
        type: "review_gate" as const,
      }));
      expect(countStages(result)).toBe(4);
    });
  });

  /* ── createDefaultStage ── */

  describe("createDefaultStage", () => {
    it("creates a default employee_session stage", () => {
      const stage = createDefaultStage("employee_session");
      expect(stage.type).toBe("employee_session");
      expect(stage.runMode).toBe("assisted");
      expect(stage.sessionTemplate).toBe("default");
      expect(stage.laneSelection).toBe("fresh_issue_lane");
      expect(stage.sessionReuse).toBe("fresh_session");
      expect(stage.prTiming).toBe("none");
    });

    it("creates a default worker_run stage", () => {
      const stage = createDefaultStage("worker_run");
      expect(stage.type).toBe("worker_run");
      expect(stage.runMode).toBe("autopilot");
      expect(stage.workerSelector).toEqual({ mode: "none" });
      expect(stage.laneSelection).toBe("fresh_issue_lane");
      expect(stage.prTiming).toBe("none");
    });

    it("creates a default mission stage", () => {
      const stage = createDefaultStage("mission");
      expect(stage.type).toBe("mission");
      expect(stage.runMode).toBe("autopilot");
      expect(stage.missionTemplate).toBe("default");
    });

    it("creates a default pr_resolution stage", () => {
      const stage = createDefaultStage("pr_resolution");
      expect(stage.type).toBe("pr_resolution");
      expect(stage.runMode).toBe("autopilot");
      expect(stage.prStrategy).toEqual({ kind: "per-lane", draft: true });
      expect(stage.prTiming).toBe("after_target_complete");
    });

    it("creates a default review_gate stage", () => {
      const stage = createDefaultStage("review_gate");
      expect(stage.type).toBe("review_gate");
      expect(stage.runMode).toBe("manual");
    });
  });

});

describe("pipelineLabels (file group)", () => {

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

});
