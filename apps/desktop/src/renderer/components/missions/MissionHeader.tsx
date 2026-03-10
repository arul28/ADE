import { useMemo } from "react";
import {
  Clock,
  SpinnerGap,
  Play,
  Stop,
  GearSix,
  GitBranch,
  Trash,
} from "@phosphor-icons/react";
import type {
  MissionDetail,
  MissionSummary,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  OrchestratorStep,
  StartOrchestratorRunFromMissionArgs,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  STATUS_BADGE_STYLES,
  STATUS_LABELS,
  PRIORITY_STYLES,
  TERMINAL_MISSION_STATUSES,
  ElapsedTime,
  filterExecutionSteps,
  isRecord,
} from "./missionHelpers";
import { useMissionsStore } from "./useMissionsStore";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

/* ════════════════════ MISSION HEADER ════════════════════ */

export function MissionHeader() {
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const runGraph = useMissionsStore((s) => s.runGraph);
  const runBusy = useMissionsStore((s) => s.runBusy);
  const checkpointStatus = useMissionsStore((s) => s.checkpointStatus);
  const activeTab = useMissionsStore((s) => s.activeTab);
  const cleanupBusy = useMissionsStore((s) => s.cleanupBusy);
  const manageMissionBusy = useMissionsStore((s) => s.manageMissionBusy);
  const missions = useMissionsStore((s) => s.missions);
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);

  const setRunBusy = useMissionsStore((s) => s.setRunBusy);
  const setError = useMissionsStore((s) => s.setError);
  const setCleanupBusy = useMissionsStore((s) => s.setCleanupBusy);
  const setMissionContextMenu = useMissionsStore((s) => s.setMissionContextMenu);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadMissionDetail = useMissionsStore((s) => s.loadMissionDetail);
  const loadOrchestratorGraph = useMissionsStore((s) => s.loadOrchestratorGraph);

  const setManageMission = useMissionsStore((s) => s.setManageMission);
  const setManageMissionOpen = useMissionsStore((s) => s.setManageMissionOpen);
  const setManageMissionCleanupLanes = useMissionsStore((s) => s.setManageMissionCleanupLanes);
  const setManageMissionError = useMissionsStore((s) => s.setManageMissionError);

  const executionSteps = useMemo(
    () => filterExecutionSteps(runGraph?.steps ?? []),
    [runGraph?.steps],
  );

  const executionProgress = useMemo(() => {
    const completed = executionSteps.filter(
      (s) => s.status === "succeeded" || s.status === "skipped" || s.status === "superseded" || s.status === "canceled",
    ).length;
    const total = executionSteps.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, pct };
  }, [executionSteps]);

  const runAutopilotState = useMemo(() => {
    const autopilot =
      runGraph?.run.metadata &&
      typeof runGraph.run.metadata.autopilot === "object" &&
      !Array.isArray(runGraph.run.metadata.autopilot)
        ? (runGraph.run.metadata.autopilot as Record<string, unknown>)
        : null;
    return {
      enabled: autopilot?.enabled === true,
      executor: typeof autopilot?.executorKind === "string" ? autopilot.executorKind : null,
    };
  }, [runGraph]);

  const selectedMissionSummary = useMemo(() => {
    if (!selectedMissionId) return null;
    return missions.find((m) => m.id === selectedMissionId) ?? null;
  }, [missions, selectedMissionId]);

  const canStartOrRerun =
    !runGraph ||
    runGraph.run.status === "succeeded" ||
    runGraph.run.status === "failed" ||
    runGraph.run.status === "canceled";
  const canCancelRun = Boolean(
    runGraph &&
      runGraph.run.status !== "succeeded" &&
      runGraph.run.status !== "failed" &&
      runGraph.run.status !== "canceled",
  );
  const canResumeRun = runGraph?.run.status === "paused";
  const canPauseRun = Boolean(
    runGraph && (runGraph.run.status === "active" || runGraph.run.status === "bootstrapping"),
  );
  const hasNonTerminalRun = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));

  const missionElapsedEndedAt = useMemo(() => {
    if (!selectedMission) return null;
    const runStatus = runGraph?.run.status ?? null;
    if (runStatus === "paused") return runGraph?.run.updatedAt ?? selectedMission.updatedAt;
    if (runStatus === "canceled" || runStatus === "failed" || runStatus === "succeeded") {
      return runGraph?.run.completedAt ?? runGraph?.run.updatedAt ?? selectedMission.completedAt ?? selectedMission.updatedAt;
    }
    if (selectedMission.status === "intervention_required") return selectedMission.updatedAt;
    if (TERMINAL_MISSION_STATUSES.has(selectedMission.status)) {
      return selectedMission.completedAt ?? selectedMission.updatedAt;
    }
    return null;
  }, [runGraph?.run.completedAt, runGraph?.run.status, runGraph?.run.updatedAt, selectedMission]);

  const checkpointIndicatorLabel = checkpointStatus ? relativeWhen(checkpointStatus.savedAt) : "pending";
  const checkpointIndicatorTooltip = checkpointStatus
    ? `Last checkpoint: ${relativeWhen(checkpointStatus.savedAt)} | ${checkpointStatus.turnCount} turns | ${checkpointStatus.compactionCount} compactions`
    : "Last checkpoint: pending";

  const chatFocused = activeTab === "chat";

  /* ── Actions ── */
  const openManageMissionDialog = (mission: MissionSummary) => {
    setManageMission(mission);
    setManageMissionCleanupLanes(false);
    setManageMissionError(null);
    setManageMissionOpen(true);
  };

  const handleStartRun = async () => {
    if (!selectedMission) return;
    setRunBusy(true);
    try {
      const fallbackExecutor: OrchestratorExecutorKind =
        runAutopilotState.executor && runAutopilotState.executor.length > 0
          ? (runAutopilotState.executor as OrchestratorExecutorKind)
          : "unified";
      const plannerProvider: "claude" | "codex" | null =
        runAutopilotState.executor === "claude" || runAutopilotState.executor === "codex"
          ? (runAutopilotState.executor as "claude" | "codex")
          : null;
      const startArgs = {
        missionId: selectedMission.id,
        runMode: "autopilot",
        autopilotOwnerId: "missions-autopilot",
        defaultExecutorKind: fallbackExecutor,
        defaultRetryLimit: 1,
        plannerProvider: plannerProvider ?? null,
      } satisfies StartOrchestratorRunFromMissionArgs;
      await window.ade.orchestrator.startRunFromMission(startArgs);
      await Promise.all([
        loadOrchestratorGraph(selectedMission.id),
        loadMissionDetail(selectedMission.id),
        refreshMissionList({ preserveSelection: true, silent: true }),
      ]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const handlePauseRun = async () => {
    if (!runGraph || !selectedMission) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.pauseRun({ runId: runGraph.run.id, reason: "Paused from Missions UI." });
      await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const handleCancelRun = async () => {
    if (!runGraph || !selectedMission) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.cancelRun({ runId: runGraph.run.id, reason: "Canceled from Missions UI." });
      await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const handleResumeRun = async () => {
    if (!runGraph || !selectedMission) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.resumeRun({ runId: runGraph.run.id });
      await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  };

  const handleCleanupLanes = async () => {
    if (!selectedMission) return;
    if (!window.confirm("Archive ADE-managed lanes created by this mission?")) return;
    setCleanupBusy(true);
    try {
      const result = await window.ade.orchestrator.cleanupTeamResources({
        missionId: selectedMission.id,
        cleanupLanes: true,
      });
      if (result.laneErrors.length > 0) {
        setError(
          `Lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length}. ` +
            `${result.laneErrors.length} lane(s) failed to archive.`,
        );
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleanupBusy(false);
    }
  };

  if (!selectedMission) return null;

  return (
    <div
      className="flex items-center gap-3 shrink-0 px-4 py-2"
      style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2
            className="truncate text-sm font-bold"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
          >
            {selectedMission.title}
          </h2>
          {(() => {
            const s = STATUS_BADGE_STYLES[selectedMission.status];
            return (
              <span
                className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]"
                style={{ background: s.background, color: s.color, border: s.border, fontFamily: MONO_FONT }}
              >
                {STATUS_LABELS[selectedMission.status]}
              </span>
            );
          })()}
          {selectedMission.priority !== "normal" &&
            (() => {
              const p = PRIORITY_STYLES[selectedMission.priority];
              return (
                <span
                  className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]"
                  style={{ background: p.background, color: p.color, border: p.border, fontFamily: MONO_FONT }}
                >
                  {selectedMission.priority}
                </span>
              );
            })()}
        </div>
        <div
          className="mt-0.5 flex items-center gap-2 text-[10px]"
          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
        >
          <span>
            <Clock className="inline h-3 w-3 mr-0.5" />
            <ElapsedTime startedAt={selectedMission.startedAt ?? null} endedAt={missionElapsedEndedAt} />
          </span>
          {selectedMission.laneName && (
            <span>
              <GitBranch className="inline h-3 w-3 mr-0.5" />
              {selectedMission.laneName}
            </span>
          )}
          {executionProgress.total > 0 && (
            <span>
              {executionProgress.completed}/{executionProgress.total} steps
            </span>
          )}
        </div>
        {!chatFocused && executionProgress.total > 0 && (
          <MissionProgressBar pct={executionProgress.pct} />
        )}
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-1.5">
        {selectedMissionSummary && (
          <button
            style={outlineButton()}
            onClick={() => openManageMissionDialog(selectedMissionSummary)}
            disabled={manageMissionBusy}
          >
            <GearSix className="h-3 w-3" />
            MANAGE
          </button>
        )}
        {!chatFocused && hasNonTerminalRun && (
          <span
            className="px-1 text-[9px] uppercase tracking-[0.5px]"
            style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
            title={checkpointIndicatorTooltip}
          >
            checkpoint {checkpointIndicatorLabel}
          </span>
        )}
        {canStartOrRerun && (
          <button style={primaryButton()} onClick={() => void handleStartRun()} disabled={runBusy}>
            {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {runGraph ? "RERUN" : "START"}
          </button>
        )}
        {canPauseRun && (
          <button
            style={outlineButton({
              color: COLORS.warning,
              border: `1px solid ${COLORS.warning}40`,
              background: `${COLORS.warning}12`,
            })}
            onClick={() => void handlePauseRun()}
            disabled={runBusy}
            title="Pause run immediately (mechanical bypass)"
          >
            <span className="text-[10px]" style={{ fontFamily: MONO_FONT }}>
              &#9208;
            </span>
            PAUSE
          </button>
        )}
        {canResumeRun && (
          <button style={outlineButton()} onClick={() => void handleResumeRun()} disabled={runBusy}>
            <Play className="h-3 w-3" />
            RESUME
          </button>
        )}
        {canCancelRun && (
          <button style={dangerButton()} onClick={() => void handleCancelRun()} disabled={runBusy}>
            <Stop className="h-3 w-3" />
            CANCEL
          </button>
        )}
        {selectedMission &&
          (selectedMission.status === "failed" || selectedMission.status === "canceled") &&
          runGraph?.steps?.some((s) => s.laneId) && (
            <button style={outlineButton()} onClick={() => void handleCleanupLanes()} disabled={cleanupBusy}>
              {cleanupBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Trash className="h-3 w-3" />}
              CLEAN UP LANES
            </button>
          )}
      </div>
    </div>
  );
}

/* ────────── Progress Bar ────────── */

export function MissionProgressBar({ pct }: { pct: number }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden" style={{ background: COLORS.recessedBg }}>
      <div className="h-full transition-all" style={{ width: `${pct}%`, background: COLORS.accent }} />
    </div>
  );
}
