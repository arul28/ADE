import React, { useMemo } from "react";
import {
  ArrowRight,
  CheckCircle,
  Crown,
  FlagBanner,
  GitBranch,
  Pulse,
  UsersThree,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import type {
  MissionDetail,
  MissionIntervention,
  MissionRunView,
  MissionRunViewProgressItem,
  MissionRunViewWorkerSummary,
  OrchestratorRunGraph,
  PhaseCard,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import { isRecord } from "./missionHelpers";
import { selectCurrentMissionWorkers, sortMissionWorkers } from "./missionWorkerPresentation";

type MissionControlOfficePanelProps = {
  mission: MissionDetail;
  runView: MissionRunView | null;
  runGraph: OrchestratorRunGraph | null;
  phases?: PhaseCard[] | null;
  onOpenIntervention?: (interventionId: string) => void;
};

type OfficeDeskStatus = "idle" | "active" | "blocked" | "done" | "failed";

type OfficeDesk = {
  key: string;
  label: string;
  detail: string;
  status: OfficeDeskStatus;
  icon: typeof Crown;
};

const STATUS_TONE: Record<OfficeDeskStatus, { color: string; label: string }> = {
  idle: { color: COLORS.textDim, label: "idle" },
  active: { color: COLORS.accent, label: "active" },
  blocked: { color: COLORS.warning, label: "blocked" },
  done: { color: COLORS.success, label: "done" },
  failed: { color: COLORS.danger, label: "failed" },
};

function pickPhases(args: {
  mission: MissionDetail;
  runGraph: OrchestratorRunGraph | null;
  phases?: PhaseCard[] | null;
}): PhaseCard[] {
  if (args.phases?.length) return args.phases.slice().sort((a, b) => a.position - b.position);
  const runMetadata = isRecord(args.runGraph?.run.metadata) ? args.runGraph.run.metadata : null;
  const runPhaseOverride = Array.isArray(runMetadata?.phaseOverride)
    ? (runMetadata.phaseOverride as PhaseCard[])
    : [];
  if (runPhaseOverride.length) return runPhaseOverride.slice().sort((a, b) => a.position - b.position);
  return (args.mission.phaseConfiguration?.selectedPhases ?? []).slice().sort((a, b) => a.position - b.position);
}

function summarizeWorkers(workers: MissionRunViewWorkerSummary[]) {
  return {
    active: workers.filter((worker) => worker.status === "active").length,
    blocked: workers.filter((worker) => worker.status === "blocked").length,
    completed: workers.filter((worker) => worker.status === "completed").length,
    failed: workers.filter((worker) => worker.status === "failed").length,
    total: workers.length,
  };
}

function missionDeskStatus(args: {
  mission: MissionDetail;
  runView: MissionRunView | null;
  runGraph: OrchestratorRunGraph | null;
  workers: ReturnType<typeof summarizeWorkers>;
  openInterventions: MissionIntervention[];
}): OfficeDesk[] {
  const runStatus = args.runView?.lifecycle.displayStatus ?? "not_started";
  const planningDone = (args.runGraph?.steps ?? []).some((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    return step.status === "succeeded"
      && (metadata?.phaseKey === "planning" || metadata?.stepType === "planning" || metadata?.workerIntent === "planner");
  });
  const resultLaneReady = Boolean(args.mission.resultLaneId);
  const closeoutOpen = (args.runView?.closeoutRequirements ?? []).filter((requirement) =>
    requirement.status !== "present" && requirement.status !== "waived" && requirement.required !== false
  ).length;
  const coordinatorBlocked = args.runView?.coordinator.available === false || args.openInterventions.length > 0;
  const coordinatorStatus: OfficeDeskStatus =
    runStatus === "failed" ? "failed" : coordinatorBlocked ? "blocked" : runStatus === "running" ? "active" : runStatus === "completed" ? "done" : "idle";

  return [
    {
      key: "planner",
      label: "Planner",
      detail: planningDone ? "Plan captured" : runStatus === "starting" || runStatus === "running" ? "Clarifying scope and shaping the DAG" : "Waiting for mission start",
      status: planningDone ? "done" : runStatus === "running" || runStatus === "starting" ? "active" : "idle",
      icon: FlagBanner,
    },
    {
      key: "orchestrator",
      label: "Orchestrator",
      detail: args.runView?.coordinator.summary ?? args.runView?.lifecycle.summary ?? "No coordinator runtime yet",
      status: coordinatorStatus,
      icon: Crown,
    },
    {
      key: "workers",
      label: "Workers",
      detail: `${args.workers.active} active, ${args.workers.completed} done, ${args.workers.blocked} blocked`,
      status: args.workers.failed > 0 ? "failed" : args.workers.blocked > 0 ? "blocked" : args.workers.active > 0 ? "active" : args.workers.completed > 0 ? "done" : "idle",
      icon: UsersThree,
    },
    {
      key: "integration",
      label: "Integration",
      detail: resultLaneReady ? `Result lane: ${args.mission.resultLaneName ?? args.mission.resultLaneId}` : "Result lane assembly pending",
      status: resultLaneReady ? "done" : runStatus === "completed" && closeoutOpen > 0 ? "blocked" : runStatus === "running" ? "active" : "idle",
      icon: GitBranch,
    },
    {
      key: "closeout",
      label: "Closeout",
      detail: closeoutOpen > 0 ? `${closeoutOpen} required check${closeoutOpen === 1 ? "" : "s"} remaining` : "Evidence and summary are clear",
      status: closeoutOpen > 0 ? "blocked" : resultLaneReady || runStatus === "completed" ? "done" : "idle",
      icon: CheckCircle,
    },
  ];
}

function DeskCard({ desk }: { desk: OfficeDesk }) {
  const tone = STATUS_TONE[desk.status];
  const Icon = desk.icon;
  return (
    <div
      className="min-w-[150px] flex-1 p-3"
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${desk.status === "blocked" || desk.status === "failed" ? tone.color + "55" : COLORS.border}`,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon size={16} weight="fill" style={{ color: tone.color }} />
          <span className="text-[11px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
            {desk.label}
          </span>
        </div>
        <span
          className="text-[9px] font-bold uppercase tracking-[0.12em]"
          style={{ color: tone.color, fontFamily: MONO_FONT }}
        >
          {tone.label}
        </span>
      </div>
      <div className="mt-2 text-[11px] leading-5" style={{ color: COLORS.textSecondary }}>
        {desk.detail}
      </div>
    </div>
  );
}

function PhaseRunway({
  phases,
  activePhaseKey,
}: {
  phases: PhaseCard[];
  activePhaseKey: string | null;
}) {
  if (!phases.length) return null;
  const activeIndex = phases.findIndex((phase) => phase.phaseKey === activePhaseKey);
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto py-1">
      {phases.map((phase, index) => {
        const isActive = phase.phaseKey === activePhaseKey;
        const isDone = activeIndex >= 0 && index < activeIndex;
        const color = isActive ? COLORS.accent : isDone ? COLORS.success : COLORS.textDim;
        return (
          <React.Fragment key={phase.id}>
            <div className="flex shrink-0 items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: color }}
              />
              <span className="text-[10px]" style={{ color, fontFamily: MONO_FONT }}>
                {phase.name}
              </span>
            </div>
            {index < phases.length - 1 ? <ArrowRight size={10} weight="bold" style={{ color: COLORS.textDim }} /> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function WorkerChip({ worker }: { worker: MissionRunViewWorkerSummary }) {
  const tone = worker.status === "failed"
    ? COLORS.danger
    : worker.status === "blocked"
      ? COLORS.warning
      : worker.status === "active"
        ? COLORS.accent
        : COLORS.textDim;
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-2 py-1.5"
      style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: COLORS.textPrimary }}>
        {worker.stepTitle ?? worker.stepKey ?? "Worker"}
      </span>
      <span className="shrink-0 text-[9px] uppercase tracking-[0.12em]" style={{ color: tone, fontFamily: MONO_FONT }}>
        {worker.status}
      </span>
    </div>
  );
}

function ProgressLine({ item }: { item: MissionRunViewProgressItem }) {
  const color = item.severity === "error"
    ? COLORS.danger
    : item.severity === "warning"
      ? COLORS.warning
      : item.severity === "success"
        ? COLORS.success
        : COLORS.accent;
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <div className="truncate" style={{ color: COLORS.textPrimary }}>{item.title}</div>
        {item.detail ? (
          <div className="mt-0.5 line-clamp-2" style={{ color: COLORS.textMuted }}>
            {item.detail}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
        {relativeWhen(item.at)}
      </span>
    </div>
  );
}

export const MissionControlOfficePanel = React.memo(function MissionControlOfficePanel({
  mission,
  runView,
  runGraph,
  phases: providedPhases,
  onOpenIntervention,
}: MissionControlOfficePanelProps) {
  const phases = useMemo(
    () => pickPhases({ mission, runGraph, phases: providedPhases }),
    [mission, providedPhases, runGraph],
  );
  const openInterventions = useMemo(
    () => mission.interventions.filter((intervention) => intervention.status === "open"),
    [mission.interventions],
  );
  const currentWorkers = useMemo(
    () => selectCurrentMissionWorkers(runView?.workers ?? []),
    [runView?.workers],
  );
  const workerSummary = useMemo(() => summarizeWorkers(currentWorkers), [currentWorkers]);
  const desks = useMemo(
    () => missionDeskStatus({ mission, runView, runGraph, workers: workerSummary, openInterventions }),
    [mission, openInterventions, runGraph, runView, workerSummary],
  );
  const visibleWorkers = useMemo(
    () => sortMissionWorkers(currentWorkers).slice(0, 8),
    [currentWorkers],
  );
  const latestProgress = useMemo(() => (runView?.progressLog ?? []).slice(0, 5), [runView?.progressLog]);

  return (
    <section className="space-y-3">
      <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Pulse size={15} weight="fill" style={{ color: COLORS.accent }} />
              <div className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                Mission control
              </div>
            </div>
            <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>
              Planner, orchestrator, workers, integration, and closeout in one live surface.
            </div>
          </div>
          {openInterventions.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpenIntervention?.(openInterventions[0]!.id)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: COLORS.warning, background: `${COLORS.warning}12`, border: `1px solid ${COLORS.warning}35`, fontFamily: MONO_FONT }}
            >
              <WarningCircle size={13} weight="bold" />
              {openInterventions.length} intervention{openInterventions.length === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>
        <div className="mt-3">
          <PhaseRunway phases={phases} activePhaseKey={runView?.active.phaseKey ?? null} />
        </div>
      </div>

      <div className="grid gap-2 xl:grid-cols-5 md:grid-cols-3 sm:grid-cols-2">
        {desks.map((desk) => <DeskCard key={desk.key} desk={desk} />)}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            <Wrench size={13} weight="fill" />
            Agent floor
          </div>
          <div className="mt-2 space-y-1.5">
            {visibleWorkers.length > 0 ? (
              visibleWorkers.map((worker, index) => (
                <WorkerChip key={worker.attemptId ?? worker.stepId ?? worker.stepKey ?? worker.sessionId ?? `worker-${index}`} worker={worker} />
              ))
            ) : (
              <div className="py-6 text-center text-[11px]" style={{ color: COLORS.textMuted }}>
                No workers have checked in yet.
              </div>
            )}
          </div>
        </section>

        <section className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            <Pulse size={13} weight="fill" />
            Latest communications
          </div>
          <div className="mt-2 space-y-2">
            {latestProgress.length > 0 ? (
              latestProgress.map((item) => <ProgressLine key={item.id} item={item} />)
            ) : (
              <div className="py-6 text-center text-[11px]" style={{ color: COLORS.textMuted }}>
                Mission updates will appear here once the run starts.
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
});
