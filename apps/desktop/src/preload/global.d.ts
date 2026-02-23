import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  ConflictProposal,
  ConflictExternalResolverRunSummary,
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
  AutomationsEventPayload,
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
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  CiScanResult,
  CiImportRequest,
  CiImportResult,
  ExportConfigBundleResult,
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitConflictState,
  GitGetCommitMessageArgs,
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
  CommitIntegrationArgs,
  LandQueueNextArgs,
  QueueLandingState,
  PrHealth,
  RebaseNeed,
  RebaseLaneArgs,
  RebaseResult,
  RebaseEventPayload,
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
  RestackArgs,
  RestackResult,
  RestackSuggestion,
  RestackSuggestionsEventPayload,
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
  OrchestratorStep,
  OrchestratorTimelineEvent,
  MissionStep,
  MissionSummary,
  MissionsEventPayload,
  MissionPlannerAttempt,
  MissionPlannerRun,
  PlanMissionArgs,
  PlanMissionResult,
  ListPlannerRunsArgs,
  GetPlannerAttemptArgs,
  GetOrchestratorGateReportArgs,
  GetOrchestratorRunGraphArgs,
  ListOrchestratorRunsArgs,
  ListOrchestratorTimelineArgs,
  CreateMissionArgs,
  CancelOrchestratorRunArgs,
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
  UpdateLaneAppearanceArgs,
  UndoConflictProposalArgs,
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
  MissionMetricsConfig,
  MissionMetricSample,
  SetMissionMetricsConfigArgs,
  ExecutionPlanPreview,
  SendAgentMessageArgs
} from "../shared/types";

export {};

declare global {
  interface Window {
    ade: {
      app: {
        ping: () => Promise<"pong">;
        getInfo: () => Promise<AppInfo>;
        getProject: () => Promise<ProjectInfo>;
        openExternal: (url: string) => Promise<void>;
        revealPath: (path: string) => Promise<void>;
      };
      project: {
        openRepo: () => Promise<ProjectInfo>;
        openAdeFolder: () => Promise<void>;
        clearLocalData: (args?: ClearLocalAdeDataArgs) => Promise<ClearLocalAdeDataResult>;
        exportConfig: () => Promise<ExportConfigBundleResult>;
        listRecent: () => Promise<RecentProjectSummary[]>;
        switchToPath: (rootPath: string) => Promise<ProjectInfo>;
        forgetRecent: (rootPath: string) => Promise<RecentProjectSummary[]>;
        onMissing: (cb: (data: { rootPath: string }) => void) => () => void;
      };
      keybindings: {
        get: () => Promise<KeybindingsSnapshot>;
        set: (overrides: KeybindingOverride[]) => Promise<KeybindingsSnapshot>;
      };
      ai: {
        getStatus: () => Promise<AiSettingsStatus>;
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
        generateInitialPacks: (args?: { laneIds?: string[] }) => Promise<void>;
        complete: () => Promise<OnboardingStatus>;
      };
      ci: {
        scan: () => Promise<CiScanResult>;
        import: (req: CiImportRequest) => Promise<CiImportResult>;
      };
      automations: {
        list: () => Promise<AutomationRuleSummary[]>;
        toggle: (args: { id: string; enabled: boolean }) => Promise<AutomationRuleSummary[]>;
        triggerManually: (args: { id: string; laneId?: string | null }) => Promise<AutomationRun>;
        getHistory: (args: { id: string; limit?: number }) => Promise<AutomationRun[]>;
        getRunDetail: (runId: string) => Promise<AutomationRunDetail | null>;
        parseNaturalLanguage: (req: AutomationParseNaturalLanguageRequest) => Promise<AutomationParseNaturalLanguageResult>;
        validateDraft: (req: AutomationValidateDraftRequest) => Promise<AutomationValidateDraftResult>;
        saveDraft: (req: AutomationSaveDraftRequest) => Promise<AutomationSaveDraftResult>;
        simulate: (req: AutomationSimulateRequest) => Promise<AutomationSimulateResult>;
        onEvent: (cb: (ev: AutomationsEventPayload) => void) => () => void;
      };
      missions: {
        list: (args?: ListMissionsArgs) => Promise<MissionSummary[]>;
        get: (missionId: string) => Promise<MissionDetail | null>;
        create: (args: CreateMissionArgs) => Promise<MissionDetail>;
        update: (args: UpdateMissionArgs) => Promise<MissionDetail>;
        delete: (args: DeleteMissionArgs) => Promise<void>;
        updateStep: (args: UpdateMissionStepArgs) => Promise<MissionStep>;
        addArtifact: (args: AddMissionArtifactArgs) => Promise<MissionArtifact>;
        addIntervention: (args: AddMissionInterventionArgs) => Promise<MissionIntervention>;
        resolveIntervention: (args: ResolveMissionInterventionArgs) => Promise<MissionIntervention>;
        onEvent: (cb: (ev: MissionsEventPayload) => void) => () => void;
      };
      planner: {
        planMission: (args: PlanMissionArgs) => Promise<PlanMissionResult>;
        getRuns: (args?: ListPlannerRunsArgs) => Promise<MissionPlannerRun[]>;
        getAttempt: (args: GetPlannerAttemptArgs) => Promise<MissionPlannerAttempt | null>;
      };
      orchestrator: {
        listRuns: (args?: ListOrchestratorRunsArgs) => Promise<OrchestratorRun[]>;
        getRunGraph: (args: GetOrchestratorRunGraphArgs) => Promise<OrchestratorRunGraph>;
        startRun: (args: StartOrchestratorRunArgs) => Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }>;
        startRunFromMission: (
          args: StartOrchestratorRunFromMissionArgs
        ) => Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }>;
        approveMissionPlan: (
          args: StartOrchestratorRunFromMissionArgs
        ) => Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }>;
        startAttempt: (args: StartOrchestratorAttemptArgs) => Promise<OrchestratorAttempt>;
        completeAttempt: (args: CompleteOrchestratorAttemptArgs) => Promise<OrchestratorAttempt>;
        tickRun: (args: TickOrchestratorRunArgs) => Promise<OrchestratorRun>;
        resumeRun: (args: ResumeOrchestratorRunArgs) => Promise<OrchestratorRun>;
        cancelRun: (args: CancelOrchestratorRunArgs) => Promise<OrchestratorRun>;
        heartbeatClaims: (args: HeartbeatOrchestratorClaimsArgs) => Promise<number>;
        listTimeline: (args: ListOrchestratorTimelineArgs) => Promise<OrchestratorTimelineEvent[]>;
        getGateReport: (args?: GetOrchestratorGateReportArgs) => Promise<OrchestratorGateReport>;
        getWorkerStates: (args: GetOrchestratorWorkerStatesArgs) => Promise<OrchestratorWorkerState[]>;
        startMissionRun: (args: StartMissionRunWithAIArgs) => Promise<StartMissionRunWithAIResult>;
        steerMission: (args: SteerMissionArgs) => Promise<SteerMissionResult>;
        getDepthConfig: (args: GetMissionDepthConfigArgs) => Promise<MissionDepthConfig>;
        getModelCapabilities: () => Promise<GetModelCapabilitiesResult>;
        sendChat: (args: SendOrchestratorChatArgs) => Promise<OrchestratorChatMessage>;
        getChat: (args: GetOrchestratorChatArgs) => Promise<OrchestratorChatMessage[]>;
        listChatThreads: (args: ListOrchestratorChatThreadsArgs) => Promise<OrchestratorChatThread[]>;
        getThreadMessages: (args: GetOrchestratorThreadMessagesArgs) => Promise<OrchestratorChatMessage[]>;
        sendThreadMessage: (args: SendOrchestratorThreadMessageArgs) => Promise<OrchestratorChatMessage>;
        getWorkerDigest: (args: GetOrchestratorWorkerDigestArgs) => Promise<OrchestratorWorkerDigest | null>;
        listWorkerDigests: (args: ListOrchestratorWorkerDigestsArgs) => Promise<OrchestratorWorkerDigest[]>;
        getContextCheckpoint: (args: GetOrchestratorContextCheckpointArgs) => Promise<OrchestratorContextCheckpoint | null>;
        listLaneDecisions: (args: ListOrchestratorLaneDecisionsArgs) => Promise<OrchestratorLaneDecision[]>;
        getMissionMetrics: (args: GetMissionMetricsArgs) => Promise<{ config: MissionMetricsConfig | null; samples: MissionMetricSample[] }>;
        setMissionMetricsConfig: (args: SetMissionMetricsConfigArgs) => Promise<MissionMetricsConfig>;
        getExecutionPlanPreview: (args: { runId: string }) => Promise<ExecutionPlanPreview | null>;
        sendAgentMessage: (args: SendAgentMessageArgs) => Promise<OrchestratorChatMessage>;
        getAggregatedUsage: (args: import("../shared/types").GetAggregatedUsageArgs) => Promise<import("../shared/types").AggregatedUsageStats>;
        onEvent: (cb: (ev: OrchestratorRuntimeEvent) => void) => () => void;
        onThreadEvent: (cb: (ev: OrchestratorThreadEvent) => void) => () => void;
      };
      lanes: {
        list: (args?: ListLanesArgs) => Promise<LaneSummary[]>;
        create: (args: CreateLaneArgs) => Promise<LaneSummary>;
        createChild: (args: CreateChildLaneArgs) => Promise<LaneSummary>;
        importBranch: (args: ImportBranchLaneArgs) => Promise<LaneSummary>;
        attach: (args: AttachLaneArgs) => Promise<LaneSummary>;
        rename: (args: RenameLaneArgs) => Promise<void>;
        reparent: (args: ReparentLaneArgs) => Promise<ReparentLaneResult>;
        updateAppearance: (args: UpdateLaneAppearanceArgs) => Promise<void>;
        archive: (args: ArchiveLaneArgs) => Promise<void>;
        delete: (args: DeleteLaneArgs) => Promise<void>;
        getStackChain: (laneId: string) => Promise<StackChainItem[]>;
        getChildren: (laneId: string) => Promise<LaneSummary[]>;
        restack: (args: RestackArgs) => Promise<RestackResult>;
        listRestackSuggestions: () => Promise<RestackSuggestion[]>;
        dismissRestackSuggestion: (args: { laneId: string }) => Promise<void>;
        deferRestackSuggestion: (args: { laneId: string; minutes: number }) => Promise<void>;
        onRestackSuggestionsEvent: (cb: (ev: RestackSuggestionsEventPayload) => void) => () => void;
        listAutoRebaseStatuses: () => Promise<AutoRebaseLaneStatus[]>;
        onAutoRebaseEvent: (cb: (ev: AutoRebaseEventPayload) => void) => () => void;
        openFolder: (args: { laneId: string }) => Promise<void>;
      };
      sessions: {
        list: (args?: ListSessionsArgs) => Promise<TerminalSessionSummary[]>;
        get: (sessionId: string) => Promise<TerminalSessionDetail | null>;
        updateMeta: (args: { sessionId: string; pinned?: boolean; goal?: string | null; toolType?: string | null; resumeCommand?: string | null }) => Promise<TerminalSessionSummary | null>;
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
        onEvent: (cb: (ev: AgentChatEventEnvelope) => void) => () => void;
        listContextPacks: (args?: import("../shared/types").ContextPackListArgs) => Promise<import("../shared/types").ContextPackOption[]>;
        fetchContextPack: (args: import("../shared/types").ContextPackFetchArgs) => Promise<import("../shared/types").ContextPackFetchResult>;
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
        finalizeResolverSession: (args: import("../shared/types").FinalizeResolverSessionArgs) => Promise<import("../shared/types").ConflictExternalResolverRunSummary>;
        suggestResolverTarget: (args: import("../shared/types").SuggestResolverTargetArgs) => Promise<import("../shared/types").SuggestResolverTargetResult>;
        onEvent: (cb: (ev: ConflictEventPayload) => void) => () => void;
      };
      context: {
        getStatus: () => Promise<ContextStatus>;
        getInventory: () => Promise<ContextInventorySnapshot>;
        generateDocs: (args: ContextGenerateDocsArgs) => Promise<ContextGenerateDocsResult>;
        prepareDocGeneration: (args: ContextPrepareDocGenArgs) => Promise<ContextPrepareDocGenResult>;
        installGeneratedDocs: (args: ContextInstallGeneratedDocsArgs) => Promise<ContextGenerateDocsResult>;
        openDoc: (args: ContextOpenDocArgs) => Promise<void>;
      };
      packs: {
        getProjectPack: () => Promise<PackSummary>;
        getLanePack: (laneId: string) => Promise<PackSummary>;
        getFeaturePack: (featureKey: string) => Promise<PackSummary>;
        getConflictPack: (args: { laneId: string; peerLaneId?: string | null }) => Promise<PackSummary>;
        getPlanPack: (laneId: string) => Promise<PackSummary>;
        getMissionPack: (args: GetMissionPackArgs) => Promise<PackSummary>;
        getProjectExport: (args: GetProjectExportArgs) => Promise<PackExport>;
        getLaneExport: (args: GetLaneExportArgs) => Promise<PackExport>;
        getConflictExport: (args: GetConflictExportArgs) => Promise<PackExport>;
        getFeatureExport: (args: GetFeatureExportArgs) => Promise<PackExport>;
        getPlanExport: (args: GetPlanExportArgs) => Promise<PackExport>;
        getMissionExport: (args: GetMissionExportArgs) => Promise<PackExport>;
        refreshLanePack: (laneId: string) => Promise<PackSummary>;
        refreshProjectPack: (args?: { laneId?: string | null }) => Promise<PackSummary>;
        refreshFeaturePack: (featureKey: string) => Promise<PackSummary>;
        refreshConflictPack: (args: { laneId: string; peerLaneId?: string | null }) => Promise<PackSummary>;
        savePlanPack: (args: { laneId: string; body: string }) => Promise<PackSummary>;
        refreshMissionPack: (args: RefreshMissionPackArgs) => Promise<PackSummary>;
        refreshPlanPack: (laneId: string) => Promise<PackSummary>;
        listVersions: (args: { packKey: string; limit?: number }) => Promise<PackVersionSummary[]>;
        getVersion: (versionId: string) => Promise<PackVersion>;
        diffVersions: (args: { fromId: string; toId: string }) => Promise<string>;
        updateNarrative: (args: { packKey: string; narrative: string }) => Promise<PackSummary>;
        listEvents: (args: { packKey: string; limit?: number }) => Promise<PackEvent[]>;
        listEventsSince: (args: ListPackEventsSinceArgs) => Promise<PackEvent[]>;
        listCheckpoints: (args?: { laneId?: string; limit?: number }) => Promise<Checkpoint[]>;
        getHeadVersion: (packKey: string) => Promise<PackHeadVersion>;
        getDeltaDigest: (args: import("../shared/types").PackDeltaDigestArgs) => Promise<import("../shared/types").PackDeltaDigestV1>;
        onEvent: (cb: (ev: PackEvent) => void) => () => void;
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
        draftDescription: (laneId: string, model?: string) => Promise<{ title: string; body: string }>;
        land: (args: LandPrArgs) => Promise<LandResult>;
        landStack: (args: LandStackArgs) => Promise<LandResult[]>;
        openInGitHub: (prId: string) => Promise<void>;
        createStacked: (args: import("../shared/types").CreateStackedPrsArgs) => Promise<import("../shared/types").CreateStackedPrsResult>;
        createQueue: (args: CreateQueuePrsArgs) => Promise<CreateQueuePrsResult>;
        createIntegration: (args: import("../shared/types").CreateIntegrationPrArgs) => Promise<import("../shared/types").CreateIntegrationPrResult>;
        simulateIntegration: (args: SimulateIntegrationArgs) => Promise<IntegrationProposal>;
        commitIntegration: (args: CommitIntegrationArgs) => Promise<import("../shared/types").CreateIntegrationPrResult>;
        landStackEnhanced: (args: import("../shared/types").LandStackEnhancedArgs) => Promise<import("../shared/types").LandResult[]>;
        landQueueNext: (args: LandQueueNextArgs) => Promise<LandResult>;
        getHealth: (prId: string) => Promise<PrHealth>;
        getQueueState: (groupId: string) => Promise<QueueLandingState | null>;
        getConflictAnalysis: (prId: string) => Promise<import("../shared/types").PrConflictAnalysis>;
        getMergeContext: (prId: string) => Promise<PrMergeContext>;
        listWithConflicts: () => Promise<import("../shared/types").PrWithConflicts[]>;
        onEvent: (cb: (ev: PrEventPayload) => void) => () => void;
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
    };
  }
}
