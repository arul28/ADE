import React from "react";
import type { OrchestratorStep } from "../../../shared/types";
import { cn } from "../ui/cn";

type ExecutionPhase = "planning" | "implementation" | "testing" | "codeReview" | "integration" | "merge" | "other";

type PhaseProgressBarProps = {
  steps: OrchestratorStep[];
  className?: string;
};

const PHASE_LABELS: Record<ExecutionPhase, string> = {
  planning: "PLANNING",
  implementation: "IMPLEMENTATION",
  testing: "TESTING",
  codeReview: "REVIEW",
  integration: "INTEGRATION",
  merge: "MERGE",
  other: "OTHER"
};

const PHASE_COLORS: Record<ExecutionPhase, { bg: string; fill: string }> = {
  planning: { bg: "#3B82F618", fill: "#3B82F6" },
  implementation: { bg: "#A78BFA18", fill: "#A78BFA" },
  testing: { bg: "#06B6D418", fill: "#06B6D4" },
  codeReview: { bg: "#F59E0B18", fill: "#F59E0B" },
  integration: { bg: "#22C55E18", fill: "#22C55E" },
  merge: { bg: "#EC489918", fill: "#EC4899" },
  other: { bg: "#71717A18", fill: "#71717A" }
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

const TERMINAL = new Set(["succeeded", "failed", "skipped", "superseded", "canceled"]);

export function PhaseProgressBar({ steps, className }: PhaseProgressBarProps) {
  const phaseGroups = new Map<ExecutionPhase, { total: number; completed: number; failed: number }>();

  for (const step of steps) {
    const stepType = typeof step.metadata?.stepType === "string" ? step.metadata.stepType : "";
    const taskType = typeof step.metadata?.taskType === "string" ? step.metadata.taskType : "";
    const phase = stepTypeToPhase(stepType, taskType);
    const group = phaseGroups.get(phase) ?? { total: 0, completed: 0, failed: 0 };
    group.total += 1;
    if (step.status === "succeeded" || step.status === "skipped" || step.status === "superseded") group.completed += 1;
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

  const totalCompleted = steps.filter(s => s.status === "succeeded" || s.status === "skipped" || s.status === "superseded").length;
  const totalSteps = steps.length;
  const overallPct = totalSteps > 0 ? Math.round((totalCompleted / totalSteps) * 100) : 0;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="mb-2 pb-2" style={{ borderBottom: "1px solid #1E1B26" }}>
        <div className="flex items-center justify-between mb-1">
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            OVERALL PROGRESS
          </span>
          <span
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              color: "#71717A"
            }}
          >
            {totalCompleted} of {totalSteps} ({overallPct}%)
          </span>
        </div>
        <div className="h-1.5 overflow-hidden" style={{ background: "#A78BFA18", borderRadius: 0 }}>
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${overallPct}%`, background: "#A78BFA", borderRadius: 0 }}
          />
        </div>
      </div>
      {phases.map(([phase, group]) => {
        const pct = group.total > 0 ? Math.round((group.completed / group.total) * 100) : 0;
        const colors = PHASE_COLORS[phase];
        return (
          <div key={phase} className="flex items-center gap-2">
            <span
              className="w-20 shrink-0"
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                color: "#71717A",
                textTransform: "uppercase",
                letterSpacing: "1px"
              }}
            >
              {PHASE_LABELS[phase]}
            </span>
            <div className="flex-1 h-1.5 overflow-hidden" style={{ background: colors.bg, borderRadius: 0 }}>
              <div
                className="h-full transition-all duration-300"
                style={{ width: `${pct}%`, background: colors.fill, borderRadius: 0 }}
              />
            </div>
            <span
              className="w-12 shrink-0 text-right"
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                color: "#71717A"
              }}
            >
              {group.completed}/{group.total}
            </span>
            {group.failed > 0 && (
              <span
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 10,
                  color: "#EF4444"
                }}
              >
                {group.failed} failed
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
