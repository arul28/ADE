/**
 * Test runs of an automation: what each step does in a safe or live test.
 *
 * A safe test works in a throwaway lane and does not reach outside ADE: a step
 * that would post, push, publish, or delete a real lane reports what it would
 * do instead. A live test runs every step for real. Both mark notifications
 * "[Test]" and use none of the rule's run budget.
 *
 * The plan the person sees before a test and the run itself both read
 * `safeTestHoldsBack`, so the preview cannot promise one thing and the run do
 * another.
 */

import type { AutomationAction, AutomationTestRunMode, AutomationTestStepEffect } from "../../../shared/types";
import { CUSTOM_NOTIFICATION_TITLE_MAX } from "../../../shared/types/attention";

/** The prefix a test puts on every notification title. */
export const TEST_NOTIFICATION_PREFIX = "[Test] ";

/** The first lines of the agent's prompt in a safe test. */
export const SAFE_TEST_AGENT_NOTICE =
  "This is a TEST run of an ADE automation, in a throwaway lane. Do the work and check it locally, "
  + "but do not push, open, merge, or comment on pull requests, change GitHub or Linear issues, or send messages. "
  + "Where the task says to do one of those, stop and write what you would have sent instead.";

/** Commands that reach outside the machine: a safe test reports them instead of running them. */
const OUTWARD_COMMAND = new RegExp(
  [
    String.raw`\bgit\s+push\b`,
    String.raw`\bgh\s+(?:pr|issue|release|api|repo|workflow|run)\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+publish\b`,
    String.raw`\bcurl\b[^\n]*\s(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b`,
    String.raw`\bcurl\b[^\n]*\s(?:-d|--data(?:-\w+)?|-F|--form)\b`,
  ].join("|"),
  "i",
);

export function isOutwardCommand(command: string | null | undefined): boolean {
  return OUTWARD_COMMAND.test(command ?? "");
}

export function isNotificationStep(action: Pick<AutomationAction, "type" | "adeAction">): boolean {
  return action.type === "ade-action"
    && action.adeAction?.domain === "attention"
    && action.adeAction?.action === "sendNotification";
}

/**
 * Why a safe test does not run this step, or null when it runs. `delete-lane`
 * runs only on a lane the test made, which the caller checks at run time.
 */
export function safeTestHoldsBack(action: AutomationAction): string | null {
  switch (action.type) {
    case "ade-action": {
      if (isNotificationStep(action)) return null;
      const name = `${action.adeAction?.domain ?? "?"}.${action.adeAction?.action ?? "?"}`;
      return `A safe test does not call ADE actions that change things outside the test (${name}).`;
    }
    case "handoff":
      return "A safe test does not hand a chat off to another model.";
    case "run-command":
      return isOutwardCommand(action.command)
        ? "This command pushes, publishes, or posts, so a safe test does not run it."
        : null;
    default:
      return null;
  }
}

/** What a step does in a test of the given mode. */
export function testStepEffect(
  action: AutomationAction,
  mode: AutomationTestRunMode,
): { effect: AutomationTestStepEffect; note: string | null } {
  if (isNotificationStep(action)) {
    return { effect: "labeled", note: "Sends for real, with \"[Test]\" before the title." };
  }
  if (mode === "live") return { effect: "runs", note: null };
  if (action.type === "delete-lane") {
    return { effect: "runs", note: "Deletes only a lane this test made. Any other lane is left alone." };
  }
  const held = safeTestHoldsBack(action);
  if (held) return { effect: "would-run", note: held };
  if (action.type === "agent-session") {
    return { effect: "runs", note: "The agent is told this is a test, and not to push, post, or comment." };
  }
  return { effect: "runs", note: null };
}

export function testNotificationTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.startsWith(TEST_NOTIFICATION_PREFIX.trim())) return trimmed.slice(0, CUSTOM_NOTIFICATION_TITLE_MAX);
  return `${TEST_NOTIFICATION_PREFIX}${trimmed}`.slice(0, CUSTOM_NOTIFICATION_TITLE_MAX);
}

/** The throwaway lane's name and its local branch, unique for each test. */
export function safeTestLaneNames(ruleName: string, suffix: string): { laneName: string; branchName: string } {
  const slug = ruleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "automation";
  return {
    laneName: `Test: ${ruleName.trim() || "automation"} (${suffix})`,
    branchName: `ade-test/${slug}-${suffix}`,
  };
}

/**
 * The remote a safe test's branch pushes to by default. It does not exist,
 * so a plain `git push` from the lane fails. An explicit `git push origin …`
 * still works; the agent notice and the plan say so.
 */
export const SAFE_TEST_PUSH_REMOTE = "ade-test-push-blocked";
