import type {
  AdeCleanupResult,
  AdeProjectEvent,
  AdeProjectSnapshot,
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  ConflictProposal,
  ConflictExternalResolverRunSummary,
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
  DeleteMissionArgs,
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
  GetLaneConflictStatusArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentTool,
  NightShiftQueueMutationRequest,
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
  AutomationsEventPayload,
  AutomationManualTriggerRequest,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationQueueActionRequest,
  AutomationQueueItem,
  AutomationQueueListArgs,
  AutomationParseNaturalLanguageRequest,
  AutomationParseNaturalLanguageResult,
  AutomationValidateDraftRequest,
  AutomationValidateDraftResult,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
  AutomationSimulateRequest,
  AutomationSimulateResult,
  NightShiftBriefing,
  NightShiftState,
  UpdateNightShiftSettingsRequest,
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
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateCoreMemoryArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  CtoIdentity,
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
  AgentTaskSession,
  CtoListAgentTaskSessionsArgs,
  CtoClearAgentTaskSessionArgs,
  CtoGetBudgetSnapshotArgs,
  CtoTriggerAgentWakeupArgs,
  CtoTriggerAgentWakeupResult,
  CtoListAgentRunsArgs,
  CtoGetAgentCoreMemoryArgs,
  CtoUpdateAgentCoreMemoryArgs,
  CtoListAgentSessionLogsArgs,
  CtoUpdateIdentityArgs,
  CtoOnboardingState,
  CtoSystemPromptPreview,
  CtoLinearProject,
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
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  CiScanResult,
  CiImportRequest,
  CiImportResult,
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
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitUpstreamSyncStatus,
  GitSyncArgs,
  GitHubStatus,
  CreatePrFromLaneArgs,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
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
  PrAiResolutionGetSessionArgs,
  PrAiResolutionGetSessionResult,
  PrAiResolutionInputArgs,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
  CommitIntegrationArgs,
  LandQueueNextArgs,
  QueueLandingState,
  QueueRehearsalState,
  PrHealth,
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
  DeletePrArgs,
  DeletePrResult,
  LinkPrToLaneArgs,
  PrEventPayload,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  PrSummary,
  PrMergeContext,
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
  ListOverlapsArgs,
  LaneSummary,
  ListMissionsArgs,
  ImportBranchLaneArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  ListLanesArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  OperationRecord,
  PackExport,
  PackEvent,
  PackHeadVersion,
  PackSummary,
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
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RebaseSuggestion,
  RebaseSuggestionsEventPayload,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
  RiskMatrixEntry,
  RunTestSuiteArgs,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  RunExternalConflictResolverArgs,
  ListExternalConflictResolverRunsArgs,
  CommitExternalConflictResolverRunArgs,
  CommitExternalConflictResolverRunResult,
  RunConflictPredictionArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalProfilesSnapshot,
  TerminalSessionSummary,
  ResolveMissionInterventionArgs,
  MissionArtifact,
  MissionDetail,
  MissionIntervention,
  OrchestratorAttempt,
  OrchestratorGateReport,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorRuntimeEvent,
  OrchestratorThreadEvent,
  DagMutationEvent,
  OrchestratorStep,
  OrchestratorTimelineEvent,
  MissionStep,
  MissionSummary,
  PhaseCard,
  MissionsEventPayload,
  ListPhaseItemsArgs,
  SavePhaseItemArgs,
  DeletePhaseItemArgs,
  ImportPhaseItemsArgs,
  ExportPhaseItemsArgs,
  ExportPhaseItemsResult,
  PhaseProfile,
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
  GetMissionLogsArgs,
  GetMissionLogsResult,
  ExportMissionLogsArgs,
  ExportMissionLogsResult,
  GetOrchestratorGateReportArgs,
  GetOrchestratorRunGraphArgs,
  ListOrchestratorRunsArgs,
  ListOrchestratorTimelineArgs,
  CreateMissionArgs,
  ArchiveMissionArgs,
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
  UpdateLaneAppearanceArgs,
  UndoConflictProposalArgs,
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
  GetMissionMetricsArgs,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  OrchestratorContextCheckpoint,
  OrchestratorLaneDecision,
  OrchestratorWorkerDigest,
  SendOrchestratorChatArgs,
  GetOrchestratorChatArgs,
  ListOrchestratorChatThreadsArgs,
  GetOrchestratorThreadMessagesArgs,
  SendOrchestratorThreadMessageArgs,
  GetOrchestratorWorkerDigestArgs,
  ListOrchestratorWorkerDigestsArgs,
  GetOrchestratorContextCheckpointArgs,
  ListOrchestratorLaneDecisionsArgs,
  ListOrchestratorArtifactsArgs,
  ListOrchestratorWorkerCheckpointsArgs,
  MissionMetricsConfig,
  MissionMetricSample,
  SetMissionMetricsConfigArgs,
  ExecutionPlanPreview,
  GetMissionStateDocumentArgs,
  MissionStateDocument,
  OrchestratorArtifact,
  OrchestratorWorkerCheckpoint,
  GetOrchestratorPromptInspectorArgs,
  GetPlanningPromptPreviewArgs,
  OrchestratorPromptInspector,
  GetMissionBudgetTelemetryArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetTelemetrySnapshot,
  MissionBudgetSnapshot,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo,
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
  RuntimeDiagnosticsStatus,
  RuntimeDiagnosticsEvent,
  LaneHealthCheck,
  GetLaneHealthArgs,
  RunHealthCheckArgs,
  ActivateFallbackArgs,
  DeactivateFallbackArgs,
} from "../shared/types";

export {};

declare global {
  interface Window {
    ade: {
      app: {
        ping: () => Promise<"pong">;
        getInfo: () => Promise<AppInfo>;
        getProject: () => Promise<ProjectInfo | null>;
        openExternal: (url: string) => Promise<void>;
        revealPath: (path: string) => Promise<void>;
        writeClipboardText: (text: string) => Promise<void>;
        openPathInEditor: (args: {
          rootPath: string;
          relativePath?: string;
          target: "finder" | "vscode" | "cursor" | "zed";
        }) => Promise<void>;
      };
      project: {
        openRepo: () => Promise<ProjectInfo | null>;
        openAdeFolder: () => Promise<void>;
      clearLocalData: (args?: ClearLocalAdeDataArgs) => Promise<ClearLocalAdeDataResult>;
      listRecent: () => Promise<RecentProjectSummary[]>;
      closeCurrent: () => Promise<void>;
      switchToPath: (rootPath: string) => Promise<ProjectInfo>;
      forgetRecent: (rootPath: string) => Promise<RecentProjectSummary[]>;
      reorderRecent: (orderedPaths: string[]) => Promise<RecentProjectSummary[]>;
      getSnapshot: () => Promise<AdeProjectSnapshot>;
      initializeOrRepair: () => Promise<AdeCleanupResult>;
      runIntegrityCheck: () => Promise<AdeCleanupResult>;
      onMissing: (cb: (data: { rootPath: string }) => void) => () => void;
      onStateEvent: (cb: (event: AdeProjectEvent) => void) => () => void;
    };
      keybindings: {
        get: () => Promise<KeybindingsSnapshot>;
        set: (overrides: KeybindingOverride[]) => Promise<KeybindingsSnapshot>;
      };
      ai: {
        getStatus: () => Promise<AiSettingsStatus>;
        storeApiKey: (provider: string, key: string) => Promise<void>;
        deleteApiKey: (provider: string) => Promise<void>;
        listApiKeys: () => Promise<string[]>;
        verifyApiKey: (provider: string) => Promise<AiApiKeyVerificationResult>;
        updateConfig: (config: Partial<AiConfig>) => Promise<void>;
      };
      agentTools: {
        detect: () => Promise<AgentTool[]>;
      };
      terminalProfiles: {
        get: () => Promise<TerminalProfilesSnapshot>;
        set: (snapshot: TerminalProfilesSnapshot) => Promise<TerminalProfilesSnapshot>;
      };
      onboarding: {
        getStatus: () => Promise<OnboardingStatus>;
        detectDefaults: () => Promise<OnboardingDetectionResult>;
        detectExistingLanes: () => Promise<OnboardingExistingLaneCandidate[]>;
        complete: () => Promise<OnboardingStatus>;
      };
      ci: {
        scan: () => Promise<CiScanResult>;
        import: (req: CiImportRequest) => Promise<CiImportResult>;
      };
      automations: {
        list: () => Promise<AutomationRuleSummary[]>;
        toggle: (args: { id: string; enabled: boolean }) => Promise<AutomationRuleSummary[]>;
        triggerManually: (args: AutomationManualTriggerRequest) => Promise<AutomationRun>;
        getHistory: (args: { id: string; limit?: number }) => Promise<AutomationRun[]>;
        listRuns: (args?: AutomationRunListArgs) => Promise<AutomationRun[]>;
        getRunDetail: (runId: string) => Promise<AutomationRunDetail | null>;
        listQueueItems: (args?: AutomationQueueListArgs) => Promise<AutomationQueueItem[]>;
        updateQueueItem: (args: AutomationQueueActionRequest) => Promise<AutomationQueueItem | null>;
        getNightShiftState: () => Promise<NightShiftState>;
        updateNightShiftSettings: (args: UpdateNightShiftSettingsRequest) => Promise<NightShiftState>;
        mutateNightShiftQueue: (args: NightShiftQueueMutationRequest) => Promise<NightShiftState>;
        getMorningBriefing: () => Promise<NightShiftBriefing | null>;
        acknowledgeMorningBriefing: (args: { id: string }) => Promise<NightShiftBriefing | null>;
        getIngressStatus: () => Promise<AutomationIngressStatus>;
        listIngressEvents: (args?: { limit?: number }) => Promise<AutomationIngressEventRecord[]>;
        parseNaturalLanguage: (req: AutomationParseNaturalLanguageRequest) => Promise<AutomationParseNaturalLanguageResult>;
        validateDraft: (req: AutomationValidateDraftRequest) => Promise<AutomationValidateDraftResult>;
        saveDraft: (req: AutomationSaveDraftRequest) => Promise<AutomationSaveDraftResult>;
        simulate: (req: AutomationSimulateRequest) => Promise<AutomationSimulateResult>;
        onEvent: (cb: (ev: AutomationsEventPayload) => void) => () => void;
      };
      usage: {
        getSnapshot: () => Promise<UsageSnapshot | null>;
        refresh: () => Promise<UsageSnapshot | null>;
        checkBudget: (args: { scope: BudgetCapScope; scopeId?: string; provider: BudgetCapProvider }) => Promise<BudgetCheckResult>;
        getCumulativeUsage: (args: { scope: BudgetCapScope; scopeId?: string; provider?: BudgetCapProvider }) => Promise<{ totalTokens: number; totalCostUsd: number; weekKey: string }>;
        getBudgetConfig: () => Promise<BudgetCapConfig>;
        onUpdate: (cb: (snapshot: UsageSnapshot) => void) => () => void;
      };
      missions: {
        list: (args?: ListMissionsArgs) => Promise<MissionSummary[]>;
        get: (missionId: string) => Promise<MissionDetail | null>;
        create: (args: CreateMissionArgs) => Promise<MissionDetail>;
        update: (args: UpdateMissionArgs) => Promise<MissionDetail>;
        archive: (args: ArchiveMissionArgs) => Promise<void>;
        delete: (args: DeleteMissionArgs) => Promise<void>;
        updateStep: (args: UpdateMissionStepArgs) => Promise<MissionStep>;
        addArtifact: (args: AddMissionArtifactArgs) => Promise<MissionArtifact>;
        addIntervention: (args: AddMissionInterventionArgs) => Promise<MissionIntervention>;
        resolveIntervention: (args: ResolveMissionInterventionArgs) => Promise<MissionIntervention>;
        listPhaseItems: (args?: ListPhaseItemsArgs) => Promise<PhaseCard[]>;
        savePhaseItem: (args: SavePhaseItemArgs) => Promise<PhaseCard>;
        deletePhaseItem: (args: DeletePhaseItemArgs) => Promise<void>;
        importPhaseItems: (args: ImportPhaseItemsArgs) => Promise<PhaseCard[]>;
        exportPhaseItems: (args?: ExportPhaseItemsArgs) => Promise<ExportPhaseItemsResult>;
        listPhaseProfiles: (args?: ListPhaseProfilesArgs) => Promise<PhaseProfile[]>;
        savePhaseProfile: (args: SavePhaseProfileArgs) => Promise<PhaseProfile>;
        deletePhaseProfile: (args: DeletePhaseProfileArgs) => Promise<void>;
        clonePhaseProfile: (args: ClonePhaseProfileArgs) => Promise<PhaseProfile>;
        exportPhaseProfile: (args: ExportPhaseProfileArgs) => Promise<ExportPhaseProfileResult>;
        importPhaseProfile: (args: ImportPhaseProfileArgs) => Promise<PhaseProfile>;
        getPhaseConfiguration: (missionId: string) => Promise<MissionPhaseConfiguration | null>;
        getDashboard: () => Promise<MissionDashboardSnapshot>;
        getFullMissionView: (args: GetFullMissionViewArgs) => Promise<FullMissionViewResult>;
        preflight: (args: MissionPreflightRequest) => Promise<MissionPreflightResult>;
        getRunView: (args: GetMissionRunViewArgs) => Promise<MissionRunView | null>;
        subscribeRunView: (args: GetMissionRunViewArgs, cb: (view: MissionRunView | null) => void) => () => void;
        onEvent: (cb: (ev: MissionsEventPayload) => void) => () => void;
      };
      orchestrator: {
        listRuns: (args?: ListOrchestratorRunsArgs) => Promise<OrchestratorRun[]>;
        getRunGraph: (args: GetOrchestratorRunGraphArgs) => Promise<OrchestratorRunGraph>;
        startRun: (args: StartOrchestratorRunArgs) => Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }>;
        startRunFromMission: (
          args: StartOrchestratorRunFromMissionArgs
        ) => Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }>;
        startAttempt: (args: StartOrchestratorAttemptArgs) => Promise<OrchestratorAttempt>;
        completeAttempt: (args: CompleteOrchestratorAttemptArgs) => Promise<OrchestratorAttempt>;
        tickRun: (args: TickOrchestratorRunArgs) => Promise<OrchestratorRun>;
        pauseRun: (args: PauseOrchestratorRunArgs) => Promise<OrchestratorRun>;
        resumeRun: (args: ResumeOrchestratorRunArgs) => Promise<OrchestratorRun>;
        cancelRun: (args: CancelOrchestratorRunArgs) => Promise<OrchestratorRun>;
        cleanupTeamResources: (args: CleanupOrchestratorTeamResourcesArgs) => Promise<CleanupOrchestratorTeamResourcesResult>;
        heartbeatClaims: (args: HeartbeatOrchestratorClaimsArgs) => Promise<number>;
        listTimeline: (args: ListOrchestratorTimelineArgs) => Promise<OrchestratorTimelineEvent[]>;
        getMissionLogs: (args: GetMissionLogsArgs) => Promise<GetMissionLogsResult>;
        exportMissionLogs: (args: ExportMissionLogsArgs) => Promise<ExportMissionLogsResult>;
        getGateReport: (args?: GetOrchestratorGateReportArgs) => Promise<OrchestratorGateReport>;
        getWorkerStates: (args: GetOrchestratorWorkerStatesArgs) => Promise<OrchestratorWorkerState[]>;
        startMissionRun: (args: StartMissionRunWithAIArgs) => Promise<StartMissionRunWithAIResult>;
        steerMission: (args: SteerMissionArgs) => Promise<SteerMissionResult>;
        getModelCapabilities: () => Promise<GetModelCapabilitiesResult>;
        getTeamMembers: (args: GetTeamMembersArgs) => Promise<OrchestratorTeamMember[]>;
        getTeamRuntimeState: (args: GetTeamRuntimeStateArgs) => Promise<OrchestratorTeamRuntimeState | null>;
        finalizeRun: (args: FinalizeRunArgs) => Promise<FinalizeRunResult>;
        sendChat: (args: SendOrchestratorChatArgs) => Promise<OrchestratorChatMessage>;
        getChat: (args: GetOrchestratorChatArgs) => Promise<OrchestratorChatMessage[]>;
        listChatThreads: (args: ListOrchestratorChatThreadsArgs) => Promise<OrchestratorChatThread[]>;
        getThreadMessages: (args: GetOrchestratorThreadMessagesArgs) => Promise<OrchestratorChatMessage[]>;
        sendThreadMessage: (args: SendOrchestratorThreadMessageArgs) => Promise<OrchestratorChatMessage>;
        getWorkerDigest: (args: GetOrchestratorWorkerDigestArgs) => Promise<OrchestratorWorkerDigest | null>;
        listWorkerDigests: (args: ListOrchestratorWorkerDigestsArgs) => Promise<OrchestratorWorkerDigest[]>;
        getContextCheckpoint: (args: GetOrchestratorContextCheckpointArgs) => Promise<OrchestratorContextCheckpoint | null>;
        listLaneDecisions: (args: ListOrchestratorLaneDecisionsArgs) => Promise<OrchestratorLaneDecision[]>;
        listArtifacts: (args: ListOrchestratorArtifactsArgs) => Promise<OrchestratorArtifact[]>;
        listWorkerCheckpoints: (args: ListOrchestratorWorkerCheckpointsArgs) => Promise<OrchestratorWorkerCheckpoint[]>;
        getPromptInspector: (args: GetOrchestratorPromptInspectorArgs) => Promise<OrchestratorPromptInspector>;
        getPlanningPromptPreview: (args: GetPlanningPromptPreviewArgs) => Promise<OrchestratorPromptInspector>;
        getMissionMetrics: (args: GetMissionMetricsArgs) => Promise<{ config: MissionMetricsConfig | null; samples: MissionMetricSample[] }>;
        setMissionMetricsConfig: (args: SetMissionMetricsConfigArgs) => Promise<MissionMetricsConfig>;
        getExecutionPlanPreview: (args: { runId: string }) => Promise<ExecutionPlanPreview | null>;
        getMissionStateDocument: (args: GetMissionStateDocumentArgs) => Promise<MissionStateDocument | null>;
        getCheckpointStatus: (args: { runId: string }) => Promise<{ savedAt: string; turnCount: number; compactionCount: number } | null>;
        getMissionBudgetStatus: (args: GetMissionBudgetStatusArgs) => Promise<MissionBudgetSnapshot>;
        getMissionBudgetTelemetry: (args: GetMissionBudgetTelemetryArgs) => Promise<MissionBudgetTelemetrySnapshot>;
        sendAgentMessage: (args: SendAgentMessageArgs) => Promise<OrchestratorChatMessage>;
        getGlobalChat: (args: GetGlobalChatArgs) => Promise<OrchestratorChatMessage[]>;
        getActiveAgents: (args: GetActiveAgentsArgs) => Promise<ActiveAgentInfo[]>;
        getAggregatedUsage: (args: import("../shared/types").GetAggregatedUsageArgs) => Promise<import("../shared/types").AggregatedUsageStats>;
        onEvent: (cb: (ev: OrchestratorRuntimeEvent) => void) => () => void;
        onThreadEvent: (cb: (ev: OrchestratorThreadEvent) => void) => () => void;
        onDagMutation: (cb: (ev: DagMutationEvent) => void) => () => void;
      };
      lanes: {
        list: (args?: ListLanesArgs) => Promise<LaneSummary[]>;
        create: (args: CreateLaneArgs) => Promise<LaneSummary>;
        createChild: (args: CreateChildLaneArgs) => Promise<LaneSummary>;
        importBranch: (args: ImportBranchLaneArgs) => Promise<LaneSummary>;
        attach: (args: AttachLaneArgs) => Promise<LaneSummary>;
        adoptAttached: (args: AdoptAttachedLaneArgs) => Promise<LaneSummary>;
        rename: (args: RenameLaneArgs) => Promise<void>;
        reparent: (args: ReparentLaneArgs) => Promise<ReparentLaneResult>;
        updateAppearance: (args: UpdateLaneAppearanceArgs) => Promise<void>;
        archive: (args: ArchiveLaneArgs) => Promise<void>;
        delete: (args: DeleteLaneArgs) => Promise<void>;
        getStackChain: (laneId: string) => Promise<StackChainItem[]>;
        getChildren: (laneId: string) => Promise<LaneSummary[]>;
        rebaseStart: (args: RebaseStartArgs) => Promise<RebaseStartResult>;
        rebasePush: (args: RebasePushArgs) => Promise<RebaseRun>;
        rebaseRollback: (args: RebaseRollbackArgs) => Promise<RebaseRun>;
        rebaseAbort: (args: RebaseAbortArgs) => Promise<RebaseRun>;
        rebaseSubscribe: (cb: (ev: RebaseRunEventPayload) => void) => () => void;
        listRebaseSuggestions: () => Promise<RebaseSuggestion[]>;
        dismissRebaseSuggestion: (args: { laneId: string }) => Promise<void>;
        deferRebaseSuggestion: (args: { laneId: string; minutes: number }) => Promise<void>;
        onRebaseSuggestionsEvent: (cb: (ev: RebaseSuggestionsEventPayload) => void) => () => void;
        listAutoRebaseStatuses: () => Promise<AutoRebaseLaneStatus[]>;
        onAutoRebaseEvent: (cb: (ev: AutoRebaseEventPayload) => void) => () => void;
        openFolder: (args: { laneId: string }) => Promise<void>;
        initEnv: (args: InitLaneEnvArgs) => Promise<LaneEnvInitProgress>;
        getEnvStatus: (args: GetLaneEnvStatusArgs) => Promise<LaneEnvInitProgress | null>;
        getOverlay: (args: GetLaneOverlayArgs) => Promise<LaneOverlayOverrides>;
        onEnvEvent: (cb: (ev: LaneEnvInitEvent) => void) => () => void;
        listTemplates: () => Promise<LaneTemplate[]>;
        getTemplate: (args: GetLaneTemplateArgs) => Promise<LaneTemplate | null>;
        getDefaultTemplate: () => Promise<string | null>;
        setDefaultTemplate: (args: SetDefaultLaneTemplateArgs) => Promise<void>;
        applyTemplate: (args: ApplyLaneTemplateArgs) => Promise<LaneEnvInitProgress>;
        portGetLease: (args: GetPortLeaseArgs) => Promise<PortLease | null>;
        portListLeases: () => Promise<PortLease[]>;
        portAcquire: (args: AcquirePortLeaseArgs) => Promise<PortLease>;
        portRelease: (args: ReleasePortLeaseArgs) => Promise<void>;
        portListConflicts: () => Promise<PortConflict[]>;
        portRecoverOrphans: () => Promise<PortLease[]>;
        onPortEvent: (cb: (ev: PortAllocationEvent) => void) => () => void;
        proxyGetStatus: () => Promise<ProxyStatus>;
        proxyStart: (args?: StartProxyArgs) => Promise<ProxyStatus>;
        proxyStop: () => Promise<void>;
        proxyAddRoute: (args: AddProxyRouteArgs) => Promise<ProxyRoute>;
        proxyRemoveRoute: (args: RemoveProxyRouteArgs) => Promise<void>;
        proxyGetPreviewInfo: (args: GetPreviewInfoArgs) => Promise<LanePreviewInfo | null>;
        proxyOpenPreview: (args: OpenPreviewArgs) => Promise<void>;
        onProxyEvent: (cb: (ev: LaneProxyEvent) => void) => () => void;
        oauthGetStatus: () => Promise<OAuthRedirectStatus>;
        oauthUpdateConfig: (args: UpdateOAuthRedirectConfigArgs) => Promise<void>;
        oauthGenerateRedirectUris: (args: GenerateRedirectUrisArgs) => Promise<RedirectUriInfo[]>;
        oauthEncodeState: (args: EncodeOAuthStateArgs) => Promise<string>;
        oauthDecodeState: (args: DecodeOAuthStateArgs) => Promise<DecodeOAuthStateResult>;
        oauthListSessions: () => Promise<OAuthSession[]>;
        onOAuthEvent: (cb: (ev: OAuthRedirectEvent) => void) => () => void;
        diagnosticsGetStatus: () => Promise<RuntimeDiagnosticsStatus>;
        diagnosticsGetLaneHealth: (args: GetLaneHealthArgs) => Promise<LaneHealthCheck | null>;
        diagnosticsRunHealthCheck: (args: RunHealthCheckArgs) => Promise<LaneHealthCheck>;
        diagnosticsRunFullCheck: () => Promise<LaneHealthCheck[]>;
        diagnosticsActivateFallback: (args: ActivateFallbackArgs) => Promise<void>;
        diagnosticsDeactivateFallback: (args: DeactivateFallbackArgs) => Promise<void>;
        onDiagnosticsEvent: (cb: (ev: RuntimeDiagnosticsEvent) => void) => () => void;
      };
      sessions: {
        list: (args?: ListSessionsArgs) => Promise<TerminalSessionSummary[]>;
        get: (sessionId: string) => Promise<TerminalSessionDetail | null>;
        updateMeta: (args: { sessionId: string; pinned?: boolean; title?: string; goal?: string | null; toolType?: string | null; resumeCommand?: string | null }) => Promise<TerminalSessionSummary | null>;
        readTranscriptTail: (args: ReadTranscriptTailArgs) => Promise<string>;
        getDelta: (sessionId: string) => Promise<SessionDeltaSummary | null>;
      };
      agentChat: {
        list: (args?: AgentChatListArgs) => Promise<AgentChatSessionSummary[]>;
        create: (args: AgentChatCreateArgs) => Promise<AgentChatSession>;
        send: (args: AgentChatSendArgs) => Promise<void>;
        steer: (args: AgentChatSteerArgs) => Promise<void>;
        interrupt: (args: AgentChatInterruptArgs) => Promise<void>;
        resume: (args: AgentChatResumeArgs) => Promise<AgentChatSession>;
        approve: (args: AgentChatApproveArgs) => Promise<void>;
        models: (args: AgentChatModelsArgs) => Promise<AgentChatModelInfo[]>;
        dispose: (args: AgentChatDisposeArgs) => Promise<void>;
        updateSession: (args: AgentChatUpdateSessionArgs) => Promise<AgentChatSession>;
        onEvent: (cb: (ev: AgentChatEventEnvelope) => void) => () => void;
        listContextPacks: (args?: import("../shared/types").ContextPackListArgs) => Promise<import("../shared/types").ContextPackOption[]>;
        fetchContextPack: (args: import("../shared/types").ContextPackFetchArgs) => Promise<import("../shared/types").ContextPackFetchResult>;
        changePermissionMode: (args: import("../shared/types").AgentChatChangePermissionModeArgs) => Promise<void>;
      };
      pty: {
        create: (args: PtyCreateArgs) => Promise<PtyCreateResult>;
        write: (args: { ptyId: string; data: string }) => Promise<void>;
        resize: (args: { ptyId: string; cols: number; rows: number }) => Promise<void>;
        dispose: (args: { ptyId: string; sessionId?: string }) => Promise<void>;
        onData: (cb: (ev: PtyDataEvent) => void) => () => void;
        onExit: (cb: (ev: PtyExitEvent) => void) => () => void;
      };
      diff: {
        getChanges: (args: GetDiffChangesArgs) => Promise<DiffChanges>;
        getFile: (args: GetFileDiffArgs) => Promise<FileDiff>;
      };
      files: {
        writeTextAtomic: (args: WriteTextAtomicArgs) => Promise<void>;
        listWorkspaces: (args?: FilesListWorkspacesArgs) => Promise<FilesWorkspace[]>;
        listTree: (args: FilesListTreeArgs) => Promise<FileTreeNode[]>;
        readFile: (args: FilesReadFileArgs) => Promise<FileContent>;
        writeText: (args: FilesWriteTextArgs) => Promise<void>;
        createFile: (args: FilesCreateFileArgs) => Promise<void>;
        createDirectory: (args: FilesCreateDirectoryArgs) => Promise<void>;
        rename: (args: FilesRenameArgs) => Promise<void>;
        delete: (args: FilesDeleteArgs) => Promise<void>;
        watchChanges: (args: FilesWatchArgs) => Promise<void>;
        stopWatching: (args: FilesWatchArgs) => Promise<void>;
        quickOpen: (args: FilesQuickOpenArgs) => Promise<FilesQuickOpenItem[]>;
        searchText: (args: FilesSearchTextArgs) => Promise<FilesSearchTextMatch[]>;
        onChange: (cb: (ev: FileChangeEvent) => void) => () => void;
      };
      git: {
        stageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        stageAll: (args: GitBatchFileActionArgs) => Promise<GitActionResult>;
        unstageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        unstageAll: (args: GitBatchFileActionArgs) => Promise<GitActionResult>;
        discardFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        restoreStagedFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        commit: (args: GitCommitArgs) => Promise<GitActionResult>;
        generateCommitMessage: (args: GitGenerateCommitMessageArgs) => Promise<GitGenerateCommitMessageResult>;
        listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<GitCommitSummary[]>;
        listCommitFiles: (args: GitListCommitFilesArgs) => Promise<string[]>;
        getCommitMessage: (args: GitGetCommitMessageArgs) => Promise<string>;
        revertCommit: (args: GitRevertArgs) => Promise<GitActionResult>;
        cherryPickCommit: (args: GitCherryPickArgs) => Promise<GitActionResult>;
        stashPush: (args: GitStashPushArgs) => Promise<GitActionResult>;
        stashList: (args: { laneId: string }) => Promise<GitStashSummary[]>;
        stashApply: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashPop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashDrop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        fetch: (args: { laneId: string }) => Promise<GitActionResult>;
        pull: (args: { laneId: string }) => Promise<GitActionResult>;
        getSyncStatus: (args: { laneId: string }) => Promise<GitUpstreamSyncStatus>;
        sync: (args: GitSyncArgs) => Promise<GitActionResult>;
        push: (args: GitPushArgs) => Promise<GitActionResult>;
        getConflictState: (laneId: string) => Promise<GitConflictState>;
        rebaseContinue: (laneId: string) => Promise<GitActionResult>;
        rebaseAbort: (laneId: string) => Promise<GitActionResult>;
        mergeContinue: (laneId: string) => Promise<GitActionResult>;
        mergeAbort: (laneId: string) => Promise<GitActionResult>;
        listBranches: (args: import("../shared/types").GitListBranchesArgs) => Promise<import("../shared/types").GitBranchSummary[]>;
        checkoutBranch: (args: import("../shared/types").GitCheckoutBranchArgs) => Promise<GitActionResult>;
      };
      conflicts: {
        getLaneStatus: (args: GetLaneConflictStatusArgs) => Promise<ConflictStatus>;
        listOverlaps: (args: ListOverlapsArgs) => Promise<ConflictOverlap[]>;
        getRiskMatrix: () => Promise<RiskMatrixEntry[]>;
        simulateMerge: (args: MergeSimulationArgs) => Promise<MergeSimulationResult>;
        runPrediction: (args?: RunConflictPredictionArgs) => Promise<BatchAssessmentResult>;
        getBatchAssessment: () => Promise<BatchAssessmentResult>;
        listProposals: (laneId: string) => Promise<ConflictProposal[]>;
        prepareProposal: (args: PrepareConflictProposalArgs) => Promise<ConflictProposalPreview>;
        requestProposal: (args: RequestConflictProposalArgs) => Promise<ConflictProposal>;
        applyProposal: (args: ApplyConflictProposalArgs) => Promise<ConflictProposal>;
        undoProposal: (args: UndoConflictProposalArgs) => Promise<ConflictProposal>;
        runExternalResolver: (args: RunExternalConflictResolverArgs) => Promise<ConflictExternalResolverRunSummary>;
        listExternalResolverRuns: (args?: ListExternalConflictResolverRunsArgs) => Promise<ConflictExternalResolverRunSummary[]>;
        commitExternalResolverRun: (args: CommitExternalConflictResolverRunArgs) => Promise<CommitExternalConflictResolverRunResult>;
        prepareResolverSession: (args: import("../shared/types").PrepareResolverSessionArgs) => Promise<import("../shared/types").PrepareResolverSessionResult>;
        attachResolverSession: (args: import("../shared/types").AttachResolverSessionArgs) => Promise<import("../shared/types").ConflictExternalResolverRunSummary>;
        finalizeResolverSession: (args: import("../shared/types").FinalizeResolverSessionArgs) => Promise<import("../shared/types").ConflictExternalResolverRunSummary>;
        cancelResolverSession: (args: import("../shared/types").CancelResolverSessionArgs) => Promise<import("../shared/types").ConflictExternalResolverRunSummary>;
        suggestResolverTarget: (args: import("../shared/types").SuggestResolverTargetArgs) => Promise<import("../shared/types").SuggestResolverTargetResult>;
        onEvent: (cb: (ev: ConflictEventPayload) => void) => () => void;
      };
      context: {
        getStatus: () => Promise<ContextStatus>;
        generateDocs: (args: ContextGenerateDocsArgs) => Promise<ContextGenerateDocsResult>;
        openDoc: (args: ContextOpenDocArgs) => Promise<void>;
      };
      github: {
        getStatus: () => Promise<GitHubStatus>;
        setToken: (token: string) => Promise<GitHubStatus>;
        clearToken: () => Promise<GitHubStatus>;
      };
      prs: {
        createFromLane: (args: CreatePrFromLaneArgs) => Promise<PrSummary>;
        linkToLane: (args: LinkPrToLaneArgs) => Promise<PrSummary>;
        getForLane: (laneId: string) => Promise<PrSummary | null>;
        listAll: () => Promise<PrSummary[]>;
        refresh: (args?: { prId?: string }) => Promise<PrSummary[]>;
        getStatus: (prId: string) => Promise<PrStatus>;
        getChecks: (prId: string) => Promise<PrCheck[]>;
        getComments: (prId: string) => Promise<PrComment[]>;
        getReviews: (prId: string) => Promise<PrReview[]>;
        updateDescription: (args: UpdatePrDescriptionArgs) => Promise<void>;
        delete: (args: DeletePrArgs) => Promise<DeletePrResult>;
        draftDescription: (args: import("../shared/types").DraftPrDescriptionArgs) => Promise<{ title: string; body: string }>;
        land: (args: LandPrArgs) => Promise<LandResult>;
        landStack: (args: LandStackArgs) => Promise<LandResult[]>;
        openInGitHub: (prId: string) => Promise<void>;
        createQueue: (args: CreateQueuePrsArgs) => Promise<CreateQueuePrsResult>;
        createIntegration: (args: import("../shared/types").CreateIntegrationPrArgs) => Promise<import("../shared/types").CreateIntegrationPrResult>;
        simulateIntegration: (args: SimulateIntegrationArgs) => Promise<IntegrationProposal>;
        commitIntegration: (args: CommitIntegrationArgs) => Promise<import("../shared/types").CreateIntegrationPrResult>;
        listProposals(): Promise<IntegrationProposal[]>;
        updateProposal(args: UpdateIntegrationProposalArgs): Promise<void>;
        deleteProposal(args: import("../shared/types").DeleteIntegrationProposalArgs): Promise<import("../shared/types").DeleteIntegrationProposalResult>;
        createIntegrationLaneForProposal(args: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult>;
        startIntegrationResolution(args: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult>;
        recheckIntegrationStep(args: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult>;
        getIntegrationResolutionState(proposalId: string): Promise<IntegrationResolutionState | null>;
        aiResolutionStart(args: PrAiResolutionStartArgs): Promise<PrAiResolutionStartResult>;
        aiResolutionGetSession(args: PrAiResolutionGetSessionArgs): Promise<PrAiResolutionGetSessionResult>;
        aiResolutionInput(args: PrAiResolutionInputArgs): Promise<void>;
        aiResolutionStop(args: PrAiResolutionStopArgs): Promise<void>;
        onAiResolutionEvent: (cb: (ev: PrAiResolutionEventPayload) => void) => () => void;
        landStackEnhanced: (args: import("../shared/types").LandStackEnhancedArgs) => Promise<import("../shared/types").LandResult[]>;
        landQueueNext: (args: LandQueueNextArgs) => Promise<LandResult>;
        startQueueAutomation: (args: import("../shared/types").StartQueueAutomationArgs) => Promise<QueueLandingState>;
        pauseQueueAutomation: (queueId: string) => Promise<QueueLandingState | null>;
        resumeQueueAutomation: (args: import("../shared/types").ResumeQueueAutomationArgs) => Promise<QueueLandingState | null>;
        cancelQueueAutomation: (queueId: string) => Promise<QueueLandingState | null>;
        startQueueRehearsal: (args: import("../shared/types").StartQueueRehearsalArgs) => Promise<QueueRehearsalState>;
        cancelQueueRehearsal: (rehearsalId: string) => Promise<QueueRehearsalState | null>;
        getHealth: (prId: string) => Promise<PrHealth>;
        getQueueState: (groupId: string) => Promise<QueueLandingState | null>;
        listQueueStates: (args?: { includeCompleted?: boolean; limit?: number }) => Promise<QueueLandingState[]>;
        getQueueRehearsalState: (groupId: string) => Promise<QueueRehearsalState | null>;
        listQueueRehearsals: (args?: { includeCompleted?: boolean; limit?: number }) => Promise<QueueRehearsalState[]>;
        getConflictAnalysis: (prId: string) => Promise<import("../shared/types").PrConflictAnalysis>;
        getMergeContext: (prId: string) => Promise<PrMergeContext>;
        listWithConflicts: () => Promise<import("../shared/types").PrWithConflicts[]>;
        getGitHubSnapshot: () => Promise<import("../shared/types").GitHubPrSnapshot>;
        listIntegrationWorkflows: (args?: import("../shared/types").ListIntegrationWorkflowsArgs) => Promise<IntegrationProposal[]>;
        onEvent: (cb: (ev: PrEventPayload) => void) => () => void;
        getDetail: (prId: string) => Promise<PrDetail>;
        getFiles: (prId: string) => Promise<PrFile[]>;
        getActionRuns: (prId: string) => Promise<PrActionRun[]>;
        getActivity: (prId: string) => Promise<PrActivityEvent[]>;
        addComment: (args: AddPrCommentArgs) => Promise<PrComment>;
        updateTitle: (args: UpdatePrTitleArgs) => Promise<void>;
        updateBody: (args: UpdatePrBodyArgs) => Promise<void>;
        setLabels: (args: SetPrLabelsArgs) => Promise<void>;
        requestReviewers: (args: RequestPrReviewersArgs) => Promise<void>;
        submitReview: (args: SubmitPrReviewArgs) => Promise<void>;
        close: (args: ClosePrArgs) => Promise<void>;
        reopen: (args: ReopenPrArgs) => Promise<void>;
        rerunChecks: (args: RerunPrChecksArgs) => Promise<void>;
        aiReviewSummary: (args: AiReviewSummaryArgs) => Promise<AiReviewSummary>;
        dismissIntegrationCleanup: (args: import("../shared/types").DismissIntegrationCleanupArgs) => Promise<IntegrationProposal>;
        cleanupIntegrationWorkflow: (args: import("../shared/types").CleanupIntegrationWorkflowArgs) => Promise<import("../shared/types").CleanupIntegrationWorkflowResult>;
      };
      rebase: {
        scanNeeds: () => Promise<RebaseNeed[]>;
        getNeed: (laneId: string) => Promise<RebaseNeed | null>;
        dismiss: (laneId: string) => Promise<void>;
        defer: (laneId: string, until: string) => Promise<void>;
        execute: (args: RebaseLaneArgs) => Promise<RebaseResult>;
        onEvent: (cb: (ev: RebaseEventPayload) => void) => () => void;
      };
      history: {
        listOperations: (args?: ListOperationsArgs) => Promise<OperationRecord[]>;
        exportOperations: (args: ExportHistoryArgs) => Promise<ExportHistoryResult>;
      };
      layout: {
        get: (layoutId: string) => Promise<DockLayout | null>;
        set: (layoutId: string, layout: DockLayout) => Promise<void>;
      };
      tilingTree: {
        get: (layoutId: string) => Promise<unknown>;
        set: (layoutId: string, tree: unknown) => Promise<void>;
      };
      graphState: {
        get: (projectId: string) => Promise<GraphPersistedState | null>;
        set: (projectId: string, state: GraphPersistedState) => Promise<void>;
      };
      processes: {
        listDefinitions: () => Promise<ProcessDefinition[]>;
        listRuntime: (laneId: string) => Promise<ProcessRuntime[]>;
        start: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        stop: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        restart: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        kill: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        startStack: (args: ProcessStackArgs) => Promise<void>;
        stopStack: (args: ProcessStackArgs) => Promise<void>;
        restartStack: (args: ProcessStackArgs) => Promise<void>;
        startAll: (args: { laneId: string }) => Promise<void>;
        stopAll: (args: { laneId: string }) => Promise<void>;
        getLogTail: (args: GetProcessLogTailArgs) => Promise<string>;
        onEvent: (cb: (ev: ProcessEvent) => void) => () => void;
      };
      tests: {
        listSuites: () => Promise<TestSuiteDefinition[]>;
        run: (args: RunTestSuiteArgs) => Promise<TestRunSummary>;
        stop: (args: StopTestRunArgs) => Promise<void>;
        listRuns: (args?: ListTestRunsArgs) => Promise<TestRunSummary[]>;
        getLogTail: (args: GetTestLogTailArgs) => Promise<string>;
        onEvent: (cb: (ev: TestEvent) => void) => () => void;
      };
      projectConfig: {
        get: () => Promise<ProjectConfigSnapshot>;
        validate: (candidate: ProjectConfigCandidate) => Promise<ProjectConfigValidationResult>;
        save: (candidate: ProjectConfigCandidate) => Promise<ProjectConfigSnapshot>;
        diffAgainstDisk: () => Promise<ProjectConfigDiff>;
        confirmTrust: (arg?: { sharedHash?: string }) => Promise<ProjectConfigTrust>;
      };
      zoom: {
        getLevel: () => number;
        setLevel: (level: number) => void;
        getFactor: () => number;
      };
      memory?: {
        add: (args: {
          projectId?: string;
          scope?: "user" | "project" | "lane" | "mission" | "agent";
          scopeOwnerId?: string;
          category: "fact" | "preference" | "pattern" | "decision" | "gotcha";
          content: string;
          importance?: "low" | "medium" | "high";
          sourceRunId?: string;
        }) => Promise<unknown>;
        pin: (args: { id: string }) => Promise<void>;
        updateCore: (args: CtoUpdateCoreMemoryArgs) => Promise<CtoSnapshot>;
        getBudget: (args?: { projectId?: string; level?: string; scope?: "user" | "project" | "lane" | "mission" | "agent"; scopeOwnerId?: string }) => Promise<unknown[]>;
        getCandidates: (args?: { projectId?: string; limit?: number }) => Promise<unknown[]>;
        promote: (args: { id: string }) => Promise<void>;
        promoteMissionEntry: (args: { id: string; missionId: string }) => Promise<MemoryEntryDto | null>;
        archive: (args: { id: string }) => Promise<void>;
        search: (args: {
          query: string;
          projectId?: string;
          scope?: "user" | "project" | "lane" | "mission" | "agent";
          scopeOwnerId?: string;
          limit?: number;
          mode?: "lexical" | "hybrid";
          status?: "promoted" | "candidate" | "archived" | "all";
        }) => Promise<unknown[]>;
        listMissionEntries: (args: {
          missionId: string;
          runId?: string | null;
          status?: "promoted" | "candidate" | "archived" | "all";
        }) => Promise<MemoryEntryDto[]>;
        listProcedures: (args?: {
          status?: "promoted" | "candidate" | "archived" | "all";
          scope?: "project" | "agent" | "mission";
          query?: string;
        }) => Promise<ProcedureListItem[]>;
        getProcedureDetail: (args: { id: string }) => Promise<ProcedureDetail | null>;
        exportProcedureSkill: (args: { id: string; name?: string }) => Promise<{ path: string; skill: SkillIndexEntry | null } | null>;
        listIndexedSkills: () => Promise<SkillIndexEntry[]>;
        reindexSkills: (args?: { paths?: string[] }) => Promise<SkillIndexEntry[]>;
        syncKnowledge: () => Promise<ChangeDigest | null>;
        getKnowledgeSyncStatus: () => Promise<KnowledgeSyncStatus>;
        getHealthStats: () => Promise<MemoryHealthStats>;
        downloadEmbeddingModel: () => Promise<MemoryHealthStats>;
        runSweep: () => Promise<MemoryLifecycleSweepResult>;
        onSweepStatus: (cb: (payload: MemorySweepStatusEventPayload) => void) => () => void;
        runConsolidation: () => Promise<MemoryConsolidationResult>;
        onConsolidationStatus: (cb: (payload: MemoryConsolidationStatusEventPayload) => void) => () => void;
      };
      cto?: {
        getState: (args?: CtoGetStateArgs) => Promise<CtoSnapshot>;
        ensureSession: (args?: CtoEnsureSessionArgs) => Promise<AgentChatSession>;
        updateCoreMemory: (args: CtoUpdateCoreMemoryArgs) => Promise<CtoSnapshot>;
        listSessionLogs: (args?: CtoListSessionLogsArgs) => Promise<CtoSessionLogEntry[]>;
        updateIdentity: (args: { patch: Record<string, unknown> }) => Promise<CtoSnapshot>;
        listAgents: (args?: CtoListAgentsArgs) => Promise<AgentIdentity[]>;
        saveAgent: (args: CtoSaveAgentArgs) => Promise<AgentIdentity>;
        removeAgent: (args: CtoRemoveAgentArgs) => Promise<void>;
        setAgentStatus: (args: CtoSetAgentStatusArgs) => Promise<void>;
        listAgentRevisions: (args: CtoListAgentRevisionsArgs) => Promise<AgentConfigRevision[]>;
        rollbackAgentRevision: (args: CtoRollbackAgentRevisionArgs) => Promise<AgentIdentity>;
        ensureAgentSession: (args: CtoEnsureAgentSessionArgs) => Promise<AgentChatSession>;
        getBudgetSnapshot: (args?: CtoGetBudgetSnapshotArgs) => Promise<AgentBudgetSnapshot>;
        triggerAgentWakeup: (args: CtoTriggerAgentWakeupArgs) => Promise<CtoTriggerAgentWakeupResult>;
        listAgentRuns: (args?: CtoListAgentRunsArgs) => Promise<WorkerAgentRun[]>;
        getAgentCoreMemory: (args: CtoGetAgentCoreMemoryArgs) => Promise<AgentCoreMemory>;
        updateAgentCoreMemory: (args: CtoUpdateAgentCoreMemoryArgs) => Promise<AgentCoreMemory>;
        listAgentSessionLogs: (args: CtoListAgentSessionLogsArgs) => Promise<AgentSessionLogEntry[]>;
        getLinearConnectionStatus: () => Promise<LinearConnectionStatus>;
        setLinearToken: (args: CtoSetLinearTokenArgs) => Promise<LinearConnectionStatus>;
        clearLinearToken: () => Promise<LinearConnectionStatus>;
        getFlowPolicy: () => Promise<LinearSyncConfig>;
        saveFlowPolicy: (args: CtoSaveFlowPolicyArgs) => Promise<LinearSyncConfig>;
        listFlowPolicyRevisions: () => Promise<CtoFlowPolicyRevision[]>;
        rollbackFlowPolicyRevision: (args: CtoRollbackFlowPolicyRevisionArgs) => Promise<LinearSyncConfig>;
        simulateFlowRoute: (args: CtoSimulateFlowRouteArgs) => Promise<LinearRouteDecision>;
        getLinearSyncDashboard: () => Promise<LinearSyncDashboard>;
        runLinearSyncNow: () => Promise<LinearSyncDashboard>;
        listLinearSyncQueue: () => Promise<LinearSyncQueueItem[]>;
        resolveLinearSyncQueueItem: (args: CtoResolveLinearSyncQueueItemArgs) => Promise<LinearSyncQueueItem | null>;
        listAgentTaskSessions: (args: CtoListAgentTaskSessionsArgs) => Promise<AgentTaskSession[]>;
        clearAgentTaskSession: (args: CtoClearAgentTaskSessionArgs) => Promise<void>;
        getOnboardingState: () => Promise<CtoOnboardingState>;
        completeOnboardingStep: (args: { stepId: string }) => Promise<CtoOnboardingState>;
        dismissOnboarding: () => Promise<CtoOnboardingState>;
        resetOnboarding: () => Promise<CtoOnboardingState>;
        previewSystemPrompt: (args?: { identityOverride?: Record<string, unknown> }) => Promise<CtoSystemPromptPreview>;
        getLinearProjects: () => Promise<CtoLinearProject[]>;
      };
    };
  }
}
