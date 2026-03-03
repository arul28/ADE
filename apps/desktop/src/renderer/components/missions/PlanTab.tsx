import React, { useState, useMemo } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type {
  MissionDetail,
  OrchestratorAttempt,
  OrchestratorRunGraph,
  OrchestratorStep,
} from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import {
  isRecord,
  STEP_STATUS_HEX,
  PLAN_DONE_STATUSES,
  statusGlyph,
} from "./missionHelpers";

export function PlanTab({
  mission,
  runGraph,
  attemptsByStep,
  selectedStepId,
  onStepSelect
}: {
  mission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  attemptsByStep: Map<string, OrchestratorAttempt[]>;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
}) {
  const [collapsedMilestones, setCollapsedMilestones] = useState<Record<string, boolean>>({});

  const hierarchy = useMemo(() => {
    const steps = runGraph?.steps ?? [];
    const phaseMap = new Map<string, {
      key: string;
      name: string;
      position: number;
      milestones: Map<string, { key: string; name: string; steps: OrchestratorStep[] }>;
    }>();

    for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
      const meta = isRecord(step.metadata) ? step.metadata : {};
      const phaseKey = typeof meta.phaseKey === "string" && meta.phaseKey.trim().length > 0 ? meta.phaseKey : "development";
      const phaseName = typeof meta.phaseName === "string" && meta.phaseName.trim().length > 0 ? meta.phaseName : "Development";
      const phasePosition = Number.isFinite(Number(meta.phasePosition)) ? Number(meta.phasePosition) : 9999;
      const planStep = isRecord(meta.planStep) ? meta.planStep : {};
      const milestoneName =
        typeof planStep.milestone === "string" && planStep.milestone.trim().length > 0
          ? planStep.milestone.trim()
          : `Milestone ${Math.floor(step.stepIndex / 4) + 1}`;

      const phaseBucket = phaseMap.get(phaseKey) ?? {
        key: phaseKey,
        name: phaseName,
        position: phasePosition,
        milestones: new Map()
      };
      const milestoneBucket = phaseBucket.milestones.get(milestoneName) ?? {
        key: `${phaseKey}:${milestoneName}`,
        name: milestoneName,
        steps: []
      };
      milestoneBucket.steps.push(step);
      phaseBucket.milestones.set(milestoneName, milestoneBucket);
      phaseMap.set(phaseKey, phaseBucket);
    }

    return Array.from(phaseMap.values())
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((phase) => ({
        ...phase,
        milestones: Array.from(phase.milestones.values()).sort((a, b) => a.steps[0]!.stepIndex - b.steps[0]!.stepIndex)
      }));
  }, [runGraph?.steps]);

  if (!runGraph || runGraph.steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16" style={{ color: COLORS.textMuted }}>
        <SquaresFour size={32} weight="regular" style={{ opacity: 0.2 }} className="mb-2" />
        <p className="text-xs" style={{ fontFamily: MONO_FONT }}>No runtime plan yet. Start a run to populate the plan tree.</p>
        {mission?.steps?.length ? (
          <p className="mt-2 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            Mission has {mission.steps.length} seeded steps waiting for orchestration.
          </p>
        ) : null}
      </div>
    );
  }

  const currentPhase = hierarchy.find((phase) =>
    phase.milestones.some((milestone) => milestone.steps.some((step) => !PLAN_DONE_STATUSES.has(step.status)))
  ) ?? hierarchy[hierarchy.length - 1] ?? null;
  const phaseTotal = currentPhase
    ? currentPhase.milestones.reduce((sum, milestone) => sum + milestone.steps.length, 0)
    : 0;
  const phaseCompleted = currentPhase
    ? currentPhase.milestones.reduce(
        (sum, milestone) => sum + milestone.steps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length,
        0
      )
    : 0;

  return (
    <div className="space-y-3 pb-3">
      {currentPhase ? (
        <div className="px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between text-[11px]" style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
            <span>Phase: {currentPhase.name}</span>
            <span>{phaseCompleted}/{phaseTotal} tasks</span>
          </div>
          <div className="mt-2 h-1.5 w-full" style={{ background: COLORS.recessedBg }}>
            <div
              className="h-full transition-all"
              style={{ width: `${phaseTotal > 0 ? Math.round((phaseCompleted / phaseTotal) * 100) : 0}%`, background: COLORS.accent }}
            />
          </div>
        </div>
      ) : null}

      {hierarchy.map((phase) => (
        <div key={phase.key} className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
            {phase.name}
          </div>
          <div className="mt-2 space-y-2">
            {phase.milestones.map((milestone) => {
              const milestoneDone = milestone.steps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length;
              const collapsed = collapsedMilestones[milestone.key] === true;
              return (
                <div key={milestone.key} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
                  <button
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left"
                    onClick={() =>
                      setCollapsedMilestones((prev) => ({ ...prev, [milestone.key]: !collapsed }))
                    }
                  >
                    <span className="text-[11px]" style={{ color: COLORS.textPrimary }}>{milestone.name}</span>
                    <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      {milestoneDone}/{milestone.steps.length}
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="space-y-1 px-2 pb-2">
                      {milestone.steps.map((step) => {
                        const attempts = attemptsByStep.get(step.id) ?? [];
                        const activeAttempt = attempts.find((attempt) => attempt.status === "running") ?? attempts[0] ?? null;
                        const meta = isRecord(step.metadata) ? step.metadata : {};
                        const expectedSignals = Array.isArray(meta.expectedSignals)
                          ? meta.expectedSignals.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
                          : [];
                        return (
                          <div
                            key={step.id}
                            className="cursor-pointer px-2 py-1"
                            onClick={() => onStepSelect(step.id)}
                            style={selectedStepId === step.id
                              ? { background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}30` }
                              : { border: `1px solid ${COLORS.border}` }
                            }
                          >
                            <div className="flex items-center gap-2 text-[11px]">
                              <span style={{ color: STEP_STATUS_HEX[step.status] ?? COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {statusGlyph(step.status)}
                              </span>
                              <span className="min-w-0 flex-1 truncate" style={{ color: COLORS.textPrimary }}>{step.title}</span>
                              {activeAttempt && step.status === "running" ? (
                                <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                  {activeAttempt.executorKind}
                                </span>
                              ) : null}
                            </div>
                            {expectedSignals.length > 0 ? (
                              <div className="mt-1 space-y-0.5 pl-5">
                                {expectedSignals.slice(0, 3).map((signal) => (
                                  <div key={signal} className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    {step.status === "succeeded" ? "\u2713" : "\u25CB"} {signal}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
