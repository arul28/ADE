import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Clock,
  SpinnerGap,
  Play,
  Plus,
  ArrowsClockwise,
  Rocket,
  MagnifyingGlass,
  Stop,
  TerminalWindow,
  X,
  Pulse,
  GitBranch,
  SquaresFour,
  Graph,
  Lightning,
  ChatCircle,
  GearSix,
  List,
  Kanban,
  Trash,
} from "@phosphor-icons/react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionDetail,
  MissionSummary,
  MissionPermissionConfig,
  ModelConfig,
  GetModelCapabilitiesResult,
  OrchestratorAttempt,
  OrchestratorArtifact,
  OrchestratorChatTarget,
  OrchestratorExecutorKind,
  OrchestratorPromptInspector,
  OrchestratorRunGraph,
  OrchestratorWorkerCheckpoint,
  ProjectConfigSnapshot,
  StartOrchestratorRunFromMissionArgs,
  MissionDashboardSnapshot,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";

import { CompletionBanner } from "./CompletionBanner";
import { MissionChatV2 } from "./MissionChatV2";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";

/* ── Extracted modules ── */
import {
  STATUS_BADGE_STYLES,
  STATUS_DOT_HEX,
  STATUS_LABELS,
  PRIORITY_STYLES,
  TERMINAL_MISSION_STATUSES,
  MISSION_BOARD_COLUMNS,
  DEFAULT_MISSION_SETTINGS_DRAFT,
  DEFAULT_ORCHESTRATOR_MODEL,
  DEFAULT_PERMISSION_CONFIG,
  isRecord,
  readString,
  toPlannerProvider,
  plannerProviderToModelConfig,
  modelConfigToPlannerProvider,
  toTeammatePlanMode,
  toCliMode,
  toCliSandboxPermissions,
  toInProcessMode,
  ElapsedTime,
  filterExecutionSteps,
  type WorkspaceTab,
  type MissionListViewMode,
  type MissionSettingsDraft,
} from "./missionHelpers";
import type { CreateDraft, CreateMissionDefaults } from "./CreateMissionDialog";
import { MissionCreateDialogHost } from "./MissionCreateDialogHost";
import { MissionSettingsDialog } from "./MissionSettingsDialog";
import { PlanTab } from "./PlanTab";
import { StepDetailPanel } from "./StepDetailPanel";
import { ActivityNarrativeHeader } from "./ActivityNarrativeHeader";
import { MissionsHomeDashboard } from "./MissionsHomeDashboard";
import { MissionStateSummary } from "./MissionStateSummary";
import { ClarificationQuizModal } from "./ClarificationQuizModal";
import { ManualInputResponseModal } from "./ManualInputResponseModal";
import { MissionLogsTab } from "./MissionLogsTab";
import type { ClarificationQuestion, ClarificationQuiz, MissionIntervention } from "../../../shared/types";
import { MissionArtifactsTab } from "./MissionArtifactsTab";
import { MissionActivePhasePanel } from "./MissionActivePhasePanel";
import { PromptInspectorCard } from "./PromptInspectorCard";
import { buildMissionArtifactGroups, deriveActivePhaseViewModel } from "./missionControlViewModel";
import { useMissionStateDocument } from "./useMissionStateDocument";
import { openMissionCreateDialog } from "./missionCreateDialogStore";

/* Re-export helpers used by tests */
export { collapsePlannerStreamMessages, resolveStepHeartbeatAt } from "./missionHelpers";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

type OrchestratorCheckpointStatus = {
  savedAt: string;
  turnCount: number;
  compactionCount: number;
};

function isQuizIntervention(intervention: MissionIntervention | null | undefined): intervention is MissionIntervention & {
  metadata: Record<string, unknown> & { quizMode: true; questions: ClarificationQuestion[] };
} {
  return Boolean(
    intervention
      && intervention.interventionType === "manual_input"
      && intervention.status === "open"
      && intervention.metadata?.quizMode === true
      && Array.isArray(intervention.metadata?.questions)
  );
}

function isBlockingManualInputIntervention(intervention: MissionIntervention): boolean {
  if (intervention.interventionType !== "manual_input" || intervention.status !== "open") return false;
  return intervention.metadata?.canProceedWithoutAnswer !== true;
}

function buildQuizDirective(quiz: ClarificationQuiz): string {
  const answerLines = quiz.answers.map((answer, index) => {
    const question = quiz.questions[index]?.question?.trim() || `Question ${index + 1}`;
    const source = answer.source === "default_assumption" ? "default assumption" : "user answer";
    return `- ${question}: ${answer.answer} (${source})`;
  });
  return [
    "Coordinator question answers:",
    ...answerLines,
    "Proceed using these answers.",
  ].join("\n");
}

/* ════════════════════ MAIN COMPONENT ════════════════════ */

export default function MissionsPage() {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const mappedLanes = useMemo(() => lanes.map((l) => ({ id: l.id, name: l.name })), [lanes]);

  /* ── Core state ── */
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedMission, setSelectedMission] = useState<MissionDetail | null>(null);
  const [runGraph, setRunGraph] = useState<OrchestratorRunGraph | null>(null);
  const [checkpointStatus, setCheckpointStatus] = useState<OrchestratorCheckpointStatus | null>(null);
  const [dashboard, setDashboard] = useState<MissionDashboardSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [runBusy, setRunBusy] = useState(false);
  const [missionSettingsOpen, setMissionSettingsOpen] = useState(false);
  const [missionSettingsBusy, setMissionSettingsBusy] = useState(false);
  const [missionSettingsError, setMissionSettingsError] = useState<string | null>(null);
  const [missionSettingsNotice, setMissionSettingsNotice] = useState<string | null>(null);
  const [missionSettingsSnapshot, setMissionSettingsSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [missionSettingsDraft, setMissionSettingsDraft] = useState<MissionSettingsDraft>(DEFAULT_MISSION_SETTINGS_DRAFT);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [planSubview, setPlanSubview] = useState<"board" | "dag">("board");
  const [searchFilter, setSearchFilter] = useState("");
  const [missionListView, setMissionListView] = useState<MissionListViewMode>("list");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [chatJumpTarget, setChatJumpTarget] = useState<OrchestratorChatTarget | null>(null);
  const [logsFocusInterventionId, setLogsFocusInterventionId] = useState<string | null>(null);
  const [activityPanelMode, setActivityPanelMode] = useState<"signal" | "logs">("signal");
  const [orchestratorArtifacts, setOrchestratorArtifacts] = useState<OrchestratorArtifact[]>([]);
  const [workerCheckpoints, setWorkerCheckpoints] = useState<OrchestratorWorkerCheckpoint[]>([]);
  const [modelCapabilities, setModelCapabilities] = useState<GetModelCapabilitiesResult | null>(null);
  const [coordinatorPromptInspector, setCoordinatorPromptInspector] = useState<OrchestratorPromptInspector | null>(null);
  const [coordinatorPromptLoading, setCoordinatorPromptLoading] = useState(false);
  const [coordinatorPromptError, setCoordinatorPromptError] = useState<string | null>(null);
  const [workerPromptInspector, setWorkerPromptInspector] = useState<OrchestratorPromptInspector | null>(null);
  const [workerPromptLoading, setWorkerPromptLoading] = useState(false);
  const [workerPromptError, setWorkerPromptError] = useState<string | null>(null);

  /* ── Steering state ── */
  const [steerBusy, setSteerBusy] = useState(false);
  const steeringLog = useMemo<Array<{ directive: string; appliedAt: string }>>(() => [], []);
  const graphRefreshTimerRef = useRef<number | null>(null);


  /* ── Intervention modal state ── */
  const [activeInterventionId, setActiveInterventionId] = useState<string | null>(null);
  const autoOpenedInterventionIdsRef = useRef<Set<string>>(new Set());

  /* ── Track original step count for dynamic step indicator ── */
  const [originalStepCount, setOriginalStepCount] = useState<number | null>(null);

  /* ── Stable array refs for memoized children ── */
  const runSteps = useMemo(() => runGraph?.steps ?? [], [runGraph?.steps]);
  const runAttempts = useMemo(() => runGraph?.attempts ?? [], [runGraph?.attempts]);
  const runClaims = useMemo(() => runGraph?.claims ?? [], [runGraph?.claims]);
  const runTimeline = useMemo(() => runGraph?.timeline ?? [], [runGraph?.timeline]);
  const executionSteps = useMemo(() => filterExecutionSteps(runSteps), [runSteps]);

  const executionProgress = useMemo(() => {
    const completed = executionSteps.filter((step) =>
      step.status === "succeeded" || step.status === "skipped" || step.status === "superseded" || step.status === "canceled"
    ).length;
    const running = executionSteps.filter((step) => step.status === "running").length;
    const blocked = executionSteps.filter((step) => step.status === "blocked").length;
    const failed = executionSteps.filter((step) => step.status === "failed").length;
    const total = executionSteps.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, running, blocked, failed, total, pct };
  }, [executionSteps]);

  /* ── Derived data ── */
  const filteredMissions = useMemo(() => {
    if (!searchFilter.trim()) return missions;
    const q = searchFilter.toLowerCase();
    return missions.filter(
      (m) => m.title.toLowerCase().includes(q) || m.status.includes(q)
    );
  }, [missions, searchFilter]);

  const runAutopilotState = useMemo(() => {
    const autopilot =
      runGraph?.run.metadata && typeof runGraph.run.metadata.autopilot === "object" && !Array.isArray(runGraph.run.metadata.autopilot)
        ? (runGraph.run.metadata.autopilot as Record<string, unknown>)
        : null;
    return {
      enabled: autopilot?.enabled === true,
      executor: typeof autopilot?.executorKind === "string" ? autopilot.executorKind : null
    };
  }, [runGraph]);

  const missionPhaseBadge = useMemo(() => {
    const runMeta = isRecord(runGraph?.run?.metadata) ? runGraph.run.metadata : null;
    const runPhaseOverride = Array.isArray(runMeta?.phaseOverride)
      ? runMeta.phaseOverride as import("../../../shared/types").PhaseCard[]
      : null;
    const missionPhaseOverride = Array.isArray(selectedMission?.phaseConfiguration?.selectedPhases)
      ? selectedMission.phaseConfiguration.selectedPhases
      : null;
    return {
      phases: runPhaseOverride && runPhaseOverride.length > 0 ? runPhaseOverride : missionPhaseOverride,
      profileName: typeof runMeta?.phaseProfileName === "string" ? runMeta.phaseProfileName : null,
    };
  }, [runGraph?.run?.metadata, selectedMission?.phaseConfiguration]);

  const activePhaseView = useMemo(() => deriveActivePhaseViewModel({
    mission: selectedMission,
    runGraph,
    modelCapabilities,
  }), [modelCapabilities, runGraph, selectedMission]);
  const { stateDoc: missionStateDoc, loading: missionStateLoading, error: missionStateError } = useMissionStateDocument(runGraph?.run.id ?? null);

  const groupedArtifacts = useMemo(() => buildMissionArtifactGroups({
    mission: selectedMission,
    runGraph,
    orchestratorArtifacts,
    checkpoints: workerCheckpoints,
  }), [orchestratorArtifacts, runGraph, selectedMission, workerCheckpoints]);

  const canStartOrRerun = !runGraph || runGraph.run.status === "succeeded" || runGraph.run.status === "failed" || runGraph.run.status === "canceled";
  const canCancelRun = Boolean(
    runGraph && runGraph.run.status !== "succeeded" && runGraph.run.status !== "failed" && runGraph.run.status !== "canceled"
  );
  const canResumeRun = runGraph?.run.status === "paused";
  const canPauseRun = Boolean(
    runGraph && (runGraph.run.status === "active" || runGraph.run.status === "bootstrapping")
  );
  const hasNonTerminalRun = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));
  const missionElapsedEndedAt = useMemo(() => {
    if (!selectedMission) return null;
    const runStatus = runGraph?.run.status ?? null;
    if (runStatus === "paused") {
      return runGraph?.run.updatedAt ?? selectedMission.updatedAt;
    }
    if (runStatus === "canceled" || runStatus === "failed" || runStatus === "succeeded") {
      return runGraph?.run.completedAt ?? runGraph?.run.updatedAt ?? selectedMission.completedAt ?? selectedMission.updatedAt;
    }
    if (selectedMission.status === "intervention_required") {
      return selectedMission.updatedAt;
    }
    if (TERMINAL_MISSION_STATUSES.has(selectedMission.status)) {
      return selectedMission.completedAt ?? selectedMission.updatedAt;
    }
    return null;
  }, [runGraph?.run.completedAt, runGraph?.run.status, runGraph?.run.updatedAt, selectedMission]);
  const checkpointIndicatorLabel = checkpointStatus ? relativeWhen(checkpointStatus.savedAt) : "pending";
  const checkpointIndicatorTooltip = checkpointStatus
    ? `Last checkpoint: ${relativeWhen(checkpointStatus.savedAt)} | ${checkpointStatus.turnCount} turns | ${checkpointStatus.compactionCount} compactions`
    : "Last checkpoint: pending";
  const defaultCreateLaneId = useMemo(
    () => lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null,
    [lanes]
  );
  const createMissionDefaults = useMemo<CreateMissionDefaults>(() => ({
    plannerProvider: missionSettingsDraft.defaultPlannerProvider,
    orchestratorModel: missionSettingsDraft.defaultOrchestratorModel,
    permissionConfig: missionSettingsDraft.permissionConfig,
  }), [missionSettingsDraft]);

  const applyMissionSettingsSnapshot = useCallback((snapshot: ProjectConfigSnapshot) => {
    const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
    const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};

    const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
    const effectiveOrchestrator = isRecord(effectiveAi.orchestrator) ? effectiveAi.orchestrator : {};

    const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
    const effectivePermissions = isRecord(effectiveAi.permissions) ? effectiveAi.permissions : {};
    const localCli = isRecord(localPermissions.cli) ? localPermissions.cli : {};
    const effectiveCli = isRecord(effectivePermissions.cli) ? effectivePermissions.cli : {};
    const localInProcess = isRecord(localPermissions.inProcess) ? localPermissions.inProcess : {};
    const effectiveInProcess = isRecord(effectivePermissions.inProcess) ? effectivePermissions.inProcess : {};
    const localProviders = isRecord(localPermissions.providers) ? localPermissions.providers : {};
    const effectiveProviders = isRecord(effectivePermissions.providers) ? effectivePermissions.providers : {};

    // Read orchestrator model — new shape first, fallback to legacy plannerProvider
    const rawPlannerProvider = readString(localOrchestrator.defaultPlannerProvider, effectiveOrchestrator.defaultPlannerProvider, "auto");
    const plannerProvider = toPlannerProvider(rawPlannerProvider);

    const localOrcModel = isRecord(localOrchestrator.defaultOrchestratorModel) ? localOrchestrator.defaultOrchestratorModel : null;
    const effectiveOrcModel = isRecord(effectiveOrchestrator.defaultOrchestratorModel) ? effectiveOrchestrator.defaultOrchestratorModel : null;

    let orchestratorModel: ModelConfig;
    if (localOrcModel && typeof localOrcModel.modelId === "string") {
      orchestratorModel = {
        modelId: localOrcModel.modelId as string,
        provider: (localOrcModel.provider as import("../../../shared/types").ModelProvider) ?? undefined,
        thinkingLevel: (localOrcModel.thinkingLevel as import("../../../shared/types").ThinkingLevel) ?? undefined,
      };
    } else if (effectiveOrcModel && typeof effectiveOrcModel.modelId === "string") {
      orchestratorModel = {
        modelId: effectiveOrcModel.modelId as string,
        provider: (effectiveOrcModel.provider as import("../../../shared/types").ModelProvider) ?? undefined,
        thinkingLevel: (effectiveOrcModel.thinkingLevel as import("../../../shared/types").ThinkingLevel) ?? undefined,
      };
    } else {
      orchestratorModel = plannerProviderToModelConfig(plannerProvider);
    }

    // Read permission config — new providers shape first, fallback to legacy cli/inProcess
    const permissionConfig: MissionPermissionConfig = {
      providers: {
        claude: (readString(localProviders.claude, effectiveProviders.claude, "full-auto") as import("../../../shared/types").AgentChatPermissionMode),
        codex: (readString(localProviders.codex, effectiveProviders.codex, "full-auto") as import("../../../shared/types").AgentChatPermissionMode),
        unified: (readString(localProviders.unified, effectiveProviders.unified, "full-auto") as import("../../../shared/types").AgentChatPermissionMode),
        codexSandbox: (readString(localProviders.codexSandbox, effectiveProviders.codexSandbox, "workspace-write") as "read-only" | "workspace-write" | "danger-full-access"),
      },
    };

    setMissionSettingsSnapshot(snapshot);
    setMissionSettingsDraft({
      defaultOrchestratorModel: orchestratorModel,
      permissionConfig,
      defaultPlannerProvider: plannerProvider,
      teammatePlanMode: toTeammatePlanMode(
        readString(localOrchestrator.teammatePlanMode, effectiveOrchestrator.teammatePlanMode, "auto")
      ),
      cliMode: toCliMode(readString(localCli.mode, effectiveCli.mode, "full-auto")),
      cliSandboxPermissions: toCliSandboxPermissions(readString(localCli.sandboxPermissions, effectiveCli.sandboxPermissions, "workspace-write")),
      inProcessMode: toInProcessMode(readString(localInProcess.mode, effectiveInProcess.mode, "full-auto")),
    });
  }, []);

  const loadMissionSettings = useCallback(async () => {
    setMissionSettingsError(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      applyMissionSettingsSnapshot(snapshot);
    } catch (err) {
      setMissionSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, [applyMissionSettingsSnapshot]);

  const saveMissionSettings = useCallback(async () => {
    setMissionSettingsBusy(true);
    setMissionSettingsError(null);
    setMissionSettingsNotice(null);
    try {
      const snapshot = missionSettingsSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
      const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
      const localCli = isRecord(localPermissions.cli) ? localPermissions.cli : {};
      const localInProcess = isRecord(localPermissions.inProcess) ? localPermissions.inProcess : {};

      const normalizedOrchestratorModel = missionSettingsDraft.defaultOrchestratorModel ?? DEFAULT_ORCHESTRATOR_MODEL;
      const normalizedPlannerProvider = modelConfigToPlannerProvider(normalizedOrchestratorModel);
      const normalizedCliMode = toCliMode(missionSettingsDraft.cliMode);
      const normalizedCliSandbox = toCliSandboxPermissions(missionSettingsDraft.cliSandboxPermissions);
      const normalizedInProcessMode = toInProcessMode(missionSettingsDraft.inProcessMode);

      const nextOrchestrator: Record<string, unknown> = {
        ...localOrchestrator,
        defaultOrchestratorModel: normalizedOrchestratorModel,
        defaultPlannerProvider: normalizedPlannerProvider,
        teammatePlanMode: toTeammatePlanMode(missionSettingsDraft.teammatePlanMode)
      };
      delete nextOrchestrator.requirePlanReview;
      delete nextOrchestrator.defaultDepthTier;
      delete nextOrchestrator.default_depth_tier;

      const nextCli: Record<string, unknown> = {
        ...localCli,
        mode: normalizedCliMode,
        sandboxPermissions: normalizedCliSandbox
      };

      const nextInProcess: Record<string, unknown> = {
        ...localInProcess,
        mode: normalizedInProcessMode
      };

      const saved = await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...localAi,
            orchestrator: nextOrchestrator,
            permissions: {
              ...localPermissions,
              cli: nextCli,
              inProcess: nextInProcess,
              providers: missionSettingsDraft.permissionConfig?.providers ?? DEFAULT_PERMISSION_CONFIG.providers,
            }
          }
        }
      });

      applyMissionSettingsSnapshot(saved);
      setMissionSettingsNotice("Mission settings saved to .ade/local.yaml.");
    } catch (err) {
      setMissionSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setMissionSettingsBusy(false);
    }
  }, [applyMissionSettingsSnapshot, missionSettingsDraft, missionSettingsSnapshot]);

  /* ── Data fetching ── */
  const refreshMissionList = useCallback(
    async (opts: { preserveSelection?: boolean; silent?: boolean } = {}) => {
      if (!opts.silent) setRefreshing(true);
      try {
        if (!lanes.length) await refreshLanes().catch(() => {});
        const list = await window.ade.missions.list({ limit: 300 });
        setMissions(list);
        setError(null);
        const preserve = opts.preserveSelection ?? true;
        if (!preserve) {
          setSelectedMissionId(list[0]?.id ?? null);
          return;
        }
        setSelectedMissionId((prev) => {
          if (prev && list.some((m) => m.id === prev)) return prev;
          return null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [lanes.length, refreshLanes]
  );

  const loadDashboard = useCallback(async () => {
    try {
      const snapshot = await window.ade.missions.getDashboard();
      setDashboard(snapshot);
    } catch {
      // Best-effort dashboard hydration.
    }
  }, []);

  const loadMissionDetail = useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) return;
    try {
      const detail = await window.ade.missions.get(trimmed);
      setSelectedMission(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadOrchestratorGraph = useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) { setRunGraph(null); return; }
    try {
      const runs = await window.ade.orchestrator.listRuns({ missionId: trimmed, limit: 20 });
      const latestRun = runs[0];
      if (!latestRun) { setRunGraph(null); return; }
      const graph = await window.ade.orchestrator.getRunGraph({ runId: latestRun.id, timelineLimit: 120 });
      setRunGraph(graph);
      if (originalStepCount === null && graph.steps.length > 0) {
        setOriginalStepCount(graph.steps.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunGraph(null);
    }
  }, [originalStepCount]);

  const loadRunArtifacts = useCallback(async (missionId: string, runId: string | null) => {
    const trimmed = missionId.trim();
    if (!trimmed) {
      setOrchestratorArtifacts([]);
      setWorkerCheckpoints([]);
      return;
    }
    try {
      const [artifacts, checkpoints] = await Promise.all([
        window.ade.orchestrator.listArtifacts({ missionId: trimmed, runId }),
        window.ade.orchestrator.listWorkerCheckpoints({ missionId: trimmed, runId }),
      ]);
      setOrchestratorArtifacts(Array.isArray(artifacts) ? artifacts : []);
      setWorkerCheckpoints(Array.isArray(checkpoints) ? checkpoints : []);
    } catch {
      setOrchestratorArtifacts([]);
      setWorkerCheckpoints([]);
    }
  }, []);

  const scheduleOrchestratorGraphRefresh = useCallback((missionId: string, delayMs = 180) => {
    if (graphRefreshTimerRef.current !== null) {
      window.clearTimeout(graphRefreshTimerRef.current);
    }
    graphRefreshTimerRef.current = window.setTimeout(() => {
      graphRefreshTimerRef.current = null;
      void loadOrchestratorGraph(missionId);
    }, delayMs);
  }, [loadOrchestratorGraph]);


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
      (result) => {
        if (!cancelled) setModelCapabilities(result);
      },
      () => {
        if (!cancelled) setModelCapabilities(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedMissionId) {
      if (graphRefreshTimerRef.current !== null) {
        window.clearTimeout(graphRefreshTimerRef.current);
        graphRefreshTimerRef.current = null;
      }
      setSelectedMission(null);
      setRunGraph(null);
      setChatJumpTarget(null);
      setLogsFocusInterventionId(null);
      setActivityPanelMode("signal");
      setOriginalStepCount(null);
      setOrchestratorArtifacts([]);
      setWorkerCheckpoints([]);
      setCoordinatorPromptInspector(null);
      setWorkerPromptInspector(null);
      return;
    }
    setChatJumpTarget(null);
    setLogsFocusInterventionId(null);
    setActivityPanelMode("signal");
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail, loadOrchestratorGraph]);

  useEffect(() => {
    if (!selectedMissionId) return;
    const runId = runGraph?.run.id ?? null;
    void loadRunArtifacts(selectedMissionId, runId);
  }, [loadRunArtifacts, runGraph?.run.id, selectedMissionId]);

  useEffect(() => {
    if (!runGraph || TERMINAL_RUN_STATUSES.has(runGraph.run.status)) {
      setCheckpointStatus(null);
      return;
    }
    const runId = runGraph.run.id;
    let disposed = false;

    const refreshCheckpointStatus = async () => {
      try {
        const next = await window.ade.orchestrator.getCheckpointStatus({ runId });
        if (!disposed) {
          setCheckpointStatus(next);
        }
      } catch {
        if (!disposed) {
          setCheckpointStatus(null);
        }
      }
    };

    void refreshCheckpointStatus();
    const intervalId = window.setInterval(() => {
      void refreshCheckpointStatus();
    }, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [runGraph?.run.id, runGraph?.run.status]);


  // Debounced event-driven refresh: coalesce rapid-fire events into a single cycle
  const missionEventTimerRef = useRef<number | null>(null);
  const orchestratorEventTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      missionEventTimerRef.current = window.setTimeout(() => {
        missionEventTimerRef.current = null;
        void refreshMissionList({ preserveSelection: true, silent: true });
        void loadDashboard();
        if (payload.missionId && payload.missionId === selectedMissionId) {
          void loadMissionDetail(payload.missionId);
          scheduleOrchestratorGraphRefresh(payload.missionId, 120);
          void loadRunArtifacts(payload.missionId, runGraph?.run.id ?? null);
        }
      }, 300);
    });
    return () => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, loadMissionDetail, loadRunArtifacts, refreshMissionList, runGraph?.run.id, scheduleOrchestratorGraphRefresh, selectedMissionId]);

  useEffect(() => {
    const selectedRunId = runGraph?.run.id ?? null;
    const unsub = window.ade.orchestrator.onEvent((event) => {
      if (!selectedMissionId) return;
      if (selectedRunId && event.runId && event.runId !== selectedRunId) return;
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      orchestratorEventTimerRef.current = window.setTimeout(() => {
        orchestratorEventTimerRef.current = null;
        scheduleOrchestratorGraphRefresh(selectedMissionId);
        void loadDashboard();
        void loadRunArtifacts(selectedMissionId, selectedRunId);
      }, 300);
    });
    return () => {
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, loadRunArtifacts, runGraph?.run.id, scheduleOrchestratorGraphRefresh, selectedMissionId]);

  useEffect(() => {
    return () => {
      if (graphRefreshTimerRef.current !== null) {
        window.clearTimeout(graphRefreshTimerRef.current);
      }
    };
  }, []);

  /* ── Actions ── */
  const startRunForMission = useCallback(
    async (args: {
      missionId: string;
      laneId?: string | null;
      executorKind: OrchestratorExecutorKind;
      plannerProvider?: "claude" | "codex" | null;
    }) => {
      const missionId = args.missionId.trim();
      if (!missionId) return;

      const startArgs = {
        missionId,
        runMode: "autopilot",
        autopilotOwnerId: "missions-autopilot",
        defaultExecutorKind: args.executorKind,
        defaultRetryLimit: 1,
        plannerProvider: args.plannerProvider ?? null
      } satisfies StartOrchestratorRunFromMissionArgs;
      return await window.ade.orchestrator.startRunFromMission(startArgs);
    },
    []
  );

  const handleLaunchMission = useCallback(async (draft: CreateDraft) => {
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
  }, [defaultCreateLaneId, refreshMissionList, loadMissionDetail, loadOrchestratorGraph]);

  const handleStartRun = useCallback(async () => {
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
      await startRunForMission({
        missionId: selectedMission.id,
        laneId: selectedMission.laneId,
        executorKind: fallbackExecutor,
        plannerProvider
      });
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
  }, [selectedMission, runAutopilotState.executor, startRunForMission, loadOrchestratorGraph, loadMissionDetail, refreshMissionList]);

  const handlePauseRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.pauseRun({ runId: runGraph.run.id, reason: "Paused from Missions UI." });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

  const handleCancelRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.cancelRun({ runId: runGraph.run.id, reason: "Canceled from Missions UI." });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

  const handleResumeRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.resumeRun({ runId: runGraph.run.id });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

  /* ── Lane cleanup for failed/canceled missions ── */
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const handleCleanupLanes = useCallback(async () => {
    if (!selectedMission || !runGraph?.steps) return;
    const laneIds = [...new Set(runGraph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
    if (!laneIds.length) return;
    if (!window.confirm(`Archive ${laneIds.length} lane(s) created by this mission?`)) return;
    setCleanupBusy(true);
    try {
      const result = await window.ade.orchestrator.cleanupTeamResources({
        missionId: selectedMission.id,
        runId: runGraph.run.id,
        cleanupLanes: true
      });
      await refreshLanes();
      if (result.laneErrors.length > 0) {
        setError(
          `Lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length}. `
          + `${result.laneErrors.length} lane(s) failed to archive.`
        );
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleanupBusy(false);
    }
  }, [runGraph, selectedMission, refreshLanes]);

  const handleInterventionResponse = useCallback(async (interventionId: string, directiveText: string) => {
    if (!selectedMission) return;
    setSteerBusy(true);
    try {
      await window.ade.orchestrator.steerMission({
        missionId: selectedMission.id,
        interventionId,
        directive: directiveText,
        priority: "instruction"
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
  }, [loadMissionDetail, loadOrchestratorGraph, refreshMissionList, selectedMission]);

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
    if (!selectedStepId) return null;
    if (!runGraph?.steps?.length) return null;
    return runGraph.steps.find((step) => step.id === selectedStepId) ?? null;
  }, [runGraph, selectedStepId]);

  const selectedStepAttempts = useMemo(() => {
    if (!selectedStep) return [];
    return attemptsByStep.get(selectedStep.id) ?? [];
  }, [attemptsByStep, selectedStep]);

  const failedExecutionSteps = useMemo(
    () => executionSteps.filter((step) => step.status === "failed"),
    [executionSteps]
  );

  const missionFileChanges = useMemo(() => {
    const files = new Set<string>();
    for (const event of runGraph?.runtimeEvents ?? []) {
      const payload = isRecord(event.payload) ? event.payload : {};
      for (const candidate of [payload.filePath, payload.path, payload.file]) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          files.add(candidate.trim());
        }
      }
    }
    return [...files].sort();
  }, [runGraph?.runtimeEvents]);

  const missionLaneLabels = useMemo(() => {
    const labels = new Set<string>();
    if (selectedMission?.laneName) labels.add(selectedMission.laneName);
    for (const step of runSteps) {
      if (step.laneId) labels.add(step.laneId);
    }
    return [...labels];
  }, [runSteps, selectedMission?.laneName]);

  const loadCoordinatorPromptInspector = useCallback(async () => {
    if (!runGraph) return;
    setCoordinatorPromptLoading(true);
    setCoordinatorPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: runGraph.run.id,
        target: "coordinator",
      });
      setCoordinatorPromptInspector(inspector);
    } catch (err) {
      setCoordinatorPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setCoordinatorPromptLoading(false);
    }
  }, [runGraph]);

  const loadWorkerPromptInspector = useCallback(async (stepId: string) => {
    if (!runGraph) return;
    setWorkerPromptLoading(true);
    setWorkerPromptError(null);
    try {
      const inspector = await window.ade.orchestrator.getPromptInspector({
        runId: runGraph.run.id,
        target: "worker",
        stepId,
      });
      setWorkerPromptInspector(inspector);
    } catch (err) {
      setWorkerPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkerPromptLoading(false);
    }
  }, [runGraph]);

  const openManualInputInterventions = useMemo(
    () =>
      selectedMission?.interventions.filter(
        (intervention) => intervention.interventionType === "manual_input" && intervention.status === "open"
      ) ?? [],
    [selectedMission]
  );

  const blockingManualInputInterventions = useMemo(
    () => openManualInputInterventions.filter((intervention) => isBlockingManualInputIntervention(intervention)),
    [openManualInputInterventions]
  );

  useEffect(() => {
    if (!selectedMission || activeInterventionId) return;
    const nextBlocking = blockingManualInputInterventions.find(
      (intervention) => !autoOpenedInterventionIdsRef.current.has(intervention.id)
    );
    if (!nextBlocking) return;
    autoOpenedInterventionIdsRef.current.add(nextBlocking.id);
    setActiveInterventionId(nextBlocking.id);
  }, [activeInterventionId, blockingManualInputInterventions, selectedMission]);

  useEffect(() => {
    if (!activeInterventionId) return;
    const stillExists = selectedMission?.interventions.some((intervention) => intervention.id === activeInterventionId) ?? false;
    if (!stillExists) {
      setActiveInterventionId(null);
    }
  }, [activeInterventionId, selectedMission]);

  useEffect(() => {
    setCoordinatorPromptInspector(null);
    setWorkerPromptInspector(null);
  }, [selectedMissionId]);

  // Reconcile selection only against displayed cards — no auto-reset mismatch
  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    if (!steps.length) {
      if (selectedStepId !== null) setSelectedStepId(null);
      return;
    }
    // Only reset selection if the currently selected step no longer exists in the graph
    if (selectedStepId && steps.some((step) => step.id === selectedStepId)) return;
    const running = steps.find((step) => step.status === "running");
    setSelectedStepId((running ?? steps[0]).id);
  }, [runGraph, selectedStepId]);

  useEffect(() => {
    setWorkerPromptInspector(null);
    setWorkerPromptError(null);
  }, [selectedStepId]);

  const chatFocused = activeTab === "chat";
  const compactPhaseChrome = chatFocused;
  const showCompletionBanner = activeTab !== "chat";

  /* ── Loading screen ── */
  if (loading) {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48" style={{ background: COLORS.border }} />
            <div className="h-3 w-32" style={{ background: `${COLORS.border}60` }} />
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>LOADING MISSIONS...</div>
        </div>
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <div className="flex h-full min-h-0" style={{ background: COLORS.pageBg }}>
        {/* ════════════ LEFT SIDEBAR ════════════ */}
        <div className="flex w-[248px] shrink-0 flex-col" style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between shrink-0 h-12 px-3" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center gap-2">
              <Rocket size={16} weight="bold" style={{ color: COLORS.accent }} />
              <span className="text-[14px] font-bold tracking-[-0.2px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                MISSIONS
              </span>
              <span className="px-2 py-0.5 text-[8px] font-bold uppercase tracking-[1px]" style={{ background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent, fontFamily: MONO_FONT }}>
                {missions.length} TOTAL
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void refreshMissionList({ preserveSelection: true })}
                className="p-1 transition-colors"
                style={{ color: COLORS.textMuted }}
                title="Refresh"
              >
                {refreshing ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwise className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => {
                  setMissionSettingsOpen(true);
                  setMissionSettingsNotice(null);
                  setMissionSettingsError(null);
                  if (!missionSettingsSnapshot) {
                    void loadMissionSettings();
                  }
                }}
                className="p-1 transition-colors"
                style={{ color: COLORS.textMuted }}
                title="Mission Settings"
              >
                <GearSix className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => openMissionCreateDialog()}
                className="p-1 transition-colors"
                style={{ color: COLORS.accent }}
                title="New Mission"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* View mode toggle + Search */}
          <div className="px-2.5 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <MagnifyingGlass className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: COLORS.textDim }} />
                <input
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Search missions..."
                  className="h-7 w-full pl-7 pr-2 text-xs outline-none"
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                />
              </div>
              <div className="flex gap-0.5 p-0.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <button
                  className="px-1.5 py-1 text-xs"
                  style={missionListView === "list" ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary } : { color: COLORS.textMuted }}
                  onClick={() => setMissionListView("list")}
                  title="List view"
                >
                  <List size={14} weight="regular" />
                </button>
                <button
                  className="px-1.5 py-1 text-xs"
                  style={missionListView === "board" ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary } : { color: COLORS.textMuted }}
                  onClick={() => setMissionListView("board")}
                  title="Board view"
                >
                  <Kanban size={14} weight="regular" />
                </button>
              </div>
            </div>
          </div>

          {/* Mission list / board */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {filteredMissions.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs" style={{ color: COLORS.textDim }}>
                {missions.length === 0 ? (
                  <div className="flex flex-col items-center gap-2">
                    <Rocket size={28} weight="regular" style={{ color: `${COLORS.accent}40` }} />
                    <p>No missions yet. Missions coordinate your AI agents to accomplish complex tasks.</p>
                    <button
                      onClick={() => openMissionCreateDialog()}
                      style={primaryButton()}
                    >
                      START MISSION
                    </button>
                  </div>
                ) : "No matches"}
              </div>
            ) : missionListView === "board" ? (
              /* Mission Kanban Board */
              <div className="space-y-3 pt-1">
                {MISSION_BOARD_COLUMNS.map((col) => {
                  const colMissions = filteredMissions.filter((m) => m.status === col.key);
                  if (colMissions.length === 0) return null;
                  return (
                    <div key={col.key}>
                      <div className="flex items-center gap-2 mb-1.5 px-1">
                        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: col.hex, fontFamily: MONO_FONT }}>{col.label}</span>
                        <span className="text-[10px]" style={{ color: COLORS.textDim }}>{colMissions.length}</span>
                      </div>
                      <div className="space-y-1">
                        {colMissions.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setSelectedMissionId(m.id)}
                            className="w-full text-left p-2.5 transition-colors"
                            style={m.id === selectedMissionId
                              ? {
                                  background: "#A78BFA12",
                                  borderTop: `1px solid ${COLORS.accent}30`,
                                  borderRight: `1px solid ${COLORS.accent}30`,
                                  borderBottom: `1px solid ${COLORS.accent}30`,
                                  borderLeft: `3px solid ${COLORS.accent}`
                                }
                              : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                            }
                          >
                            <div className="flex items-center gap-1.5">
                              <div className="text-xs font-medium truncate flex-1" style={{ color: COLORS.textPrimary }}>{m.title}</div>
                              {m.openInterventions > 0 && (
                                <span
                                className="shrink-0 px-1 py-0.5 text-[9px] font-bold"
                                style={{ color: COLORS.warning, background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30`, fontFamily: MONO_FONT }}
                                title="Has pending interventions"
                              >
                                  !
                              </span>
                            )}
                            </div>
                            <div className="mt-1 text-[11px] truncate" style={{ color: COLORS.textMuted }}>{m.prompt}</div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{relativeWhen(m.createdAt)}</span>
                              {m.totalSteps > 0 && (
                                <span className="text-[10px] ml-auto" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{m.completedSteps}/{m.totalSteps}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Mission List View */
              <div className="space-y-1">
                {filteredMissions.map((m) => {
                  const isSelected = m.id === selectedMissionId;
                  const progress = m.totalSteps > 0 ? Math.round((m.completedSteps / m.totalSteps) * 100) : 0;
                  const isActive = m.status === "in_progress" || m.status === "planning";
                  const badgeStyle = STATUS_BADGE_STYLES[m.status];
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMissionId(m.id)}
                      className={cn(
                        "w-full text-left px-2.5 py-2 transition-colors",
                        isActive && !isSelected && "ade-glow-pulse-blue"
                      )}
                      style={isSelected
                        ? {
                            background: "#A78BFA12",
                            borderTop: `1px solid ${COLORS.accent}30`,
                            borderRight: `1px solid ${COLORS.accent}30`,
                            borderBottom: `1px solid ${COLORS.accent}30`,
                            borderLeft: `3px solid ${COLORS.accent}`
                          }
                        : { border: "1px solid transparent" }
                      }
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1 h-2 w-2 shrink-0" style={{ background: STATUS_DOT_HEX[m.status], borderRadius: 0 }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{m.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: badgeStyle.background, color: badgeStyle.color, border: badgeStyle.border, fontFamily: MONO_FONT }}>
                              {STATUS_LABELS[m.status]}
                            </span>
                            {m.openInterventions > 0 && (
                              <span
                                className="px-1 py-0.5 text-[9px] font-bold"
                                style={{ color: COLORS.warning, background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30`, fontFamily: MONO_FONT }}
                                title="Has pending interventions"
                              >
                                !
                              </span>
                            )}
                          </div>
                          {m.totalSteps > 0 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1" style={{ background: COLORS.recessedBg }}>
                                <div
                                  className="h-1 transition-all"
                                  style={{ width: `${progress}%`, background: COLORS.accent }}
                                />
                              </div>
                              <span className="shrink-0 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {m.completedSteps}/{m.totalSteps}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ════════════ MAIN WORKSPACE ════════════ */}
        <div className="flex flex-1 flex-col min-w-0" style={{ background: COLORS.pageBg }}>
          {!selectedMissionId ? (
            <MissionsHomeDashboard
              snapshot={dashboard}
              onNewMission={() => openMissionCreateDialog()}
              onViewMission={(missionId) => setSelectedMissionId(missionId)}
            />
          ) : (
            <>
              {/* ── Header Bar ── */}
              <div className="flex items-center gap-3 shrink-0 px-4 py-2" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-bold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                      {selectedMission?.title ?? "Loading..."}
                    </h2>
                    {selectedMission && (() => {
                      const s = STATUS_BADGE_STYLES[selectedMission.status];
                      return (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: s.background, color: s.color, border: s.border, fontFamily: MONO_FONT }}>
                          {STATUS_LABELS[selectedMission.status]}
                        </span>
                      );
                    })()}
                    {selectedMission && selectedMission.priority !== "normal" && (() => {
                      const p = PRIORITY_STYLES[selectedMission.priority];
                      return (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: p.background, color: p.color, border: p.border, fontFamily: MONO_FONT }}>
                          {selectedMission.priority}
                        </span>
                      );
                    })()}
                    {/* Phase badge removed — phases now shown in stepper below */}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <span><Clock className="inline h-3 w-3 mr-0.5" /><ElapsedTime startedAt={selectedMission?.startedAt ?? null} endedAt={missionElapsedEndedAt} /></span>
                    {selectedMission?.laneName && (
                      <span><GitBranch className="inline h-3 w-3 mr-0.5" />{selectedMission.laneName}</span>
                    )}
                    {executionProgress.total > 0 && (
                      <span>{executionProgress.completed}/{executionProgress.total} steps</span>
                    )}
                  </div>
                  {!chatFocused && executionProgress.total > 0 && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden" style={{ background: COLORS.recessedBg }}>
                      <div
                        className="h-full transition-all"
                        style={{ width: `${executionProgress.pct}%`, background: COLORS.accent }}
                      />
                    </div>
                  )}
                  {/* Canonical progress note removed for cleaner header */}
                </div>

                {/* Quick actions */}
                <div className="flex items-center gap-1.5">
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
                    <button style={primaryButton()} onClick={handleStartRun} disabled={runBusy}>
                      {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      {runGraph ? "RERUN" : "START"}
                    </button>
                  )}
                  {canPauseRun && (
                    <button
                      style={outlineButton({ color: COLORS.warning, border: `1px solid ${COLORS.warning}40`, background: `${COLORS.warning}12` })}
                      onClick={handlePauseRun}
                      disabled={runBusy}
                      title="Pause run immediately (mechanical bypass)"
                    >
                      <span className="text-[10px]" style={{ fontFamily: MONO_FONT }}>&#9208;</span>
                      PAUSE
                    </button>
                  )}
                  {canResumeRun && (
                    <button style={outlineButton()} onClick={handleResumeRun} disabled={runBusy}>
                      <Play className="h-3 w-3" />
                      RESUME
                    </button>
                  )}
                  {canCancelRun && (
                    <button style={dangerButton()} onClick={handleCancelRun} disabled={runBusy}>
                      <Stop className="h-3 w-3" />
                      CANCEL
                    </button>
                  )}
                  {selectedMission && (selectedMission.status === "failed" || selectedMission.status === "canceled") && runGraph?.steps && runGraph.steps.some(s => s.laneId) && (
                    <button style={outlineButton()} onClick={handleCleanupLanes} disabled={cleanupBusy}>
                      {cleanupBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Trash className="h-3 w-3" />}
                      CLEAN UP LANES
                    </button>
                  )}
                </div>
              </div>

              {/* ── Error Banner ── */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="px-4 py-2 text-[11px] flex items-center justify-between"
                    style={{ borderBottom: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}
                  >
                    <span>{error}</span>
                    <button onClick={() => setError(null)} style={{ color: COLORS.danger }}>
                      <X className="h-3 w-3" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Coordinator Manual Input Banner ── */}
              {selectedMission && openManualInputInterventions.length > 0 && (() => {
                const blockingCount = blockingManualInputInterventions.length;
                const optionalCount = openManualInputInterventions.length - blockingCount;
                const primaryIntervention = blockingManualInputInterventions[0] ?? openManualInputInterventions[0];
                if (!primaryIntervention) return null;
                const label = blockingCount > 0
                  ? blockingCount === 1
                    ? "Coordinator is waiting on 1 answer"
                    : `Coordinator is waiting on ${blockingCount} answers`
                  : optionalCount === 1
                    ? "Coordinator has 1 optional question"
                    : `Coordinator has ${optionalCount} optional questions`;
                const detail = isQuizIntervention(primaryIntervention)
                  ? `${primaryIntervention.metadata.questions.length} question${primaryIntervention.metadata.questions.length === 1 ? "" : "s"} ready to answer`
                  : primaryIntervention.title;
                return (
                  <div
                    style={{
                      background: COLORS.cardBg,
                      border: `1px solid ${blockingCount > 0 ? COLORS.warning : COLORS.accentBorder}`,
                      margin: compactPhaseChrome ? "8px 12px" : "12px 16px",
                      padding: compactPhaseChrome ? "8px 12px" : "12px 16px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <ChatCircle
                        weight="bold"
                        style={{ color: blockingCount > 0 ? COLORS.warning : COLORS.accent, width: 14, height: 14, flexShrink: 0 }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: compactPhaseChrome ? 10 : 11,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "1px",
                            color: blockingCount > 0 ? COLORS.warning : COLORS.accent,
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontFamily: SANS_FONT,
                            fontSize: compactPhaseChrome ? 11 : 12,
                            color: COLORS.textSecondary,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {detail}
                        </div>
                      </div>
                    </div>
                    <button
                      style={primaryButton({ height: 28, padding: "0 12px", fontSize: 10 })}
                      onClick={() => setActiveInterventionId(primaryIntervention.id)}
                    >
                      {isQuizIntervention(primaryIntervention) ? "ANSWER NOW" : "OPEN REQUEST"}
                    </button>
                  </div>
                );
              })()}

              {runGraph && (
                <MissionActivePhasePanel
                  activePhase={activePhaseView}
                  allPhases={missionPhaseBadge.phases}
                  promptInspector={coordinatorPromptInspector}
                  promptLoading={coordinatorPromptLoading}
                  promptError={coordinatorPromptError}
                  onInspectPrompt={() => void loadCoordinatorPromptInspector()}
                  coordinatorAvailability={missionStateDoc?.coordinatorAvailability ?? null}
                  compact={compactPhaseChrome}
                />
              )}

              {/* Phase pills removed — now integrated into MissionActivePhasePanel stepper */}

              {/* ── Tab Navigation ── */}
              <div className="flex items-center gap-0 px-3" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {([
                  { key: "overview" as WorkspaceTab, label: "Overview", icon: SquaresFour },
                  { key: "plan" as WorkspaceTab, label: "Plan", icon: Graph },
                  { key: "chat" as WorkspaceTab, label: "Chat", icon: ChatCircle },
                  { key: "artifacts" as WorkspaceTab, label: "Artifacts", icon: Lightning },
                  { key: "history" as WorkspaceTab, label: "History", icon: Pulse }
                ]).map((tab) => {
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

              {/* ── Completion Banner ── */}
              {runGraph && showCompletionBanner && (
                <div className="px-4 pt-3 space-y-2">
                  <CompletionBanner
                    status={runGraph.run.status}
                    evaluation={runGraph.completionEvaluation}
                    runId={runGraph.run.id}
                    stateDoc={missionStateDoc}
                  />
                </div>
              )}

              {/* ── Tab Content ── */}
              <div className={cn(
                "flex-1 min-h-0",
                activeTab === "chat"
                  ? "flex flex-col overflow-hidden"
                  : "overflow-auto p-4"
              )}>
                {activeTab === "overview" && selectedMission && (
                  <div className="space-y-3">
                    {/* Mission prompt */}
                    <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                      <div className="text-[10px] font-semibold" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                        Prompt
                      </div>
                      <div className="mt-1.5 text-[12px]" style={{ color: COLORS.textPrimary, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {selectedMission.prompt}
                      </div>
                    </div>

                    {/* State summary */}
                    <MissionStateSummary
                      runId={runGraph?.run.id ?? null}
                      stateDoc={missionStateDoc}
                      loading={missionStateLoading}
                      error={missionStateError}
                      onOpenIntervention={(interventionId) => setActiveInterventionId(interventionId)}
                    />

                    {/* Failed steps — only if there are failures */}
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

                    {/* Interventions — only if there are any */}
                    {selectedMission.interventions.length > 0 && (
                      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] font-semibold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                            Interventions ({selectedMission.interventions.length})
                          </div>
                          <button
                            type="button"
                            className="text-[9px]"
                            style={{ color: COLORS.textDim, fontFamily: MONO_FONT, background: "none", border: "none", cursor: "pointer" }}
                            onClick={() => setActiveTab("history")}
                          >
                            View history →
                          </button>
                        </div>
                        <div className="mt-1.5 space-y-1">
                          {selectedMission.interventions.slice(0, 6).map((iv) => (
                            <div key={iv.id} className="flex items-center justify-between gap-3 px-2 py-1.5" style={{ background: COLORS.recessedBg }}>
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="px-1 py-0.5 text-[8px] font-bold uppercase shrink-0"
                                  style={{
                                    color: iv.status === "open" ? COLORS.warning : COLORS.success,
                                    border: `1px solid ${iv.status === "open" ? COLORS.warning : COLORS.success}40`,
                                    background: `${iv.status === "open" ? COLORS.warning : COLORS.success}12`,
                                    fontFamily: MONO_FONT,
                                  }}
                                >
                                  {iv.status === "open" ? "open" : "resolved"}
                                </span>
                                <span className="text-[11px] truncate" style={{ color: COLORS.textPrimary }}>{iv.title}</span>
                              </div>
                              <span className="text-[9px] shrink-0" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                                {iv.interventionType.replace(/_/g, " ")}
                              </span>
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
                            height: 24,
                            padding: "0 8px",
                            fontSize: 9,
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
                            height: 24,
                            padding: "0 8px",
                            fontSize: 9,
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
                        <PlanTab
                          mission={selectedMission}
                          runGraph={runGraph}
                          attemptsByStep={attemptsByStep}
                          selectedStepId={selectedStepId}
                          onStepSelect={setSelectedStepId}
                        />
                      ) : (
                        <OrchestratorDAG
                          steps={runSteps}
                          attempts={runAttempts}
                          claims={runClaims}
                          selectedStepId={selectedStepId}
                          onStepClick={setSelectedStepId}
                          runId={runGraph?.run?.id}
                        />
                      )}
                    </div>
                    <div className="space-y-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
                      <StepDetailPanel
                        step={selectedStep}
                        attempts={selectedStepAttempts}
                        allSteps={runSteps}
                        claims={runClaims}
                        onOpenWorkerThread={(target) => {
                          setChatJumpTarget(target);
                          setActiveTab("chat");
                        }}
                        onInspectPrompt={(stepId) => void loadWorkerPromptInspector(stepId)}
                      />
                      {selectedStep ? (
                        <PromptInspectorCard
                          inspector={workerPromptInspector}
                          loading={workerPromptLoading}
                          error={workerPromptError}
                          title="Selected step effective prompt"
                        />
                      ) : null}
                    </div>
                  </div>
                )}
                {activeTab === "history" && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setActivityPanelMode("signal")}
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px]"
                        style={activityPanelMode === "signal"
                          ? { background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}35`, color: COLORS.accent, fontFamily: MONO_FONT }
                          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }
                        }
                      >
                        Timeline
                      </button>
                      <button
                        type="button"
                        onClick={() => setActivityPanelMode("logs")}
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px]"
                        style={activityPanelMode === "logs"
                          ? { background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}35`, color: COLORS.accent, fontFamily: MONO_FONT }
                          : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }
                        }
                      >
                        Raw Logs
                      </button>
                    </div>
                    {activityPanelMode === "signal" ? (
                      <>
                        <ActivityNarrativeHeader
                          runGraph={runGraph}
                          steeringLog={steeringLog}
                        />
                        <OrchestratorActivityFeed
                          runId={runGraph?.run.id ?? ""}
                          initialTimeline={runTimeline}
                        />

                        {/* Run Narrative - shown when available */}
                        {Array.isArray(runGraph?.run?.metadata?.runNarrative) && (runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).length > 0 && (
                          <div className="space-y-1.5 mt-4">
                            <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: COLORS.textMuted }}>
                              RUN NARRATIVE
                            </div>
                            <div className="space-y-1">
                              {(runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).map((entry, i: number) => (
                                <div key={i} className="text-[11px] flex gap-2 items-start" style={{ fontFamily: MONO_FONT }}>
                                  <span className="shrink-0" style={{ color: COLORS.accent }}>{entry.stepKey}</span>
                                  <span style={{ color: COLORS.textSecondary }}>{entry.summary}</span>
                                </div>
                              ))}
                            </div>
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
                  <MissionChatV2
                    missionId={selectedMissionId}
                    missionStatus={selectedMission?.status ?? null}
                    runId={runGraph?.run.id ?? null}
                    runStatus={runGraph?.run.status ?? null}
                    runMetadata={runGraph?.run.metadata ?? null}
                    jumpTarget={chatJumpTarget}
                    onJumpHandled={() => setChatJumpTarget(null)}
                  />
                )}

                {activeTab === "artifacts" && (
                  <MissionArtifactsTab
                    groupedArtifacts={groupedArtifacts}
                    closeoutRequirements={missionStateDoc?.finalization?.requirements ?? []}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ════════════ CREATE DIALOG ════════════ */}
      <MissionCreateDialogHost
        lanes={mappedLanes}
        defaultLaneId={defaultCreateLaneId}
        missionDefaults={createMissionDefaults}
        onLaunch={handleLaunchMission}
      />

      {/* ════════════ MISSION SETTINGS DIALOG ════════════ */}
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

      {/* ════════════ MANUAL INPUT MODALS ════════════ */}
      {activeInterventionId && selectedMission && (() => {
        const iv = selectedMission.interventions.find((intervention) => intervention.id === activeInterventionId);
        if (!iv || iv.status !== "open" || iv.interventionType !== "manual_input") {
          return null;
        }
        if (isQuizIntervention(iv)) {
          const phase = typeof iv.metadata.phase === "string" ? iv.metadata.phase : null;
          return (
            <ClarificationQuizModal
              interventionId={iv.id}
              missionId={selectedMission.id}
              questions={iv.metadata.questions}
              phase={phase}
              onClose={() => setActiveInterventionId(null)}
              onSubmit={async (quiz: ClarificationQuiz) => {
                await handleInterventionResponse(iv.id, buildQuizDirective(quiz));
              }}
            />
          );
        }
        return (
          <ManualInputResponseModal
            intervention={iv}
            onClose={() => setActiveInterventionId(null)}
            onSubmit={async (answer) => {
              await handleInterventionResponse(iv.id, answer);
            }}
          />
        );
      })()}
    </LazyMotion>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
