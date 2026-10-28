import type { AutomationRule } from "./types";

type RuleExecution = Pick<AutomationRule, "execution">;

/** The caller or trigger must name the run's lane (`laneMode: "require-on-trigger"`). */
export function requiresTriggerLane(rule: RuleExecution): boolean {
  return rule.execution?.laneMode === "require-on-trigger";
}

/** Lane modes that resolve (and may create) the run's lane before a step runs. */
export function createsLaneForRun(rule: RuleExecution): boolean {
  return rule.execution?.laneMode === "create" || rule.execution?.laneMode === "pr-branch";
}

/**
 * Built-in steps that resolve the run's lane, and so make it under a creating
 * lane mode (`resolveExecutionLaneId`), unless the step names its own lane.
 */
const LANE_RESOLVING_ACTIONS = new Set(["agent-session", "run-command", "run-tests", "predict-conflicts"]);

/**
 * What lane a run of this rule needs from its caller.
 *
 * `"lane-to-delete"` for a built-in `delete-lane` step that names no lane and
 * has no lane made before it (by a `create-lane` step, or by a step that
 * resolves the run's lane under `laneMode: "create"` / `"pr-branch"`): it
 * deletes the trigger's lane, so a manual run without one fails mid-run (the
 * "Clean up merged lanes" template run by hand). Callers ask for the lane up
 * front, as the lane to delete. Otherwise `"lane"` for
 * `laneMode: "require-on-trigger"`.
 */
export function automationRunLaneNeed(rule: RuleExecution): "none" | "lane" | "lane-to-delete" {
  const execution = rule.execution;
  if (!execution) return "none";
  if (execution.kind === "built-in" && !execution.targetLaneId?.trim()) {
    const createsLane = createsLaneForRun(rule);
    for (const action of execution.builtIn?.actions ?? []) {
      if ((action.condition ?? "").trim() === "false") continue;
      if (action.type === "create-lane") break;
      if (createsLane && LANE_RESOLVING_ACTIONS.has(action.type) && !action.targetLaneId?.trim()) break;
      if (action.type === "delete-lane" && !action.targetLaneId?.trim()) return "lane-to-delete";
    }
  }
  return requiresTriggerLane(rule) ? "lane" : "none";
}

export function automationRunNeedsLane(rule: RuleExecution): boolean {
  return automationRunLaneNeed(rule) !== "none";
}
