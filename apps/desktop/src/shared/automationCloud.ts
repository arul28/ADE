/**
 * A rule whose runs get their lane on ADE Cloud (`execution.cloud`). The
 * machine that runs the rule watches the trigger and keeps the history; each
 * run makes a new lane on its own new computer through the cloud launch path
 * (`cloud.lane_launch`), as an unattended agent under the agent limits.
 *
 * - An agent rule starts its chat there (launch kind `chat`).
 * - A rule of built-in steps makes the lane there alone (kind `lane`). Its
 *   other steps run here, so a step that works in a lane here (a command,
 *   tests, a hand-off) can't be in it.
 */

import type { AutomationAction, AutomationExecution, AutomationCloudTarget } from "./types/config";
import { isCloudTierId } from "./cloudTiers";

/** Built-in steps that work in the run's lane on this machine: they can't follow a lane on ADE Cloud. */
const LOCAL_LANE_STEPS: ReadonlySet<AutomationAction["type"]> = new Set([
  "create-lane",
  "delete-lane",
  "agent-session",
  "predict-conflicts",
  "run-tests",
  "run-command",
  "handoff",
]);

/** The stored target, or undefined when the value isn't one. An unknown size reads as the saved size. */
export function parseAutomationCloudTarget(value: unknown): AutomationCloudTarget | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sizeId = (value as { sizeId?: unknown }).sizeId;
  return isCloudTierId(sizeId) ? { sizeId } : {};
}

/** The rule's ADE Cloud target, or null when its runs stay on its machine. */
export function automationCloudTarget(execution: Pick<AutomationExecution, "cloud"> | null | undefined): AutomationCloudTarget | null {
  return execution?.cloud ? execution.cloud : null;
}

/**
 * Why this rule can't run on ADE Cloud as it is, or null. One sentence the
 * builder shows and the service refuses with.
 */
export function automationCloudProblem(execution: AutomationExecution | null | undefined): string | null {
  if (!automationCloudTarget(execution) || !execution) return null;
  if (execution.kind === "agent-session" && execution.session?.chatSessionId?.trim()) {
    return "A rule that runs in one chat can't run on ADE Cloud. Run each trigger in a new chat, or turn ADE Cloud off.";
  }
  if (execution.laneMode !== "create" && execution.laneMode !== "pr-branch") {
    return "On ADE Cloud each run gets a new lane on its own computer. Pick \"A new lane each run\" or \"The PR's branch\".";
  }
  if (execution.kind === "built-in") {
    const local = (execution.builtIn?.actions ?? []).find((action) => LOCAL_LANE_STEPS.has(action.type));
    if (local) {
      return "Commands, tests, conflict checks, hand-offs and lane steps work in a lane on this machine, so they can't follow a lane on ADE Cloud. Remove them, or turn ADE Cloud off.";
    }
  }
  return null;
}
