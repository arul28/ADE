/**
 * Parameterized template playbooks. Each seeds the builder with a valid
 * `AutomationRuleDraft` plus a short "what you'll configure" list. Grouped for
 * the gallery; the flagship subset is featured in the empty state.
 */

import type { AiPermissionSettings, AutomationRuleDraft, ModelConfig } from "../../../../shared/types";
import { defaultKickoffPrompt } from "../../../lib/linearBatchLaunch";

const GROUP_ORDER = ["Agent workflows", "Pull requests", "Chats", "Issue intake", "Hygiene"] as const;

export type AutomationTemplate = {
  id: string;
  name: string;
  description: string;
  group: (typeof GROUP_ORDER)[number];
  triggerType: string;
  whatYouConfigure: string[];
  isFlagship?: boolean;
  draft: Omit<AutomationRuleDraft, "id">;
};

const BASE: Pick<
  Omit<AutomationRuleDraft, "id">,
  "enabled" | "mode" | "executor" | "reviewProfile" | "toolPalette" | "contextSources" | "outputs" | "verification"
> = {
  enabled: true,
  mode: "review",
  executor: { mode: "automation-bot" },
  reviewProfile: "quick",
  toolPalette: ["repo", "git"],
  contextSources: [],
  outputs: { disposition: "comment-only", createArtifact: true },
  verification: { verifyBeforePublish: false, mode: "intervention" },
};

const SONNET = { modelId: "anthropic/claude-sonnet-5", thinkingLevel: "medium" as const };

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-agent-task",
    name: "Daily agent task",
    description: "Every weekday morning, spin up a fresh lane and have an agent work a recurring task.",
    group: "Agent workflows",
    triggerType: "schedule",
    whatYouConfigure: ["Schedule", "Agent prompt", "Optional cleanup delay"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "Daily agent task",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      execution: {
        kind: "agent-session",
        laneMode: "create",
        laneNamePreset: "custom",
        laneNameTemplate: "Daily task {{date}}",
        session: { title: "Daily task" },
      },
      modelConfig: SONNET,
      prompt:
        "Run today's recurring maintenance task. Summarize what you did and flag anything that needs a human.",
      guardrails: {},
      billingCode: "auto:daily-agent-task",
      actions: [],
    },
  },
  {
    id: "linear-issue-lane-agent",
    name: "Linear issue → lane + agent",
    description: "When a Linear issue is created, open a lane named for it and let an agent work it toward a draft PR.",
    group: "Issue intake",
    triggerType: "linear.issue_created",
    whatYouConfigure: ["Team / project", "Agent prompt", "Model"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "Linear issue → lane + agent",
      // No team default: a wrong team key silently blocks every dispatch.
      // "Team / project" stays in whatYouConfigure for users who want scoping.
      triggers: [{ type: "linear.issue_created" }],
      trigger: { type: "linear.issue_created" },
      execution: {
        kind: "agent-session",
        laneMode: "create",
        laneNamePreset: "custom",
        laneNameTemplate: "{{trigger.issue.title}}",
        session: { title: "Linear issue" },
      },
      modelConfig: SONNET,
      prompt:
        "Work the linked Linear issue. Implement a focused change, keep the diff tight, and open a draft PR when ready.",
      toolPalette: ["repo", "git", "linear"],
      outputs: { disposition: "open-pr-draft", createArtifact: true },
      guardrails: {},
      billingCode: "auto:linear-issue-lane-agent",
      actions: [],
    },
  },
  {
    id: "github-issue-lane-agent",
    name: "GitHub issue → lane + agent",
    description: "When a GitHub issue is opened, open a lane named for it and let an agent work it toward a draft PR.",
    group: "Issue intake",
    triggerType: "github.issue_opened",
    whatYouConfigure: ["Repository / labels", "Agent prompt", "Model"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "GitHub issue → lane + agent",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: {
        kind: "agent-session",
        laneMode: "create",
        laneNamePreset: "issue-title",
        session: { title: "GitHub issue" },
      },
      modelConfig: SONNET,
      prompt:
        "Work the linked GitHub issue. Implement a focused change and open a draft PR when ready. Cite files you touched.",
      toolPalette: ["repo", "git", "github"],
      outputs: { disposition: "open-pr-draft", createArtifact: true },
      guardrails: {},
      billingCode: "auto:github-issue-lane-agent",
      actions: [],
    },
  },
  {
    id: "dependabot-pr-agent",
    name: "Dependabot PR → its branch + agent",
    description: "When Dependabot opens a PR, open the PR's own branch as a lane and let an agent finish and check the update there.",
    group: "Pull requests",
    triggerType: "github.pr_opened",
    whatYouConfigure: ["Agent prompt", "Model", "Other bots or authors"],
    draft: {
      ...BASE,
      name: "Dependabot PR → its branch + agent",
      triggers: [{ type: "github.pr_opened", authors: ["dependabot[bot]"] }],
      trigger: { type: "github.pr_opened", authors: ["dependabot[bot]"] },
      execution: {
        kind: "agent-session",
        laneMode: "pr-branch",
        laneNamePreset: "pr-title-author",
        session: { title: "Dependabot PR" },
      },
      modelConfig: SONNET,
      prompt:
        "Dependabot opened PR #{{trigger.pr.number}} ({{trigger.pr.title}}). You are on its branch. Finish the update: read what the bump changes (its changelog or release notes for breaking changes), run any install, lockfile or code-generation steps the project uses for that package, run the build and the checks for the code that uses it, and fix what breaks. Commit and push to this branch. If the new version needs a decision a human should make (a breaking API, a dropped platform, a licence change), do not work around it; stop and say what is needed. End with what you checked.",
      toolPalette: ["repo", "git", "github"],
      guardrails: {},
      billingCode: "auto:dependabot-pr-agent",
      actions: [],
    },
  },
  {
    id: "fix-failing-ci",
    name: "Fix failing CI on a PR",
    description: "When a PR's checks fail, an agent opens the PR's branch, reads the failing checks, fixes them and pushes.",
    group: "Pull requests",
    triggerType: "github.pr_checks_failed",
    whatYouConfigure: ["Branches to watch", "Model"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "Fix failing CI on a PR",
      mode: "fix",
      triggers: [{ type: "github.pr_checks_failed" }],
      trigger: { type: "github.pr_checks_failed" },
      execution: {
        kind: "agent-session",
        laneMode: "pr-branch",
        laneNamePreset: "pr-title-author",
        session: { title: "Fix CI" },
      },
      modelConfig: SONNET,
      prompt:
        "The checks on PR #{{trigger.pr.number}} ({{trigger.pr.title}}) failed. You are on its branch. Read the failing checks (`ade prs checks {{trigger.pr.number}} --text`) and the failed jobs' logs from your CI (for GitHub Actions, `gh run view <run> --log-failed`), find the cause, and fix it with the smallest change. Run the failing checks locally where you can, then commit and push to this branch. Do not skip, disable or weaken a test to make it pass. Do not push when the failure is flaky or outside this PR, or when the last commit on this branch is already a CI fix from this automation and the same check failed again; say so and stop, so a human takes over.",
      toolPalette: ["repo", "git", "github"],
      guardrails: {},
      billingCode: "auto:fix-failing-ci",
      actions: [],
    },
  },
  {
    id: "fix-review-comments",
    name: "Fix review comments",
    description: "When a review asks for changes on a PR, an agent opens the PR's branch, makes the changes and replies to each comment.",
    group: "Pull requests",
    triggerType: "github.pr_review_submitted",
    whatYouConfigure: ["Whose PRs (PR authors)", "Model"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "Fix review comments",
      mode: "fix",
      triggers: [{ type: "github.pr_review_submitted" }],
      trigger: { type: "github.pr_review_submitted" },
      execution: {
        kind: "agent-session",
        laneMode: "pr-branch",
        laneNamePreset: "pr-title-author",
        session: { title: "Review fixes" },
      },
      modelConfig: SONNET,
      prompt:
        "A review was submitted on PR #{{trigger.pr.number}} ({{trigger.pr.title}}). You are on its branch. Read the open review work (`ade prs comments {{trigger.pr.number}}` lists each open thread with its id). If nothing in it asks for a change, or every open thread already has your answer, stop without pushing. Otherwise make each requested change, run the checks for what you touched, then commit and push to this branch. Reply on each thread you acted on with what you changed, or why you did not when a request is unclear or wrong (`ade prs reply {{trigger.pr.number}} --thread <id> --body \"...\"`). Do not resolve threads; the reviewer does.",
      toolPalette: ["repo", "git", "github"],
      guardrails: {},
      billingCode: "auto:fix-review-comments",
      actions: [],
    },
  },
  {
    id: "clean-up-merged-lanes",
    name: "Clean up merged lanes",
    description: "When a lane is merged, delete it and its local branch so the workspace stays tidy.",
    group: "Hygiene",
    triggerType: "lane.merged",
    whatYouConfigure: ["Lane name pattern", "Branch cleanup options"],
    isFlagship: true,
    draft: {
      ...BASE,
      name: "Clean up merged lanes",
      mode: "monitor",
      triggers: [{ type: "lane.merged" }],
      trigger: { type: "lane.merged" },
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [{ type: "delete-lane", laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } }],
        },
      },
      prompt: "",
      toolPalette: ["git"],
      guardrails: {},
      billingCode: "auto:clean-up-merged-lanes",
      actions: [{ type: "delete-lane", laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } }],
      legacyActions: [{ type: "delete-lane", laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } }],
    },
  },

  // ---- Chats ----
  {
    id: "handoff-on-usage-limit",
    name: "Keep going when a model runs out",
    description: "When a chat hits its usage limit, hand it to another model so the work carries on.",
    group: "Chats",
    triggerType: "session.limit_reached",
    whatYouConfigure: ["Model to switch to", "Fork or brief"],
    draft: {
      ...BASE,
      name: "Keep going when a model runs out",
      mode: "monitor",
      triggers: [{ type: "session.limit_reached" }],
      trigger: { type: "session.limit_reached" },
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [{ type: "handoff", handoffMode: "brief", targetModelId: "openai/gpt-5.5", targetLaneMode: "same" }],
        },
      },
      prompt: "",
      toolPalette: ["repo"],
      guardrails: {},
      billingCode: "auto:handoff-on-usage-limit",
      actions: [{ type: "handoff", handoffMode: "brief", targetModelId: "openai/gpt-5.5", targetLaneMode: "same" }],
    },
  },
  {
    id: "finished-chat-draft-pr",
    name: "Finished chat → draft PR",
    description: "When a chat ends with changes but no PR, an agent writes the title and description and opens a draft PR from its lane.",
    group: "Chats",
    triggerType: "session.ended_without_pr",
    whatYouConfigure: ["Base branch", "Model"],
    draft: {
      ...BASE,
      name: "Finished chat → draft PR",
      mode: "fix",
      triggers: [{ type: "session.ended_without_pr" }],
      trigger: { type: "session.ended_without_pr" },
      execution: {
        kind: "agent-session",
        laneMode: "require-on-trigger",
        session: { title: "Draft PR" },
      },
      modelConfig: SONNET,
      prompt:
        "A chat in this lane ended with work and no pull request. Look at what the lane changed against its base branch. If there is nothing worth a PR (no meaningful commits and no meaningful uncommitted changes, only scratch files), stop and say so. Otherwise commit anything left uncommitted that belongs with the work, push the branch, open the PR (`ade prs create --lane <this lane> --title \"...\" --body-file pr.md`) and mark it a draft (`ade prs draft <pr>`). Write a plain title and a short description: what changed, why, and how it was checked. Do not change the code itself.",
      toolPalette: ["repo", "git", "github"],
      outputs: { disposition: "open-pr-draft", createArtifact: true },
      guardrails: {},
      billingCode: "auto:finished-chat-draft-pr",
      actions: [],
    },
  },

  // ---- Agent workflows ----
  {
    id: "pr-comment-responder",
    name: "PR comment responder",
    description: "When someone comments on a PR, spin up a reply thread scoped to the comment.",
    group: "Agent workflows",
    triggerType: "github.pr_commented",
    whatYouConfigure: ["Repository", "Reply prompt"],
    draft: {
      ...BASE,
      name: "PR comment responder",
      triggers: [{ type: "github.pr_commented" }],
      trigger: { type: "github.pr_commented" },
      execution: { kind: "agent-session", session: { title: "PR comment reply" } },
      modelConfig: SONNET,
      prompt:
        "A reviewer commented on the PR. Address their feedback concretely. If it needs a code change, outline the change; otherwise answer directly.",
      toolPalette: ["repo", "git", "github"],
      guardrails: {},
      billingCode: "auto:pr-comment-responder",
      actions: [],
    },
  },
  {
    id: "weekly-linear-project-update",
    name: "Weekly Linear project update",
    description: "Every Friday afternoon, an agent writes a short status post on your Linear project from this week's lanes, PRs and merges.",
    group: "Agent workflows",
    triggerType: "schedule",
    whatYouConfigure: ["Linear project id", "Schedule", "Model"],
    draft: {
      ...BASE,
      name: "Weekly Linear project update",
      triggers: [{ type: "schedule", cron: "0 16 * * 5" }],
      trigger: { type: "schedule", cron: "0 16 * * 5" },
      execution: { kind: "agent-session", session: { title: "Linear project update" } },
      modelConfig: SONNET,
      prompt: [
        "Write this week's status update for the Linear project <PROJECT_ID>.",
        "Use ADE's own record: lanes linked to that project's issues, their PRs, what merged, what is in review, and what is blocked (`ade lanes list`, `ade prs list`, `ade linear search-issues --project-id <PROJECT_ID>`).",
        "Keep it short: Shipped, In review, Blocked, Next, each with issue ids and PR links. Choose a health: on-track, at-risk or off-track.",
        "Post it with `ade linear project-update --project <PROJECT_ID> --health <health> --body \"<markdown>\"`.",
      ].join("\n"),
      toolPalette: ["repo", "git", "linear"],
      guardrails: {},
      billingCode: "auto:weekly-linear-project-update",
      actions: [],
    },
  },

  // ---- Issue intake ----
  {
    id: "auto-label-issue",
    name: "Auto-label new issues",
    description: "Add a 'needs-triage' label to every newly opened issue, no human in the loop.",
    group: "Issue intake",
    triggerType: "github.issue_opened",
    whatYouConfigure: ["Repository", "Labels to add"],
    draft: {
      ...BASE,
      name: "Auto-label new issues",
      mode: "monitor",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [
            {
              type: "ade-action",
              adeAction: {
                domain: "issue",
                action: "setLabels",
                args: { number: 0, labels: ["needs-triage"] },
                resolvers: { number: "trigger.issue.number" },
              },
            },
          ],
        },
      },
      prompt: "",
      toolPalette: ["github"],
      guardrails: {},
      billingCode: "auto:auto-label-issue",
      actions: [
        {
          type: "ade-action",
          adeAction: {
            domain: "issue",
            action: "setLabels",
            args: { number: 0, labels: ["needs-triage"] },
            resolvers: { number: "trigger.issue.number" },
          },
        },
      ],
    },
  },

  // ---- Hygiene ----
  {
    id: "push-conflict-scan",
    name: "Push conflict scan",
    description: "Predict merge-conflict risk whenever a push lands on main.",
    group: "Hygiene",
    triggerType: "git.push",
    whatYouConfigure: ["Branch"],
    draft: {
      ...BASE,
      name: "Push conflict scan",
      mode: "monitor",
      triggers: [{ type: "git.push", branch: "main" }],
      trigger: { type: "git.push", branch: "main" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "predict-conflicts" }] } },
      prompt: "",
      toolPalette: ["git"],
      guardrails: {},
      billingCode: "auto:push-conflict-scan",
      actions: [{ type: "predict-conflicts" }],
    },
  },
];


export const TEMPLATE_GROUPS: Array<{ title: string; templates: AutomationTemplate[] }> = GROUP_ORDER.map(
  (title) => ({ title, templates: TEMPLATES.filter((t) => t.group === title) }),
).filter((group) => group.templates.length > 0);

export const FLAGSHIP_TEMPLATES: AutomationTemplate[] = TEMPLATES.filter((t) => t.isFlagship);

const LINEAR_AGENT_RULE_PROMPT = [
  defaultKickoffPrompt(),
  "",
  "You were started from Linear. Keep the person who asked informed: when you need a decision, ask it as a question (they answer in Linear); when you finish, end with a short summary of what changed and the PR link.",
].join("\n");

/** The rule Settings → Linear → ADE agent creates for delegations or mentions. */
export function buildLinearAgentRuleDraft(args: {
  name: string;
  trigger: "linear.agent_delegated" | "linear.agent_mentioned";
  laneMode: "create" | "reuse";
  modelConfig: ModelConfig;
  permissionConfig: AiPermissionSettings | undefined;
}): AutomationRuleDraft {
  const trigger = { type: args.trigger } as const;
  return {
    name: args.name,
    description: args.trigger === "linear.agent_delegated"
      ? "Runs when a Linear delegation to ADE reaches this ADE."
      : "Answers when an @ADE mention in Linear reaches this ADE.",
    enabled: true,
    mode: args.trigger === "linear.agent_delegated" ? "fix" : "monitor",
    triggers: [trigger],
    trigger,
    execution: { kind: "agent-session", laneMode: args.laneMode, session: {} },
    executor: { mode: "automation-bot" },
    modelConfig: args.modelConfig,
    ...(args.permissionConfig ? { permissionConfig: args.permissionConfig } : {}),
    prompt: args.trigger === "linear.agent_delegated"
      ? LINEAR_AGENT_RULE_PROMPT
      : "Answer the question in the mention. Read code as needed, but do not change files unless they ask you to.",
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:linear-agent",
    actions: [],
    legacyActions: [],
  };
}
