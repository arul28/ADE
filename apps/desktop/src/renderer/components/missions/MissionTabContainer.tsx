import { useMemo } from "react";
import {
  SquaresFour,
  ChatCircle,
  Pulse,
} from "@phosphor-icons/react";
import type {
  OrchestratorAttempt,
  OrchestratorChatTarget,
  OrchestratorRunGraph,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { type WorkspaceTab, filterExecutionSteps, isRecord } from "./missionHelpers";
import { useMissionsStore } from "./useMissionsStore";

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

/* ════════════════════ TAB NAVIGATION ════════════════════ */

export function MissionTabNavigation() {
  const activeTab = useMissionsStore((s) => s.activeTab);
  const setActiveTab = useMissionsStore((s) => s.setActiveTab);

  const primaryWorkspaceTab = useMemo(() => {
    if (activeTab === "overview") return "intake" as const;
    if (activeTab === "plan" || activeTab === "chat") return "run" as const;
    return "evidence" as const;
  }, [activeTab]);

  return (
    <div className="flex items-center gap-0 px-3" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
      {([
        { key: "intake" as const, tab: "overview" as WorkspaceTab, label: "Intake", icon: SquaresFour },
        { key: "run" as const, tab: "chat" as WorkspaceTab, label: "Run", icon: ChatCircle },
        { key: "evidence" as const, tab: "history" as WorkspaceTab, label: "Evidence", icon: Pulse },
      ]).map((tab) => {
        const isActive = primaryWorkspaceTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.tab)}
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
      <div className="ml-auto flex items-center gap-1">
        {primaryWorkspaceTab === "run" ? (
          <>
            <SubTabButton label="Feed" tab="chat" activeTab={activeTab} onSelect={setActiveTab} />
            <SubTabButton label="Plan" tab="plan" activeTab={activeTab} onSelect={setActiveTab} />
          </>
        ) : null}
        {primaryWorkspaceTab === "evidence" ? (
          <>
            <SubTabButton label="Timeline" tab="history" activeTab={activeTab} onSelect={setActiveTab} />
            <SubTabButton label="Artifacts" tab="artifacts" activeTab={activeTab} onSelect={setActiveTab} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function SubTabButton(props: {
  label: string;
  tab: WorkspaceTab;
  activeTab: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
}) {
  const isActive = props.activeTab === props.tab;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.tab)}
      className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px]"
      style={
        isActive
          ? { background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}35`, color: COLORS.accent, fontFamily: MONO_FONT }
          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }
      }
    >
      {props.label}
    </button>
  );
}

/* ════════════════════ TAB CONTENT ════════════════════ */

export function MissionTabContent() {
  const selectedMissionId = useMissionsStore((s) => s.selectedMissionId);
  const selectedMission = useMissionsStore((s) => s.selectedMission);
  const runGraph = useMissionsStore((s) => s.runGraph);
  const activeTab = useMissionsStore((s) => s.activeTab);
  const planSubview = useMissionsStore((s) => s.planSubview);
  const selectedStepId = useMissionsStore((s) => s.selectedStepId);
  const activityPanelMode = useMissionsStore((s) => s.activityPanelMode);
  const orchestratorArtifacts = useMissionsStore((s) => s.orchestratorArtifacts);
  const workerCheckpoints = useMissionsStore((s) => s.workerCheckpoints);
  const modelCapabilities = useMissionsStore((s) => s.modelCapabilities);
  const coordinatorPromptInspector = useMissionsStore((s) => s.coordinatorPromptInspector);
  const coordinatorPromptLoading = useMissionsStore((s) => s.coordinatorPromptLoading);
  const coordinatorPromptError = useMissionsStore((s) => s.coordinatorPromptError);
  const workerPromptInspector = useMissionsStore((s) => s.workerPromptInspector);
  const workerPromptLoading = useMissionsStore((s) => s.workerPromptLoading);
  const workerPromptError = useMissionsStore((s) => s.workerPromptError);
  const chatJumpTarget = useMissionsStore((s) => s.chatJumpTarget);
  const logsFocusInterventionId = useMissionsStore((s) => s.logsFocusInterventionId);
  const steerBusy = useMissionsStore((s) => s.steerBusy);

  const setPlanSubview = useMissionsStore((s) => s.setPlanSubview);
  const setSelectedStepId = useMissionsStore((s) => s.setSelectedStepId);
  const setActiveTab = useMissionsStore((s) => s.setActiveTab);
  const setActivityPanelMode = useMissionsStore((s) => s.setActivityPanelMode);
  const setChatJumpTarget = useMissionsStore((s) => s.setChatJumpTarget);
  const setLogsFocusInterventionId = useMissionsStore((s) => s.setLogsFocusInterventionId);
  const setError = useMissionsStore((s) => s.setError);
  const setSteerBusy = useMissionsStore((s) => s.setSteerBusy);
  const setActiveInterventionId = useMissionsStore((s) => s.setActiveInterventionId);
  const refreshMissionList = useMissionsStore((s) => s.refreshMissionList);
  const loadMissionDetail = useMissionsStore((s) => s.loadMissionDetail);
  const loadOrchestratorGraph = useMissionsStore((s) => s.loadOrchestratorGraph);

  const runSteps = useMemo(() => runGraph?.steps ?? [], [runGraph?.steps]);
  const runAttempts = useMemo(() => runGraph?.attempts ?? [], [runGraph?.attempts]);
  const runClaims = useMemo(() => runGraph?.claims ?? [], [runGraph?.claims]);
  const runTimeline = useMemo(() => runGraph?.timeline ?? [], [runGraph?.timeline]);
  const executionSteps = useMemo(() => filterExecutionSteps(runSteps), [runSteps]);

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

  const failedExecutionSteps = useMemo(
    () => executionSteps.filter((step) => step.status === "failed"),
    [executionSteps],
  );

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

  /* ── Prompt inspectors ── */
  const loadCoordinatorPromptInspector = async () => {
    if (!runGraph) return;
    useMissionsStore.getState().setCoordinatorPromptLoading(true);
    useMissionsStore.getState().setCoordinatorPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: runGraph.run.id,
        target: "coordinator",
      });
      useMissionsStore.getState().setCoordinatorPromptInspector(inspector);
    } catch (err) {
      useMissionsStore.getState().setCoordinatorPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      useMissionsStore.getState().setCoordinatorPromptLoading(false);
    }
  };

  const loadWorkerPromptInspector = async (stepId: string) => {
    if (!runGraph) return;
    useMissionsStore.getState().setWorkerPromptLoading(true);
    useMissionsStore.getState().setWorkerPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: runGraph.run.id,
        target: "worker",
        stepId,
      });
      useMissionsStore.getState().setWorkerPromptInspector(inspector);
    } catch (err) {
      useMissionsStore.getState().setWorkerPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      useMissionsStore.getState().setWorkerPromptLoading(false);
    }
  };

  /* ── Intervention handling ── */
  const handleOpenIntervention = (interventionId: string) => {
    if (!selectedMission) return;
    const intervention = selectedMission.interventions.find((e) => e.id === interventionId) ?? null;
    if (!intervention || intervention.status !== "open") return;

    if (intervention.interventionType === "manual_input") {
      setActiveInterventionId(intervention.id);
      return;
    }

    const metadata = isRecord(intervention.metadata) ? intervention.metadata : {};
    const interventionRunId = typeof metadata.runId === "string" && metadata.runId.trim().length > 0 ? metadata.runId.trim() : null;
    const interventionStepId = typeof metadata.stepId === "string" && metadata.stepId.trim().length > 0 ? metadata.stepId.trim() : null;
    const interventionStepKey = typeof metadata.stepKey === "string" && metadata.stepKey.trim().length > 0 ? metadata.stepKey.trim() : null;
    const interventionAttemptId = typeof metadata.attemptId === "string" && metadata.attemptId.trim().length > 0 ? metadata.attemptId.trim() : null;
    const reasonCode = typeof metadata.reasonCode === "string" && metadata.reasonCode.trim().length > 0 ? metadata.reasonCode.trim() : null;
    const currentRunId = runGraph?.run.id ?? null;
    const sameRun = interventionRunId ? interventionRunId === currentRunId : Boolean(currentRunId);
    const resolvedStepId =
      sameRun && interventionStepId && runGraph?.steps.some((step) => step.id === interventionStepId)
        ? interventionStepId
        : null;

    if (reasonCode === "coordinator_unavailable" || reasonCode === "coordinator_recovery_failed") {
      setLogsFocusInterventionId(null);
      setChatJumpTarget({ kind: "coordinator", runId: interventionRunId ?? currentRunId });
      setActiveTab("chat");
      return;
    }

    if (intervention.interventionType === "failed_step") {
      if (resolvedStepId) {
        setSelectedStepId(resolvedStepId);
        setPlanSubview("board");
      }
      if (sameRun && (interventionAttemptId || resolvedStepId || interventionStepKey)) {
        setLogsFocusInterventionId(null);
        setChatJumpTarget({
          kind: "worker",
          runId: interventionRunId ?? currentRunId,
          stepId: resolvedStepId,
          stepKey: interventionStepKey,
          attemptId: interventionAttemptId,
        });
        setActiveTab("chat");
        return;
      }
      setLogsFocusInterventionId(intervention.id);
      setActiveTab("history");
      return;
    }

    setLogsFocusInterventionId(intervention.id);
    setActiveTab("history");
  };

  const handleInterventionResponse = async (interventionId: string, directiveText: string) => {
    if (!selectedMission) return;
    setSteerBusy(true);
    try {
      await window.ade.orchestrator.steerMission({
        missionId: selectedMission.id,
        interventionId,
        directive: directiveText,
        priority: "instruction",
      });
      setActiveInterventionId(null);
      await refreshMissionList({ preserveSelection: true, silent: true });
      await loadMissionDetail(selectedMission.id);
      await loadOrchestratorGraph(selectedMission.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSteerBusy(false);
    }
  };

  return (
    <>
      {runGraph && (
        <MissionActivePhasePanel activePhase={activePhaseView} allPhases={missionPhaseBadge.phases} promptInspector={coordinatorPromptInspector} promptLoading={coordinatorPromptLoading} promptError={coordinatorPromptError} onInspectPrompt={() => void loadCoordinatorPromptInspector()} coordinatorAvailability={runView?.coordinator.available != null ? { available: runView.coordinator.available, mode: runView.coordinator.mode ?? "offline", summary: runView.coordinator.summary ?? null } : null} compact={compactPhaseChrome} />
      )}

      {/* Completion Banner */}
      {runGraph && showCompletionBanner && (<div className="px-4 pt-3 space-y-2"><CompletionBanner status={runGraph.run.status} evaluation={runGraph.completionEvaluation} runId={runGraph.run.id} /></div>)}

      {/* Halt reason */}
      {runView?.haltReason ? (<div className="px-4 pt-3"><div className="space-y-1 p-3" style={{ background: runView.haltReason.severity === "error" ? `${COLORS.danger}12` : `${COLORS.warning}12`, border: `1px solid ${runView.haltReason.severity === "error" ? `${COLORS.danger}35` : `${COLORS.warning}35`}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Why did this stop?</div>
        <div className="text-[12px] font-semibold" style={{ color: COLORS.textPrimary }}>{runView.haltReason.title}</div>
        <div className="text-[11px]" style={{ color: COLORS.textSecondary }}>{runView.haltReason.detail}</div>
      </div></div>) : null}

      {/* Tab Content */}
      <div
        className={cn(
          "flex-1 min-h-0",
          activeTab === "chat" ? "flex flex-col overflow-hidden" : "overflow-auto p-4",
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
            <MissionRunPanel runView={runView} interventions={selectedMission.interventions} onOpenIntervention={handleOpenIntervention} />
            {failedExecutionSteps.length > 0 && (
              <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                <div className="text-[10px] font-semibold" style={{ color: COLORS.danger, fontFamily: MONO_FONT }}>
                  {failedExecutionSteps.length} failed step{failedExecutionSteps.length !== 1 ? "s" : ""}
                </div>
                <div className="mt-1.5 space-y-1">
                  {failedExecutionSteps.map((step) => (
                    <div key={step.id} className="flex items-center gap-2 text-[11px]">
                      <span style={{ color: COLORS.danger }}>{"\u2717"}</span>
                      <span style={{ color: COLORS.textPrimary }}>{step.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "plan" && (
          <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
            <div className="min-h-0 min-w-0 flex-1 overflow-auto">
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  style={outlineButton({
                    height: 24, padding: "0 8px", fontSize: 9,
                    background: planSubview === "board" ? `${COLORS.accent}14` : COLORS.cardBg,
                    color: planSubview === "board" ? COLORS.accent : COLORS.textMuted,
                    border: `1px solid ${planSubview === "board" ? `${COLORS.accent}35` : COLORS.border}`,
                  })}
                  onClick={() => setPlanSubview("board")}
                >
                  BOARD
                </button>
                <button
                  type="button"
                  style={outlineButton({
                    height: 24, padding: "0 8px", fontSize: 9,
                    background: planSubview === "dag" ? `${COLORS.accent}14` : COLORS.cardBg,
                    color: planSubview === "dag" ? COLORS.accent : COLORS.textMuted,
                    border: `1px solid ${planSubview === "dag" ? `${COLORS.accent}35` : COLORS.border}`,
                  })}
                  onClick={() => setPlanSubview("dag")}
                >
                  DAG
                </button>
              </div>
              {planSubview === "board" ? (
                <PlanTab mission={selectedMission} runGraph={runGraph} attemptsByStep={attemptsByStep} selectedStepId={selectedStepId} onStepSelect={setSelectedStepId} />
              ) : (
                <OrchestratorDAG steps={runSteps} attempts={runAttempts} claims={runClaims} selectedStepId={selectedStepId} onStepClick={setSelectedStepId} runId={runGraph?.run?.id} />
              )}
            </div>
            <div className="space-y-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
              <StepDetailPanel step={selectedStep} attempts={selectedStepAttempts} allSteps={runSteps} claims={runClaims} onOpenWorkerThread={(target) => { setChatJumpTarget(target); setActiveTab("chat"); }} onInspectPrompt={(stepId) => void loadWorkerPromptInspector(stepId)} />
              {selectedStep ? <PromptInspectorCard inspector={workerPromptInspector} loading={workerPromptLoading} error={workerPromptError} title="Selected step effective prompt" /> : null}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="space-y-3">
            <div className="flex items-center gap-1">
              <ModeToggleButton label="Timeline" tab="signal" activeMode={activityPanelMode} onSelect={(m) => setActivityPanelMode(m as "signal" | "logs")} />
              <ModeToggleButton label="Raw Logs" tab="logs" activeMode={activityPanelMode} onSelect={(m) => setActivityPanelMode(m as "signal" | "logs")} />
            </div>
            {activityPanelMode === "signal" ? (
              <>
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
              </>
            ) : selectedMission ? (
              <MissionLogsTab
                missionId={selectedMission.id}
                runId={runGraph?.run.id ?? null}
                focusInterventionId={logsFocusInterventionId}
                onFocusHandled={() => setLogsFocusInterventionId(null)}
              />
            ) : null}
          </div>
        )}

        {activeTab === "chat" && selectedMissionId && (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <MissionChatV2 missionId={selectedMissionId} missionStatus={selectedMission?.status ?? null} runId={runGraph?.run.id ?? null} runStatus={runGraph?.run.status ?? null} runMetadata={runGraph?.run.metadata ?? null} runView={runView} jumpTarget={chatJumpTarget} onJumpHandled={() => setChatJumpTarget(null)} />
            </div>
            {runView && (<div className="w-[280px] shrink-0 overflow-y-auto p-2" style={{ borderLeft: `1px solid ${COLORS.border}`, background: COLORS.pageBg }}><MissionRunPanel runView={runView} interventions={selectedMission?.interventions} onOpenIntervention={handleOpenIntervention} /></div>)}
          </div>
        )}

        {activeTab === "artifacts" && (
          <MissionArtifactsTab groupedArtifacts={groupedArtifacts} closeoutRequirements={[]} />
        )}
      </div>
    </>
  );
}

/* ────────── Internal mode toggle (for History signal/logs) ────────── */

function ModeToggleButton(props: {
  label: string;
  tab: string;
  activeMode: string;
  onSelect: (mode: string) => void;
}) {
  const isActive = props.activeMode === props.tab;
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.tab)}
      className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px]"
      style={
        isActive
          ? { background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}35`, color: COLORS.accent, fontFamily: MONO_FONT }
          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }
      }
    >
      {props.label}
    </button>
  );
}
