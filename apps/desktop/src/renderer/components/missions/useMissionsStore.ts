import { create } from "zustand";
import type {
  MissionDetail,
  MissionSummary,
  MissionDashboardSnapshot,
  MissionPermissionConfig,
  ModelConfig,
  GetModelCapabilitiesResult,
  OrchestratorArtifact,
  OrchestratorChatTarget,
  OrchestratorPromptInspector,
  OrchestratorRunGraph,
  OrchestratorWorkerCheckpoint,
  ProjectConfigSnapshot,
} from "../../../shared/types";
import {
  DEFAULT_MISSION_SETTINGS_DRAFT,
  DEFAULT_ORCHESTRATOR_MODEL,
  DEFAULT_PERMISSION_CONFIG,
  TERMINAL_MISSION_STATUSES,
  isRecord,
  readString,
  toPlannerProvider,
  plannerProviderToModelConfig,
  modelConfigToPlannerProvider,
  toTeammatePlanMode,
  toCliMode,
  toCliSandboxPermissions,
  toInProcessMode,
  type WorkspaceTab,
  type MissionListViewMode,
  type MissionSettingsDraft,
} from "./missionHelpers";

function readBoolean(primary: unknown, fallback: unknown, defaultValue: boolean): boolean {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function readStringArray(primary: unknown, fallback: unknown): string[] {
  const normalize = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0))]
      : [];
  const primaryList = normalize(primary);
  if (primaryList.length > 0) return primaryList;
  return normalize(fallback);
}

/* ════════════════════ TYPES ════════════════════ */

export type OrchestratorCheckpointStatus = {
  savedAt: string;
  turnCount: number;
  compactionCount: number;
};

export type MissionContextMenuState = {
  mission: MissionSummary;
  x: number;
  y: number;
} | null;

export type MissionAttentionToast = {
  id: string;
  missionTitle: string;
  message: string;
  severity: "warning" | "error";
  missionId: string;
};

/* ════════════════════ STORE STATE ════════════════════ */

export type MissionsState = {
  /* ── Core domain state ── */
  missions: MissionSummary[];
  selectedMissionId: string | null;
  selectedMission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  checkpointStatus: OrchestratorCheckpointStatus | null;
  dashboard: MissionDashboardSnapshot | null;

  /* ── Loading / error ── */
  loading: boolean;
  error: string | null;
  refreshing: boolean;

  /* ── Run actions ── */
  runBusy: boolean;

  /* ── Settings ── */
  missionSettingsOpen: boolean;
  missionSettingsBusy: boolean;
  missionSettingsError: string | null;
  missionSettingsNotice: string | null;
  missionSettingsSnapshot: ProjectConfigSnapshot | null;
  missionSettingsDraft: MissionSettingsDraft;

  /* ── UI state ── */
  activeTab: WorkspaceTab;
  planSubview: "board" | "dag";
  searchFilter: string;
  missionListView: MissionListViewMode;
  missionContextMenu: MissionContextMenuState;
  selectedStepId: string | null;
  chatJumpTarget: OrchestratorChatTarget | null;
  logsFocusInterventionId: string | null;
  activityPanelMode: "signal" | "logs";
  orchestratorArtifacts: OrchestratorArtifact[];
  workerCheckpoints: OrchestratorWorkerCheckpoint[];
  modelCapabilities: GetModelCapabilitiesResult | null;

  /* ── Prompt inspector ── */
  coordinatorPromptInspector: OrchestratorPromptInspector | null;
  coordinatorPromptLoading: boolean;
  coordinatorPromptError: string | null;
  workerPromptInspector: OrchestratorPromptInspector | null;
  workerPromptLoading: boolean;
  workerPromptError: string | null;

  /* ── Steering ── */
  steerBusy: boolean;

  /* ── Intervention modal ── */
  activeInterventionId: string | null;

  /* ── Attention toasts ── */
  attentionToasts: MissionAttentionToast[];

  /* ── Progress tracking ── */
  originalStepCount: number | null;

  /* ── Manage mission dialog ── */
  manageMission: MissionSummary | null;
  manageMissionOpen: boolean;
  manageMissionCleanupLanes: boolean;
  manageMissionBusy: boolean;
  manageMissionError: string | null;

  /* ── Lane cleanup ── */
  cleanupBusy: boolean;
};

/* ════════════════════ STORE ACTIONS ════════════════════ */

export type MissionsActions = {
  /* ── Simple setters ── */
  setMissions: (missions: MissionSummary[]) => void;
  setSelectedMissionId: (id: string | null) => void;
  setSelectedMission: (mission: MissionDetail | null) => void;
  setRunGraph: (graph: OrchestratorRunGraph | null) => void;
  setCheckpointStatus: (status: OrchestratorCheckpointStatus | null) => void;
  setDashboard: (dashboard: MissionDashboardSnapshot | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setRefreshing: (refreshing: boolean) => void;
  setRunBusy: (busy: boolean) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setPlanSubview: (view: "board" | "dag") => void;
  setSearchFilter: (filter: string) => void;
  setMissionListView: (view: MissionListViewMode) => void;
  setMissionContextMenu: (menu: MissionContextMenuState) => void;
  setSelectedStepId: (id: string | null) => void;
  setChatJumpTarget: (target: OrchestratorChatTarget | null) => void;
  setLogsFocusInterventionId: (id: string | null) => void;
  setActivityPanelMode: (mode: "signal" | "logs") => void;
  setOrchestratorArtifacts: (artifacts: OrchestratorArtifact[]) => void;
  setWorkerCheckpoints: (checkpoints: OrchestratorWorkerCheckpoint[]) => void;
  setModelCapabilities: (caps: GetModelCapabilitiesResult | null) => void;
  setActiveInterventionId: (id: string | null) => void;
  setAttentionToasts: (toasts: MissionAttentionToast[]) => void;
  setOriginalStepCount: (count: number | null) => void;
  setSteerBusy: (busy: boolean) => void;
  setCleanupBusy: (busy: boolean) => void;

  /* ── Settings actions ── */
  setMissionSettingsOpen: (open: boolean) => void;
  setMissionSettingsBusy: (busy: boolean) => void;
  setMissionSettingsError: (error: string | null) => void;
  setMissionSettingsNotice: (notice: string | null) => void;
  setMissionSettingsSnapshot: (snapshot: ProjectConfigSnapshot | null) => void;
  setMissionSettingsDraft: (draft: MissionSettingsDraft | ((prev: MissionSettingsDraft) => MissionSettingsDraft)) => void;

  /* ── Prompt inspector ── */
  setCoordinatorPromptInspector: (inspector: OrchestratorPromptInspector | null) => void;
  setCoordinatorPromptLoading: (loading: boolean) => void;
  setCoordinatorPromptError: (error: string | null) => void;
  setWorkerPromptInspector: (inspector: OrchestratorPromptInspector | null) => void;
  setWorkerPromptLoading: (loading: boolean) => void;
  setWorkerPromptError: (error: string | null) => void;

  /* ── Manage mission dialog ── */
  setManageMission: (mission: MissionSummary | null) => void;
  setManageMissionOpen: (open: boolean) => void;
  setManageMissionCleanupLanes: (cleanup: boolean) => void;
  setManageMissionBusy: (busy: boolean) => void;
  setManageMissionError: (error: string | null) => void;

  /* ── Compound actions (IPC calls) ── */
  refreshMissionList: (opts?: { preserveSelection?: boolean; silent?: boolean }) => Promise<void>;
  loadDashboard: () => Promise<void>;
  loadMissionDetail: (missionId: string) => Promise<void>;
  loadOrchestratorGraph: (missionId: string) => Promise<void>;
  loadRunArtifacts: (missionId: string, runId: string | null) => Promise<void>;
  loadMissionSettings: () => Promise<void>;
  saveMissionSettings: () => Promise<void>;
  applyMissionSettingsSnapshot: (snapshot: ProjectConfigSnapshot) => void;

  /** Consolidated mission selection via single getFullMissionView IPC call. */
  selectMission: (missionId: string | null) => Promise<void>;

  /* ── Event subscription lifecycle ── */
  /** Start event subscriptions and debounced refresh timers. Returns cleanup fn. */
  initEventSubscriptions: () => () => void;

  /* ── Attention toast management (timers owned by store, not components) ── */
  addAttentionToast: (message: string, severity: "warning" | "error", missionTitle: string, missionId: string) => void;
  dismissAttentionToast: (id: string) => void;
  /** Cleanup all toast timers (call on unmount) */
  cleanupToastTimers: () => void;

  /* ── Selection reset ── */
  clearSelection: () => void;
};

export type MissionsStore = MissionsState & MissionsActions;

/* ════════════════════ INITIAL STATE ════════════════════ */

export const initialMissionsState: MissionsState = {
  missions: [],
  selectedMissionId: null,
  selectedMission: null,
  runGraph: null,
  checkpointStatus: null,
  dashboard: null,
  loading: true,
  error: null,
  refreshing: false,
  runBusy: false,
  missionSettingsOpen: false,
  missionSettingsBusy: false,
  missionSettingsError: null,
  missionSettingsNotice: null,
  missionSettingsSnapshot: null,
  missionSettingsDraft: DEFAULT_MISSION_SETTINGS_DRAFT,
  activeTab: "chat",
  planSubview: "board",
  searchFilter: "",
  missionListView: "list",
  missionContextMenu: null,
  selectedStepId: null,
  chatJumpTarget: null,
  logsFocusInterventionId: null,
  activityPanelMode: "signal",
  orchestratorArtifacts: [],
  workerCheckpoints: [],
  modelCapabilities: null,
  coordinatorPromptInspector: null,
  coordinatorPromptLoading: false,
  coordinatorPromptError: null,
  workerPromptInspector: null,
  workerPromptLoading: false,
  workerPromptError: null,
  steerBusy: false,
  activeInterventionId: null,
  attentionToasts: [],
  originalStepCount: null,
  manageMission: null,
  manageMissionOpen: false,
  manageMissionCleanupLanes: false,
  manageMissionBusy: false,
  manageMissionError: null,
  cleanupBusy: false,
};

function isRendererVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/* ── Toast timer registry (module-scoped, not per-render) ── */
const toastTimers = new Map<string, number>();
let missionSelectionRequestSeq = 0;

function buildClearedSelectionState(): Partial<MissionsState> {
  return {
    selectedMissionId: null,
    selectedMission: null,
    runGraph: null,
    chatJumpTarget: null,
    logsFocusInterventionId: null,
    activityPanelMode: "signal",
    originalStepCount: null,
    orchestratorArtifacts: [],
    workerCheckpoints: [],
    coordinatorPromptInspector: null,
    workerPromptInspector: null,
  };
}

/* ════════════════════ STORE CREATION ════════════════════ */

export const useMissionsStore = create<MissionsStore>((set, get) => ({
  ...initialMissionsState,

  /* ── Simple setters ── */
  setMissions: (missions) => set({ missions }),
  setSelectedMissionId: (id) => set({ selectedMissionId: id }),
  setSelectedMission: (mission) => set({ selectedMission: mission }),
  setRunGraph: (graph) => set({ runGraph: graph }),
  setCheckpointStatus: (status) => set({ checkpointStatus: status }),
  setDashboard: (dashboard) => set({ dashboard: dashboard }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setRefreshing: (refreshing) => set({ refreshing }),
  setRunBusy: (busy) => set({ runBusy: busy }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setPlanSubview: (view) => set({ planSubview: view }),
  setSearchFilter: (filter) => set({ searchFilter: filter }),
  setMissionListView: (view) => set({ missionListView: view }),
  setMissionContextMenu: (menu) => set({ missionContextMenu: menu }),
  setSelectedStepId: (id) => set({ selectedStepId: id }),
  setChatJumpTarget: (target) => set({ chatJumpTarget: target }),
  setLogsFocusInterventionId: (id) => set({ logsFocusInterventionId: id }),
  setActivityPanelMode: (mode) => set({ activityPanelMode: mode }),
  setOrchestratorArtifacts: (artifacts) => set({ orchestratorArtifacts: artifacts }),
  setWorkerCheckpoints: (checkpoints) => set({ workerCheckpoints: checkpoints }),
  setModelCapabilities: (caps) => set({ modelCapabilities: caps }),
  setActiveInterventionId: (id) => set({ activeInterventionId: id }),
  setAttentionToasts: (toasts) => set({ attentionToasts: toasts }),
  setOriginalStepCount: (count) => set({ originalStepCount: count }),
  setSteerBusy: (busy) => set({ steerBusy: busy }),
  setCleanupBusy: (busy) => set({ cleanupBusy: busy }),

  /* ── Settings setters ── */
  setMissionSettingsOpen: (open) => set({ missionSettingsOpen: open }),
  setMissionSettingsBusy: (busy) => set({ missionSettingsBusy: busy }),
  setMissionSettingsError: (error) => set({ missionSettingsError: error }),
  setMissionSettingsNotice: (notice) => set({ missionSettingsNotice: notice }),
  setMissionSettingsSnapshot: (snapshot) => set({ missionSettingsSnapshot: snapshot }),
  setMissionSettingsDraft: (draftOrFn) => set((state) => ({
    missionSettingsDraft: typeof draftOrFn === "function"
      ? draftOrFn(state.missionSettingsDraft)
      : draftOrFn,
  })),

  /* ── Prompt inspector setters ── */
  setCoordinatorPromptInspector: (inspector) => set({ coordinatorPromptInspector: inspector }),
  setCoordinatorPromptLoading: (loading) => set({ coordinatorPromptLoading: loading }),
  setCoordinatorPromptError: (error) => set({ coordinatorPromptError: error }),
  setWorkerPromptInspector: (inspector) => set({ workerPromptInspector: inspector }),
  setWorkerPromptLoading: (loading) => set({ workerPromptLoading: loading }),
  setWorkerPromptError: (error) => set({ workerPromptError: error }),

  /* ── Manage mission dialog setters ── */
  setManageMission: (mission) => set({ manageMission: mission }),
  setManageMissionOpen: (open) => set({ manageMissionOpen: open }),
  setManageMissionCleanupLanes: (cleanup) => set({ manageMissionCleanupLanes: cleanup }),
  setManageMissionBusy: (busy) => set({ manageMissionBusy: busy }),
  setManageMissionError: (error) => set({ manageMissionError: error }),

  /* ── Compound actions (IPC calls) ── */
  refreshMissionList: async (opts = {}) => {
    const { preserveSelection = true, silent = false } = opts;
    if (!silent) set({ refreshing: true });
    try {
      const list = await window.ade.missions.list({ limit: 300 });
      set((state) => {
        const selectedStillExists = Boolean(
          state.selectedMissionId && list.some((mission) => mission.id === state.selectedMissionId),
        );
        const nextId = preserveSelection
          ? (selectedStillExists ? state.selectedMissionId : null)
          : (list[0]?.id ?? null);
        return {
          missions: list,
          error: null,
          loading: false,
          refreshing: false,
          selectedMissionId: nextId,
          ...(!nextId ? buildClearedSelectionState() : {}),
        };
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
        refreshing: false,
      });
    }
  },

  loadDashboard: async () => {
    try {
      const snapshot = await window.ade.missions.getDashboard();
      set({ dashboard: snapshot });
    } catch {
      // Best-effort dashboard hydration.
    }
  },

  loadMissionDetail: async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) return;
    try {
      const detail = await window.ade.missions.get(trimmed);
      set({ selectedMission: detail, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadOrchestratorGraph: async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) { set({ runGraph: null }); return; }
    try {
      const runs = await window.ade.orchestrator.listRuns({ missionId: trimmed, limit: 20 });
      const latestRun = runs[0];
      if (!latestRun) { set({ runGraph: null }); return; }
      const graph = await window.ade.orchestrator.getRunGraph({ runId: latestRun.id, timelineLimit: 120 });
      set((state) => ({
        runGraph: graph,
        originalStepCount: state.originalStepCount === null && graph.steps.length > 0
          ? graph.steps.length
          : state.originalStepCount,
      }));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        runGraph: null,
      });
    }
  },

  loadRunArtifacts: async (missionId: string, runId: string | null) => {
    const trimmed = missionId.trim();
    if (!trimmed) {
      set({ orchestratorArtifacts: [], workerCheckpoints: [] });
      return;
    }
    try {
      const [artifacts, checkpoints] = await Promise.all([
        window.ade.orchestrator.listArtifacts({ missionId: trimmed, runId }),
        window.ade.orchestrator.listWorkerCheckpoints({ missionId: trimmed, runId }),
      ]);
      set({
        orchestratorArtifacts: Array.isArray(artifacts) ? artifacts : [],
        workerCheckpoints: Array.isArray(checkpoints) ? checkpoints : [],
      });
    } catch {
      set({ orchestratorArtifacts: [], workerCheckpoints: [] });
    }
  },

  applyMissionSettingsSnapshot: (snapshot: ProjectConfigSnapshot) => {
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
    const localExternalMcp = isRecord(localPermissions.externalMcp) ? localPermissions.externalMcp : {};
    const effectiveExternalMcp = isRecord(effectivePermissions.externalMcp) ? effectivePermissions.externalMcp : {};

    const localOrcModel = isRecord(localOrchestrator.defaultOrchestratorModel) ? localOrchestrator.defaultOrchestratorModel : null;
    const effectiveOrcModel = isRecord(effectiveOrchestrator.defaultOrchestratorModel) ? effectiveOrchestrator.defaultOrchestratorModel : null;

    // Legacy fallback: derive from deprecated defaultPlannerProvider if no orchestrator model
    const rawLocal = localOrchestrator as Record<string, unknown>;
    const rawEffective = effectiveOrchestrator as Record<string, unknown>;
    const legacyPlannerProvider = toPlannerProvider(
      readString(rawLocal.defaultPlannerProvider, rawEffective.defaultPlannerProvider, "auto")
    );

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
      orchestratorModel = plannerProviderToModelConfig(legacyPlannerProvider);
    }

    const permissionConfig: MissionPermissionConfig = {
      providers: {
        claude: readString(localProviders.claude, effectiveProviders.claude, "full-auto") as import("../../../shared/types").AgentChatPermissionMode,
        codex: readString(localProviders.codex, effectiveProviders.codex, "full-auto") as import("../../../shared/types").AgentChatPermissionMode,
        opencode: readString(localProviders.opencode, effectiveProviders.opencode, "full-auto") as import("../../../shared/types").AgentChatPermissionMode,
        codexSandbox: readString(localProviders.codexSandbox, effectiveProviders.codexSandbox, "workspace-write") as "read-only" | "workspace-write" | "danger-full-access",
      },
      externalMcp: {
        enabled: readBoolean(localExternalMcp.enabled, effectiveExternalMcp.enabled, false),
        selectedServers: readStringArray(localExternalMcp.selectedServers, effectiveExternalMcp.selectedServers),
        selectedTools: readStringArray(localExternalMcp.selectedTools, effectiveExternalMcp.selectedTools),
      },
    };

    set({
      missionSettingsSnapshot: snapshot,
      missionSettingsDraft: {
        defaultOrchestratorModel: orchestratorModel,
        permissionConfig,
        teammatePlanMode: toTeammatePlanMode(
          readString(localOrchestrator.teammatePlanMode, effectiveOrchestrator.teammatePlanMode, "auto")
        ),
        cliMode: toCliMode(readString(localCli.mode, effectiveCli.mode, "full-auto")),
        cliSandboxPermissions: toCliSandboxPermissions(readString(localCli.sandboxPermissions, effectiveCli.sandboxPermissions, "workspace-write")),
        inProcessMode: toInProcessMode(readString(localInProcess.mode, effectiveInProcess.mode, "full-auto")),
        smartBudget: get().missionSettingsDraft.smartBudget,
      },
    });
  },

  loadMissionSettings: async () => {
    set({ missionSettingsError: null });
    try {
      const snapshot = await window.ade.projectConfig.get();
      get().applyMissionSettingsSnapshot(snapshot);
    } catch (err) {
      set({ missionSettingsError: err instanceof Error ? err.message : String(err) });
    }
  },

  saveMissionSettings: async () => {
    set({ missionSettingsBusy: true, missionSettingsError: null, missionSettingsNotice: null });
    try {
      const state = get();
      const snapshot = state.missionSettingsSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
      const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
      const localCli = isRecord(localPermissions.cli) ? localPermissions.cli : {};
      const localInProcess = isRecord(localPermissions.inProcess) ? localPermissions.inProcess : {};
      const draft = state.missionSettingsDraft;

      const normalizedOrchestratorModel = draft.defaultOrchestratorModel ?? DEFAULT_ORCHESTRATOR_MODEL;
      const normalizedCliMode = toCliMode(draft.cliMode);
      const normalizedCliSandbox = toCliSandboxPermissions(draft.cliSandboxPermissions);
      const normalizedInProcessMode = toInProcessMode(draft.inProcessMode);

      const nextOrchestrator: Record<string, unknown> = {
        ...localOrchestrator,
        defaultOrchestratorModel: normalizedOrchestratorModel,
        teammatePlanMode: toTeammatePlanMode(draft.teammatePlanMode),
      };
      delete nextOrchestrator.requirePlanReview;
      delete nextOrchestrator.defaultDepthTier;
      delete nextOrchestrator.default_depth_tier;
      delete nextOrchestrator.defaultPlannerProvider;

      const nextCli: Record<string, unknown> = {
        ...localCli,
        mode: normalizedCliMode,
        sandboxPermissions: normalizedCliSandbox,
      };

      const nextInProcess: Record<string, unknown> = {
        ...localInProcess,
        mode: normalizedInProcessMode,
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
              providers: draft.permissionConfig?.providers ?? DEFAULT_PERMISSION_CONFIG.providers,
              externalMcp: draft.permissionConfig?.externalMcp,
            },
          },
        },
      });

      get().applyMissionSettingsSnapshot(saved);
      set({ missionSettingsNotice: "Mission settings saved to .ade/local.yaml." });
    } catch (err) {
      set({ missionSettingsError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ missionSettingsBusy: false });
    }
  },

  /* ── Consolidated mission selection (VAL-ARCH-004) ── */
  selectMission: async (missionId: string | null) => {
    const currentSelectedId = get().selectedMissionId;
    const currentHydratedMissionId = get().selectedMission?.id ?? null;
    const selectedIdChanged = missionId !== currentSelectedId;
    const hydratedMissionChanged = missionId !== currentHydratedMissionId;

    // Update selected ID immediately for responsive UI when the selection actually changes.
    if (selectedIdChanged) {
      set({ selectedMissionId: missionId });
    }

    if (!missionId) {
      get().clearSelection();
      return;
    }

    if (hydratedMissionChanged) {
      // Reset transient state only when the user actually switches missions.
      set({
        chatJumpTarget: null,
        logsFocusInterventionId: null,
        activityPanelMode: "signal",
        coordinatorPromptInspector: null,
        workerPromptInspector: null,
      });
    }

    const requestSeq = ++missionSelectionRequestSeq;
    try {
      const view = await window.ade.missions.getFullMissionView({ missionId });
      if (requestSeq !== missionSelectionRequestSeq || get().selectedMissionId !== missionId) {
        return;
      }
      set((state) => ({
        selectedMission: view.mission,
        runGraph: view.runGraph,
        orchestratorArtifacts: Array.isArray(view.artifacts) ? view.artifacts : [],
        workerCheckpoints: Array.isArray(view.checkpoints) ? view.checkpoints : [],
        dashboard: view.dashboard ?? state.dashboard,
        originalStepCount:
          state.originalStepCount === null && view.runGraph && view.runGraph.steps.length > 0
            ? view.runGraph.steps.length
            : state.originalStepCount,
        error: null,
      }));
    } catch (err) {
      if (requestSeq !== missionSelectionRequestSeq || get().selectedMissionId !== missionId) {
        return;
      }
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  /* ── Event subscriptions (VAL-ARCH-007) ── */
  initEventSubscriptions: () => {
    let missionEventTimer: number | null = null;
    let orchestratorEventTimer: number | null = null;

    const unsubMissions = window.ade.missions.onEvent((payload) => {
      if (!isRendererVisible()) return;
      if (missionEventTimer !== null) window.clearTimeout(missionEventTimer);
      missionEventTimer = window.setTimeout(() => {
        missionEventTimer = null;
        void (async () => {
          await get().refreshMissionList({ preserveSelection: true, silent: true });
          await get().loadDashboard();
          const currentSelectedId = get().selectedMissionId;
          if (payload.missionId && payload.missionId === currentSelectedId) {
            await get().selectMission(payload.missionId);
          }
        })();
      }, 350);
    });

    const unsubOrchestrator = window.ade.orchestrator.onEvent((event) => {
      if (!isRendererVisible()) return;
      const selectedRunId = get().runGraph?.run.id ?? null;
      if (selectedRunId && event.runId && event.runId !== selectedRunId) return;
      if (orchestratorEventTimer !== null) window.clearTimeout(orchestratorEventTimer);
      orchestratorEventTimer = window.setTimeout(() => {
        orchestratorEventTimer = null;
        const latestSelectedId = get().selectedMissionId;
        if (!latestSelectedId) return;
        const latestSelectedRunId = get().runGraph?.run.id ?? null;
        if (latestSelectedRunId && event.runId && event.runId !== latestSelectedRunId) return;
        void get().selectMission(latestSelectedId);
      }, 650);
    });

    return () => {
      if (missionEventTimer !== null) window.clearTimeout(missionEventTimer);
      if (orchestratorEventTimer !== null) window.clearTimeout(orchestratorEventTimer);
      unsubMissions();
      unsubOrchestrator();
    };
  },

  /* ── Attention toast management (VAL-ARCH-007) ── */
  addAttentionToast: (message, severity, missionTitle, missionId) => {
    const id = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    set((state) => ({
      attentionToasts: [
        { id, missionTitle, message, severity, missionId },
        ...state.attentionToasts,
      ].slice(0, 3),
    }));
    const timer = window.setTimeout(() => get().dismissAttentionToast(id), 12_000);
    toastTimers.set(id, timer);
  },

  dismissAttentionToast: (id) => {
    set((state) => ({
      attentionToasts: state.attentionToasts.filter((t) => t.id !== id),
    }));
    const timer = toastTimers.get(id);
    if (timer != null) window.clearTimeout(timer);
    toastTimers.delete(id);
  },

  cleanupToastTimers: () => {
    for (const timer of toastTimers.values()) window.clearTimeout(timer);
    toastTimers.clear();
  },

  /* ── Selection reset ── */
  clearSelection: () => set(buildClearedSelectionState()),
}));

/* ════════════════════ FINE-GRAINED SELECTORS ════════════════════ */

export const selectMissions = (s: MissionsStore) => s.missions;
export const selectSelectedMissionId = (s: MissionsStore) => s.selectedMissionId;
export const selectSelectedMission = (s: MissionsStore) => s.selectedMission;
export const selectRunGraph = (s: MissionsStore) => s.runGraph;
export const selectDashboard = (s: MissionsStore) => s.dashboard;
export const selectLoading = (s: MissionsStore) => s.loading;
export const selectError = (s: MissionsStore) => s.error;
export const selectRefreshing = (s: MissionsStore) => s.refreshing;
export const selectActiveTab = (s: MissionsStore) => s.activeTab;
export const selectSearchFilter = (s: MissionsStore) => s.searchFilter;
export const selectMissionListView = (s: MissionsStore) => s.missionListView;
export const selectRunBusy = (s: MissionsStore) => s.runBusy;
export const selectActiveInterventionId = (s: MissionsStore) => s.activeInterventionId;
export const selectAttentionToasts = (s: MissionsStore) => s.attentionToasts;
export const selectCheckpointStatus = (s: MissionsStore) => s.checkpointStatus;
export const selectMissionSettingsOpen = (s: MissionsStore) => s.missionSettingsOpen;
export const selectMissionSettingsDraft = (s: MissionsStore) => s.missionSettingsDraft;
export const selectPlanSubview = (s: MissionsStore) => s.planSubview;
export const selectMissionContextMenu = (s: MissionsStore) => s.missionContextMenu;
export const selectSelectedStepId = (s: MissionsStore) => s.selectedStepId;
export const selectActivityPanelMode = (s: MissionsStore) => s.activityPanelMode;
export const selectOrchestratorArtifacts = (s: MissionsStore) => s.orchestratorArtifacts;
export const selectWorkerCheckpoints = (s: MissionsStore) => s.workerCheckpoints;
export const selectModelCapabilities = (s: MissionsStore) => s.modelCapabilities;
export const selectSteerBusy = (s: MissionsStore) => s.steerBusy;
export const selectCleanupBusy = (s: MissionsStore) => s.cleanupBusy;
export const selectManageMission = (s: MissionsStore) => s.manageMission;
export const selectManageMissionOpen = (s: MissionsStore) => s.manageMissionOpen;
export const selectManageMissionBusy = (s: MissionsStore) => s.manageMissionBusy;
export const selectManageMissionError = (s: MissionsStore) => s.manageMissionError;
export const selectManageMissionCleanupLanes = (s: MissionsStore) => s.manageMissionCleanupLanes;
export const selectChatJumpTarget = (s: MissionsStore) => s.chatJumpTarget;
export const selectLogsFocusInterventionId = (s: MissionsStore) => s.logsFocusInterventionId;
