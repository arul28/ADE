import React, { useMemo } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import type {
  MissionArtifact,
  MissionDetail,
  OrchestratorAttempt,
  OrchestratorRunGraph,
  OrchestratorStep,
} from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import {
  filterExecutionSteps,
  isRecord,
  PLAN_DONE_STATUSES,
  statusGlyph,
  STEP_STATUS_HEX,
} from "./missionHelpers";
import { OrchestratorDAG } from "./OrchestratorDAG";

type PhaseSection = {
  key: string;
  name: string;
  position: number;
  steps: OrchestratorStep[];
};

type PlanGroup = {
  key: string;
  label: string;
  kind: "feature" | "milestone" | "phase";
  steps: OrchestratorStep[];
};

type PlannerReview = {
  title: string;
  objective: string | null;
  domain: string | null;
  complexity: string | null;
  strategy: string | null;
  parallelismCap: number | null;
  parallelismRationale: string | null;
  assumptions: string[];
  risks: string[];
};

function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toText(entry))
    .filter((entry): entry is string => entry != null);
}

function resolvePhase(step: OrchestratorStep): { key: string; name: string; position: number } {
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const key = typeof meta.phaseKey === "string" && meta.phaseKey.trim().length > 0 ? meta.phaseKey.trim() : "development";
  const name = typeof meta.phaseName === "string" && meta.phaseName.trim().length > 0 ? meta.phaseName.trim() : "Development";
  const rawPosition = Number(meta.phasePosition);
  const position = Number.isFinite(rawPosition) ? rawPosition : 9999;
  return { key, name, position };
}

function stepLabel(step: OrchestratorStep): string {
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

function parsePlanArtifact(artifact: MissionArtifact | null): Partial<PlannerReview> | null {
  const description = toText(artifact?.description);
  if (!description) return null;

  const matchSection = (heading: string): string[] => {
    const expression = new RegExp(`${heading}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][A-Za-z ]+:|$)`, "i");
    const block = description.match(expression)?.[1] ?? "";
    return block
      .split("\n")
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean);
  };

  return {
    objective: description.match(/^Objective:\s*(.+)$/im)?.[1]?.trim() ?? null,
    strategy: description.match(/^Strategy:\s*(.+)$/im)?.[1]?.trim() ?? null,
    assumptions: matchSection("Assumptions"),
    risks: matchSection("Risks"),
  };
}

function derivePlannerReview(mission: MissionDetail | null, runGraph: OrchestratorRunGraph | null): PlannerReview {
  const runMeta = isRecord(runGraph?.run.metadata) ? runGraph.run.metadata : null;
  const plannerPlan = isRecord(runMeta?.plannerPlan) ? runMeta.plannerPlan : null;
  const missionSummary = isRecord(plannerPlan?.missionSummary) ? plannerPlan.missionSummary : null;
  const artifactFallback = parsePlanArtifact(
    mission?.artifacts.find((artifact) =>
      artifact.artifactType === "plan"
      || artifact.title.toLowerCase().includes("generated mission plan")
      || (artifact.artifactType === "summary" && artifact.title.toLowerCase().includes("plan"))
    ) ?? null,
  );
  const parallelismCap = Number(missionSummary?.parallelismCap ?? Number.NaN);
  const assumptions = toStringArray(plannerPlan?.assumptions);
  const risks = toStringArray(plannerPlan?.risks);

  return {
    title: toText(mission?.title) ?? "Mission plan",
    objective: toText(missionSummary?.objective) ?? artifactFallback?.objective ?? toText(mission?.prompt),
    domain: toText(missionSummary?.domain),
    complexity: toText(missionSummary?.complexity),
    strategy: toText(missionSummary?.strategy) ?? artifactFallback?.strategy ?? null,
    parallelismCap: Number.isFinite(parallelismCap) && parallelismCap > 0 ? Math.floor(parallelismCap) : null,
    parallelismRationale: toText(missionSummary?.parallelismRationale),
    assumptions: assumptions.length > 0 ? assumptions : (artifactFallback?.assumptions ?? []),
    risks: risks.length > 0 ? risks : (artifactFallback?.risks ?? []),
  };
}

function derivePlanGroups(steps: OrchestratorStep[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    const meta = isRecord(step.metadata) ? step.metadata : {};
    const planStep = isRecord(meta.planStep) ? meta.planStep : null;
    const featureLabel = toText(meta.featureLabel) ?? toText(planStep?.featureLabel) ?? toText(planStep?.feature);
    const explicitMilestone = toText(meta.milestoneName) ?? toText(meta.milestoneLabel);
    const milestoneLabel = explicitMilestone
      ?? ((typeof meta.stepType === "string" && meta.stepType === "milestone") ? step.title : null);
    const phase = resolvePhase(step);
    let kind: PlanGroup["kind"] = "phase";
    if (featureLabel) kind = "feature";
    else if (milestoneLabel) kind = "milestone";
    const label = featureLabel ?? milestoneLabel ?? phase.name;
    const key = `${kind}:${label.toLowerCase()}`;
    const existing = groups.get(key) ?? { key, label, kind, steps: [] };
    existing.steps.push(step);
    groups.set(key, existing);
  }

  return [...groups.values()].sort((a, b) => a.steps[0]!.stepIndex - b.steps[0]!.stepIndex);
}

function kindLabel(kind: PlanGroup["kind"]): string {
  switch (kind) {
    case "feature": return "Feature";
    case "milestone": return "Milestone";
    case "phase": return "Phase";
  }
}

function SummaryList({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: string[];
  emptyLabel: string;
}) {
  return (
    <section className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
        {title}
      </div>
      {items.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {items.map((item, index) => (
            <div key={`${title}-${index}`} className="flex gap-2 text-[11px]" style={{ color: COLORS.textPrimary }}>
              <span style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>{index + 1}.</span>
              <span className="min-w-0 flex-1">{item}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
          {emptyLabel}
        </div>
      )}
    </section>
  );
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
  const steps = useMemo(() => runGraph?.steps ?? [], [runGraph?.steps]);
  const phaseSections = useMemo(() => phaseSectionsFromSteps(steps), [steps]);
  const executableSteps = useMemo(() => filterExecutionSteps(steps), [steps]);
  const plannerReview = useMemo(() => derivePlannerReview(mission, runGraph), [mission, runGraph]);
  const planGroups = useMemo(() => derivePlanGroups(steps), [steps]);

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
          <span>Planner review and work breakdown</span>
          <span>
            {executableSteps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length}/{executableSteps.length} executable steps complete
          </span>
        </div>
        <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>
          Review the planner summary first, then inspect grouped work, dependencies, and step-level ownership details below.
        </div>
      </div>

      <section className="space-y-3 p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
              Planner summary
            </div>
            <div className="mt-1 text-[13px] font-semibold" style={{ color: COLORS.textPrimary }}>
              {plannerReview.title}
            </div>
          </div>
          {plannerReview.parallelismCap != null ? (
            <div
              className="px-2 py-1 text-[10px] font-semibold"
              style={{ color: COLORS.accent, border: `1px solid ${COLORS.accent}30`, background: `${COLORS.accent}12`, fontFamily: MONO_FONT }}
            >
              Parallelism cap {plannerReview.parallelismCap}
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
              Objective
            </div>
            <div className="text-[12px]" style={{ color: COLORS.textPrimary, whiteSpace: "pre-wrap" }}>
              {plannerReview.objective ?? "Planner metadata did not record a structured objective. The mission prompt remains the source of truth."}
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {plannerReview.strategy ? <span>Strategy: {plannerReview.strategy}</span> : null}
              {plannerReview.domain ? <span>Domain: {plannerReview.domain}</span> : null}
              {plannerReview.complexity ? <span>Complexity: {plannerReview.complexity}</span> : null}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
              Parallelism rationale
            </div>
            <div className="text-[12px]" style={{ color: COLORS.textPrimary }}>
              {plannerReview.parallelismRationale ?? "No explicit rationale was captured. Use the dependency graph and grouped steps below to judge where parallel execution is actually safe."}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <SummaryList
          title="Assumptions"
          items={plannerReview.assumptions}
          emptyLabel="No explicit assumptions were captured in planner metadata."
        />
        <SummaryList
          title="Risks"
          items={plannerReview.risks}
          emptyLabel="No explicit risks were captured in planner metadata."
        />
      </div>

      <section className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            Milestone and feature grouping
          </div>
          <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {planGroups.length} grouped view{planGroups.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {planGroups.map((group) => (
            <div key={group.key} className="p-2.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold" style={{ color: COLORS.textPrimary }}>
                  {group.label}
                </div>
                <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                  {kindLabel(group.kind)}
                </div>
              </div>
              <div className="mt-2 space-y-1">
                {group.steps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => onStepSelect(step.id)}
                    className="flex w-full items-start gap-2 text-left"
                    style={{ color: selectedStepId === step.id ? COLORS.accent : COLORS.textSecondary }}
                  >
                    <span style={{ color: STEP_STATUS_HEX[step.status] ?? COLORS.textMuted, fontFamily: MONO_FONT }}>
                      {statusGlyph(step.status)}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px]">{step.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
          Dependency DAG
        </div>
        <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>
          The graph reflects the current runtime plan. Click any node to sync the detailed step panel above.
        </div>
        <div className="mt-2 overflow-auto">
          <OrchestratorDAG
            steps={runGraph.steps}
            attempts={runGraph.attempts}
            claims={runGraph.claims}
            selectedStepId={selectedStepId}
            onStepClick={onStepSelect}
            runId={runGraph.run.id}
          />
        </div>
      </section>

      {phaseSections.map((phase) => (
        <section key={phase.key} className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary }}>
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
                        background: `${COLORS.accent}16`,
                        border: `1px solid ${COLORS.accent}33`,
                        color: COLORS.accent,
                        fontFamily: MONO_FONT,
                      }}
                    >
                      {stepLabel(step)}
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <span>Status: {step.status}</span>
                    {assignedTo ? <span>Assigned to: {assignedTo}</span> : null}
                    {latestAttempt?.executorKind ? <span>Executor: {latestAttempt.executorKind}</span> : null}
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
