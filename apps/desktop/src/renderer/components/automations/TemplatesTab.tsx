import {
  Bug,
  ChatCircleText,
  GitPullRequest,
  ShieldCheck,
  TestTube,
} from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { TemplateCard, type AutomationTemplate } from "./components/TemplateCard";

const TEMPLATES: Array<AutomationTemplate & { draft: Omit<AutomationRuleDraft, "id"> }> = [
  {
    id: "daily-agent-brief",
    name: "Daily agent brief",
    description: "Send a prompt to an automation-only chat thread every weekday morning to summarize repo activity and likely follow-ups.",
    triggerType: "schedule",
    actionSummary: "agent session",
    icon: ChatCircleText,
    draft: {
      name: "Daily agent brief",
      enabled: true,
      description: "Create a concise weekday brief that summarizes repo activity, risks, and obvious next actions.",
      mode: "review",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      execution: { kind: "agent-session", session: { title: "Daily brief" } },
      executor: { mode: "automation-bot" },
      modelConfig: {
        orchestratorModel: {
          modelId: "anthropic/claude-sonnet-4-6",
          thinkingLevel: "medium",
        },
      },
      prompt: "Summarize the most important repo activity since the last weekday brief. Keep it concise, concrete, and oriented around what the team should know next.",
      reviewProfile: "quick",
      toolPalette: ["repo", "git", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxDurationMin: 10 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:daily-agent-brief",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "pr-review-session",
    name: "PR review session",
    description: "When a pull request opens, send a focused review prompt to an automation-only chat thread and keep the transcript in Automations history.",
    triggerType: "git.pr_opened",
    actionSummary: "agent session",
    icon: GitPullRequest,
    draft: {
      name: "PR review session",
      enabled: true,
      description: "Review new PRs for concrete risk, missing tests, and release impact.",
      mode: "review",
      triggers: [{ type: "git.pr_opened", branch: "main" }],
      trigger: { type: "git.pr_opened", branch: "main" },
      execution: { kind: "agent-session", session: { title: "PR review" } },
      executor: { mode: "automation-bot" },
      modelConfig: {
        orchestratorModel: {
          modelId: "anthropic/claude-sonnet-4-6",
          thinkingLevel: "high",
        },
      },
      prompt: "Review the pull request for risky changes, missing tests, and release impact. Report only concrete findings and cite the files or checks that support them.",
      reviewProfile: "full",
      toolPalette: ["repo", "git", "github", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { confidenceThreshold: 0.7, maxDurationMin: 20 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:pr-review-session",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "linear-triage-mission",
    name: "Linear triage mission",
    description: "Launch a mission when new Linear issues arrive so ADE can do a deeper triage pass with mission-level tooling and permissions.",
    triggerType: "linear.issue_created",
    actionSummary: "mission",
    icon: ShieldCheck,
    draft: {
      name: "Linear triage mission",
      enabled: true,
      description: "Launch a mission to triage new Linear issues with ownership and severity guidance.",
      mode: "review",
      triggers: [{ type: "linear.issue_created", team: "ENG" }],
      trigger: { type: "linear.issue_created", team: "ENG" },
      execution: { kind: "mission", mission: { title: "Linear triage" } },
      executor: { mode: "automation-bot" },
      modelConfig: {
        orchestratorModel: {
          modelId: "anthropic/claude-sonnet-4-6",
          thinkingLevel: "high",
        },
      },
      prompt: "Triage the new Linear issue. Recommend likely owner, severity, and next action. Use the mission to gather enough context before deciding.",
      reviewProfile: "quick",
      toolPalette: ["linear", "repo", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxDurationMin: 25 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:linear-triage-mission",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "nightly-test-sweep",
    name: "Nightly test sweep",
    description: "Run a built-in test suite on a schedule without starting a mission or an agent chat thread.",
    triggerType: "schedule",
    actionSummary: "built-in tasks",
    icon: TestTube,
    draft: {
      name: "Nightly test sweep",
      enabled: true,
      description: "Run a nightly built-in test sweep on weekdays.",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 2 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 2 * * 1-5" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "run-tests", suiteId: "" }] } },
      executor: { mode: "automation-bot" },
      prompt: "",
      reviewProfile: "quick",
      toolPalette: ["tests"],
      contextSources: [{ type: "project-memory" }],
      memory: { mode: "project" },
      guardrails: { maxDurationMin: 30 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:nightly-test-sweep",
      actions: [{ type: "run-tests", suite: "" }],
      legacyActions: [{ type: "run-tests", suite: "" }],
    },
  },
  {
    id: "push-conflict-scan",
    name: "Push conflict scan",
    description: "Run a built-in conflict prediction task whenever a push lands on the default branch.",
    triggerType: "git.push",
    actionSummary: "built-in tasks",
    icon: Bug,
    draft: {
      name: "Push conflict scan",
      enabled: true,
      description: "Predict conflict risk after pushes on main.",
      mode: "monitor",
      triggers: [{ type: "git.push", branch: "main" }],
      trigger: { type: "git.push", branch: "main" },
      execution: { kind: "built-in", builtIn: { actions: [{ type: "predict-conflicts" }] } },
      executor: { mode: "automation-bot" },
      prompt: "",
      reviewProfile: "quick",
      toolPalette: ["git"],
      contextSources: [{ type: "project-memory" }],
      memory: { mode: "project" },
      guardrails: { maxDurationMin: 10 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:push-conflict-scan",
      actions: [{ type: "predict-conflicts" }],
      legacyActions: [{ type: "predict-conflicts" }],
    },
  },
];

export function TemplatesTab({
  onUseTemplate,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
}) {
  return (
    <div className="h-full overflow-y-auto px-6 py-6" style={{ background: "#0F0D14" }}>
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <div className="text-lg font-semibold text-[#FAFAFA]">Templates</div>
          <div className="mt-2 text-sm leading-6 text-[#9A96B2]">
            Start from a clean schedule or event-driven pattern. Templates follow the new Automations model: one trigger, one execution kind, and clear history inside Automations.
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onUse={() => onUseTemplate(template.draft)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
