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

import type { AutomationAction, AutomationExecution, AutomationCloudTarget, AutomationTrigger } from "./types/config";
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

/** True for an IANA time zone this runtime knows (`Europe/Berlin`, `UTC`). */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** This computer's time zone, the one a rule moved to ADE Cloud keeps. */
export function localTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isIanaTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

type CloudHomeRule = {
  scope?: { sessionId?: string | null } | null;
  triggers?: ReadonlyArray<AutomationTrigger> | null;
  trigger?: AutomationTrigger | null;
  execution?: AutomationExecution | null;
};

/**
 * Why this rule can't have ADE Cloud as its home (C9), or null. ADE's server
 * watches only a schedule, a custom webhook or Run now, and each run is an
 * agent in a new lane on its own cloud computer; nothing that lives on one
 * computer (a chat, a lane, a secret, its files) can come along.
 */
export function automationCloudHomeProblem(rule: CloudHomeRule): string | null {
  if (typeof rule.scope?.sessionId === "string" && rule.scope.sessionId.trim()) {
    return "This rule belongs to one chat, which lives on its computer, so it can't run on ADE Cloud.";
  }
  const execution = rule.execution;
  if (!execution || execution.kind !== "agent-session") {
    return "On ADE Cloud a rule runs an agent in a new lane. A rule of built-in steps runs on one of your computers.";
  }
  if (execution.session?.chatSessionId?.trim()) {
    return "A rule that runs in one chat can't run on ADE Cloud. Run each trigger in a new chat.";
  }
  if (execution.laneMode !== "create") {
    return "On ADE Cloud each run gets a new lane on its own computer. Pick \"A new lane each run\".";
  }
  const triggers = rule.triggers?.length ? rule.triggers : rule.trigger ? [rule.trigger] : [];
  if (triggers.filter((trigger) => trigger.type === "schedule").length > 1) return "ADE Cloud takes one schedule per rule.";
  if (triggers.filter((trigger) => trigger.type === "webhook").length > 1) return "ADE Cloud takes one webhook per rule.";
  for (const trigger of triggers) {
    if (trigger.secretRef?.trim() || trigger.webhook?.signature) {
      return "This rule checks a signing secret, which stays on the computer that has it. Remove the signature check to run it on ADE Cloud.";
    }
    if (trigger.type === "schedule" || trigger.type === "manual") continue;
    if (trigger.type === "webhook") {
      if (!trigger.webhook?.hookId) return "This webhook has no ADE webhook URL yet. Make one, then pick ADE Cloud.";
      if (trigger.webhook.filters?.length) return "Webhook filters run on one of your computers for now. Remove them to run this rule on ADE Cloud.";
      continue;
    }
    if (trigger.type === "file.change") return "File-change triggers watch files on one computer, so they can't run on ADE Cloud.";
    if (trigger.type.startsWith("linear.")) return "Linear triggers run on one of your computers for now.";
    if (trigger.type.startsWith("github") || trigger.type.startsWith("git.pr_")) {
      return "GitHub triggers run on one of your computers for now: ADE Cloud doesn't match GitHub's events yet.";
    }
    return "This trigger happens on one computer, so it can't start a rule on ADE Cloud. Use a schedule, a webhook or Run now.";
  }
  return null;
}

/** The stored target, or undefined when the value isn't one. An unknown size reads as the saved size. */
export function parseAutomationCloudTarget(value: unknown): AutomationCloudTarget | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { sizeId, maxRunsPerHour, keepComputer } = value as { sizeId?: unknown; maxRunsPerHour?: unknown; keepComputer?: unknown };
  const perHour = typeof maxRunsPerHour === "number" && Number.isInteger(maxRunsPerHour) && maxRunsPerHour >= 1 && maxRunsPerHour <= 60 ? maxRunsPerHour : null;
  return {
    ...(isCloudTierId(sizeId) ? { sizeId } : {}),
    ...(perHour ? { maxRunsPerHour: perHour } : {}),
    ...(keepComputer === true ? { keepComputer: true } : {}),
  };
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
