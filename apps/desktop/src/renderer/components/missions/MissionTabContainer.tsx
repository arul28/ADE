import { useMemo } from "react";
import {
  SquaresFour,
  ChatCircle,
  Pulse,
} from "@phosphor-icons/react";
import type {
  OrchestratorAttempt,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { type WorkspaceTab, isRecord } from "./missionHelpers";
import { useMissionsStore, type MissionsStore } from "./useMissionsStore";
import { useShallow } from "zustand/react/shallow";

/* ── Imported tab content components ── */
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";
import { CompletionBanner } from "./CompletionBanner";
import { MissionChatV2 } from "./MissionChatV2";
import { PlanTab } from "./PlanTab";
import { StepDetailPanel } from "./StepDetailPanel";
import { ActivityNarrativeHeader } from "./ActivityNarrativeHeader";
import { MissionRunPanel } from "./MissionRunPanel";
import { MissionLogsTab } from "./MissionLogsTab";
import { MissionArtifactsTab } from "./MissionArtifactsTab";
import { MissionActivePhasePanel } from "./MissionActivePhasePanel";
import { PromptInspectorCard } from "./PromptInspectorCard";
import { buildMissionArtifactGroups, deriveActivePhaseViewModel } from "./missionControlViewModel";
import { useMissionRunView } from "./useMissionRunView";
import { routeMissionIntervention } from "./missionInterventionRouting";

/* ════════════════════ TAB NAVIGATION ════════════════════ */

/**
 * Flat tab navigation — all views 1-click reachable. (VAL-UX-004)
 * No sub-toggles: planSubview and activityPanelMode eliminated from tab nav.
 */
export function MissionTabNavigation() {
  const activeTab = useMissionsStore((s) => s.activeTab);
  const setActiveTab = useMissionsStore((s) => s.setActiveTab);

  const tabs: Array<{ key: WorkspaceTab; label: string; icon: typeof SquaresFour }> = [
    { key: "overview", label: "Overview", icon: SquaresFour },
    { key: "chat", label: "Feed", icon: ChatCircle },
    { key: "plan", label: "Plan", icon: SquaresFour },
    { key: "history", label: "Timeline", icon: Pulse },
    { key: "artifacts", label: "Artifacts", icon: Pulse },
  ];

  return (
    <div className="flex items-center gap-0 px-3" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] transition-colors"
            style={{
              color: isActive ? COLORS.textPrimary : COLORS.textMuted,
              fontFamily: SANS_FONT,
              fontWeight: isActive ? 600 : 400,
              borderBottom: isActive ? `2px solid ${COLORS.accent}` : "2px solid transparent",
              background: "transparent",
            }}
          >
            <tab.icon className="h-3.5 w-3.5" style={{ color: isActive ? COLORS.accent : COLORS.textDim }} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════ Grouped selectors (VAL-ARCH-008) ══════════════════ */

/** Core render data for tab content — grouped to avoid N separate subscriptions. */
const selectTabContentData = (s: MissionsStore) => ({
  selectedMissionId: s.selectedMissionId,
  selectedMission: s.selectedMission,
  runGraph: s.runGraph,
  activeTab: s.activeTab,
  planSubview: s.planSubview,
  selectedStepId: s.selectedStepId,
  activityPanelMode: s.activityPanelMode,
  orchestratorArtifacts: s.orchestratorArtifacts,
  workerCheckpoints: s.workerCheckpoints,
  modelCapabilities: s.modelCapabilities,
  chatJumpTarget: s.chatJumpTarget,
  logsFocusInterventionId: s.logsFocusInterventionId,
  steerBusy: s.steerBusy,
});

/** Prompt inspector state — rarely changes, grouped separately. */
const selectPromptInspectorData = (s: MissionsStore) => ({
  coordinatorPromptInspector: s.coordinatorPromptInspector,
  coordinatorPromptLoading: s.coordinatorPromptLoading,
  coordinatorPromptError: s.coordinatorPromptError,
  workerPromptInspector: s.workerPromptInspector,
  workerPromptLoading: s.workerPromptLoading,
  workerPromptError: s.workerPromptError,
});

/* ════════════════════ TAB CONTENT ════════════════════ */

export function MissionTabContent() {
  /* ── Grouped selectors (VAL-ARCH-008) ── */
  const {
    selectedMissionId,
    selectedMission,
    runGraph,
    activeTab,
    planSubview,
    selectedStepId,
    activityPanelMode,
    orchestratorArtifacts,
    workerCheckpoints,
    modelCapabilities,
    chatJumpTarget,
    logsFocusInterventionId,
    steerBusy,
  } = useMissionsStore(useShallow(selectTabContentData));

  const {
    coordinatorPromptInspector,
    coordinatorPromptLoading,
    coordinatorPromptError,
    workerPromptInspector,
    workerPromptLoading,
    workerPromptError,
  } = useMissionsStore(useShallow(selectPromptInspectorData));

  const runSteps = useMemo(() => runGraph?.steps ?? [], [runGraph?.steps]);
  const runClaims = useMemo(() => runGraph?.claims ?? [], [runGraph?.claims]);
  const runTimeline = useMemo(() => runGraph?.timeline ?? [], [runGraph?.timeline]);

  const { runView } = useMissionRunView(selectedMissionId, runGraph?.run.id ?? null);

  const attemptsByStep = useMemo(() => {
    const map = new Map<string, OrchestratorAttempt[]>();
    if (!runGraph) return map;
    for (const attempt of runGraph.attempts) {
      const bucket = map.get(attempt.stepId) ?? [];
      bucket.push(attempt);
      map.set(attempt.stepId, bucket);
    }
    return map;
  }, [runGraph]);

  const selectedStep = useMemo(() => {
    if (!selectedStepId || !runGraph?.steps?.length) return null;
    return runGraph.steps.find((step) => step.id === selectedStepId) ?? null;
  }, [runGraph, selectedStepId]);

  const selectedStepAttempts = useMemo(() => {
    if (!selectedStep) return [];
    return attemptsByStep.get(selectedStep.id) ?? [];
  }, [attemptsByStep, selectedStep]);

  const steeringLog = useMemo<Array<{ directive: string; appliedAt: string }>>(() => [], []);

  const activePhaseView = useMemo(
    () => deriveActivePhaseViewModel({ mission: selectedMission, runGraph, modelCapabilities }),
    [modelCapabilities, runGraph, selectedMission],
  );

  const missionPhaseBadge = useMemo(() => {
    const runMeta = isRecord(runGraph?.run?.metadata) ? runGraph.run.metadata : null;
    const runPhaseOverride = Array.isArray(runMeta?.phaseOverride)
      ? (runMeta.phaseOverride as import("../../../shared/types").PhaseCard[])
      : null;
    const missionPhaseOverride = Array.isArray(selectedMission?.phaseConfiguration?.selectedPhases)
      ? selectedMission.phaseConfiguration.selectedPhases
      : null;
    return {
      phases: runPhaseOverride && runPhaseOverride.length > 0 ? runPhaseOverride : missionPhaseOverride,
    };
  }, [runGraph?.run?.metadata, selectedMission?.phaseConfiguration]);

  const groupedArtifacts = useMemo(
    () =>
      buildMissionArtifactGroups({
        mission: selectedMission,
        runGraph,
        orchestratorArtifacts,
        checkpoints: workerCheckpoints,
      }),
    [orchestratorArtifacts, runGraph, selectedMission, workerCheckpoints],
  );

  const chatFocused = activeTab === "chat";
  const compactPhaseChrome = chatFocused;
  const showCompletionBanner = activeTab !== "chat";

  /* ── Prompt inspectors (imperative store access to avoid extra subscriptions) ── */
  const loadCoordinatorPromptInspector = async () => {
    const s = useMissionsStore.getState();
    if (!s.runGraph) return;
    s.setCoordinatorPromptLoading(true);
    s.setCoordinatorPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: s.runGraph.run.id,
        target: "coordinator",
      });
      s.setCoordinatorPromptInspector(inspector);
    } catch (err) {
      s.setCoordinatorPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setCoordinatorPromptLoading(false);
    }
  };

  const loadWorkerPromptInspector = async (stepId: string) => {
    const s = useMissionsStore.getState();
    if (!s.runGraph) return;
    s.setWorkerPromptLoading(true);
    s.setWorkerPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: s.runGraph.run.id,
        target: "worker",
        stepId,
      });
      s.setWorkerPromptInspector(inspector);
    } catch (err) {
      s.setWorkerPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setWorkerPromptLoading(false);
    }
  };

  /* ── Intervention handling (imperative store access) ── */
  const handleOpenIntervention = (interventionId: string) => {
    const s = useMissionsStore.getState();
    routeMissionIntervention(s, interventionId);
  };

  const handleInterventionResponse = async (interventionId: string, directiveText: string) => {
    const s = useMissionsStore.getState();
    if (!s.selectedMission) return;
    s.setSteerBusy(true);
    try {
      await window.ade.orchestrator.steerMission({
        missionId: s.selectedMission.id,
        interventionId,
        directive: directiveText,
        priority: "instruction",
      });
      s.setActiveInterventionId(null);
      await s.refreshMissionList({ preserveSelection: true, silent: true });
      await s.selectMission(s.selectedMission.id);
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err));
    } finally {
      s.setSteerBusy(false);
    }
  };

  return (
    <>
      {runGraph && (
        <MissionActivePhasePanel activePhase={activePhaseView} allPhases={missionPhaseBadge.phases} promptInspector={coordinatorPromptInspector} promptLoading={coordinatorPromptLoading} promptError={coordinatorPromptError} onInspectPrompt={() => void loadCoordinatorPromptInspector()} coordinatorAvailability={runView?.coordinator.available != null ? { available: runView.coordinator.available, mode: runView.coordinator.mode ?? "offline", summary: runView.coordinator.summary ?? null } : null} compact={compactPhaseChrome} />
      )}

      {/* Completion Banner */}
      {runGraph && showCompletionBanner && (<div className="px-4 pt-3 space-y-2"><CompletionBanner status={runGraph.run.status} evaluation={runGraph.completionEvaluation} runId={runGraph.run.id} /></div>)}
      {/* Tab Content */}
      <div
        className={cn(
          "flex-1 min-h-0",
          activeTab === "chat" ? "flex flex-col overflow-hidden" : "overflow-y-auto overflow-x-hidden p-4",
        )}
      >
        {activeTab === "overview" && selectedMission && (
          <div className="space-y-3">
            <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
              <div className="text-[10px] font-semibold" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                Prompt
              </div>
              <div className="mt-1.5 text-[12px]" style={{ color: COLORS.textPrimary, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {selectedMission.prompt}
              </div>
            </div>
            <MissionRunPanel
              runView={runView}
              interventions={selectedMission.interventions}
              onOpenIntervention={handleOpenIntervention}
              showInterventions={false}
              hideInterventionHaltReason
            />
          </div>
        )}

        {activeTab === "plan" && (
          <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
              <PlanTab mission={selectedMission} runGraph={runGraph} attemptsByStep={attemptsByStep} selectedStepId={selectedStepId} onStepSelect={(id) => useMissionsStore.getState().setSelectedStepId(id)} />
            </div>
            <div className="space-y-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
              <StepDetailPanel step={selectedStep} attempts={selectedStepAttempts} allSteps={runSteps} claims={runClaims} onOpenWorkerThread={(target) => { useMissionsStore.getState().setChatJumpTarget(target); useMissionsStore.getState().setActiveTab("chat"); }} onInspectPrompt={(stepId) => void loadWorkerPromptInspector(stepId)} />
              {selectedStep ? <PromptInspectorCard inspector={workerPromptInspector} loading={workerPromptLoading} error={workerPromptError} title="Selected step effective prompt" /> : null}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="space-y-3">
            <ActivityNarrativeHeader runGraph={runGraph} steeringLog={steeringLog} />
            <OrchestratorActivityFeed runId={runGraph?.run.id ?? ""} initialTimeline={runTimeline} />
            {Array.isArray(runGraph?.run?.metadata?.runNarrative) && (runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).length > 0 && (
              <div className="space-y-1.5 mt-4">
                <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: COLORS.textMuted }}>RUN NARRATIVE</div>
                <div className="space-y-1">{(runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).map((entry, i: number) => (
                  <div key={i} className="text-[11px] flex gap-2 items-start" style={{ fontFamily: MONO_FONT }}><span className="shrink-0" style={{ color: COLORS.accent }}>{entry.stepKey}</span><span style={{ color: COLORS.textSecondary }}>{entry.summary}</span></div>
                ))}</div>
              </div>
            )}
            {selectedMission && (
              <MissionLogsTab
                missionId={selectedMission.id}
                runId={runGraph?.run.id ?? null}
                focusInterventionId={logsFocusInterventionId}
                onFocusHandled={() => useMissionsStore.getState().setLogsFocusInterventionId(null)}
              />
            )}
          </div>
        )}

        {activeTab === "chat" && selectedMissionId && (
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <MissionChatV2
              missionId={selectedMissionId}
              missionStatus={selectedMission?.status ?? null}
              runId={runGraph?.run.id ?? null}
              runStatus={runGraph?.run.status ?? null}
              runMetadata={runGraph?.run.metadata ?? null}
              runView={runView}
              interventions={selectedMission?.interventions ?? []}
              jumpTarget={chatJumpTarget}
              onJumpHandled={() => useMissionsStore.getState().setChatJumpTarget(null)}
              onOpenIntervention={handleOpenIntervention}
            />
          </div>
        )}

        {activeTab === "artifacts" && (
          <MissionArtifactsTab
            groupedArtifacts={groupedArtifacts}
            closeoutRequirements={runView?.closeoutRequirements ?? []}
            missionId={selectedMissionId}
            runId={runGraph?.run.id ?? null}
          />
        )}
      </div>
    </>
  );
}
