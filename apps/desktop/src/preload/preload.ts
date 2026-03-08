import { contextBridge, ipcRenderer, webFrame } from "electron";
import { IPC } from "../shared/ipc";
import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
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
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateCoreMemoryArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  AgentIdentity,
  AgentCoreMemory,
  AgentSessionLogEntry,
  AgentConfigRevision,
  AgentBudgetSnapshot,
  WorkerAgentRun,
  CtoListAgentsArgs,
  CtoSaveAgentArgs,
  CtoRemoveAgentArgs,
  CtoListAgentRevisionsArgs,
  CtoRollbackAgentRevisionArgs,
  CtoEnsureAgentSessionArgs,
  CtoGetBudgetSnapshotArgs,
  CtoTriggerAgentWakeupArgs,
  CtoTriggerAgentWakeupResult,
  CtoListAgentRunsArgs,
  CtoListAgentTaskSessionsArgs,
  CtoClearAgentTaskSessionArgs,
  AgentTaskSession,
  CtoGetAgentCoreMemoryArgs,
  CtoUpdateAgentCoreMemoryArgs,
  CtoListAgentSessionLogsArgs,
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  CtoSaveFlowPolicyArgs,
  CtoFlowPolicyRevision,
  CtoRollbackFlowPolicyRevisionArgs,
  CtoSimulateFlowRouteArgs,
  LinearRouteDecision,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  CtoResolveLinearSyncQueueItemArgs,
  LinearSyncConfig,
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  AutomationsEventPayload,
  ConflictExternalResolverRunSummary,
  ConflictProposal,
  ConflictProposalPreview,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextOpenDocArgs,
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
  PrDetail,
  PrFile,
  PrActionRun,
  PrActivityEvent,
  PrLabel,
  PrUser,
  AddPrCommentArgs,
  UpdatePrTitleArgs,
  UpdatePrBodyArgs,
  SetPrLabelsArgs,
  RequestPrReviewersArgs,
  SubmitPrReviewArgs,
  ClosePrArgs,
  ReopenPrArgs,
  RerunPrChecksArgs,
  AiReviewSummaryArgs,
  AiReviewSummary,
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
  AgentChatUpdateSessionArgs,
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
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  PrAiResolutionInputArgs,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
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
  RebaseStartArgs,
  RebaseStartResult,
  RebasePushArgs,
  RebaseRollbackArgs,
  RebaseAbortArgs,
  RebaseRun,
  RebaseRunEventPayload,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RebaseSuggestion,
  RebaseSuggestionsEventPayload,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
  UpdateLaneAppearanceArgs,
  InitLaneEnvArgs,
  GetLaneEnvStatusArgs,
  GetLaneOverlayArgs,
  LaneEnvInitProgress,
  LaneEnvInitEvent,
  LaneOverlayOverrides,
  LaneTemplate,
  GetLaneTemplateArgs,
  SetDefaultLaneTemplateArgs,
  ApplyLaneTemplateArgs,
  GetPortLeaseArgs,
  AcquirePortLeaseArgs,
  ReleasePortLeaseArgs,
  PortLease,
  PortConflict,
  PortAllocationEvent,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalProfilesSnapshot,
  TerminalSessionSummary,
  ResolveMissionInterventionArgs,
  PhaseCard,
  PhaseProfile,
  ListPhaseItemsArgs,
  SavePhaseItemArgs,
  DeletePhaseItemArgs,
  ExportPhaseItemsArgs,
  ExportPhaseItemsResult,
  ImportPhaseItemsArgs,
  SavePhaseProfileArgs,
  ListPhaseProfilesArgs,
  DeletePhaseProfileArgs,
  ClonePhaseProfileArgs,
  ExportPhaseProfileArgs,
  ExportPhaseProfileResult,
  ImportPhaseProfileArgs,
  MissionPhaseConfiguration,
  MissionDashboardSnapshot,
  MissionPreflightRequest,
  MissionPreflightResult,
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
  PauseOrchestratorRunArgs,
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
  GetTeamMembersArgs,
  GetTeamRuntimeStateArgs,
  FinalizeRunArgs,
  FinalizeRunResult,
  OrchestratorTeamMember,
  OrchestratorTeamRuntimeState,
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
  GetMissionStateDocumentArgs,
  MissionStateDocument,
  GetMissionLogsArgs,
  GetMissionLogsResult,
  ExportMissionLogsArgs,
  ExportMissionLogsResult,
  GetAggregatedUsageArgs,
  AggregatedUsageStats,
  UsageSnapshot,
  BudgetCheckResult,
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapConfig,
  GetMissionBudgetTelemetryArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetTelemetrySnapshot,
  MissionBudgetSnapshot,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo
} from "../shared/types";

contextBridge.exposeInMainWorld("ade", {
  app: {
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    getProject: async (): Promise<ProjectInfo | null> => ipcRenderer.invoke(IPC.appGetProject),
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
    openRepo: async (): Promise<ProjectInfo | null> => ipcRenderer.invoke(IPC.projectOpenRepo),
    openAdeFolder: async (): Promise<void> => ipcRenderer.invoke(IPC.projectOpenAdeFolder),
    clearLocalData: async (args: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> =>
      ipcRenderer.invoke(IPC.projectClearLocalData, args),
    listRecent: async (): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectListRecent),
    closeCurrent: async (): Promise<void> => ipcRenderer.invoke(IPC.projectCloseCurrent),
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
    verifyApiKey: async (provider: string): Promise<AiApiKeyVerificationResult> =>
      ipcRenderer.invoke(IPC.aiVerifyApiKey, { provider }),
    updateConfig: async (config: Partial<AiConfig>): Promise<void> =>
      ipcRenderer.invoke(IPC.aiUpdateConfig, config),
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
  usage: {
    getSnapshot: async (): Promise<UsageSnapshot | null> =>
      ipcRenderer.invoke(IPC.usageGetSnapshot),
    refresh: async (): Promise<UsageSnapshot | null> =>
      ipcRenderer.invoke(IPC.usageRefresh),
    checkBudget: async (args: { scope: BudgetCapScope; scopeId?: string; provider: BudgetCapProvider }): Promise<BudgetCheckResult> =>
      ipcRenderer.invoke(IPC.usageCheckBudget, args),
    getCumulativeUsage: async (args: { scope: BudgetCapScope; scopeId?: string; provider?: BudgetCapProvider }): Promise<{ totalTokens: number; totalCostUsd: number; weekKey: string }> =>
      ipcRenderer.invoke(IPC.usageGetCumulativeUsage, args),
    getBudgetConfig: async (): Promise<BudgetCapConfig> =>
      ipcRenderer.invoke(IPC.usageGetBudgetConfig),
    onUpdate: (cb: (snapshot: UsageSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: UsageSnapshot) => cb(snapshot);
      ipcRenderer.on(IPC.usageEvent, listener);
      return () => ipcRenderer.removeListener(IPC.usageEvent, listener);
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
    listPhaseItems: async (args: ListPhaseItemsArgs = {}): Promise<PhaseCard[]> =>
      ipcRenderer.invoke(IPC.missionsListPhaseItems, args),
    savePhaseItem: async (args: SavePhaseItemArgs): Promise<PhaseCard> =>
      ipcRenderer.invoke(IPC.missionsSavePhaseItem, args),
    deletePhaseItem: async (args: DeletePhaseItemArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.missionsDeletePhaseItem, args),
    importPhaseItems: async (args: ImportPhaseItemsArgs): Promise<PhaseCard[]> =>
      ipcRenderer.invoke(IPC.missionsImportPhaseItems, args),
    exportPhaseItems: async (args: ExportPhaseItemsArgs = {}): Promise<ExportPhaseItemsResult> =>
      ipcRenderer.invoke(IPC.missionsExportPhaseItems, args),
    listPhaseProfiles: async (args: ListPhaseProfilesArgs = {}): Promise<PhaseProfile[]> =>
      ipcRenderer.invoke(IPC.missionsListPhaseProfiles, args),
    savePhaseProfile: async (args: SavePhaseProfileArgs): Promise<PhaseProfile> =>
      ipcRenderer.invoke(IPC.missionsSavePhaseProfile, args),
    deletePhaseProfile: async (args: DeletePhaseProfileArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.missionsDeletePhaseProfile, args),
    clonePhaseProfile: async (args: ClonePhaseProfileArgs): Promise<PhaseProfile> =>
      ipcRenderer.invoke(IPC.missionsClonePhaseProfile, args),
    exportPhaseProfile: async (args: ExportPhaseProfileArgs): Promise<ExportPhaseProfileResult> =>
      ipcRenderer.invoke(IPC.missionsExportPhaseProfile, args),
    importPhaseProfile: async (args: ImportPhaseProfileArgs): Promise<PhaseProfile> =>
      ipcRenderer.invoke(IPC.missionsImportPhaseProfile, args),
    getPhaseConfiguration: async (missionId: string): Promise<MissionPhaseConfiguration | null> =>
      ipcRenderer.invoke(IPC.missionsGetPhaseConfiguration, { missionId }),
    getDashboard: async (): Promise<MissionDashboardSnapshot> =>
      ipcRenderer.invoke(IPC.missionsGetDashboard),
    preflight: async (args: MissionPreflightRequest): Promise<MissionPreflightResult> =>
      ipcRenderer.invoke(IPC.missionsPreflight, args),
    onEvent: (cb: (ev: MissionsEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MissionsEventPayload) => cb(payload);
      ipcRenderer.on(IPC.missionsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.missionsEvent, listener);
    }
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
    startAttempt: async (args: StartOrchestratorAttemptArgs): Promise<OrchestratorAttempt> =>
      ipcRenderer.invoke(IPC.orchestratorStartAttempt, args),
    completeAttempt: async (args: CompleteOrchestratorAttemptArgs): Promise<OrchestratorAttempt> =>
      ipcRenderer.invoke(IPC.orchestratorCompleteAttempt, args),
    tickRun: async (args: TickOrchestratorRunArgs): Promise<OrchestratorRun> =>
      ipcRenderer.invoke(IPC.orchestratorTickRun, args),
    pauseRun: async (args: PauseOrchestratorRunArgs): Promise<OrchestratorRun> =>
      ipcRenderer.invoke(IPC.orchestratorPauseRun, args),
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
    getMissionLogs: async (args: GetMissionLogsArgs): Promise<GetMissionLogsResult> =>
      ipcRenderer.invoke(IPC.orchestratorGetMissionLogs, args),
    exportMissionLogs: async (args: ExportMissionLogsArgs): Promise<ExportMissionLogsResult> =>
      ipcRenderer.invoke(IPC.orchestratorExportMissionLogs, args),
    getGateReport: async (args: GetOrchestratorGateReportArgs = {}): Promise<OrchestratorGateReport> =>
      ipcRenderer.invoke(IPC.orchestratorGetGateReport, args),
    getWorkerStates: async (args: GetOrchestratorWorkerStatesArgs): Promise<OrchestratorWorkerState[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetWorkerStates, args),
    startMissionRun: async (args: StartMissionRunWithAIArgs): Promise<StartMissionRunWithAIResult> =>
      ipcRenderer.invoke(IPC.orchestratorStartMissionRun, args),
    steerMission: async (args: SteerMissionArgs): Promise<SteerMissionResult> =>
      ipcRenderer.invoke(IPC.orchestratorSteerMission, args),
    getModelCapabilities: async (): Promise<GetModelCapabilitiesResult> =>
      ipcRenderer.invoke(IPC.orchestratorGetModelCapabilities),
    getTeamMembers: async (args: GetTeamMembersArgs): Promise<OrchestratorTeamMember[]> =>
      ipcRenderer.invoke(IPC.orchestratorGetTeamMembers, args),
    getTeamRuntimeState: async (args: GetTeamRuntimeStateArgs): Promise<OrchestratorTeamRuntimeState | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetTeamRuntimeState, args),
    finalizeRun: async (args: FinalizeRunArgs): Promise<FinalizeRunResult> =>
      ipcRenderer.invoke(IPC.orchestratorFinalizeRun, args),
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
    getMissionStateDocument: async (args: GetMissionStateDocumentArgs): Promise<MissionStateDocument | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetMissionStateDocument, args),
    getCheckpointStatus: async (
      args: { runId: string }
    ): Promise<{ savedAt: string; turnCount: number; compactionCount: number } | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetCheckpointStatus, args),
    getMissionBudgetStatus: async (args: GetMissionBudgetStatusArgs): Promise<MissionBudgetSnapshot> =>
      ipcRenderer.invoke(IPC.orchestratorGetMissionBudgetStatus, args),
    getMissionBudgetTelemetry: async (
      args: GetMissionBudgetTelemetryArgs
    ): Promise<MissionBudgetTelemetrySnapshot> =>
      ipcRenderer.invoke(IPC.orchestratorGetMissionBudgetTelemetry, args),
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
    adoptAttached: async (args: AdoptAttachedLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesAdoptAttached, args),
    rename: async (args: RenameLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesRename, args),
    reparent: async (args: ReparentLaneArgs): Promise<ReparentLaneResult> => ipcRenderer.invoke(IPC.lanesReparent, args),
    updateAppearance: async (args: UpdateLaneAppearanceArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesUpdateAppearance, args),
    archive: async (args: ArchiveLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesArchive, args),
    delete: async (args: DeleteLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesDelete, args),
    getStackChain: async (laneId: string): Promise<StackChainItem[]> =>
      ipcRenderer.invoke(IPC.lanesGetStackChain, { laneId }),
    getChildren: async (laneId: string): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesGetChildren, { laneId }),
    rebaseStart: async (args: RebaseStartArgs): Promise<RebaseStartResult> =>
      ipcRenderer.invoke(IPC.lanesRebaseStart, args),
    rebasePush: async (args: RebasePushArgs): Promise<RebaseRun> =>
      ipcRenderer.invoke(IPC.lanesRebasePush, args),
    rebaseRollback: async (args: RebaseRollbackArgs): Promise<RebaseRun> =>
      ipcRenderer.invoke(IPC.lanesRebaseRollback, args),
    rebaseAbort: async (args: RebaseAbortArgs): Promise<RebaseRun> =>
      ipcRenderer.invoke(IPC.lanesRebaseAbort, args),
    rebaseSubscribe: (cb: (ev: RebaseRunEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RebaseRunEventPayload) => cb(payload);
      ipcRenderer.on(IPC.lanesRebaseEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesRebaseEvent, listener);
    },
    listRebaseSuggestions: async (): Promise<RebaseSuggestion[]> => ipcRenderer.invoke(IPC.lanesListRebaseSuggestions),
    dismissRebaseSuggestion: async (args: { laneId: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDismissRebaseSuggestion, args),
    deferRebaseSuggestion: async (args: { laneId: string; minutes: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDeferRebaseSuggestion, args),
    onRebaseSuggestionsEvent: (cb: (ev: RebaseSuggestionsEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RebaseSuggestionsEventPayload) => cb(payload);
      ipcRenderer.on(IPC.lanesRebaseSuggestionsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesRebaseSuggestionsEvent, listener);
    },
    listAutoRebaseStatuses: async (): Promise<AutoRebaseLaneStatus[]> => ipcRenderer.invoke(IPC.lanesListAutoRebaseStatuses),
    onAutoRebaseEvent: (cb: (ev: AutoRebaseEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AutoRebaseEventPayload) => cb(payload);
      ipcRenderer.on(IPC.lanesAutoRebaseEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesAutoRebaseEvent, listener);
    },
    openFolder: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.lanesOpenFolder, args),
    initEnv: async (args: InitLaneEnvArgs): Promise<LaneEnvInitProgress> =>
      ipcRenderer.invoke(IPC.lanesInitEnv, args),
    getEnvStatus: async (args: GetLaneEnvStatusArgs): Promise<LaneEnvInitProgress | null> =>
      ipcRenderer.invoke(IPC.lanesGetEnvStatus, args),
    getOverlay: async (args: GetLaneOverlayArgs): Promise<LaneOverlayOverrides> =>
      ipcRenderer.invoke(IPC.lanesGetOverlay, args),
    onEnvEvent: (cb: (ev: LaneEnvInitEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: LaneEnvInitEvent) => cb(payload);
      ipcRenderer.on(IPC.lanesEnvEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesEnvEvent, listener);
    },
    listTemplates: async (): Promise<LaneTemplate[]> =>
      ipcRenderer.invoke(IPC.lanesListTemplates),
    getTemplate: async (args: GetLaneTemplateArgs): Promise<LaneTemplate | null> =>
      ipcRenderer.invoke(IPC.lanesGetTemplate, args),
    getDefaultTemplate: async (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.lanesGetDefaultTemplate),
    setDefaultTemplate: async (args: SetDefaultLaneTemplateArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesSetDefaultTemplate, args),
    applyTemplate: async (args: ApplyLaneTemplateArgs): Promise<LaneEnvInitProgress> =>
      ipcRenderer.invoke(IPC.lanesApplyTemplate, args),
    portGetLease: async (args: GetPortLeaseArgs): Promise<PortLease | null> =>
      ipcRenderer.invoke(IPC.lanesPortGetLease, args),
    portListLeases: async (): Promise<PortLease[]> =>
      ipcRenderer.invoke(IPC.lanesPortListLeases),
    portAcquire: async (args: AcquirePortLeaseArgs): Promise<PortLease> =>
      ipcRenderer.invoke(IPC.lanesPortAcquire, args),
    portRelease: async (args: ReleasePortLeaseArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesPortRelease, args),
    portListConflicts: async (): Promise<PortConflict[]> =>
      ipcRenderer.invoke(IPC.lanesPortListConflicts),
    portRecoverOrphans: async (): Promise<PortLease[]> =>
      ipcRenderer.invoke(IPC.lanesPortRecoverOrphans),
    onPortEvent: (cb: (ev: PortAllocationEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PortAllocationEvent) => cb(payload);
      ipcRenderer.on(IPC.lanesPortEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesPortEvent, listener);
    },
  },
  sessions: {
    list: async (args: ListSessionsArgs = {}): Promise<TerminalSessionSummary[]> =>
      ipcRenderer.invoke(IPC.sessionsList, args),
    get: async (sessionId: string): Promise<TerminalSessionDetail | null> =>
      ipcRenderer.invoke(IPC.sessionsGet, { sessionId }),
    updateMeta: async (args: { sessionId: string; pinned?: boolean; title?: string; goal?: string | null; toolType?: string | null; resumeCommand?: string | null }): Promise<TerminalSessionSummary | null> =>
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
    updateSession: async (args: AgentChatUpdateSessionArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatUpdateSession, args),
    onEvent: (cb: (ev: AgentChatEventEnvelope) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentChatEventEnvelope) => cb(payload);
      ipcRenderer.on(IPC.agentChatEvent, listener);
      return () => ipcRenderer.removeListener(IPC.agentChatEvent, listener);
    },
    listContextPacks: async (args: import("../shared/types").ContextPackListArgs = {}): Promise<import("../shared/types").ContextPackOption[]> =>
      ipcRenderer.invoke(IPC.agentChatListContextPacks, args),
    fetchContextPack: async (args: import("../shared/types").ContextPackFetchArgs): Promise<import("../shared/types").ContextPackFetchResult> =>
      ipcRenderer.invoke(IPC.agentChatFetchContextPack, args),
    changePermissionMode: async (args: import("../shared/types").AgentChatChangePermissionModeArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatChangePermissionMode, args),
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
    generateDocs: async (args: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> =>
      ipcRenderer.invoke(IPC.contextGenerateDocs, args),
    openDoc: async (args: ContextOpenDocArgs): Promise<void> => ipcRenderer.invoke(IPC.contextOpenDoc, args)
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
    aiResolutionStart: (args: PrAiResolutionStartArgs): Promise<PrAiResolutionStartResult> =>
      ipcRenderer.invoke(IPC.prsAiResolutionStart, args),
    aiResolutionInput: (args: PrAiResolutionInputArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsAiResolutionInput, args),
    aiResolutionStop: (args: PrAiResolutionStopArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsAiResolutionStop, args),
    onAiResolutionEvent: (cb: (ev: PrAiResolutionEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PrAiResolutionEventPayload) => cb(payload);
      ipcRenderer.on(IPC.prsAiResolutionEvent, listener);
      return () => ipcRenderer.removeListener(IPC.prsAiResolutionEvent, listener);
    },
    onEvent: (cb: (ev: PrEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PrEventPayload) => cb(payload);
      ipcRenderer.on(IPC.prsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.prsEvent, listener);
    },
    getDetail: async (prId: string): Promise<PrDetail> => ipcRenderer.invoke(IPC.prsGetDetail, { prId }),
    getFiles: async (prId: string): Promise<PrFile[]> => ipcRenderer.invoke(IPC.prsGetFiles, { prId }),
    getActionRuns: async (prId: string): Promise<PrActionRun[]> => ipcRenderer.invoke(IPC.prsGetActionRuns, { prId }),
    getActivity: async (prId: string): Promise<PrActivityEvent[]> => ipcRenderer.invoke(IPC.prsGetActivity, { prId }),
    addComment: async (args: AddPrCommentArgs): Promise<PrComment> => ipcRenderer.invoke(IPC.prsAddComment, args),
    updateTitle: async (args: UpdatePrTitleArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateTitle, args),
    updateBody: async (args: UpdatePrBodyArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateBody, args),
    setLabels: async (args: SetPrLabelsArgs): Promise<void> => ipcRenderer.invoke(IPC.prsSetLabels, args),
    requestReviewers: async (args: RequestPrReviewersArgs): Promise<void> => ipcRenderer.invoke(IPC.prsRequestReviewers, args),
    submitReview: async (args: SubmitPrReviewArgs): Promise<void> => ipcRenderer.invoke(IPC.prsSubmitReview, args),
    close: async (args: ClosePrArgs): Promise<void> => ipcRenderer.invoke(IPC.prsClose, args),
    reopen: async (args: ReopenPrArgs): Promise<void> => ipcRenderer.invoke(IPC.prsReopen, args),
    rerunChecks: async (args: RerunPrChecksArgs): Promise<void> => ipcRenderer.invoke(IPC.prsRerunChecks, args),
    aiReviewSummary: async (args: AiReviewSummaryArgs): Promise<AiReviewSummary> => ipcRenderer.invoke(IPC.prsAiReviewSummary, args)
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
    add: async (args: {
      projectId?: string;
      scope?: "user" | "project" | "lane" | "mission" | "agent";
      scopeOwnerId?: string;
      category: "fact" | "preference" | "pattern" | "decision" | "gotcha";
      content: string;
      importance?: "low" | "medium" | "high";
      sourceRunId?: string;
    }): Promise<unknown> =>
      ipcRenderer.invoke(IPC.memoryAdd, args),
    pin: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryPin, args),
    updateCore: async (args: CtoUpdateCoreMemoryArgs): Promise<CtoSnapshot> =>
      ipcRenderer.invoke(IPC.memoryUpdateCore, args),
    getBudget: async (args: { projectId?: string; level?: string; scope?: "user" | "project" | "lane" | "mission" | "agent"; scopeOwnerId?: string } = {}): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memoryGetBudget, args),
    getCandidates: async (args: { projectId?: string; limit?: number } = {}): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memoryGetCandidates, args),
    promote: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryPromote, args),
    archive: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryArchive, args),
    search: async (args: {
      query: string;
      projectId?: string;
      scope?: "user" | "project" | "lane" | "mission" | "agent";
      scopeOwnerId?: string;
      limit?: number;
      status?: "promoted" | "candidate" | "archived" | "all";
    }): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memorySearch, args)
  },
  cto: {
    getState: async (args: CtoGetStateArgs = {}): Promise<CtoSnapshot> =>
      ipcRenderer.invoke(IPC.ctoGetState, args),
    ensureSession: async (args: CtoEnsureSessionArgs = {}): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.ctoEnsureSession, args),
    updateCoreMemory: async (args: CtoUpdateCoreMemoryArgs): Promise<CtoSnapshot> =>
      ipcRenderer.invoke(IPC.ctoUpdateCoreMemory, args),
    listSessionLogs: async (args: CtoListSessionLogsArgs = {}): Promise<CtoSessionLogEntry[]> =>
      ipcRenderer.invoke(IPC.ctoListSessionLogs, args),
    updateIdentity: async (args: { patch: Record<string, unknown> }): Promise<CtoSnapshot> =>
      ipcRenderer.invoke(IPC.ctoUpdateIdentity, args),
    listAgents: async (args: CtoListAgentsArgs = {}): Promise<AgentIdentity[]> =>
      ipcRenderer.invoke(IPC.ctoListAgents, args),
    saveAgent: async (args: CtoSaveAgentArgs): Promise<AgentIdentity> =>
      ipcRenderer.invoke(IPC.ctoSaveAgent, args),
    removeAgent: async (args: CtoRemoveAgentArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.ctoRemoveAgent, args),
    listAgentRevisions: async (args: CtoListAgentRevisionsArgs): Promise<AgentConfigRevision[]> =>
      ipcRenderer.invoke(IPC.ctoListAgentRevisions, args),
    rollbackAgentRevision: async (args: CtoRollbackAgentRevisionArgs): Promise<AgentIdentity> =>
      ipcRenderer.invoke(IPC.ctoRollbackAgentRevision, args),
    ensureAgentSession: async (args: CtoEnsureAgentSessionArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.ctoEnsureAgentSession, args),
    getBudgetSnapshot: async (args: CtoGetBudgetSnapshotArgs = {}): Promise<AgentBudgetSnapshot> =>
      ipcRenderer.invoke(IPC.ctoGetBudgetSnapshot, args),
    triggerAgentWakeup: async (args: CtoTriggerAgentWakeupArgs): Promise<CtoTriggerAgentWakeupResult> =>
      ipcRenderer.invoke(IPC.ctoTriggerAgentWakeup, args),
    listAgentRuns: async (args: CtoListAgentRunsArgs = {}): Promise<WorkerAgentRun[]> =>
      ipcRenderer.invoke(IPC.ctoListAgentRuns, args),
    getAgentCoreMemory: async (args: CtoGetAgentCoreMemoryArgs): Promise<AgentCoreMemory> =>
      ipcRenderer.invoke(IPC.ctoGetAgentCoreMemory, args),
    updateAgentCoreMemory: async (args: CtoUpdateAgentCoreMemoryArgs): Promise<AgentCoreMemory> =>
      ipcRenderer.invoke(IPC.ctoUpdateAgentCoreMemory, args),
    listAgentSessionLogs: async (args: CtoListAgentSessionLogsArgs): Promise<AgentSessionLogEntry[]> =>
      ipcRenderer.invoke(IPC.ctoListAgentSessionLogs, args),
    getLinearConnectionStatus: async (): Promise<LinearConnectionStatus> =>
      ipcRenderer.invoke(IPC.ctoGetLinearConnectionStatus),
    setLinearToken: async (args: CtoSetLinearTokenArgs): Promise<LinearConnectionStatus> =>
      ipcRenderer.invoke(IPC.ctoSetLinearToken, args),
    clearLinearToken: async (): Promise<LinearConnectionStatus> =>
      ipcRenderer.invoke(IPC.ctoClearLinearToken),
    getFlowPolicy: async (): Promise<LinearSyncConfig> =>
      ipcRenderer.invoke(IPC.ctoGetFlowPolicy),
    saveFlowPolicy: async (args: CtoSaveFlowPolicyArgs): Promise<LinearSyncConfig> =>
      ipcRenderer.invoke(IPC.ctoSaveFlowPolicy, args),
    listFlowPolicyRevisions: async (): Promise<CtoFlowPolicyRevision[]> =>
      ipcRenderer.invoke(IPC.ctoListFlowPolicyRevisions),
    rollbackFlowPolicyRevision: async (args: CtoRollbackFlowPolicyRevisionArgs): Promise<LinearSyncConfig> =>
      ipcRenderer.invoke(IPC.ctoRollbackFlowPolicyRevision, args),
    simulateFlowRoute: async (args: CtoSimulateFlowRouteArgs): Promise<LinearRouteDecision> =>
      ipcRenderer.invoke(IPC.ctoSimulateFlowRoute, args),
    getLinearSyncDashboard: async (): Promise<LinearSyncDashboard> =>
      ipcRenderer.invoke(IPC.ctoGetLinearSyncDashboard),
    runLinearSyncNow: async (): Promise<LinearSyncDashboard> =>
      ipcRenderer.invoke(IPC.ctoRunLinearSyncNow),
    listLinearSyncQueue: async (): Promise<LinearSyncQueueItem[]> =>
      ipcRenderer.invoke(IPC.ctoListLinearSyncQueue),
    resolveLinearSyncQueueItem: async (args: CtoResolveLinearSyncQueueItemArgs): Promise<LinearSyncQueueItem | null> =>
      ipcRenderer.invoke(IPC.ctoResolveLinearSyncQueueItem, args),
    listAgentTaskSessions: async (args: CtoListAgentTaskSessionsArgs): Promise<AgentTaskSession[]> =>
      ipcRenderer.invoke(IPC.ctoListAgentTaskSessions, args),
    clearAgentTaskSession: async (args: CtoClearAgentTaskSessionArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.ctoClearAgentTaskSession, args),
  }
});
