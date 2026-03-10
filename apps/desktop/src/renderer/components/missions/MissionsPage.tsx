import { useCallback, useMemo, useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "motion/react";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

/* ── Store & extracted components ── */
import { useMissionsStore } from "./useMissionsStore";
import { MissionSidebar } from "./MissionSidebar";
import { MissionDetailView } from "./MissionDetailView";
import { ManageMissionDialog, MissionContextMenu } from "./ManageMissionDialog";
import { MissionCreateDialogHost } from "./MissionCreateDialogHost";
import { MissionSettingsDialog } from "./MissionSettingsDialog";
import { useMissionPolling } from "./useMissionPolling";

import type { CreateDraft, CreateMissionDefaults } from "./CreateMissionDialog";

/* Re-export helpers used by tests */
export { collapsePlannerStreamMessages, resolveStepHeartbeatAt } from "./missionHelpers";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

/* ════════════════════ MAIN COMPONENT ════════════════════ */

export default function MissionsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const mappedLanes = useMemo(() => lanes.map((l) => ({ id: l.id, name: l.name })), [lanes]);

  /* ── Minimal store slices (VAL-ARCH-008) ── */
  const loading = useMissionsStore((s) => s.loading);
  const missionSettingsOpen = useMissionsStore((s) => s.missionSettingsOpen);
  const missionSettingsBusy = useMissionsStore((s) => s.missionSettingsBusy);
  const missionSettingsError = useMissionsStore((s) => s.missionSettingsError);
  const missionSettingsNotice = useMissionsStore((s) => s.missionSettingsNotice);
  const missionSettingsDraft = useMissionsStore((s) => s.missionSettingsDraft);

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
    void useMissionsStore.getState().refreshMissionList({ preserveSelection: true });
    void useMissionsStore.getState().loadDashboard();
  }, []);

  useEffect(() => {
    void useMissionsStore.getState().loadMissionSettings();
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.ade.orchestrator.getModelCapabilities().then(
      (result) => { if (!cancelled) useMissionsStore.getState().setModelCapabilities(result); },
      () => { if (!cancelled) useMissionsStore.getState().setModelCapabilities(null); },
    );
    return () => { cancelled = true; };
  }, []);

  /* ── Event subscriptions — delegated to store (VAL-ARCH-007) ── */
  useEffect(() => {
    const cleanup = useMissionsStore.getState().initEventSubscriptions();
    return cleanup;
  }, []);

  /* ── Selection change via consolidated getFullMissionView (VAL-ARCH-004) ── */
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  useEffect(() => {
    void useMissionsStore.getState().selectMission(selectedMissionId);
  }, [selectedMissionId]);

  /* ── Checkpoint polling via shared coordinator ── */
  const runGraph = useMissionsStore((s) => s.runGraph);
  const checkpointPollEnabled = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));
  const checkpointRunId = runGraph?.run.id ?? null;
  const refreshCheckpointStatus = useCallback(() => {
    const store = useMissionsStore.getState();
    if (!checkpointRunId) { store.setCheckpointStatus(null); return; }
    void window.ade.orchestrator.getCheckpointStatus({ runId: checkpointRunId }).then(
      (next) => store.setCheckpointStatus(next),
      () => store.setCheckpointStatus(null),
    );
  }, [checkpointRunId]);
  useMissionPolling(refreshCheckpointStatus, 10_000, checkpointPollEnabled);
  useEffect(() => {
    if (!checkpointPollEnabled) useMissionsStore.getState().setCheckpointStatus(null);
  }, [checkpointPollEnabled]);

  /* ── Step selection reconciliation ── */
  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    const store = useMissionsStore.getState();
    const currentStepId = store.selectedStepId;
    if (!steps.length) {
      if (currentStepId !== null) store.setSelectedStepId(null);
      return;
    }
    if (currentStepId && steps.some((s) => s.id === currentStepId)) return;
    const running = steps.find((s) => s.status === "running");
    store.setSelectedStepId((running ?? steps[0]).id);
  }, [runGraph]);

  useEffect(() => {
    useMissionsStore.getState().setCoordinatorPromptInspector(null);
    useMissionsStore.getState().setWorkerPromptInspector(null);
  }, [selectedMissionId]);

  /* ── Attention toast notifications (timers owned by store, VAL-ARCH-007) ── */
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const prevMissionStatusRef = useRef<string | null>(null);
  const prevOpenInterventionCountRef = useRef<number>(0);

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

    const store = useMissionsStore.getState();
    if (currentStatus === "intervention_required" && prevStatus !== "intervention_required") {
      store.addAttentionToast("Mission requires intervention", "warning", selectedMission.title, selectedMission.id);
    } else if (currentStatus === "failed" && prevStatus !== "failed") {
      store.addAttentionToast("Mission has failed", "error", selectedMission.title, selectedMission.id);
    } else if (currentOpenCount > prevOpenCount && currentStatus === "in_progress") {
      store.addAttentionToast(
        `${currentOpenCount - prevOpenCount} new intervention${currentOpenCount - prevOpenCount === 1 ? "" : "s"} opened`,
        "warning",
        selectedMission.title,
        selectedMission.id,
      );
    }
  }, [selectedMission?.status, selectedMission?.openInterventions, selectedMission?.id, selectedMission?.title, selectedMission]);

  useEffect(() => {
    return () => useMissionsStore.getState().cleanupToastTimers();
  }, []);

  /* ── Mission launch handler ── */
  const handleLaunchMission = useCallback(
    async (draft: CreateDraft) => {
      const store = useMissionsStore.getState();
      const prompt = draft.prompt.trim();
      if (!prompt) { store.setError("Mission prompt is required."); return; }
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
        store.setSelectedMissionId(created.id);
        await store.selectMission(created.id);
        await store.refreshMissionList({ preserveSelection: true, silent: true });
        store.setError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [defaultCreateLaneId],
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
          useMissionsStore.getState().setMissionSettingsOpen(false);
        }}
        draft={missionSettingsDraft}
        onDraftChange={(update) => useMissionsStore.getState().setMissionSettingsDraft((prev) => ({ ...prev, ...update }))}
        onSave={() => void useMissionsStore.getState().saveMissionSettings()}
        busy={missionSettingsBusy}
        error={missionSettingsError}
        notice={missionSettingsNotice}
      />
    </LazyMotion>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
