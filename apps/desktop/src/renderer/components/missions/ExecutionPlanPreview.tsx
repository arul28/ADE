import React, { useState } from "react";
import {
  CheckCircle,
  Warning,
  CaretDown,
  CaretRight,
  Users,
  Stack,
  ArrowsClockwise,
  GitPullRequest,
  Shield
} from "@phosphor-icons/react";
import type {
  ExecutionPlanPreview as ExecutionPlanPreviewType,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview,
  OrchestratorWorkerRole
} from "../../../shared/types";
import { cn } from "../ui/cn";

/* ── Helpers ── */

const ROLE_BADGE_CLASSES: Record<OrchestratorWorkerRole, string> = {
  planning: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  implementation: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  testing: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  code_review: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  test_review: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  integration: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  merge: "bg-orange-500/20 text-orange-300 border-orange-500/30"
};

const ROLE_LABELS: Record<OrchestratorWorkerRole, string> = {
  planning: "Planning",
  implementation: "Implementation",
  testing: "Testing",
  code_review: "Code Review",
  test_review: "Test Review",
  integration: "Integration",
  merge: "Merge"
};

const EXECUTOR_BADGE_CLASSES: Record<string, string> = {
  claude: "bg-violet-500/20 text-violet-300",
  codex: "bg-emerald-500/20 text-emerald-300",
  shell: "bg-amber-500/20 text-amber-300",
  manual: "bg-blue-500/20 text-blue-300"
};

function RoleBadge({ role }: { role: OrchestratorWorkerRole }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[9px] font-medium border",
        ROLE_BADGE_CLASSES[role] ?? "bg-zinc-500/20 text-zinc-300 border-zinc-500/30"
      )}
    >
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

/* ── Phase Row ── */

function PhaseSection({ phase }: { phase: ExecutionPlanPhase }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded border border-border/20 bg-zinc-900/40">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/40"
      >
        {expanded
          ? <CaretDown size={12} weight="regular" className="text-muted-fg shrink-0" />
          : <CaretRight size={12} weight="regular" className="text-muted-fg shrink-0" />
        }
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fg capitalize">
              {phase.phase.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")}
            </span>
            <span className="text-[9px] text-muted-fg">
              {phase.stepCount} step{phase.stepCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn(
            "rounded px-1 py-0.5 text-[9px] font-medium",
            EXECUTOR_BADGE_CLASSES[phase.executorKind] ?? "bg-zinc-500/20 text-zinc-300"
          )}>
            {phase.model !== "default" ? phase.model : phase.executorKind}
          </span>
          {phase.gatePolicy !== "none" && phase.gatePolicy !== "off" && (
            <span className="rounded px-1 py-0.5 text-[9px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30">
              {phase.gatePolicy}
            </span>
          )}
          {phase.recoveryEnabled && (
            <ArrowsClockwise size={12} weight="regular" className="text-amber-400" />
          )}
        </div>
      </button>

      {expanded && phase.steps.length > 0 && (
        <div className="border-t border-border/15 px-2.5 py-1.5 space-y-1">
          {phase.steps.map((step) => (
            <StepRow key={step.stepKey} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Step Row ── */

function StepRow({ step }: { step: ExecutionPlanStepPreview }) {
  return (
    <div className="flex items-center gap-2 py-1 pl-5">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-fg truncate">{step.title}</div>
        {step.dependencies.length > 0 && (
          <div className="text-[9px] text-muted-fg truncate">
            depends on: {step.dependencies.join(", ")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <RoleBadge role={step.role} />
        <span className={cn(
          "rounded px-1 py-0.5 text-[9px] font-medium",
          EXECUTOR_BADGE_CLASSES[step.executorKind] ?? "bg-zinc-500/20 text-zinc-300"
        )}>
          {step.executorKind}
        </span>
      </div>
    </div>
  );
}

/* ── Main Component ── */

type ExecutionPlanPreviewProps = {
  preview: ExecutionPlanPreviewType | null;
};

export function ExecutionPlanPreview({ preview }: ExecutionPlanPreviewProps) {
  if (!preview) {
    return (
      <div className="rounded-lg border border-border/20 bg-zinc-800/30 px-3 py-3 text-center">
        <div className="text-xs text-muted-fg">No execution plan available</div>
      </div>
    );
  }

  const { strategy, teamSummary, phases, recoveryPolicy, integrationPrPlan, aligned, driftNotes } = preview;

  return (
    <div className="rounded-lg border border-border/20 bg-zinc-800/30 space-y-2.5 p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stack size={14} weight="regular" className="text-accent" />
          <span className="text-xs font-semibold text-fg">Execution Plan</span>
        </div>
        {aligned ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-300">
            <CheckCircle size={12} weight="regular" />
            Aligned
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-amber-300">
            <Warning size={12} weight="regular" />
            Drift detected
          </span>
        )}
      </div>

      {/* Strategy line */}
      <div className="text-[10px] text-fg/80 leading-snug">{strategy}</div>

      {/* Team summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-[10px] text-muted-fg">
          <Users size={12} weight="regular" />
          <span>{teamSummary.workerCount} worker{teamSummary.workerCount !== 1 ? "s" : ""}</span>
        </div>
        {teamSummary.parallelLanes > 0 && (
          <div className="flex items-center gap-1 text-[11px] text-muted-fg">
            <Stack size={12} weight="regular" />
            <span>{teamSummary.parallelLanes} lane{teamSummary.parallelLanes !== 1 ? "s" : ""}</span>
          </div>
        )}
        <div className="flex items-center gap-1 flex-wrap">
          {teamSummary.roles.map((role) => (
            <RoleBadge key={role} role={role} />
          ))}
        </div>
      </div>

      {/* Phase list */}
      {phases.length > 0 && (
        <div className="space-y-1">
          {phases.map((phase) => (
            <PhaseSection key={phase.phase} phase={phase} />
          ))}
        </div>
      )}

      {/* Recovery policy */}
      {recoveryPolicy.enabled && (
        <div className="flex items-center gap-2 text-[10px] text-muted-fg">
          <Shield size={12} weight="regular" className="text-amber-400 shrink-0" />
          <span>
            Auto-recovery: up to {recoveryPolicy.maxIterations} iteration{recoveryPolicy.maxIterations !== 1 ? "s" : ""}
            {recoveryPolicy.onExhaustion !== "fail" && (
              <span className="ml-1 text-[9px]">
                (on exhaustion: {recoveryPolicy.onExhaustion.replace(/_/g, " ")})
              </span>
            )}
          </span>
        </div>
      )}

      {/* Integration PR plan */}
      {integrationPrPlan.enabled && (
        <div className="flex items-center gap-2 text-[10px] text-muted-fg">
          <GitPullRequest size={12} weight="regular" className="text-emerald-400 shrink-0" />
          <span>
            Will create integration PR when complete
            {integrationPrPlan.draft && " (draft)"}
          </span>
        </div>
      )}

      {/* Drift notes */}
      {driftNotes.length > 0 && (
        <div className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 space-y-0.5">
          <div className="text-[10px] font-medium text-amber-300">Drift Notes</div>
          {driftNotes.map((note, i) => (
            <div key={i} className="text-[9px] text-amber-200/80">{note}</div>
          ))}
        </div>
      )}
    </div>
  );
}
