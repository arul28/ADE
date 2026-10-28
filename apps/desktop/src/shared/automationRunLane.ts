import type { AutomationRule } from "./types";

/**
 * What lane a run of this rule needs from its caller.
 *
 * `"lane"` for `laneMode: "require-on-trigger"`. `"lane-to-delete"` for a
 * built-in `delete-lane` step that names no lane and follows no `create-lane`
 * step: it deletes the trigger's lane, so a manual run without one fails
 * mid-run (the "Clean up merged lanes" template run by hand). Callers ask for
 * the lane up front instead.
 */
export function automationRunLaneNeed(rule: Pick<AutomationRule, "execution">): "none" | "lane" | "lane-to-delete" {
  const execution = rule.execution;
  if (!execution) return "none";
  if (execution.laneMode === "require-on-trigger") return "lane";
  if (execution.laneMode === "create" || execution.laneMode === "pr-branch") return "none";
  if (execution.kind !== "built-in" || execution.targetLaneId?.trim()) return "none";
  for (const action of execution.builtIn?.actions ?? []) {
    if (action.type === "create-lane") return "none";
    if (action.type === "delete-lane" && !action.targetLaneId?.trim()) return "lane-to-delete";
  }
  return "none";
}

export function automationRunNeedsLane(rule: Pick<AutomationRule, "execution">): boolean {
  return automationRunLaneNeed(rule) !== "none";
}
