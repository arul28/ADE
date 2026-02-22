import React from "react";
import type { OrchestratorStep } from "../../../shared/types";
import { cn } from "../ui/cn";

type ExecutionPhase = "planning" | "implementation" | "testing" | "codeReview" | "integration" | "merge" | "other";

type PhaseProgressBarProps = {
  steps: OrchestratorStep[];
  className?: string;
};

const PHASE_LABELS: Record<ExecutionPhase, string> = {
  planning: "Planning",
  implementation: "Implementation",
  testing: "Testing",
  codeReview: "Review",
  integration: "Integration",
  merge: "Merge",
  other: "Other"
};

const PHASE_COLORS: Record<ExecutionPhase, { bg: string; fill: string }> = {
  planning: { bg: "bg-blue-500/10", fill: "bg-blue-500" },
  implementation: { bg: "bg-violet-500/10", fill: "bg-violet-500" },
  testing: { bg: "bg-cyan-500/10", fill: "bg-cyan-500" },
  codeReview: { bg: "bg-amber-500/10", fill: "bg-amber-500" },
  integration: { bg: "bg-emerald-500/10", fill: "bg-emerald-500" },
  merge: { bg: "bg-pink-500/10", fill: "bg-pink-500" },
  other: { bg: "bg-gray-500/10", fill: "bg-gray-500" }
};

function stepTypeToPhase(stepType: string, taskType?: string): ExecutionPhase {
  const primary = (stepType || "").trim().toLowerCase();
  const secondary = (taskType || "").trim().toLowerCase();

  if (primary === "analysis" || secondary === "analysis") return "planning";
  if (primary === "code" || primary === "implementation" || secondary === "code" || secondary === "implementation") return "implementation";
  if (primary === "test" || primary === "validation" || secondary === "test" || secondary === "validation") return "testing";
  if (primary === "review" || secondary === "review") return "codeReview";
  if (primary === "integration" || secondary === "integration") return "integration";
  if (primary === "merge" || secondary === "merge") return "merge";
  return "other";
}

const TERMINAL = new Set(["succeeded", "failed", "skipped", "canceled"]);

export function PhaseProgressBar({ steps, className }: PhaseProgressBarProps) {
  const phaseGroups = new Map<ExecutionPhase, { total: number; completed: number; failed: number }>();

  for (const step of steps) {
    const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : "";
    const taskType = typeof step.metadata?.taskType === "string" ? step.metadata.taskType : "";
    const phase = stepTypeToPhase(stepType, taskType);
    const group = phaseGroups.get(phase) ?? { total: 0, completed: 0, failed: 0 };
    group.total += 1;
    if (step.status === "succeeded" || step.status === "skipped") group.completed += 1;
    if (step.status === "failed") group.failed += 1;
    phaseGroups.set(phase, group);
  }

  const phases = Array.from(phaseGroups.entries())
    .filter(([, g]) => g.total > 0)
    .sort(([a], [b]) => {
      const order: ExecutionPhase[] = ["planning", "implementation", "testing", "codeReview", "integration", "merge", "other"];
      return order.indexOf(a) - order.indexOf(b);
    });

  if (phases.length === 0) return null;

  return (
    <div className={cn("space-y-1.5", className)}>
      {phases.map(([phase, group]) => {
        const pct = group.total > 0 ? Math.round((group.completed / group.total) * 100) : 0;
        const colors = PHASE_COLORS[phase];
        return (
          <div key={phase} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[10px] text-muted-fg">{PHASE_LABELS[phase]}</span>
            <div className={cn("flex-1 h-1.5 rounded-full overflow-hidden", colors.bg)}>
              <div
                className={cn("h-full rounded-full transition-all duration-300", colors.fill)}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-[10px] text-muted-fg text-right">
              {group.completed}/{group.total}
            </span>
            {group.failed > 0 && (
              <span className="text-[10px] text-red-400">{group.failed} failed</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
