import { contextBridge, ipcRenderer, webFrame } from "electron";
import { IPC } from "../shared/ipc";
import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationParseNaturalLanguageRequest,
  AutomationParseNaturalLanguageResult,
  AutomationValidateDraftRequest,
  AutomationValidateDraftResult,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
  AutomationSimulateRequest,
  AutomationSimulateResult,
  AiSettingsStatus,
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  AutomationsEventPayload,
  ConflictExternalResolverRunSummary,
  ConflictProposal,
  ConflictProposalPreview,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextPrepareDocGenArgs,
  ContextPrepareDocGenResult,
  ContextInstallGeneratedDocsArgs,
  ContextOpenDocArgs,
  ContextInventorySnapshot,
  ContextStatus,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  DeleteLaneArgs,
  DiffChanges,
  DockLayout,
  GraphPersistedState,
  FileChangeEvent,
  FileContent,
  FileDiff,
  FileTreeNode,
  FilesCreateDirectoryArgs,
  FilesCreateFileArgs,
  FilesDeleteArgs,
  FilesListTreeArgs,
  FilesListWorkspacesArgs,
  FilesQuickOpenArgs,
  FilesQuickOpenItem,
  FilesReadFileArgs,
  FilesRenameArgs,
  FilesSearchTextArgs,
  FilesSearchTextMatch,
  FilesWatchArgs,
  FilesWorkspace,
  FilesWriteTextArgs,
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitConflictState,
  GitGetCommitMessageArgs,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitBatchFileActionArgs,
  GitBranchSummary,
  GitListBranchesArgs,
  GitCheckoutBranchArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitUpstreamSyncStatus,
  GitSyncArgs,
  GitHubStatus,
  CreatePrFromLaneArgs,
  DeletePrArgs,
  DeletePrResult,
  LinkPrToLaneArgs,
  PrEventPayload,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  PrSummary,
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  LandStackArgs,
  LandResult,
  GetDiffChangesArgs,
  GetLaneConflictStatusArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  ExportConfigBundleResult,
  AgentTool,
  AgentChatApproveArgs,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
  AgentChatEventEnvelope,
  AgentChatInterruptArgs,
  AgentChatListArgs,
  AgentChatModelInfo,
  AgentChatModelsArgs,
  AgentChatResumeArgs,
  AgentChatSendArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  CiScanResult,
  CiImportRequest,
  CiImportResult,
  LaneSummary,
  ListOverlapsArgs,
  ListLanesArgs,
  ListMissionsArgs,
  ImportBranchLaneArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  OperationRecord,
  PackEvent,
  PackExport,
  PackHeadVersion,
  PackSummary,
  PackDeltaDigestArgs,
  PackDeltaDigestV1,
  PackVersion,
  PackVersionSummary,
  Checkpoint,
  GetLaneExportArgs,
  GetProjectExportArgs,
  GetConflictExportArgs,
  GetFeatureExportArgs,
  GetPlanExportArgs,
  GetMissionExportArgs,
  GetMissionPackArgs,
  RefreshMissionPackArgs,
  ListPackEventsSinceArgs,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  RecentProjectSummary,
  PtyCreateArgs,
  PtyCreateResult,
  PtyDataEvent,
  PtyExitEvent,
  RiskMatrixEntry,
  RunConflictPredictionArgs,
  RunExternalConflictResolverArgs,
  ListExternalConflictResolverRunsArgs,
  CommitExternalConflictResolverRunArgs,
  CommitExternalConflictResolverRunResult,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  UndoConflictProposalArgs,
  PrepareResolverSessionArgs,
  PrepareResolverSessionResult,
  FinalizeResolverSessionArgs,
  SuggestResolverTargetArgs,
  SuggestResolverTargetResult,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
  CreateStackedPrsArgs,
  CreateStackedPrsResult,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  SimulateIntegrationArgs,
  IntegrationProposal,
  IntegrationResolutionState,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  CommitIntegrationArgs,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  QueueLandingState,
  PrConflictAnalysis,
  PrMergeContext,
  PrHealth,
  PrWithConflicts,
  RebaseNeed,
  RebaseLaneArgs,
  RebaseResult,
  RebaseEventPayload,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RestackArgs,
  RestackResult,
  RestackSuggestion,
  RestackSuggestionsEventPayload,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
  UpdateLaneAppearanceArgs,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalProfilesSnapshot,
  TerminalSessionSummary,
  ResolveMissionInterventionArgs,
  PlanMissionArgs,
  PlanMissionResult,
  ListPlannerRunsArgs,
  GetPlannerAttemptArgs,
  MissionPlannerAttempt,
  MissionPlannerRun,
  DeleteMissionArgs,
  MissionArtifact,
  MissionDetail,
  MissionIntervention,
  OrchestratorAttempt,
  OrchestratorGateReport,
  OrchestratorRuntimeEvent,
  OrchestratorThreadEvent,
  DagMutationEvent,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorTimelineEvent,
  MissionStep,
  MissionSummary,
  MissionsEventPayload,
  GetOrchestratorGateReportArgs,
  GetOrchestratorRunGraphArgs,
  ListOrchestratorRunsArgs,
  ListOrchestratorTimelineArgs,
  CreateMissionArgs,
  CancelOrchestratorRunArgs,
  CleanupOrchestratorTeamResourcesArgs,
  CleanupOrchestratorTeamResourcesResult,
  CompleteOrchestratorAttemptArgs,
  HeartbeatOrchestratorClaimsArgs,
  ResumeOrchestratorRunArgs,
  StartOrchestratorAttemptArgs,
  StartOrchestratorRunArgs,
  StartOrchestratorRunFromMissionArgs,
  TickOrchestratorRunArgs,
  UpdateMissionArgs,
  UpdateMissionStepArgs,
  TestEvent,
  TestRunSummary,
  TestSuiteDefinition,
  WriteTextAtomicArgs,
  GetOrchestratorWorkerStatesArgs,
  OrchestratorWorkerState,
  StartMissionRunWithAIArgs,
  StartMissionRunWithAIResult,
  SteerMissionArgs,
  SteerMissionResult,
  GetMissionDepthConfigArgs,
  MissionDepthConfig,
  GetModelCapabilitiesResult,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorWorkerDigest,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  MissionMetricsConfig,
  MissionMetricSample,
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
  GetOrchestratorWorkerDigestArgs,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorContextCheckpointArgs,
  ListOrchestratorLaneDecisionsArgs,
  GetMissionMetricsArgs,
  SetMissionMetricsConfigArgs,
  ExecutionPlanPreview,
  GetAggregatedUsageArgs,
  AggregatedUsageStats,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  DeliverMessageArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo
} from "../shared/types";

contextBridge.exposeInMainWorld("ade", {
  app: {
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    getProject: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.appGetProject),
    openExternal: async (url: string): Promise<void> => ipcRenderer.invoke(IPC.appOpenExternal, { url }),
    revealPath: async (path: string): Promise<void> => ipcRenderer.invoke(IPC.appRevealPath, { path }),
    writeClipboardText: async (text: string): Promise<void> => ipcRenderer.invoke(IPC.appWriteClipboardText, { text }),
    openPathInEditor: async (args: {
      rootPath: string;
      relativePath?: string;
      target: "finder" | "vscode" | "cursor" | "zed";
    }): Promise<void> => ipcRenderer.invoke(IPC.appOpenPathInEditor, args)
  },
  project: {
    openRepo: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.projectOpenRepo),
    openAdeFolder: async (): Promise<void> => ipcRenderer.invoke(IPC.projectOpenAdeFolder),
    clearLocalData: async (args: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> =>
      ipcRenderer.invoke(IPC.projectClearLocalData, args),
    exportConfig: async (): Promise<ExportConfigBundleResult> => ipcRenderer.invoke(IPC.projectExportConfig),
    listRecent: async (): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectListRecent),
    switchToPath: async (rootPath: string): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.projectSwitchToPath, { rootPath }),
    forgetRecent: async (rootPath: string): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectForgetRecent, { rootPath }),
    onMissing: (cb: (data: { rootPath: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { rootPath: string }) => cb(payload);
      ipcRenderer.on(IPC.projectMissing, listener);
      return () => ipcRenderer.removeListener(IPC.projectMissing, listener);
    }
  },
  keybindings: {
    get: async (): Promise<KeybindingsSnapshot> => ipcRenderer.invoke(IPC.keybindingsGet),
    set: async (overrides: KeybindingOverride[]): Promise<KeybindingsSnapshot> =>
      ipcRenderer.invoke(IPC.keybindingsSet, { overrides })
  },
  ai: {
    getStatus: async (): Promise<AiSettingsStatus> => ipcRenderer.invoke(IPC.aiGetStatus),
    storeApiKey: async (provider: string, key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.aiStoreApiKey, { provider, key }),
    deleteApiKey: async (provider: string): Promise<void> =>
      ipcRenderer.invoke(IPC.aiDeleteApiKey, { provider }),
    listApiKeys: async (): Promise<string[]> =>
      ipcRenderer.invoke(IPC.aiListApiKeys),
  },
  agentTools: {
    detect: async (): Promise<AgentTool[]> => ipcRenderer.invoke(IPC.agentToolsDetect)
  },
  terminalProfiles: {
    get: async (): Promise<TerminalProfilesSnapshot> => ipcRenderer.invoke(IPC.terminalProfilesGet),
    set: async (snapshot: TerminalProfilesSnapshot): Promise<TerminalProfilesSnapshot> =>
      ipcRenderer.invoke(IPC.terminalProfilesSet, snapshot)
  },
  onboarding: {
    getStatus: async (): Promise<OnboardingStatus> => ipcRenderer.invoke(IPC.onboardingGetStatus),
    detectDefaults: async (): Promise<OnboardingDetectionResult> => ipcRenderer.invoke(IPC.onboardingDetectDefaults),
    detectExistingLanes: async (): Promise<OnboardingExistingLaneCandidate[]> =>
      ipcRenderer.invoke(IPC.onboardingDetectExistingLanes),
    generateInitialPacks: async (args: { laneIds?: string[] } = {}): Promise<void> =>
      ipcRenderer.invoke(IPC.onboardingGenerateInitialPacks, args),
    complete: async (): Promise<OnboardingStatus> => ipcRenderer.invoke(IPC.onboardingComplete)
  },
  ci: {
    scan: async (): Promise<CiScanResult> => ipcRenderer.invoke(IPC.ciScan),
    import: async (req: CiImportRequest): Promise<CiImportResult> => ipcRenderer.invoke(IPC.ciImport, req)
  },
  automations: {
    list: async (): Promise<AutomationRuleSummary[]> => ipcRenderer.invoke(IPC.automationsList),
    toggle: async (args: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> =>
      ipcRenderer.invoke(IPC.automationsToggle, args),
    triggerManually: async (args: { id: string; laneId?: string | null }): Promise<AutomationRun> =>
      ipcRenderer.invoke(IPC.automationsTriggerManually, args),
    getHistory: async (args: { id: string; limit?: number }): Promise<AutomationRun[]> =>
      ipcRenderer.invoke(IPC.automationsGetHistory, args),
    getRunDetail: async (runId: string): Promise<AutomationRunDetail | null> =>
      ipcRenderer.invoke(IPC.automationsGetRunDetail, { runId }),
    parseNaturalLanguage: async (req: AutomationParseNaturalLanguageRequest): Promise<AutomationParseNaturalLanguageResult> =>
      ipcRenderer.invoke(IPC.automationsParseNaturalLanguage, req),
    validateDraft: async (req: AutomationValidateDraftRequest): Promise<AutomationValidateDraftResult> =>
      ipcRenderer.invoke(IPC.automationsValidateDraft, req),
    saveDraft: async (req: AutomationSaveDraftRequest): Promise<AutomationSaveDraftResult> =>
      ipcRenderer.invoke(IPC.automationsSaveDraft, req),
    simulate: async (req: AutomationSimulateRequest): Promise<AutomationSimulateResult> =>
      ipcRenderer.invoke(IPC.automationsSimulate, req),
    onEvent: (cb: (ev: AutomationsEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AutomationsEventPayload) => cb(payload);
      ipcRenderer.on(IPC.automationsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.automationsEvent, listener);
    }
  },
  missions: {
    list: async (args: ListMissionsArgs = {}): Promise<MissionSummary[]> => ipcRenderer.invoke(IPC.missionsList, args),
    get: async (missionId: string): Promise<MissionDetail | null> => ipcRenderer.invoke(IPC.missionsGet, { missionId }),
    create: async (args: CreateMissionArgs): Promise<MissionDetail> => ipcRenderer.invoke(IPC.missionsCreate, args),
    update: async (args: UpdateMissionArgs): Promise<MissionDetail> => ipcRenderer.invoke(IPC.missionsUpdate, args),
    delete: async (args: DeleteMissionArgs): Promise<void> => ipcRenderer.invoke(IPC.missionsDelete, args),
    updateStep: async (args: UpdateMissionStepArgs): Promise<MissionStep> => ipcRenderer.invoke(IPC.missionsUpdateStep, args),
    addArtifact: async (args: AddMissionArtifactArgs): Promise<MissionArtifact> => ipcRenderer.invoke(IPC.missionsAddArtifact, args),
    addIntervention: async (args: AddMissionInterventionArgs): Promise<MissionIntervention> =>
      ipcRenderer.invoke(IPC.missionsAddIntervention, args),
    resolveIntervention: async (args: ResolveMissionInterventionArgs): Promise<MissionIntervention> =>
      ipcRenderer.invoke(IPC.missionsResolveIntervention, args),
    onEvent: (cb: (ev: MissionsEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MissionsEventPayload) => cb(payload);
      ipcRenderer.on(IPC.missionsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.missionsEvent, listener);
    }
  },
  planner: {
    planMission: async (args: PlanMissionArgs): Promise<PlanMissionResult> => ipcRenderer.invoke(IPC.plannerPlanMission, args),
    getRuns: async (args: ListPlannerRunsArgs = {}): Promise<MissionPlannerRun[]> => ipcRenderer.invoke(IPC.plannerGetRuns, args),
    getAttempt: async (args: GetPlannerAttemptArgs): Promise<MissionPlannerAttempt | null> =>
      ipcRenderer.invoke(IPC.plannerGetAttempt, args)
  },
  orchestrator: {
    listRuns: async (args: ListOrchestratorRunsArgs = {}): Promise<OrchestratorRun[]> =>
      ipcRenderer.invoke(IPC.orchestratorListRuns, args),
    getRunGraph: async (args: GetOrchestratorRunGraphArgs): Promise<OrchestratorRunGraph> =>
      ipcRenderer.invoke(IPC.orchestratorGetRunGraph, args),
    startRun: async (args: StartOrchestratorRunArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> =>
      ipcRenderer.invoke(IPC.orchestratorStartRun, args),
    startRunFromMission: async (
      args: StartOrchestratorRunFromMissionArgs
    ): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => ipcRenderer.invoke(IPC.orchestratorStartRunFromMission, args),
    approveMissionPlan: async (
      args: StartOrchestratorRunFromMissionArgs
    ): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => ipcRenderer.invoke(IPC.orchestratorApproveMissionPlan, args),
    startAttempt: async (args: StartOrchestratorAttemptArgs): Promise<OrchestratorAttempt> =>
      ipcRenderer.invoke(IPC.orchestratorStartAttempt, args),
    completeAttempt: async (args: CompleteOrchestratorAttemptArgs): Promise<OrchestratorAttempt> =>
      ipcRenderer.invoke(IPC.orchestratorCompleteAttempt, args),
    tickRun: async (args: TickOrchestratorRunArgs): Promise<OrchestratorRun> =>
      ipcRenderer.invoke(IPC.orchestratorTickRun, args),
    resumeRun: async (args: ResumeOrchestratorRunArgs): Promise<OrchestratorRun> =>
      ipcRenderer.invoke(IPC.orchestratorResumeRun, args),
    cancelRun: async (args: CancelOrchestratorRunArgs): Promise<OrchestratorRun> =>
      ipcRenderer.invoke(IPC.orchestratorCancelRun, args),
    cleanupTeamResources: async (
      args: CleanupOrchestratorTeamResourcesArgs
    ): Promise<CleanupOrchestratorTeamResourcesResult> => ipcRenderer.invoke(IPC.orchestratorCleanupTeamResources, args),
    heartbeatClaims: async (args: HeartbeatOrchestratorClaimsArgs): Promise<number> =>
      ipcRenderer.invoke(IPC.orchestratorHeartbeatClaims, args),
    listTimeline: async (args: ListOrchestratorTimelineArgs): Promise<OrchestratorTimelineEvent[]> =>
      ipcRenderer.invoke(IPC.orchestratorListTimeline, args),
    getGateReport: async (args: GetOrchestratorGateReportArgs = {}): Promise<OrchestratorGateReport> =>
      ipcRenderer.invoke(IPC.orchestratorGetGateReport, args),
    getWorkerStates: async (args: GetOrchestratorWorkerStatesArgs): Promise<OrchestratorWorkerState[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetWorkerStates, args),
    startMissionRun: async (args: StartMissionRunWithAIArgs): Promise<StartMissionRunWithAIResult> =>
      ipcRenderer.invoke(IPC.orchestratorStartMissionRun, args),
    steerMission: async (args: SteerMissionArgs): Promise<SteerMissionResult> =>
      ipcRenderer.invoke(IPC.orchestratorSteerMission, args),
    getDepthConfig: async (args: GetMissionDepthConfigArgs): Promise<MissionDepthConfig> =>
      ipcRenderer.invoke(IPC.orchestratorGetDepthConfig, args),
    getModelCapabilities: async (): Promise<GetModelCapabilitiesResult> =>
      ipcRenderer.invoke(IPC.orchestratorGetModelCapabilities),
    sendChat: async (args: SendOrchestratorChatArgs): Promise<OrchestratorChatMessage> =>
      ipcRenderer.invoke(IPC.orchestratorSendChat, args),
    getChat: async (args: GetOrchestratorChatArgs): Promise<OrchestratorChatMessage[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetChat, args),
    listChatThreads: async (args: ListOrchestratorChatThreadsArgs): Promise<OrchestratorChatThread[]> =>
      ipcRenderer.invoke(IPC.orchestratorListChatThreads, args),
    getThreadMessages: async (args: GetOrchestratorThreadMessagesArgs): Promise<OrchestratorChatMessage[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetThreadMessages, args),
    sendThreadMessage: async (args: SendOrchestratorThreadMessageArgs): Promise<OrchestratorChatMessage> =>
      ipcRenderer.invoke(IPC.orchestratorSendThreadMessage, args),
    getWorkerDigest: async (args: GetOrchestratorWorkerDigestArgs): Promise<OrchestratorWorkerDigest | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetWorkerDigest, args),
    listWorkerDigests: async (args: ListOrchestratorWorkerDigestsArgs): Promise<OrchestratorWorkerDigest[]> =>
      ipcRenderer.invoke(IPC.orchestratorListWorkerDigests, args),
    getContextCheckpoint: async (args: GetOrchestratorContextCheckpointArgs): Promise<OrchestratorContextCheckpoint | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetContextCheckpoint, args),
    listLaneDecisions: async (args: ListOrchestratorLaneDecisionsArgs): Promise<OrchestratorLaneDecision[]> =>
      ipcRenderer.invoke(IPC.orchestratorListLaneDecisions, args),
    getMissionMetrics: async (args: GetMissionMetricsArgs): Promise<{ config: MissionMetricsConfig | null; samples: MissionMetricSample[] }> =>
      ipcRenderer.invoke(IPC.orchestratorGetMissionMetrics, args),
    setMissionMetricsConfig: async (args: SetMissionMetricsConfigArgs): Promise<MissionMetricsConfig> =>
      ipcRenderer.invoke(IPC.orchestratorSetMissionMetricsConfig, args),
    getExecutionPlanPreview: async (args: { runId: string }): Promise<ExecutionPlanPreview | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetExecutionPlanPreview, args),
    sendAgentMessage: async (args: SendAgentMessageArgs): Promise<OrchestratorChatMessage> =>
      ipcRenderer.invoke(IPC.orchestratorSendAgentMessage, args),
    getGlobalChat: async (args: GetGlobalChatArgs): Promise<OrchestratorChatMessage[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetGlobalChat, args),
    getActiveAgents: async (args: GetActiveAgentsArgs): Promise<ActiveAgentInfo[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetActiveAgents, args),
    getAggregatedUsage: async (args: GetAggregatedUsageArgs): Promise<AggregatedUsageStats> =>
      ipcRenderer.invoke(IPC.getAggregatedUsage, args),
    onEvent: (cb: (ev: OrchestratorRuntimeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: OrchestratorRuntimeEvent) => cb(payload);
      ipcRenderer.on(IPC.orchestratorEvent, listener);
      return () => ipcRenderer.removeListener(IPC.orchestratorEvent, listener);
    },
    onThreadEvent: (cb: (ev: OrchestratorThreadEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: OrchestratorThreadEvent) => cb(payload);
      ipcRenderer.on(IPC.orchestratorThreadEvent, listener);
      return () => ipcRenderer.removeListener(IPC.orchestratorThreadEvent, listener);
    },
    onDagMutation: (cb: (ev: DagMutationEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DagMutationEvent) => cb(payload);
      ipcRenderer.on(IPC.orchestratorDagMutation, listener);
      return () => ipcRenderer.removeListener(IPC.orchestratorDagMutation, listener);
    }
  },
  lanes: {
    list: async (args: ListLanesArgs = {}): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesList, args),
    create: async (args: CreateLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesCreate, args),
    createChild: async (args: CreateChildLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesCreateChild, args),
    importBranch: async (args: ImportBranchLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesImportBranch, args),
    attach: async (args: AttachLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesAttach, args),
    rename: async (args: RenameLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesRename, args),
    reparent: async (args: ReparentLaneArgs): Promise<ReparentLaneResult> => ipcRenderer.invoke(IPC.lanesReparent, args),
    updateAppearance: async (args: UpdateLaneAppearanceArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesUpdateAppearance, args),
    archive: async (args: ArchiveLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesArchive, args),
    delete: async (args: DeleteLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesDelete, args),
    getStackChain: async (laneId: string): Promise<StackChainItem[]> =>
      ipcRenderer.invoke(IPC.lanesGetStackChain, { laneId }),
    getChildren: async (laneId: string): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesGetChildren, { laneId }),
    restack: async (args: RestackArgs): Promise<RestackResult> => ipcRenderer.invoke(IPC.lanesRestack, args),
    listRestackSuggestions: async (): Promise<RestackSuggestion[]> => ipcRenderer.invoke(IPC.lanesListRestackSuggestions),
    dismissRestackSuggestion: async (args: { laneId: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDismissRestackSuggestion, args),
    deferRestackSuggestion: async (args: { laneId: string; minutes: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDeferRestackSuggestion, args),
    onRestackSuggestionsEvent: (cb: (ev: RestackSuggestionsEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RestackSuggestionsEventPayload) => cb(payload);
      ipcRenderer.on(IPC.lanesRestackSuggestionsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesRestackSuggestionsEvent, listener);
    },
    listAutoRebaseStatuses: async (): Promise<AutoRebaseLaneStatus[]> => ipcRenderer.invoke(IPC.lanesListAutoRebaseStatuses),
    onAutoRebaseEvent: (cb: (ev: AutoRebaseEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AutoRebaseEventPayload) => cb(payload);
      ipcRenderer.on(IPC.lanesAutoRebaseEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesAutoRebaseEvent, listener);
    },
    openFolder: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.lanesOpenFolder, args)
  },
  sessions: {
    list: async (args: ListSessionsArgs = {}): Promise<TerminalSessionSummary[]> =>
      ipcRenderer.invoke(IPC.sessionsList, args),
    get: async (sessionId: string): Promise<TerminalSessionDetail | null> =>
      ipcRenderer.invoke(IPC.sessionsGet, { sessionId }),
    updateMeta: async (args: { sessionId: string; pinned?: boolean; goal?: string | null; toolType?: string | null; resumeCommand?: string | null }): Promise<TerminalSessionSummary | null> =>
      ipcRenderer.invoke(IPC.sessionsUpdateMeta, args),
    readTranscriptTail: async (args: ReadTranscriptTailArgs): Promise<string> =>
      ipcRenderer.invoke(IPC.sessionsReadTranscriptTail, args),
    getDelta: async (sessionId: string): Promise<SessionDeltaSummary | null> =>
      ipcRenderer.invoke(IPC.sessionsGetDelta, { sessionId })
  },
  agentChat: {
    list: async (args: AgentChatListArgs = {}): Promise<AgentChatSessionSummary[]> =>
      ipcRenderer.invoke(IPC.agentChatList, args),
    create: async (args: AgentChatCreateArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatCreate, args),
    send: async (args: AgentChatSendArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatSend, args),
    steer: async (args: AgentChatSteerArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatSteer, args),
    interrupt: async (args: AgentChatInterruptArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatInterrupt, args),
    resume: async (args: AgentChatResumeArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatResume, args),
    approve: async (args: AgentChatApproveArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatApprove, args),
    models: async (args: AgentChatModelsArgs): Promise<AgentChatModelInfo[]> =>
      ipcRenderer.invoke(IPC.agentChatModels, args),
    dispose: async (args: AgentChatDisposeArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatDispose, args),
    onEvent: (cb: (ev: AgentChatEventEnvelope) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentChatEventEnvelope) => cb(payload);
      ipcRenderer.on(IPC.agentChatEvent, listener);
      return () => ipcRenderer.removeListener(IPC.agentChatEvent, listener);
    },
    listContextPacks: async (args: import("../shared/types").ContextPackListArgs = {}): Promise<import("../shared/types").ContextPackOption[]> =>
      ipcRenderer.invoke(IPC.agentChatListContextPacks, args),
    fetchContextPack: async (args: import("../shared/types").ContextPackFetchArgs): Promise<import("../shared/types").ContextPackFetchResult> =>
      ipcRenderer.invoke(IPC.agentChatFetchContextPack, args)
  },
  pty: {
    create: async (args: PtyCreateArgs): Promise<PtyCreateResult> => ipcRenderer.invoke(IPC.ptyCreate, args),
    write: async (arg: { ptyId: string; data: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyWrite, arg),
    resize: async (arg: { ptyId: string; cols: number; rows: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.ptyResize, arg),
    dispose: async (arg: { ptyId: string; sessionId?: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyDispose, arg),
    onData: (cb: (ev: PtyDataEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyData, listener);
      return () => ipcRenderer.removeListener(IPC.ptyData, listener);
    },
    onExit: (cb: (ev: PtyExitEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyExit, listener);
      return () => ipcRenderer.removeListener(IPC.ptyExit, listener);
    }
  },
  diff: {
    getChanges: async (args: GetDiffChangesArgs): Promise<DiffChanges> => ipcRenderer.invoke(IPC.diffGetChanges, args),
    getFile: async (args: GetFileDiffArgs): Promise<FileDiff> => ipcRenderer.invoke(IPC.diffGetFile, args)
  },
  files: {
    writeTextAtomic: async (args: WriteTextAtomicArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWriteTextAtomic, args),
    listWorkspaces: async (args: FilesListWorkspacesArgs = {}): Promise<FilesWorkspace[]> =>
      ipcRenderer.invoke(IPC.filesListWorkspaces, args),
    listTree: async (args: FilesListTreeArgs): Promise<FileTreeNode[]> => ipcRenderer.invoke(IPC.filesListTree, args),
    readFile: async (args: FilesReadFileArgs): Promise<FileContent> => ipcRenderer.invoke(IPC.filesReadFile, args),
    writeText: async (args: FilesWriteTextArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWriteText, args),
    createFile: async (args: FilesCreateFileArgs): Promise<void> => ipcRenderer.invoke(IPC.filesCreateFile, args),
    createDirectory: async (args: FilesCreateDirectoryArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.filesCreateDirectory, args),
    rename: async (args: FilesRenameArgs): Promise<void> => ipcRenderer.invoke(IPC.filesRename, args),
    delete: async (args: FilesDeleteArgs): Promise<void> => ipcRenderer.invoke(IPC.filesDelete, args),
    watchChanges: async (args: FilesWatchArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWatchChanges, args),
    stopWatching: async (args: FilesWatchArgs): Promise<void> => ipcRenderer.invoke(IPC.filesStopWatching, args),
    quickOpen: async (args: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> => ipcRenderer.invoke(IPC.filesQuickOpen, args),
    searchText: async (args: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> => ipcRenderer.invoke(IPC.filesSearchText, args),
    onChange: (cb: (ev: FileChangeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FileChangeEvent) => cb(payload);
      ipcRenderer.on(IPC.filesChange, listener);
      return () => ipcRenderer.removeListener(IPC.filesChange, listener);
    }
  },
  git: {
    stageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStageFile, args),
    stageAll: async (args: GitBatchFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStageAll, args),
    unstageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitUnstageFile, args),
    unstageAll: async (args: GitBatchFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitUnstageAll, args),
    discardFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitDiscardFile, args),
    restoreStagedFile: async (args: GitFileActionArgs): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitRestoreStagedFile, args),
    commit: async (args: GitCommitArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitCommit, args),
    listRecentCommits: async (args: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> =>
      ipcRenderer.invoke(IPC.gitListRecentCommits, args),
    listCommitFiles: async (args: GitListCommitFilesArgs): Promise<string[]> =>
      ipcRenderer.invoke(IPC.gitListCommitFiles, args),
    getCommitMessage: async (args: GitGetCommitMessageArgs): Promise<string> =>
      ipcRenderer.invoke(IPC.gitGetCommitMessage, args),
    revertCommit: async (args: GitRevertArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitRevertCommit, args),
    cherryPickCommit: async (args: GitCherryPickArgs): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitCherryPickCommit, args),
    stashPush: async (args: GitStashPushArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashPush, args),
    stashList: async (args: { laneId: string }): Promise<GitStashSummary[]> => ipcRenderer.invoke(IPC.gitStashList, args),
    stashApply: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashApply, args),
    stashPop: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashPop, args),
    stashDrop: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashDrop, args),
    fetch: async (args: { laneId: string }): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitFetch, args),
    pull: async (args: { laneId: string }): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitPull, args),
    getSyncStatus: async (args: { laneId: string }): Promise<GitUpstreamSyncStatus> =>
      ipcRenderer.invoke(IPC.gitGetSyncStatus, args),
    sync: async (args: GitSyncArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitSync, args),
    push: async (args: GitPushArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitPush, args),
    getConflictState: async (laneId: string): Promise<GitConflictState> =>
      ipcRenderer.invoke(IPC.gitGetConflictState, { laneId }),
    rebaseContinue: async (laneId: string): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitRebaseContinue, { laneId }),
    rebaseAbort: async (laneId: string): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitRebaseAbort, { laneId }),
    mergeContinue: async (laneId: string): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitMergeContinue, { laneId }),
    mergeAbort: async (laneId: string): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitMergeAbort, { laneId }),
    listBranches: async (args: GitListBranchesArgs): Promise<GitBranchSummary[]> =>
      ipcRenderer.invoke(IPC.gitListBranches, args),
    checkoutBranch: async (args: GitCheckoutBranchArgs): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitCheckoutBranch, args)
  },
  conflicts: {
    getLaneStatus: async (args: GetLaneConflictStatusArgs): Promise<ConflictStatus> =>
      ipcRenderer.invoke(IPC.conflictsGetLaneStatus, args),
    listOverlaps: async (args: ListOverlapsArgs): Promise<ConflictOverlap[]> =>
      ipcRenderer.invoke(IPC.conflictsListOverlaps, args),
    getRiskMatrix: async (): Promise<RiskMatrixEntry[]> => ipcRenderer.invoke(IPC.conflictsGetRiskMatrix),
    simulateMerge: async (args: MergeSimulationArgs): Promise<MergeSimulationResult> =>
      ipcRenderer.invoke(IPC.conflictsSimulateMerge, args),
    runPrediction: async (args: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> =>
      ipcRenderer.invoke(IPC.conflictsRunPrediction, args),
    getBatchAssessment: async (): Promise<BatchAssessmentResult> => ipcRenderer.invoke(IPC.conflictsGetBatchAssessment),
    listProposals: async (laneId: string): Promise<ConflictProposal[]> =>
      ipcRenderer.invoke(IPC.conflictsListProposals, { laneId }),
    prepareProposal: async (args: PrepareConflictProposalArgs): Promise<ConflictProposalPreview> =>
      ipcRenderer.invoke(IPC.conflictsPrepareProposal, args),
    requestProposal: async (args: RequestConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsRequestProposal, args),
    applyProposal: async (args: ApplyConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsApplyProposal, args),
    undoProposal: async (args: UndoConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsUndoProposal, args),
    runExternalResolver: async (args: RunExternalConflictResolverArgs): Promise<ConflictExternalResolverRunSummary> =>
      ipcRenderer.invoke(IPC.conflictsRunExternalResolver, args),
    listExternalResolverRuns: async (args: ListExternalConflictResolverRunsArgs = {}): Promise<ConflictExternalResolverRunSummary[]> =>
      ipcRenderer.invoke(IPC.conflictsListExternalResolverRuns, args),
    commitExternalResolverRun: async (args: CommitExternalConflictResolverRunArgs): Promise<CommitExternalConflictResolverRunResult> =>
      ipcRenderer.invoke(IPC.conflictsCommitExternalResolverRun, args),
    prepareResolverSession: (args: PrepareResolverSessionArgs): Promise<PrepareResolverSessionResult> =>
      ipcRenderer.invoke(IPC.conflictsPrepareResolverSession, args),
    finalizeResolverSession: (args: FinalizeResolverSessionArgs): Promise<ConflictExternalResolverRunSummary> =>
      ipcRenderer.invoke(IPC.conflictsFinalizeResolverSession, args),
    suggestResolverTarget: (args: SuggestResolverTargetArgs): Promise<SuggestResolverTargetResult> =>
      ipcRenderer.invoke(IPC.conflictsSuggestResolverTarget, args),
    onEvent: (cb: (ev: ConflictEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ConflictEventPayload) => cb(payload);
      ipcRenderer.on(IPC.conflictsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.conflictsEvent, listener);
    }
  },
  context: {
    getStatus: async (): Promise<ContextStatus> => ipcRenderer.invoke(IPC.contextGetStatus),
    getInventory: async (): Promise<ContextInventorySnapshot> => ipcRenderer.invoke(IPC.contextGetInventory),
    generateDocs: async (args: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> =>
      ipcRenderer.invoke(IPC.contextGenerateDocs, args),
    prepareDocGeneration: async (args: ContextPrepareDocGenArgs): Promise<ContextPrepareDocGenResult> =>
      ipcRenderer.invoke(IPC.contextPrepareDocGeneration, args),
    installGeneratedDocs: async (args: ContextInstallGeneratedDocsArgs): Promise<ContextGenerateDocsResult> =>
      ipcRenderer.invoke(IPC.contextInstallGeneratedDocs, args),
    openDoc: async (args: ContextOpenDocArgs): Promise<void> => ipcRenderer.invoke(IPC.contextOpenDoc, args)
  },
  packs: {
    getProjectPack: async (): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsGetProjectPack),
    getLanePack: async (laneId: string): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsGetLanePack, { laneId }),
    getFeaturePack: async (featureKey: string): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsGetFeaturePack, { featureKey }),
    getConflictPack: async (args: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsGetConflictPack, args),
    getPlanPack: async (laneId: string): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsGetPlanPack, { laneId }),
    getMissionPack: async (args: GetMissionPackArgs): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsGetMissionPack, args),
    getProjectExport: async (args: GetProjectExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetProjectExport, args),
    getLaneExport: async (args: GetLaneExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetLaneExport, args),
    getConflictExport: async (args: GetConflictExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetConflictExport, args),
    getFeatureExport: async (args: GetFeatureExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetFeatureExport, args),
    getPlanExport: async (args: GetPlanExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetPlanExport, args),
    getMissionExport: async (args: GetMissionExportArgs): Promise<PackExport> =>
      ipcRenderer.invoke(IPC.packsGetMissionExport, args),
    refreshLanePack: async (laneId: string): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsRefreshLanePack, { laneId }),
    refreshProjectPack: async (args: { laneId?: string | null } = {}): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsRefreshProjectPack, args),
    refreshFeaturePack: async (featureKey: string): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsRefreshFeaturePack, { featureKey }),
    refreshConflictPack: async (args: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsRefreshConflictPack, args),
    savePlanPack: async (args: { laneId: string; body: string }): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsSavePlanPack, args),
    refreshMissionPack: async (args: RefreshMissionPackArgs): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsRefreshMissionPack, args),
    refreshPlanPack: async (laneId: string): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsRefreshPlanPack, { laneId }),
    listVersions: async (args: { packKey: string; limit?: number }): Promise<PackVersionSummary[]> =>
      ipcRenderer.invoke(IPC.packsListVersions, args),
    getVersion: async (versionId: string): Promise<PackVersion> => ipcRenderer.invoke(IPC.packsGetVersion, { versionId }),
    diffVersions: async (args: { fromId: string; toId: string }): Promise<string> =>
      ipcRenderer.invoke(IPC.packsDiffVersions, args),
    updateNarrative: async (args: { packKey: string; narrative: string }): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsUpdateNarrative, args),
    listEvents: async (args: { packKey: string; limit?: number }): Promise<PackEvent[]> =>
      ipcRenderer.invoke(IPC.packsListEvents, args),
    listEventsSince: async (args: ListPackEventsSinceArgs): Promise<PackEvent[]> =>
      ipcRenderer.invoke(IPC.packsListEventsSince, args),
    listCheckpoints: async (args: { laneId?: string; limit?: number } = {}): Promise<Checkpoint[]> =>
      ipcRenderer.invoke(IPC.packsListCheckpoints, args),
    getHeadVersion: async (packKey: string): Promise<PackHeadVersion> =>
      ipcRenderer.invoke(IPC.packsGetHeadVersion, { packKey }),
    getDeltaDigest: async (args: PackDeltaDigestArgs): Promise<PackDeltaDigestV1> =>
      ipcRenderer.invoke(IPC.packsGetDeltaDigest, args),
    onEvent: (cb: (ev: PackEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PackEvent) => cb(payload);
      ipcRenderer.on(IPC.packsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.packsEvent, listener);
    }
  },
  github: {
    getStatus: async (): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubGetStatus),
    setToken: async (token: string): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubSetToken, { token }),
    clearToken: async (): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubClearToken)
  },
  prs: {
    createFromLane: async (args: CreatePrFromLaneArgs): Promise<PrSummary> => ipcRenderer.invoke(IPC.prsCreateFromLane, args),
    linkToLane: async (args: LinkPrToLaneArgs): Promise<PrSummary> => ipcRenderer.invoke(IPC.prsLinkToLane, args),
    getForLane: async (laneId: string): Promise<PrSummary | null> => ipcRenderer.invoke(IPC.prsGetForLane, { laneId }),
    listAll: async (): Promise<PrSummary[]> => ipcRenderer.invoke(IPC.prsListAll),
    refresh: async (args: { prId?: string } = {}): Promise<PrSummary[]> => ipcRenderer.invoke(IPC.prsRefresh, args),
    getStatus: async (prId: string): Promise<PrStatus> => ipcRenderer.invoke(IPC.prsGetStatus, { prId }),
    getChecks: async (prId: string): Promise<PrCheck[]> => ipcRenderer.invoke(IPC.prsGetChecks, { prId }),
    getComments: async (prId: string): Promise<PrComment[]> => ipcRenderer.invoke(IPC.prsGetComments, { prId }),
    getReviews: async (prId: string): Promise<PrReview[]> => ipcRenderer.invoke(IPC.prsGetReviews, { prId }),
    updateDescription: async (args: UpdatePrDescriptionArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateDescription, args),
    delete: async (args: DeletePrArgs): Promise<DeletePrResult> => ipcRenderer.invoke(IPC.prsDelete, args),
    draftDescription: async (laneId: string, model?: string): Promise<{ title: string; body: string }> =>
      ipcRenderer.invoke(IPC.prsDraftDescription, { laneId, model }),
    land: async (args: LandPrArgs): Promise<LandResult> => ipcRenderer.invoke(IPC.prsLand, args),
    landStack: async (args: LandStackArgs): Promise<LandResult[]> => ipcRenderer.invoke(IPC.prsLandStack, args),
    openInGitHub: async (prId: string): Promise<void> => ipcRenderer.invoke(IPC.prsOpenInGitHub, { prId }),
    createStacked: (args: CreateStackedPrsArgs): Promise<CreateStackedPrsResult> =>
      ipcRenderer.invoke(IPC.prsCreateStacked, args),
    createQueue: (args: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> =>
      ipcRenderer.invoke(IPC.prsCreateQueue, args),
    createIntegration: (args: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> =>
      ipcRenderer.invoke(IPC.prsCreateIntegration, args),
    simulateIntegration: (args: SimulateIntegrationArgs): Promise<IntegrationProposal> =>
      ipcRenderer.invoke(IPC.prsSimulateIntegration, args),
    commitIntegration: (args: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> =>
      ipcRenderer.invoke(IPC.prsCommitIntegration, args),
    listProposals: (): Promise<IntegrationProposal[]> =>
      ipcRenderer.invoke(IPC.prsListProposals),
    updateProposal: (args: UpdateIntegrationProposalArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsUpdateProposal, args),
    deleteProposal: (proposalId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.prsDeleteProposal, proposalId),
    landStackEnhanced: (args: LandStackEnhancedArgs): Promise<LandResult[]> =>
      ipcRenderer.invoke(IPC.prsLandStackEnhanced, args),
    landQueueNext: (args: LandQueueNextArgs): Promise<LandResult> =>
      ipcRenderer.invoke(IPC.prsLandQueueNext, args),
    getHealth: (prId: string): Promise<PrHealth> =>
      ipcRenderer.invoke(IPC.prsGetHealth, { prId }),
    getQueueState: (groupId: string): Promise<QueueLandingState | null> =>
      ipcRenderer.invoke(IPC.prsGetQueueState, { groupId }),
    getConflictAnalysis: (prId: string): Promise<PrConflictAnalysis> =>
      ipcRenderer.invoke(IPC.prsGetConflictAnalysis, { prId }),
    getMergeContext: (prId: string): Promise<PrMergeContext> =>
      ipcRenderer.invoke(IPC.prsGetMergeContext, { prId }),
    listWithConflicts: (): Promise<PrWithConflicts[]> =>
      ipcRenderer.invoke(IPC.prsListWithConflicts),
    createIntegrationLaneForProposal: (args: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult> =>
      ipcRenderer.invoke(IPC.prsCreateIntegrationLaneForProposal, args),
    startIntegrationResolution: (args: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> =>
      ipcRenderer.invoke(IPC.prsStartIntegrationResolution, args),
    getIntegrationResolutionState: (proposalId: string): Promise<IntegrationResolutionState | null> =>
      ipcRenderer.invoke(IPC.prsGetIntegrationResolutionState, { proposalId }),
    recheckIntegrationStep: (args: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> =>
      ipcRenderer.invoke(IPC.prsRecheckIntegrationStep, args),
    onEvent: (cb: (ev: PrEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PrEventPayload) => cb(payload);
      ipcRenderer.on(IPC.prsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.prsEvent, listener);
    }
  },
  rebase: {
    scanNeeds: async (): Promise<RebaseNeed[]> => ipcRenderer.invoke(IPC.rebaseScanNeeds),
    getNeed: async (laneId: string): Promise<RebaseNeed | null> =>
      ipcRenderer.invoke(IPC.rebaseGetNeed, { laneId }),
    dismiss: async (laneId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.rebaseDismiss, { laneId }),
    defer: async (laneId: string, until: string): Promise<void> =>
      ipcRenderer.invoke(IPC.rebaseDefer, { laneId, until }),
    execute: async (args: RebaseLaneArgs): Promise<RebaseResult> =>
      ipcRenderer.invoke(IPC.rebaseExecute, args),
    onEvent: (cb: (ev: RebaseEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RebaseEventPayload) => cb(payload);
      ipcRenderer.on(IPC.rebaseEvent, listener);
      return () => ipcRenderer.removeListener(IPC.rebaseEvent, listener);
    }
  },
  history: {
    listOperations: async (args: ListOperationsArgs = {}): Promise<OperationRecord[]> =>
      ipcRenderer.invoke(IPC.historyListOperations, args),
    exportOperations: async (args: ExportHistoryArgs): Promise<ExportHistoryResult> =>
      ipcRenderer.invoke(IPC.historyExportOperations, args)
  },
  layout: {
    get: async (layoutId: string): Promise<DockLayout | null> => ipcRenderer.invoke(IPC.layoutGet, { layoutId }),
    set: async (layoutId: string, layout: DockLayout): Promise<void> =>
      ipcRenderer.invoke(IPC.layoutSet, { layoutId, layout })
  },
  tilingTree: {
    get: async (layoutId: string): Promise<unknown> => ipcRenderer.invoke(IPC.tilingTreeGet, { layoutId }),
    set: async (layoutId: string, tree: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC.tilingTreeSet, { layoutId, tree })
  },
  graphState: {
    get: async (projectId: string): Promise<GraphPersistedState | null> =>
      ipcRenderer.invoke(IPC.graphStateGet, { projectId }),
    set: async (projectId: string, state: GraphPersistedState): Promise<void> =>
      ipcRenderer.invoke(IPC.graphStateSet, { projectId, state })
  },
  processes: {
    listDefinitions: async (): Promise<ProcessDefinition[]> => ipcRenderer.invoke(IPC.processesListDefinitions),
    listRuntime: async (laneId: string): Promise<ProcessRuntime[]> => ipcRenderer.invoke(IPC.processesListRuntime, { laneId }),
    start: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStart, args),
    stop: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStop, args),
    restart: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesRestart, args),
    kill: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesKill, args),
    startStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStartStack, args),
    stopStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStopStack, args),
    restartStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesRestartStack, args),
    startAll: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.processesStartAll, args),
    stopAll: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.processesStopAll, args),
    getLogTail: async (args: GetProcessLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.processesGetLogTail, args),
    onEvent: (cb: (ev: ProcessEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProcessEvent) => cb(payload);
      ipcRenderer.on(IPC.processesEvent, listener);
      return () => ipcRenderer.removeListener(IPC.processesEvent, listener);
    }
  },
  tests: {
    listSuites: async (): Promise<TestSuiteDefinition[]> => ipcRenderer.invoke(IPC.testsListSuites),
    run: async (args: RunTestSuiteArgs): Promise<TestRunSummary> => ipcRenderer.invoke(IPC.testsRun, args),
    stop: async (args: StopTestRunArgs): Promise<void> => ipcRenderer.invoke(IPC.testsStop, args),
    listRuns: async (args: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => ipcRenderer.invoke(IPC.testsListRuns, args),
    getLogTail: async (args: GetTestLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.testsGetLogTail, args),
    onEvent: (cb: (ev: TestEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TestEvent) => cb(payload);
      ipcRenderer.on(IPC.testsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.testsEvent, listener);
    }
  },
  projectConfig: {
    get: async (): Promise<ProjectConfigSnapshot> => ipcRenderer.invoke(IPC.projectConfigGet),
    validate: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigValidationResult> =>
      ipcRenderer.invoke(IPC.projectConfigValidate, { candidate }),
    save: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigSnapshot> =>
      ipcRenderer.invoke(IPC.projectConfigSave, { candidate }),
    diffAgainstDisk: async (): Promise<ProjectConfigDiff> => ipcRenderer.invoke(IPC.projectConfigDiffAgainstDisk),
    confirmTrust: async (arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> =>
      ipcRenderer.invoke(IPC.projectConfigConfirmTrust, arg)
  },
  zoom: {
    getLevel: (): number => webFrame.getZoomLevel(),
    setLevel: (level: number): void => webFrame.setZoomLevel(level),
    getFactor: (): number => webFrame.getZoomFactor()
  },
  memory: {
    getBudget: async (args: { projectId?: string; level?: string } = {}): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memoryGetBudget, args),
    getCandidates: async (args: { projectId?: string; limit?: number } = {}): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memoryGetCandidates, args),
    promote: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryPromote, args),
    archive: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryArchive, args),
    search: async (args: { query: string; projectId?: string; limit?: number }): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memorySearch, args)
  }
});
