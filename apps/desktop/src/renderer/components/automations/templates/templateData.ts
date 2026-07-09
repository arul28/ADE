/**
 * Parameterized template playbooks. Each seeds the builder with a valid
 * `AutomationRuleDraft` plus a short "what you'll configure" list. Grouped for
 * the gallery; the flagship subset is featured in the empty state.
 */

import type { AutomationRuleDraft } from "../../../../shared/types";

export type AutomationTemplate = {
  id: string;
  name: string;
  description: string;
  group: string;
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
const SONNET_HIGH = { modelId: "anthropic/claude-sonnet-5", thinkingLevel: "high" as const };

export const TEMPLATES: AutomationTemplate[] = [
  // ---- Flagship 1 ----
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
      guardrails: { maxDurationMin: 20 },
      billingCode: "auto:daily-agent-task",
      actions: [],
    },
  },
  // ---- Flagship 2 ----
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
      guardrails: { maxDurationMin: 30 },
      billingCode: "auto:linear-issue-lane-agent",
      actions: [],
    },
  },
  // ---- Flagship 3 ----
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
      guardrails: { maxDurationMin: 30 },
      billingCode: "auto:github-issue-lane-agent",
      actions: [],
    },
  },
  // ---- Flagship 4 ----
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
      guardrails: { maxDurationMin: 5 },
      billingCode: "auto:clean-up-merged-lanes",
      actions: [{ type: "delete-lane", laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } }],
      legacyActions: [{ type: "delete-lane", laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false } }],
    },
  },

  // ---- Agent workflows ----
  {
    id: "pr-review-session",
    name: "PR review session",
    description: "Open an agent review thread whenever a PR opens against main. Focuses on risk and missing tests.",
    group: "Agent workflows",
    triggerType: "github.pr_opened",
    whatYouConfigure: ["Base branch", "Review prompt", "Model"],
    draft: {
      ...BASE,
      name: "PR review session",
      // `branch` matches the PR head branch; the base-branch filter is
      // `targetBranch`, left unset so the template fires on every PR until
      // the user narrows it.
      triggers: [{ type: "github.pr_opened" }],
      trigger: { type: "github.pr_opened" },
      execution: { kind: "agent-session", session: { title: "PR review" } },
      modelConfig: SONNET_HIGH,
      prompt:
        "Review this pull request. Cite concrete risks and missing tests; skip filler. Reference file paths and checks that support each finding.",
      toolPalette: ["repo", "git", "github"],
      guardrails: { maxDurationMin: 20 },
      billingCode: "auto:pr-review-session",
      actions: [],
    },
  },
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
      guardrails: { maxDurationMin: 15 },
      billingCode: "auto:pr-comment-responder",
      actions: [],
    },
  },
  {
    id: "daily-agent-brief",
    name: "Daily agent brief",
    description: "Every weekday morning, summarize repo activity and likely follow-ups into a thread.",
    group: "Agent workflows",
    triggerType: "schedule",
    whatYouConfigure: ["Schedule", "Brief prompt"],
    draft: {
      ...BASE,
      name: "Daily agent brief",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      execution: { kind: "agent-session", session: { title: "Daily brief" } },
      modelConfig: SONNET,
      prompt:
        "Summarize the most important repo activity since yesterday's brief. Keep it concise, concrete, and oriented around what the team should know next.",
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:daily-agent-brief",
      actions: [],
    },
  },

  // ---- Issue intake ----
  {
    id: "issue-triage",
    name: "Issue triage agent",
    description: "When a new issue opens, draft a triage comment: likely owner, severity, and a reproduction question.",
    group: "Issue intake",
    triggerType: "github.issue_opened",
    whatYouConfigure: ["Repository / labels", "Triage prompt"],
    draft: {
      ...BASE,
      name: "Issue triage agent",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: { kind: "agent-session", session: { title: "Issue triage" } },
      modelConfig: SONNET,
      prompt:
        "Triage this new issue. Identify the likely owner/area, suggest a severity, and ask one sharp reproduction question if anything is missing.",
      toolPalette: ["repo", "git", "github"],
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:issue-triage",
      actions: [],
    },
  },
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
      guardrails: { maxDurationMin: 2 },
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
  {
    id: "linear-label-triage",
    name: "Linear label triage",
    description: "When an 'agent' label is added to a Linear issue, post a triage comment recommending next steps.",
    group: "Issue intake",
    triggerType: "linear.issue_labeled",
    whatYouConfigure: ["Label to watch", "Comment prompt"],
    draft: {
      ...BASE,
      name: "Linear label triage",
      mode: "monitor",
      triggers: [{ type: "linear.issue_labeled", labels: ["agent"] }],
      trigger: { type: "linear.issue_labeled", labels: ["agent"] },
      execution: { kind: "agent-session", session: { title: "Linear triage" } },
      modelConfig: SONNET,
      prompt:
        "This Linear issue was just labeled for agent attention. Post a short triage comment: likely owner, a severity guess, and the next concrete step.",
      toolPalette: ["linear"],
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:linear-label-triage",
      actions: [],
    },
  },

  // ---- Hygiene ----
  {
    id: "stale-issue-closer",
    name: "Stale issue closer",
    description: "Nightly pass that closes issues idle 60+ days with an explanatory comment.",
    group: "Hygiene",
    triggerType: "schedule",
    whatYouConfigure: ["Schedule", "Idle threshold prompt"],
    draft: {
      ...BASE,
      name: "Stale issue closer",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 3 * * *" }],
      trigger: { type: "schedule", cron: "0 3 * * *" },
      execution: { kind: "agent-session", session: { title: "Stale issue sweep" } },
      modelConfig: SONNET,
      prompt:
        "Scan open issues. For each idle for 60+ days with no owner signal, post a short explanatory comment and close it. Keep comments courteous.",
      toolPalette: ["github"],
      guardrails: { maxDurationMin: 25 },
      billingCode: "auto:stale-issue-closer",
      actions: [],
    },
  },
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
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:push-conflict-scan",
      actions: [{ type: "predict-conflicts" }],
    },
  },
  {
    id: "label-welcome",
    name: "Label welcome comment",
    description: "When an issue receives a label, post a short automated welcome with repro steps and doc links.",
    group: "Hygiene",
    triggerType: "github.issue_labeled",
    whatYouConfigure: ["Label", "Welcome prompt"],
    draft: {
      ...BASE,
      name: "Label welcome comment",
      mode: "monitor",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "agent-session", session: { title: "Label welcome" } },
      modelConfig: SONNET,
      prompt:
        "A label was just added to this issue. Post a short, friendly comment linking repro steps and the most relevant doc section. Keep it under 5 sentences.",
      toolPalette: ["github"],
      guardrails: { maxDurationMin: 5 },
      billingCode: "auto:label-welcome",
      actions: [],
    },
  },

  // ---- CI & tests ----
  {
    id: "nightly-test-sweep",
    name: "Nightly test sweep",
    description: "Run the built-in test suite on a cron. No chat thread, just deterministic checks.",
    group: "CI & tests",
    triggerType: "schedule",
    whatYouConfigure: ["Schedule", "Test suite"],
    draft: {
      ...BASE,
      name: "Nightly test sweep",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 2 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 2 * * 1-5" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "run-tests", suiteId: "" }] } },
      prompt: "",
      toolPalette: ["tests"],
      guardrails: { maxDurationMin: 30 },
      billingCode: "auto:nightly-test-sweep",
      actions: [{ type: "run-tests", suite: "" }],
    },
  },
];

export const GROUP_ORDER = ["Agent workflows", "Issue intake", "Hygiene", "CI & tests"];

export const TEMPLATE_GROUPS: Array<{ title: string; templates: AutomationTemplate[] }> = GROUP_ORDER.map(
  (title) => ({ title, templates: TEMPLATES.filter((t) => t.group === title) }),
).filter((group) => group.templates.length > 0);

export const FLAGSHIP_TEMPLATES: AutomationTemplate[] = TEMPLATES.filter((t) => t.isFlagship);
