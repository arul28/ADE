import {
  Bug,
  ChatCircleText,
  ClockCounterClockwise,
  GitPullRequest,
  Lightning,
  ShieldCheck,
  Tag,
  TestTube,
  UserCircle,
  Warning,
} from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { TemplateCard, type AutomationTemplate } from "./components/TemplateCard";

type TemplateDefinition = AutomationTemplate & { draft: Omit<AutomationRuleDraft, "id"> };

const DEFAULT_MODEL = {
  orchestratorModel: {
    modelId: "anthropic/claude-sonnet-4-6" as const,
    thinkingLevel: "medium" as const,
  },
};

const DEFAULT_MODEL_HIGH = {
  orchestratorModel: {
    modelId: "anthropic/claude-sonnet-4-6" as const,
    thinkingLevel: "high" as const,
  },
};

const BASE_DRAFT: Pick<
  Omit<AutomationRuleDraft, "id">,
  "enabled"
  | "mode"
  | "executor"
  | "reviewProfile"
  | "toolPalette"
  | "contextSources"
  | "memory"
  | "outputs"
  | "verification"
  | "legacyActions"
> = {
  enabled: true,
  mode: "review",
  executor: { mode: "automation-bot" },
  reviewProfile: "quick",
  toolPalette: ["repo", "git", "memory"],
  contextSources: [{ type: "project-memory" }],
  memory: { mode: "automation-plus-project" },
  outputs: { disposition: "comment-only", createArtifact: true },
  verification: { verifyBeforePublish: false, mode: "intervention" },
  legacyActions: [],
};

const TEMPLATES: TemplateDefinition[] = [
  {
    id: "pr-review-session",
    name: "PR review session",
    description:
      "Open an agent review thread whenever a PR opens against main. Focuses on risk, missing tests, and release impact.",
    triggerType: "github.pr_opened",
    actionSummary: "agent session",
    icon: GitPullRequest,
    draft: {
      ...BASE_DRAFT,
      name: "PR review session",
      triggers: [{ type: "github.pr_opened", branch: "main" }],
      trigger: { type: "github.pr_opened", branch: "main" },
      execution: { kind: "agent-session", session: { title: "PR review" } },
      modelConfig: DEFAULT_MODEL_HIGH,
      prompt:
        "Review this pull request. Cite concrete risks and missing tests; skip filler. Reference file paths and checks that support each finding.",
      toolPalette: ["repo", "git", "github", "memory"],
      guardrails: { maxDurationMin: 20 },
      billingCode: "auto:pr-review-session",
      actions: [],
    },
  },
  {
    id: "issue-triage",
    name: "Issue triage agent",
    description:
      "When a new issue opens, ADE drafts a triage comment: likely area owner, severity guess, and a first reproduction question.",
    triggerType: "github.issue_opened",
    actionSummary: "agent session",
    icon: Warning,
    draft: {
      ...BASE_DRAFT,
      name: "Issue triage agent",
      triggers: [{ type: "github.issue_opened" }],
      trigger: { type: "github.issue_opened" },
      execution: { kind: "agent-session", session: { title: "Issue triage" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "Triage this new issue. Identify the likely owner/area, suggest a severity, and ask one sharp reproduction question if anything is missing.",
      toolPalette: ["repo", "git", "github", "memory"],
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:issue-triage",
      actions: [],
    },
  },
  {
    id: "auto-label-issue",
    name: "Auto-label new issues",
    description:
      "Add a 'needs-triage' label to every newly opened issue so it shows up in the triage queue without a human in the loop.",
    triggerType: "github.issue_opened",
    actionSummary: "ade-action · issue.setLabels",
    icon: Tag,
    draft: {
      ...BASE_DRAFT,
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
      modelConfig: DEFAULT_MODEL,
      prompt: "",
      toolPalette: ["github"],
      contextSources: [],
      memory: { mode: "none" },
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
    id: "stale-issue-closer",
    name: "Stale issue closer",
    description:
      "Nightly pass that scans open issues and closes anything idle for 60+ days with an explanatory comment. Runs on a cron.",
    triggerType: "schedule",
    actionSummary: "agent session",
    icon: ClockCounterClockwise,
    draft: {
      ...BASE_DRAFT,
      name: "Stale issue closer",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 3 * * *" }],
      trigger: { type: "schedule", cron: "0 3 * * *" },
      execution: { kind: "agent-session", session: { title: "Stale issue sweep" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "Scan open issues. For each issue idle for 60+ days with no owner signal, post a short explanatory comment and close it. Keep comments courteous.",
      toolPalette: ["github", "memory"],
      guardrails: { maxDurationMin: 25 },
      billingCode: "auto:stale-issue-closer",
      actions: [],
    },
  },
  {
    id: "daily-agent-brief",
    name: "Daily agent brief",
    description:
      "Every weekday morning at 9am, summarize repo activity and likely follow-ups into an automation thread.",
    triggerType: "schedule",
    actionSummary: "agent session",
    icon: ChatCircleText,
    draft: {
      ...BASE_DRAFT,
      name: "Daily agent brief",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      execution: { kind: "agent-session", session: { title: "Daily brief" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "Summarize the most important repo activity since yesterday's brief. Keep it concise, concrete, and oriented around what the team should know next.",
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:daily-agent-brief",
      actions: [],
    },
  },
  {
    id: "nightly-test-sweep",
    name: "Nightly test sweep",
    description:
      "Run the built-in test suite on a cron. No chat thread, no mission — just deterministic checks against main.",
    triggerType: "schedule",
    actionSummary: "built-in · run-tests",
    icon: TestTube,
    draft: {
      ...BASE_DRAFT,
      name: "Nightly test sweep",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 2 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 2 * * 1-5" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "run-tests", suiteId: "" }] } },
      prompt: "",
      toolPalette: ["tests"],
      memory: { mode: "project" },
      guardrails: { maxDurationMin: 30 },
      billingCode: "auto:nightly-test-sweep",
      actions: [{ type: "run-tests", suite: "" }],
      legacyActions: [{ type: "run-tests", suite: "" }],
    },
  },
  {
    id: "push-conflict-scan",
    name: "Push conflict scan",
    description:
      "Predict merge-conflict risk whenever a push lands on main. Surfaces lanes most likely to hit conflicts.",
    triggerType: "git.push",
    actionSummary: "built-in · predict-conflicts",
    icon: Bug,
    draft: {
      ...BASE_DRAFT,
      name: "Push conflict scan",
      mode: "monitor",
      triggers: [{ type: "git.push", branch: "main" }],
      trigger: { type: "git.push", branch: "main" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "predict-conflicts" }] } },
      prompt: "",
      toolPalette: ["git"],
      memory: { mode: "project" },
      guardrails: { maxDurationMin: 10 },
      billingCode: "auto:push-conflict-scan",
      actions: [{ type: "predict-conflicts" }],
      legacyActions: [{ type: "predict-conflicts" }],
    },
  },
  {
    id: "linear-intake",
    name: "Linear intake triage",
    description:
      "When a new Linear issue lands in a watched team, run a focused triage thread to recommend owner, severity, and next step.",
    triggerType: "linear.issue_created",
    actionSummary: "agent session",
    icon: ShieldCheck,
    draft: {
      ...BASE_DRAFT,
      name: "Linear intake triage",
      triggers: [{ type: "linear.issue_created", team: "ENG" }],
      trigger: { type: "linear.issue_created", team: "ENG" },
      execution: { kind: "agent-session", session: { title: "Linear triage" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "Triage this new Linear issue. Recommend likely owner, severity, and next step. Use linked project memory for context.",
      toolPalette: ["linear", "repo", "memory"],
      guardrails: { maxDurationMin: 15 },
      billingCode: "auto:linear-intake",
      actions: [],
    },
  },
  {
    id: "pr-comment-responder",
    name: "PR comment responder",
    description:
      "When someone comments on a PR, spin up a reply thread scoped to the comment so ADE can address the feedback inline.",
    triggerType: "github.pr_commented",
    actionSummary: "agent session",
    icon: Lightning,
    draft: {
      ...BASE_DRAFT,
      name: "PR comment responder",
      triggers: [{ type: "github.pr_commented" }],
      trigger: { type: "github.pr_commented" },
      execution: { kind: "agent-session", session: { title: "PR comment reply" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "A reviewer commented on the PR. Address their feedback concretely. If it needs a code change, outline the change; otherwise answer directly.",
      toolPalette: ["repo", "git", "github", "memory"],
      guardrails: { maxDurationMin: 15 },
      billingCode: "auto:pr-comment-responder",
      actions: [],
    },
  },
  {
    id: "assignee-welcome",
    name: "Label welcome comment",
    description:
      "When an issue receives a label, post a short automated welcome with repro steps and relevant doc links.",
    triggerType: "github.issue_labeled",
    actionSummary: "agent session",
    icon: UserCircle,
    draft: {
      ...BASE_DRAFT,
      name: "Label welcome comment",
      mode: "monitor",
      triggers: [{ type: "github.issue_labeled" }],
      trigger: { type: "github.issue_labeled" },
      execution: { kind: "agent-session", session: { title: "Label welcome" } },
      modelConfig: DEFAULT_MODEL,
      prompt:
        "A label was just added to this issue. Post a short, friendly comment linking repro steps and the most relevant doc section. Keep it under 5 sentences.",
      toolPalette: ["github", "memory"],
      guardrails: { maxDurationMin: 5 },
      billingCode: "auto:assignee-welcome",
      actions: [],
    },
  },
];

export function TemplatesTab({
  onUseTemplate,
  missionsEnabled,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
  missionsEnabled: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto px-6 py-6" style={{ background: "#0F0D14" }}>
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <div className="text-lg font-semibold text-[#FAFAFA]">Start from a template</div>
          <div className="mt-2 text-sm leading-6 text-[#9A96B2]">
            Every template sets one trigger and a starter action list. Edit the name, filters, and prompt once the rule is in your list.
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.map((template) => {
            const disabled = template.draft.execution?.kind === "mission" && !missionsEnabled;
            return (
              <TemplateCard
                key={template.id}
                template={template}
                disabled={disabled}
                disabledReason={disabled ? "Mission automations are coming soon in production builds." : undefined}
                onUse={() => onUseTemplate(template.draft)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
