import { useMemo, useCallback, useEffect, useState } from "react";
import {
  Clock,
  SpinnerGap,
  Play,
  Stop,
  GearSix,
  GitBranch,
  Archive,
  XCircle,
  Gauge,
} from "@phosphor-icons/react";
import type {
  MissionSummary,
  OrchestratorExecutorKind,
  StartOrchestratorRunFromMissionArgs,
  UsageSnapshot,
} from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import {
  STATUS_CONFIG,
  PRIORITY_STYLES,
  TERMINAL_MISSION_STATUSES,
  ElapsedTime,
  computeProgress,
  LIFECYCLE_ACTIONS,
  formatResetCountdown,
  usagePercentColor,
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

  /* ── computeProgress excludes superseded/retry (VAL-UX-003) ── */
  const executionProgress = useMemo(
    () => computeProgress(runGraph?.steps ?? []),
    [runGraph?.steps],
  );

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
          : "opencode";
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

  const handleArchiveMission = useCallback(async () => {
    const s = useMissionsStore.getState();
    if (!s.selectedMission) return;
    if (!TERMINAL_MISSION_STATUSES.has(s.selectedMission.status)) return;
    if (!window.confirm("Archive this mission? This will remove it from the active list.")) return;
    s.setCleanupBusy(true);
    try {
      // Clean up lanes first
      let cleanupWarning: string | null = null;
      try {
        const result = await window.ade.orchestrator.cleanupTeamResources({
          missionId: s.selectedMission.id,
          cleanupLanes: true,
        });
        if (result.laneErrors.length > 0) {
          cleanupWarning = `Mission archived, but lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length} lane(s). ${result.laneErrors.length} lane(s) failed.`;
        }
      } catch { /* lane cleanup is best-effort */ }
      // Actually archive the mission via the mission service API
      await window.ade.missions.archive({ missionId: s.selectedMission.id });
      await s.refreshMissionList({ preserveSelection: true, silent: true });
      await s.loadDashboard();
      s.setError(cleanupWarning);
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
            const sc = STATUS_CONFIG[selectedMission.status];
            return (
              <span
                className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[1px]"
                style={{ background: sc.background, color: sc.color, border: sc.border, fontFamily: MONO_FONT }}
              >
                {sc.label}
              </span>
            );
          })()}
          {selectedMission.priority !== "normal" &&
            (() => {
              const p = PRIORITY_STYLES[selectedMission.priority];
              return (
                <span
                  className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[1px]"
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
        {!chatFocused && executionProgress.total > 0 && executionProgress.pct > 0 && (
          <MissionProgressBar pct={executionProgress.pct} />
        )}
      </div>

      {/* Usage meter (VAL-USAGE-001) */}
      <CompactUsageMeter />

      {/* Quick actions (VAL-UX-006 lifecycle actions) */}
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
        {canStartOrRerun && (
          <button style={primaryButton()} onClick={() => void handleStartRun()} disabled={runBusy}>
            {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {runGraph ? "RERUN" : "START"}
          </button>
        )}
        {canResumeRun && (
          <button style={outlineButton()} onClick={() => void handleResumeRun()} disabled={runBusy}>
            <Play className="h-3 w-3" />
            RESUME
          </button>
        )}
        {/* Pause Run — amber */}
        {canPauseRun && (
          <button
            style={outlineButton({
              color: LIFECYCLE_ACTIONS.stop_run.color,
              border: `1px solid ${LIFECYCLE_ACTIONS.stop_run.color}40`,
              background: `${LIFECYCLE_ACTIONS.stop_run.color}12`,
            })}
            onClick={() => void handlePauseRun()}
            disabled={runBusy}
            title="Pause the current run"
          >
            <Stop className="h-3 w-3" />
            PAUSE
          </button>
        )}
        {/* Cancel Mission — red with confirmation (VAL-UX-006) */}
        {canCancelRun && (
          <button
            style={dangerButton()}
            onClick={() => {
              const msg = LIFECYCLE_ACTIONS.cancel_mission.confirmText;
              if (msg && !window.confirm(msg)) return;
              void handleCancelRun();
            }}
            disabled={runBusy}
            title="Cancel the entire mission"
          >
            <XCircle className="h-3 w-3" />
            CANCEL
          </button>
        )}
        {/* Archive Mission — gray, terminal only (VAL-UX-006) */}
        {selectedMission && TERMINAL_MISSION_STATUSES.has(selectedMission.status) && (
          <button
            style={outlineButton({
              color: LIFECYCLE_ACTIONS.archive_mission.color,
              border: `1px solid ${LIFECYCLE_ACTIONS.archive_mission.color}40`,
              background: `${LIFECYCLE_ACTIONS.archive_mission.color}12`,
            })}
            onClick={() => void handleArchiveMission()}
            disabled={cleanupBusy}
            title="Archive this mission and clean up lanes"
          >
            {cleanupBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
            ARCHIVE
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

/* ────────── Compact Usage Meter (VAL-USAGE-001, VAL-USAGE-004, VAL-USAGE-005) ────────── */

function CompactUsageMeter() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const [perMissionCost, setPerMissionCost] = useState<number>(0);

  useEffect(() => {
    if (!window.ade?.usage) return;
    // Initial load
    window.ade.usage.getSnapshot().then(setSnapshot).catch(() => {});
    // Refresh every 2 minutes
    const timer = window.setInterval(() => {
      window.ade.usage.getSnapshot().then(setSnapshot).catch(() => {});
    }, 120_000);
    // Subscribe to live updates
    const unsub = window.ade.usage.onUpdate((snap) => setSnapshot(snap));
    return () => {
      window.clearInterval(timer);
      try { unsub(); } catch { /* ignore */ }
    };
  }, []);

  // Per-mission cost sourced from missionBudgetService (VAL-USAGE-005 scrutiny fix)
  useEffect(() => {
    if (!selectedMission?.id) { setPerMissionCost(0); return; }
    let cancelled = false;
    const fetchBudget = () => {
      window.ade.orchestrator
        .getMissionBudgetStatus({ missionId: selectedMission.id })
        .then((budget) => {
          if (!cancelled) setPerMissionCost(budget.mission.usedCostUsd ?? 0);
        })
        .catch(() => {
          if (!cancelled) setPerMissionCost(0);
        });
    };
    fetchBudget();
    const timer = window.setInterval(fetchBudget, 120_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedMission?.id]);

  if (!snapshot || snapshot.windows.length === 0) return null;

  const claudeWindows = snapshot.windows.filter((w) => w.provider === "claude");
  const codexWindows = snapshot.windows.filter((w) => w.provider === "codex");

  // Hide the meter entirely when all windows report 0% and there's no mission cost — it's not useful yet
  const allZero = snapshot.windows.every((w) => w.percentUsed === 0) && perMissionCost <= 0;
  if (allZero) return null;

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 shrink-0"
      style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
      title="Subscription usage"
    >
      <Gauge className="h-3 w-3 shrink-0" style={{ color: COLORS.textMuted }} />
      {claudeWindows.map((w) => (
        <UsageWindowBadge key={`claude-${w.windowType}`} provider="Claude" windowType={w.windowType} pct={w.percentUsed} resetsInMs={w.resetsInMs} />
      ))}
      {codexWindows.map((w) => (
        <UsageWindowBadge key={`codex-${w.windowType}`} provider="Codex" windowType={w.windowType} pct={w.percentUsed} resetsInMs={w.resetsInMs} />
      ))}
      {/* Per-mission cost from missionBudgetService (VAL-USAGE-005) */}
      {perMissionCost > 0 && (
        <span
          className="text-[10px]"
          style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
          title={`Mission cost: $${perMissionCost.toFixed(4)}`}
        >
          ${perMissionCost.toFixed(2)}
        </span>
      )}
    </div>
  );
}

function UsageWindowBadge({
  provider,
  windowType,
  pct,
  resetsInMs,
}: {
  provider: string;
  windowType: string;
  pct: number;
  resetsInMs: number;
}) {
  const color = usagePercentColor(pct);
  const windowLabel = windowType === "five_hour" ? "5h" : "wk";
  const resetLabel = resetsInMs > 0 ? formatResetCountdown(resetsInMs) : null;
  return (
    <span
      className="text-[10px] whitespace-nowrap"
      style={{ color, fontFamily: MONO_FONT }}
      title={`${provider} ${windowType === "five_hour" ? "5-hour" : "weekly"}: ${pct.toFixed(1)}%${resetLabel ? ` — ${resetLabel}` : ""}`}
    >
      {provider[0]}/{windowLabel} {Math.round(pct)}%
      {/* Reset countdown shown inline (VAL-USAGE-004 scrutiny fix) */}
      {resetLabel && (
        <span style={{ color: COLORS.textDim, marginLeft: 2, fontSize: 9 }}>
          ({resetLabel})
        </span>
      )}
    </span>
  );
}
