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
      trigger: { type: "commit", branch: "main" },
      actions: [{ type: "run-command", command: "npm audit --audit-level=high && npx semgrep --config=auto ." } as any],
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
      trigger: { type: "session-end" },
      actions: [{ type: "run-tests", suite: "" } as any],
    },
  },
  {
    id: "bug-triage",
    name: "Bug Triage",
    description: "Predict merge conflicts and update packs on every commit to detect issues early.",
    triggerType: "commit",
    actionSummary: "predict-conflicts, update-packs",
    icon: Bug,
    draft: {
      name: "Bug Triage on Commit",
      enabled: true,
      trigger: { type: "commit" },
      actions: [{ type: "predict-conflicts" } as any, { type: "update-packs" } as any],
    },
  },
  {
    id: "routine-tasks",
    name: "Routine Tasks",
    description: "Scheduled daily at 9 AM: update packs, run tests, predict conflicts.",
    triggerType: "schedule",
    actionSummary: "update-packs, run-tests, predict-conflicts",
    icon: CheckSquare,
    draft: {
      name: "Daily Routine (9 AM)",
      enabled: true,
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
      actions: [
        { type: "update-packs" } as any,
        { type: "run-tests", suite: "" } as any,
        { type: "predict-conflicts" } as any,
      ],
    },
  },
  {
    id: "session-cleanup",
    name: "Session Cleanup",
    description: "Update packs when a coding session ends. Keeps dependency state fresh.",
    triggerType: "session-end",
    actionSummary: "update-packs",
    icon: Wrench,
    draft: {
      name: "Session Cleanup",
      enabled: true,
      trigger: { type: "session-end" },
      actions: [{ type: "update-packs" } as any],
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
      trigger: { type: "manual" },
      actions: [],
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
