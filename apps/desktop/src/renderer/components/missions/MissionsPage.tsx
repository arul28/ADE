import { useCallback, useMemo, useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "motion/react";
import type { MissionDetail, MissionSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

/* ── Store & extracted components ── */
import { useMissionsStore } from "./useMissionsStore";
import { MissionSidebar } from "./MissionSidebar";
import { MissionDetailView } from "./MissionDetailView";
import { ManageMissionDialog, MissionContextMenu } from "./ManageMissionDialog";
import { MissionCreateDialogHost } from "./MissionCreateDialogHost";
import { MissionSettingsDialog } from "./MissionSettingsDialog";
import { openMissionCreateDialog } from "./missionCreateDialogStore";
import { useMissionPolling } from "./useMissionPolling";

import type { CreateDraft, CreateMissionDefaults } from "./CreateMissionDialog";
import {
  DEFAULT_PERMISSION_CONFIG,
  TERMINAL_MISSION_STATUSES,
} from "./missionHelpers";
import type { MissionAttentionToast } from "./useMissionsStore";

/* Re-export helpers used by tests */
export { collapsePlannerStreamMessages, resolveStepHeartbeatAt } from "./missionHelpers";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

/* ════════════════════ MAIN COMPONENT ════════════════════ */

export default function MissionsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const mappedLanes = useMemo(() => lanes.map((l) => ({ id: l.id, name: l.name })), [lanes]);

  /* ── Store selectors ── */
  const loading = useMissionsStore((s) => s.loading);
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const runGraph = useMissionsStore((s) => s.runGraph);
  const missionSettingsOpen = useMissionsStore((s) => s.missionSettingsOpen);
  const missionSettingsBusy = useMissionsStore((s) => s.missionSettingsBusy);
  const missionSettingsError = useMissionsStore((s) => s.missionSettingsError);
  const missionSettingsNotice = useMissionsStore((s) => s.missionSettingsNotice);
  const missionSettingsDraft = useMissionsStore((s) => s.missionSettingsDraft);
  const attentionToasts = useMissionsStore((s) => s.attentionToasts);

  /* ── Store actions ── */
  const setSelectedMissionId = useMissionsStore((s) => s.setSelectedMissionId);
  const setError = useMissionsStore((s) => s.setError);
  const setMissionSettingsOpen = useMissionsStore((s) => s.setMissionSettingsOpen);
  const setMissionSettingsDraft = useMissionsStore((s) => s.setMissionSettingsDraft);
  const setAttentionToasts = useMissionsStore((s) => s.setAttentionToasts);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadDashboard = useMissionsStore((s) => s.loadDashboard);
  const loadMissionDetail = useMissionsStore((s) => s.loadMissionDetail);
  const loadOrchestratorGraph = useMissionsStore((s) => s.loadOrchestratorGraph);
  const loadRunArtifacts = useMissionsStore((s) => s.loadRunArtifacts);
  const loadMissionSettings = useMissionsStore((s) => s.loadMissionSettings);
  const saveMissionSettings = useMissionsStore((s) => s.saveMissionSettings);
  const clearSelection = useMissionsStore((s) => s.clearSelection);
  const setCheckpointStatus = useMissionsStore((s) => s.setCheckpointStatus);
  const setModelCapabilities = useMissionsStore((s) => s.setModelCapabilities);
  const setSelectedStepId = useMissionsStore((s) => s.setSelectedStepId);
  const setCoordinatorPromptInspector = useMissionsStore((s) => s.setCoordinatorPromptInspector);
  const setWorkerPromptInspector = useMissionsStore((s) => s.setWorkerPromptInspector);
  const setWorkerPromptError = useMissionsStore((s) => s.setWorkerPromptError);

  /* ── Default lane for create dialog ── */
  const defaultCreateLaneId = useMemo(
    () => lanes.find((l) => l.laneType === "primary")?.id ?? lanes[0]?.id ?? null,
    [lanes],
  );

  const createMissionDefaults = useMemo<CreateMissionDefaults>(
    () => ({
      plannerProvider: missionSettingsDraft.defaultPlannerProvider,
      orchestratorModel: missionSettingsDraft.defaultOrchestratorModel,
      permissionConfig: missionSettingsDraft.permissionConfig,
    }),
    [missionSettingsDraft],
  );

  /* ── Initial data load ── */
  useEffect(() => {
    void refreshMissionList({ preserveSelection: true });
    void loadDashboard();
  }, [refreshMissionList, loadDashboard]);

  useEffect(() => {
    void loadMissionSettings();
  }, [loadMissionSettings]);

  useEffect(() => {
    let cancelled = false;
    window.ade.orchestrator.getModelCapabilities().then(
      (result) => { if (!cancelled) setModelCapabilities(result); },
      () => { if (!cancelled) setModelCapabilities(null); },
    );
    return () => { cancelled = true; };
  }, [setModelCapabilities]);

  /* ── Selection change handling ── */
  useEffect(() => {
    if (!selectedMissionId) {
      clearSelection();
      return;
    }
    useMissionsStore.getState().setChatJumpTarget(null);
    useMissionsStore.getState().setLogsFocusInterventionId(null);
    useMissionsStore.getState().setActivityPanelMode("signal");
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, clearSelection, loadMissionDetail, loadOrchestratorGraph]);

  /* ── Load artifacts when run changes ── */
  useEffect(() => {
    if (!selectedMissionId) return;
    const runId = runGraph?.run.id ?? null;
    void loadRunArtifacts(selectedMissionId, runId);
  }, [loadRunArtifacts, runGraph?.run.id, selectedMissionId]);

  /* ── Checkpoint polling via shared coordinator (no setInterval in component) ── */
  const checkpointPollEnabled = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));
  const checkpointRunId = runGraph?.run.id ?? null;
  const refreshCheckpointStatus = useCallback(() => {
    if (!checkpointRunId) { setCheckpointStatus(null); return; }
    void window.ade.orchestrator.getCheckpointStatus({ runId: checkpointRunId }).then(
      (next) => setCheckpointStatus(next),
      () => setCheckpointStatus(null),
    );
  }, [checkpointRunId, setCheckpointStatus]);
  useMissionPolling(refreshCheckpointStatus, 10_000, checkpointPollEnabled);
  useEffect(() => {
    if (!checkpointPollEnabled) setCheckpointStatus(null);
  }, [checkpointPollEnabled, setCheckpointStatus]);

  /* ── Event subscriptions (debounced, in store layer effectively) ── */
  const graphRefreshTimerRef = useRef<number | null>(null);
  const missionEventTimerRef = useRef<number | null>(null);
  const orchestratorEventTimerRef = useRef<number | null>(null);

  const scheduleOrchestratorGraphRefresh = useCallback(
    (missionId: string, delayMs = 180) => {
      if (graphRefreshTimerRef.current !== null) window.clearTimeout(graphRefreshTimerRef.current);
      graphRefreshTimerRef.current = window.setTimeout(() => {
        graphRefreshTimerRef.current = null;
        void loadOrchestratorGraph(missionId);
      }, delayMs);
    },
    [loadOrchestratorGraph],
  );

  useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      missionEventTimerRef.current = window.setTimeout(() => {
        missionEventTimerRef.current = null;
        void refreshMissionList({ preserveSelection: true, silent: true });
        void loadDashboard();
        const currentSelectedId = useMissionsStore.getState().selectedMissionId;
        if (payload.missionId && payload.missionId === currentSelectedId) {
          void loadMissionDetail(payload.missionId);
          scheduleOrchestratorGraphRefresh(payload.missionId, 120);
          void loadRunArtifacts(payload.missionId, useMissionsStore.getState().runGraph?.run.id ?? null);
        }
      }, 300);
    });
    return () => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, loadMissionDetail, loadRunArtifacts, refreshMissionList, scheduleOrchestratorGraphRefresh]);

  useEffect(() => {
    const unsub = window.ade.orchestrator.onEvent((event) => {
      const currentSelectedId = useMissionsStore.getState().selectedMissionId;
      if (!currentSelectedId) return;
      const selectedRunId = useMissionsStore.getState().runGraph?.run.id ?? null;
      if (selectedRunId && event.runId && event.runId !== selectedRunId) return;
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      orchestratorEventTimerRef.current = window.setTimeout(() => {
        orchestratorEventTimerRef.current = null;
        scheduleOrchestratorGraphRefresh(currentSelectedId);
        void loadDashboard();
        void loadRunArtifacts(currentSelectedId, selectedRunId);
      }, 300);
    });
    return () => {
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, loadRunArtifacts, scheduleOrchestratorGraphRefresh]);

  useEffect(() => {
    return () => {
      if (graphRefreshTimerRef.current !== null) window.clearTimeout(graphRefreshTimerRef.current);
    };
  }, []);

  /* ── Step selection reconciliation ── */
  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    const currentStepId = useMissionsStore.getState().selectedStepId;
    if (!steps.length) {
      if (currentStepId !== null) setSelectedStepId(null);
      return;
    }
    if (currentStepId && steps.some((s) => s.id === currentStepId)) return;
    const running = steps.find((s) => s.status === "running");
    setSelectedStepId((running ?? steps[0]).id);
  }, [runGraph, setSelectedStepId]);

  useEffect(() => {
    setCoordinatorPromptInspector(null);
    setWorkerPromptInspector(null);
  }, [selectedMissionId, setCoordinatorPromptInspector, setWorkerPromptInspector]);

  useEffect(() => {
    setWorkerPromptInspector(null);
    setWorkerPromptError(null);
  }, [useMissionsStore.getState().selectedStepId, setWorkerPromptInspector, setWorkerPromptError]);

  /* ── Attention toast notifications ── */
  const prevMissionStatusRef = useRef<string | null>(null);
  const prevOpenInterventionCountRef = useRef<number>(0);
  const attentionToastTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!selectedMission) {
      prevMissionStatusRef.current = null;
      prevOpenInterventionCountRef.current = 0;
      return;
    }
    const prevStatus = prevMissionStatusRef.current;
    const prevOpenCount = prevOpenInterventionCountRef.current;
    const currentStatus = selectedMission.status;
    const currentOpenCount = selectedMission.openInterventions;
    prevMissionStatusRef.current = currentStatus;
    prevOpenInterventionCountRef.current = currentOpenCount;
    if (prevStatus === null) return;

    const dismissToast = (id: string) => {
      setAttentionToasts(useMissionsStore.getState().attentionToasts.filter((t) => t.id !== id));
      const timer = attentionToastTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      attentionToastTimersRef.current.delete(id);
    };

    const addToast = (message: string, severity: "warning" | "error") => {
      const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      setAttentionToasts([
        { id, missionTitle: selectedMission.title, message, severity, missionId: selectedMission.id },
        ...useMissionsStore.getState().attentionToasts,
      ].slice(0, 3));
      const timer = window.setTimeout(() => dismissToast(id), 12_000);
      attentionToastTimersRef.current.set(id, timer);
    };

    if (currentStatus === "intervention_required" && prevStatus !== "intervention_required") {
      addToast("Mission requires intervention", "warning");
    } else if (currentStatus === "failed" && prevStatus !== "failed") {
      addToast("Mission has failed", "error");
    } else if (currentOpenCount > prevOpenCount && currentStatus === "in_progress") {
      addToast(
        `${currentOpenCount - prevOpenCount} new intervention${currentOpenCount - prevOpenCount === 1 ? "" : "s"} opened`,
        "warning",
      );
    }
  }, [selectedMission?.status, selectedMission?.openInterventions, selectedMission?.id, selectedMission?.title, setAttentionToasts, selectedMission]);

  useEffect(() => {
    return () => {
      for (const timer of attentionToastTimersRef.current.values()) window.clearTimeout(timer);
      attentionToastTimersRef.current.clear();
    };
  }, []);

  /* ── Mission launch handler ── */
  const handleLaunchMission = useCallback(
    async (draft: CreateDraft) => {
      const prompt = draft.prompt.trim();
      if (!prompt) { setError("Mission prompt is required."); return; }
      const resolvedLaneId = draft.laneId.trim() || defaultCreateLaneId || "";
      try {
        const created = await window.ade.missions.create({
          title: draft.title.trim() || undefined,
          prompt,
          laneId: resolvedLaneId || undefined,
          priority: draft.priority,
          agentRuntime: draft.agentRuntime,
          teamRuntime: draft.teamRuntime,
          executionPolicy: {
            prStrategy: draft.prStrategy,
            ...(draft.teamRuntime ? { teamRuntime: draft.teamRuntime } : {}),
          },
          modelConfig: {
            ...draft.modelConfig,
            decisionTimeoutCapHours: draft.modelConfig.decisionTimeoutCapHours ?? 24,
          },
          phaseProfileId: draft.phaseProfileId,
          phaseOverride: draft.phaseOverride,
          permissionConfig: draft.permissionConfig,
          autostart: true,
          launchMode: "autopilot",
        });
        setSelectedMissionId(created.id);
        await Promise.all([
          refreshMissionList({ preserveSelection: true, silent: true }),
          loadMissionDetail(created.id),
          loadOrchestratorGraph(created.id),
        ]);
        setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [defaultCreateLaneId, refreshMissionList, loadMissionDetail, loadOrchestratorGraph, setError, setSelectedMissionId],
  );

  /* ── Loading screen ── */
  if (loading) {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48" style={{ background: COLORS.border }} />
            <div className="h-3 w-32" style={{ background: `${COLORS.border}60` }} />
          </div>
          <div
            className="text-[10px] font-bold uppercase tracking-[1px]"
            style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
          >
            LOADING MISSIONS...
          </div>
        </div>
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <div className="flex h-full min-h-0" style={{ background: COLORS.pageBg }}>
        {/* Sidebar */}
        <MissionSidebar />

        {/* Main workspace */}
        <div className="flex flex-1 flex-col min-w-0" style={{ background: COLORS.pageBg }}>
          <MissionDetailView />
        </div>
      </div>

      {/* Context Menu */}
      <MissionContextMenu />

      {/* Manage Mission Dialog */}
      <ManageMissionDialog />

      {/* Create Mission Dialog */}
      <MissionCreateDialogHost
        lanes={mappedLanes}
        defaultLaneId={defaultCreateLaneId}
        missionDefaults={createMissionDefaults}
        onLaunch={handleLaunchMission}
      />

      {/* Mission Settings Dialog */}
      <MissionSettingsDialog
        open={missionSettingsOpen}
        onClose={() => {
          if (missionSettingsBusy) return;
          setMissionSettingsOpen(false);
        }}
        draft={missionSettingsDraft}
        onDraftChange={(update) => setMissionSettingsDraft((prev) => ({ ...prev, ...update }))}
        onSave={() => void saveMissionSettings()}
        busy={missionSettingsBusy}
        error={missionSettingsError}
        notice={missionSettingsNotice}
      />
    </LazyMotion>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
