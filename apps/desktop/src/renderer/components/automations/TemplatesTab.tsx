import { useState } from "react";
import {
  ShieldCheck,
  TestTube,
  Bug,
  CheckSquare,
  Wrench,
  PencilSimple,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { TemplateCard, type AutomationTemplate } from "./components/TemplateCard";

const TEMPLATES: (AutomationTemplate & { draft: Omit<AutomationRuleDraft, "id"> })[] = [
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Scan for vulnerabilities on every push to main. Runs dependency audit and SAST checks.",
    triggerType: "commit",
    actionSummary: "run-command: security audit",
    icon: ShieldCheck,
    draft: {
      name: "Security Audit on Push",
      enabled: true,
      description: "Review security-sensitive changes and stop before publishing external side effects.",
      mode: "review",
      triggers: [{ type: "commit", branch: "main" }],
      trigger: { type: "commit", branch: "main" },
      executor: { mode: "automation-bot" },
      prompt: "Run a security-focused review over the latest changes, highlight only high-confidence issues, and summarize release risk.",
      reviewProfile: "security",
      toolPalette: ["repo", "git", "tests", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }, { type: "skills" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { confidenceThreshold: 0.72, maxFindings: 8 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: true, mode: "intervention" },
      billingCode: "auto:security-audit",
      actions: [{ type: "run-command", command: "npm audit --audit-level=high && npx semgrep --config=auto ." } as any],
      legacyActions: [{ type: "run-command", command: "npm audit --audit-level=high && npx semgrep --config=auto ." } as any],
    },
  },
  {
    id: "test-coverage",
    name: "Test Coverage Sweep",
    description: "Run the full test suite after each session ends. Catch regressions early.",
    triggerType: "session-end",
    actionSummary: "run-tests",
    icon: TestTube,
    draft: {
      name: "Post-Session Test Sweep",
      enabled: true,
      description: "Monitor session-end health and surface regressions quickly.",
      mode: "monitor",
      triggers: [{ type: "session-end" }],
      trigger: { type: "session-end" },
      executor: { mode: "automation-bot" },
      prompt: "Check the latest session changes, run the default quality sweep, and summarize whether follow-up work is needed.",
      reviewProfile: "incremental",
      toolPalette: ["repo", "tests", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxFindings: 5 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:test-sweep",
      actions: [{ type: "run-tests", suite: "" } as any],
      legacyActions: [{ type: "run-tests", suite: "" } as any],
    },
  },
  {
    id: "bug-triage",
    name: "Bug Triage",
    description: "Predict merge conflicts on every commit and route actionable follow-up early.",
    triggerType: "commit",
    actionSummary: "predict-conflicts",
    icon: Bug,
    draft: {
      name: "Bug Triage on Commit",
      enabled: true,
      description: "Review commits for likely breakage and queue actionable work.",
      mode: "review",
      triggers: [{ type: "commit" }],
      trigger: { type: "commit" },
      executor: { mode: "cto-route" },
      prompt: "Triage the latest commit for high-signal bugs, conflict risk, and follow-up work. Route actionable findings clearly.",
      reviewProfile: "quick",
      toolPalette: ["repo", "git", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxFindings: 6 },
      outputs: { disposition: "open-task", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:bug-triage",
      actions: [{ type: "predict-conflicts" } as any],
      legacyActions: [{ type: "predict-conflicts" } as any],
    },
  },
  {
    id: "pr-reviewer",
    name: "PR Reviewer",
    description: "Review each newly opened PR for missing tests, risky changes, and clear follow-up guidance.",
    triggerType: "git.pr_opened",
    actionSummary: "mission-powered PR review",
    icon: ShieldCheck,
    draft: {
      name: "PR Reviewer",
      enabled: true,
      description: "Run a focused PR review when a lane opens a new pull request.",
      mode: "review",
      triggers: [{ type: "git.pr_opened", branch: "feat/*", draftState: "any" }],
      trigger: { type: "git.pr_opened", branch: "feat/*", draftState: "any" },
      executor: { mode: "automation-bot" },
      prompt: "A PR was just opened. Review the diff for risky changes, missing tests, and release notes impact. Summarize only concrete findings and cite files or checks.",
      reviewProfile: "full",
      toolPalette: ["repo", "git", "github", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }, { type: "skills" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { confidenceThreshold: 0.7, maxFindings: 8 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: true, mode: "intervention" },
      billingCode: "auto:pr-reviewer",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "routine-tasks",
    name: "Routine Tasks",
    description: "Scheduled weekday sweep for regressions and conflict risk.",
    triggerType: "schedule",
    actionSummary: "run-tests, predict-conflicts",
    icon: CheckSquare,
    draft: {
      name: "Daily Routine (9 AM)",
      enabled: true,
      description: "Nightly sweep for release readiness, regressions, and follow-up recommendations.",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      executor: { mode: "night-shift" },
      prompt: "Run a routine daily sweep, summarize noteworthy regressions, and queue anything better handled overnight.",
      reviewProfile: "full",
      toolPalette: ["repo", "git", "tests", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }, { type: "skills" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { reserveBudget: true, maxFindings: 10 },
      outputs: { disposition: "queue-overnight", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:daily-routine",
      actions: [
        { type: "run-tests", suite: "" } as any,
        { type: "predict-conflicts" } as any,
      ],
      legacyActions: [
        { type: "run-tests", suite: "" } as any,
        { type: "predict-conflicts" } as any,
      ],
    },
  },
  {
    id: "daily-standup",
    name: "Daily Standup",
    description: "Weekday summary of yesterday's repo activity with links, risks, and clear talking points.",
    triggerType: "schedule",
    actionSummary: "weekday status report",
    icon: CheckSquare,
    draft: {
      name: "Daily Standup Summary",
      enabled: true,
      description: "Summarize yesterday's git activity for standup without speculation.",
      mode: "monitor",
      triggers: [{ type: "schedule", cron: "0 9 * * 1-5" }],
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      executor: { mode: "automation-bot" },
      prompt: "Summarize yesterday's repo activity for standup. Anchor every statement to commits, PRs, or files. Keep it scannable and team-ready.",
      reviewProfile: "quick",
      toolPalette: ["repo", "git", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxFindings: 6 },
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:daily-standup",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "linear-triager",
    name: "Linear Triager",
    description: "Route newly created issues with priority, owner suggestions, and a clean summary for humans.",
    triggerType: "linear.issue_created",
    actionSummary: "cto-route triage",
    icon: Bug,
    draft: {
      name: "Linear Triager",
      enabled: true,
      description: "Review new Linear issues and recommend ownership, priority, and next step.",
      mode: "review",
      triggers: [{ type: "linear.issue_created", team: "ENG" }],
      trigger: { type: "linear.issue_created", team: "ENG" },
      executor: { mode: "cto-route" },
      prompt: "A new Linear issue was created. Suggest the right owner, likely priority, and whether it needs immediate action. Be concise and concrete.",
      reviewProfile: "quick",
      toolPalette: ["linear", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { maxFindings: 4 },
      outputs: { disposition: "open-task", createArtifact: true },
      verification: { verifyBeforePublish: true, mode: "intervention" },
      billingCode: "auto:linear-triager",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "session-cleanup",
    name: "Session Cleanup",
    description: "Mission-powered session wrap-up that records follow-up risk and next steps.",
    triggerType: "session-end",
    actionSummary: "mission-powered review",
    icon: Wrench,
    draft: {
      name: "Session Cleanup",
      enabled: true,
      description: "Clean up after sessions and keep project state warm for the next automation.",
      mode: "monitor",
      triggers: [{ type: "session-end" }],
      trigger: { type: "session-end" },
      executor: { mode: "automation-bot" },
      prompt: "Summarize the session end state, refresh context, and note any follow-up risk.",
      reviewProfile: "quick",
      toolPalette: ["repo", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "automation-memory" }],
      memory: { mode: "automation-plus-project" },
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:session-cleanup",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "nightly-dependency-sweep",
    name: "Nightly Dependency Sweep",
    description: "Queue an overnight dependency and changelog sweep after pushes to main.",
    triggerType: "git.push",
    actionSummary: "night shift dependency review",
    icon: Wrench,
    draft: {
      name: "Nightly Dependency Sweep",
      enabled: true,
      description: "After pushes to main, queue a night-shift pass that checks dependencies and release notes impact.",
      mode: "monitor",
      triggers: [{ type: "git.push", branch: "main" }],
      trigger: { type: "git.push", branch: "main" },
      executor: { mode: "night-shift" },
      prompt: "A push landed on main. Review dependency updates, release note impact, and anything that should be queued for the next maintenance window.",
      reviewProfile: "release-risk",
      toolPalette: ["repo", "git", "tests", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }, { type: "skills" }],
      memory: { mode: "automation-plus-project" },
      guardrails: { reserveBudget: true, maxFindings: 6 },
      outputs: { disposition: "queue-overnight", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:nightly-dependency-sweep",
      actions: [],
      legacyActions: [],
    },
  },
  {
    id: "custom",
    name: "Custom Automation",
    description: "Start from scratch. Pick your trigger and build any action pipeline you want.",
    triggerType: "manual",
    actionSummary: "(configure actions)",
    icon: PencilSimple,
    draft: {
      name: "New Custom Rule",
      enabled: false,
      description: "",
      mode: "review",
      triggers: [{ type: "manual" }],
      trigger: { type: "manual" },
      executor: { mode: "automation-bot" },
      prompt: "",
      reviewProfile: "quick",
      toolPalette: ["repo", "memory", "mission"],
      contextSources: [{ type: "project-memory" }, { type: "procedures" }],
      memory: { mode: "automation-plus-project" },
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false, mode: "intervention" },
      billingCode: "auto:custom",
      actions: [],
      legacyActions: [],
    },
  },
];

export function TemplatesTab({
  onUseTemplate,
}: {
  onUseTemplate: (draft: Omit<AutomationRuleDraft, "id">) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="h-full overflow-y-auto p-6"
      style={{ background: "#0F0D14" }}
    >
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <div
            className="text-[16px] font-bold text-[#FAFAFA] tracking-[-0.4px]"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Templates
          </div>
          <div className="mt-1 font-mono text-[10px] text-[#71717A]">
            Start with a pre-built automation recipe and customize it to your workflow.
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((tmpl, i) => (
            <motion.div
              key={tmpl.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05, ease: "easeOut" }}
            >
              <TemplateCard
                template={tmpl}
                onUse={() => onUseTemplate(tmpl.draft)}
              />
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
