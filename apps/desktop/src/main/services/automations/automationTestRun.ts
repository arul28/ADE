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

import { randomUUID } from "node:crypto";
import type {
  AutomationAction,
  AutomationExecution,
  AutomationRule,
  AutomationTestEvent,
  AutomationTestPlan,
  AutomationTestPlanStep,
  AutomationTestRequest,
  AutomationTestRunMode,
  AutomationTestStepEffect,
  AutomationTriggerType,
} from "../../../shared/types";
import { CUSTOM_NOTIFICATION_TITLE_MAX } from "../../../shared/types/attention";
import { runGit } from "../git/git";
import type { createLaneService } from "../lanes/laneService";
import { isRecord, nowIso } from "../shared/utils";
import type { AutomationPrLaneService } from "./automationPrBranchLane";
import type { TriggerContext } from "./automationService";

/** `resolvePlaceholders` from automationService, passed in so this module does not import it back. */
export type ResolvePlaceholders = (node: unknown, trigger: TriggerContext) => unknown;

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

/** The agent's prompt, with the safe-test notice first when this is a safe test. */
export function withSafeTestNotice(prompt: string, trigger: TriggerContext): string {
  return trigger.test?.mode === "safe" ? `${SAFE_TEST_AGENT_NOTICE}\n\n${prompt}` : prompt;
}

function truncateForTest(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The skipped-step output of a safe test: what the step would have done, with this event's values. */
export function describeHeldBackStep(
  action: AutomationAction,
  trigger: TriggerContext,
  reason: string,
  resolvePlaceholders: ResolvePlaceholders,
): string {
  let what = "";
  if (action.type === "ade-action" && action.adeAction) {
    const args = resolvePlaceholders(action.adeAction.args ?? {}, trigger);
    what = `would call ${action.adeAction.domain}.${action.adeAction.action} with ${truncateForTest(JSON.stringify(args))}`;
  } else if (action.type === "run-command") {
    what = `would run \`${truncateForTest(action.command ?? "")}\``;
  } else if (action.type === "handoff") {
    what = `would hand the chat off${action.targetModelId ? ` to ${action.targetModelId}` : ""}`;
  } else {
    what = `would run the ${action.type} step`;
  }
  return `Test: ${what}. ${reason}`;
}

/** The rule a safe test runs: every step in the test lane, never a named lane or a bound chat. */
export function safeTestRule(rule: AutomationRule): AutomationRule {
  const inTestLane = (actions: AutomationAction[] | undefined) =>
    actions?.map((action) => ({ ...action, targetLaneId: null }));
  const execution = rule.execution
    ? {
      ...rule.execution,
      laneMode: "require-on-trigger" as const,
      targetLaneId: null,
      ...(rule.execution.session ? { session: { ...rule.execution.session, chatSessionId: null } } : {}),
      ...(rule.execution.builtIn ? { builtIn: { ...rule.execution.builtIn, actions: inTestLane(rule.execution.builtIn.actions) ?? [] } } : {}),
    }
    : rule.execution;
  return {
    ...rule,
    execution,
    ...(rule.legacy ? { legacy: { ...rule.legacy, actions: inTestLane(rule.legacy.actions) } } : {}),
  };
}

export type AutomationTestRunDeps = {
  projectRoot: string;
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "create" | "getLaneWorktreePath">;
  prService: AutomationPrLaneService | null;
  resolveExecutionKind: (rule: AutomationRule) => AutomationExecution["kind"];
  resolvePlaceholders: ResolvePlaceholders;
};

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

const requiresTriggerLane = (rule: AutomationRule): boolean => rule.execution?.laneMode === "require-on-trigger";

/** The test event, plan, and throwaway lane. Nothing here writes a run. */
export function createAutomationTestRuns({
  projectRoot,
  laneService,
  prService,
  resolveExecutionKind,
  resolvePlaceholders,
}: AutomationTestRunDeps) {

  const describeTestEvent = (event: AutomationTestEvent, triggerType: AutomationTriggerType, laneName: string | null): string => {
    if (event.label?.trim()) return event.label.trim();
    if (event.pr?.number) return `PR #${event.pr.number}${event.pr.title ? ` ${event.pr.title}` : ""}`;
    if (event.issue?.number) return `Issue #${event.issue.number}${event.issue.title ? ` ${event.issue.title}` : ""}`;
    if (event.linearIssue?.id) return `Linear issue ${event.linearIssue.id}${event.linearIssue.title ? ` ${event.linearIssue.title}` : ""}`;
    if (event.sessionId?.trim()) return `Chat ${event.sessionId.trim()}`;
    if (laneName) return `Lane ${laneName}`;
    if (triggerType === "webhook") return event.webhookBody !== undefined ? "A sample webhook request" : "An empty webhook request";
    return "Now, with no event";
  };

  /** A PR given by number alone gets its title, link, and branches from GitHub, when it can. */
  const completeTestPr = async (pr: NonNullable<TriggerContext["pr"]>): Promise<NonNullable<TriggerContext["pr"]>> => {
    if ((pr.title?.trim() && pr.headBranch?.trim()) || !prService) return pr;
    const [repoOwner, repoName] = (pr.repo ?? "").split("/");
    try {
      const { preflight } = await prService.preflightCreateLaneFromPrBranch(
        pr.url
          ? { prUrlOrNumber: pr.url }
          : repoOwner && repoName
            ? { repoOwner, repoName, githubPrNumber: pr.number }
            : { prUrlOrNumber: String(pr.number) },
      );
      return {
        ...pr,
        title: pr.title?.trim() || preflight.title,
        url: pr.url || preflight.githubUrl || undefined,
        repo: pr.repo || (preflight.repoOwner && preflight.repoName ? `${preflight.repoOwner}/${preflight.repoName}` : undefined),
        headBranch: pr.headBranch || preflight.headBranch || undefined,
        baseBranch: pr.baseBranch || preflight.baseBranch || undefined,
      };
    } catch {
      // Not reachable now: the test goes on with what the caller sent.
      return pr;
    }
  };

  /** The trigger a test pretends set the rule off. Builds no lane and changes nothing. */
  const buildTestTrigger = async (
    rule: AutomationRule,
    eventInput: AutomationTestEvent | null | undefined,
    mode: AutomationTestRunMode,
  ): Promise<TriggerContext> => {
    const event = eventInput ?? {};
    const triggerType = (event.triggerType ?? rule.triggers[0]?.type ?? "manual") as AutomationTriggerType;
    const trigger: TriggerContext = { triggerType, reason: `test:${rule.id}`, scheduledAt: nowIso() };
    const laneId = trimToNull(event.laneId);
    let laneName: string | null = null;
    if (laneId) {
      const lane = (await laneService.list({ includeArchived: false })).find((entry) => entry.id === laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      laneName = lane.name;
      trigger.laneId = lane.id;
      trigger.laneName = lane.name;
      trigger.branch = lane.branchRef;
    }
    const sessionId = trimToNull(event.sessionId);
    if (sessionId) {
      trigger.sessionId = sessionId;
      trigger.session = { sessionId, ...(laneId ? { laneId } : {}) };
    }
    if (event.pr?.number) {
      const pr = await completeTestPr(event.pr);
      trigger.pr = pr;
      if (pr.repo) trigger.repo = pr.repo;
      if (pr.headBranch) trigger.branch = pr.headBranch;
      if (pr.baseBranch) trigger.targetBranch = pr.baseBranch;
      if (pr.author) trigger.author = pr.author;
      if (pr.labels?.length) trigger.labels = pr.labels;
      trigger.draftState = pr.draft ? "draft" : "ready";
    }
    if (event.issue?.number) {
      trigger.issue = event.issue;
      if (event.issue.repo) trigger.repo = event.issue.repo;
      if (event.issue.author) trigger.author = event.issue.author;
      if (event.issue.labels?.length) trigger.labels = event.issue.labels;
    }
    if (event.linearIssue?.id) trigger.linear = { issue: event.linearIssue };
    if (triggerType === "webhook") {
      trigger.webhook = { hookId: "test", method: "POST", headers: {}, query: {}, body: event.webhookBody ?? {} };
    }
    const label = describeTestEvent({ ...event, pr: trigger.pr ?? event.pr }, triggerType, laneName);
    trigger.summary = label;
    trigger.test = { mode, event: label, lanes: [], cleanedUpAt: null };
    return trigger;
  };

  const testRuleSteps = (rule: AutomationRule): AutomationAction[] | null =>
    resolveExecutionKind(rule) === "built-in"
      ? (rule.execution?.builtIn?.actions ?? rule.legacy?.actions ?? [])
      : null;

  /** Problems stop a test; warnings say how it differs from a real run. */
  const problemsAndWarnings = (
    rule: AutomationRule,
    trigger: TriggerContext,
    mode: AutomationTestRunMode,
  ): { problems: string[]; warnings: string[] } => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const steps = testRuleSteps(rule);
    if (steps && steps.length === 0) problems.push("This automation has no steps to test.");
    if (!steps && !(rule.prompt ?? "").trim()) problems.push("This automation has no prompt for its agent.");
    if (rule.execution?.laneMode === "pr-branch" && !trigger.pr?.number && !trigger.laneId) {
      problems.push("This automation works in a pull request's branch. Pick a pull request to test with.");
    }
    if (mode === "live" && requiresTriggerLane(rule) && !trigger.laneId) {
      problems.push("This automation works in the trigger's lane. Pick a lane to test with.");
    }
    const type = trigger.triggerType;
    if (/(^|\.)pr_|pull_request/.test(type) && !trigger.pr?.number) {
      warnings.push("No pull request is picked, so values from the PR are empty.");
    }
    if (/issue/.test(type) && !type.startsWith("linear") && !trigger.issue?.number) {
      warnings.push("No issue is picked, so values from the issue are empty.");
    }
    if (type.startsWith("linear") && !trigger.linear) {
      warnings.push("No Linear issue is picked, so values from the issue are empty.");
    }
    if (type === "webhook" && trigger.webhook && isRecord(trigger.webhook.body) && Object.keys(trigger.webhook.body).length === 0) {
      warnings.push("The webhook request is empty, so values from its body are empty.");
    }
    if (mode === "safe" && rule.execution?.session?.chatSessionId?.trim()) {
      warnings.push("This automation normally writes to one existing chat. A safe test starts a new chat in the test lane instead.");
    }
    if (mode === "safe" && (!steps || steps.some((step) => step.type === "agent-session"))) {
      warnings.push("A plain git push from the test lane fails, but an agent can still push on purpose. It is told not to.");
    }
    return { problems, warnings };
  };

  const describeTestLane = (rule: AutomationRule, trigger: TriggerContext, mode: AutomationTestRunMode): string => {
    if (mode === "safe") {
      if (trigger.pr?.number) {
        return `A new throwaway lane on a copy of PR #${trigger.pr.number}'s branch. The PR's own branch and lane are not touched.`;
      }
      if (trigger.laneName) return `A new throwaway lane copied from lane "${trigger.laneName}". That lane is not touched.`;
      return "A new throwaway lane from the default branch.";
    }
    if (rule.execution?.session?.chatSessionId?.trim()) return "Its own chat, in that chat's lane.";
    switch (rule.execution?.laneMode) {
      case "create":
        return "A new lane for this run.";
      case "pr-branch":
        return trigger.pr?.number
          ? `PR #${trigger.pr.number}'s own branch. Commits and pushes go to the real pull request.`
          : `Lane "${trigger.laneName ?? trigger.laneId}", on the PR's branch.`;
      case "require-on-trigger":
        return `The trigger's lane "${trigger.laneName ?? trigger.laneId ?? "?"}".`;
      default: {
        const configured = trimToNull(rule.execution?.targetLaneId);
        if (configured) return `Lane ${configured}, which the automation names.`;
        return trigger.laneName ? `The trigger's lane "${trigger.laneName}".` : "The primary lane.";
      }
    }
  };

  /** `{{run.*}}` values are not known before a run; the plan names them instead. */
  const RUN_VALUE_NAMES: Record<string, string> = {
    "run.chatSessionId": "the chat this run starts",
    "run.laneId": "the lane this run uses",
    "run.laneName": "the lane this run uses",
    "run.id": "this run",
  };
  const resolveForPlan = (value: unknown, trigger: TriggerContext): string => {
    const named = JSON.parse(JSON.stringify(value ?? ""), (_key, entry) =>
      typeof entry === "string"
        ? entry.replace(/\{\{\s*(run\.[^}\s]+)\s*\}\}/g, (_m, expr: string) => `‹${RUN_VALUE_NAMES[expr] ?? expr}›`)
        : entry,
    ) as unknown;
    const resolved = resolvePlaceholders(named, trigger);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  };

  const describeTestStep = (action: AutomationAction, trigger: TriggerContext): { title: string; detail: string | null } => {
    switch (action.type) {
      case "create-lane":
        return { title: "Create a lane", detail: action.laneNameTemplate ? `Name: ${resolveForPlan(action.laneNameTemplate, trigger)}` : null };
      case "delete-lane":
        return { title: "Delete a lane", detail: Number(action.afterMinutes ?? 0) > 0 ? `After ${action.afterMinutes} minutes` : null };
      case "agent-session":
        return {
          title: action.sessionTitle?.trim() || "Agent chat",
          detail: truncateForTest(`${action.modelConfig?.modelId ?? "Default model"}. Prompt: ${resolveForPlan(action.prompt ?? "", trigger)}`),
        };
      case "predict-conflicts":
        return { title: "Check for conflicts", detail: null };
      case "run-tests":
        return { title: "Run tests", detail: action.suiteId ? `Suite: ${action.suiteId}` : null };
      case "run-command":
        // Commands run as written: placeholders in them are not filled in.
        return { title: "Run a command", detail: truncateForTest(action.command ?? "") };
      case "handoff":
        return { title: "Hand off the chat", detail: action.targetModelId ? `To ${action.targetModelId}` : null };
      case "ade-action": {
        const config = action.adeAction;
        if (config?.domain === "attention" && config.action === "sendNotification") {
          const args = isRecord(config.args) ? config.args : {};
          const lines = [
            `Title: ${testNotificationTitle(resolveForPlan(args.title ?? "", trigger))}`,
            args.body ? `Body: ${resolveForPlan(args.body, trigger)}` : null,
            args.open ? `Opens: ${resolveForPlan(args.open, trigger)}` : null,
          ].filter(Boolean);
          return { title: "Send notification to mobile app", detail: lines.join("\n") };
        }
        return {
          title: `${config?.domain ?? "?"}.${config?.action ?? "?"}`,
          detail: truncateForTest(resolveForPlan(config?.args ?? {}, trigger)),
        };
      }
      default:
        return { title: action.type, detail: null };
    }
  };

  const planTest = async (rule: AutomationRule, request: AutomationTestRequest): Promise<AutomationTestPlan> => {
    const mode: AutomationTestRunMode = request.mode === "live" ? "live" : "safe";
    const trigger = await buildTestTrigger(rule, request.event, mode);
    const { problems, warnings } = problemsAndWarnings(rule, trigger, mode);
    const steps = testRuleSteps(rule);
    const planSteps: AutomationTestPlanStep[] = steps
      ? steps.map((action, index) => ({
        index,
        ...describeTestStep(action, trigger),
        ...testStepEffect(action, mode),
        alwaysRun: action.alwaysRun === true,
      }))
      : [{
        index: 0,
        title: "Agent chat",
        detail: truncateForTest(`${rule.modelConfig?.modelId ?? "Default model"}. Prompt: ${resolveForPlan(rule.prompt ?? "", trigger)}`),
        ...testStepEffect({ type: "agent-session" } as AutomationAction, mode),
        alwaysRun: false,
      }];
    const makesLanes = rule.execution?.laneMode === "create" || (steps ?? []).some((step) => step.type === "create-lane");
    const afterwards = mode === "safe"
      ? [
        "The test lane stays, so you can look at what it did.",
        "Clean up on this run in History deletes the lanes the test made and their local branches.",
      ]
      : [
        "Everything this test does is real. Pushes, comments, and posts stay.",
        ...(makesLanes ? ["Clean up on this run in History deletes the lanes it made. Their pushed branches stay."] : []),
      ];
    return {
      mode,
      ruleName: rule.name,
      event: trigger.test?.event ?? "",
      lane: describeTestLane(rule, trigger, mode),
      steps: planSteps,
      afterwards,
      problems,
      warnings,
    };
  };

  /** Fetches a PR's head into a private ref and answers its commit. */
  const fetchPrHeadForTest = async (pr: NonNullable<TriggerContext["pr"]>): Promise<string> => {
    const ref = `refs/ade-test/pr-${pr.number}-${randomUUID().slice(0, 8)}`;
    const sources = [`refs/pull/${pr.number}/head`, ...(pr.headBranch ? [`refs/heads/${pr.headBranch}`] : [])];
    let lastError = "";
    for (const source of sources) {
      const fetched = await runGit(["fetch", "--no-tags", "origin", `+${source}:${ref}`], { cwd: projectRoot, timeoutMs: 120_000 });
      if (fetched.exitCode !== 0) {
        lastError = fetched.stderr.trim();
        continue;
      }
      const sha = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: projectRoot, timeoutMs: 10_000 });
      await runGit(["update-ref", "-d", ref], { cwd: projectRoot, timeoutMs: 10_000 });
      if (sha.exitCode === 0 && sha.stdout.trim()) return sha.stdout.trim();
    }
    throw new Error(`Could not fetch PR #${pr.number}'s branch for the test.${lastError ? ` ${lastError}` : ""}`);
  };

  /** The throwaway lane a safe test works in. Points the trigger at it. */
  const createSafeTestLane = async (rule: AutomationRule, trigger: TriggerContext): Promise<void> => {
    let startPoint: string | null = null;
    if (trigger.pr?.number) {
      startPoint = await fetchPrHeadForTest(trigger.pr);
    } else if (trigger.laneId) {
      const head = await runGit(["rev-parse", "HEAD"], { cwd: laneService.getLaneWorktreePath(trigger.laneId), timeoutMs: 10_000 });
      if (head.exitCode === 0 && head.stdout.trim()) startPoint = head.stdout.trim();
    }
    const { laneName, branchName } = safeTestLaneNames(rule.name, randomUUID().replace(/-/g, "").slice(0, 6));
    const lane = await laneService.create({
      name: laneName,
      description: `Throwaway lane for a safe test of "${rule.name}" (${trigger.test?.event ?? "no event"}). Clean up the test run in History to remove it.`,
      branchName,
      ...(startPoint ? { startPoint } : {}),
    });
    trigger.test?.lanes.push({ id: lane.id, name: lane.name });
    // A plain `git push` from the lane goes to a remote that does not exist.
    const branch = (lane.branchRef ?? branchName).replace(/^refs\/heads\//, "");
    await runGit(["config", `branch.${branch}.pushRemote`, SAFE_TEST_PUSH_REMOTE], { cwd: projectRoot, timeoutMs: 10_000 });
    trigger.laneId = lane.id;
    trigger.laneName = lane.name;
    if (trigger.session) trigger.session = { ...trigger.session, laneId: lane.id };
  };

  return { buildTestTrigger, problemsAndWarnings, planTest, createSafeTestLane };
}
