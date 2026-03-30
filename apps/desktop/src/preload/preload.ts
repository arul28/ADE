import { contextBridge, ipcRenderer, webFrame } from "electron";
import { IPC } from "../shared/ipc";
import type { AdeCleanupResult, AdeProjectEvent, AdeProjectSnapshot } from "../shared/types";
import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationDeleteRuleRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationManualTriggerRequest,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
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
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncStatusEventPayload,
  SyncTransferReadiness,
  DraftPrDescriptionArgs,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateIdentityArgs,
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
  CtoSetAgentStatusArgs,
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
  CtoOnboardingState,
  CtoSystemPromptPreview,
  CtoLinearProject,
  CtoStartLinearOAuthResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoRunProjectScanResult,
  CtoGetOpenclawStateResult,
  CtoUpdateOpenclawConfigArgs,
  CtoTestOpenclawConnectionArgs,
  CtoTestOpenclawConnectionResult,
  CtoListOpenclawMessagesArgs,
  CtoListOpenclawMessagesResult,
  CtoSendOpenclawMessageArgs,
  LinearConnectionStatus,
  CtoSetLinearOAuthClientArgs,
  LinearIngressEventRecord,
  LinearIngressStatus,
  CtoSetLinearTokenArgs,
  CtoSaveFlowPolicyArgs,
  CtoFlowPolicyRevision,
  CtoRollbackFlowPolicyRevisionArgs,
  CtoSimulateFlowRouteArgs,
  LinearRouteDecision,
  LinearWorkflowCatalog,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  LinearWorkflowRunDetail,
  LinearWorkflowEventPayload,
  CtoGetLinearWorkflowRunDetailArgs,
  CtoResolveLinearSyncQueueItemArgs,
  CtoEnsureLinearWebhookArgs,
  CtoListLinearIngressEventsArgs,
  LinearWorkflowConfig,
  OpenclawBridgeStatus,
  ExternalConnectionAuthRecord,
  ExternalConnectionAuthRecordInput,
  ExternalConnectionAuthStatus,
  ExternalConnectionOAuthSessionResult,
  ExternalConnectionOAuthSessionStartResult,
  ExternalMcpEventPayload,
  ExternalMcpManagedAuthConfig,
  ExternalMcpServerConfig,
  ExternalMcpServerSnapshot,
  ExternalMcpUsageEvent,
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  AutomationsEventPayload,
  ConflictExternalResolverRunSummary,
  ConflictProposal,
  ConflictProposalPreview,
  ContextDocPrefs,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextOpenDocArgs,
  ContextStatus,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  CreateLaneFromUnstagedArgs,
  DeleteLaneArgs,
  DevToolsCheckResult,
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
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
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
  DeleteIntegrationProposalArgs,
  DeleteIntegrationProposalResult,
  LinkPrToLaneArgs,
  PrEventPayload,
  PrCheck,
  PrComment,
  PrReview,
  PrReviewThread,
  PrReviewThreadComment,
  PrStatus,
  PrSummary,
  PrDetail,
  PrFile,
  PrActionRun,
  PrActivityEvent,
  AddPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
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
  AgentChatGetSummaryArgs,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatInterruptArgs,
  AgentChatListArgs,
  AgentChatModelInfo,
  AgentChatModelsArgs,
  AgentChatRespondToInputArgs,
  AgentChatResumeArgs,
  AgentChatSendArgs,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatSubagentSnapshot,
  AgentChatSubagentListArgs,
  AgentChatUpdateSessionArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
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
  AttachResolverSessionArgs,
  FinalizeResolverSessionArgs,
  CancelResolverSessionArgs,
  SuggestResolverTargetArgs,
  SuggestResolverTargetResult,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  SimulateIntegrationArgs,
  IntegrationProposal,
  IntegrationResolutionState,
  ListIntegrationWorkflowsArgs,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  DismissIntegrationCleanupArgs,
  CleanupIntegrationWorkflowArgs,
  CleanupIntegrationWorkflowResult,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  PrIssueResolutionStartArgs,
  PrIssueResolutionPromptPreviewArgs,
  PrIssueResolutionPromptPreviewResult,
  PrIssueResolutionStartResult,
  RebaseResolutionStartArgs,
  RebaseResolutionStartResult,
  PrAiResolutionGetSessionArgs,
  PrAiResolutionGetSessionResult,
  PrAiResolutionInputArgs,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
  CommitIntegrationArgs,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  ReorderQueuePrsArgs,
  ResumeQueueAutomationArgs,
  StartQueueAutomationArgs,
  QueueLandingState,
  GitHubPrSnapshot,
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
  SaveLaneTemplateArgs,
  DeleteLaneTemplateArgs,
  GetPortLeaseArgs,
  AcquirePortLeaseArgs,
  ReleasePortLeaseArgs,
  PortLease,
  PortConflict,
  PortAllocationEvent,
  ProxyStatus,
  ProxyRoute,
  LanePreviewInfo,
  LaneProxyEvent,
  AddProxyRouteArgs,
  RemoveProxyRouteArgs,
  GetPreviewInfoArgs,
  OpenPreviewArgs,
  StartProxyArgs,
  OAuthRedirectStatus,
  OAuthRedirectEvent,
  OAuthSession,
  RedirectUriInfo,
  UpdateOAuthRedirectConfigArgs,
  GenerateRedirectUrisArgs,
  EncodeOAuthStateArgs,
  DecodeOAuthStateArgs,
  DecodeOAuthStateResult,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
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
  GetFullMissionViewArgs,
  FullMissionViewResult,
  MissionPreflightRequest,
  MissionPreflightResult,
  GetMissionRunViewArgs,
  MissionRunView,
  ArchiveMissionArgs,
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
  ListOrchestratorArtifactsArgs,
  ListOrchestratorWorkerCheckpointsArgs,
  GetOrchestratorPromptInspectorArgs,
  GetPlanningPromptPreviewArgs,
  OrchestratorArtifact,
  OrchestratorWorkerCheckpoint,
  OrchestratorPromptInspector,
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
  ChangeDigest,
  KnowledgeSyncStatus,
  MemoryHealthStats,
  MemoryEntryDto,
  MemoryConsolidationResult,
  MemoryConsolidationStatusEventPayload,
  MemoryLifecycleSweepResult,
  MemorySweepStatusEventPayload,
  ProcedureDetail,
  ProcedureListItem,
  SkillIndexEntry,
  GetMissionBudgetTelemetryArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetTelemetrySnapshot,
  MissionBudgetSnapshot,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo,
  RuntimeDiagnosticsStatus,
  RuntimeDiagnosticsEvent,
  LaneHealthCheck,
  GetLaneHealthArgs,
  RunHealthCheckArgs,
  ActivateFallbackArgs,
  DeactivateFallbackArgs,
  ComputerUseArtifactListArgs,
  ComputerUseArtifactReviewArgs,
  ComputerUseArtifactRouteArgs,
  ComputerUseArtifactView,
  ComputerUseEventPayload,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
  ComputerUseSettingsSnapshot,
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
    chooseDirectory: async (args: { title?: string; defaultPath?: string } = {}): Promise<string | null> =>
      ipcRenderer.invoke(IPC.projectChooseDirectory, args),
    openAdeFolder: async (): Promise<void> => ipcRenderer.invoke(IPC.projectOpenAdeFolder),
    clearLocalData: async (args: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> =>
      ipcRenderer.invoke(IPC.projectClearLocalData, args),
    listRecent: async (): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectListRecent),
    closeCurrent: async (): Promise<void> => ipcRenderer.invoke(IPC.projectCloseCurrent),
    switchToPath: async (rootPath: string): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.projectSwitchToPath, { rootPath }),
    forgetRecent: async (rootPath: string): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectForgetRecent, { rootPath }),
    reorderRecent: async (orderedPaths: string[]): Promise<RecentProjectSummary[]> => ipcRenderer.invoke(IPC.projectReorderRecent, { orderedPaths }),
    getSnapshot: async (): Promise<AdeProjectSnapshot> => ipcRenderer.invoke(IPC.projectStateGetSnapshot),
    initializeOrRepair: async (): Promise<AdeCleanupResult> => ipcRenderer.invoke(IPC.projectStateInitializeOrRepair),
    runIntegrityCheck: async (): Promise<AdeCleanupResult> => ipcRenderer.invoke(IPC.projectStateRunIntegrityCheck),
    onMissing: (cb: (data: { rootPath: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { rootPath: string }) => cb(payload);
      ipcRenderer.on(IPC.projectMissing, listener);
      return () => ipcRenderer.removeListener(IPC.projectMissing, listener);
    },
    onStateEvent: (cb: (event: AdeProjectEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AdeProjectEvent) => cb(payload);
      ipcRenderer.on(IPC.projectStateEvent, listener);
      return () => ipcRenderer.removeListener(IPC.projectStateEvent, listener);
    }
  },
  keybindings: {
    get: async (): Promise<KeybindingsSnapshot> => ipcRenderer.invoke(IPC.keybindingsGet),
    set: async (overrides: KeybindingOverride[]): Promise<KeybindingsSnapshot> =>
      ipcRenderer.invoke(IPC.keybindingsSet, { overrides })
  },
  ai: {
    getStatus: async (args?: { force?: boolean }): Promise<AiSettingsStatus> => ipcRenderer.invoke(IPC.aiGetStatus, args),
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
  sync: {
    getStatus: async (): Promise<SyncRoleSnapshot> => ipcRenderer.invoke(IPC.syncGetStatus),
    listDevices: async (): Promise<SyncDeviceRuntimeState[]> => ipcRenderer.invoke(IPC.syncListDevices),
    updateLocalDevice: async (args: { name?: string; deviceType?: SyncPeerDeviceType }): Promise<SyncDeviceRecord> =>
      ipcRenderer.invoke(IPC.syncUpdateLocalDevice, args),
    connectToBrain: async (draft: SyncDesktopConnectionDraft): Promise<SyncRoleSnapshot> =>
      ipcRenderer.invoke(IPC.syncConnectToBrain, draft),
    disconnectFromBrain: async (): Promise<SyncRoleSnapshot> =>
      ipcRenderer.invoke(IPC.syncDisconnectFromBrain),
    forgetDevice: async (deviceId: string): Promise<SyncRoleSnapshot> =>
      ipcRenderer.invoke(IPC.syncForgetDevice, { deviceId }),
    getTransferReadiness: async (): Promise<SyncTransferReadiness> =>
      ipcRenderer.invoke(IPC.syncGetTransferReadiness),
    transferBrainToLocal: async (): Promise<SyncRoleSnapshot> =>
      ipcRenderer.invoke(IPC.syncTransferBrainToLocal),
    onEvent: (cb: (event: SyncStatusEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SyncStatusEventPayload) => cb(payload);
      ipcRenderer.on(IPC.syncEvent, listener);
      return () => ipcRenderer.removeListener(IPC.syncEvent, listener);
    },
  },
  externalMcp: {
    listServers: async (): Promise<ExternalMcpServerSnapshot[]> => ipcRenderer.invoke(IPC.externalMcpListServers),
    listConfigs: async (): Promise<ExternalMcpServerConfig[]> => ipcRenderer.invoke(IPC.externalMcpListConfigs),
    getUsageEvents: async (args: { limit?: number } = {}): Promise<ExternalMcpUsageEvent[]> =>
      ipcRenderer.invoke(IPC.externalMcpGetUsageEvents, args),
    listAuthRecords: async (): Promise<ExternalConnectionAuthRecord[]> =>
      ipcRenderer.invoke(IPC.externalMcpListAuthRecords),
    onEvent: (cb: (event: ExternalMcpEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ExternalMcpEventPayload) => cb(payload);
      ipcRenderer.on(IPC.externalMcpEvent, listener);
      return () => ipcRenderer.removeListener(IPC.externalMcpEvent, listener);
    },
    connectServer: async (serverName: string): Promise<ExternalMcpServerSnapshot> =>
      ipcRenderer.invoke(IPC.externalMcpConnectServer, { serverName }),
    disconnectServer: async (serverName: string): Promise<ExternalMcpServerSnapshot | null> =>
      ipcRenderer.invoke(IPC.externalMcpDisconnectServer, { serverName }),
    testServer: async (config: ExternalMcpServerConfig): Promise<ExternalMcpServerSnapshot> =>
      ipcRenderer.invoke(IPC.externalMcpTestServer, { config }),
    saveServer: async (config: ExternalMcpServerConfig): Promise<ExternalMcpServerConfig[]> =>
      ipcRenderer.invoke(IPC.externalMcpSaveServer, { config }),
    removeServer: async (serverName: string): Promise<ExternalMcpServerConfig[]> =>
      ipcRenderer.invoke(IPC.externalMcpRemoveServer, { serverName }),
    saveAuthRecord: async (record: ExternalConnectionAuthRecordInput): Promise<ExternalConnectionAuthRecord> =>
      ipcRenderer.invoke(IPC.externalMcpSaveAuthRecord, { record }),
    removeAuthRecord: async (authId: string): Promise<ExternalConnectionAuthRecord[]> =>
      ipcRenderer.invoke(IPC.externalMcpRemoveAuthRecord, { authId }),
    getAuthStatus: async (binding?: ExternalMcpManagedAuthConfig | null): Promise<ExternalConnectionAuthStatus> =>
      ipcRenderer.invoke(IPC.externalMcpGetAuthStatus, { binding: binding ?? null }),
    startOAuthSession: async (authId: string): Promise<ExternalConnectionOAuthSessionStartResult> =>
      ipcRenderer.invoke(IPC.externalMcpStartOAuthSession, { authId }),
    getOAuthSession: async (sessionId: string): Promise<ExternalConnectionOAuthSessionResult> =>
      ipcRenderer.invoke(IPC.externalMcpGetOAuthSession, { sessionId }),
  },
  agentTools: {
    detect: async (): Promise<AgentTool[]> => ipcRenderer.invoke(IPC.agentToolsDetect)
  },
  devTools: {
    detect: async (force?: boolean): Promise<DevToolsCheckResult> =>
      ipcRenderer.invoke(IPC.devToolsDetect, { force }),
  },
  onboarding: {
    getStatus: async (): Promise<OnboardingStatus> => ipcRenderer.invoke(IPC.onboardingGetStatus),
    detectDefaults: async (): Promise<OnboardingDetectionResult> => ipcRenderer.invoke(IPC.onboardingDetectDefaults),
    detectExistingLanes: async (): Promise<OnboardingExistingLaneCandidate[]> =>
      ipcRenderer.invoke(IPC.onboardingDetectExistingLanes),
    setDismissed: async (dismissed: boolean): Promise<OnboardingStatus> =>
      ipcRenderer.invoke(IPC.onboardingSetDismissed, { dismissed }),
    complete: async (): Promise<OnboardingStatus> => ipcRenderer.invoke(IPC.onboardingComplete)
  },
  automations: {
    list: async (): Promise<AutomationRuleSummary[]> => ipcRenderer.invoke(IPC.automationsList),
    toggle: async (args: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> =>
      ipcRenderer.invoke(IPC.automationsToggle, args),
    deleteRule: async (args: AutomationDeleteRuleRequest): Promise<AutomationRuleSummary[]> =>
      ipcRenderer.invoke(IPC.automationsDeleteRule, args),
    triggerManually: async (args: AutomationManualTriggerRequest): Promise<AutomationRun> =>
      ipcRenderer.invoke(IPC.automationsTriggerManually, args),
    getHistory: async (args: { id: string; limit?: number }): Promise<AutomationRun[]> =>
      ipcRenderer.invoke(IPC.automationsGetHistory, args),
    listRuns: async (args?: AutomationRunListArgs): Promise<AutomationRun[]> =>
      ipcRenderer.invoke(IPC.automationsListRuns, args ?? {}),
    getRunDetail: async (runId: string): Promise<AutomationRunDetail | null> =>
      ipcRenderer.invoke(IPC.automationsGetRunDetail, { runId }),
    getIngressStatus: async (): Promise<AutomationIngressStatus> =>
      ipcRenderer.invoke(IPC.automationsGetIngressStatus),
    listIngressEvents: async (args?: { limit?: number }): Promise<AutomationIngressEventRecord[]> =>
      ipcRenderer.invoke(IPC.automationsListIngressEvents, args ?? {}),
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
    saveBudgetConfig: async (config: BudgetCapConfig): Promise<BudgetCapConfig> =>
      ipcRenderer.invoke(IPC.usageSaveBudgetConfig, config),
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
    archive: async (args: ArchiveMissionArgs): Promise<void> => ipcRenderer.invoke(IPC.missionsArchive, args),
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
    getFullMissionView: async (args: GetFullMissionViewArgs): Promise<FullMissionViewResult> =>
      ipcRenderer.invoke(IPC.missionsGetFullMissionView, args),
    preflight: async (args: MissionPreflightRequest): Promise<MissionPreflightResult> =>
      ipcRenderer.invoke(IPC.missionsPreflight, args),
    getRunView: async (args: GetMissionRunViewArgs): Promise<MissionRunView | null> =>
      ipcRenderer.invoke(IPC.missionsGetRunView, args),
    subscribeRunView: (args: GetMissionRunViewArgs, cb: (view: MissionRunView | null) => void) => {
      let disposed = false;
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      const refresh = () => {
        if (disposed) return;
        void ipcRenderer.invoke(IPC.missionsGetRunView, args).then(
          (view: MissionRunView | null) => {
            if (!disposed) cb(view);
          },
          () => {}
        );
      };
      const scheduleRefresh = (delayMs = 160) => {
        if (disposed) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          refresh();
        }, delayMs);
      };
      const missionListener = (_event: Electron.IpcRendererEvent, payload: MissionsEventPayload) => {
        if (payload.missionId !== args.missionId) return;
        scheduleRefresh();
      };
      const runtimeListener = (_event: Electron.IpcRendererEvent, payload: OrchestratorRuntimeEvent) => {
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh();
      };
      const threadListener = (_event: Electron.IpcRendererEvent, payload: OrchestratorThreadEvent) => {
        if (payload.missionId !== args.missionId) return;
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh(120);
      };
      const dagListener = (_event: Electron.IpcRendererEvent, payload: DagMutationEvent) => {
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh(120);
      };
      ipcRenderer.on(IPC.missionsEvent, missionListener);
      ipcRenderer.on(IPC.orchestratorEvent, runtimeListener);
      ipcRenderer.on(IPC.orchestratorThreadEvent, threadListener);
      ipcRenderer.on(IPC.orchestratorDagMutation, dagListener);
      refresh();
      return () => {
        disposed = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        ipcRenderer.removeListener(IPC.missionsEvent, missionListener);
        ipcRenderer.removeListener(IPC.orchestratorEvent, runtimeListener);
        ipcRenderer.removeListener(IPC.orchestratorThreadEvent, threadListener);
        ipcRenderer.removeListener(IPC.orchestratorDagMutation, dagListener);
      };
    },
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
    listArtifacts: async (args: ListOrchestratorArtifactsArgs): Promise<OrchestratorArtifact[]> =>
      ipcRenderer.invoke(IPC.orchestratorListArtifacts, args),
    listWorkerCheckpoints: async (
      args: ListOrchestratorWorkerCheckpointsArgs
    ): Promise<OrchestratorWorkerCheckpoint[]> =>
      ipcRenderer.invoke(IPC.orchestratorListWorkerCheckpoints, args),
    getPromptInspector: async (
      args: GetOrchestratorPromptInspectorArgs
    ): Promise<OrchestratorPromptInspector | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetPromptInspector, args),
    getPlanningPromptPreview: async (
      args: GetPlanningPromptPreviewArgs
    ): Promise<OrchestratorPromptInspector | null> =>
      ipcRenderer.invoke(IPC.orchestratorGetPlanningPromptPreview, args),
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
    createFromUnstaged: async (args: CreateLaneFromUnstagedArgs): Promise<LaneSummary> =>
      ipcRenderer.invoke(IPC.lanesCreateFromUnstaged, args),
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
    saveTemplate: async (args: SaveLaneTemplateArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesSaveTemplate, args),
    deleteTemplate: async (args: DeleteLaneTemplateArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDeleteTemplate, args),
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
    proxyGetStatus: async (): Promise<ProxyStatus> =>
      ipcRenderer.invoke(IPC.lanesProxyGetStatus),
    proxyStart: async (args?: StartProxyArgs): Promise<ProxyStatus> =>
      ipcRenderer.invoke(IPC.lanesProxyStart, args),
    proxyStop: async (): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesProxyStop),
    proxyAddRoute: async (args: AddProxyRouteArgs): Promise<ProxyRoute> =>
      ipcRenderer.invoke(IPC.lanesProxyAddRoute, args),
    proxyRemoveRoute: async (args: RemoveProxyRouteArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesProxyRemoveRoute, args),
    proxyGetPreviewInfo: async (args: GetPreviewInfoArgs): Promise<LanePreviewInfo | null> =>
      ipcRenderer.invoke(IPC.lanesProxyGetPreviewInfo, args),
    proxyOpenPreview: async (args: OpenPreviewArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesProxyOpenPreview, args),
    onProxyEvent: (cb: (ev: LaneProxyEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: LaneProxyEvent) => cb(payload);
      ipcRenderer.on(IPC.lanesProxyEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesProxyEvent, listener);
    },
    oauthGetStatus: async (): Promise<OAuthRedirectStatus> =>
      ipcRenderer.invoke(IPC.lanesOAuthGetStatus),
    oauthUpdateConfig: async (args: UpdateOAuthRedirectConfigArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesOAuthUpdateConfig, args),
    oauthGenerateRedirectUris: async (args: GenerateRedirectUrisArgs): Promise<RedirectUriInfo[]> =>
      ipcRenderer.invoke(IPC.lanesOAuthGenerateRedirectUris, args),
    oauthEncodeState: async (args: EncodeOAuthStateArgs): Promise<string> =>
      ipcRenderer.invoke(IPC.lanesOAuthEncodeState, args),
    oauthDecodeState: async (args: DecodeOAuthStateArgs): Promise<DecodeOAuthStateResult> =>
      ipcRenderer.invoke(IPC.lanesOAuthDecodeState, args),
    oauthListSessions: async (): Promise<OAuthSession[]> =>
      ipcRenderer.invoke(IPC.lanesOAuthListSessions),
    onOAuthEvent: (cb: (ev: OAuthRedirectEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: OAuthRedirectEvent) => cb(payload);
      ipcRenderer.on(IPC.lanesOAuthEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesOAuthEvent, listener);
    },
    diagnosticsGetStatus: async (): Promise<RuntimeDiagnosticsStatus> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsGetStatus),
    diagnosticsGetLaneHealth: async (args: GetLaneHealthArgs): Promise<LaneHealthCheck | null> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsGetLaneHealth, args),
    diagnosticsRunHealthCheck: async (args: RunHealthCheckArgs): Promise<LaneHealthCheck> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsRunHealthCheck, args),
    diagnosticsRunFullCheck: async (): Promise<LaneHealthCheck[]> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsRunFullCheck),
    diagnosticsActivateFallback: async (args: ActivateFallbackArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsActivateFallback, args),
    diagnosticsDeactivateFallback: async (args: DeactivateFallbackArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesDiagnosticsDeactivateFallback, args),
    onDiagnosticsEvent: (cb: (ev: RuntimeDiagnosticsEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeDiagnosticsEvent) => cb(payload);
      ipcRenderer.on(IPC.lanesDiagnosticsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.lanesDiagnosticsEvent, listener);
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
    getSummary: async (args: AgentChatGetSummaryArgs): Promise<AgentChatSessionSummary | null> =>
      ipcRenderer.invoke(IPC.agentChatGetSummary, args),
    create: async (args: AgentChatCreateArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatCreate, args),
    handoff: async (args: AgentChatHandoffArgs): Promise<AgentChatHandoffResult> =>
      ipcRenderer.invoke(IPC.agentChatHandoff, args),
    send: async (args: AgentChatSendArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatSend, args),
    steer: async (args: AgentChatSteerArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatSteer, args),
    cancelSteer: async (args: AgentChatCancelSteerArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatCancelSteer, args),
    editSteer: async (args: AgentChatEditSteerArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatEditSteer, args),
    interrupt: async (args: AgentChatInterruptArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatInterrupt, args),
    resume: async (args: AgentChatResumeArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatResume, args),
    approve: async (args: AgentChatApproveArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatApprove, args),
    respondToInput: async (args: AgentChatRespondToInputArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatRespondToInput, args),
    models: async (args: AgentChatModelsArgs): Promise<AgentChatModelInfo[]> =>
      ipcRenderer.invoke(IPC.agentChatModels, args),
    dispose: async (args: AgentChatDisposeArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatDispose, args),
    updateSession: async (args: AgentChatUpdateSessionArgs): Promise<AgentChatSession> =>
      ipcRenderer.invoke(IPC.agentChatUpdateSession, args),
    warmupModel: async (args: { sessionId: string; modelId: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.agentChatWarmupModel, args),
    onEvent: (cb: (ev: AgentChatEventEnvelope) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentChatEventEnvelope) => cb(payload);
      ipcRenderer.on(IPC.agentChatEvent, listener);
      return () => ipcRenderer.removeListener(IPC.agentChatEvent, listener);
    },
    slashCommands: async (args: AgentChatSlashCommandsArgs): Promise<AgentChatSlashCommand[]> =>
      ipcRenderer.invoke(IPC.agentChatSlashCommands, args),
    fileSearch: async (args: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> =>
      ipcRenderer.invoke(IPC.agentChatFileSearch, args),
    listSubagents: async (args: AgentChatSubagentListArgs): Promise<AgentChatSubagentSnapshot[]> =>
      ipcRenderer.invoke(IPC.agentChatListSubagents, args),
    getSessionCapabilities: async (args: AgentChatSessionCapabilitiesArgs): Promise<AgentChatSessionCapabilities> =>
      ipcRenderer.invoke(IPC.agentChatGetSessionCapabilities, args),
    saveTempAttachment: async (args: { data: string; filename: string }): Promise<{ path: string }> =>
      ipcRenderer.invoke(IPC.agentChatSaveTempAttachment, args),
  },
  computerUse: {
    getSettings: async (): Promise<ComputerUseSettingsSnapshot> =>
      ipcRenderer.invoke(IPC.computerUseGetSettings),
    listArtifacts: async (args: ComputerUseArtifactListArgs = {}): Promise<ComputerUseArtifactView[]> =>
      ipcRenderer.invoke(IPC.computerUseListArtifacts, args),
    getOwnerSnapshot: async (args: ComputerUseOwnerSnapshotArgs): Promise<ComputerUseOwnerSnapshot> =>
      ipcRenderer.invoke(IPC.computerUseGetOwnerSnapshot, args),
    routeArtifact: async (args: ComputerUseArtifactRouteArgs): Promise<ComputerUseArtifactView> =>
      ipcRenderer.invoke(IPC.computerUseRouteArtifact, args),
    updateArtifactReview: async (args: ComputerUseArtifactReviewArgs): Promise<ComputerUseArtifactView> =>
      ipcRenderer.invoke(IPC.computerUseUpdateArtifactReview, args),
    onEvent: (cb: (ev: ComputerUseEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ComputerUseEventPayload) => cb(payload);
      ipcRenderer.on(IPC.computerUseEvent, listener);
      return () => ipcRenderer.removeListener(IPC.computerUseEvent, listener);
    },
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
    generateCommitMessage: async (args: GitGenerateCommitMessageArgs): Promise<GitGenerateCommitMessageResult> =>
      ipcRenderer.invoke(IPC.gitGenerateCommitMessage, args),
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
    stashClear: async (args: { laneId: string }): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashClear, args),
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
    attachResolverSession: (args: AttachResolverSessionArgs): Promise<ConflictExternalResolverRunSummary> =>
      ipcRenderer.invoke(IPC.conflictsAttachResolverSession, args),
    finalizeResolverSession: (args: FinalizeResolverSessionArgs): Promise<ConflictExternalResolverRunSummary> =>
      ipcRenderer.invoke(IPC.conflictsFinalizeResolverSession, args),
    cancelResolverSession: (args: CancelResolverSessionArgs): Promise<ConflictExternalResolverRunSummary> =>
      ipcRenderer.invoke(IPC.conflictsCancelResolverSession, args),
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
    openDoc: async (args: ContextOpenDocArgs): Promise<void> => ipcRenderer.invoke(IPC.contextOpenDoc, args),
    getPrefs: async (): Promise<ContextDocPrefs> => ipcRenderer.invoke(IPC.contextGetPrefs),
    savePrefs: async (prefs: ContextDocPrefs): Promise<ContextDocPrefs> =>
      ipcRenderer.invoke(IPC.contextSavePrefs, prefs),
    onStatusChanged: (cb: (status: ContextStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ContextStatus) => cb(payload);
      ipcRenderer.on(IPC.contextStatusChanged, listener);
      return () => ipcRenderer.removeListener(IPC.contextStatusChanged, listener);
    },
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
    refresh: async (args: { prId?: string; prIds?: string[] } = {}): Promise<PrSummary[]> => ipcRenderer.invoke(IPC.prsRefresh, args),
    getStatus: async (prId: string): Promise<PrStatus | null> => ipcRenderer.invoke(IPC.prsGetStatus, { prId }),
    getChecks: async (prId: string): Promise<PrCheck[]> => ipcRenderer.invoke(IPC.prsGetChecks, { prId }),
    getComments: async (prId: string): Promise<PrComment[]> => ipcRenderer.invoke(IPC.prsGetComments, { prId }),
    getReviews: async (prId: string): Promise<PrReview[]> => ipcRenderer.invoke(IPC.prsGetReviews, { prId }),
    getReviewThreads: async (prId: string): Promise<PrReviewThread[]> => ipcRenderer.invoke(IPC.prsGetReviewThreads, { prId }),
    updateDescription: async (args: UpdatePrDescriptionArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateDescription, args),
    delete: async (args: DeletePrArgs): Promise<DeletePrResult> => ipcRenderer.invoke(IPC.prsDelete, args),
    draftDescription: async (args: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> =>
      ipcRenderer.invoke(IPC.prsDraftDescription, args),
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
    deleteProposal: (args: DeleteIntegrationProposalArgs): Promise<DeleteIntegrationProposalResult> =>
      ipcRenderer.invoke(IPC.prsDeleteProposal, args),
    landStackEnhanced: (args: LandStackEnhancedArgs): Promise<LandResult[]> =>
      ipcRenderer.invoke(IPC.prsLandStackEnhanced, args),
    landQueueNext: (args: LandQueueNextArgs): Promise<LandResult> =>
      ipcRenderer.invoke(IPC.prsLandQueueNext, args),
    startQueueAutomation: (args: StartQueueAutomationArgs): Promise<QueueLandingState> =>
      ipcRenderer.invoke(IPC.prsStartQueueAutomation, args),
    pauseQueueAutomation: (queueId: string): Promise<QueueLandingState | null> =>
      ipcRenderer.invoke(IPC.prsPauseQueueAutomation, { queueId }),
    resumeQueueAutomation: (args: ResumeQueueAutomationArgs): Promise<QueueLandingState | null> =>
      ipcRenderer.invoke(IPC.prsResumeQueueAutomation, args),
    cancelQueueAutomation: (queueId: string): Promise<QueueLandingState | null> =>
      ipcRenderer.invoke(IPC.prsCancelQueueAutomation, { queueId }),
    reorderQueuePrs: (args: ReorderQueuePrsArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsReorderQueue, args),
    getHealth: (prId: string): Promise<PrHealth> =>
      ipcRenderer.invoke(IPC.prsGetHealth, { prId }),
    getQueueState: (groupId: string): Promise<QueueLandingState | null> =>
      ipcRenderer.invoke(IPC.prsGetQueueState, { groupId }),
    listQueueStates: (args?: { includeCompleted?: boolean; limit?: number }): Promise<QueueLandingState[]> =>
      ipcRenderer.invoke(IPC.prsListQueueStates, args ?? {}),
    getConflictAnalysis: (prId: string): Promise<PrConflictAnalysis> =>
      ipcRenderer.invoke(IPC.prsGetConflictAnalysis, { prId }),
    getMergeContext: (prId: string): Promise<PrMergeContext> =>
      ipcRenderer.invoke(IPC.prsGetMergeContext, { prId }),
    listWithConflicts: (): Promise<PrWithConflicts[]> =>
      ipcRenderer.invoke(IPC.prsListWithConflicts),
    getGitHubSnapshot: (args?: { force?: boolean }): Promise<GitHubPrSnapshot> =>
      ipcRenderer.invoke(IPC.prsGetGitHubSnapshot, args ?? {}),
    listIntegrationWorkflows: (args: ListIntegrationWorkflowsArgs = {}): Promise<IntegrationProposal[]> =>
      ipcRenderer.invoke(IPC.prsListIntegrationWorkflows, args),
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
    aiResolutionGetSession: (args: PrAiResolutionGetSessionArgs): Promise<PrAiResolutionGetSessionResult> =>
      ipcRenderer.invoke(IPC.prsAiResolutionGetSession, args),
    aiResolutionInput: (args: PrAiResolutionInputArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsAiResolutionInput, args),
    aiResolutionStop: (args: PrAiResolutionStopArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsAiResolutionStop, args),
    issueResolutionStart: (args: PrIssueResolutionStartArgs): Promise<PrIssueResolutionStartResult> =>
      ipcRenderer.invoke(IPC.prsIssueResolutionStart, args),
    issueResolutionPreviewPrompt: (args: PrIssueResolutionPromptPreviewArgs): Promise<PrIssueResolutionPromptPreviewResult> =>
      ipcRenderer.invoke(IPC.prsIssueResolutionPreviewPrompt, args),
    rebaseResolutionStart: (args: RebaseResolutionStartArgs): Promise<RebaseResolutionStartResult> =>
      ipcRenderer.invoke(IPC.prsRebaseResolutionStart, args),
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
    replyToReviewThread: async (args: ReplyToPrReviewThreadArgs): Promise<PrReviewThreadComment> =>
      ipcRenderer.invoke(IPC.prsReplyToReviewThread, args),
    resolveReviewThread: async (args: ResolvePrReviewThreadArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.prsResolveReviewThread, args),
    updateTitle: async (args: UpdatePrTitleArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateTitle, args),
    updateBody: async (args: UpdatePrBodyArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateBody, args),
    setLabels: async (args: SetPrLabelsArgs): Promise<void> => ipcRenderer.invoke(IPC.prsSetLabels, args),
    requestReviewers: async (args: RequestPrReviewersArgs): Promise<void> => ipcRenderer.invoke(IPC.prsRequestReviewers, args),
    submitReview: async (args: SubmitPrReviewArgs): Promise<void> => ipcRenderer.invoke(IPC.prsSubmitReview, args),
    close: async (args: ClosePrArgs): Promise<void> => ipcRenderer.invoke(IPC.prsClose, args),
    reopen: async (args: ReopenPrArgs): Promise<void> => ipcRenderer.invoke(IPC.prsReopen, args),
    rerunChecks: async (args: RerunPrChecksArgs): Promise<void> => ipcRenderer.invoke(IPC.prsRerunChecks, args),
    aiReviewSummary: async (args: AiReviewSummaryArgs): Promise<AiReviewSummary> => ipcRenderer.invoke(IPC.prsAiReviewSummary, args),
    dismissIntegrationCleanup: async (args: DismissIntegrationCleanupArgs): Promise<IntegrationProposal> =>
      ipcRenderer.invoke(IPC.prsDismissIntegrationCleanup, args),
    cleanupIntegrationWorkflow: async (args: CleanupIntegrationWorkflowArgs): Promise<CleanupIntegrationWorkflowResult> =>
      ipcRenderer.invoke(IPC.prsCleanupIntegrationWorkflow, args),
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
      category: "fact" | "preference" | "pattern" | "decision" | "gotcha" | "convention";
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
    promoteMissionEntry: async (args: { id: string; missionId: string }): Promise<MemoryEntryDto | null> =>
      ipcRenderer.invoke(IPC.memoryPromoteMissionEntry, args),
    archive: async (args: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.memoryArchive, args),
    search: async (args: {
      query: string;
      projectId?: string;
      scope?: "user" | "project" | "lane" | "mission" | "agent";
      scopeOwnerId?: string;
      limit?: number;
      mode?: "lexical" | "hybrid";
      status?: "promoted" | "candidate" | "archived" | "all";
    }): Promise<unknown[]> =>
      ipcRenderer.invoke(IPC.memorySearch, args),
    list: async (args: {
      scope?: "project" | "agent" | "mission";
      tier?: 1 | 2 | 3;
      status?: "promoted" | "candidate" | "archived" | "all";
      limit?: number;
    } = {}): Promise<MemoryEntryDto[]> =>
      ipcRenderer.invoke(IPC.memoryList, args),
    listMissionEntries: async (args: {
      missionId: string;
      runId?: string | null;
      status?: "promoted" | "candidate" | "archived" | "all";
    }): Promise<MemoryEntryDto[]> =>
      ipcRenderer.invoke(IPC.memoryListMissionEntries, args),
    listProcedures: async (args: {
      status?: "promoted" | "candidate" | "archived" | "all";
      scope?: "project" | "agent" | "mission";
      query?: string;
    } = {}): Promise<ProcedureListItem[]> =>
      ipcRenderer.invoke(IPC.memoryListProcedures, args),
    getProcedureDetail: async (args: { id: string }): Promise<ProcedureDetail | null> =>
      ipcRenderer.invoke(IPC.memoryGetProcedureDetail, args),
    exportProcedureSkill: async (args: { id: string; name?: string }): Promise<{ path: string; skill: SkillIndexEntry | null } | null> =>
      ipcRenderer.invoke(IPC.memoryExportProcedureSkill, args),
    listIndexedSkills: async (): Promise<SkillIndexEntry[]> =>
      ipcRenderer.invoke(IPC.memoryListIndexedSkills),
    reindexSkills: async (args: { paths?: string[] } = {}): Promise<SkillIndexEntry[]> =>
      ipcRenderer.invoke(IPC.memoryReindexSkills, args),
    syncKnowledge: async (): Promise<ChangeDigest | null> =>
      ipcRenderer.invoke(IPC.memorySyncKnowledge),
    getKnowledgeSyncStatus: async (): Promise<KnowledgeSyncStatus> =>
      ipcRenderer.invoke(IPC.memoryGetKnowledgeSyncStatus),
    getHealthStats: async (): Promise<MemoryHealthStats> =>
      ipcRenderer.invoke(IPC.memoryHealthStats),
    downloadEmbeddingModel: async (): Promise<MemoryHealthStats> =>
      ipcRenderer.invoke(IPC.memoryDownloadEmbeddingModel),
    runSweep: async (): Promise<MemoryLifecycleSweepResult> =>
      ipcRenderer.invoke(IPC.memoryRunSweep),
    onSweepStatus: (cb: (payload: MemorySweepStatusEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MemorySweepStatusEventPayload) => cb(payload);
      ipcRenderer.on(IPC.memorySweepStatus, listener);
      return () => ipcRenderer.removeListener(IPC.memorySweepStatus, listener);
    },
    runConsolidation: async (): Promise<MemoryConsolidationResult> =>
      ipcRenderer.invoke(IPC.memoryRunConsolidation),
    onConsolidationStatus: (cb: (payload: MemoryConsolidationStatusEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: MemoryConsolidationStatusEventPayload) => cb(payload);
      ipcRenderer.on(IPC.memoryConsolidationStatus, listener);
      return () => ipcRenderer.removeListener(IPC.memoryConsolidationStatus, listener);
    }
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
    updateIdentity: async (args: CtoUpdateIdentityArgs): Promise<CtoSnapshot> =>
      ipcRenderer.invoke(IPC.ctoUpdateIdentity, args),
    getOpenclawState: async (): Promise<CtoGetOpenclawStateResult> =>
      ipcRenderer.invoke(IPC.ctoGetOpenclawState),
    updateOpenclawConfig: async (args: CtoUpdateOpenclawConfigArgs): Promise<CtoGetOpenclawStateResult> =>
      ipcRenderer.invoke(IPC.ctoUpdateOpenclawConfig, args),
    testOpenclawConnection: async (args: CtoTestOpenclawConnectionArgs = {}): Promise<CtoTestOpenclawConnectionResult> =>
      ipcRenderer.invoke(IPC.ctoTestOpenclawConnection, args),
    listOpenclawMessages: async (args: CtoListOpenclawMessagesArgs = {}): Promise<CtoListOpenclawMessagesResult> =>
      ipcRenderer.invoke(IPC.ctoListOpenclawMessages, args),
    sendOpenclawMessage: async (args: CtoSendOpenclawMessageArgs): Promise<CtoListOpenclawMessagesResult[number]> =>
      ipcRenderer.invoke(IPC.ctoSendOpenclawMessage, args),
    onOpenclawConnectionStatus: (cb: (status: OpenclawBridgeStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: OpenclawBridgeStatus) => cb(payload);
      ipcRenderer.on(IPC.openclawConnectionStatus, listener);
      return () => ipcRenderer.removeListener(IPC.openclawConnectionStatus, listener);
    },
    listAgents: async (args: CtoListAgentsArgs = {}): Promise<AgentIdentity[]> =>
      ipcRenderer.invoke(IPC.ctoListAgents, args),
    saveAgent: async (args: CtoSaveAgentArgs): Promise<AgentIdentity> =>
      ipcRenderer.invoke(IPC.ctoSaveAgent, args),
    removeAgent: async (args: CtoRemoveAgentArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.ctoRemoveAgent, args),
    setAgentStatus: async (args: CtoSetAgentStatusArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.ctoSetAgentStatus, args),
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
    getFlowPolicy: async (): Promise<LinearWorkflowConfig> =>
      ipcRenderer.invoke(IPC.ctoGetFlowPolicy),
    saveFlowPolicy: async (args: CtoSaveFlowPolicyArgs): Promise<LinearWorkflowConfig> =>
      ipcRenderer.invoke(IPC.ctoSaveFlowPolicy, args),
    listFlowPolicyRevisions: async (): Promise<CtoFlowPolicyRevision[]> =>
      ipcRenderer.invoke(IPC.ctoListFlowPolicyRevisions),
    rollbackFlowPolicyRevision: async (args: CtoRollbackFlowPolicyRevisionArgs): Promise<LinearWorkflowConfig> =>
      ipcRenderer.invoke(IPC.ctoRollbackFlowPolicyRevision, args),
    simulateFlowRoute: async (args: CtoSimulateFlowRouteArgs): Promise<LinearRouteDecision> =>
      ipcRenderer.invoke(IPC.ctoSimulateFlowRoute, args),
    getLinearWorkflowCatalog: async (): Promise<LinearWorkflowCatalog> =>
      ipcRenderer.invoke(IPC.ctoGetLinearWorkflowCatalog),
    getLinearSyncDashboard: async (): Promise<LinearSyncDashboard> =>
      ipcRenderer.invoke(IPC.ctoGetLinearSyncDashboard),
    runLinearSyncNow: async (): Promise<LinearSyncDashboard> =>
      ipcRenderer.invoke(IPC.ctoRunLinearSyncNow),
    listLinearSyncQueue: async (): Promise<LinearSyncQueueItem[]> =>
      ipcRenderer.invoke(IPC.ctoListLinearSyncQueue),
    getLinearWorkflowRunDetail: async (args: CtoGetLinearWorkflowRunDetailArgs): Promise<LinearWorkflowRunDetail | null> =>
      ipcRenderer.invoke(IPC.ctoGetLinearWorkflowRunDetail, args),
    resolveLinearSyncQueueItem: async (args: CtoResolveLinearSyncQueueItemArgs): Promise<LinearSyncQueueItem | null> =>
      ipcRenderer.invoke(IPC.ctoResolveLinearSyncQueueItem, args),
    getLinearIngressStatus: async (): Promise<LinearIngressStatus> =>
      ipcRenderer.invoke(IPC.ctoGetLinearIngressStatus),
    listLinearIngressEvents: async (args: CtoListLinearIngressEventsArgs = {}): Promise<LinearIngressEventRecord[]> =>
      ipcRenderer.invoke(IPC.ctoListLinearIngressEvents, args),
    ensureLinearWebhook: async (args: CtoEnsureLinearWebhookArgs = {}): Promise<LinearIngressStatus> =>
      ipcRenderer.invoke(IPC.ctoEnsureLinearWebhook, args),
    onLinearWorkflowEvent: (cb: (event: LinearWorkflowEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: LinearWorkflowEventPayload) => cb(payload);
      ipcRenderer.on(IPC.ctoLinearWorkflowEvent, listener);
      return () => ipcRenderer.removeListener(IPC.ctoLinearWorkflowEvent, listener);
    },
    listAgentTaskSessions: async (args: CtoListAgentTaskSessionsArgs): Promise<AgentTaskSession[]> =>
      ipcRenderer.invoke(IPC.ctoListAgentTaskSessions, args),
    clearAgentTaskSession: async (args: CtoClearAgentTaskSessionArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.ctoClearAgentTaskSession, args),
    getOnboardingState: async (): Promise<CtoOnboardingState> =>
      ipcRenderer.invoke(IPC.ctoGetOnboardingState),
    completeOnboardingStep: async (args: { stepId: string }): Promise<CtoOnboardingState> =>
      ipcRenderer.invoke(IPC.ctoCompleteOnboardingStep, args),
    dismissOnboarding: async (): Promise<CtoOnboardingState> =>
      ipcRenderer.invoke(IPC.ctoDismissOnboarding),
    resetOnboarding: async (): Promise<CtoOnboardingState> =>
      ipcRenderer.invoke(IPC.ctoResetOnboarding),
    previewSystemPrompt: async (args: { identityOverride?: Record<string, unknown> } = {}): Promise<CtoSystemPromptPreview> =>
      ipcRenderer.invoke(IPC.ctoPreviewSystemPrompt, args),
    getLinearProjects: async (): Promise<CtoLinearProject[]> =>
      ipcRenderer.invoke(IPC.ctoGetLinearProjects),
    setLinearOAuthClient: async (args: CtoSetLinearOAuthClientArgs): Promise<LinearConnectionStatus> =>
      ipcRenderer.invoke(IPC.ctoSetLinearOAuthClient, args),
    clearLinearOAuthClient: async (): Promise<LinearConnectionStatus> =>
      ipcRenderer.invoke(IPC.ctoClearLinearOAuthClient),
    startLinearOAuth: async (): Promise<CtoStartLinearOAuthResult> =>
      ipcRenderer.invoke(IPC.ctoStartLinearOAuth),
    getLinearOAuthSession: async (args: CtoGetLinearOAuthSessionArgs): Promise<CtoGetLinearOAuthSessionResult> =>
      ipcRenderer.invoke(IPC.ctoGetLinearOAuthSession, args),
    runProjectScan: async (): Promise<CtoRunProjectScanResult> =>
      ipcRenderer.invoke(IPC.ctoRunProjectScan),
  },
  updateCheckForUpdates: () => ipcRenderer.invoke(IPC.updateCheckForUpdates),
  updateQuitAndInstall: () => ipcRenderer.invoke(IPC.updateQuitAndInstall),
  onUpdateEvent: (cb: (data: { type: string; version?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { type: string; version?: string }) => cb(payload);
    ipcRenderer.on(IPC.updateEvent, listener);
    return () => ipcRenderer.removeListener(IPC.updateEvent, listener);
  },
});
