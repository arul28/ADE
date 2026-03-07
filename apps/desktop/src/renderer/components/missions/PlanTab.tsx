import React, { useMemo } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type {
  MissionDetail,
  OrchestratorAttempt,
  OrchestratorRunGraph,
  OrchestratorStep,
} from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import {
  filterExecutionSteps,
  isDisplayOnlyTaskStep,
  isRecord,
  PLAN_DONE_STATUSES,
  statusGlyph,
  STEP_STATUS_HEX,
} from "./missionHelpers";

type PhaseSection = {
  key: string;
  name: string;
  position: number;
  steps: OrchestratorStep[];
};

function resolvePhase(step: OrchestratorStep): { key: string; name: string; position: number } {
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const key = typeof meta.phaseKey === "string" && meta.phaseKey.trim().length > 0 ? meta.phaseKey.trim() : "development";
  const name = typeof meta.phaseName === "string" && meta.phaseName.trim().length > 0 ? meta.phaseName.trim() : "Development";
  const rawPosition = Number(meta.phasePosition);
  const position = Number.isFinite(rawPosition) ? rawPosition : 9999;
  return { key, name, position };
}

function stepLabel(step: OrchestratorStep): string {
  if (isDisplayOnlyTaskStep(step)) return "Plan";
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const stepType = typeof meta.stepType === "string" && meta.stepType.trim().length > 0 ? meta.stepType.trim() : "Worker";
  return stepType.replace(/_/g, " ");
}

function phaseSectionsFromSteps(steps: OrchestratorStep[]): PhaseSection[] {
  const sections = new Map<string, PhaseSection>();
  for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    const phase = resolvePhase(step);
    const existing = sections.get(phase.key) ?? {
      key: phase.key,
      name: phase.name,
      position: phase.position,
      steps: [],
    };
    existing.steps.push(step);
    sections.set(phase.key, existing);
  }

  return [...sections.values()].sort((a, b) => a.position - b.position || a.steps[0]!.stepIndex - b.steps[0]!.stepIndex);
}

export const PlanTab = React.memo(function PlanTab({
  mission,
  runGraph,
  attemptsByStep,
  selectedStepId,
  onStepSelect,
}: {
  mission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  attemptsByStep: Map<string, OrchestratorAttempt[]>;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
}) {
  const steps = runGraph?.steps ?? [];
  const phaseSections = useMemo(() => phaseSectionsFromSteps(steps), [steps]);
  const executableSteps = useMemo(() => filterExecutionSteps(steps), [steps]);

  if (!runGraph || steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16" style={{ color: COLORS.textMuted }}>
        <SquaresFour size={32} weight="regular" style={{ opacity: 0.2 }} className="mb-2" />
        <p className="text-xs" style={{ fontFamily: MONO_FONT }}>No runtime plan yet. Start a run to populate the work breakdown.</p>
        {mission?.steps?.length ? (
          <p className="mt-2 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            Mission has {mission.steps.length} seeded steps waiting for orchestration.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-3">
      <div className="px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between text-[11px]" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
          <span>Ordered work breakdown</span>
          <span>
            {executableSteps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length}/{executableSteps.length} executable steps complete
          </span>
        </div>
      </div>

      {phaseSections.map((phase) => (
        <section key={phase.key} className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
              {phase.name}
            </div>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {phase.steps.length} item{phase.steps.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="mt-2 space-y-2">
            {phase.steps.map((step, index) => {
              const attempts = attemptsByStep.get(step.id) ?? [];
              const latestAttempt = attempts[0] ?? null;
              const isSelected = selectedStepId === step.id;
              const isPlanNode = isDisplayOnlyTaskStep(step);
              const meta = isRecord(step.metadata) ? step.metadata : {};
              const assignedTo = typeof meta.assignedTo === "string" ? meta.assignedTo.trim() : "";
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => onStepSelect(step.id)}
                  className="w-full px-3 py-2 text-left transition-colors"
                  style={isSelected
                    ? { background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}30` }
                    : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                  }
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>{index + 1}.</span>
                    <span style={{ color: STEP_STATUS_HEX[step.status] ?? COLORS.textMuted, fontFamily: MONO_FONT }}>
                      {statusGlyph(step.status)}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: COLORS.textPrimary }}>{step.title}</span>
                    <span
                      className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]"
                      style={{
                        background: isPlanNode ? `${COLORS.warning}16` : `${COLORS.accent}16`,
                        border: `1px solid ${isPlanNode ? COLORS.warning : COLORS.accent}33`,
                        color: isPlanNode ? COLORS.warning : COLORS.accent,
                        fontFamily: MONO_FONT,
                      }}
                    >
                      {stepLabel(step)}
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <span>Status: {step.status}</span>
                    {assignedTo ? <span>Assigned to: {assignedTo}</span> : null}
                    {!isPlanNode && latestAttempt?.executorKind ? <span>Executor: {latestAttempt.executorKind}</span> : null}
                    {step.dependencyStepIds.length > 0 ? <span>Depends on: {step.dependencyStepIds.length}</span> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
});
