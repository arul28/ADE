import { useMemo, useCallback } from "react";
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
  MissionSummary,
  OrchestratorExecutorKind,
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
import { useMissionsStore, type MissionsStore } from "./useMissionsStore";
import { useShallow } from "zustand/react/shallow";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

/* ── Fine-grained derived selectors (VAL-ARCH-008) ── */
const selectHeaderData = (s: MissionsStore) => ({
  selectedMission: s.selectedMission,
  runGraph: s.runGraph,
  runBusy: s.runBusy,
  checkpointStatus: s.checkpointStatus,
  activeTab: s.activeTab,
  cleanupBusy: s.cleanupBusy,
  manageMissionBusy: s.manageMissionBusy,
});

const selectHeaderMissionSummary = (s: MissionsStore) => {
  if (!s.selectedMissionId) return null;
  return s.missions.find((m) => m.id === s.selectedMissionId) ?? null;
};

/* ════════════════════ MISSION HEADER ════════════════════ */

export function MissionHeader() {
  /* ── Grouped selector for render data (VAL-ARCH-008) ── */
  const {
    selectedMission,
    runGraph,
    runBusy,
    checkpointStatus,
    activeTab,
    cleanupBusy,
    manageMissionBusy,
  } = useMissionsStore(useShallow(selectHeaderData));

  const selectedMissionSummary = useMissionsStore(selectHeaderMissionSummary);

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

  /* ── Actions (access store imperatively to avoid extra subscriptions) ── */
  const openManageMissionDialog = useCallback((mission: MissionSummary) => {
    const s = useMissionsStore.getState();
    s.setManageMission(mission);
    s.setManageMissionCleanupLanes(false);
    s.setManageMissionError(null);
    s.setManageMissionOpen(true);
  }, []);

  const handleStartRun = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.selectedMission) return;
    s.setRunBusy(true);
    try {
      const autopilot =
        s.runGraph?.run.metadata &&
        typeof s.runGraph.run.metadata.autopilot === "object" &&
        !Array.isArray(s.runGraph.run.metadata.autopilot)
          ? (s.runGraph.run.metadata.autopilot as Record<string, unknown>)
          : null;
      const executorKind = typeof autopilot?.executorKind === "string" ? autopilot.executorKind : null;
      const fallbackExecutor: OrchestratorExecutorKind =
        executorKind && executorKind.length > 0
          ? (executorKind as OrchestratorExecutorKind)
          : "unified";
      const plannerProvider: "claude" | "codex" | null =
        executorKind === "claude" || executorKind === "codex"
          ? (executorKind as "claude" | "codex")
          : null;
      const startArgs = {
        missionId: s.selectedMission.id,
        runMode: "autopilot",
        autopilotOwnerId: "missions-autopilot",
        defaultExecutorKind: fallbackExecutor,
        defaultRetryLimit: 1,
        plannerProvider: plannerProvider ?? null,
      } satisfies StartOrchestratorRunFromMissionArgs;
      await window.ade.orchestrator.startRunFromMission(startArgs);
      await Promise.all([
        s.loadOrchestratorGraph(s.selectedMission.id),
        s.loadMissionDetail(s.selectedMission.id),
        s.refreshMissionList({ preserveSelection: true, silent: true }),
      ]);
      s.setError(null);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setRunBusy(false);
    }
  }, []);

  const handlePauseRun = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.runGraph || !s.selectedMission) return;
    s.setRunBusy(true);
    try {
      await window.ade.orchestrator.pauseRun({ runId: s.runGraph.run.id, reason: "Paused from Missions UI." });
      await s.loadOrchestratorGraph(s.selectedMission.id);
      s.setError(null);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setRunBusy(false);
    }
  }, []);

  const handleCancelRun = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.runGraph || !s.selectedMission) return;
    s.setRunBusy(true);
    try {
      await window.ade.orchestrator.cancelRun({ runId: s.runGraph.run.id, reason: "Canceled from Missions UI." });
      await s.loadOrchestratorGraph(s.selectedMission.id);
      s.setError(null);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setRunBusy(false);
    }
  }, []);

  const handleResumeRun = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.runGraph || !s.selectedMission) return;
    s.setRunBusy(true);
    try {
      await window.ade.orchestrator.resumeRun({ runId: s.runGraph.run.id });
      await s.loadOrchestratorGraph(s.selectedMission.id);
      s.setError(null);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setRunBusy(false);
    }
  }, []);

  const handleCleanupLanes = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.selectedMission) return;
    if (!window.confirm("Archive ADE-managed lanes created by this mission?")) return;
    s.setCleanupBusy(true);
    try {
      const result = await window.ade.orchestrator.cleanupTeamResources({
        missionId: s.selectedMission.id,
        cleanupLanes: true,
      });
      if (result.laneErrors.length > 0) {
        s.setError(
          `Lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length}. ` +
            `${result.laneErrors.length} lane(s) failed to archive.`,
        );
      } else {
        s.setError(null);
      }
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setCleanupBusy(false);
    }
  }, []);

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
