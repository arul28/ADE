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
 * What lane a run of this rule needs from its caller.
 *
 * `"lane"` for `laneMode: "require-on-trigger"`. `"lane-to-delete"` for a
 * built-in `delete-lane` step that names no lane and follows no `create-lane`
 * step: it deletes the trigger's lane, so a manual run without one fails
 * mid-run (the "Clean up merged lanes" template run by hand). Callers ask for
 * the lane up front instead.
 */
export function automationRunLaneNeed(rule: RuleExecution): "none" | "lane" | "lane-to-delete" {
  const execution = rule.execution;
  if (!execution) return "none";
  if (requiresTriggerLane(rule)) return "lane";
  if (createsLaneForRun(rule)) return "none";
  if (execution.kind !== "built-in" || execution.targetLaneId?.trim()) return "none";
  for (const action of execution.builtIn?.actions ?? []) {
    if (action.type === "create-lane") return "none";
    if (action.type === "delete-lane" && !action.targetLaneId?.trim()) return "lane-to-delete";
  }
  return "none";
}

export function automationRunNeedsLane(rule: RuleExecution): boolean {
  return automationRunLaneNeed(rule) !== "none";
}
