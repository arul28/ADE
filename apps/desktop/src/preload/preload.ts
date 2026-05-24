import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { IPC } from "../shared/ipc";
import type {
  AdeCleanupResult,
  AdeProjectEvent,
  AdeProjectSnapshot,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectIcon,
} from "../shared/types";
import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  UnregisteredLaneCandidate,
  AppInfo,
  AppNavigationRequest,
  AutoUpdateSnapshot,
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
  ReviewEventPayload,
  ReviewFeedbackRecord,
  ReviewLaunchContext,
  ReviewListRunsArgs,
  ReviewListSuppressionsArgs,
  ReviewQualityReport,
  ReviewRecordFeedbackArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewSuppression,
  ReviewStartRunArgs,
  AdeActionRegistryEntry,
  AdeCliInstallResult,
  AdeCliStatus,
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  CursorCloudAgentSummary,
  CursorCloudArtifactDownload,
  CursorCloudArtifactSummary,
  CursorCloudCreateRunRequest,
  CursorCloudCreateRunResult,
  CursorCloudFollowUpRequest,
  CursorCloudFollowUpResult,
  CursorCloudListAgentsResult,
  CursorCloudListRunsResult,
  CursorCloudRepository,
  CursorCloudOpenChatRequest,
  CursorCloudOpenChatResult,
  CursorCloudStreamRunRequest,
  CursorCloudStreamRunResult,
  OpenCodeRuntimeSnapshot,
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncStatusEventPayload,
  SyncTransferReadiness,
  ApnsBridgeStatus,
  ApnsBridgeSaveConfigArgs,
  ApnsBridgeUploadKeyArgs,
  ApnsBridgeSendTestPushArgs,
  ApnsBridgeSendTestPushResult,
  DraftPrDescriptionArgs,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateIdentityArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  AgentIdentity,
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
  CtoListAgentSessionLogsArgs,
  CtoOnboardingState,
  CtoSystemPromptPreview,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoGetLinearIssuePickerDataResult,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  CtoStartLinearOAuthResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoRunProjectScanResult,
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
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  AutomationsEventPayload,
  ConflictExternalResolverRunSummary,
  ConflictProposal,
  ConflictProposalPreview,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  CreateLaneFromUnstagedArgs,
  LaneBranchSwitchArgs,
  LaneBranchSwitchPreview,
  LaneBranchSwitchResult,
  DeleteLaneArgs,
  DevToolsCheckResult,
  DiffChanges,
  DockLayout,
  GraphPersistedState,
  FileChangeEvent,
  FileContent,
  FileDiff,
  FilePatch,
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
  GitCreateTagArgs,
  GitConflictState,
  GitGetCommitMessageArgs,
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitBatchFileActionArgs,
  BranchPullRequest,
  GitBranchSummary,
  GitListBranchesArgs,
  GitGetUserIdentityArgs,
  GitUserIdentity,
  GitCheckoutBranchArgs,
  GitHeadChangeActionArgs,
  GitPullArgs,
  GitPushArgs,
  GitResetCommitArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitUpstreamSyncStatus,
  GitSyncArgs,
  GitHubAutolink,
  GitHubRepoRef,
  GitHubStatus,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
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
  PrCommit,
  PrActionRun,
  PrActivityEvent,
  CleanupPrBranchArgs,
  CleanupPrBranchResult,
  AddPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
  PrDeployment,
  PrAiSummary,
  PostPrReviewCommentArgs,
  SetPrReviewThreadResolvedArgs,
  SetPrReviewThreadResolvedResult,
  ReactToPrCommentArgs,
  LaunchPrIssueResolutionFromThreadArgs,
  LaunchPrIssueResolutionFromThreadResult,
  UpdatePrTitleArgs,
  UpdatePrBodyArgs,
  SetPrLabelsArgs,
  RequestPrReviewersArgs,
  SubmitPrReviewArgs,
  SubmitPrReviewResult,
  ClosePrArgs,
  ReopenPrArgs,
  RerunPrChecksArgs,
  AiReviewSummaryArgs,
  AiReviewSummary,
  IssueInventoryItem,
  IssueInventorySnapshot,
  PrConvergenceState,
  PrConvergenceStatePatch,
  PrAgentPermissionMode,
  PathToMergeStartResult,
  PathToMergeStopResult,
  ConvergenceStatus,
  PipelineSettings,
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  LandStackArgs,
  LandResult,
  GetDiffChangesArgs,
  GetLaneConflictStatusArgs,
  GetFileDiffArgs,
  GetFilePatchArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentTool,
  AgentChatApproveArgs,
  AgentChatArchiveArgs,
  AgentChatCreateArgs,
  AgentChatCodexOpenInCliArgs,
  AgentChatCodexOpenInCliResult,
  AgentChatDeleteArgs,
  AgentChatSuggestLaneNameArgs,
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatGetSummaryArgs,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatInterruptArgs,
  AgentChatListArgs,
  AgentChatModelCatalog,
  AgentChatModelCatalogArgs,
  AgentChatModelInfo,
  AgentChatModelsArgs,
  AgentChatParallelLaunchState,
  AgentChatParallelLaunchStateArgs,
  AgentChatRespondToInputArgs,
  AgentChatSendArgs,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatClaudeOutputStyle,
  AgentChatClaudeOutputStylesArgs,
  AgentChatSetClaudeOutputStyleArgs,
  AgentChatClaudePlugin,
  AgentChatClaudePluginsArgs,
  AgentChatReloadClaudePluginsArgs,
  AgentChatReloadClaudePluginsResult,
  AgentChatClaudeSessionInfo,
  AgentChatClaudeSessionInfoArgs,
  AgentChatClaudeSessionListArgs,
  AgentChatClaudeSessionMessage,
  AgentChatClaudeSessionMessagesArgs,
  AgentChatSubagentTranscriptArgs,
  AgentChatSubagentTranscriptMessage,
  AgentChatContextUsage,
  AgentChatContextUsageArgs,
  AgentChatRewindFilesArgs,
  AgentChatRewindFilesResult,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSessionSummary,
  AgentChatSteerArgs,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatDispatchSteerArgs,
  AgentChatDispatchSteerResult,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatCancelDispatchedSteerResult,
  AgentChatTurnFileDiff,
  AgentChatSubagentSnapshot,
  AgentChatSubagentListArgs,
  AgentChatUpdateSessionArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  OnboardingTourProgress,
  OnboardingTourVariant,
  LaneListSnapshot,
  LaneSummary,
  ListOverlapsArgs,
  ListLanesArgs,
  ListMissionsArgs,
  ImportBranchLaneArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  DeleteSessionArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  OperationRecord,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessGroupArgs,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  OpenProjectBinding,
  CreateProjectInput,
  CreateProjectResult,
  CloneProjectInput,
  CloneProjectResult,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  PublishProjectInput,
  PublishProjectResult,
  RecentProjectSummary,
  PtyCreateArgs,
  PtyCreateResult,
  PtySendToSessionArgs,
  PtySendToSessionResult,
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
  PrSnapshotHydration,
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
  LaneDeleteEvent,
  LaneDeleteProgress,
  LaneDeleteRisk,
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
  TerminalSessionChangedEvent,
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
  UpdateSessionMetaArgs,
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
  UsageThresholdEvent,
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
  IosSimulatorDevice,
  IosSimulatorDragArgs,
  IosSimulatorEventPayload,
  IosSimulatorListPreviewsArgs,
  IosSimulatorOpenPreviewWorkspaceArgs,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderPreviewArgs,
  IosSimulatorRenderPreviewResult,
  IosScreenSnapshot,
  IosScreenSnapshotArgs,
  IosInspectorSnapshot,
  IosSimulatorInspectPointArgs,
  IosSimulatorInspectResult,
  IosSimulatorLaunchArgs,
  IosSimulatorLaunchTarget,
  IosSimulatorListLaunchTargetsArgs,
  IosSimulatorScreenshot,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
  IosSimulatorStartStreamArgs,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
  IosSimulatorWindowState,
  IosSimulatorWindowSource,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlEventPayload,
  AppControlInspectPointArgs,
  AppControlInspectResult,
  AppControlLaunchArgs,
  AppControlScreenshot,
  AppControlSelectResult,
  AppControlSession,
  AppControlSnapshot,
  AppControlSnapshotArgs,
  AppControlStatus,
  AppControlStopArgs,
  AppControlTarget,
  AppControlTypeTextArgs,
  BuiltInBrowserAttachWebviewArgs,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserSelectResult,
  BuiltInBrowserStatus,
  BuiltInBrowserTabArgs,
  MacosVmAgentGuide,
  MacosVmAgentGuideArgs,
  MacosVmCaptureScreenshotArgs,
  MacosVmCaptureScreenshotResult,
  MacosVmClickArgs,
  MacosVmDeleteArgs,
  MacosVmDetachLaneArgs,
  MacosVmDetachLaneResult,
  MacosVmDisplaySession,
  MacosVmDisplaySessionArgs,
  MacosVmEventPayload,
  MacosVmFocusWindowArgs,
  MacosVmGetCredentialsArgs,
  MacosVmInstallRuntimeArgs,
  MacosVmProvisionArgs,
  MacosVmRecord,
  MacosVmRestartArgs,
  MacosVmRuntimeInstallStatus,
  MacosVmSelectPointArgs,
  MacosVmSelectPointResult,
  MacosVmSetCredentialsArgs,
  MacosVmStartArgs,
  MacosVmStatus,
  MacosVmStatusArgs,
  MacosVmStopArgs,
  MacosVmStorageInfo,
  MacosVmStoredCredentialsSummary,
  MacosVmTypeTextArgs,
  MacosVmWindowTarget,
  MacosVmWipeArgs,
  MacosVmWipeResult,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeEventNotificationPayload,
  RemoteRuntimeLocalWorkCheckResult,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  ChatTerminalActiveForChatArgs,
  ChatTerminalListArgs,
  ChatTerminalPreviewArgs,
  ChatTerminalPreviewResult,
  ChatTerminalReadArgs,
  ChatTerminalReadResult,
  ChatTerminalReattachArgs,
  ChatTerminalReattachResult,
  ChatTerminalSession,
  ChatTerminalSignalArgs,
  ChatTerminalWriteArgs,
  FeedbackPrepareDraftArgs,
  FeedbackPreparedDraft,
  FeedbackSubmission,
  FeedbackSubmissionEvent,
  FeedbackSubmitDraftArgs,
} from "../shared/types";

type ShortIpcCache<T> = {
  clear: () => void;
  get: (opts?: { force?: boolean }) => Promise<T>;
};

function createShortIpcCache<T>(
  loader: () => Promise<T>,
  ttlMs: number,
): ShortIpcCache<T> {
  let value: T | undefined;
  let promise: Promise<T> | null = null;
  let expiresAt = 0;

  return {
    clear: () => {
      value = undefined;
      promise = null;
      expiresAt = 0;
    },
    get: async (opts?: { force?: boolean }) => {
      const now = Date.now();
      if (!opts?.force) {
        if (value !== undefined && expiresAt > now) return value;
        if (promise) return promise;
      }

      const req = loader()
        .then((next) => {
          if (promise === req) {
            value = next;
            expiresAt = Date.now() + ttlMs;
          }
          return next;
        })
        .finally(() => {
          if (promise === req) promise = null;
        });
      promise = req;
      return req;
    },
  };
}

// Soft cap to keep keyed caches from growing unboundedly across long desktop
// sessions when callers use high-cardinality keys (image paths, session ids,
// diff arg blobs, etc.). Map iteration order is insertion order, so deleting
// the first key approximates LRU when combined with the touch-on-access below.
const KEYED_IPC_CACHE_MAX_ENTRIES = 256;

function createKeyedShortIpcCache<T>(
  loader: (key: string) => Promise<T>,
  ttlMs: number,
  options: { maxEntries?: number } = {},
): {
  clear: (key?: string) => void;
  get: (key: string, opts?: { force?: boolean }) => Promise<T>;
} {
  const maxEntries = options.maxEntries ?? KEYED_IPC_CACHE_MAX_ENTRIES;
  const caches = new Map<string, ShortIpcCache<T>>();
  const touch = (key: string, cache: ShortIpcCache<T>) => {
    // Move to most-recently-used position by re-inserting.
    caches.delete(key);
    caches.set(key, cache);
  };
  const evictIfNeeded = () => {
    while (caches.size > maxEntries) {
      const oldestKey = caches.keys().next().value;
      if (oldestKey === undefined) break;
      caches.delete(oldestKey);
    }
  };
  const getCache = (key: string): ShortIpcCache<T> => {
    const existing = caches.get(key);
    if (existing) {
      touch(key, existing);
      return existing;
    }
    const cache = createShortIpcCache(() => loader(key), ttlMs);
    caches.set(key, cache);
    evictIfNeeded();
    return cache;
  };

  return {
    clear: (key?: string) => {
      if (key == null) {
        caches.clear();
        return;
      }
      caches.delete(key);
    },
    get: (key: string, opts?: { force?: boolean }) => getCache(key).get(opts),
  };
}

function serializeIpcCacheArgs(value: unknown): string {
  return JSON.stringify(value ?? {}) ?? "{}";
}

function parseIpcCacheArgs<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(key) as T;
  } catch {
    return fallback;
  }
}

const projectConfigSnapshotCache = createShortIpcCache<ProjectConfigSnapshot>(
  () => ipcRenderer.invoke(IPC.projectConfigGet),
  1_000,
);

const aiStatusCache = (() => {
  let value: AiSettingsStatus | undefined;
  let promise: Promise<AiSettingsStatus> | null = null;
  let expiresAt = 0;
  let includesOpenCodeInventory = false;
  let promiseIncludesOpenCodeInventory = false;

  const clear = () => {
    value = undefined;
    promise = null;
    expiresAt = 0;
    includesOpenCodeInventory = false;
    promiseIncludesOpenCodeInventory = false;
  };

  const get = async (key: string): Promise<AiSettingsStatus> => {
    const args = parseIpcCacheArgs<{ refreshOpenCodeInventory?: boolean }>(
      key,
      {},
    );
    const wantsOpenCodeInventory = args.refreshOpenCodeInventory === true;
    const now = Date.now();
    if (
      value !== undefined &&
      expiresAt > now &&
      (!wantsOpenCodeInventory || includesOpenCodeInventory)
    ) {
      return value;
    }
    if (
      promise &&
      (!wantsOpenCodeInventory || promiseIncludesOpenCodeInventory)
    ) {
      return promise;
    }

    promiseIncludesOpenCodeInventory = wantsOpenCodeInventory;
    const request = callProjectRuntimeActionOr(
      "ai",
      "getStatus",
      {
        args: {
          refreshOpenCodeInventory: wantsOpenCodeInventory,
        },
      },
      () =>
        ipcRenderer.invoke(IPC.aiGetStatus, {
          refreshOpenCodeInventory: wantsOpenCodeInventory,
        }),
    )
      .then((status: AiSettingsStatus) => {
        if (promise === request) {
          value = status;
          expiresAt = Date.now() + 10_000;
          includesOpenCodeInventory = wantsOpenCodeInventory;
        }
        return status;
      })
      .finally(() => {
        if (promise === request) {
          promise = null;
          promiseIncludesOpenCodeInventory = false;
        }
      });
    promise = request;
    return request;
  };

  return { clear, get };
})();

const githubStatusCache = createShortIpcCache<GitHubStatus>(
  () => ipcRenderer.invoke(IPC.githubGetStatus, {}),
  30_000,
);
const githubRemoteStatusCache = createShortIpcCache<{
  repo: GitHubRepoRef | null;
  hasOrigin: boolean;
}>(() => ipcRenderer.invoke(IPC.githubGetRemoteStatus), 30_000);

const lanesListCache = createKeyedShortIpcCache<LaneSummary[]>(
  (key) =>
    ipcRenderer.invoke(
      IPC.lanesList,
      parseIpcCacheArgs<ListLanesArgs>(key, {}),
    ),
  2_000,
);

const lanesListSnapshotsCache = createKeyedShortIpcCache<LaneListSnapshot[]>(
  (key) =>
    ipcRenderer.invoke(
      IPC.lanesListSnapshots,
      parseIpcCacheArgs<ListLanesArgs>(key, {}),
    ),
  2_000,
);

const sessionDeltaCache = createKeyedShortIpcCache<SessionDeltaSummary | null>(
  (sessionId) =>
    callProjectRuntimeActionOr(
      "session",
      "getDelta",
      { args: { sessionId } },
      () => ipcRenderer.invoke(IPC.sessionsGetDelta, { sessionId }),
    ),
  1_000,
);

const agentChatSummaryCache =
  createKeyedShortIpcCache<AgentChatSessionSummary | null>(
    (sessionId) => ipcRenderer.invoke(IPC.agentChatGetSummary, { sessionId }),
    1_000,
  );

const iosSimulatorStatusCache = createShortIpcCache<IosSimulatorStatus>(
  () =>
    callProjectRuntimeActionOr("ios_simulator", "getStatus", {}, () =>
      ipcRenderer.invoke(IPC.iosSimulatorGetStatus),
    ),
  2_000,
);

const iosSimulatorDevicesCache = createShortIpcCache<IosSimulatorDevice[]>(
  () =>
    callProjectRuntimeActionOr("ios_simulator", "listDevices", {}, () =>
      ipcRenderer.invoke(IPC.iosSimulatorListDevices),
    ),
  2_000,
);

const appControlStatusCache = createShortIpcCache<AppControlStatus>(
  () =>
    callProjectRuntimeActionOr("app_control", "getStatus", {}, () =>
      ipcRenderer.invoke(IPC.appControlGetStatus),
    ),
  1_000,
);

const builtInBrowserStatusCache = createShortIpcCache<BuiltInBrowserStatus>(
  () => ipcRenderer.invoke(IPC.builtInBrowserGetStatus),
  500,
);

const macosVmStatusCache = createKeyedShortIpcCache<MacosVmStatus>((key) => {
  const args = parseIpcCacheArgs<MacosVmStatusArgs>(key, {});
  return callRemoteProjectRuntimeActionOr("macos_vm", "getStatus", { args }, () =>
    ipcRenderer.invoke(IPC.macosVmGetStatus, args),
  );
}, 750);

const computerUseOwnerSnapshotCache =
  createKeyedShortIpcCache<ComputerUseOwnerSnapshot>((key) => {
    const args = parseIpcCacheArgs<ComputerUseOwnerSnapshotArgs>(
      key,
      {} as ComputerUseOwnerSnapshotArgs,
    );
    return callProjectRuntimeActionOr(
      "computer_use_artifacts",
      "getOwnerSnapshot",
      { args },
      () => ipcRenderer.invoke(IPC.computerUseGetOwnerSnapshot, args),
    );
  }, 2_000);

const imageDataUrlCache = createKeyedShortIpcCache<{ dataUrl: string }>(
  (path) => ipcRenderer.invoke(IPC.appGetImageDataUrl, { path }),
  30_000,
);

const projectIconCache = createKeyedShortIpcCache<ProjectIcon>(
  (rootPath) => ipcRenderer.invoke(IPC.projectResolveIcon, { rootPath }),
  30_000,
);

const diffChangesCache = createKeyedShortIpcCache<DiffChanges>(
  (key) =>
    ipcRenderer.invoke(
      IPC.diffGetChanges,
      parseIpcCacheArgs<GetDiffChangesArgs>(key, {} as GetDiffChangesArgs),
    ),
  2_000,
);

const gitBranchesCache = createKeyedShortIpcCache<GitBranchSummary[]>(
  (key) =>
    ipcRenderer.invoke(
      IPC.gitListBranches,
      parseIpcCacheArgs<GitListBranchesArgs>(key, {} as GitListBranchesArgs),
    ),
  2_000,
);

const localRuntimeDaemonDisabled =
  process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON === "1";

const allowLocalRuntimeFallback =
  process.env.ADE_LOCAL_RUNTIME_FALLBACK !== "0" &&
  (
    process.env.ADE_LOCAL_RUNTIME_FALLBACK === "1" ||
    localRuntimeDaemonDisabled ||
    process.env.ADE_PACKAGE_CHANNEL === "alpha"
  );

function isLocalRuntimeActionNotCallableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Action '[^']+\.[^']+' is not callable/i.test(message);
}

function isSafeLocalRuntimeFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|ETIMEDOUT)\b/i.test(message) ||
    /Local runtime daemon is not available/i.test(message) ||
    /ADE service connection (?:closed|failed)/i.test(message) ||
    /IPC handler for 'ade\.localRuntime\.(?:callAction|callSync|streamEvents)' timed out/i.test(message) ||
    isLocalRuntimeActionNotCallableError(error) ||
    /Timed out waiting for remote ADE service method /i.test(message) ||
    /Timed out connecting to ADE service socket/i.test(message) ||
    /Unsupported database value/i.test(message) ||
    /UNIQUE constraint failed: process_definitions\.id/i.test(message) ||
    /no such function: crsql_internal_sync_bit/i.test(message) ||
    /database is not open/i.test(message)
  );
}

let currentProjectBinding: OpenProjectBinding | null = null;
let projectBindingGeneration = 0;
let projectBindingVersion = 0;
let projectBindingRefreshPromise: Promise<OpenProjectBinding | null> | null = null;
let projectRuntimeTransitionDepth = 0;

function rememberProjectBinding(binding: OpenProjectBinding | null): void {
  const previousKey = currentProjectBinding?.key ?? null;
  const nextKey = binding?.key ?? null;
  projectBindingVersion += 1;
  currentProjectBinding = binding;
  if (previousKey !== nextKey) {
    projectBindingGeneration += 1;
    resetRemoteRuntimeEventDedup(nextKey);
    resetLocalRuntimeEventPollingSuppression();
    clearPendingRemoteRuntimeEventPoll();
  }
  if (
    binding?.kind === "remote" ||
    (binding?.kind === "local" && !localRuntimeDaemonDisabled)
  ) {
    ensureRemoteRuntimeEventPump();
  }
}

function localProjectBindingForRoot(rootPath: string): OpenProjectBinding {
  const trimmed = rootPath.trim();
  if (!trimmed) {
    throw new Error("Project root path is required.");
  }
  const displayName = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
  return {
    kind: "local",
    key: `local:${trimmed}`,
    rootPath: trimmed,
    displayName,
  };
}

async function refreshProjectBinding(): Promise<OpenProjectBinding | null> {
  if (projectBindingRefreshPromise) return projectBindingRefreshPromise;
  const refreshVersion = projectBindingVersion;
  projectBindingRefreshPromise = ipcRenderer
    .invoke(IPC.appGetWindowSession)
    .then((session: { binding?: OpenProjectBinding | null } | null) => {
      const binding = session?.binding ?? null;
      if (projectBindingVersion !== refreshVersion) return currentProjectBinding;
      rememberProjectBinding(binding);
      return binding;
    })
    .finally(() => {
      projectBindingRefreshPromise = null;
    });
  return projectBindingRefreshPromise;
}

async function getRemoteProjectBinding(options?: { fresh?: boolean }): Promise<Extract<
  OpenProjectBinding,
  { kind: "remote" }
> | null> {
  const binding = await getProjectRuntimeBinding(options);
  return binding?.kind === "remote" ? binding : null;
}

async function getLocalProjectBinding(options?: { fresh?: boolean }): Promise<Extract<
  OpenProjectBinding,
  { kind: "local" }
> | null> {
  const binding = await getProjectRuntimeBinding(options);
  return binding?.kind === "local" ? binding : null;
}

async function getProjectRuntimeBinding(options?: { fresh?: boolean }): Promise<OpenProjectBinding | null> {
  if (!options?.fresh && currentProjectBinding) return currentProjectBinding;
  return refreshProjectBinding();
}

function normalizePathForContainment(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed || "/";
}

function isAbsoluteOrHomePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

async function assertNotRemoteProjectPathAction(
  action: string,
  paths: Array<string | null | undefined>,
): Promise<void> {
  const binding = await getProjectRuntimeBinding();
  if (binding?.kind !== "remote") return;
  const remoteRoot = normalizePathForContainment(binding.rootPath);
  const hasRemotePath = paths.some((value) => {
    const pathValue = value?.trim();
    if (!pathValue) return false;
    if (!isAbsoluteOrHomePath(pathValue)) return true;
    const normalized = normalizePathForContainment(pathValue);
    return normalized === remoteRoot || normalized.startsWith(`${remoteRoot}/`);
  });
  if (!hasRemotePath) return;
  throw new Error(
    `${action} is only available for local desktop paths, not remote project paths.`,
  );
}

async function assertLocalProjectHostAction(action: string): Promise<void> {
  const binding = await getProjectRuntimeBinding();
  if (binding?.kind !== "remote") return;
  throw new Error(`${action} is only available on the local project host.`);
}

async function callRemoteProjectActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
  options?: { freshBinding?: boolean },
): Promise<{ handled: true; result: T } | { handled: false }> {
  const binding = await getRemoteProjectBinding(options?.freshBinding ? { fresh: true } : undefined);
  if (!binding) return { handled: false };
  const response = (await ipcRenderer.invoke(IPC.remoteRuntimeCallAction, {
    id: binding.targetId,
    projectId: binding.projectId,
    request: { domain, action, ...request },
  })) as RemoteRuntimeActionResult;
  return { handled: true, result: response.result as T };
}

async function callLocalProjectActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
  options?: { freshBinding?: boolean },
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (localRuntimeDaemonDisabled) return { handled: false };
  const binding = await getLocalProjectBinding(options?.freshBinding ? { fresh: true } : undefined);
  if (!binding) return { handled: false };
  try {
    const response = (await ipcRenderer.invoke(IPC.localRuntimeCallAction, {
      rootPath: binding.rootPath,
      request: { domain, action, ...request },
    })) as RemoteRuntimeActionResult;
    return { handled: true, result: response.result as T };
  } catch (error) {
    const canUseFallback =
      allowLocalRuntimeFallback
      || isLocalRuntimeActionNotCallableError(error)
      // Chat turns must not stall behind a hung local-runtime daemon — fall back
      // to in-process IPC for safe transport errors (timeouts, socket loss).
      || (domain === "chat" && isSafeLocalRuntimeFallbackError(error));
    if (!canUseFallback || !isSafeLocalRuntimeFallbackError(error)) {
      throw error;
    }
    console.warn(
      "Local ADE service action failed; using in-process fallback.",
      error,
    );
    return { handled: false };
  }
}

async function callLocalProjectActionStrictIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (localRuntimeDaemonDisabled) return { handled: false };
  const binding = await getLocalProjectBinding();
  if (!binding) return { handled: false };
  const response = (await ipcRenderer.invoke(IPC.localRuntimeCallAction, {
    rootPath: binding.rootPath,
    request: { domain, action, ...request },
  })) as RemoteRuntimeActionResult;
  return { handled: true, result: response.result as T };
}

// Chat actions that mutate runtime state. Only these are gated by the
// project-transition guard: read-only chat queries (e.g. `listSessions`,
// `getSessionSummary`, `getAvailableModels`, `getChatEventHistory`) must be
// allowed to fall through to IPC while a project switch is in flight, so the
// UI can render summaries and history during the transition.
const MUTATING_CHAT_ACTIONS = new Set<string>([
  "sendMessage",
  "respondToInput",
  "approveToolUse",
  "interrupt",
  "steer",
  "cancelSteer",
  "editSteer",
  "dispatchSteer",
  "cancelDispatchedSteer",
  "createSession",
  "archiveSession",
  "unarchiveSession",
  "deleteSession",
  "updateSession",
  "handoffSession",
  "setClaudeOutputStyle",
  "reloadClaudePlugins",
  "setParallelLaunchState",
  "ensureCtoSession",
  "ensureAgentIdentitySession",
  "warmupModel",
  "rewindFiles",
  "saveTempAttachment",
  "codexOpenInCli",
]);

async function callProjectRuntimeActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  const freshBinding = domain === "chat";
  const isMutatingChatAction =
    freshBinding && MUTATING_CHAT_ACTIONS.has(action);
  if (isMutatingChatAction && projectRuntimeTransitionDepth > 0) {
    throw new Error("Project is switching. Wait for the current project to finish loading before sending chat messages.");
  }
  // During a project transition, let read-only chat calls fall through to
  // their IPC fallback instead of binding to a possibly-stale runtime.
  if (freshBinding && !isMutatingChatAction && projectRuntimeTransitionDepth > 0) {
    return { handled: false };
  }
  const remote = await callRemoteProjectActionIfBound<T>(
    domain,
    action,
    request,
    { freshBinding },
  );
  if (remote.handled) return remote;
  return callLocalProjectActionIfBound<T>(domain, action, request, { freshBinding });
}

async function callProjectRuntimeActionOr<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  const runtime = await callProjectRuntimeActionIfBound<T>(
    domain,
    action,
    request,
  );
  return runtime.handled ? runtime.result : local();
}

async function callProjectRuntimeActionStrictOr<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  const remote = await callRemoteProjectActionIfBound<T>(domain, action, request);
  if (remote.handled) return remote.result;
  const localRuntime = await callLocalProjectActionStrictIfBound<T>(domain, action, request);
  return localRuntime.handled ? localRuntime.result : local();
}

async function callRemoteProjectRuntimeActionOr<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  const remote = await callRemoteProjectActionIfBound<T>(
    domain,
    action,
    request,
  );
  return remote.handled ? remote.result : local();
}

function callPrReadRuntimeActionOr<T>(
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  return callProjectRuntimeActionOr("pr", action, request, local);
}

async function callProjectFileRuntimeActionOr<T>(
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  const remote = await callRemoteProjectActionIfBound<T>(
    "file",
    action,
    request,
  );
  if (remote.handled) return remote.result;
  const localRuntime = await callLocalProjectActionStrictIfBound<T>(
    "file",
    action,
    request,
  );
  return localRuntime.handled ? localRuntime.result : local();
}

async function callRemoteProjectSyncIfBound<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  const binding = await getRemoteProjectBinding();
  if (!binding) return { handled: false };
  const result = (await ipcRenderer.invoke(IPC.remoteRuntimeCallSync, {
    id: binding.targetId,
    projectId: binding.projectId,
    method,
    params,
  })) as T;
  return { handled: true, result };
}

async function callLocalProjectSyncIfBound<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (localRuntimeDaemonDisabled) return { handled: false };
  const binding = await getLocalProjectBinding();
  if (!binding) return { handled: false };
  try {
    const result = (await ipcRenderer.invoke(IPC.localRuntimeCallSync, {
      rootPath: binding.rootPath,
      method,
      params,
    })) as T;
    return { handled: true, result };
  } catch (error) {
    const canUseFallback =
      allowLocalRuntimeFallback || isLocalRuntimeActionNotCallableError(error);
    if (!canUseFallback || !isSafeLocalRuntimeFallbackError(error)) {
      throw error;
    }
    console.warn(
      "Local ADE service sync call failed; using in-process fallback.",
      error,
    );
    return { handled: false };
  }
}

async function callProjectRuntimeSyncOr<T>(
  method: string,
  params: Record<string, unknown>,
  local: () => Promise<T>,
): Promise<T> {
  const remote = await callRemoteProjectSyncIfBound<T>(method, params);
  if (remote.handled) return remote.result;
  const localRuntime = await callLocalProjectSyncIfBound<T>(method, params);
  return localRuntime.handled ? localRuntime.result : local();
}

const remoteAgentChatEventCallbacks = new Set<
  (payload: AgentChatEventEnvelope) => void
>();
const remoteSessionChangedCallbacks = new Set<
  (payload: TerminalSessionChangedEvent) => void
>();
const remoteLaneDeleteEventCallbacks = new Set<
  (payload: LaneDeleteEvent) => void
>();
const remoteLaneRebaseEventCallbacks = new Set<
  (payload: RebaseRunEventPayload) => void
>();
const remoteLaneRebaseSuggestionsEventCallbacks = new Set<
  (payload: RebaseSuggestionsEventPayload) => void
>();
const remoteLaneAutoRebaseEventCallbacks = new Set<
  (payload: AutoRebaseEventPayload) => void
>();
const remoteLaneEnvEventCallbacks = new Set<
  (payload: LaneEnvInitEvent) => void
>();
const remoteLanePortEventCallbacks = new Set<
  (payload: PortAllocationEvent) => void
>();
const remoteLaneProxyEventCallbacks = new Set<
  (payload: LaneProxyEvent) => void
>();
const remoteLaneOAuthEventCallbacks = new Set<
  (payload: OAuthRedirectEvent) => void
>();
const remoteLaneDiagnosticsEventCallbacks = new Set<
  (payload: RuntimeDiagnosticsEvent) => void
>();
const remotePtyDataEventCallbacks = new Set<(payload: PtyDataEvent) => void>();
const remotePtyExitEventCallbacks = new Set<(payload: PtyExitEvent) => void>();
const remoteProcessEventCallbacks = new Set<(payload: ProcessEvent) => void>();
const remoteTestEventCallbacks = new Set<(payload: TestEvent) => void>();
const remoteFileChangeEventCallbacks = new Set<
  (payload: FileChangeEvent) => void
>();
const remotePrEventCallbacks = new Set<(payload: PrEventPayload) => void>();
const remotePrAiResolutionEventCallbacks = new Set<
  (payload: PrAiResolutionEventPayload) => void
>();
const remoteProjectStateEventCallbacks = new Set<
  (payload: AdeProjectEvent) => void
>();
const remoteMissionEventCallbacks = new Set<
  (payload: MissionsEventPayload) => void
>();
const remoteOrchestratorEventCallbacks = new Set<
  (payload: OrchestratorRuntimeEvent) => void
>();
const remoteOrchestratorThreadEventCallbacks = new Set<
  (payload: OrchestratorThreadEvent) => void
>();
const remoteDagMutationEventCallbacks = new Set<
  (payload: DagMutationEvent) => void
>();
const remoteSyncStatusEventCallbacks = new Set<
  (payload: SyncStatusEventPayload) => void
>();
const remoteReviewEventCallbacks = new Set<
  (payload: ReviewEventPayload) => void
>();
const remoteMacosVmEventCallbacks = new Set<
  (payload: MacosVmEventPayload) => void
>();
const remoteUsageUpdateEventCallbacks = new Set<
  (payload: UsageSnapshot) => void
>();
const remoteUsageThresholdEventCallbacks = new Set<
  (payload: UsageThresholdEvent) => void
>();
const remoteAutomationsEventCallbacks = new Set<
  (payload: AutomationsEventPayload) => void
>();
const remoteConflictEventCallbacks = new Set<
  (payload: ConflictEventPayload) => void
>();
const remoteGitHubStatusChangedCallbacks = new Set<
  (payload: GitHubStatus) => void
>();
const remoteLinearWorkflowEventCallbacks = new Set<
  (payload: LinearWorkflowEventPayload) => void
>();
const remoteFeedbackEventCallbacks = new Set<
  (payload: FeedbackSubmissionEvent) => void
>();
const remoteComputerUseEventCallbacks = new Set<
  (payload: ComputerUseEventPayload) => void
>();
const remoteIosSimulatorEventCallbacks = new Set<
  (payload: IosSimulatorEventPayload) => void
>();
const remoteAppControlEventCallbacks = new Set<
  (payload: AppControlEventPayload) => void
>();

function createLocalIpcEventSubscription<T>(
  channel: string,
  logLabel: string,
  beforeEmit?: () => void,
): (cb: (payload: T) => void) => () => void {
  const callbacks = new Set<(payload: T) => void>();
  let listener: ((_event: Electron.IpcRendererEvent, payload: T) => void) | null = null;

  return (cb: (payload: T) => void) => {
    callbacks.add(cb);
    if (!listener) {
      listener = (_event: Electron.IpcRendererEvent, payload: T) => {
        beforeEmit?.();
        for (const callback of [...callbacks]) {
          try {
            callback(payload);
          } catch (error) {
            console.error(`preload ${logLabel} listener failed`, error);
          }
        }
      };
      ipcRenderer.on(channel, listener);
    }
    return () => {
      callbacks.delete(cb);
      if (callbacks.size === 0 && listener) {
        ipcRenderer.removeListener(channel, listener);
        listener = null;
      }
    };
  };
}

const subscribeLocalSessionChangedEvents =
  createLocalIpcEventSubscription<TerminalSessionChangedEvent>(
    IPC.sessionsChanged,
    "session changed",
    () => sessionDeltaCache.clear(),
  );
const subscribeLocalPrEvents = createLocalIpcEventSubscription<PrEventPayload>(
  IPC.prsEvent,
  "PR event",
);
const subscribeLocalUsageUpdateEvents =
  createLocalIpcEventSubscription<UsageSnapshot>(
    IPC.usageEvent,
    "usage update",
  );
const subscribeLocalUsageThresholdEvents =
  createLocalIpcEventSubscription<UsageThresholdEvent>(
    IPC.usageThresholdEvent,
    "usage threshold",
  );
const subscribeLocalAutomationsEvents =
  createLocalIpcEventSubscription<AutomationsEventPayload>(
    IPC.automationsEvent,
    "automation event",
  );
const subscribeLocalConflictEvents =
  createLocalIpcEventSubscription<ConflictEventPayload>(
    IPC.conflictsEvent,
    "conflict event",
  );
const subscribeLocalFeedbackEvents =
  createLocalIpcEventSubscription<FeedbackSubmissionEvent>(
    IPC.feedbackOnUpdate,
    "feedback event",
  );

let remoteRuntimeEventTimer: ReturnType<typeof setTimeout> | null = null;
let remoteRuntimeEventInFlight = false;
let remoteRuntimeEventCursor = 0;
let remoteRuntimeEventBindingKey: string | null = null;
let remoteRuntimeEventGeneration = -1;
let remoteRuntimeEventEpoch: string | null = null;
let remoteRuntimeEventStartedAtMs = 0;
let remoteRuntimeSeenEventBindingKey: string | null = null;
const remoteRuntimeSeenEventIds = new Set<number>();
let localRuntimeEventSuppressedUntilMs = 0;
let localRuntimeEventSuppressionLogged = false;

function suppressLocalRuntimeEventPolling(): void {
  localRuntimeEventSuppressedUntilMs = Math.max(
    localRuntimeEventSuppressedUntilMs,
    Date.now() + 30_000,
  );
}

function resetLocalRuntimeEventPollingSuppression(): void {
  localRuntimeEventSuppressedUntilMs = 0;
  localRuntimeEventSuppressionLogged = false;
}

function clearPendingRemoteRuntimeEventPoll(): void {
  if (!remoteRuntimeEventTimer) return;
  clearTimeout(remoteRuntimeEventTimer);
  remoteRuntimeEventTimer = null;
}

function localRuntimeEventSuppressionDelayMs(): number {
  return Math.max(0, localRuntimeEventSuppressedUntilMs - Date.now());
}

function resetRemoteRuntimeEventDedup(bindingKey: string | null): void {
  remoteRuntimeSeenEventBindingKey = bindingKey;
  remoteRuntimeSeenEventIds.clear();
}

function shouldDispatchRemoteRuntimeEvent(
  bindingKey: string,
  event: RemoteRuntimeBufferedEvent,
): boolean {
  if (remoteRuntimeSeenEventBindingKey !== bindingKey) {
    resetRemoteRuntimeEventDedup(bindingKey);
  }
  if (remoteRuntimeSeenEventIds.has(event.id)) return false;
  remoteRuntimeSeenEventIds.add(event.id);
  while (remoteRuntimeSeenEventIds.size > 1_000) {
    const oldest = remoteRuntimeSeenEventIds.values().next().value;
    if (typeof oldest !== "number") break;
    remoteRuntimeSeenEventIds.delete(oldest);
  }
  remoteRuntimeEventCursor = Math.max(remoteRuntimeEventCursor, event.id);
  return true;
}

function hasRemoteRuntimeEventSubscribers(): boolean {
  return (
    remoteAgentChatEventCallbacks.size > 0 ||
    remoteMissionEventCallbacks.size > 0 ||
    remoteOrchestratorEventCallbacks.size > 0 ||
    remoteOrchestratorThreadEventCallbacks.size > 0 ||
    remoteDagMutationEventCallbacks.size > 0 ||
    remoteSyncStatusEventCallbacks.size > 0 ||
    remoteReviewEventCallbacks.size > 0 ||
    remoteSessionChangedCallbacks.size > 0 ||
    remoteLaneDeleteEventCallbacks.size > 0 ||
    remoteLaneRebaseEventCallbacks.size > 0 ||
    remoteLaneRebaseSuggestionsEventCallbacks.size > 0 ||
    remoteLaneAutoRebaseEventCallbacks.size > 0 ||
    remoteLaneEnvEventCallbacks.size > 0 ||
    remoteLanePortEventCallbacks.size > 0 ||
    remoteLaneProxyEventCallbacks.size > 0 ||
    remoteLaneOAuthEventCallbacks.size > 0 ||
    remoteLaneDiagnosticsEventCallbacks.size > 0 ||
    remotePtyDataEventCallbacks.size > 0 ||
    remotePtyExitEventCallbacks.size > 0 ||
    remoteProcessEventCallbacks.size > 0 ||
    remoteTestEventCallbacks.size > 0 ||
    remoteFileChangeEventCallbacks.size > 0 ||
    remotePrEventCallbacks.size > 0 ||
    remoteProjectStateEventCallbacks.size > 0 ||
    remoteMacosVmEventCallbacks.size > 0 ||
    remoteUsageUpdateEventCallbacks.size > 0 ||
    remoteUsageThresholdEventCallbacks.size > 0 ||
    remoteAutomationsEventCallbacks.size > 0 ||
    remoteConflictEventCallbacks.size > 0 ||
    remoteGitHubStatusChangedCallbacks.size > 0 ||
    remoteLinearWorkflowEventCallbacks.size > 0 ||
    remoteFeedbackEventCallbacks.size > 0 ||
    remoteComputerUseEventCallbacks.size > 0 ||
    remoteIosSimulatorEventCallbacks.size > 0 ||
    remoteAppControlEventCallbacks.size > 0 ||
    remotePrAiResolutionEventCallbacks.size > 0
  );
}

function ensureRemoteRuntimeEventPump(): void {
  if (!hasRemoteRuntimeEventSubscribers()) return;
  if (remoteRuntimeEventTimer || remoteRuntimeEventInFlight) return;
  remoteRuntimeEventTimer = setTimeout(() => {
    remoteRuntimeEventTimer = null;
    void pollRemoteRuntimeEvents();
  }, 0);
}

function scheduleRemoteRuntimeEventPoll(delayMs: number): void {
  if (!hasRemoteRuntimeEventSubscribers()) return;
  if (remoteRuntimeEventTimer || remoteRuntimeEventInFlight) return;
  remoteRuntimeEventTimer = setTimeout(() => {
    remoteRuntimeEventTimer = null;
    void pollRemoteRuntimeEvents();
  }, delayMs);
}

async function pollRemoteRuntimeEvents(): Promise<void> {
  if (remoteRuntimeEventInFlight || !hasRemoteRuntimeEventSubscribers()) return;
  remoteRuntimeEventInFlight = true;
  let nextDelayMs: number | null = null;
  let pollingLocalRuntime = false;
  try {
    const binding = await getProjectRuntimeBinding();
    if (
      !binding ||
      (binding.kind !== "remote" && binding.kind !== "local") ||
      (binding.kind === "local" && localRuntimeDaemonDisabled)
    ) {
      remoteRuntimeEventCursor = 0;
      remoteRuntimeEventBindingKey = null;
      remoteRuntimeEventGeneration = projectBindingGeneration;
      remoteRuntimeEventEpoch = null;
      remoteRuntimeEventStartedAtMs = 0;
      resetRemoteRuntimeEventDedup(null);
      resetLocalRuntimeEventPollingSuppression();
      return;
    }
    pollingLocalRuntime = binding.kind === "local";
    if (pollingLocalRuntime) {
      const suppressionDelayMs = localRuntimeEventSuppressionDelayMs();
      if (suppressionDelayMs > 0) {
        nextDelayMs = Math.max(1_000, suppressionDelayMs);
        return;
      }
      localRuntimeEventSuppressionLogged = false;
    }

    if (
      remoteRuntimeEventBindingKey !== binding.key ||
      remoteRuntimeEventGeneration !== projectBindingGeneration
    ) {
      remoteRuntimeEventCursor = 0;
      remoteRuntimeEventBindingKey = binding.key;
      remoteRuntimeEventGeneration = projectBindingGeneration;
      remoteRuntimeEventEpoch = null;
      remoteRuntimeEventStartedAtMs =
        binding.kind === "local" ? Date.now() : 0;
      resetRemoteRuntimeEventDedup(binding.key);
    }

    const pollingBindingKey = binding.key;
    const pollingGeneration = projectBindingGeneration;
    const request = {
      cursor: remoteRuntimeEventCursor,
      limit: 100,
    } satisfies RemoteRuntimeStreamEventsRequest;
    const batch =
      binding.kind === "remote"
        ? ((await ipcRenderer.invoke(IPC.remoteRuntimeStreamEvents, {
            id: binding.targetId,
            projectId: binding.projectId,
            request,
          })) as RemoteRuntimeStreamEventsResult)
        : ((await ipcRenderer.invoke(IPC.localRuntimeStreamEvents, {
            rootPath: binding.rootPath,
            request,
          })) as RemoteRuntimeStreamEventsResult);

    if (
      currentProjectBinding?.key !== pollingBindingKey ||
      projectBindingGeneration !== pollingGeneration
    ) {
      nextDelayMs = 0;
      return;
    }

    const batchEpoch =
      typeof batch.eventEpoch === "string" && batch.eventEpoch.trim()
        ? batch.eventEpoch.trim()
        : null;
    if (batchEpoch) {
      const epochChanged = remoteRuntimeEventEpoch
        ? batchEpoch !== remoteRuntimeEventEpoch
        : remoteRuntimeEventCursor > 0;
      remoteRuntimeEventEpoch = batchEpoch;
      if (epochChanged) {
        remoteRuntimeEventCursor = 0;
        resetRemoteRuntimeEventDedup(binding.key);
        nextDelayMs = 0;
        return;
      }
    }

    remoteRuntimeEventCursor = Number.isFinite(batch.nextCursor)
      ? Math.max(0, Math.floor(batch.nextCursor))
      : remoteRuntimeEventCursor;

    for (const event of batch.events) {
      const eventTime = Date.parse(event.timestamp);
      if (
        binding.kind === "local" &&
        remoteRuntimeEventStartedAtMs > 0 &&
        Number.isFinite(eventTime) &&
        eventTime < remoteRuntimeEventStartedAtMs - 1_000
      ) {
        continue;
      }
      if (!shouldDispatchRemoteRuntimeEvent(binding.key, event)) continue;
      dispatchRemoteRuntimeEventPayload(event.payload);
    }
    nextDelayMs = batch.hasMore ? 50 : 750;
  } catch (error) {
    if (pollingLocalRuntime && isSafeLocalRuntimeFallbackError(error)) {
      suppressLocalRuntimeEventPolling();
      if (!localRuntimeEventSuppressionLogged) {
        localRuntimeEventSuppressionLogged = true;
        console.warn(
          "Local ADE service event polling failed; backing off while the local service recovers.",
          error,
        );
      }
    } else {
      console.warn("Remote ADE service event polling failed", error);
    }
    nextDelayMs = 2_000;
  } finally {
    remoteRuntimeEventInFlight = false;
    if (
      nextDelayMs != null &&
      hasRemoteRuntimeEventSubscribers() &&
      (currentProjectBinding?.kind === "remote" ||
        currentProjectBinding?.kind === "local") &&
      !remoteRuntimeEventTimer
    ) {
      scheduleRemoteRuntimeEventPoll(nextDelayMs);
    }
  }
}

function handleRemoteRuntimeEventNotification(value: unknown): void {
  const payload = toRemoteRuntimeEventNotificationPayload(value);
  const binding = currentProjectBinding;
  if (!payload || !binding || payload.bindingKey !== binding.key) return;
  const eventTime = Date.parse(payload.event.timestamp);
  if (
    binding.kind === "local" &&
    remoteRuntimeEventStartedAtMs > 0 &&
    Number.isFinite(eventTime) &&
    eventTime < remoteRuntimeEventStartedAtMs - 1_000
  ) {
    return;
  }
  if (!shouldDispatchRemoteRuntimeEvent(payload.bindingKey, payload.event))
    return;
  dispatchRemoteRuntimeEventPayload(payload.event.payload);
}

function toRemoteRuntimeEventNotificationPayload(
  value: unknown,
): RemoteRuntimeEventNotificationPayload | null {
  if (!isRecord(value)) return null;
  const bindingKey =
    typeof value.bindingKey === "string" ? value.bindingKey : "";
  const event = toRemoteRuntimeBufferedEvent(value.event);
  if (!bindingKey || !event) return null;
  return { bindingKey, event };
}

function toRemoteRuntimeBufferedEvent(
  value: unknown,
): RemoteRuntimeBufferedEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "number" || !Number.isFinite(value.id)) return null;
  if (typeof value.timestamp !== "string") return null;
  const category = value.category;
  if (
    category !== "orchestrator" &&
    category !== "dag_mutation" &&
    category !== "runtime" &&
    category !== "mission" &&
    category !== "pty"
  ) {
    return null;
  }
  const payload = isRecord(value.payload) ? value.payload : {};
  return {
    id: Math.max(0, Math.floor(value.id)),
    timestamp: value.timestamp,
    category,
    payload,
  };
}

ipcRenderer.on(IPC.runtimeEvent, (_event, payload: unknown) => {
  handleRemoteRuntimeEventNotification(payload);
});

function dispatchRemoteRuntimeEventPayload(
  payload: Record<string, unknown>,
): void {
  if (payload.type === "missions-updated") {
    for (const cb of [...remoteMissionEventCallbacks]) {
      try {
        cb(payload as MissionsEventPayload);
      } catch (error) {
        console.error("preload remote mission listener failed", error);
      }
    }
  }

  if (payload.type === "sync-status" && isRecord(payload.snapshot)) {
    for (const cb of [...remoteSyncStatusEventCallbacks]) {
      try {
        cb(payload as SyncStatusEventPayload);
      } catch (error) {
        console.error("preload remote sync listener failed", error);
      }
    }
  }

  if (payload.type === "usage" && isRecord(payload.snapshot)) {
    for (const cb of [...remoteUsageUpdateEventCallbacks]) {
      try {
        cb(payload.snapshot as unknown as UsageSnapshot);
      } catch (error) {
        console.error("preload remote usage listener failed", error);
      }
    }
  }

  const usageThresholdEvent = toWrappedEvent<UsageThresholdEvent>(
    payload,
    "usage_threshold",
  );
  if (usageThresholdEvent) {
    for (const cb of [...remoteUsageThresholdEventCallbacks]) {
      try {
        cb(usageThresholdEvent);
      } catch (error) {
        console.error("preload remote usage threshold listener failed", error);
      }
    }
  }

  const automationsEvent = toAutomationsRuntimeEvent(payload);
  if (automationsEvent) {
    for (const cb of [...remoteAutomationsEventCallbacks]) {
      try {
        cb(automationsEvent);
      } catch (error) {
        console.error("preload remote automation listener failed", error);
      }
    }
  }

  const conflictEvent = toWrappedEvent<ConflictEventPayload>(
    payload,
    "conflict_event",
  );
  if (conflictEvent) {
    for (const cb of [...remoteConflictEventCallbacks]) {
      try {
        cb(conflictEvent);
      } catch (error) {
        console.error("preload remote conflict listener failed", error);
      }
    }
  }

  const githubStatus = toWrappedEvent<GitHubStatus>(
    payload,
    "github_status_changed",
  );
  if (githubStatus) {
    githubStatusCache.clear();
    githubRemoteStatusCache.clear();
    for (const cb of [...remoteGitHubStatusChangedCallbacks]) {
      try {
        cb(githubStatus);
      } catch (error) {
        console.error("preload remote GitHub status listener failed", error);
      }
    }
  }

  const linearWorkflowEvent = toWrappedEvent<LinearWorkflowEventPayload>(
    payload,
    "linear_workflow_event",
  );
  if (linearWorkflowEvent) {
    for (const cb of [...remoteLinearWorkflowEventCallbacks]) {
      try {
        cb(linearWorkflowEvent);
      } catch (error) {
        console.error("preload remote Linear workflow listener failed", error);
      }
    }
  }

  const feedbackEvent = toWrappedEvent<FeedbackSubmissionEvent>(
    payload,
    "feedback_submission_event",
  );
  if (feedbackEvent) {
    for (const cb of [...remoteFeedbackEventCallbacks]) {
      try {
        cb(feedbackEvent);
      } catch (error) {
        console.error("preload remote feedback listener failed", error);
      }
    }
  }

  const computerUseEvent = toWrappedEvent<ComputerUseEventPayload>(
    payload,
    "computer_use_event",
  );
  if (computerUseEvent) {
    computerUseOwnerSnapshotCache.clear();
    for (const cb of [...remoteComputerUseEventCallbacks]) {
      try {
        cb(computerUseEvent);
      } catch (error) {
        console.error("preload remote computer use listener failed", error);
      }
    }
  }

  const iosSimulatorEvent = toWrappedEvent<IosSimulatorEventPayload>(
    payload,
    "ios_simulator_event",
  );
  if (iosSimulatorEvent) {
    clearIosSimulatorStatusCaches();
    for (const cb of [...remoteIosSimulatorEventCallbacks]) {
      try {
        cb(iosSimulatorEvent);
      } catch (error) {
        console.error("preload remote iOS simulator listener failed", error);
      }
    }
  }

  const appControlEvent = toWrappedEvent<AppControlEventPayload>(
    payload,
    "app_control_event",
  );
  if (appControlEvent) {
    appControlStatusCache.clear();
    for (const cb of [...remoteAppControlEventCallbacks]) {
      try {
        cb(appControlEvent);
      } catch (error) {
        console.error("preload remote App Control listener failed", error);
      }
    }
  }

  const reviewEvent = toWrappedEvent<ReviewEventPayload>(
    payload,
    "review_event",
  );
  if (reviewEvent) {
    for (const cb of [...remoteReviewEventCallbacks]) {
      try {
        cb(reviewEvent);
      } catch (error) {
        console.error("preload remote review listener failed", error);
      }
    }
  }

  if (
    payload.type === "orchestrator-run-updated" ||
    payload.type === "orchestrator-step-updated" ||
    payload.type === "orchestrator-attempt-updated" ||
    payload.type === "orchestrator-claim-updated"
  ) {
    for (const cb of [...remoteOrchestratorEventCallbacks]) {
      try {
        cb(payload as OrchestratorRuntimeEvent);
      } catch (error) {
        console.error("preload remote orchestrator listener failed", error);
      }
    }
  }

  if (
    payload.type === "thread_updated" ||
    payload.type === "message_appended" ||
    payload.type === "message_updated" ||
    payload.type === "metrics_updated" ||
    payload.type === "worker_digest_updated" ||
    payload.type === "worker_replay"
  ) {
    for (const cb of [...remoteOrchestratorThreadEventCallbacks]) {
      try {
        cb(payload as OrchestratorThreadEvent);
      } catch (error) {
        console.error(
          "preload remote orchestrator thread listener failed",
          error,
        );
      }
    }
  }

  if (
    typeof payload.runId === "string" &&
    isRecord(payload.mutation) &&
    typeof payload.timestamp === "string"
  ) {
    for (const cb of [...remoteDagMutationEventCallbacks]) {
      try {
        cb(payload as DagMutationEvent);
      } catch (error) {
        console.error("preload remote DAG mutation listener failed", error);
      }
    }
  }

  const chatEvent = toAgentChatEventEnvelope(payload);
  if (chatEvent) {
    agentChatSummaryCache.clear();
    for (const cb of [...remoteAgentChatEventCallbacks]) {
      try {
        cb(chatEvent);
      } catch (error) {
        console.error("preload remote agent chat listener failed", error);
      }
    }
  }

  const sessionChanged = toTerminalSessionChangedEvent(payload);
  if (sessionChanged) {
    sessionDeltaCache.clear();
    for (const cb of [...remoteSessionChangedCallbacks]) {
      try {
        cb(sessionChanged);
      } catch (error) {
        console.error("preload remote session listener failed", error);
      }
    }
  }

  const laneDeleteEvent = toWrappedEvent<LaneDeleteEvent>(
    payload,
    "lane_delete_event",
  );
  if (laneDeleteEvent) {
    clearGitReadCaches();
    for (const cb of [...remoteLaneDeleteEventCallbacks]) {
      try {
        cb(laneDeleteEvent);
      } catch (error) {
        console.error("preload remote lane delete listener failed", error);
      }
    }
  }

  const laneRebaseEvent = toWrappedEvent<RebaseRunEventPayload>(
    payload,
    "lane_rebase_event",
  );
  if (laneRebaseEvent) {
    clearGitReadCaches();
    for (const cb of [...remoteLaneRebaseEventCallbacks]) {
      try {
        cb(laneRebaseEvent);
      } catch (error) {
        console.error("preload remote lane rebase listener failed", error);
      }
    }
  }

  const rebaseSuggestionsEvent = toWrappedEvent<RebaseSuggestionsEventPayload>(
    payload,
    "lane_rebase_suggestions_event",
  );
  if (rebaseSuggestionsEvent) {
    for (const cb of [...remoteLaneRebaseSuggestionsEventCallbacks]) {
      try {
        cb(rebaseSuggestionsEvent);
      } catch (error) {
        console.error(
          "preload remote rebase suggestions listener failed",
          error,
        );
      }
    }
  }

  const autoRebaseEvent = toWrappedEvent<AutoRebaseEventPayload>(
    payload,
    "lane_auto_rebase_event",
  );
  if (autoRebaseEvent) {
    for (const cb of [...remoteLaneAutoRebaseEventCallbacks]) {
      try {
        cb(autoRebaseEvent);
      } catch (error) {
        console.error("preload remote auto rebase listener failed", error);
      }
    }
  }

  const envEvent = toWrappedEvent<LaneEnvInitEvent>(payload, "lane_env_event");
  if (envEvent) {
    for (const cb of [...remoteLaneEnvEventCallbacks]) {
      try {
        cb(envEvent);
      } catch (error) {
        console.error("preload remote lane env listener failed", error);
      }
    }
  }

  const portEvent = toWrappedEvent<PortAllocationEvent>(
    payload,
    "lane_port_event",
  );
  if (portEvent) {
    for (const cb of [...remoteLanePortEventCallbacks]) {
      try {
        cb(portEvent);
      } catch (error) {
        console.error("preload remote lane port listener failed", error);
      }
    }
  }

  const proxyEvent = toWrappedEvent<LaneProxyEvent>(
    payload,
    "lane_proxy_event",
  );
  if (proxyEvent) {
    for (const cb of [...remoteLaneProxyEventCallbacks]) {
      try {
        cb(proxyEvent);
      } catch (error) {
        console.error("preload remote lane proxy listener failed", error);
      }
    }
  }

  const oauthEvent = toWrappedEvent<OAuthRedirectEvent>(
    payload,
    "lane_oauth_event",
  );
  if (oauthEvent) {
    for (const cb of [...remoteLaneOAuthEventCallbacks]) {
      try {
        cb(oauthEvent);
      } catch (error) {
        console.error("preload remote lane OAuth listener failed", error);
      }
    }
  }

  const diagnosticsEvent = toWrappedEvent<RuntimeDiagnosticsEvent>(
    payload,
    "lane_diagnostics_event",
  );
  if (diagnosticsEvent) {
    for (const cb of [...remoteLaneDiagnosticsEventCallbacks]) {
      try {
        cb(diagnosticsEvent);
      } catch (error) {
        console.error("preload remote lane diagnostics listener failed", error);
      }
    }
  }

  if (isRecord(payload) && payload.type === "lane_head_changed") {
    clearGitReadCaches();
  }

  const ptyDataEvent = toWrappedEvent<PtyDataEvent>(payload, "pty_data");
  if (ptyDataEvent) {
    for (const cb of [...remotePtyDataEventCallbacks]) {
      try {
        cb(ptyDataEvent);
      } catch (error) {
        console.error("preload remote pty data listener failed", error);
      }
    }
  }

  const ptyExitEvent = toWrappedEvent<PtyExitEvent>(payload, "pty_exit");
  if (ptyExitEvent) {
    for (const cb of [...remotePtyExitEventCallbacks]) {
      try {
        cb(ptyExitEvent);
      } catch (error) {
        console.error("preload remote pty exit listener failed", error);
      }
    }
  }

  const processEvent = toProcessEvent(payload);
  if (processEvent) {
    for (const cb of [...remoteProcessEventCallbacks]) {
      try {
        cb(processEvent);
      } catch (error) {
        console.error("preload remote process listener failed", error);
      }
    }
  }

  const testEvent = toTestEvent(payload);
  if (testEvent) {
    for (const cb of [...remoteTestEventCallbacks]) {
      try {
        cb(testEvent);
      } catch (error) {
        console.error("preload remote test listener failed", error);
      }
    }
  }

  const fileChangeEvent = toWrappedEvent<FileChangeEvent>(
    payload,
    "file_change",
  );
  if (fileChangeEvent) {
    clearGitReadCaches();
    for (const cb of [...remoteFileChangeEventCallbacks]) {
      try {
        cb(fileChangeEvent);
      } catch (error) {
        console.error("preload remote file change listener failed", error);
      }
    }
  }

  const prAiResolutionEvent = toWrappedEvent<PrAiResolutionEventPayload>(
    payload,
    "pr_ai_resolution_event",
  );
  if (prAiResolutionEvent) {
    for (const cb of [...remotePrAiResolutionEventCallbacks]) {
      try {
        cb(prAiResolutionEvent);
      } catch (error) {
        console.error("preload remote PR AI resolution listener failed", error);
      }
    }
  }

  const prEvent = toWrappedEvent<PrEventPayload>(payload, "pr_event");
  if (prEvent) {
    for (const cb of [...remotePrEventCallbacks]) {
      try {
        cb(prEvent);
      } catch (error) {
        console.error("preload remote PR listener failed", error);
      }
    }
  }

  const projectStateEvent = toWrappedEvent<AdeProjectEvent>(
    payload,
    "project_state_event",
  );
  if (projectStateEvent) {
    for (const cb of [...remoteProjectStateEventCallbacks]) {
      try {
        cb(projectStateEvent);
      } catch (error) {
        console.error("preload remote project state listener failed", error);
      }
    }
  }

  const macosVmEvent = toMacosVmRuntimeEvent(payload);
  if (macosVmEvent) {
    macosVmStatusCache.clear();
    for (const cb of [...remoteMacosVmEventCallbacks]) {
      try {
        cb(macosVmEvent);
      } catch (error) {
        console.error("preload remote macOS VM listener failed", error);
      }
    }
  }
}

function subscribeRemoteAgentChatEvents(
  cb: (payload: AgentChatEventEnvelope) => void,
): () => void {
  remoteAgentChatEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteAgentChatEventCallbacks.delete(cb);
  };
}

function subscribeRemoteMissionEvents(
  cb: (payload: MissionsEventPayload) => void,
): () => void {
  remoteMissionEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteMissionEventCallbacks.delete(cb);
  };
}

function subscribeRemoteOrchestratorEvents(
  cb: (payload: OrchestratorRuntimeEvent) => void,
): () => void {
  remoteOrchestratorEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteOrchestratorEventCallbacks.delete(cb);
  };
}

function subscribeRemoteOrchestratorThreadEvents(
  cb: (payload: OrchestratorThreadEvent) => void,
): () => void {
  remoteOrchestratorThreadEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteOrchestratorThreadEventCallbacks.delete(cb);
  };
}

function subscribeRemoteDagMutationEvents(
  cb: (payload: DagMutationEvent) => void,
): () => void {
  remoteDagMutationEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteDagMutationEventCallbacks.delete(cb);
  };
}

function subscribeRemoteSyncStatusEvents(
  cb: (payload: SyncStatusEventPayload) => void,
): () => void {
  remoteSyncStatusEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteSyncStatusEventCallbacks.delete(cb);
  };
}

function subscribeRemoteReviewEvents(
  cb: (payload: ReviewEventPayload) => void,
): () => void {
  remoteReviewEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteReviewEventCallbacks.delete(cb);
  };
}

function subscribeRemoteSessionChangedEvents(
  cb: (payload: TerminalSessionChangedEvent) => void,
): () => void {
  remoteSessionChangedCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteSessionChangedCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneDeleteEvents(
  cb: (payload: LaneDeleteEvent) => void,
): () => void {
  remoteLaneDeleteEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneDeleteEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneRebaseEvents(
  cb: (payload: RebaseRunEventPayload) => void,
): () => void {
  remoteLaneRebaseEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneRebaseEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneRebaseSuggestionsEvents(
  cb: (payload: RebaseSuggestionsEventPayload) => void,
): () => void {
  remoteLaneRebaseSuggestionsEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneRebaseSuggestionsEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneAutoRebaseEvents(
  cb: (payload: AutoRebaseEventPayload) => void,
): () => void {
  remoteLaneAutoRebaseEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneAutoRebaseEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneEnvEvents(
  cb: (payload: LaneEnvInitEvent) => void,
): () => void {
  remoteLaneEnvEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneEnvEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLanePortEvents(
  cb: (payload: PortAllocationEvent) => void,
): () => void {
  remoteLanePortEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLanePortEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneProxyEvents(
  cb: (payload: LaneProxyEvent) => void,
): () => void {
  remoteLaneProxyEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneProxyEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneOAuthEvents(
  cb: (payload: OAuthRedirectEvent) => void,
): () => void {
  remoteLaneOAuthEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneOAuthEventCallbacks.delete(cb);
  };
}

function subscribeRemoteLaneDiagnosticsEvents(
  cb: (payload: RuntimeDiagnosticsEvent) => void,
): () => void {
  remoteLaneDiagnosticsEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneDiagnosticsEventCallbacks.delete(cb);
  };
}

function subscribeRemotePtyDataEvents(
  cb: (payload: PtyDataEvent) => void,
): () => void {
  remotePtyDataEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remotePtyDataEventCallbacks.delete(cb);
  };
}

function subscribeRemotePtyExitEvents(
  cb: (payload: PtyExitEvent) => void,
): () => void {
  remotePtyExitEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remotePtyExitEventCallbacks.delete(cb);
  };
}

function subscribeRemoteProcessEvents(
  cb: (payload: ProcessEvent) => void,
): () => void {
  remoteProcessEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteProcessEventCallbacks.delete(cb);
  };
}

function subscribeRemoteTestEvents(
  cb: (payload: TestEvent) => void,
): () => void {
  remoteTestEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteTestEventCallbacks.delete(cb);
  };
}

function subscribeRemoteFileChangeEvents(
  cb: (payload: FileChangeEvent) => void,
): () => void {
  remoteFileChangeEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteFileChangeEventCallbacks.delete(cb);
  };
}

function subscribeRemotePrAiResolutionEvents(
  cb: (payload: PrAiResolutionEventPayload) => void,
): () => void {
  remotePrAiResolutionEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remotePrAiResolutionEventCallbacks.delete(cb);
  };
}

function subscribeRemotePrEvents(
  cb: (payload: PrEventPayload) => void,
): () => void {
  remotePrEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remotePrEventCallbacks.delete(cb);
  };
}

function subscribeRemoteProjectStateEvents(
  cb: (payload: AdeProjectEvent) => void,
): () => void {
  remoteProjectStateEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteProjectStateEventCallbacks.delete(cb);
  };
}

function subscribeRemoteMacosVmEvents(
  cb: (payload: MacosVmEventPayload) => void,
): () => void {
  remoteMacosVmEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteMacosVmEventCallbacks.delete(cb);
  };
}

function subscribeRemoteUsageUpdateEvents(
  cb: (payload: UsageSnapshot) => void,
): () => void {
  remoteUsageUpdateEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteUsageUpdateEventCallbacks.delete(cb);
  };
}

function subscribeRemoteUsageThresholdEvents(
  cb: (payload: UsageThresholdEvent) => void,
): () => void {
  remoteUsageThresholdEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteUsageThresholdEventCallbacks.delete(cb);
  };
}

function subscribeRemoteAutomationsEvents(
  cb: (payload: AutomationsEventPayload) => void,
): () => void {
  remoteAutomationsEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteAutomationsEventCallbacks.delete(cb);
  };
}

function subscribeRemoteConflictEvents(
  cb: (payload: ConflictEventPayload) => void,
): () => void {
  remoteConflictEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteConflictEventCallbacks.delete(cb);
  };
}

function subscribeRemoteGitHubStatusChangedEvents(
  cb: (payload: GitHubStatus) => void,
): () => void {
  remoteGitHubStatusChangedCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteGitHubStatusChangedCallbacks.delete(cb);
  };
}

function subscribeRemoteLinearWorkflowEvents(
  cb: (payload: LinearWorkflowEventPayload) => void,
): () => void {
  remoteLinearWorkflowEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLinearWorkflowEventCallbacks.delete(cb);
  };
}

function subscribeRemoteFeedbackEvents(
  cb: (payload: FeedbackSubmissionEvent) => void,
): () => void {
  remoteFeedbackEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteFeedbackEventCallbacks.delete(cb);
  };
}

function subscribeRemoteComputerUseEvents(
  cb: (payload: ComputerUseEventPayload) => void,
): () => void {
  remoteComputerUseEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteComputerUseEventCallbacks.delete(cb);
  };
}

function subscribeRemoteIosSimulatorEvents(
  cb: (payload: IosSimulatorEventPayload) => void,
): () => void {
  remoteIosSimulatorEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteIosSimulatorEventCallbacks.delete(cb);
  };
}

function subscribeRemoteAppControlEvents(
  cb: (payload: AppControlEventPayload) => void,
): () => void {
  remoteAppControlEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteAppControlEventCallbacks.delete(cb);
  };
}

function subscribeAgentChatEvents(
  cb: (payload: AgentChatEventEnvelope) => void,
): () => void {
  const removeLocal = agentChatEventFanout(cb);
  const removeRemote = subscribeRemoteAgentChatEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribePtyDataEvents(
  cb: (payload: PtyDataEvent) => void,
): () => void {
  const removeLocal = ptyDataEventFanout(cb);
  const removeRemote = subscribeRemotePtyDataEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribePtyExitEvents(
  cb: (payload: PtyExitEvent) => void,
): () => void {
  const removeLocal = ptyExitEventFanout(cb);
  const removeRemote = subscribeRemotePtyExitEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeMacosVmEvents(
  cb: (payload: MacosVmEventPayload) => void,
): () => void {
  const removeLocal = macosVmEventFanout(cb);
  const removeRemote = subscribeRemoteMacosVmEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeUsageUpdateEvents(
  cb: (payload: UsageSnapshot) => void,
): () => void {
  const removeLocal = subscribeLocalUsageUpdateEvents(cb);
  const removeRemote = subscribeRemoteUsageUpdateEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeUsageThresholdEvents(
  cb: (payload: UsageThresholdEvent) => void,
): () => void {
  const removeLocal = subscribeLocalUsageThresholdEvents(cb);
  const removeRemote = subscribeRemoteUsageThresholdEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeAutomationsEvents(
  cb: (payload: AutomationsEventPayload) => void,
): () => void {
  const removeLocal = subscribeLocalAutomationsEvents(cb);
  const removeRemote = subscribeRemoteAutomationsEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeConflictEvents(
  cb: (payload: ConflictEventPayload) => void,
): () => void {
  const removeLocal = subscribeLocalConflictEvents(cb);
  const removeRemote = subscribeRemoteConflictEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function isRebaseEventPayload(
  payload: ConflictEventPayload,
): payload is RebaseEventPayload {
  return (
    payload.type === "rebase-needs-updated" ||
    payload.type === "rebase-started" ||
    payload.type === "rebase-completed"
  );
}

function subscribeFeedbackEvents(
  cb: (payload: FeedbackSubmissionEvent) => void,
): () => void {
  const removeLocal = subscribeLocalFeedbackEvents(cb);
  const removeRemote = subscribeRemoteFeedbackEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeComputerUseEvents(
  cb: (payload: ComputerUseEventPayload) => void,
): () => void {
  const removeLocal = computerUseEventFanout(cb);
  const removeRemote = subscribeRemoteComputerUseEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeIosSimulatorEvents(
  cb: (payload: IosSimulatorEventPayload) => void,
): () => void {
  const removeLocal = iosSimulatorEventFanout(cb);
  const removeRemote = subscribeRemoteIosSimulatorEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeAppControlEvents(
  cb: (payload: AppControlEventPayload) => void,
): () => void {
  const removeLocal = appControlEventFanout(cb);
  const removeRemote = subscribeRemoteAppControlEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toAgentChatEventEnvelope(
  payload: unknown,
): AgentChatEventEnvelope | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.sessionId !== "string") return null;
  if (typeof payload.timestamp !== "string") return null;
  if (!isRecord(payload.event) || typeof payload.event.type !== "string")
    return null;
  return payload as unknown as AgentChatEventEnvelope;
}

function toTerminalSessionChangedEvent(
  payload: unknown,
): TerminalSessionChangedEvent | null {
  if (!isRecord(payload) || payload.type !== "terminal_session_changed")
    return null;
  const event = payload.event;
  if (!isRecord(event)) return null;
  if (typeof event.sessionId !== "string") return null;
  if (
    event.reason !== "meta-updated" &&
    event.reason !== "deleted" &&
    event.reason !== "created"
  )
    return null;
  return {
    sessionId: event.sessionId,
    reason: event.reason,
  };
}

function toWrappedEvent<T>(payload: unknown, type: string): T | null {
  if (!isRecord(payload) || payload.type !== type || !isRecord(payload.event))
    return null;
  return payload.event as T;
}

function toAutomationsRuntimeEvent(
  payload: unknown,
): AutomationsEventPayload | null {
  if (!isRecord(payload)) return null;
  if (payload.source !== "automations") return null;
  if (
    payload.type !== "runs-updated" &&
    payload.type !== "webhook-status-updated" &&
    payload.type !== "ingress-updated"
  ) {
    return null;
  }
  const event: Record<string, unknown> = { ...payload };
  delete event.source;
  return event as unknown as AutomationsEventPayload;
}

function toMacosVmRuntimeEvent(payload: unknown): MacosVmEventPayload | null {
  if (!isRecord(payload) || payload.type !== "macos_vm") return null;
  const eventType =
    typeof payload.eventType === "string" ? payload.eventType.trim() : "";
  if (!eventType) return null;
  const event: Record<string, unknown> = { ...payload, type: eventType };
  delete event.eventType;
  return event as unknown as MacosVmEventPayload;
}

function toProcessEvent(payload: unknown): ProcessEvent | null {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;
  if (payload.type === "runtime") {
    const runtime = payload.runtime;
    if (!isRecord(runtime)) return null;
    if (
      typeof runtime.laneId !== "string" ||
      typeof runtime.processId !== "string"
    )
      return null;
    return payload as unknown as ProcessEvent;
  }
  if (payload.type === "log") {
    if (typeof payload.runId !== "string") return null;
    if (
      typeof payload.laneId !== "string" ||
      typeof payload.processId !== "string"
    )
      return null;
    if (payload.stream !== "stdout" && payload.stream !== "stderr") return null;
    if (typeof payload.chunk !== "string" || typeof payload.ts !== "string")
      return null;
    return payload as unknown as ProcessEvent;
  }
  return null;
}

function toTestEvent(payload: unknown): TestEvent | null {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;
  if (payload.type === "run") {
    const run = payload.run;
    if (!isRecord(run)) return null;
    if (typeof run.id !== "string" || typeof run.suiteId !== "string")
      return null;
    return payload as unknown as TestEvent;
  }
  if (payload.type === "log") {
    if (
      typeof payload.runId !== "string" ||
      typeof payload.suiteId !== "string"
    )
      return null;
    if (payload.stream !== "stdout" && payload.stream !== "stderr") return null;
    if (typeof payload.chunk !== "string" || typeof payload.ts !== "string")
      return null;
    return payload as unknown as TestEvent;
  }
  return null;
}

function clearGitReadCaches(): void {
  diffChangesCache.clear();
  gitBranchesCache.clear();
  lanesListCache.clear();
  lanesListSnapshotsCache.clear();
  sessionDeltaCache.clear();
}

function normalizeLaneIdArg(args: unknown): string {
  const raw = typeof args === "string"
    ? args
    : isRecord(args) && typeof args.laneId === "string"
      ? args.laneId
      : null;
  const laneId = raw?.trim();
  if (!laneId) throw new Error("laneId is required.");
  return laneId;
}

function clearProjectScopedReadCaches(): void {
  clearGitReadCaches();
  githubStatusCache.clear();
  githubRemoteStatusCache.clear();
  projectConfigSnapshotCache.clear();
  agentChatSummaryCache.clear();
  computerUseOwnerSnapshotCache.clear();
  imageDataUrlCache.clear();
  projectIconCache.clear();
}

function clearIosSimulatorStatusCaches(): void {
  iosSimulatorStatusCache.clear();
  iosSimulatorDevicesCache.clear();
}

function getAiStatusCacheKey(args?: {
  refreshOpenCodeInventory?: boolean;
}): string {
  return serializeIpcCacheArgs({
    refreshOpenCodeInventory: args?.refreshOpenCodeInventory === true,
  });
}

async function clearAround<T>(
  clear: () => void,
  action: () => Promise<T>,
): Promise<T> {
  clear();
  try {
    return await action();
  } finally {
    clear();
  }
}

async function runProjectRuntimeTransition<T>(
  action: () => Promise<T>,
): Promise<T> {
  projectRuntimeTransitionDepth += 1;
  try {
    return await action();
  } finally {
    projectRuntimeTransitionDepth = Math.max(0, projectRuntimeTransitionDepth - 1);
  }
}

function createIpcEventFanout<T>(
  channel: string,
  beforeDispatch?: (payload: T) => void,
): (cb: (payload: T) => void) => () => void {
  const callbacks = new Set<(payload: T) => void>();
  let subscribed = false;
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => {
    beforeDispatch?.(payload);
    for (const cb of [...callbacks]) {
      // Isolate subscribers: a single throwing listener must not abort
      // delivery to the rest of the fanout.
      try {
        cb(payload);
      } catch (error) {
        console.error(
          `preload IPC fanout listener failed for ${channel}`,
          error,
        );
      }
    }
  };

  return (cb: (payload: T) => void) => {
    callbacks.add(cb);
    if (!subscribed) {
      ipcRenderer.on(channel, listener);
      subscribed = true;
    }
    return () => {
      callbacks.delete(cb);
      if (callbacks.size === 0 && subscribed) {
        ipcRenderer.removeListener(channel, listener);
        subscribed = false;
      }
    };
  };
}

const agentChatEventFanout = createIpcEventFanout<AgentChatEventEnvelope>(
  IPC.agentChatEvent,
  // Streamed/background agent activity changes session state too — invalidate
  // the 1s summary cache before listeners can read a stale value.
  () => agentChatSummaryCache.clear(),
);
const computerUseEventFanout = createIpcEventFanout<ComputerUseEventPayload>(
  IPC.computerUseEvent,
  () => computerUseOwnerSnapshotCache.clear(),
);
const iosSimulatorEventFanout = createIpcEventFanout<IosSimulatorEventPayload>(
  IPC.iosSimulatorEvent,
  () => clearIosSimulatorStatusCaches(),
);
const appControlEventFanout = createIpcEventFanout<AppControlEventPayload>(
  IPC.appControlEvent,
  () => appControlStatusCache.clear(),
);
const builtInBrowserEventFanout =
  createIpcEventFanout<BuiltInBrowserEventPayload>(
    IPC.builtInBrowserEvent,
    () => builtInBrowserStatusCache.clear(),
  );
const macosVmEventFanout = createIpcEventFanout<MacosVmEventPayload>(
  IPC.macosVmEvent,
  () => macosVmStatusCache.clear(),
);
const projectStateEventFanout = createIpcEventFanout<AdeProjectEvent>(
  IPC.projectStateEvent,
);
const ptyDataEventFanout = createIpcEventFanout<PtyDataEvent>(IPC.ptyData);
const ptyExitEventFanout = createIpcEventFanout<PtyExitEvent>(IPC.ptyExit);

contextBridge.exposeInMainWorld("ade", {
  app: {
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    getProject: async (): Promise<ProjectInfo | null> =>
      ipcRenderer.invoke(IPC.appGetProject),
    getWindowSession: async (): Promise<{
      windowId: number | null;
      project: ProjectInfo | null;
      binding: OpenProjectBinding | null;
      openProjectTabs: ProjectInfo[];
    }> => {
      const session = (await ipcRenderer.invoke(IPC.appGetWindowSession)) as {
        windowId: number | null;
        project: ProjectInfo | null;
        binding: OpenProjectBinding | null;
        openProjectTabs?: ProjectInfo[];
      };
      rememberProjectBinding(session.binding);
      return { ...session, openProjectTabs: session.openProjectTabs ?? [] };
    },
    setWindowProjectTabs: async (
      rootPaths: string[],
    ): Promise<{ openProjectTabs: ProjectInfo[] }> =>
      ipcRenderer.invoke(IPC.appSetWindowProjectTabs, { rootPaths }),
    newWindow: async (): Promise<{ windowId: number | null }> =>
      ipcRenderer.invoke(IPC.appNewWindow),
    openProjectInNewWindow: async (
      rootPath: string,
    ): Promise<{ windowId: number | null; project: ProjectInfo | null }> =>
      ipcRenderer.invoke(IPC.appOpenProjectInNewWindow, { rootPath }),
    closeWindow: async (
      windowId?: number | null,
    ): Promise<{ closed: boolean }> =>
      ipcRenderer.invoke(IPC.appCloseWindow, { windowId: windowId ?? null }),
    onProjectChanged: (cb: (project: ProjectInfo | null) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProjectInfo | null,
      ) => {
        clearProjectScopedReadCaches();
        cb(payload);
      };
      ipcRenderer.on(IPC.appProjectChanged, listener);
      return () => ipcRenderer.removeListener(IPC.appProjectChanged, listener);
    },
    onProjectBindingChanged: (
      cb: (binding: OpenProjectBinding | null) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: OpenProjectBinding | null,
      ) => {
        rememberProjectBinding(payload);
        clearProjectScopedReadCaches();
        cb(payload);
      };
      ipcRenderer.on(IPC.appProjectBindingChanged, listener);
      return () =>
        ipcRenderer.removeListener(IPC.appProjectBindingChanged, listener);
    },
    onNavigate: (cb: (request: AppNavigationRequest) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: AppNavigationRequest,
      ) => cb(payload);
      ipcRenderer.on(IPC.appNavigate, listener);
      return () => ipcRenderer.removeListener(IPC.appNavigate, listener);
    },
    openExternal: async (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.appOpenExternal, { url }),
    revealPath: async (path: string): Promise<void> => {
      await assertNotRemoteProjectPathAction("Reveal path", [path]);
      return ipcRenderer.invoke(IPC.appRevealPath, { path });
    },
    openPath: async (path: string): Promise<void> => {
      await assertNotRemoteProjectPathAction("Open path", [path]);
      return ipcRenderer.invoke(IPC.appOpenPath, { path });
    },
    writeClipboardText: async (text: string): Promise<void> =>
      ipcRenderer.invoke(IPC.appWriteClipboardText, { text }),
    readClipboardText: async (): Promise<string> =>
      ipcRenderer.invoke(IPC.appReadClipboardText),
    hasClipboardImage: async (): Promise<boolean> =>
      ipcRenderer.invoke(IPC.appHasClipboardImage),
    readClipboardImage: async (): Promise<{
      data: string;
      filename: string;
      mimeType: string;
    } | null> => ipcRenderer.invoke(IPC.appReadClipboardImage),
    saveClipboardImageAttachment: async (): Promise<{
      path: string;
      mimeType: string;
      previewDataUrl: string | null;
    } | null> => ipcRenderer.invoke(IPC.appSaveClipboardImageAttachment),
    getImageDataUrl: async (path: string): Promise<{ dataUrl: string }> => {
      await assertNotRemoteProjectPathAction("Read image file", [path]);
      return imageDataUrlCache.get(path);
    },
    writeClipboardImage: async (path: string): Promise<void> => {
      await assertNotRemoteProjectPathAction("Write clipboard image", [path]);
      return ipcRenderer.invoke(IPC.appWriteClipboardImage, { path });
    },
    openPathInEditor: async (args: {
      rootPath: string;
      relativePath?: string;
      target: "default" | "finder" | "vscode" | "cursor" | "zed";
    }): Promise<void> => {
      await assertNotRemoteProjectPathAction("Open path in editor", [
        args.rootPath,
      ]);
      return ipcRenderer.invoke(IPC.appOpenPathInEditor, args);
    },
    logDebugEvent: (
      event: string,
      payload: Record<string, unknown> = {},
    ): void => ipcRenderer.send(IPC.appLogDebugEvent, { event, payload }),
  },
  project: {
    openRepo: async (args?: { rootPath?: string }): Promise<ProjectInfo | null> => {
      // `clearAround` runs its cleanup callback both before AND after the
      // action. Nulling the binding inside that callback meant a successful
      // open clobbered the freshly-published binding (set by the
      // appProjectBindingChanged listener) and disabled runtime routing /
      // event pumping until another refresh restored it. Null once up front;
      // the listener handles the post-action update.
      rememberProjectBinding(null);
      return clearAround(
        () => {
          clearProjectScopedReadCaches();
        },
        () => runProjectRuntimeTransition(() =>
          ipcRenderer.invoke(IPC.projectOpenRepo, args ?? {}),
        ),
      );
    },
    chooseDirectory: async (
      args: { title?: string; defaultPath?: string } = {},
    ): Promise<string | null> =>
      ipcRenderer.invoke(IPC.projectChooseDirectory, args),
    browseDirectories: async (
      args: ProjectBrowseInput = {},
    ): Promise<ProjectBrowseResult> =>
      ipcRenderer.invoke(IPC.projectBrowseDirectories, args),
    getDetail: async (rootPath: string): Promise<ProjectDetail> =>
      ipcRenderer.invoke(IPC.projectGetDetail, { rootPath }),
    resolveIcon: async (rootPath: string): Promise<ProjectIcon> =>
      projectIconCache.get(rootPath),
    chooseIcon: async (rootPath: string): Promise<ProjectIcon | null> =>
      clearAround(
        () => {
          imageDataUrlCache.clear();
          projectIconCache.clear(rootPath);
        },
        () => ipcRenderer.invoke(IPC.projectChooseIcon, { rootPath }),
      ),
    removeIcon: async (rootPath: string): Promise<ProjectIcon> =>
      clearAround(
        () => {
          imageDataUrlCache.clear();
          projectIconCache.clear(rootPath);
        },
        () => ipcRenderer.invoke(IPC.projectRemoveIcon, { rootPath }),
      ),
    getDroppedPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
    openAdeFolder: async (): Promise<void> =>
      ipcRenderer.invoke(IPC.projectOpenAdeFolder),
    clearLocalData: async (
      args: ClearLocalAdeDataArgs = {},
    ): Promise<ClearLocalAdeDataResult> =>
      clearAround(
        () => clearProjectScopedReadCaches(),
        () =>
          callProjectRuntimeActionOr(
            "ade_project",
            "clearLocalData",
            { args },
            () => ipcRenderer.invoke(IPC.projectClearLocalData, args),
          ),
      ),
    listRecent: async (): Promise<RecentProjectSummary[]> =>
      ipcRenderer.invoke(IPC.projectListRecent),
    closeCurrent: async (): Promise<void> =>
      clearAround(
        () => {
          rememberProjectBinding(null);
          clearProjectScopedReadCaches();
        },
        () => runProjectRuntimeTransition(() =>
          ipcRenderer.invoke(IPC.projectCloseCurrent),
        ),
      ),
    switchToPath: async (rootPath: string): Promise<ProjectInfo> => {
      // See openRepo above: `clearAround` runs cleanup twice, so nulling the
      // binding inside it would clobber the new one set by the
      // appProjectBindingChanged listener.
      const normalizedRootPath = typeof rootPath === "string" ? rootPath.trim() : "";
      if (!normalizedRootPath) {
        throw new Error("Project root path is required.");
      }
      const previousBinding = currentProjectBinding;
      try {
        const project = await clearAround(
          () => {
            clearProjectScopedReadCaches();
          },
          () => runProjectRuntimeTransition(() =>
            ipcRenderer.invoke(IPC.projectSwitchToPath, { rootPath: normalizedRootPath }),
          ),
        );
        rememberProjectBinding(
          localProjectBindingForRoot(project?.rootPath ?? normalizedRootPath),
        );
        return project;
      } catch (error) {
        rememberProjectBinding(previousBinding);
        throw error;
      }
    },
    forgetRecent: async (rootPath: string): Promise<RecentProjectSummary[]> =>
      ipcRenderer.invoke(IPC.projectForgetRecent, { rootPath }),
    reorderRecent: async (
      orderedPaths: string[],
    ): Promise<RecentProjectSummary[]> =>
      ipcRenderer.invoke(IPC.projectReorderRecent, { orderedPaths }),
    createLocal: async (
      input: CreateProjectInput,
    ): Promise<CreateProjectResult> =>
      ipcRenderer.invoke(IPC.projectCreateLocal, input),
    clone: async (input: CloneProjectInput): Promise<CloneProjectResult> =>
      ipcRenderer.invoke(IPC.projectClone, input),
    getDefaultParentDir: async (): Promise<string> =>
      ipcRenderer.invoke(IPC.projectGetDefaultParentDir),
    getSnapshot: async (): Promise<AdeProjectSnapshot> =>
      callProjectRuntimeActionOr("ade_project", "getSnapshot", {}, () =>
        ipcRenderer.invoke(IPC.projectStateGetSnapshot),
      ),
    initializeOrRepair: async (): Promise<AdeCleanupResult> =>
      callProjectRuntimeActionOr("ade_project", "initializeOrRepair", {}, () =>
        ipcRenderer.invoke(IPC.projectStateInitializeOrRepair),
      ),
    runIntegrityCheck: async (): Promise<AdeCleanupResult> =>
      callProjectRuntimeActionOr("ade_project", "runIntegrityCheck", {}, () =>
        ipcRenderer.invoke(IPC.projectStateRunIntegrityCheck),
      ),
    onMissing: (cb: (data: { rootPath: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { rootPath: string },
      ) => cb(payload);
      ipcRenderer.on(IPC.projectMissing, listener);
      return () => ipcRenderer.removeListener(IPC.projectMissing, listener);
    },
    onStateEvent: (cb: (event: AdeProjectEvent) => void) => {
      const removeLocal = projectStateEventFanout(cb);
      const removeRemote = subscribeRemoteProjectStateEvents(cb);
      return () => {
        removeRemote();
        removeLocal();
      };
    },
  },
  remoteRuntime: {
    listTargets: async (): Promise<RemoteRuntimeTarget[]> =>
      ipcRenderer.invoke(IPC.remoteRuntimeListTargets),
    getConnectionSnapshot: async (): Promise<RemoteRuntimeConnectionSnapshot> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetConnectionSnapshot),
    onConnectionSnapshotChanged: (
      cb: (snapshot: RemoteRuntimeConnectionSnapshot) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RemoteRuntimeConnectionSnapshot,
      ) => cb(payload);
      ipcRenderer.on(IPC.remoteRuntimeConnectionSnapshotChanged, listener);
      return () =>
        ipcRenderer.removeListener(
          IPC.remoteRuntimeConnectionSnapshotChanged,
          listener,
        );
    },
    listDiscoveredMachines: async (): Promise<
      RemoteRuntimeDiscoveryResult
    > => ipcRenderer.invoke(IPC.remoteRuntimeListDiscoveredMachines),
    saveTarget: async (
      input: RemoteRuntimeTargetInput,
    ): Promise<RemoteRuntimeTarget> =>
      ipcRenderer.invoke(IPC.remoteRuntimeSaveTarget, input),
    removeTarget: async (id: string): Promise<{ removed: boolean }> =>
      ipcRenderer.invoke(IPC.remoteRuntimeRemoveTarget, { id }),
    connect: async (id: string): Promise<RemoteRuntimeConnectResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeConnect, { id }),
    listProjects: async (id: string): Promise<RemoteRuntimeProjectRecord[]> =>
      ipcRenderer.invoke(IPC.remoteRuntimeListProjects, { id }),
    addProject: async (
      id: string,
      rootPath: string,
    ): Promise<RemoteRuntimeProjectRecord> =>
      ipcRenderer.invoke(IPC.remoteRuntimeAddProject, { id, rootPath }),
    browseDirectories: async (
      id: string,
      args: ProjectBrowseInput = {},
    ): Promise<ProjectBrowseResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeBrowseDirectories, { id, args }),
    getProjectDetail: async (
      id: string,
      rootPath: string,
    ): Promise<ProjectDetail> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetProjectDetail, { id, rootPath }),
    getDefaultParentDir: async (id: string): Promise<string> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetDefaultParentDir, { id }),
    createProject: async (
      id: string,
      input: CreateProjectInput,
    ): Promise<RemoteRuntimeProjectRecord> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCreateProject, { id, input }),
    cloneProject: async (
      id: string,
      input: CloneProjectInput,
    ): Promise<RemoteRuntimeProjectRecord> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCloneProject, { id, input }),
    listMyGitHubRepos: async (
      id: string,
      input: ListMyGitHubReposInput = {},
    ): Promise<ListMyGitHubReposResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeListMyGitHubRepos, { id, input }),
    openProject: async (
      id: string,
      projectId: string,
    ): Promise<OpenProjectBinding> => {
      const binding = (await ipcRenderer.invoke(IPC.remoteRuntimeOpenProject, {
        id,
        projectId,
      })) as OpenProjectBinding;
      rememberProjectBinding(binding);
      return binding;
    },
    callAction: async (
      id: string,
      projectId: string,
      request: RemoteRuntimeActionRequest,
    ): Promise<RemoteRuntimeActionResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCallAction, {
        id,
        projectId,
        request,
      }),
    streamEvents: async (
      id: string,
      projectId: string,
      request: RemoteRuntimeStreamEventsRequest = {},
    ): Promise<RemoteRuntimeStreamEventsResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeStreamEvents, {
        id,
        projectId,
        request,
      }),
    checkLocalWork: async (
      id: string,
      project: RemoteRuntimeProjectRecord,
    ): Promise<RemoteRuntimeLocalWorkCheckResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCheckLocalWork, { id, project }),
    disconnect: async (id: string): Promise<{ disconnected: boolean }> =>
      ipcRenderer.invoke(IPC.remoteRuntimeDisconnect, { id }),
  },
  keybindings: {
    get: async (): Promise<KeybindingsSnapshot> =>
      callProjectRuntimeActionOr("keybindings", "get", {}, () =>
        ipcRenderer.invoke(IPC.keybindingsGet),
      ),
    set: async (
      overrides: KeybindingOverride[],
    ): Promise<KeybindingsSnapshot> =>
      callProjectRuntimeActionOr(
        "keybindings",
        "set",
        { args: { overrides } },
        () => ipcRenderer.invoke(IPC.keybindingsSet, { overrides }),
      ),
  },
  ai: {
    getStatus: async (args?: {
      force?: boolean;
      refreshOpenCodeInventory?: boolean;
    }): Promise<AiSettingsStatus> => {
      const cacheKey = getAiStatusCacheKey(args);
      if (args?.force === true) {
        aiStatusCache.clear();
        return callProjectRuntimeActionOr("ai", "getStatus", { args }, () =>
          ipcRenderer.invoke(IPC.aiGetStatus, args),
        );
      }
      return aiStatusCache.get(cacheKey);
    },
    getOpenCodeRuntimeDiagnostics: async (): Promise<OpenCodeRuntimeSnapshot> =>
      callProjectRuntimeActionOr("ai", "getOpenCodeRuntimeDiagnostics", {}, () =>
        ipcRenderer.invoke(IPC.aiGetOpenCodeRuntimeDiagnostics),
      ),
    isOpenCodeInstalled: async (): Promise<{ installed: boolean; source: "user-installed" | "bundled" | "missing" }> =>
      callProjectRuntimeActionOr("ai", "isOpenCodeInstalled", {}, () =>
        ipcRenderer.invoke(IPC.aiIsOpenCodeInstalled),
      ),
    storeApiKey: async (provider: string, key: string): Promise<void> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "ai",
            "storeApiKey",
            { args: { provider, key } },
            () => ipcRenderer.invoke(IPC.aiStoreApiKey, { provider, key }),
          ),
      ),
    deleteApiKey: async (provider: string): Promise<void> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "ai",
            "deleteApiKey",
            { args: { provider } },
            () => ipcRenderer.invoke(IPC.aiDeleteApiKey, { provider }),
          ),
      ),
    listApiKeys: async (): Promise<string[]> =>
      callProjectRuntimeActionOr("ai", "listApiKeys", {}, () =>
        ipcRenderer.invoke(IPC.aiListApiKeys),
      ),
    verifyApiKey: async (
      provider: string,
    ): Promise<AiApiKeyVerificationResult> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "ai",
            "verifyApiKeyConnection",
            { args: { provider } },
            () => ipcRenderer.invoke(IPC.aiVerifyApiKey, { provider }),
          ),
      ),
    updateConfig: async (config: Partial<AiConfig>): Promise<void> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "ai",
            "updateConfig",
            { args: config },
            () => ipcRenderer.invoke(IPC.aiUpdateConfig, config),
          ),
      ),
    cursorCloudListRepositories: async (): Promise<CursorCloudRepository[]> =>
      callProjectRuntimeActionOr("ai", "listCursorCloudRepositories", {}, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudListRepositories),
      ),
    cursorCloudListAgents: async (args?: {
      includeArchived?: boolean;
      limit?: number;
      cursor?: string | null;
    }): Promise<CursorCloudListAgentsResult> =>
      callProjectRuntimeActionOr(
        "ai",
        "listCursorCloudAgents",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.aiCursorCloudListAgents, args ?? {}),
      ),
    cursorCloudListRuns: async (args: {
      agentId: string;
      limit?: number;
      cursor?: string | null;
    }): Promise<CursorCloudListRunsResult> =>
      callProjectRuntimeActionOr("ai", "listCursorCloudRuns", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudListRuns, args),
      ),
    cursorCloudCreateRun: async (
      args: CursorCloudCreateRunRequest,
    ): Promise<CursorCloudCreateRunResult> =>
      callProjectRuntimeActionOr("ai", "createCursorCloudRun", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudCreateRun, args),
      ),
    cursorCloudArchiveAgent: async (agentId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "ai",
        "archiveCursorCloudAgent",
        { args: { agentId } },
        () => ipcRenderer.invoke(IPC.aiCursorCloudArchiveAgent, { agentId }),
      ),
    cursorCloudUnarchiveAgent: async (agentId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "ai",
        "unarchiveCursorCloudAgent",
        { args: { agentId } },
        () => ipcRenderer.invoke(IPC.aiCursorCloudUnarchiveAgent, { agentId }),
      ),
    cursorCloudDeleteAgent: async (agentId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "ai",
        "deleteCursorCloudAgent",
        { args: { agentId } },
        () => ipcRenderer.invoke(IPC.aiCursorCloudDeleteAgent, { agentId }),
      ),
    cursorCloudGetAgent: async (
      agentId: string,
    ): Promise<CursorCloudAgentSummary | null> =>
      callProjectRuntimeActionOr(
        "ai",
        "getCursorCloudAgent",
        { args: { agentId } },
        () => ipcRenderer.invoke(IPC.aiCursorCloudGetAgent, { agentId }),
      ),
    cursorCloudStreamRun: async (
      args: CursorCloudStreamRunRequest,
    ): Promise<CursorCloudStreamRunResult> =>
      callProjectRuntimeActionOr("ai", "cursorCloudStreamRun", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudStreamRun, args),
      ),
    cursorCloudCancelRun: async (args: {
      agentId: string;
      runId: string;
    }): Promise<void> =>
      callProjectRuntimeActionOr("ai", "cancelCursorCloudRun", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudCancelRun, args),
      ),
    cursorCloudFollowUp: async (
      args: CursorCloudFollowUpRequest,
    ): Promise<CursorCloudFollowUpResult> =>
      callProjectRuntimeActionOr("ai", "cursorCloudFollowUp", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudFollowUp, args),
      ),
    cursorCloudListArtifacts: async (
      agentId: string,
    ): Promise<CursorCloudArtifactSummary[]> =>
      callProjectRuntimeActionOr(
        "ai",
        "listCursorCloudArtifacts",
        { args: { agentId } },
        () => ipcRenderer.invoke(IPC.aiCursorCloudListArtifacts, { agentId }),
      ),
    cursorCloudDownloadArtifact: async (args: {
      agentId: string;
      path: string;
    }): Promise<CursorCloudArtifactDownload> =>
      callProjectRuntimeActionOr(
        "ai",
        "downloadCursorCloudArtifact",
        { args },
        () => ipcRenderer.invoke(IPC.aiCursorCloudDownloadArtifact, args),
      ),
    cursorCloudOpenChat: async (
      args: CursorCloudOpenChatRequest,
    ): Promise<CursorCloudOpenChatResult> =>
      callProjectRuntimeActionOr("ai", "openCursorCloudChat", { args }, () =>
        ipcRenderer.invoke(IPC.aiCursorCloudOpenChat, args),
      ),
  },
  modelPicker: {
    getFavorites: async (): Promise<{ favorites: string[] }> =>
      callProjectRuntimeSyncOr("modelPicker.getFavorites", {}, async () => ({ favorites: [] })),
    setFavorites: async (favorites: string[]): Promise<{ favorites: string[] }> =>
      callProjectRuntimeSyncOr("modelPicker.setFavorites", { favorites }, async () => ({
        favorites,
      })),
    toggleFavorite: async (
      modelId: string,
    ): Promise<{ favorites: string[]; isFavorite: boolean }> =>
      callProjectRuntimeSyncOr("modelPicker.toggleFavorite", { modelId }, async () => ({
        favorites: [],
        isFavorite: false,
      })),
    getRecents: async (): Promise<{ recents: string[] }> =>
      callProjectRuntimeSyncOr("modelPicker.getRecents", {}, async () => ({ recents: [] })),
    pushRecent: async (modelId: string): Promise<{ recents: string[] }> =>
      callProjectRuntimeSyncOr("modelPicker.pushRecent", { modelId }, async () => ({
        recents: [],
      })),
  },
  sync: {
    getStatus: async (args?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.getStatus", args ?? {}, () =>
        ipcRenderer.invoke(IPC.syncGetStatus, args),
      ),
    refreshDiscovery: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.refreshDiscovery", {}, () =>
        ipcRenderer.invoke(IPC.syncRefreshDiscovery),
      ),
    listDevices: async (): Promise<SyncDeviceRuntimeState[]> =>
      callProjectRuntimeSyncOr("sync.listDevices", {}, () =>
        ipcRenderer.invoke(IPC.syncListDevices),
      ),
    updateLocalDevice: async (args: {
      name?: string;
      deviceType?: SyncPeerDeviceType;
    }): Promise<SyncDeviceRecord> =>
      callProjectRuntimeSyncOr("sync.updateLocalDevice", args, () =>
        ipcRenderer.invoke(IPC.syncUpdateLocalDevice, args),
      ),
    connectToBrain: async (
      draft: SyncDesktopConnectionDraft,
    ): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr(
        "sync.connectToBrain",
        draft as unknown as Record<string, unknown>,
        () => ipcRenderer.invoke(IPC.syncConnectToBrain, draft),
      ),
    disconnectFromBrain: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.disconnectFromBrain", {}, () =>
        ipcRenderer.invoke(IPC.syncDisconnectFromBrain),
      ),
    forgetDevice: async (deviceId: string): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.forgetDevice", { deviceId }, () =>
        ipcRenderer.invoke(IPC.syncForgetDevice, { deviceId }),
      ),
    getTransferReadiness: async (): Promise<SyncTransferReadiness> =>
      callProjectRuntimeSyncOr("sync.getTransferReadiness", {}, () =>
        ipcRenderer.invoke(IPC.syncGetTransferReadiness),
      ),
    transferBrainToLocal: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.transferBrainToLocal", {}, () =>
        ipcRenderer.invoke(IPC.syncTransferBrainToLocal),
      ),
    getPin: async (): Promise<{ pin: string | null }> =>
      callProjectRuntimeSyncOr("sync.getPin", {}, () =>
        ipcRenderer.invoke(IPC.syncGetPin),
      ),
    setPin: async (pin: string): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.setPin", { pin }, () =>
        ipcRenderer.invoke(IPC.syncSetPin, pin),
      ),
    generatePin: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.generatePin", {}, () =>
        ipcRenderer.invoke(IPC.syncGeneratePin),
      ),
    clearPin: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.clearPin", {}, () =>
        ipcRenderer.invoke(IPC.syncClearPin),
      ),
    setActiveLanePresence: async (args: { laneIds: string[] }): Promise<void> =>
      callProjectRuntimeSyncOr("sync.setActiveLanePresence", args, () =>
        ipcRenderer.invoke(IPC.syncSetActiveLanePresence, args),
      ),
    onEvent: (cb: (event: SyncStatusEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: SyncStatusEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.syncEvent, listener);
      const removeRemote = subscribeRemoteSyncStatusEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.syncEvent, listener);
      };
    },
  },
  notifications: {
    apns: {
      getStatus: async (): Promise<ApnsBridgeStatus> =>
        callProjectRuntimeActionOr("notifications_apns", "getStatus", {}, () =>
          ipcRenderer.invoke(IPC.notificationsApnsGetStatus),
        ),
      saveConfig: async (
        args: ApnsBridgeSaveConfigArgs,
      ): Promise<ApnsBridgeStatus> =>
        callProjectRuntimeActionOr("notifications_apns", "saveConfig", { args }, () =>
          ipcRenderer.invoke(IPC.notificationsApnsSaveConfig, args),
        ),
      uploadKey: async (
        args: ApnsBridgeUploadKeyArgs,
      ): Promise<ApnsBridgeStatus> =>
        callProjectRuntimeActionOr("notifications_apns", "uploadKey", { args }, () =>
          ipcRenderer.invoke(IPC.notificationsApnsUploadKey, args),
        ),
      clearKey: async (): Promise<ApnsBridgeStatus> =>
        callProjectRuntimeActionOr("notifications_apns", "clearKey", {}, () =>
          ipcRenderer.invoke(IPC.notificationsApnsClearKey),
        ),
      sendTestPush: async (
        args: ApnsBridgeSendTestPushArgs,
      ): Promise<ApnsBridgeSendTestPushResult> =>
        callProjectRuntimeActionOr("notifications_apns", "sendTestPush", { args }, () =>
          ipcRenderer.invoke(IPC.notificationsApnsSendTestPush, args),
        ),
    },
  },
  agentTools: {
    detect: async (): Promise<AgentTool[]> =>
      ipcRenderer.invoke(IPC.agentToolsDetect),
  },
  adeCli: {
    getStatus: async (): Promise<AdeCliStatus> =>
      ipcRenderer.invoke(IPC.adeCliGetStatus),
    installForUser: async (): Promise<AdeCliInstallResult> =>
      ipcRenderer.invoke(IPC.adeCliInstallForUser),
  },
  devTools: {
    detect: async (force?: boolean): Promise<DevToolsCheckResult> =>
      ipcRenderer.invoke(IPC.devToolsDetect, { force }),
  },
  onboarding: {
    getStatus: async (): Promise<OnboardingStatus> =>
      callProjectRuntimeActionOr("onboarding", "getStatus", {}, () =>
        ipcRenderer.invoke(IPC.onboardingGetStatus),
      ),
    detectDefaults: async (): Promise<OnboardingDetectionResult> =>
      callProjectRuntimeActionOr("onboarding", "detectDefaults", {}, () =>
        ipcRenderer.invoke(IPC.onboardingDetectDefaults),
      ),
    detectExistingLanes: async (): Promise<OnboardingExistingLaneCandidate[]> =>
      callProjectRuntimeActionOr("onboarding", "detectExistingLanes", {}, () =>
        ipcRenderer.invoke(IPC.onboardingDetectExistingLanes),
      ),
    setDismissed: async (dismissed: boolean): Promise<OnboardingStatus> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "setDismissed",
        { arg: dismissed },
        () => ipcRenderer.invoke(IPC.onboardingSetDismissed, { dismissed }),
      ),
    complete: async (): Promise<OnboardingStatus> =>
      callProjectRuntimeActionOr("onboarding", "complete", {}, () =>
        ipcRenderer.invoke(IPC.onboardingComplete),
      ),
    getTourProgress: async (): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr("onboarding", "getTourProgress", {}, () =>
        ipcRenderer.invoke(IPC.onboardingGetTourProgress),
      ),
    markWizardCompleted: async (): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr("onboarding", "markWizardCompleted", {}, () =>
        ipcRenderer.invoke(IPC.onboardingMarkWizardCompleted),
      ),
    markWizardDismissed: async (): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr("onboarding", "markWizardDismissed", {}, () =>
        ipcRenderer.invoke(IPC.onboardingMarkWizardDismissed),
      ),
    markTourCompleted: async (
      tourId: string,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markTourCompleted",
        { arg: tourId },
        () => ipcRenderer.invoke(IPC.onboardingMarkTourCompleted, { tourId }),
      ),
    markTourDismissed: async (
      tourId: string,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markTourDismissed",
        { arg: tourId },
        () => ipcRenderer.invoke(IPC.onboardingMarkTourDismissed, { tourId }),
      ),
    updateTourStep: async (
      tourId: string,
      index: number,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "updateTourStep",
        { argsList: [tourId, index] },
        () =>
          ipcRenderer.invoke(IPC.onboardingUpdateTourStep, { tourId, index }),
      ),
    markGlossaryTermSeen: async (
      termId: string,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markGlossaryTermSeen",
        { arg: termId },
        () =>
          ipcRenderer.invoke(IPC.onboardingMarkGlossaryTermSeen, { termId }),
      ),
    resetTourProgress: async (
      tourId?: string,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "resetTourProgress",
        { arg: tourId },
        () => ipcRenderer.invoke(IPC.onboardingResetTourProgress, { tourId }),
      ),
    markTourCompletedVariant: async (
      tourId: string,
      variant: OnboardingTourVariant,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markTourCompleted",
        { argsList: [tourId, variant] },
        () =>
          ipcRenderer.invoke(IPC.onboardingMarkTourCompletedVariant, {
            tourId,
            variant,
          }),
      ),
    markTourDismissedVariant: async (
      tourId: string,
      variant: OnboardingTourVariant,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markTourDismissed",
        { argsList: [tourId, variant] },
        () =>
          ipcRenderer.invoke(IPC.onboardingMarkTourDismissedVariant, {
            tourId,
            variant,
          }),
      ),
    updateTourStepVariant: async (
      tourId: string,
      variant: OnboardingTourVariant,
      index: number,
    ): Promise<OnboardingTourProgress> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "updateTourStep",
        { argsList: [tourId, index, variant] },
        () =>
          ipcRenderer.invoke(IPC.onboardingUpdateTourStepVariant, {
            tourId,
            variant,
            index,
          }),
      ),
    tutorial: {
      start: async (): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "markTutorialStarted",
          {},
          () => ipcRenderer.invoke(IPC.onboardingTutorialStart),
        ),
      dismiss: async (permanent: boolean): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "markTutorialDismissed",
          { arg: permanent },
          () =>
            ipcRenderer.invoke(IPC.onboardingTutorialDismiss, { permanent }),
        ),
      complete: async (): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "markTutorialCompleted",
          {},
          () => ipcRenderer.invoke(IPC.onboardingTutorialComplete),
        ),
      updateAct: async (
        actIndex: number,
        ctxSnapshot?: Record<string, unknown>,
      ): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "updateTutorialAct",
          { argsList: [actIndex, ctxSnapshot] },
          () =>
            ipcRenderer.invoke(IPC.onboardingTutorialUpdateAct, {
              actIndex,
              ctxSnapshot,
            }),
        ),
      setSilenced: async (silenced: boolean): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "setTutorialSilenced",
          { arg: silenced },
          () =>
            ipcRenderer.invoke(IPC.onboardingTutorialSetSilenced, { silenced }),
        ),
      clearSessionDismissal: async (): Promise<OnboardingTourProgress> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "clearTutorialSessionDismissal",
          {},
          () => ipcRenderer.invoke(IPC.onboardingTutorialClearSessionDismissal),
        ),
      shouldPrompt: async (): Promise<boolean> =>
        callProjectRuntimeActionOr(
          "onboarding",
          "shouldPromptTutorial",
          {},
          () => ipcRenderer.invoke(IPC.onboardingTutorialShouldPrompt),
        ),
    },
  },
  automations: {
    list: async (): Promise<AutomationRuleSummary[]> =>
      callProjectRuntimeActionOr("automations", "list", {}, () =>
        ipcRenderer.invoke(IPC.automationsList),
      ),
    toggle: async (args: {
      id: string;
      enabled: boolean;
    }): Promise<AutomationRuleSummary[]> =>
      callProjectRuntimeActionOr("automations", "toggleRule", { args }, () =>
        ipcRenderer.invoke(IPC.automationsToggle, args),
      ),
    deleteRule: async (
      args: AutomationDeleteRuleRequest,
    ): Promise<AutomationRuleSummary[]> =>
      callProjectRuntimeActionOr("automations", "deleteRule", { args }, () =>
        ipcRenderer.invoke(IPC.automationsDeleteRule, args),
      ),
    triggerManually: async (
      args: AutomationManualTriggerRequest,
    ): Promise<AutomationRun> =>
      callProjectRuntimeActionOr(
        "automations",
        "triggerManually",
        { args },
        () => ipcRenderer.invoke(IPC.automationsTriggerManually, args),
      ),
    getHistory: async (args: {
      id: string;
      limit?: number;
    }): Promise<AutomationRun[]> =>
      callProjectRuntimeActionOr("automations", "getHistory", { args }, () =>
        ipcRenderer.invoke(IPC.automationsGetHistory, args),
      ),
    listRuns: async (args?: AutomationRunListArgs): Promise<AutomationRun[]> =>
      callProjectRuntimeActionOr(
        "automations",
        "listRuns",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.automationsListRuns, args ?? {}),
      ),
    getRunDetail: async (runId: string): Promise<AutomationRunDetail | null> =>
      callProjectRuntimeActionOr(
        "automations",
        "getRunDetail",
        { args: { runId } },
        () => ipcRenderer.invoke(IPC.automationsGetRunDetail, { runId }),
      ),
    getIngressStatus: async (): Promise<AutomationIngressStatus> =>
      callProjectRuntimeActionOr("automations", "getIngressStatus", {}, () =>
        ipcRenderer.invoke(IPC.automationsGetIngressStatus),
      ),
    listIngressEvents: async (args?: {
      limit?: number;
    }): Promise<AutomationIngressEventRecord[]> =>
      callProjectRuntimeActionOr(
        "automations",
        "listIngressEvents",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.automationsListIngressEvents, args ?? {}),
      ),
    parseNaturalLanguage: async (
      req: AutomationParseNaturalLanguageRequest,
    ): Promise<AutomationParseNaturalLanguageResult> =>
      callProjectRuntimeActionOr(
        "automation_planner",
        "parseNaturalLanguage",
        { args: req },
        () => ipcRenderer.invoke(IPC.automationsParseNaturalLanguage, req),
      ),
    validateDraft: async (
      req: AutomationValidateDraftRequest,
    ): Promise<AutomationValidateDraftResult> =>
      callProjectRuntimeActionOr(
        "automation_planner",
        "validateDraft",
        { args: req },
        () => ipcRenderer.invoke(IPC.automationsValidateDraft, req),
      ),
    saveDraft: async (
      req: AutomationSaveDraftRequest,
    ): Promise<AutomationSaveDraftResult> =>
      callProjectRuntimeActionOr(
        "automation_planner",
        "saveDraft",
        { args: req },
        () => ipcRenderer.invoke(IPC.automationsSaveDraft, req),
      ),
    simulate: async (
      req: AutomationSimulateRequest,
    ): Promise<AutomationSimulateResult> =>
      callProjectRuntimeActionOr(
        "automation_planner",
        "simulate",
        { args: req },
        () => ipcRenderer.invoke(IPC.automationsSimulate, req),
      ),
    onEvent: subscribeAutomationsEvents,
  },
  review: {
    listLaunchContext: async (): Promise<ReviewLaunchContext> =>
      callProjectRuntimeActionOr("review", "listLaunchContext", {}, () =>
        ipcRenderer.invoke(IPC.reviewListLaunchContext),
      ),
    listRuns: async (args: ReviewListRunsArgs = {}): Promise<ReviewRun[]> =>
      callProjectRuntimeActionOr("review", "listRuns", { args }, () =>
        ipcRenderer.invoke(IPC.reviewListRuns, args),
      ),
    getRunDetail: async (runId: string): Promise<ReviewRunDetail | null> =>
      callProjectRuntimeActionOr(
        "review",
        "getRunDetail",
        { args: { runId } },
        () => ipcRenderer.invoke(IPC.reviewGetRunDetail, { runId }),
      ),
    startRun: async (args: ReviewStartRunArgs): Promise<ReviewRun> =>
      callProjectRuntimeActionStrictOr("review", "startRun", { args }, () =>
        ipcRenderer.invoke(IPC.reviewStartRun, args),
      ),
    rerun: async (runId: string): Promise<ReviewRun> =>
      callProjectRuntimeActionOr("review", "rerun", { arg: runId }, () =>
        ipcRenderer.invoke(IPC.reviewRerun, { runId }),
      ),
    cancelRun: async (runId: string): Promise<ReviewRun | null> =>
      callProjectRuntimeActionOr(
        "review",
        "cancelRun",
        { args: { runId } },
        () => ipcRenderer.invoke(IPC.reviewCancelRun, { runId }),
      ),
    recordFeedback: async (
      args: ReviewRecordFeedbackArgs,
    ): Promise<ReviewFeedbackRecord> =>
      callProjectRuntimeActionOr("review", "recordFeedback", { args }, () =>
        ipcRenderer.invoke(IPC.reviewRecordFeedback, args),
      ),
    listSuppressions: async (
      args: ReviewListSuppressionsArgs = {},
    ): Promise<ReviewSuppression[]> =>
      callProjectRuntimeActionOr("review", "listSuppressions", { args }, () =>
        ipcRenderer.invoke(IPC.reviewListSuppressions, args),
      ),
    deleteSuppression: async (suppressionId: string): Promise<boolean> =>
      callProjectRuntimeActionOr(
        "review",
        "deleteSuppression",
        { args: { suppressionId } },
        () =>
          ipcRenderer.invoke(IPC.reviewDeleteSuppression, { suppressionId }),
      ),
    qualityReport: async (): Promise<ReviewQualityReport> =>
      callProjectRuntimeActionOr("review", "qualityReport", {}, () =>
        ipcRenderer.invoke(IPC.reviewQualityReport),
      ),
    onEvent: (cb: (ev: ReviewEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ReviewEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.reviewEvent, listener);
      const removeRemote = subscribeRemoteReviewEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.reviewEvent, listener);
      };
    },
  },
  actions: {
    listRegistry: async (): Promise<AdeActionRegistryEntry[]> => {
      const binding = await getRemoteProjectBinding({ fresh: true });
      if (binding) {
        return ipcRenderer.invoke(IPC.remoteRuntimeListActionRegistry, {
          id: binding.targetId,
          projectId: binding.projectId,
        });
      }
      return ipcRenderer.invoke(IPC.adeActionsListRegistry);
    },
  },
  usage: {
    getSnapshot: async (): Promise<UsageSnapshot | null> =>
      callRemoteProjectRuntimeActionOr("usage", "getUsageSnapshot", {}, () =>
        ipcRenderer.invoke(IPC.usageGetSnapshot),
      ),
    refresh: async (): Promise<UsageSnapshot | null> =>
      callRemoteProjectRuntimeActionOr("usage", "forceRefresh", {}, () =>
        ipcRenderer.invoke(IPC.usageRefresh),
      ),
    checkBudget: async (args: {
      scope: BudgetCapScope;
      scopeId?: string;
      provider: BudgetCapProvider;
    }): Promise<BudgetCheckResult> =>
      callRemoteProjectRuntimeActionOr("budget", "checkBudget", { args }, () =>
        ipcRenderer.invoke(IPC.usageCheckBudget, args),
      ),
    getCumulativeUsage: async (args: {
      scope: BudgetCapScope;
      scopeId?: string;
      provider?: BudgetCapProvider;
    }): Promise<{
      totalTokens: number;
      totalCostUsd: number;
      weekKey: string;
    }> =>
      callRemoteProjectRuntimeActionOr("budget", "getCumulativeUsage", { args }, () =>
        ipcRenderer.invoke(IPC.usageGetCumulativeUsage, args),
      ),
    getBudgetConfig: async (): Promise<BudgetCapConfig> =>
      callRemoteProjectRuntimeActionOr("budget", "getConfig", {}, () =>
        ipcRenderer.invoke(IPC.usageGetBudgetConfig),
      ),
    saveBudgetConfig: async (
      config: BudgetCapConfig,
    ): Promise<BudgetCapConfig> =>
      callRemoteProjectRuntimeActionOr(
        "budget",
        "updateConfig",
        { args: config },
        () => ipcRenderer.invoke(IPC.usageSaveBudgetConfig, config),
      ),
    onUpdate: subscribeUsageUpdateEvents,
    onThreshold: subscribeUsageThresholdEvents,
  },
  missions: {
    list: async (args: ListMissionsArgs = {}): Promise<MissionSummary[]> =>
      callProjectRuntimeActionOr("mission", "list", { args }, () =>
        ipcRenderer.invoke(IPC.missionsList, args),
      ),
    get: async (missionId: string): Promise<MissionDetail | null> =>
      callProjectRuntimeActionOr("mission", "get", { arg: missionId }, () =>
        ipcRenderer.invoke(IPC.missionsGet, { missionId }),
      ),
    create: async (args: CreateMissionArgs): Promise<MissionDetail> =>
      callProjectRuntimeActionOr("mission", "create", { args }, () =>
        ipcRenderer.invoke(IPC.missionsCreate, args),
      ),
    update: async (args: UpdateMissionArgs): Promise<MissionDetail> =>
      callProjectRuntimeActionOr("mission", "update", { args }, () =>
        ipcRenderer.invoke(IPC.missionsUpdate, args),
      ),
    archive: async (args: ArchiveMissionArgs): Promise<void> =>
      callProjectRuntimeActionOr("mission", "archive", { args }, () =>
        ipcRenderer.invoke(IPC.missionsArchive, args),
      ),
    delete: async (args: DeleteMissionArgs): Promise<void> =>
      callProjectRuntimeActionOr("mission", "delete", { args }, () =>
        ipcRenderer.invoke(IPC.missionsDelete, args),
      ),
    updateStep: async (args: UpdateMissionStepArgs): Promise<MissionStep> =>
      callProjectRuntimeActionOr("mission", "updateStep", { args }, () =>
        ipcRenderer.invoke(IPC.missionsUpdateStep, args),
      ),
    addArtifact: async (
      args: AddMissionArtifactArgs,
    ): Promise<MissionArtifact> =>
      callProjectRuntimeActionOr("mission", "addArtifact", { args }, () =>
        ipcRenderer.invoke(IPC.missionsAddArtifact, args),
      ),
    addIntervention: async (
      args: AddMissionInterventionArgs,
    ): Promise<MissionIntervention> =>
      callProjectRuntimeActionOr("mission", "addIntervention", { args }, () =>
        ipcRenderer.invoke(IPC.missionsAddIntervention, args),
      ),
    resolveIntervention: async (
      args: ResolveMissionInterventionArgs,
    ): Promise<MissionIntervention> =>
      callProjectRuntimeActionOr(
        "mission",
        "resolveIntervention",
        { args },
        () => ipcRenderer.invoke(IPC.missionsResolveIntervention, args),
      ),
    listPhaseItems: async (
      args: ListPhaseItemsArgs = {},
    ): Promise<PhaseCard[]> =>
      callProjectRuntimeActionOr("mission", "listPhaseItems", { args }, () =>
        ipcRenderer.invoke(IPC.missionsListPhaseItems, args),
      ),
    savePhaseItem: async (args: SavePhaseItemArgs): Promise<PhaseCard> =>
      callProjectRuntimeActionOr("mission", "savePhaseItem", { args }, () =>
        ipcRenderer.invoke(IPC.missionsSavePhaseItem, args),
      ),
    deletePhaseItem: async (args: DeletePhaseItemArgs): Promise<void> =>
      callProjectRuntimeActionOr("mission", "deletePhaseItem", { args }, () =>
        ipcRenderer.invoke(IPC.missionsDeletePhaseItem, args),
      ).then(() => undefined),
    importPhaseItems: async (
      args: ImportPhaseItemsArgs,
    ): Promise<PhaseCard[]> =>
      callProjectRuntimeActionOr("mission", "importPhaseItems", { args }, () =>
        ipcRenderer.invoke(IPC.missionsImportPhaseItems, args),
      ),
    exportPhaseItems: async (
      args: ExportPhaseItemsArgs = {},
    ): Promise<ExportPhaseItemsResult> =>
      callProjectRuntimeActionOr("mission", "exportPhaseItems", { args }, () =>
        ipcRenderer.invoke(IPC.missionsExportPhaseItems, args),
      ),
    listPhaseProfiles: async (
      args: ListPhaseProfilesArgs = {},
    ): Promise<PhaseProfile[]> =>
      callProjectRuntimeActionOr("mission", "listPhaseProfiles", { args }, () =>
        ipcRenderer.invoke(IPC.missionsListPhaseProfiles, args),
      ),
    savePhaseProfile: async (
      args: SavePhaseProfileArgs,
    ): Promise<PhaseProfile> =>
      callProjectRuntimeActionOr("mission", "savePhaseProfile", { args }, () =>
        ipcRenderer.invoke(IPC.missionsSavePhaseProfile, args),
      ),
    deletePhaseProfile: async (args: DeletePhaseProfileArgs): Promise<void> =>
      callProjectRuntimeActionOr(
        "mission",
        "deletePhaseProfile",
        { args },
        () => ipcRenderer.invoke(IPC.missionsDeletePhaseProfile, args),
      ).then(() => undefined),
    clonePhaseProfile: async (
      args: ClonePhaseProfileArgs,
    ): Promise<PhaseProfile> =>
      callProjectRuntimeActionOr("mission", "clonePhaseProfile", { args }, () =>
        ipcRenderer.invoke(IPC.missionsClonePhaseProfile, args),
      ),
    exportPhaseProfile: async (
      args: ExportPhaseProfileArgs,
    ): Promise<ExportPhaseProfileResult> =>
      callProjectRuntimeActionOr(
        "mission",
        "exportPhaseProfile",
        { args },
        () => ipcRenderer.invoke(IPC.missionsExportPhaseProfile, args),
      ),
    importPhaseProfile: async (
      args: ImportPhaseProfileArgs,
    ): Promise<PhaseProfile> =>
      callProjectRuntimeActionOr(
        "mission",
        "importPhaseProfile",
        { args },
        () => ipcRenderer.invoke(IPC.missionsImportPhaseProfile, args),
      ),
    getPhaseConfiguration: async (
      missionId: string,
    ): Promise<MissionPhaseConfiguration | null> =>
      callProjectRuntimeActionOr(
        "mission",
        "getPhaseConfiguration",
        { arg: missionId },
        () =>
          ipcRenderer.invoke(IPC.missionsGetPhaseConfiguration, { missionId }),
      ),
    getDashboard: async (): Promise<MissionDashboardSnapshot> =>
      callProjectRuntimeActionOr("mission", "getDashboard", {}, () =>
        ipcRenderer.invoke(IPC.missionsGetDashboard),
      ),
    getFullMissionView: async (
      args: GetFullMissionViewArgs,
    ): Promise<FullMissionViewResult> =>
      callProjectRuntimeActionOr(
        "mission",
        "getFullMissionView",
        { args },
        () => ipcRenderer.invoke(IPC.missionsGetFullMissionView, args),
      ),
    preflight: async (
      args: MissionPreflightRequest,
    ): Promise<MissionPreflightResult> =>
      callProjectRuntimeActionOr("mission", "preflight", { args }, () =>
        ipcRenderer.invoke(IPC.missionsPreflight, args),
      ),
    getRunView: async (
      args: GetMissionRunViewArgs,
    ): Promise<MissionRunView | null> =>
      callProjectRuntimeActionOr("mission", "getRunView", { args }, () =>
        ipcRenderer.invoke(IPC.missionsGetRunView, args),
      ),
    subscribeRunView: (
      args: GetMissionRunViewArgs,
      cb: (view: MissionRunView | null) => void,
    ) => {
      let disposed = false;
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      let inFlight = false;
      let pending = false;
      const refresh = () => {
        if (disposed) return;
        if (inFlight) {
          pending = true;
          return;
        }
        inFlight = true;
        void callProjectRuntimeActionOr("mission", "getRunView", { args }, () =>
          ipcRenderer.invoke(IPC.missionsGetRunView, args),
        )
          .then(
            (view: MissionRunView | null) => {
              if (!disposed) cb(view);
            },
            () => {},
          )
          .finally(() => {
            inFlight = false;
            if (disposed || !pending) return;
            pending = false;
            scheduleRefresh(350);
          });
      };
      const scheduleRefresh = (delayMs = 650) => {
        if (disposed) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          refresh();
        }, delayMs);
      };
      const missionListener = (
        _event: Electron.IpcRendererEvent,
        payload: MissionsEventPayload,
      ) => {
        if (payload.missionId !== args.missionId) return;
        scheduleRefresh();
      };
      const runtimeListener = (
        _event: Electron.IpcRendererEvent,
        payload: OrchestratorRuntimeEvent,
      ) => {
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh();
      };
      const threadListener = (
        _event: Electron.IpcRendererEvent,
        payload: OrchestratorThreadEvent,
      ) => {
        if (payload.missionId !== args.missionId) return;
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh(750);
      };
      const dagListener = (
        _event: Electron.IpcRendererEvent,
        payload: DagMutationEvent,
      ) => {
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh(750);
      };
      ipcRenderer.on(IPC.missionsEvent, missionListener);
      ipcRenderer.on(IPC.orchestratorEvent, runtimeListener);
      ipcRenderer.on(IPC.orchestratorThreadEvent, threadListener);
      ipcRenderer.on(IPC.orchestratorDagMutation, dagListener);
      const removeRemoteMission = subscribeRemoteMissionEvents((payload) => {
        if (payload.missionId !== args.missionId) return;
        scheduleRefresh();
      });
      const removeRemoteOrchestrator = subscribeRemoteOrchestratorEvents(
        (payload) => {
          if (args.runId && payload.runId !== args.runId) return;
          scheduleRefresh();
        },
      );
      const removeRemoteThread = subscribeRemoteOrchestratorThreadEvents(
        (payload) => {
          if (payload.missionId !== args.missionId) return;
          if (args.runId && payload.runId !== args.runId) return;
          scheduleRefresh(750);
        },
      );
      const removeRemoteDag = subscribeRemoteDagMutationEvents((payload) => {
        if (args.runId && payload.runId !== args.runId) return;
        scheduleRefresh(750);
      });
      refresh();
      return () => {
        disposed = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        removeRemoteMission();
        removeRemoteOrchestrator();
        removeRemoteThread();
        removeRemoteDag();
        ipcRenderer.removeListener(IPC.missionsEvent, missionListener);
        ipcRenderer.removeListener(IPC.orchestratorEvent, runtimeListener);
        ipcRenderer.removeListener(IPC.orchestratorThreadEvent, threadListener);
        ipcRenderer.removeListener(IPC.orchestratorDagMutation, dagListener);
      };
    },
    onEvent: (cb: (ev: MissionsEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: MissionsEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.missionsEvent, listener);
      const removeRemote = subscribeRemoteMissionEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.missionsEvent, listener);
      };
    },
  },
  orchestrator: {
    listRuns: async (
      args: ListOrchestratorRunsArgs = {},
    ): Promise<OrchestratorRun[]> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "listRuns",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListRuns, args),
      ),
    getRunGraph: async (
      args: GetOrchestratorRunGraphArgs,
    ): Promise<OrchestratorRunGraph> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "getRunGraph",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetRunGraph, args),
      ),
    startRun: async (
      args: StartOrchestratorRunArgs,
    ): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "startRun",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorStartRun, args),
      ),
    startRunFromMission: async (
      args: StartOrchestratorRunFromMissionArgs,
    ): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const launch =
        await callProjectRuntimeActionOr<StartMissionRunWithAIResult>(
          "orchestrator",
          "startMissionRun",
          {
            args: {
              missionId: args.missionId,
              runMode: args.runMode,
              autopilotOwnerId: args.autopilotOwnerId,
              defaultExecutorKind: args.defaultExecutorKind,
              defaultRetryLimit: args.defaultRetryLimit,
              metadata: args.metadata ?? null,
              plannerProvider: args.plannerProvider ?? undefined,
            },
          },
          () =>
            ipcRenderer.invoke(IPC.orchestratorStartMissionRun, {
              missionId: args.missionId,
              runMode: args.runMode,
              autopilotOwnerId: args.autopilotOwnerId,
              defaultExecutorKind: args.defaultExecutorKind,
              defaultRetryLimit: args.defaultRetryLimit,
              metadata: args.metadata ?? null,
              plannerProvider: args.plannerProvider ?? undefined,
            }),
        );
      if (!launch.started) {
        throw new Error("Mission run did not produce a runnable execution.");
      }
      return launch.started;
    },
    startAttempt: async (
      args: StartOrchestratorAttemptArgs,
    ): Promise<OrchestratorAttempt> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "startAttempt",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorStartAttempt, args),
      ),
    completeAttempt: async (
      args: CompleteOrchestratorAttemptArgs,
    ): Promise<OrchestratorAttempt> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "completeAttempt",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorCompleteAttempt, args),
      ),
    tickRun: async (args: TickOrchestratorRunArgs): Promise<OrchestratorRun> =>
      callProjectRuntimeActionOr("orchestrator_core", "tick", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorTickRun, args),
      ),
    pauseRun: async (
      args: PauseOrchestratorRunArgs,
    ): Promise<OrchestratorRun> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "pauseRun",
        {
          args: {
            runId: args.runId,
            reason: args.reason ?? "Paused from Missions UI.",
          },
        },
        () => ipcRenderer.invoke(IPC.orchestratorPauseRun, args),
      ),
    resumeRun: async (
      args: ResumeOrchestratorRunArgs,
    ): Promise<OrchestratorRun> =>
      callProjectRuntimeActionOr("orchestrator", "resumeRun", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorResumeRun, args),
      ),
    cancelRun: async (
      args: CancelOrchestratorRunArgs,
    ): Promise<OrchestratorRun> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "cancelRunGracefully",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorCancelRun, args),
      ),
    cleanupTeamResources: async (
      args: CleanupOrchestratorTeamResourcesArgs,
    ): Promise<CleanupOrchestratorTeamResourcesResult> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "cleanupTeamResources",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorCleanupTeamResources, args),
      ),
    heartbeatClaims: async (
      args: HeartbeatOrchestratorClaimsArgs,
    ): Promise<number> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "heartbeatClaims",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorHeartbeatClaims, args),
      ),
    listTimeline: async (
      args: ListOrchestratorTimelineArgs,
    ): Promise<OrchestratorTimelineEvent[]> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "listTimeline",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListTimeline, args),
      ),
    getMissionLogs: async (
      args: GetMissionLogsArgs,
    ): Promise<GetMissionLogsResult> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getMissionLogs",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetMissionLogs, args),
      ),
    exportMissionLogs: async (
      args: ExportMissionLogsArgs,
    ): Promise<ExportMissionLogsResult> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "exportMissionLogs",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorExportMissionLogs, args),
      ),
    getGateReport: async (
      args: GetOrchestratorGateReportArgs = {},
    ): Promise<OrchestratorGateReport> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "getLatestGateReport",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetGateReport, args),
      ),
    getWorkerStates: async (
      args: GetOrchestratorWorkerStatesArgs,
    ): Promise<OrchestratorWorkerState[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getWorkerStates",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetWorkerStates, args),
      ),
    startMissionRun: async (
      args: StartMissionRunWithAIArgs,
    ): Promise<StartMissionRunWithAIResult> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "startMissionRun",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorStartMissionRun, args),
      ),
    steerMission: async (args: SteerMissionArgs): Promise<SteerMissionResult> =>
      callProjectRuntimeActionOr("orchestrator", "steerMission", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorSteerMission, args),
      ),
    getModelCapabilities: async (): Promise<GetModelCapabilitiesResult> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getModelCapabilities",
        {},
        () => ipcRenderer.invoke(IPC.orchestratorGetModelCapabilities),
      ),
    getTeamMembers: async (
      args: GetTeamMembersArgs,
    ): Promise<OrchestratorTeamMember[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getTeamMembers",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetTeamMembers, args),
      ),
    getTeamRuntimeState: async (
      args: GetTeamRuntimeStateArgs,
    ): Promise<OrchestratorTeamRuntimeState | null> =>
      callProjectRuntimeActionOr(
        "orchestrator_core",
        "getRunState",
        { arg: args.runId },
        () => ipcRenderer.invoke(IPC.orchestratorGetTeamRuntimeState, args),
      ),
    finalizeRun: async (args: FinalizeRunArgs): Promise<FinalizeRunResult> =>
      callProjectRuntimeActionOr("orchestrator", "finalizeRun", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorFinalizeRun, args),
      ),
    sendChat: async (
      args: SendOrchestratorChatArgs,
    ): Promise<OrchestratorChatMessage> =>
      callProjectRuntimeActionOr("orchestrator", "sendChat", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorSendChat, args),
      ),
    getChat: async (
      args: GetOrchestratorChatArgs,
    ): Promise<OrchestratorChatMessage[]> =>
      callProjectRuntimeActionOr("orchestrator", "getChat", { args }, () =>
        ipcRenderer.invoke(IPC.orchestratorGetChat, args),
      ),
    listChatThreads: async (
      args: ListOrchestratorChatThreadsArgs,
    ): Promise<OrchestratorChatThread[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "listChatThreads",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListChatThreads, args),
      ),
    getThreadMessages: async (
      args: GetOrchestratorThreadMessagesArgs,
    ): Promise<OrchestratorChatMessage[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getThreadMessages",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetThreadMessages, args),
      ),
    sendThreadMessage: async (
      args: SendOrchestratorThreadMessageArgs,
    ): Promise<OrchestratorChatMessage> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "sendThreadMessage",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorSendThreadMessage, args),
      ),
    getWorkerDigest: async (
      args: GetOrchestratorWorkerDigestArgs,
    ): Promise<OrchestratorWorkerDigest | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getWorkerDigest",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetWorkerDigest, args),
      ),
    listWorkerDigests: async (
      args: ListOrchestratorWorkerDigestsArgs,
    ): Promise<OrchestratorWorkerDigest[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "listWorkerDigests",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListWorkerDigests, args),
      ),
    getContextCheckpoint: async (
      args: GetOrchestratorContextCheckpointArgs,
    ): Promise<OrchestratorContextCheckpoint | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getContextCheckpoint",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetContextCheckpoint, args),
      ),
    listLaneDecisions: async (
      args: ListOrchestratorLaneDecisionsArgs,
    ): Promise<OrchestratorLaneDecision[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "listLaneDecisions",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListLaneDecisions, args),
      ),
    getMissionMetrics: async (
      args: GetMissionMetricsArgs,
    ): Promise<{
      config: MissionMetricsConfig | null;
      samples: MissionMetricSample[];
    }> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getMissionMetrics",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetMissionMetrics, args),
      ),
    setMissionMetricsConfig: async (
      args: SetMissionMetricsConfigArgs,
    ): Promise<MissionMetricsConfig> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "setMissionMetricsConfig",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorSetMissionMetricsConfig, args),
      ),
    getExecutionPlanPreview: async (args: {
      runId: string;
    }): Promise<ExecutionPlanPreview | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getExecutionPlanPreview",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetExecutionPlanPreview, args),
      ),
    getMissionStateDocument: async (
      args: GetMissionStateDocumentArgs,
    ): Promise<MissionStateDocument | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getMissionStateDocument",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetMissionStateDocument, args),
      ),
    listArtifacts: async (
      args: ListOrchestratorArtifactsArgs,
    ): Promise<OrchestratorArtifact[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "listArtifacts",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListArtifacts, args),
      ),
    listWorkerCheckpoints: async (
      args: ListOrchestratorWorkerCheckpointsArgs,
    ): Promise<OrchestratorWorkerCheckpoint[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "listWorkerCheckpoints",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorListWorkerCheckpoints, args),
      ),
    getPromptInspector: async (
      args: GetOrchestratorPromptInspectorArgs,
    ): Promise<OrchestratorPromptInspector | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getPromptInspector",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetPromptInspector, args),
      ),
    getPlanningPromptPreview: async (
      args: GetPlanningPromptPreviewArgs,
    ): Promise<OrchestratorPromptInspector | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getPlanningPromptPreview",
        { args },
        () =>
          ipcRenderer.invoke(IPC.orchestratorGetPlanningPromptPreview, args),
      ),
    getCheckpointStatus: async (args: {
      runId: string;
    }): Promise<{
      savedAt: string;
      turnCount: number;
      compactionCount: number;
    } | null> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getCheckpointStatus",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetCheckpointStatus, args),
      ),
    getMissionBudgetStatus: async (
      args: GetMissionBudgetStatusArgs,
    ): Promise<MissionBudgetSnapshot> =>
      callProjectRuntimeActionOr(
        "mission_budget",
        "getMissionBudgetStatus",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetMissionBudgetStatus, args),
      ),
    getMissionBudgetTelemetry: async (
      args: GetMissionBudgetTelemetryArgs,
    ): Promise<MissionBudgetTelemetrySnapshot> =>
      callProjectRuntimeActionOr(
        "mission_budget",
        "getMissionBudgetTelemetry",
        { args },
        () =>
          ipcRenderer.invoke(IPC.orchestratorGetMissionBudgetTelemetry, args),
      ),
    sendAgentMessage: async (
      args: SendAgentMessageArgs,
    ): Promise<OrchestratorChatMessage> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "sendAgentMessage",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorSendAgentMessage, args),
      ),
    getGlobalChat: async (
      args: GetGlobalChatArgs,
    ): Promise<OrchestratorChatMessage[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getGlobalChat",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetGlobalChat, args),
      ),
    getActiveAgents: async (
      args: GetActiveAgentsArgs,
    ): Promise<ActiveAgentInfo[]> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getActiveAgents",
        { args },
        () => ipcRenderer.invoke(IPC.orchestratorGetActiveAgents, args),
      ),
    getAggregatedUsage: async (
      args: GetAggregatedUsageArgs,
    ): Promise<AggregatedUsageStats> =>
      callProjectRuntimeActionOr(
        "orchestrator",
        "getAggregatedUsage",
        { args },
        () => ipcRenderer.invoke(IPC.getAggregatedUsage, args),
      ),
    onEvent: (cb: (ev: OrchestratorRuntimeEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: OrchestratorRuntimeEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.orchestratorEvent, listener);
      const removeRemote = subscribeRemoteOrchestratorEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.orchestratorEvent, listener);
      };
    },
    onThreadEvent: (cb: (ev: OrchestratorThreadEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: OrchestratorThreadEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.orchestratorThreadEvent, listener);
      const removeRemote = subscribeRemoteOrchestratorThreadEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.orchestratorThreadEvent, listener);
      };
    },
    onDagMutation: (cb: (ev: DagMutationEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: DagMutationEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.orchestratorDagMutation, listener);
      const removeRemote = subscribeRemoteDagMutationEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.orchestratorDagMutation, listener);
      };
    },
  },
  lanes: {
    list: async (args: ListLanesArgs = {}): Promise<LaneSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<LaneSummary[]>(
        "lane",
        "list",
        { args },
      );
      if (runtime.handled) return runtime.result;
      return lanesListCache.get(serializeIpcCacheArgs(args));
    },
    listSnapshots: async (
      args: ListLanesArgs = {},
    ): Promise<LaneListSnapshot[]> => {
      const runtime = await callProjectRuntimeActionIfBound<LaneListSnapshot[]>(
        "lane",
        "listSnapshots",
        { args },
      );
      if (runtime.handled) return runtime.result;
      return lanesListSnapshotsCache.get(serializeIpcCacheArgs(args));
    },
    create: async (args: CreateLaneArgs): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "create",
        { args },
        () => ipcRenderer.invoke(IPC.lanesCreate, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    createChild: async (args: CreateChildLaneArgs): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "createChild",
        { args },
        () => ipcRenderer.invoke(IPC.lanesCreateChild, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    createFromUnstaged: async (
      args: CreateLaneFromUnstagedArgs,
    ): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "createFromUnstaged",
        { args },
        () => ipcRenderer.invoke(IPC.lanesCreateFromUnstaged, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    importBranch: async (args: ImportBranchLaneArgs): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "importBranch",
        { args },
        () => ipcRenderer.invoke(IPC.lanesImportBranch, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    previewBranchSwitch: async (
      args: LaneBranchSwitchArgs,
    ): Promise<LaneBranchSwitchPreview> =>
      callProjectRuntimeActionOr("lane", "previewBranchSwitch", { args }, () =>
        ipcRenderer.invoke(IPC.lanesPreviewBranchSwitch, args),
      ),
    switchBranch: async (
      args: LaneBranchSwitchArgs,
    ): Promise<LaneBranchSwitchResult> => {
      clearGitReadCaches();
      const result = await callProjectRuntimeActionOr<LaneBranchSwitchResult>(
        "lane",
        "switchBranch",
        { args },
        () => ipcRenderer.invoke(IPC.lanesSwitchBranch, args),
      );
      clearGitReadCaches();
      return result as LaneBranchSwitchResult;
    },
    attach: async (args: AttachLaneArgs): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "attach",
        { args },
        () => ipcRenderer.invoke(IPC.lanesAttach, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    listUnregisteredWorktrees: async (): Promise<UnregisteredLaneCandidate[]> =>
      callProjectRuntimeActionOr("lane", "listUnregisteredWorktrees", {}, () =>
        ipcRenderer.invoke(IPC.lanesListUnregisteredWorktrees),
      ),
    adoptAttached: async (
      args: AdoptAttachedLaneArgs,
    ): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callProjectRuntimeActionOr<LaneSummary>(
        "lane",
        "adoptAttached",
        { args },
        () => ipcRenderer.invoke(IPC.lanesAdoptAttached, args),
      );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    rename: async (args: RenameLaneArgs): Promise<void> => {
      clearGitReadCaches();
      await callProjectRuntimeActionOr("lane", "rename", { args }, () =>
        ipcRenderer.invoke(IPC.lanesRename, args),
      );
      clearGitReadCaches();
    },
    reparent: async (args: ReparentLaneArgs): Promise<ReparentLaneResult> => {
      clearGitReadCaches();
      const result = await callProjectRuntimeActionOr<ReparentLaneResult>(
        "lane",
        "reparent",
        { args },
        () => ipcRenderer.invoke(IPC.lanesReparent, args),
      );
      clearGitReadCaches();
      return result as ReparentLaneResult;
    },
    updateAppearance: async (args: UpdateLaneAppearanceArgs): Promise<void> => {
      clearGitReadCaches();
      await callProjectRuntimeActionOr(
        "lane",
        "updateAppearance",
        { args },
        () => ipcRenderer.invoke(IPC.lanesUpdateAppearance, args),
      );
      clearGitReadCaches();
    },
    archive: async (args: ArchiveLaneArgs): Promise<void> => {
      clearGitReadCaches();
      await callProjectRuntimeActionOr("lane", "archive", { args }, () =>
        ipcRenderer.invoke(IPC.lanesArchive, args),
      );
      clearGitReadCaches();
    },
    delete: async (args: DeleteLaneArgs): Promise<void> => {
      clearGitReadCaches();
      await callProjectRuntimeActionOr("lane", "delete", { args }, () =>
        ipcRenderer.invoke(IPC.lanesDelete, args),
      );
      clearGitReadCaches();
    },
    cancelDelete: async (args: {
      laneId: string;
    }): Promise<{ cancelled: boolean; reason?: string }> =>
      callProjectRuntimeActionOr(
        "lane",
        "cancelDelete",
        { arg: args.laneId },
        () => ipcRenderer.invoke(IPC.lanesDeleteCancel, args),
      ),
    listDeleteProgress: async (): Promise<LaneDeleteProgress[]> =>
      callProjectRuntimeActionOr("lane", "listDeleteProgress", {}, () =>
        ipcRenderer.invoke(IPC.lanesListDeleteProgress),
      ),
    getDeleteRisk: async (args: { laneId: string }): Promise<LaneDeleteRisk> =>
      callProjectRuntimeActionOr(
        "lane",
        "getDeleteRisk",
        { arg: args.laneId },
        () => ipcRenderer.invoke(IPC.lanesGetDeleteRisk, args),
      ),
    onDeleteEvent: (cb: (ev: LaneDeleteEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LaneDeleteEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesDeleteEvent, listener);
      const removeRemote = subscribeRemoteLaneDeleteEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesDeleteEvent, listener);
      };
    },
    getStackChain: async (laneId: string): Promise<StackChainItem[]> =>
      callProjectRuntimeActionOr("lane", "getStackChain", { arg: laneId }, () =>
        ipcRenderer.invoke(IPC.lanesGetStackChain, { laneId }),
      ),
    getChildren: async (laneId: string): Promise<LaneSummary[]> =>
      callProjectRuntimeActionOr("lane", "getChildren", { arg: laneId }, () =>
        ipcRenderer.invoke(IPC.lanesGetChildren, { laneId }),
      ),
    rebaseStart: async (args: RebaseStartArgs): Promise<RebaseStartResult> =>
      callProjectRuntimeActionOr("lane", "rebaseStart", { args }, () =>
        ipcRenderer.invoke(IPC.lanesRebaseStart, args),
      ),
    rebasePush: async (args: RebasePushArgs): Promise<RebaseRun> =>
      callProjectRuntimeActionOr("lane", "rebasePush", { args }, () =>
        ipcRenderer.invoke(IPC.lanesRebasePush, args),
      ),
    rebaseRollback: async (args: RebaseRollbackArgs): Promise<RebaseRun> =>
      callProjectRuntimeActionOr("lane", "rebaseRollback", { args }, () =>
        ipcRenderer.invoke(IPC.lanesRebaseRollback, args),
      ),
    rebaseAbort: async (args: RebaseAbortArgs): Promise<RebaseRun> =>
      callProjectRuntimeActionOr("lane", "rebaseAbort", { args }, () =>
        ipcRenderer.invoke(IPC.lanesRebaseAbort, args),
      ),
    rebaseSubscribe: (cb: (ev: RebaseRunEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RebaseRunEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesRebaseEvent, listener);
      const removeRemote = subscribeRemoteLaneRebaseEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesRebaseEvent, listener);
      };
    },
    listRebaseSuggestions: async (): Promise<RebaseSuggestion[]> =>
      callProjectRuntimeActionOr("lane", "listRebaseSuggestions", {}, () =>
        ipcRenderer.invoke(IPC.lanesListRebaseSuggestions),
      ),
    dismissRebaseSuggestion: async (args: {
      laneId: string;
    }): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "dismissRebaseSuggestion",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDismissRebaseSuggestion, args),
      );
    },
    deferRebaseSuggestion: async (args: {
      laneId: string;
      minutes: number;
    }): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "deferRebaseSuggestion",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDeferRebaseSuggestion, args),
      );
    },
    onRebaseSuggestionsEvent: (
      cb: (ev: RebaseSuggestionsEventPayload) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RebaseSuggestionsEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesRebaseSuggestionsEvent, listener);
      const removeRemote = subscribeRemoteLaneRebaseSuggestionsEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesRebaseSuggestionsEvent, listener);
      };
    },
    listAutoRebaseStatuses: async (): Promise<AutoRebaseLaneStatus[]> =>
      callProjectRuntimeActionOr("lane", "listAutoRebaseStatuses", { args: {} }, () =>
        ipcRenderer.invoke(IPC.lanesListAutoRebaseStatuses),
      ),
    dismissAutoRebaseStatus: async (args: {
      laneId: string;
    }): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "dismissAutoRebaseStatus",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDismissAutoRebaseStatus, args),
      );
    },
    onAutoRebaseEvent: (cb: (ev: AutoRebaseEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: AutoRebaseEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesAutoRebaseEvent, listener);
      const removeRemote = subscribeRemoteLaneAutoRebaseEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesAutoRebaseEvent, listener);
      };
    },
    openFolder: async (args: { laneId: string }): Promise<void> => {
      const binding = await getRemoteProjectBinding();
      if (binding) {
        throw new Error(
          "Remote lane folders cannot be opened on this machine. Copy the remote path instead.",
        );
      }
      await ipcRenderer.invoke(IPC.lanesOpenFolder, args);
    },
    initEnv: async (args: InitLaneEnvArgs): Promise<LaneEnvInitProgress> =>
      callProjectRuntimeActionOr("lane", "initEnv", { args }, () =>
        ipcRenderer.invoke(IPC.lanesInitEnv, args),
      ),
    getEnvStatus: async (
      args: GetLaneEnvStatusArgs,
    ): Promise<LaneEnvInitProgress | null> =>
      callProjectRuntimeActionOr("lane", "getEnvStatus", { args }, () =>
        ipcRenderer.invoke(IPC.lanesGetEnvStatus, args),
      ),
    getOverlay: async (
      args: GetLaneOverlayArgs,
    ): Promise<LaneOverlayOverrides> =>
      callProjectRuntimeActionOr("lane", "getOverlay", { args }, () =>
        ipcRenderer.invoke(IPC.lanesGetOverlay, args),
      ),
    onEnvEvent: (cb: (ev: LaneEnvInitEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LaneEnvInitEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesEnvEvent, listener);
      const removeRemote = subscribeRemoteLaneEnvEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesEnvEvent, listener);
      };
    },
    listTemplates: async (): Promise<LaneTemplate[]> =>
      callProjectRuntimeActionOr("lane", "listTemplates", {}, () =>
        ipcRenderer.invoke(IPC.lanesListTemplates),
      ),
    getTemplate: async (
      args: GetLaneTemplateArgs,
    ): Promise<LaneTemplate | null> =>
      callProjectRuntimeActionOr("lane", "getTemplate", { args }, () =>
        ipcRenderer.invoke(IPC.lanesGetTemplate, args),
      ),
    getDefaultTemplate: async (): Promise<string | null> =>
      callProjectRuntimeActionOr("lane", "getDefaultTemplate", {}, () =>
        ipcRenderer.invoke(IPC.lanesGetDefaultTemplate),
      ),
    setDefaultTemplate: async (
      args: SetDefaultLaneTemplateArgs,
    ): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "setDefaultTemplate",
        { args },
        () => ipcRenderer.invoke(IPC.lanesSetDefaultTemplate, args),
      );
    },
    applyTemplate: async (
      args: ApplyLaneTemplateArgs,
    ): Promise<LaneEnvInitProgress> =>
      callProjectRuntimeActionOr("lane", "applyTemplate", { args }, () =>
        ipcRenderer.invoke(IPC.lanesApplyTemplate, args),
      ),
    saveTemplate: async (args: SaveLaneTemplateArgs): Promise<void> => {
      await callProjectRuntimeActionOr("lane", "saveTemplate", { args }, () =>
        ipcRenderer.invoke(IPC.lanesSaveTemplate, args),
      );
    },
    deleteTemplate: async (args: DeleteLaneTemplateArgs): Promise<void> => {
      await callProjectRuntimeActionOr("lane", "deleteTemplate", { args }, () =>
        ipcRenderer.invoke(IPC.lanesDeleteTemplate, args),
      );
    },
    portGetLease: async (args: GetPortLeaseArgs): Promise<PortLease | null> =>
      callProjectRuntimeActionOr("lane", "portGetLease", { args }, () =>
        ipcRenderer.invoke(IPC.lanesPortGetLease, args),
      ),
    portListLeases: async (): Promise<PortLease[]> =>
      callProjectRuntimeActionOr("lane", "portListLeases", {}, () =>
        ipcRenderer.invoke(IPC.lanesPortListLeases),
      ),
    portAcquire: async (args: AcquirePortLeaseArgs): Promise<PortLease> =>
      callProjectRuntimeActionOr("lane", "portAcquire", { args }, () =>
        ipcRenderer.invoke(IPC.lanesPortAcquire, args),
      ),
    portRelease: async (args: ReleasePortLeaseArgs): Promise<void> => {
      await callProjectRuntimeActionOr("lane", "portRelease", { args }, () =>
        ipcRenderer.invoke(IPC.lanesPortRelease, args),
      );
    },
    portListConflicts: async (): Promise<PortConflict[]> =>
      callProjectRuntimeActionOr("lane", "portListConflicts", {}, () =>
        ipcRenderer.invoke(IPC.lanesPortListConflicts),
      ),
    portRecoverOrphans: async (): Promise<PortLease[]> =>
      callProjectRuntimeActionOr("lane", "portRecoverOrphans", {}, () =>
        ipcRenderer.invoke(IPC.lanesPortRecoverOrphans),
      ),
    onPortEvent: (cb: (ev: PortAllocationEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: PortAllocationEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesPortEvent, listener);
      const removeRemote = subscribeRemoteLanePortEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesPortEvent, listener);
      };
    },
    proxyGetStatus: async (): Promise<ProxyStatus> =>
      callProjectRuntimeActionOr("lane", "proxyGetStatus", {}, () =>
        ipcRenderer.invoke(IPC.lanesProxyGetStatus),
      ),
    proxyStart: async (args?: StartProxyArgs): Promise<ProxyStatus> =>
      callProjectRuntimeActionOr("lane", "proxyStart", { args }, () =>
        ipcRenderer.invoke(IPC.lanesProxyStart, args),
      ),
    proxyStop: async (): Promise<void> => {
      await callProjectRuntimeActionOr("lane", "proxyStop", {}, () =>
        ipcRenderer.invoke(IPC.lanesProxyStop),
      );
    },
    proxyAddRoute: async (args: AddProxyRouteArgs): Promise<ProxyRoute> =>
      callProjectRuntimeActionOr("lane", "proxyAddRoute", { args }, () =>
        ipcRenderer.invoke(IPC.lanesProxyAddRoute, args),
      ),
    proxyRemoveRoute: async (args: RemoveProxyRouteArgs): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "proxyRemoveRoute",
        { args },
        () => ipcRenderer.invoke(IPC.lanesProxyRemoveRoute, args),
      );
    },
    proxyGetPreviewInfo: async (
      args: GetPreviewInfoArgs,
    ): Promise<LanePreviewInfo | null> =>
      callProjectRuntimeActionOr("lane", "proxyGetPreviewInfo", { args }, () =>
        ipcRenderer.invoke(IPC.lanesProxyGetPreviewInfo, args),
      ),
    proxyOpenPreview: async (args: OpenPreviewArgs): Promise<void> => {
      const binding = await getProjectRuntimeBinding();
      if (binding) {
        const runtime =
          await callProjectRuntimeActionIfBound<LanePreviewInfo | null>(
            "lane",
            "proxyGetPreviewInfo",
            { args },
          );
        if (!runtime.handled) {
          await ipcRenderer.invoke(IPC.lanesProxyOpenPreview, args);
          return;
        }
        const info = runtime.result;
        if (!info) throw new Error(`No preview route for lane: ${args.laneId}`);
        await ipcRenderer.invoke(IPC.appOpenExternal, { url: info.previewUrl });
        return;
      }
      await ipcRenderer.invoke(IPC.lanesProxyOpenPreview, args);
    },
    onProxyEvent: (cb: (ev: LaneProxyEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LaneProxyEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesProxyEvent, listener);
      const removeRemote = subscribeRemoteLaneProxyEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesProxyEvent, listener);
      };
    },
    oauthGetStatus: async (): Promise<OAuthRedirectStatus> =>
      callProjectRuntimeActionOr("lane", "oauthGetStatus", {}, () =>
        ipcRenderer.invoke(IPC.lanesOAuthGetStatus),
      ),
    oauthUpdateConfig: async (
      args: UpdateOAuthRedirectConfigArgs,
    ): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "oauthUpdateConfig",
        { args },
        () => ipcRenderer.invoke(IPC.lanesOAuthUpdateConfig, args),
      );
    },
    oauthGenerateRedirectUris: async (
      args: GenerateRedirectUrisArgs,
    ): Promise<RedirectUriInfo[]> =>
      callProjectRuntimeActionOr(
        "lane",
        "oauthGenerateRedirectUris",
        { args },
        () => ipcRenderer.invoke(IPC.lanesOAuthGenerateRedirectUris, args),
      ),
    oauthEncodeState: async (args: EncodeOAuthStateArgs): Promise<string> =>
      callProjectRuntimeActionOr("lane", "oauthEncodeState", { args }, () =>
        ipcRenderer.invoke(IPC.lanesOAuthEncodeState, args),
      ),
    oauthDecodeState: async (
      args: DecodeOAuthStateArgs,
    ): Promise<DecodeOAuthStateResult> =>
      callProjectRuntimeActionOr("lane", "oauthDecodeState", { args }, () =>
        ipcRenderer.invoke(IPC.lanesOAuthDecodeState, args),
      ),
    oauthListSessions: async (): Promise<OAuthSession[]> =>
      callProjectRuntimeActionOr("lane", "oauthListSessions", {}, () =>
        ipcRenderer.invoke(IPC.lanesOAuthListSessions),
      ),
    onOAuthEvent: (cb: (ev: OAuthRedirectEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: OAuthRedirectEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesOAuthEvent, listener);
      const removeRemote = subscribeRemoteLaneOAuthEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesOAuthEvent, listener);
      };
    },
    diagnosticsGetStatus: async (): Promise<RuntimeDiagnosticsStatus> =>
      callProjectRuntimeActionOr("lane", "diagnosticsGetStatus", {}, () =>
        ipcRenderer.invoke(IPC.lanesDiagnosticsGetStatus),
      ),
    diagnosticsGetLaneHealth: async (
      args: GetLaneHealthArgs,
    ): Promise<LaneHealthCheck | null> =>
      callProjectRuntimeActionOr(
        "lane",
        "diagnosticsGetLaneHealth",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDiagnosticsGetLaneHealth, args),
      ),
    diagnosticsRunHealthCheck: async (
      args: RunHealthCheckArgs,
    ): Promise<LaneHealthCheck> =>
      callProjectRuntimeActionOr(
        "lane",
        "diagnosticsRunHealthCheck",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDiagnosticsRunHealthCheck, args),
      ),
    diagnosticsRunFullCheck: async (): Promise<LaneHealthCheck[]> =>
      callProjectRuntimeActionOr("lane", "diagnosticsRunFullCheck", {}, () =>
        ipcRenderer.invoke(IPC.lanesDiagnosticsRunFullCheck),
      ),
    diagnosticsActivateFallback: async (
      args: ActivateFallbackArgs,
    ): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "diagnosticsActivateFallback",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDiagnosticsActivateFallback, args),
      );
    },
    diagnosticsDeactivateFallback: async (
      args: DeactivateFallbackArgs,
    ): Promise<void> => {
      await callProjectRuntimeActionOr(
        "lane",
        "diagnosticsDeactivateFallback",
        { args },
        () => ipcRenderer.invoke(IPC.lanesDiagnosticsDeactivateFallback, args),
      );
    },
    onDiagnosticsEvent: (cb: (ev: RuntimeDiagnosticsEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RuntimeDiagnosticsEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesDiagnosticsEvent, listener);
      const removeRemote = subscribeRemoteLaneDiagnosticsEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesDiagnosticsEvent, listener);
      };
    },
  },
  sessions: {
    list: async (
      args: ListSessionsArgs = {},
    ): Promise<TerminalSessionSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        TerminalSessionSummary[]
      >("session", "list", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.sessionsList, args);
    },
    get: async (sessionId: string): Promise<TerminalSessionDetail | null> => {
      const runtime =
        await callProjectRuntimeActionIfBound<TerminalSessionDetail | null>(
          "session",
          "get",
          { arg: sessionId },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.sessionsGet, { sessionId });
    },
    delete: async (args: DeleteSessionArgs): Promise<void> => {
      sessionDeltaCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<boolean>(
        "session",
        "deleteSession",
        { arg: args.sessionId },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.sessionsDelete, args);
      sessionDeltaCache.clear();
    },
    updateMeta: async (
      args: UpdateSessionMetaArgs,
    ): Promise<TerminalSessionSummary | null> => {
      sessionDeltaCache.clear();
      const runtime =
        await callProjectRuntimeActionIfBound<TerminalSessionSummary | null>(
          "session",
          "updateMeta",
          { args },
        );
      const updated = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.sessionsUpdateMeta, args);
      sessionDeltaCache.clear();
      return updated as TerminalSessionSummary | null;
    },
    readTranscriptTail: async (
      args: ReadTranscriptTailArgs,
    ): Promise<string> => {
      const runtime = await callProjectRuntimeActionIfBound<string>(
        "session",
        "readTranscriptTail",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.sessionsReadTranscriptTail, args);
    },
    getDelta: async (sessionId: string): Promise<SessionDeltaSummary | null> =>
      sessionDeltaCache.get(sessionId),
    onChanged: (cb: (ev: TerminalSessionChangedEvent) => void) => {
      const removeLocal = subscribeLocalSessionChangedEvents(cb);
      const removeRemote = subscribeRemoteSessionChangedEvents(cb);
      return () => {
        removeRemote();
        removeLocal();
      };
    },
  },
  agentChat: {
    list: async (
      args: AgentChatListArgs = {},
    ): Promise<AgentChatSessionSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        AgentChatSessionSummary[]
      >("chat", "listSessions", {
        argsList: [
          args.laneId,
          { includeAutomation: args.includeAutomation === true },
        ],
      });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.agentChatList, args);
    },
    getSummary: async (
      args: AgentChatGetSummaryArgs,
    ): Promise<AgentChatSessionSummary | null> => {
      const sessionId =
        typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return ipcRenderer.invoke(IPC.agentChatGetSummary, args);
      const runtime =
        await callProjectRuntimeActionIfBound<AgentChatSessionSummary | null>(
          "chat",
          "getSessionSummary",
          { arg: sessionId },
        );
      return runtime.handled
        ? runtime.result
        : agentChatSummaryCache.get(sessionId);
    },
    create: async (args: AgentChatCreateArgs): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<AgentChatSession>(
        "chat",
        "createSession",
        { args },
      );
      const session = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.agentChatCreate, args);
      agentChatSummaryCache.clear();
      return session as AgentChatSession;
    },
    suggestLaneName: async (
      args: AgentChatSuggestLaneNameArgs,
    ): Promise<string> =>
      callProjectRuntimeActionOr(
        "chat",
        "suggestLaneNameFromPrompt",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatSuggestLaneName, args),
      ),
    parallelLaunchState: {
      get: async (
        args: AgentChatParallelLaunchStateArgs,
      ): Promise<AgentChatParallelLaunchState | null> =>
        callProjectRuntimeActionOr(
          "chat",
          "getParallelLaunchState",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatParallelLaunchStateGet, args),
        ),
      set: async (args: AgentChatSetParallelLaunchStateArgs): Promise<void> =>
        callProjectRuntimeActionOr(
          "chat",
          "setParallelLaunchState",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatParallelLaunchStateSet, args),
        ),
    },
    handoff: async (
      args: AgentChatHandoffArgs,
    ): Promise<AgentChatHandoffResult> =>
      callProjectRuntimeActionOr("chat", "handoffSession", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatHandoff, args),
      ),
    send: async (args: AgentChatSendArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "sendMessage",
        { args },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.agentChatSend, args);
      agentChatSummaryCache.clear();
    },
    steer: async (args: AgentChatSteerArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      await callProjectRuntimeActionOr("chat", "steer", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatSteer, args),
      );
      agentChatSummaryCache.clear();
    },
    cancelSteer: async (args: AgentChatCancelSteerArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      await callProjectRuntimeActionOr("chat", "cancelSteer", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatCancelSteer, args),
      );
      agentChatSummaryCache.clear();
    },
    editSteer: async (args: AgentChatEditSteerArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      await callProjectRuntimeActionOr("chat", "editSteer", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatEditSteer, args),
      );
      agentChatSummaryCache.clear();
    },
    dispatchSteer: async (
      args: AgentChatDispatchSteerArgs,
    ): Promise<AgentChatDispatchSteerResult> => {
      agentChatSummaryCache.clear();
      const result = await callProjectRuntimeActionOr(
        "chat",
        "dispatchSteer",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatDispatchSteer, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    cancelDispatchedSteer: async (
      args: AgentChatCancelDispatchedSteerArgs,
    ): Promise<AgentChatCancelDispatchedSteerResult> => {
      agentChatSummaryCache.clear();
      const result = await callProjectRuntimeActionOr(
        "chat",
        "cancelDispatchedSteer",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatCancelDispatchedSteer, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    interrupt: async (args: AgentChatInterruptArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "interrupt",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatInterrupt, args);
      agentChatSummaryCache.clear();
    },
    approve: async (args: AgentChatApproveArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "approveToolUse",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatApprove, args);
      agentChatSummaryCache.clear();
    },
    respondToInput: async (
      args: AgentChatRespondToInputArgs,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "respondToInput",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatRespondToInput, args);
      agentChatSummaryCache.clear();
    },
    models: async (
      args: AgentChatModelsArgs,
    ): Promise<AgentChatModelInfo[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        AgentChatModelInfo[]
      >("chat", "getAvailableModels", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.agentChatModels, args);
    },
    modelCatalog: async (
      args?: AgentChatModelCatalogArgs,
    ): Promise<AgentChatModelCatalog> => {
      const runtime = await callProjectRuntimeActionIfBound<
        AgentChatModelCatalog
      >("chat", "modelCatalog", { args: args ?? {} });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.agentChatModelCatalog, args ?? {});
    },
    archive: async (args: AgentChatArchiveArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "archiveSession",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatArchive, args);
      agentChatSummaryCache.clear();
    },
    unarchive: async (args: AgentChatArchiveArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "unarchiveSession",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatUnarchive, args);
      agentChatSummaryCache.clear();
    },
    delete: async (args: AgentChatDeleteArgs): Promise<void> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "deleteSession",
        { args },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.agentChatDelete, args);
      agentChatSummaryCache.clear();
    },
    updateSession: async (
      args: AgentChatUpdateSessionArgs,
    ): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<AgentChatSession>(
        "chat",
        "updateSession",
        { args },
      );
      const session = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.agentChatUpdateSession, args);
      agentChatSummaryCache.clear();
      return session as AgentChatSession;
    },
    warmupModel: async (args: {
      sessionId: string;
      modelId: string;
    }): Promise<void> =>
      callProjectRuntimeActionOr("chat", "warmupModel", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatWarmupModel, args),
      ),
    onEvent: subscribeAgentChatEvents,
    slashCommands: async (
      args: AgentChatSlashCommandsArgs,
    ): Promise<AgentChatSlashCommand[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        AgentChatSlashCommand[]
      >("chat", "getSlashCommands", { args });
      if (runtime.handled) {
        return Array.isArray(runtime.result) ? runtime.result : [];
      }
      return ipcRenderer.invoke(IPC.agentChatSlashCommands, args);
    },
    listClaudePlugins: async (
      args: AgentChatClaudePluginsArgs = {},
    ): Promise<AgentChatClaudePlugin[]> =>
      callProjectRuntimeActionOr("chat", "listClaudePlugins", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatListClaudePlugins, args),
      ),
    reloadClaudePlugins: async (
      args: AgentChatReloadClaudePluginsArgs,
    ): Promise<AgentChatReloadClaudePluginsResult> =>
      callProjectRuntimeActionOr("chat", "reloadClaudePlugins", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatReloadClaudePlugins, args),
      ),
    listClaudeOutputStyles: async (
      args: AgentChatClaudeOutputStylesArgs = {},
    ): Promise<AgentChatClaudeOutputStyle[]> =>
      callProjectRuntimeActionOr("chat", "listClaudeOutputStyles", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatListClaudeOutputStyles, args),
      ),
    setClaudeOutputStyle: async (
      args: AgentChatSetClaudeOutputStyleArgs,
    ): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const session = await callProjectRuntimeActionOr("chat", "setClaudeOutputStyle", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatSetClaudeOutputStyle, args),
      );
      agentChatSummaryCache.clear();
      return session as AgentChatSession;
    },
    listClaudeSessions: async (
      args: AgentChatClaudeSessionListArgs = {},
    ): Promise<AgentChatClaudeSessionInfo[]> =>
      callProjectRuntimeActionOr("chat", "listClaudeSessions", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatListClaudeSessions, args),
      ),
    getClaudeSessionInfo: async (
      args: AgentChatClaudeSessionInfoArgs,
    ): Promise<AgentChatClaudeSessionInfo | null> =>
      callProjectRuntimeActionOr("chat", "getClaudeSessionInfo", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetClaudeSessionInfo, args),
      ),
    getClaudeSessionMessages: async (
      args: AgentChatClaudeSessionMessagesArgs,
    ): Promise<AgentChatClaudeSessionMessage[]> =>
      callProjectRuntimeActionOr("chat", "getClaudeSessionMessages", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetClaudeSessionMessages, args),
      ),
    getSubagentTranscript: async (
      args: AgentChatSubagentTranscriptArgs,
    ): Promise<AgentChatSubagentTranscriptMessage[] | null> =>
      callProjectRuntimeActionOr("chat", "getSubagentTranscript", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetSubagentTranscript, args),
      ),
    getContextUsage: async (
      args: AgentChatContextUsageArgs,
    ): Promise<AgentChatContextUsage | null> =>
      callProjectRuntimeActionOr("chat", "getContextUsage", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetContextUsage, args),
      ),
    rewindFiles: async (
      args: AgentChatRewindFilesArgs,
    ): Promise<AgentChatRewindFilesResult> =>
      callProjectRuntimeActionOr("chat", "rewindFiles", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatRewindFiles, args),
      ),
    fileSearch: async (
      args: AgentChatFileSearchArgs,
    ): Promise<AgentChatFileSearchResult[]> =>
      callProjectRuntimeActionOr("chat", "fileSearch", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatFileSearch, args),
      ),
    getTurnFileDiff: async (
      args: AgentChatGetTurnFileDiffArgs,
    ): Promise<AgentChatTurnFileDiff | null> =>
      callProjectRuntimeActionOr("chat", "getTurnFileDiff", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetTurnFileDiff, args),
      ),
    listSubagents: async (
      args: AgentChatSubagentListArgs,
    ): Promise<AgentChatSubagentSnapshot[]> =>
      callProjectRuntimeActionOr("chat", "listSubagents", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatListSubagents, args),
      ),
    getSessionCapabilities: async (
      args: AgentChatSessionCapabilitiesArgs,
    ): Promise<AgentChatSessionCapabilities> =>
      callProjectRuntimeActionOr(
        "chat",
        "getSessionCapabilities",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatGetSessionCapabilities, args),
      ),
    saveTempAttachment: async (args: {
      data: string;
      filename: string;
    }): Promise<{ path: string }> =>
      callProjectRuntimeActionOr("chat", "saveTempAttachment", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatSaveTempAttachment, args),
      ),
    getEventHistory: async (args: {
      sessionId: string;
      maxEvents?: number;
    }): Promise<AgentChatEventHistorySnapshot> => {
      const runtime = await callProjectRuntimeActionIfBound<AgentChatEventHistorySnapshot>("chat", "getChatEventHistory", {
        argsList: [args.sessionId, { maxEvents: args.maxEvents }],
      });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.agentChatGetEventHistory, args);
    },
    codex: {
      openInCli: (
        args: AgentChatCodexOpenInCliArgs,
      ): Promise<AgentChatCodexOpenInCliResult> =>
        callProjectRuntimeActionOr("chat", "codexOpenInCli", { args }, () =>
          ipcRenderer.invoke(IPC.agentChatCodexOpenInCli, args),
        ),
    },
  },
  computerUse: {
    listArtifacts: async (
      args: ComputerUseArtifactListArgs = {},
    ): Promise<ComputerUseArtifactView[]> =>
      callProjectRuntimeActionOr(
        "computer_use_artifacts",
        "listArtifacts",
        { args },
        () => ipcRenderer.invoke(IPC.computerUseListArtifacts, args),
      ),
    getOwnerSnapshot: async (
      args: ComputerUseOwnerSnapshotArgs,
    ): Promise<ComputerUseOwnerSnapshot> =>
      computerUseOwnerSnapshotCache.get(serializeIpcCacheArgs(args)),
    routeArtifact: async (
      args: ComputerUseArtifactRouteArgs,
    ): Promise<ComputerUseArtifactView> =>
      clearAround(
        () => computerUseOwnerSnapshotCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "computer_use_artifacts",
            "routeArtifact",
            { args },
            () => ipcRenderer.invoke(IPC.computerUseRouteArtifact, args),
          ),
      ),
    updateArtifactReview: async (
      args: ComputerUseArtifactReviewArgs,
    ): Promise<ComputerUseArtifactView> =>
      clearAround(
        () => computerUseOwnerSnapshotCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "computer_use_artifacts",
            "updateArtifactReview",
            { args },
            () => ipcRenderer.invoke(IPC.computerUseUpdateArtifactReview, args),
          ),
      ),
    readArtifactPreview: async (args: {
      uri: string;
    }): Promise<string | null> =>
      callProjectRuntimeActionOr(
        "computer_use_artifacts",
        "readArtifactPreview",
        { args },
        () => ipcRenderer.invoke(IPC.computerUseReadArtifactPreview, args),
      ),
    onEvent: subscribeComputerUseEvents,
  },
  iosSimulator: {
    getStatus: async (): Promise<IosSimulatorStatus> =>
      iosSimulatorStatusCache.get(),
    listDevices: async (): Promise<IosSimulatorDevice[]> =>
      iosSimulatorDevicesCache.get(),
    listLaunchTargets: async (
      args: IosSimulatorListLaunchTargetsArgs = {},
    ): Promise<IosSimulatorLaunchTarget[]> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "listLaunchTargets",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorListLaunchTargets, args),
      ),
    launch: async (
      args: IosSimulatorLaunchArgs = {},
    ): Promise<IosSimulatorSession> => {
      clearIosSimulatorStatusCaches();
      try {
        return await callProjectRuntimeActionOr(
          "ios_simulator",
          "launch",
          { args },
          () => ipcRenderer.invoke(IPC.iosSimulatorLaunch, args),
        );
      } finally {
        clearIosSimulatorStatusCaches();
      }
    },
    attachToChatSession: async (args: {
      chatSessionId: string | null;
      callerChatSessionId?: string | null;
    }): Promise<IosSimulatorSession | null> => {
      clearIosSimulatorStatusCaches();
      try {
        return await callProjectRuntimeActionOr(
          "ios_simulator",
          "attachToChatSession",
          { argsList: [args.chatSessionId, args.callerChatSessionId] },
          () => ipcRenderer.invoke(IPC.iosSimulatorAttachToChatSession, args),
        );
      } finally {
        clearIosSimulatorStatusCaches();
      }
    },
    shutdown: async (
      args: IosSimulatorShutdownArgs = {},
    ): Promise<IosSimulatorShutdownResult> => {
      clearIosSimulatorStatusCaches();
      try {
        return await callProjectRuntimeActionOr(
          "ios_simulator",
          "shutdown",
          { args },
          () => ipcRenderer.invoke(IPC.iosSimulatorShutdown, args),
        );
      } finally {
        clearIosSimulatorStatusCaches();
      }
    },
    screenshot: async (
      args: { deviceUdid?: string | null } = {},
    ): Promise<IosSimulatorScreenshot> =>
      callProjectRuntimeActionOr("ios_simulator", "screenshot", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorScreenshot, args),
      ),
    getScreenSnapshot: async (
      args: IosScreenSnapshotArgs = {},
    ): Promise<IosScreenSnapshot> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "getScreenSnapshot",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorGetScreenSnapshot, args),
      ),
    getInspectorSnapshot: async (
      args: { deviceUdid?: string | null } = {},
    ): Promise<IosInspectorSnapshot | null> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "getInspectorSnapshot",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorGetInspectorSnapshot, args),
      ),
    inspectPoint: async (
      args: IosSimulatorInspectPointArgs,
    ): Promise<IosSimulatorInspectResult> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "inspectPoint",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorInspectPoint, args),
      ),
    getPreviewCapability: async (
      args: IosSimulatorListPreviewsArgs = {},
    ): Promise<IosSimulatorPreviewCapability> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "getPreviewCapability",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorGetPreviewCapability, args),
      ),
    listPreviewTargets: async (
      args: IosSimulatorListPreviewsArgs = {},
    ): Promise<IosSimulatorPreviewTarget[]> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "listPreviewTargets",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorListPreviewTargets, args),
      ),
    renderPreview: async (
      args: IosSimulatorRenderPreviewArgs,
    ): Promise<IosSimulatorRenderPreviewResult> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "renderPreview",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorRenderPreview, args),
      ),
    openPreviewWorkspace: async (
      args: IosSimulatorOpenPreviewWorkspaceArgs = {},
    ): Promise<{ ok: true; path: string }> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "openPreviewWorkspace",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorOpenPreviewWorkspace, args),
      ),
    startStream: async (
      args: IosSimulatorStartStreamArgs = {},
    ): Promise<IosSimulatorStreamStatus> => {
      clearIosSimulatorStatusCaches();
      try {
        return await callProjectRuntimeActionOr(
          "ios_simulator",
          "startStream",
          { args },
          () => ipcRenderer.invoke(IPC.iosSimulatorStartStream, args),
        );
      } finally {
        clearIosSimulatorStatusCaches();
      }
    },
    stopStream: async (): Promise<IosSimulatorStreamStatus> => {
      clearIosSimulatorStatusCaches();
      try {
        return await callProjectRuntimeActionOr(
          "ios_simulator",
          "stopStream",
          {},
          () => ipcRenderer.invoke(IPC.iosSimulatorStopStream),
        );
      } finally {
        clearIosSimulatorStatusCaches();
      }
    },
    getStreamStatus: async (): Promise<IosSimulatorStreamStatus> =>
      callProjectRuntimeActionOr("ios_simulator", "getStreamStatus", {}, () =>
        ipcRenderer.invoke(IPC.iosSimulatorGetStreamStatus),
      ),
    getSimulatorWindowState: async (): Promise<IosSimulatorWindowState> => {
      await assertLocalProjectHostAction("iOS Simulator window state");
      return ipcRenderer.invoke(IPC.iosSimulatorGetWindowState);
    },
    listSimulatorWindowSources: async (): Promise<
      IosSimulatorWindowSource[]
    > => {
      await assertLocalProjectHostAction("iOS Simulator window sources");
      return ipcRenderer.invoke(IPC.iosSimulatorListWindowSources);
    },
    tap: async (args: {
      deviceUdid?: string | null;
      projectRoot?: string | null;
      x: number;
      y: number;
    }): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("ios_simulator", "tap", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorTap, args),
      ),
    typeText: async (args: {
      deviceUdid?: string | null;
      projectRoot?: string | null;
      text: string;
    }): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("ios_simulator", "typeText", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorTypeText, args),
      ),
    drag: async (args: IosSimulatorDragArgs): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("ios_simulator", "drag", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorDrag, args),
      ),
    swipe: async (args: IosSimulatorDragArgs): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("ios_simulator", "swipe", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorSwipe, args),
      ),
    selectPoint: async (args: {
      deviceUdid?: string | null;
      projectRoot?: string | null;
      x: number;
      y: number;
    }): Promise<IosSimulatorSelectResult> =>
      callProjectRuntimeActionOr("ios_simulator", "selectPoint", { args }, () =>
        ipcRenderer.invoke(IPC.iosSimulatorSelectPoint, args),
      ),
    onEvent: subscribeIosSimulatorEvents,
  },
  appControl: {
    getStatus: async (): Promise<AppControlStatus> =>
      appControlStatusCache.get(),
    launch: async (
      args: AppControlLaunchArgs = {},
    ): Promise<AppControlSession> =>
      clearAround(
        () => appControlStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("app_control", "launch", { args }, () =>
            ipcRenderer.invoke(IPC.appControlLaunch, args),
          ),
      ),
    launchInTerminal: async (
      args: AppControlLaunchArgs = {},
    ): Promise<AppControlSession> =>
      clearAround(
        () => appControlStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "app_control",
            "launchInTerminal",
            { args },
            () => ipcRenderer.invoke(IPC.appControlLaunchInTerminal, args),
          ),
      ),
    connect: async (args: AppControlConnectArgs): Promise<AppControlSession> =>
      clearAround(
        () => appControlStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("app_control", "connect", { args }, () =>
            ipcRenderer.invoke(IPC.appControlConnect, args),
          ),
      ),
    stop: async (
      args: AppControlStopArgs = {},
    ): Promise<{ ok: true; previousSession: AppControlSession | null }> =>
      clearAround(
        () => appControlStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("app_control", "stop", { args }, () =>
            ipcRenderer.invoke(IPC.appControlStop, args),
          ),
      ),
    screenshot: async (): Promise<AppControlScreenshot> =>
      callProjectRuntimeActionOr("app_control", "screenshot", {}, () =>
        ipcRenderer.invoke(IPC.appControlScreenshot),
      ),
    getSnapshot: async (
      args: AppControlSnapshotArgs = {},
    ): Promise<AppControlSnapshot> =>
      callProjectRuntimeActionOr("app_control", "getSnapshot", { args }, () =>
        ipcRenderer.invoke(IPC.appControlGetSnapshot, args),
      ),
    inspectPoint: async (
      args: AppControlInspectPointArgs,
    ): Promise<AppControlInspectResult> =>
      callProjectRuntimeActionOr("app_control", "inspectPoint", { args }, () =>
        ipcRenderer.invoke(IPC.appControlInspectPoint, args),
      ),
    selectPoint: async (
      args: AppControlInspectPointArgs,
    ): Promise<AppControlSelectResult> =>
      callProjectRuntimeActionOr("app_control", "selectPoint", { args }, () =>
        ipcRenderer.invoke(IPC.appControlSelectPoint, args),
      ),
    click: async (args: AppControlClickArgs): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "click", { args }, () =>
        ipcRenderer.invoke(IPC.appControlClick, args),
      ),
    typeText: async (args: AppControlTypeTextArgs): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "typeText", { args }, () =>
        ipcRenderer.invoke(IPC.appControlTypeText, args),
      ),
    scroll: async (args: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      scale?: number | null;
    }): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "scroll", { args }, () =>
        ipcRenderer.invoke(IPC.appControlScroll, args),
      ),
    dispatchKey: async (args: {
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key?: string | null;
      code?: string | null;
      text?: string | null;
      modifiers?: number | null;
    }): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "dispatchKey", { args }, () =>
        ipcRenderer.invoke(IPC.appControlDispatchKey, args),
      ),
    listTargets: async (): Promise<AppControlTarget[]> =>
      callProjectRuntimeActionOr("app_control", "listTargets", {}, () =>
        ipcRenderer.invoke(IPC.appControlListTargets),
      ),
    attachToTarget: async (args: {
      targetId: string;
    }): Promise<AppControlSession> =>
      clearAround(
        () => appControlStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "app_control",
            "attachToTarget",
            { argsList: [args.targetId] },
            () => ipcRenderer.invoke(IPC.appControlAttachToTarget, args),
          ),
      ),
    onEvent: subscribeAppControlEvents,
  },
  builtInBrowser: {
    getStatus: async (): Promise<BuiltInBrowserStatus> =>
      builtInBrowserStatusCache.get(),
    showPanel: async (
      args: BuiltInBrowserOpenPanelArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserShowPanel, args),
      ),
    setBounds: async (
      args: BuiltInBrowserBoundsArgs,
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserSetBounds, args),
      ),
    attachWebview: async (
      args: BuiltInBrowserAttachWebviewArgs,
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserAttachWebview, args),
      ),
    navigate: async (
      args: BuiltInBrowserNavigateArgs,
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserNavigate, args),
      ),
    createTab: async (
      args: BuiltInBrowserCreateTabArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserCreateTab, args),
      ),
    switchTab: async (
      args: BuiltInBrowserTabArgs,
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserSwitchTab, args),
      ),
    closeTab: async (
      args: BuiltInBrowserTabArgs,
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserCloseTab, args),
      ),
    reload: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserReload),
      ),
    goBack: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserGoBack),
      ),
    goForward: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserGoForward),
      ),
    stop: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStop),
      ),
    startInspect: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStartInspect),
      ),
    stopInspect: async (): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStopInspect),
      ),
    captureScreenshot: async (): Promise<BuiltInBrowserScreenshot> =>
      ipcRenderer.invoke(IPC.builtInBrowserCaptureScreenshot),
    selectPoint: async (
      args: BuiltInBrowserSelectPointArgs,
    ): Promise<BuiltInBrowserSelectResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserSelectPoint, args),
    selectCurrent: async (): Promise<BuiltInBrowserSelectResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserSelectCurrent),
    clearSelection: async (): Promise<{ ok: true }> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserClearSelection),
      ),
    onEvent: builtInBrowserEventFanout,
  },
  macosVm: {
    getStatus: async (args: MacosVmStatusArgs = {}): Promise<MacosVmStatus> =>
      macosVmStatusCache.get(serializeIpcCacheArgs(args)),
    provision: async (args: MacosVmProvisionArgs): Promise<MacosVmRecord> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "provision", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmProvision, args),
          ),
      ),
    start: async (args: MacosVmStartArgs): Promise<MacosVmRecord> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "start", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmStart, args),
          ),
      ),
    stop: async (args: MacosVmStopArgs): Promise<MacosVmRecord | null> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "stop", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmStop, args),
          ),
      ),
    delete: async (
      args: MacosVmDeleteArgs,
    ): Promise<{ deleted: boolean; previous: MacosVmRecord | null }> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "delete", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmDelete, args),
          ),
      ),
    getAgentGuide: async (
      args: MacosVmAgentGuideArgs,
    ): Promise<MacosVmAgentGuide> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "getAgentGuide", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmGetAgentGuide, args),
      ),
    focusWindow: async (
      args: MacosVmFocusWindowArgs,
    ): Promise<MacosVmWindowTarget> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "focusWindow", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmFocusWindow, args),
      ),
    getDisplaySession: async (
      args: MacosVmDisplaySessionArgs,
    ): Promise<MacosVmDisplaySession> => {
      await assertLocalProjectHostAction("macOS VM display session");
      return ipcRenderer.invoke(IPC.macosVmGetDisplaySession, args);
    },
    captureScreenshot: async (
      args: MacosVmCaptureScreenshotArgs,
    ): Promise<MacosVmCaptureScreenshotResult> =>
      callRemoteProjectRuntimeActionOr(
        "macos_vm",
        "captureScreenshot",
        { args },
        () => ipcRenderer.invoke(IPC.macosVmCaptureScreenshot, args),
      ),
    selectPoint: async (
      args: MacosVmSelectPointArgs,
    ): Promise<MacosVmSelectPointResult> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "selectPoint", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmSelectPoint, args),
      ),
    click: async (
      args: MacosVmClickArgs,
    ): Promise<{
      ok: true;
      window: MacosVmWindowTarget;
      x: number;
      y: number;
    }> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "click", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmClick, args),
      ),
    typeText: async (
      args: MacosVmTypeTextArgs,
    ): Promise<{ ok: true; window: MacosVmWindowTarget }> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "typeText", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmTypeText, args),
      ),
    restart: async (args: MacosVmRestartArgs = {}): Promise<MacosVmRecord | null> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "restart", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmRestart, args),
          ),
      ),
    wipe: async (args: MacosVmWipeArgs): Promise<MacosVmWipeResult> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "wipe", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmWipe, args),
          ),
      ),
    installRuntime: async (
      args: MacosVmInstallRuntimeArgs = {},
    ): Promise<MacosVmRuntimeInstallStatus> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        () =>
          callRemoteProjectRuntimeActionOr("macos_vm", "installRuntime", { args }, () =>
            ipcRenderer.invoke(IPC.macosVmInstallRuntime, args),
          ),
      ),
    setCredentials: async (args: MacosVmSetCredentialsArgs): Promise<{ ok: true }> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        async () => {
          await assertLocalProjectHostAction("macOS VM credentials");
          return ipcRenderer.invoke(IPC.macosVmSetCredentials, args);
        },
      ),
    getCredentials: async (
      args: MacosVmGetCredentialsArgs,
    ): Promise<MacosVmStoredCredentialsSummary> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "getCredentials", { args }, () =>
        ipcRenderer.invoke(IPC.macosVmGetCredentials, args),
      ),
    detachLane: async (args: MacosVmDetachLaneArgs): Promise<MacosVmDetachLaneResult> =>
      clearAround(
        () => macosVmStatusCache.clear(),
        async () => {
          await assertLocalProjectHostAction("macOS VM lane detach");
          return ipcRenderer.invoke(IPC.macosVmDetachLane, args);
        },
      ),
    getStorageInfo: async (): Promise<MacosVmStorageInfo> =>
      callRemoteProjectRuntimeActionOr("macos_vm", "getStorageInfo", {}, () =>
        ipcRenderer.invoke(IPC.macosVmGetStorageInfo),
      ),
    onEvent: subscribeMacosVmEvents,
  },
  terminal: {
    list: async (
      args: ChatTerminalListArgs = {},
    ): Promise<ChatTerminalSession[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        ChatTerminalSession[]
      >("terminal", "list", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalList, args);
    },
    read: async (
      args: ChatTerminalReadArgs = {},
    ): Promise<ChatTerminalReadResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ChatTerminalReadResult>(
          "terminal",
          "read",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalRead, args);
    },
    preview: async (
      args: ChatTerminalPreviewArgs = {},
    ): Promise<ChatTerminalPreviewResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ChatTerminalPreviewResult>(
          "terminal",
          "preview",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalPreview, args);
    },
    write: async (args: ChatTerminalWriteArgs): Promise<{ ok: true }> => {
      const runtime = await callProjectRuntimeActionIfBound<{ ok: true }>(
        "terminal",
        "write",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalWrite, args);
    },
    signal: async (args: ChatTerminalSignalArgs): Promise<{ ok: true }> => {
      const runtime = await callProjectRuntimeActionIfBound<{ ok: true }>(
        "terminal",
        "signal",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalSignal, args);
    },
    activeForChat: async (
      args: ChatTerminalActiveForChatArgs,
    ): Promise<ChatTerminalSession | null> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ChatTerminalSession | null>(
          "terminal",
          "activeForChat",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalActiveForChat, args);
    },
    reattachChatCli: async (
      args: ChatTerminalReattachArgs,
    ): Promise<ChatTerminalReattachResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ChatTerminalReattachResult>(
          "terminal",
          "reattachChatCli",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.terminalReattachChatCli, args);
    },
  },
  localhost: {
    probePort: async (port: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.localhostProbePort, { port }),
  },
  pty: {
    create: async (args: PtyCreateArgs): Promise<PtyCreateResult> => {
      const runtime = await callProjectRuntimeActionIfBound<PtyCreateResult>(
        "pty",
        "create",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.ptyCreate, args);
    },
    sendToSession: async (
      args: PtySendToSessionArgs,
    ): Promise<PtySendToSessionResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<PtySendToSessionResult>(
          "pty",
          "sendToSession",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.ptySendToSession, args);
    },
    write: async (arg: { ptyId: string; data: string }): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "pty",
        "write",
        { args: arg },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.ptyWrite, arg);
    },
    resize: async (arg: {
      ptyId: string;
      cols: number;
      rows: number;
    }): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "pty",
        "resize",
        { args: arg },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.ptyResize, arg);
    },
    dispose: async (arg: {
      ptyId: string;
      sessionId?: string;
    }): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "pty",
        "dispose",
        { args: arg },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.ptyDispose, arg);
    },
    onData: subscribePtyDataEvents,
    onExit: subscribePtyExitEvents,
  },
  diff: {
    getChanges: async (args: GetDiffChangesArgs): Promise<DiffChanges> => {
      const runtime = await callProjectRuntimeActionIfBound<DiffChanges>(
        "diff",
        "getChanges",
        { arg: args.laneId },
      );
      if (runtime.handled) return runtime.result;
      return diffChangesCache.get(serializeIpcCacheArgs(args));
    },
    getFile: async (args: GetFileDiffArgs): Promise<FileDiff> => {
      const runtime = await callProjectRuntimeActionIfBound<FileDiff>(
        "diff",
        "getFileDiff",
        {
          args: {
            laneId: args.laneId,
            filePath: args.path,
            mode: args.mode,
            compareRef: args.compareRef,
            compareTo: args.compareTo,
          },
        },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.diffGetFile, args);
    },
    getFilePatch: async (args: GetFilePatchArgs): Promise<FilePatch> => {
      const runtime = await callProjectRuntimeActionIfBound<FilePatch>(
        "diff",
        "getFilePatch",
        {
          args: {
            laneId: args.laneId,
            filePath: args.path,
            mode: args.mode,
            compareRef: args.compareRef,
            compareTo: args.compareTo,
          },
        },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.diffGetFilePatch, args);
    },
  },
  files: {
    writeTextAtomic: async (args: WriteTextAtomicArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "writeTextAtomic",
        { args },
        () => ipcRenderer.invoke(IPC.filesWriteTextAtomic, args),
      );
    },
    listWorkspaces: async (
      args: FilesListWorkspacesArgs = {},
    ): Promise<FilesWorkspace[]> => {
      return callProjectFileRuntimeActionOr<FilesWorkspace[]>(
        "listWorkspaces",
        { args },
        () => ipcRenderer.invoke(IPC.filesListWorkspaces, args),
      );
    },
    listTree: async (args: FilesListTreeArgs): Promise<FileTreeNode[]> => {
      return callProjectFileRuntimeActionOr<FileTreeNode[]>(
        "listTree",
        { args },
        () => ipcRenderer.invoke(IPC.filesListTree, args),
      );
    },
    readFile: async (args: FilesReadFileArgs): Promise<FileContent> => {
      return callProjectFileRuntimeActionOr<FileContent>(
        "readFile",
        { args },
        () => ipcRenderer.invoke(IPC.filesReadFile, args),
      );
    },
    writeText: async (args: FilesWriteTextArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "writeWorkspaceText",
        { args },
        () => ipcRenderer.invoke(IPC.filesWriteText, args),
      );
    },
    createFile: async (args: FilesCreateFileArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "createFile",
        { args },
        () => ipcRenderer.invoke(IPC.filesCreateFile, args),
      );
    },
    createDirectory: async (args: FilesCreateDirectoryArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "createDirectory",
        { args },
        () => ipcRenderer.invoke(IPC.filesCreateDirectory, args),
      );
    },
    rename: async (args: FilesRenameArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "rename",
        { args },
        () => ipcRenderer.invoke(IPC.filesRename, args),
      );
    },
    delete: async (args: FilesDeleteArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "deletePath",
        { args },
        () => ipcRenderer.invoke(IPC.filesDelete, args),
      );
    },
    watchChanges: async (args: FilesWatchArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "watchWorkspace",
        { args },
        () => ipcRenderer.invoke(IPC.filesWatchChanges, args),
      );
    },
    stopWatching: async (args: FilesWatchArgs): Promise<void> => {
      await callProjectFileRuntimeActionOr<void>(
        "stopWatching",
        { args },
        () => ipcRenderer.invoke(IPC.filesStopWatching, args),
      );
    },
    quickOpen: async (
      args: FilesQuickOpenArgs,
    ): Promise<FilesQuickOpenItem[]> => {
      return callProjectFileRuntimeActionOr<FilesQuickOpenItem[]>(
        "quickOpen",
        { args },
        () => ipcRenderer.invoke(IPC.filesQuickOpen, args),
      );
    },
    searchText: async (
      args: FilesSearchTextArgs,
    ): Promise<FilesSearchTextMatch[]> => {
      return callProjectFileRuntimeActionOr<FilesSearchTextMatch[]>(
        "searchText",
        { args },
        () => ipcRenderer.invoke(IPC.filesSearchText, args),
      );
    },
    onChange: (cb: (ev: FileChangeEvent) => void) => {
      const unsubscribeRuntime = subscribeRemoteFileChangeEvents(cb);
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: FileChangeEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.filesChange, listener);
      return () => {
        unsubscribeRuntime();
        ipcRenderer.removeListener(IPC.filesChange, listener);
      };
    },
  },
  git: {
    stageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stageFile",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStageFile, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stageAll: async (
      args: GitBatchFileActionArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stageAll",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStageAll, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    unstageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "unstageFile",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitUnstageFile, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    unstageAll: async (
      args: GitBatchFileActionArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "unstageAll",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitUnstageAll, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    discardFile: async (args: GitFileActionArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "discardFile",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitDiscardFile, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    restoreStagedFile: async (
      args: GitFileActionArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "restoreStagedFile",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitRestoreStagedFile, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    commit: async (args: GitCommitArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "commit",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitCommit, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    generateCommitMessage: async (
      args: GitGenerateCommitMessageArgs,
    ): Promise<GitGenerateCommitMessageResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<GitGenerateCommitMessageResult>(
          "git",
          "generateCommitMessage",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGenerateCommitMessage, args);
    },
    listRecentCommits: async (args: {
      laneId: string;
      limit?: number;
    }): Promise<GitCommitSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<GitCommitSummary[]>(
        "git",
        "listRecentCommits",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitListRecentCommits, args);
    },
    listCommitFiles: async (
      args: GitListCommitFilesArgs,
    ): Promise<string[]> => {
      const runtime = await callProjectRuntimeActionIfBound<string[]>(
        "git",
        "listCommitFiles",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitListCommitFiles, args);
    },
    getCommitMessage: async (
      args: GitGetCommitMessageArgs,
    ): Promise<string> => {
      const runtime = await callProjectRuntimeActionIfBound<string>(
        "git",
        "getCommitMessage",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetCommitMessage, args);
    },
    getCommit: async (
      args: { laneId: string; commitSha: string },
    ): Promise<GitCommitSummary | null> => {
      const runtime = await callProjectRuntimeActionIfBound<GitCommitSummary | null>(
        "git",
        "getCommit",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetCommit, args);
    },
    revertCommit: async (args: GitRevertArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "revertCommit",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitRevertCommit, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    cherryPickCommit: async (
      args: GitCherryPickArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "cherryPickCommit",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitCherryPickCommit, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    createTag: async (args: GitCreateTagArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "createTag",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitCreateTag, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    resetToCommit: async (
      args: GitResetCommitArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "resetToCommit",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitResetToCommit, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stashPush: async (args: GitStashPushArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stashPush",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStashPush, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stashList: async (args: { laneId: string }): Promise<GitStashSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<GitStashSummary[]>(
        "git",
        "listStashes",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitStashList, args);
    },
    stashApply: async (args: GitStashRefArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stashApply",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStashApply, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stashPop: async (args: GitStashRefArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stashPop",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStashPop, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stashDrop: async (args: GitStashRefArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stashDrop",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStashDrop, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    stashClear: async (args: { laneId: string }): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "stashClear",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitStashClear, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    fetch: async (args: { laneId: string }): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "fetch",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitFetch, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    pull: async (args: GitPullArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "pull",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitPull, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    undoLastHeadChange: async (args: GitHeadChangeActionArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "undoLastHeadChange",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitUndoLastHeadChange, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    redoLastHeadChange: async (args: GitHeadChangeActionArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "redoLastHeadChange",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitRedoLastHeadChange, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    getSyncStatus: async (args: {
      laneId: string;
    }): Promise<GitUpstreamSyncStatus> => {
      const runtime =
        await callProjectRuntimeActionIfBound<GitUpstreamSyncStatus>(
          "git",
          "getSyncStatus",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetSyncStatus, args);
    },
    getOriginRemote: async (args: {
      laneId: string;
    }): Promise<{ remoteUrl: string | null; branch: string | null }> => {
      const runtime = await callProjectRuntimeActionIfBound<{
        remoteUrl: string | null;
        branch: string | null;
      }>("git", "getOriginRemote", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetOriginRemote, args);
    },
    getOpenPrForBranch: async (args: {
      laneId: string;
      branch?: string;
    }): Promise<{
      prUrl: string | null;
      prNumber: number | null;
      title: string | null;
      headRefName: string | null;
    }> => {
      const runtime = await callProjectRuntimeActionIfBound<{
        prUrl: string | null;
        prNumber: number | null;
        title: string | null;
        headRefName: string | null;
      }>("git", "getOpenPrForBranch", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetOpenPrForBranch, args);
    },
    sync: async (args: GitSyncArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "sync",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitSync, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    push: async (args: GitPushArgs): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "push",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitPush, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
    getConflictState: async (laneId: string): Promise<GitConflictState> => {
      const runtime = await callProjectRuntimeActionIfBound<GitConflictState>(
        "git",
        "getConflictState",
        { args: { laneId } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetConflictState, { laneId });
    },
    rebaseContinue: async (args: string | { laneId: string }): Promise<GitActionResult> => {
      const laneId = normalizeLaneIdArg(args);
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "rebaseContinue",
        { args: { laneId } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitRebaseContinue, { laneId });
    },
    rebaseAbort: async (args: string | { laneId: string }): Promise<GitActionResult> => {
      const laneId = normalizeLaneIdArg(args);
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "rebaseAbort",
        { args: { laneId } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitRebaseAbort, { laneId });
    },
    mergeContinue: async (args: string | { laneId: string }): Promise<GitActionResult> => {
      const laneId = normalizeLaneIdArg(args);
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "mergeContinue",
        { args: { laneId } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitMergeContinue, { laneId });
    },
    mergeAbort: async (args: string | { laneId: string }): Promise<GitActionResult> => {
      const laneId = normalizeLaneIdArg(args);
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "mergeAbort",
        { args: { laneId } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitMergeAbort, { laneId });
    },
    listBranches: async (
      args: GitListBranchesArgs,
    ): Promise<GitBranchSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<GitBranchSummary[]>(
        "git",
        "listBranches",
        { args },
      );
      if (runtime.handled) return runtime.result;
      return gitBranchesCache.get(serializeIpcCacheArgs(args));
    },
    getUserIdentity: async (
      args: GitGetUserIdentityArgs,
    ): Promise<GitUserIdentity> => {
      const runtime = await callProjectRuntimeActionIfBound<GitUserIdentity>(
        "git",
        "getUserIdentity",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitGetUserIdentity, args);
    },
    checkoutBranch: async (
      args: GitCheckoutBranchArgs,
    ): Promise<GitActionResult> => {
      clearGitReadCaches();
      const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
        "git",
        "checkoutBranch",
        { args },
      );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.gitCheckoutBranch, args);
      clearGitReadCaches();
      return result as GitActionResult;
    },
  },
  conflicts: {
    getLaneStatus: async (
      args: GetLaneConflictStatusArgs,
    ): Promise<ConflictStatus> =>
      callProjectRuntimeActionOr("conflicts", "getLaneStatus", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsGetLaneStatus, args),
      ),
    listOverlaps: async (args: ListOverlapsArgs): Promise<ConflictOverlap[]> =>
      callProjectRuntimeActionOr("conflicts", "listOverlaps", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsListOverlaps, args),
      ),
    getRiskMatrix: async (): Promise<RiskMatrixEntry[]> =>
      callProjectRuntimeActionOr("conflicts", "getRiskMatrix", {}, () =>
        ipcRenderer.invoke(IPC.conflictsGetRiskMatrix),
      ),
    simulateMerge: async (
      args: MergeSimulationArgs,
    ): Promise<MergeSimulationResult> =>
      callProjectRuntimeActionOr("conflicts", "simulateMerge", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsSimulateMerge, args),
      ),
    runPrediction: async (
      args: RunConflictPredictionArgs = {},
    ): Promise<BatchAssessmentResult> =>
      callProjectRuntimeActionOr("conflicts", "runPrediction", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsRunPrediction, args),
      ),
    getBatchAssessment: async (): Promise<BatchAssessmentResult> =>
      callProjectRuntimeActionOr("conflicts", "getBatchAssessment", {}, () =>
        ipcRenderer.invoke(IPC.conflictsGetBatchAssessment),
      ),
    listProposals: async (laneId: string): Promise<ConflictProposal[]> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "listProposals",
        { args: { laneId } },
        () => ipcRenderer.invoke(IPC.conflictsListProposals, { laneId }),
      ),
    prepareProposal: async (
      args: PrepareConflictProposalArgs,
    ): Promise<ConflictProposalPreview> =>
      callProjectRuntimeActionOr("conflicts", "prepareProposal", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsPrepareProposal, args),
      ),
    requestProposal: async (
      args: RequestConflictProposalArgs,
    ): Promise<ConflictProposal> =>
      callProjectRuntimeActionOr("conflicts", "requestProposal", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsRequestProposal, args),
      ),
    applyProposal: async (
      args: ApplyConflictProposalArgs,
    ): Promise<ConflictProposal> =>
      callProjectRuntimeActionOr("conflicts", "applyProposal", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsApplyProposal, args),
      ),
    undoProposal: async (
      args: UndoConflictProposalArgs,
    ): Promise<ConflictProposal> =>
      callProjectRuntimeActionOr("conflicts", "undoProposal", { args }, () =>
        ipcRenderer.invoke(IPC.conflictsUndoProposal, args),
      ),
    runExternalResolver: async (
      args: RunExternalConflictResolverArgs,
    ): Promise<ConflictExternalResolverRunSummary> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "runExternalResolver",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsRunExternalResolver, args),
      ),
    listExternalResolverRuns: async (
      args: ListExternalConflictResolverRunsArgs = {},
    ): Promise<ConflictExternalResolverRunSummary[]> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "listExternalResolverRuns",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsListExternalResolverRuns, args),
      ),
    commitExternalResolverRun: async (
      args: CommitExternalConflictResolverRunArgs,
    ): Promise<CommitExternalConflictResolverRunResult> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "commitExternalResolverRun",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsCommitExternalResolverRun, args),
      ),
    prepareResolverSession: async (
      args: PrepareResolverSessionArgs,
    ): Promise<PrepareResolverSessionResult> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "prepareResolverSession",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsPrepareResolverSession, args),
      ),
    attachResolverSession: async (
      args: AttachResolverSessionArgs,
    ): Promise<ConflictExternalResolverRunSummary> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "attachResolverSession",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsAttachResolverSession, args),
      ),
    finalizeResolverSession: async (
      args: FinalizeResolverSessionArgs,
    ): Promise<ConflictExternalResolverRunSummary> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "finalizeResolverSession",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsFinalizeResolverSession, args),
      ),
    cancelResolverSession: async (
      args: CancelResolverSessionArgs,
    ): Promise<ConflictExternalResolverRunSummary> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "cancelResolverSession",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsCancelResolverSession, args),
      ),
    suggestResolverTarget: async (
      args: SuggestResolverTargetArgs,
    ): Promise<SuggestResolverTargetResult> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "suggestResolverTarget",
        { args },
        () => ipcRenderer.invoke(IPC.conflictsSuggestResolverTarget, args),
      ),
    onEvent: subscribeConflictEvents,
  },
  feedback: {
    prepareDraft: async (
      args: FeedbackPrepareDraftArgs,
    ): Promise<FeedbackPreparedDraft> =>
      callProjectRuntimeActionOr("feedback", "prepareDraft", { args }, () =>
        ipcRenderer.invoke(IPC.feedbackPrepareDraft, args),
      ),
    submitDraft: async (
      args: FeedbackSubmitDraftArgs,
    ): Promise<FeedbackSubmission> =>
      callProjectRuntimeActionOr(
        "feedback",
        "submitPreparedDraft",
        { args },
        () => ipcRenderer.invoke(IPC.feedbackSubmitDraft, args),
      ),
    list: async (): Promise<FeedbackSubmission[]> =>
      callProjectRuntimeActionOr("feedback", "list", {}, () =>
        ipcRenderer.invoke(IPC.feedbackList),
      ),
    onUpdate: subscribeFeedbackEvents,
  },
  github: {
    getStatus: async (opts?: {
      forceRefresh?: boolean;
    }): Promise<GitHubStatus> => {
      if (opts?.forceRefresh) githubStatusCache.clear();
      return callProjectRuntimeActionOr(
        "github",
        "getStatus",
        { args: opts ?? {} },
        () =>
          opts?.forceRefresh
            ? clearAround(
                () => githubStatusCache.clear(),
                () => ipcRenderer.invoke(IPC.githubGetStatus, opts ?? {}),
              )
            : githubStatusCache.get(),
      );
    },
    getRemoteStatus: async (opts?: {
      forceRefresh?: boolean;
    }): Promise<{ repo: GitHubRepoRef | null; hasOrigin: boolean }> => {
      return callProjectRuntimeActionOr(
        "github",
        "getRemoteStatus",
        { args: opts ?? {} },
        () =>
          opts?.forceRefresh
            ? clearAround(
                () => githubRemoteStatusCache.clear(),
                () => ipcRenderer.invoke(IPC.githubGetRemoteStatus, opts ?? {}),
              )
            : githubRemoteStatusCache.get(),
      );
    },
    setToken: async (token: string): Promise<GitHubStatus> =>
      clearAround(
        () => {
          githubStatusCache.clear();
          githubRemoteStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr("github", "setToken", { arg: token }, () =>
            ipcRenderer.invoke(IPC.githubSetToken, { token }),
          ),
      ),
    clearToken: async (): Promise<GitHubStatus> =>
      clearAround(
        () => {
          githubStatusCache.clear();
          githubRemoteStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr("github", "clearToken", {}, () =>
            ipcRenderer.invoke(IPC.githubClearToken),
          ),
      ),
    detectRepo: async (): Promise<{ owner: string; name: string } | null> => {
      const runtime = await callProjectRuntimeActionIfBound<{
        owner: string;
        name: string;
      } | null>("github", "detectRepo", {});
      if (runtime.handled) return runtime.result;
      const status = await githubStatusCache.get();
      return status.repo;
    },
    listRepoAutolinks: async (args: {
      owner?: string;
      name?: string;
    } = {}): Promise<GitHubAutolink[]> =>
      callProjectRuntimeActionOr("github", "listRepoAutolinks", { args }, () =>
        ipcRenderer.invoke(IPC.githubListRepoAutolinks, args),
      ),
    createRepoAutolink: async (args: {
      owner?: string;
      name?: string;
      keyPrefix: string;
      urlTemplate: string;
      isAlphanumeric?: boolean;
    }): Promise<GitHubAutolink> =>
      callProjectRuntimeActionOr("github", "createRepoAutolink", { args }, () =>
        ipcRenderer.invoke(IPC.githubCreateRepoAutolink, args),
      ),
    listRepoLabels: async (args: {
      owner: string;
      name: string;
    }): Promise<Array<{ name: string; color?: string }>> =>
      callProjectRuntimeActionOr("github", "listRepoLabels", { args }, () =>
        ipcRenderer.invoke(IPC.githubListRepoLabels, args),
      ),
    listRepoCollaborators: async (args: {
      owner: string;
      name: string;
    }): Promise<Array<{ login: string; avatarUrl?: string }>> =>
      callProjectRuntimeActionOr(
        "github",
        "listRepoCollaborators",
        { args },
        () => ipcRenderer.invoke(IPC.githubListRepoCollaborators, args),
      ),
    listMyRepos: async (
      input: ListMyGitHubReposInput = {},
    ): Promise<ListMyGitHubReposResult> => {
      const binding = await getRemoteProjectBinding({ fresh: true });
      if (binding) {
        return ipcRenderer.invoke(IPC.remoteRuntimeListMyGitHubRepos, {
          id: binding.targetId,
          input,
        });
      }
      return ipcRenderer.invoke(IPC.githubListMyRepos, input);
    },
    publishCurrentProject: async (
      input: PublishProjectInput,
    ): Promise<PublishProjectResult> =>
      clearAround(
        () => {
          githubStatusCache.clear();
          githubRemoteStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr(
            "github",
            "publishCurrentProject",
            { args: input },
            () => ipcRenderer.invoke(IPC.githubPublishCurrentProject, input),
          ),
      ),
    onStatusChanged: (cb: (status: GitHubStatus) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: GitHubStatus,
      ) => {
        githubStatusCache.clear();
        githubRemoteStatusCache.clear();
        cb(payload);
      };
      ipcRenderer.on(IPC.githubStatusChanged, listener);
      const removeRemote = subscribeRemoteGitHubStatusChangedEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.githubStatusChanged, listener);
      };
    },
  },
  prs: {
    createFromLane: async (args: CreatePrFromLaneArgs): Promise<PrSummary> =>
      callProjectRuntimeActionOr("pr", "createFromLane", { args }, () =>
        ipcRenderer.invoke(IPC.prsCreateFromLane, args),
      ),
    linkToLane: async (args: LinkPrToLaneArgs): Promise<PrSummary> =>
      callProjectRuntimeActionOr("pr", "linkToLane", { args }, () =>
        ipcRenderer.invoke(IPC.prsLinkToLane, args),
      ),
    preflightCreateLaneFromPrBranch: async (
      args: CreateLaneFromPrBranchArgs,
    ): Promise<CreateLaneFromPrBranchPreflightResult> =>
      callProjectRuntimeActionStrictOr("pr", "preflightCreateLaneFromPrBranch", { args }, () =>
        ipcRenderer.invoke(IPC.prsPreflightCreateLaneFromPrBranch, args),
      ),
    createLaneFromPrBranch: async (
      args: CreateLaneFromPrBranchArgs,
    ): Promise<CreateLaneFromPrBranchResult> =>
      callProjectRuntimeActionStrictOr("pr", "createLaneFromPrBranch", { args }, () =>
        ipcRenderer.invoke(IPC.prsCreateLaneFromPrBranch, args),
      ),
    getForLane: async (laneId: string): Promise<PrSummary | null> =>
      callPrReadRuntimeActionOr("getForLane", { arg: laneId }, () =>
        ipcRenderer.invoke(IPC.prsGetForLane, { laneId }),
      ),
    listAll: async (): Promise<PrSummary[]> =>
      callPrReadRuntimeActionOr("listAll", { args: {} }, () =>
        ipcRenderer.invoke(IPC.prsListAll),
      ),
    listOpenForRepo: async (): Promise<BranchPullRequest[]> =>
      callPrReadRuntimeActionOr("listOpenPullRequests", {}, () =>
        ipcRenderer.invoke(IPC.prsListOpenForRepo),
      ),
    refresh: async (
      args: { prId?: string; prIds?: string[] } = {},
    ): Promise<PrSummary[]> =>
      callPrReadRuntimeActionOr("refresh", { args }, () =>
        ipcRenderer.invoke(IPC.prsRefresh, args),
      ),
    getStatus: async (prId: string): Promise<PrStatus | null> =>
      callPrReadRuntimeActionOr("getStatus", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetStatus, { prId }),
      ),
    getChecks: async (prId: string): Promise<PrCheck[]> =>
      callPrReadRuntimeActionOr("getChecks", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetChecks, { prId }),
      ),
    getComments: async (prId: string): Promise<PrComment[]> =>
      callPrReadRuntimeActionOr("getComments", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetComments, { prId }),
      ),
    getReviews: async (prId: string): Promise<PrReview[]> =>
      callPrReadRuntimeActionOr("getReviews", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetReviews, { prId }),
      ),
    getReviewThreads: async (prId: string): Promise<PrReviewThread[]> =>
      callPrReadRuntimeActionOr("getReviewThreads", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetReviewThreads, { prId }),
      ),
    updateDescription: async (args: UpdatePrDescriptionArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "updateDescription", { args }, () =>
        ipcRenderer.invoke(IPC.prsUpdateDescription, args),
      ),
    delete: async (args: DeletePrArgs): Promise<DeletePrResult> =>
      callProjectRuntimeActionOr("pr", "delete", { args }, () =>
        ipcRenderer.invoke(IPC.prsDelete, args),
      ),
    draftDescription: async (
      args: DraftPrDescriptionArgs,
    ): Promise<{ title: string; body: string }> =>
      callProjectRuntimeActionOr("pr", "draftDescription", { args }, () =>
        ipcRenderer.invoke(IPC.prsDraftDescription, args),
      ),
    land: async (args: LandPrArgs): Promise<LandResult> =>
      callProjectRuntimeActionOr("pr", "land", { args }, () =>
        ipcRenderer.invoke(IPC.prsLand, args),
      ),
    landStack: async (args: LandStackArgs): Promise<LandResult[]> =>
      callProjectRuntimeActionOr("pr", "landStack", { args }, () =>
        ipcRenderer.invoke(IPC.prsLandStack, args),
      ),
    retargetBase: async (args: {
      prId: string;
      baseBranch: string;
    }): Promise<void> =>
      callProjectRuntimeActionOr(
        "pr",
        "retargetBase",
        { argsList: [args.prId, args.baseBranch] },
        () => ipcRenderer.invoke(IPC.prsRetargetBase, args),
      ),
    openInGitHub: async (prId: string): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<PrSummary[]>(
        "pr",
        "listAll",
        { args: {} },
      );
      if (runtime.handled) {
        const pr = runtime.result.find((entry) => entry.id === prId);
        if (pr?.githubUrl) {
          await ipcRenderer.invoke(IPC.appOpenExternal, { url: pr.githubUrl });
          return;
        }
        throw new Error(`Remote PR ${prId} was not found or does not have a GitHub URL.`);
      }
      await ipcRenderer.invoke(IPC.prsOpenInGitHub, { prId });
    },
    createQueue: (args: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> =>
      callProjectRuntimeActionOr("pr", "createQueuePrs", { args }, () =>
        ipcRenderer.invoke(IPC.prsCreateQueue, args),
      ),
    createIntegration: (
      args: CreateIntegrationPrArgs,
    ): Promise<CreateIntegrationPrResult> =>
      callProjectRuntimeActionOr("pr", "createIntegrationPr", { args }, () =>
        ipcRenderer.invoke(IPC.prsCreateIntegration, args),
      ),
    simulateIntegration: (
      args: SimulateIntegrationArgs,
    ): Promise<IntegrationProposal> =>
      callProjectRuntimeActionOr("pr", "simulateIntegration", { args }, () =>
        ipcRenderer.invoke(IPC.prsSimulateIntegration, args),
      ),
    commitIntegration: (
      args: CommitIntegrationArgs,
    ): Promise<CreateIntegrationPrResult> =>
      callProjectRuntimeActionOr("pr", "commitIntegration", { args }, () =>
        ipcRenderer.invoke(IPC.prsCommitIntegration, args),
      ),
    listProposals: (): Promise<IntegrationProposal[]> =>
      callProjectRuntimeActionOr("pr", "listIntegrationProposals", {}, () =>
        ipcRenderer.invoke(IPC.prsListProposals),
      ),
    updateProposal: (args: UpdateIntegrationProposalArgs): Promise<void> =>
      callProjectRuntimeActionOr(
        "pr",
        "updateIntegrationProposal",
        { args },
        () => ipcRenderer.invoke(IPC.prsUpdateProposal, args),
      ),
    deleteProposal: (
      args: DeleteIntegrationProposalArgs,
    ): Promise<DeleteIntegrationProposalResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "deleteIntegrationProposal",
        { args },
        () => ipcRenderer.invoke(IPC.prsDeleteProposal, args),
      ),
    landStackEnhanced: (args: LandStackEnhancedArgs): Promise<LandResult[]> =>
      callProjectRuntimeActionOr("pr", "landStackEnhanced", { args }, () =>
        ipcRenderer.invoke(IPC.prsLandStackEnhanced, args),
      ),
    landQueueNext: (args: LandQueueNextArgs): Promise<LandResult> =>
      callProjectRuntimeActionOr("pr", "landQueueNext", { args }, () =>
        ipcRenderer.invoke(IPC.prsLandQueueNext, args),
      ),
    startQueueAutomation: (
      args: StartQueueAutomationArgs,
    ): Promise<QueueLandingState> =>
      callProjectRuntimeActionOr("pr", "startQueueAutomation", { args }, () =>
        ipcRenderer.invoke(IPC.prsStartQueueAutomation, args),
      ),
    pauseQueueAutomation: (
      queueId: string,
    ): Promise<QueueLandingState | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "pauseQueueAutomation",
        { arg: queueId },
        () => ipcRenderer.invoke(IPC.prsPauseQueueAutomation, { queueId }),
      ),
    resumeQueueAutomation: (
      args: ResumeQueueAutomationArgs,
    ): Promise<QueueLandingState | null> =>
      callProjectRuntimeActionOr("pr", "resumeQueueAutomation", { args }, () =>
        ipcRenderer.invoke(IPC.prsResumeQueueAutomation, args),
      ),
    cancelQueueAutomation: (
      queueId: string,
    ): Promise<QueueLandingState | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "cancelQueueAutomation",
        { arg: queueId },
        () => ipcRenderer.invoke(IPC.prsCancelQueueAutomation, { queueId }),
      ),
    reorderQueuePrs: (args: ReorderQueuePrsArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "reorderQueuePrs", { args }, () =>
        ipcRenderer.invoke(IPC.prsReorderQueue, args),
      ),
    getHealth: (prId: string): Promise<PrHealth> =>
      callProjectRuntimeActionOr("pr", "getPrHealth", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetHealth, { prId }),
      ),
    getQueueState: (groupId: string): Promise<QueueLandingState | null> =>
      callProjectRuntimeActionOr("pr", "getQueueState", { arg: groupId }, () =>
        ipcRenderer.invoke(IPC.prsGetQueueState, { groupId }),
      ),
    listQueueStates: (args?: {
      includeCompleted?: boolean;
      limit?: number;
    }): Promise<QueueLandingState[]> =>
      callProjectRuntimeActionOr(
        "pr",
        "listQueueStates",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.prsListQueueStates, args ?? {}),
      ),
    getConflictAnalysis: (prId: string): Promise<PrConflictAnalysis | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "getConflictAnalysis",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsGetConflictAnalysis, { prId }),
      ),
    getMergeContext: (prId: string): Promise<PrMergeContext> =>
      callPrReadRuntimeActionOr("getMergeContext", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetMergeContext, { prId }),
      ),
    getMergeContexts: (prIds: string[]): Promise<Record<string, PrMergeContext>> =>
      callPrReadRuntimeActionOr(
        "getMergeContexts",
        { argsList: [prIds] },
        () => ipcRenderer.invoke(IPC.prsGetMergeContexts, { prIds }),
      ),
    listWithConflicts: (args: { includeConflictAnalysis?: boolean } = {}): Promise<PrWithConflicts[]> =>
      callPrReadRuntimeActionOr("listWithConflicts", { args }, () =>
        ipcRenderer.invoke(IPC.prsListWithConflicts, args),
      ),
    listSnapshots: (args: { prId?: string } = {}): Promise<PrSnapshotHydration[]> =>
      callPrReadRuntimeActionOr(
        "listSnapshots",
        { args },
        () => ipcRenderer.invoke(IPC.prsListSnapshots, args),
      ),
    getGitHubSnapshot: (args?: {
      force?: boolean;
      includeExternalClosed?: boolean;
    }): Promise<GitHubPrSnapshot> =>
      callPrReadRuntimeActionOr(
        "getGithubSnapshot",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.prsGetGitHubSnapshot, args ?? {}),
      ),
    listIntegrationWorkflows: (
      args: ListIntegrationWorkflowsArgs = {},
    ): Promise<IntegrationProposal[]> =>
      callProjectRuntimeActionOr(
        "pr",
        "listIntegrationWorkflows",
        { args },
        () => ipcRenderer.invoke(IPC.prsListIntegrationWorkflows, args),
      ),
    createIntegrationLaneForProposal: (
      args: CreateIntegrationLaneForProposalArgs,
    ): Promise<CreateIntegrationLaneForProposalResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "createIntegrationLaneForProposal",
        { args },
        () => ipcRenderer.invoke(IPC.prsCreateIntegrationLaneForProposal, args),
      ),
    startIntegrationResolution: (
      args: StartIntegrationResolutionArgs,
    ): Promise<StartIntegrationResolutionResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "startIntegrationResolution",
        { args },
        () => ipcRenderer.invoke(IPC.prsStartIntegrationResolution, args),
      ),
    getIntegrationResolutionState: (
      proposalId: string,
    ): Promise<IntegrationResolutionState | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "getIntegrationResolutionState",
        { arg: proposalId },
        () =>
          ipcRenderer.invoke(IPC.prsGetIntegrationResolutionState, {
            proposalId,
          }),
      ),
    recheckIntegrationStep: (
      args: RecheckIntegrationStepArgs,
    ): Promise<RecheckIntegrationStepResult> =>
      callProjectRuntimeActionOr("pr", "recheckIntegrationStep", { args }, () =>
        ipcRenderer.invoke(IPC.prsRecheckIntegrationStep, args),
      ),
    aiResolutionStart: (
      args: PrAiResolutionStartArgs,
    ): Promise<PrAiResolutionStartResult> =>
      callProjectRuntimeActionOr("pr", "aiResolutionStart", { args }, () =>
        ipcRenderer.invoke(IPC.prsAiResolutionStart, args),
      ),
    aiResolutionGetSession: (
      args: PrAiResolutionGetSessionArgs,
    ): Promise<PrAiResolutionGetSessionResult> =>
      callProjectRuntimeActionOr("pr", "aiResolutionGetSession", { args }, () =>
        ipcRenderer.invoke(IPC.prsAiResolutionGetSession, args),
      ),
    aiResolutionInput: (args: PrAiResolutionInputArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "aiResolutionInput", { args }, () =>
        ipcRenderer.invoke(IPC.prsAiResolutionInput, args),
      ),
    aiResolutionStop: (args: PrAiResolutionStopArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "aiResolutionStop", { args }, () =>
        ipcRenderer.invoke(IPC.prsAiResolutionStop, args),
      ),
    issueResolutionStart: (
      args: PrIssueResolutionStartArgs,
    ): Promise<PrIssueResolutionStartResult> =>
      callProjectRuntimeActionOr("pr", "issueResolutionStart", { args }, () =>
        ipcRenderer.invoke(IPC.prsIssueResolutionStart, args),
      ),
    issueResolutionPreviewPrompt: (
      args: PrIssueResolutionPromptPreviewArgs,
    ): Promise<PrIssueResolutionPromptPreviewResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "issueResolutionPreviewPrompt",
        { args },
        () => ipcRenderer.invoke(IPC.prsIssueResolutionPreviewPrompt, args),
      ),
    rebaseResolutionStart: (
      args: RebaseResolutionStartArgs,
    ): Promise<RebaseResolutionStartResult> =>
      callProjectRuntimeActionOr("pr", "rebaseResolutionStart", { args }, () =>
        ipcRenderer.invoke(IPC.prsRebaseResolutionStart, args),
      ),
    onAiResolutionEvent: (cb: (ev: PrAiResolutionEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: PrAiResolutionEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.prsAiResolutionEvent, listener);
      const unsubscribeRemote = subscribeRemotePrAiResolutionEvents(cb);
      return () => {
        unsubscribeRemote();
        ipcRenderer.removeListener(IPC.prsAiResolutionEvent, listener);
      };
    },
    onEvent: (cb: (ev: PrEventPayload) => void) => {
      const unsubscribeLocal = subscribeLocalPrEvents(cb);
      const unsubscribeRemote = subscribeRemotePrEvents(cb);
      return () => {
        unsubscribeRemote();
        unsubscribeLocal();
      };
    },
    getDetail: async (prId: string): Promise<PrDetail> =>
      callPrReadRuntimeActionOr("getDetail", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetDetail, { prId }),
      ),
    getFiles: async (prId: string): Promise<PrFile[]> =>
      callPrReadRuntimeActionOr("getFiles", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetFiles, { prId }),
      ),
    getCommits: async (prId: string): Promise<PrCommit[]> =>
      callPrReadRuntimeActionOr("getCommits", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetCommits, { prId }),
      ),
    getActionRuns: async (prId: string): Promise<PrActionRun[]> =>
      callPrReadRuntimeActionOr("getActionRuns", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetActionRuns, { prId }),
      ),
    getActivity: async (prId: string): Promise<PrActivityEvent[]> =>
      callPrReadRuntimeActionOr("getActivity", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetActivity, { prId }),
      ),
    addComment: async (args: AddPrCommentArgs): Promise<PrComment> =>
      callProjectRuntimeActionOr("pr", "addComment", { args }, () =>
        ipcRenderer.invoke(IPC.prsAddComment, args),
      ),
    replyToReviewThread: async (
      args: ReplyToPrReviewThreadArgs,
    ): Promise<PrReviewThreadComment> =>
      callProjectRuntimeActionOr("pr", "replyToReviewThread", { args }, () =>
        ipcRenderer.invoke(IPC.prsReplyToReviewThread, args),
      ),
    resolveReviewThread: async (
      args: ResolvePrReviewThreadArgs,
    ): Promise<void> =>
      callProjectRuntimeActionOr("pr", "resolveReviewThread", { args }, () =>
        ipcRenderer.invoke(IPC.prsResolveReviewThread, args),
      ),
    updateTitle: async (args: UpdatePrTitleArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "updateTitle", { args }, () =>
        ipcRenderer.invoke(IPC.prsUpdateTitle, args),
      ),
    updateBody: async (args: UpdatePrBodyArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "updateBody", { args }, () =>
        ipcRenderer.invoke(IPC.prsUpdateBody, args),
      ),
    setLabels: async (args: SetPrLabelsArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "setLabels", { args }, () =>
        ipcRenderer.invoke(IPC.prsSetLabels, args),
      ),
    requestReviewers: async (args: RequestPrReviewersArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "requestReviewers", { args }, () =>
        ipcRenderer.invoke(IPC.prsRequestReviewers, args),
      ),
    submitReview: async (
      args: SubmitPrReviewArgs,
    ): Promise<SubmitPrReviewResult> =>
      callProjectRuntimeActionOr("pr", "submitReview", { args }, () =>
        ipcRenderer.invoke(IPC.prsSubmitReview, args),
      ),
    close: async (args: ClosePrArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "closePr", { args }, () =>
        ipcRenderer.invoke(IPC.prsClose, args),
      ),
    reopen: async (args: ReopenPrArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "reopenPr", { args }, () =>
        ipcRenderer.invoke(IPC.prsReopen, args),
      ),
    rerunChecks: async (args: RerunPrChecksArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "rerunChecks", { args }, () =>
        ipcRenderer.invoke(IPC.prsRerunChecks, args),
      ),
    aiReviewSummary: async (
      args: AiReviewSummaryArgs,
    ): Promise<AiReviewSummary> =>
      callProjectRuntimeActionOr("pr", "aiReviewSummary", { args }, () =>
        ipcRenderer.invoke(IPC.prsAiReviewSummary, args),
      ),
    issueInventorySync: async (
      prId: string,
    ): Promise<IssueInventorySnapshot> => {
      const checks = await callProjectRuntimeActionIfBound<PrCheck[]>(
        "pr",
        "getChecks",
        { arg: prId },
      );
      const reviewThreads = checks.handled
        ? await callProjectRuntimeActionIfBound<PrReviewThread[]>(
            "pr",
            "getReviewThreads",
            { arg: prId },
          )
        : ({ handled: false } as const);
      const comments =
        checks.handled && reviewThreads.handled
          ? await callProjectRuntimeActionIfBound<PrComment[]>(
              "pr",
              "getComments",
              { arg: prId },
            )
          : ({ handled: false } as const);
      if (checks.handled && reviewThreads.handled && comments.handled) {
        const runtime =
          await callProjectRuntimeActionIfBound<IssueInventorySnapshot>(
            "issue_inventory",
            "syncFromPrData",
            {
              argsList: [
                prId,
                checks.result,
                reviewThreads.result,
                comments.result,
              ],
            },
          );
        if (runtime.handled) return runtime.result;
      }
      return ipcRenderer.invoke(IPC.prsIssueInventorySync, { prId });
    },
    issueInventoryGet: async (prId: string): Promise<IssueInventorySnapshot> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "getInventory",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsIssueInventoryGet, { prId }),
      ),
    issueInventoryGetNew: async (prId: string): Promise<IssueInventoryItem[]> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "getNewItems",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsIssueInventoryGetNew, { prId }),
      ),
    issueInventoryMarkFixed: async (
      prId: string,
      itemIds: string[],
    ): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "markFixed",
        { argsList: [prId, itemIds] },
        () =>
          ipcRenderer.invoke(IPC.prsIssueInventoryMarkFixed, { prId, itemIds }),
      ),
    issueInventoryMarkDismissed: async (
      prId: string,
      itemIds: string[],
      reason: string,
    ): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "markDismissed",
        { argsList: [prId, itemIds, reason] },
        () =>
          ipcRenderer.invoke(IPC.prsIssueInventoryMarkDismissed, {
            prId,
            itemIds,
            reason,
          }),
      ),
    issueInventoryMarkEscalated: async (
      prId: string,
      itemIds: string[],
    ): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "markEscalated",
        { argsList: [prId, itemIds] },
        () =>
          ipcRenderer.invoke(IPC.prsIssueInventoryMarkEscalated, {
            prId,
            itemIds,
          }),
      ),
    issueInventoryGetConvergence: async (
      prId: string,
    ): Promise<ConvergenceStatus> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "getConvergenceStatus",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsIssueInventoryGetConvergence, { prId }),
      ),
    issueInventoryReset: async (prId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "resetInventory",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsIssueInventoryReset, { prId }),
      ),
    convergenceStateGet: async (prId: string): Promise<PrConvergenceState> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "getConvergenceRuntime",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsConvergenceStateGet, { prId }),
      ),
    convergenceStateSave: async (
      prId: string,
      state: PrConvergenceStatePatch,
    ): Promise<PrConvergenceState> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "saveConvergenceRuntime",
        { argsList: [prId, state] },
        () => ipcRenderer.invoke(IPC.prsConvergenceStateSave, { prId, state }),
      ),
    convergenceStateDelete: async (prId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "resetConvergenceRuntime",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsConvergenceStateDelete, { prId }),
      ),
    pathToMergeStart: async (args: {
      prId: string;
      modelId?: string | null;
      reasoning?: string | null;
      permissionMode?: PrAgentPermissionMode | null;
      scope?: "checks" | "comments" | "both";
      additionalInstructions?: string | null;
    }): Promise<PathToMergeStartResult> =>
      callProjectRuntimeActionOr(
        "path_to_merge",
        "startPathToMerge",
        { args },
        () => ipcRenderer.invoke(IPC.prsPathToMergeStart, args),
      ),
    pathToMergeStop: async (args: {
      prId: string;
      reason?: string | null;
    }): Promise<PathToMergeStopResult> =>
      callProjectRuntimeActionOr(
        "path_to_merge",
        "stopPathToMerge",
        { args },
        () => ipcRenderer.invoke(IPC.prsPathToMergeStop, args),
      ),
    pipelineSettingsGet: async (prId: string): Promise<PipelineSettings> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "getPipelineSettings",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsPipelineSettingsGet, { prId }),
      ),
    pipelineSettingsSave: async (
      prId: string,
      settings: Partial<PipelineSettings>,
    ): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "savePipelineSettings",
        { argsList: [prId, settings] },
        () =>
          ipcRenderer.invoke(IPC.prsPipelineSettingsSave, { prId, settings }),
      ),
    pipelineSettingsDelete: async (prId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "issue_inventory",
        "deletePipelineSettings",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsPipelineSettingsDelete, { prId }),
      ),
    dismissIntegrationCleanup: async (
      args: DismissIntegrationCleanupArgs,
    ): Promise<IntegrationProposal> =>
      callProjectRuntimeActionOr(
        "pr",
        "dismissIntegrationCleanup",
        { args },
        () => ipcRenderer.invoke(IPC.prsDismissIntegrationCleanup, args),
      ),
    cleanupIntegrationWorkflow: async (
      args: CleanupIntegrationWorkflowArgs,
    ): Promise<CleanupIntegrationWorkflowResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "cleanupIntegrationWorkflow",
        { args },
        () => ipcRenderer.invoke(IPC.prsCleanupIntegrationWorkflow, args),
      ),
    getDeployments: async (prId: string): Promise<PrDeployment[]> =>
      callPrReadRuntimeActionOr("getDeployments", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetDeployments, { prId }),
      ),
    getAiSummary: async (prId: string): Promise<PrAiSummary | null> =>
      callPrReadRuntimeActionOr("getAiSummary", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetAiSummary, { prId }),
      ),
    regenerateAiSummary: async (prId: string): Promise<PrAiSummary> =>
      callProjectRuntimeActionOr(
        "pr",
        "regenerateAiSummary",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsRegenerateAiSummary, { prId }),
      ),
    postReviewComment: async (
      args: PostPrReviewCommentArgs,
    ): Promise<PrReviewThreadComment> =>
      callProjectRuntimeActionOr("pr", "postReviewComment", { args }, () =>
        ipcRenderer.invoke(IPC.prsPostReviewComment, args),
      ),
    setReviewThreadResolved: async (
      args: SetPrReviewThreadResolvedArgs,
    ): Promise<SetPrReviewThreadResolvedResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "setReviewThreadResolved",
        { args },
        () => ipcRenderer.invoke(IPC.prsSetReviewThreadResolved, args),
      ),
    reactToComment: async (args: ReactToPrCommentArgs): Promise<void> =>
      callProjectRuntimeActionOr("pr", "reactToComment", { args }, () =>
        ipcRenderer.invoke(IPC.prsReactToComment, args),
      ),
    launchIssueResolutionFromThread: async (
      args: LaunchPrIssueResolutionFromThreadArgs,
    ): Promise<LaunchPrIssueResolutionFromThreadResult> =>
      callProjectRuntimeActionOr(
        "pr",
        "launchIssueResolutionFromThread",
        { args },
        () => ipcRenderer.invoke(IPC.prsLaunchIssueResolutionFromThread, args),
      ),
    cleanupBranch: async (
      args: CleanupPrBranchArgs,
    ): Promise<CleanupPrBranchResult> =>
      callProjectRuntimeActionOr("pr", "cleanupBranch", { args }, () =>
        ipcRenderer.invoke(IPC.prsCleanupBranch, args),
      ),
  },
  rebase: {
    scanNeeds: async (): Promise<RebaseNeed[]> =>
      callProjectRuntimeActionOr("conflicts", "scanRebaseNeeds", {}, () =>
        ipcRenderer.invoke(IPC.rebaseScanNeeds),
      ),
    getNeed: async (laneId: string): Promise<RebaseNeed | null> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "getRebaseNeed",
        { arg: laneId },
        () => ipcRenderer.invoke(IPC.rebaseGetNeed, { laneId }),
      ),
    dismiss: async (laneId: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "dismissRebase",
        { arg: laneId },
        () => ipcRenderer.invoke(IPC.rebaseDismiss, { laneId }),
      ).then(() => undefined),
    defer: async (laneId: string, until: string): Promise<void> =>
      callProjectRuntimeActionOr(
        "conflicts",
        "deferRebase",
        { argsList: [laneId, until] },
        () => ipcRenderer.invoke(IPC.rebaseDefer, { laneId, until }),
      ).then(() => undefined),
    execute: async (args: RebaseLaneArgs): Promise<RebaseResult> =>
      callProjectRuntimeActionOr("conflicts", "rebaseLane", { args }, () =>
        ipcRenderer.invoke(IPC.rebaseExecute, args),
      ),
    onEvent: (cb: (ev: RebaseEventPayload) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: RebaseEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.rebaseEvent, listener);
      const removeRemote = subscribeRemoteConflictEvents((payload) => {
        if (isRebaseEventPayload(payload)) cb(payload);
      });
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.rebaseEvent, listener);
      };
    },
  },
  history: {
    listOperations: async (
      args: ListOperationsArgs = {},
    ): Promise<OperationRecord[]> =>
      callProjectRuntimeActionOr("operation", "list", { args }, () =>
        ipcRenderer.invoke(IPC.historyListOperations, args),
      ),
    exportOperations: async (
      args: ExportHistoryArgs,
    ): Promise<ExportHistoryResult> => {
      const listArgs: ListOperationsArgs = {
        ...(typeof args?.laneId === "string" ? { laneId: args.laneId } : {}),
        ...(typeof args?.kind === "string" ? { kind: args.kind } : {}),
        ...(typeof args?.status === "string" && args.status !== "all" ? { status: args.status } : {}),
        limit: typeof args?.limit === "number" ? args.limit : 1000,
      };
      const runtime = await callProjectRuntimeActionIfBound<OperationRecord[]>(
        "operation",
        "list",
        { args: listArgs },
      );
      if (!runtime.handled) {
        return ipcRenderer.invoke(IPC.historyExportOperations, args);
      }
      const binding = await getProjectRuntimeBinding();
      return ipcRenderer.invoke(IPC.historyExportOperations, {
        ...args,
        rows: runtime.result,
        project: binding
          ? {
              rootPath: binding.rootPath,
              displayName: binding.displayName,
            }
          : null,
      });
    },
  },
  layout: {
    get: async (layoutId: string): Promise<DockLayout | null> =>
      callProjectRuntimeActionOr("layout", "get", { args: { layoutId } }, () =>
        ipcRenderer.invoke(IPC.layoutGet, { layoutId }),
      ),
    set: async (layoutId: string, layout: DockLayout): Promise<void> =>
      callProjectRuntimeActionOr(
        "layout",
        "set",
        { args: { layoutId, layout } },
        () => ipcRenderer.invoke(IPC.layoutSet, { layoutId, layout }),
      ).then(() => undefined),
  },
  tilingTree: {
    get: async (layoutId: string): Promise<unknown> =>
      callProjectRuntimeActionOr(
        "tiling_tree",
        "get",
        { args: { layoutId } },
        () => ipcRenderer.invoke(IPC.tilingTreeGet, { layoutId }),
      ),
    set: async (layoutId: string, tree: unknown): Promise<void> =>
      callProjectRuntimeActionOr(
        "tiling_tree",
        "set",
        { args: { layoutId, tree } },
        () => ipcRenderer.invoke(IPC.tilingTreeSet, { layoutId, tree }),
      ).then(() => undefined),
  },
  graphState: {
    get: async (projectId: string): Promise<GraphPersistedState | null> =>
      callProjectRuntimeActionOr("graph_state", "get", {}, () =>
        ipcRenderer.invoke(IPC.graphStateGet, { projectId }),
      ),
    set: async (projectId: string, state: GraphPersistedState): Promise<void> =>
      callProjectRuntimeActionOr(
        "graph_state",
        "set",
        { args: { state } },
        () => ipcRenderer.invoke(IPC.graphStateSet, { projectId, state }),
      ).then(() => undefined),
  },
  processes: {
    listDefinitions: async (): Promise<ProcessDefinition[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        ProcessDefinition[]
      >("process", "listDefinitions");
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesListDefinitions);
    },
    listRuntime: async (laneId: string): Promise<ProcessRuntime[]> => {
      const runtime = await callProjectRuntimeActionIfBound<ProcessRuntime[]>(
        "process",
        "listRuntime",
        { arg: laneId },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesListRuntime, { laneId });
    },
    start: async (args: ProcessActionArgs): Promise<ProcessRuntime> => {
      const runtime = await callProjectRuntimeActionIfBound<ProcessRuntime>(
        "process",
        "start",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStart, args);
    },
    stop: async (args: ProcessActionArgs): Promise<ProcessRuntime | null> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ProcessRuntime | null>(
          "process",
          "stop",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStop, args);
    },
    restart: async (args: ProcessActionArgs): Promise<ProcessRuntime> => {
      const runtime = await callProjectRuntimeActionIfBound<ProcessRuntime>(
        "process",
        "restart",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesRestart, args);
    },
    kill: async (args: ProcessActionArgs): Promise<ProcessRuntime | null> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ProcessRuntime | null>(
          "process",
          "kill",
          { args },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesKill, args);
    },
    startStack: async (args: ProcessStackArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "startStack",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStartStack, args);
    },
    stopStack: async (args: ProcessStackArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "stopStack",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStopStack, args);
    },
    restartStack: async (args: ProcessStackArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "restartStack",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesRestartStack, args);
    },
    startGroup: async (args: ProcessGroupArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "startGroup",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStartGroup, args);
    },
    stopGroup: async (args: ProcessGroupArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "stopGroup",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStopGroup, args);
    },
    restartGroup: async (args: ProcessGroupArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "restartGroup",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesRestartGroup, args);
    },
    startAll: async (args: { laneId: string }): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "startAll",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStartAll, args);
    },
    stopAll: async (args: { laneId: string }): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "process",
        "stopAll",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesStopAll, args);
    },
    getLogTail: async (args: GetProcessLogTailArgs): Promise<string> => {
      const runtime = await callProjectRuntimeActionIfBound<string>(
        "process",
        "getLogTail",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.processesGetLogTail, args);
    },
    onEvent: (cb: (ev: ProcessEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ProcessEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.processesEvent, listener);
      const unsubscribeRemote = subscribeRemoteProcessEvents(cb);
      return () => {
        unsubscribeRemote();
        ipcRenderer.removeListener(IPC.processesEvent, listener);
      };
    },
  },
  tests: {
    listSuites: async (): Promise<TestSuiteDefinition[]> => {
      const runtime = await callProjectRuntimeActionIfBound<
        TestSuiteDefinition[]
      >("tests", "listSuites");
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.testsListSuites);
    },
    run: async (args: RunTestSuiteArgs): Promise<TestRunSummary> => {
      const runtime = await callProjectRuntimeActionIfBound<TestRunSummary>(
        "tests",
        "run",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.testsRun, args);
    },
    stop: async (args: StopTestRunArgs): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "tests",
        "stop",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.testsStop, args);
    },
    listRuns: async (
      args: ListTestRunsArgs = {},
    ): Promise<TestRunSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<TestRunSummary[]>(
        "tests",
        "listRuns",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.testsListRuns, args);
    },
    getLogTail: async (args: GetTestLogTailArgs): Promise<string> => {
      const runtime = await callProjectRuntimeActionIfBound<string>(
        "tests",
        "getLogTail",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.testsGetLogTail, args);
    },
    onEvent: (cb: (ev: TestEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: TestEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.testsEvent, listener);
      const unsubscribeRemote = subscribeRemoteTestEvents(cb);
      return () => {
        unsubscribeRemote();
        ipcRenderer.removeListener(IPC.testsEvent, listener);
      };
    },
  },
  projectConfig: {
    get: async (): Promise<ProjectConfigSnapshot> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ProjectConfigSnapshot>(
          "project_config",
          "get",
        );
      return runtime.handled
        ? runtime.result
        : projectConfigSnapshotCache.get();
    },
    validate: async (
      candidate: ProjectConfigCandidate,
    ): Promise<ProjectConfigValidationResult> => {
      const runtime =
        await callProjectRuntimeActionIfBound<ProjectConfigValidationResult>(
          "project_config",
          "validate",
          { args: candidate },
        );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.projectConfigValidate, { candidate });
    },
    save: async (
      candidate: ProjectConfigCandidate,
    ): Promise<ProjectConfigSnapshot> => {
      projectConfigSnapshotCache.clear();
      try {
        const runtime =
          await callProjectRuntimeActionIfBound<ProjectConfigSnapshot>(
            "project_config",
            "save",
            { args: candidate },
          );
        const snapshot = runtime.handled
          ? runtime.result
          : await ipcRenderer.invoke(IPC.projectConfigSave, { candidate });
        projectConfigSnapshotCache.clear();
        return snapshot;
      } catch (error) {
        projectConfigSnapshotCache.clear();
        throw error;
      }
    },
    diffAgainstDisk: async (): Promise<ProjectConfigDiff> => {
      const runtime = await callProjectRuntimeActionIfBound<ProjectConfigDiff>(
        "project_config",
        "diffAgainstDisk",
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.projectConfigDiffAgainstDisk);
    },
    confirmTrust: async (
      arg: { sharedHash?: string } = {},
    ): Promise<ProjectConfigTrust> => {
      projectConfigSnapshotCache.clear();
      try {
        const runtime =
          await callProjectRuntimeActionIfBound<ProjectConfigTrust>(
            "project_config",
            "confirmTrust",
            { args: arg },
          );
        return runtime.handled
          ? runtime.result
          : ipcRenderer.invoke(IPC.projectConfigConfirmTrust, arg);
      } finally {
        projectConfigSnapshotCache.clear();
      }
    },
  },
  zoom: {
    getLevel: (): number => webFrame.getZoomLevel(),
    setLevel: (level: number): void => webFrame.setZoomLevel(level),
    getFactor: (): number => webFrame.getZoomFactor(),
  },
  cto: {
    getState: async (args: CtoGetStateArgs = {}): Promise<CtoSnapshot> =>
      callProjectRuntimeActionOr(
        "cto_state",
        "getSnapshot",
        { arg: args.recentLimit ?? 20 },
        () => ipcRenderer.invoke(IPC.ctoGetState, args),
      ),
    ensureSession: async (
      args: CtoEnsureSessionArgs = {},
    ): Promise<AgentChatSession> =>
      callProjectRuntimeActionOr("chat", "ensureCtoSession", { args }, () =>
        ipcRenderer.invoke(IPC.ctoEnsureSession, args),
      ),
    listSessionLogs: async (
      args: CtoListSessionLogsArgs = {},
    ): Promise<CtoSessionLogEntry[]> =>
      callProjectRuntimeActionOr(
        "cto_state",
        "getSessionLogs",
        { arg: args.limit ?? 40 },
        () => ipcRenderer.invoke(IPC.ctoListSessionLogs, args),
      ),
    updateIdentity: async (args: CtoUpdateIdentityArgs): Promise<CtoSnapshot> =>
      callProjectRuntimeActionOr(
        "cto_state",
        "updateIdentity",
        { arg: args.patch ?? {} },
        () => ipcRenderer.invoke(IPC.ctoUpdateIdentity, args),
      ),
    listAgents: async (
      args: CtoListAgentsArgs = {},
    ): Promise<AgentIdentity[]> =>
      callProjectRuntimeActionOr("worker_agent", "listAgents", { args }, () =>
        ipcRenderer.invoke(IPC.ctoListAgents, args),
      ),
    saveAgent: async (args: CtoSaveAgentArgs): Promise<AgentIdentity> =>
      callProjectRuntimeActionOr("worker_agent", "saveAgent", { args }, () =>
        ipcRenderer.invoke(IPC.ctoSaveAgent, args),
      ),
    removeAgent: async (args: CtoRemoveAgentArgs): Promise<void> =>
      callProjectRuntimeActionOr("worker_agent", "removeAgent", { args }, () =>
        ipcRenderer.invoke(IPC.ctoRemoveAgent, args),
      ),
    setAgentStatus: async (args: CtoSetAgentStatusArgs): Promise<void> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "setAgentStatus",
        { args },
        () => ipcRenderer.invoke(IPC.ctoSetAgentStatus, args),
      ),
    listAgentRevisions: async (
      args: CtoListAgentRevisionsArgs,
    ): Promise<AgentConfigRevision[]> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "listAgentRevisions",
        { args },
        () => ipcRenderer.invoke(IPC.ctoListAgentRevisions, args),
      ),
    rollbackAgentRevision: async (
      args: CtoRollbackAgentRevisionArgs,
    ): Promise<AgentIdentity> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "rollbackAgentRevision",
        { args },
        () => ipcRenderer.invoke(IPC.ctoRollbackAgentRevision, args),
      ),
    ensureAgentSession: async (
      args: CtoEnsureAgentSessionArgs,
    ): Promise<AgentChatSession> =>
      callProjectRuntimeActionOr(
        "chat",
        "ensureAgentIdentitySession",
        { args },
        () => ipcRenderer.invoke(IPC.ctoEnsureAgentSession, args),
      ),
    getBudgetSnapshot: async (
      args: CtoGetBudgetSnapshotArgs = {},
    ): Promise<AgentBudgetSnapshot> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "getBudgetSnapshot",
        { args },
        () => ipcRenderer.invoke(IPC.ctoGetBudgetSnapshot, args),
      ),
    triggerAgentWakeup: async (
      args: CtoTriggerAgentWakeupArgs,
    ): Promise<CtoTriggerAgentWakeupResult> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "triggerWakeup",
        { args },
        () => ipcRenderer.invoke(IPC.ctoTriggerAgentWakeup, args),
      ),
    listAgentRuns: async (
      args: CtoListAgentRunsArgs = {},
    ): Promise<WorkerAgentRun[]> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "listAgentRuns",
        { args },
        () => ipcRenderer.invoke(IPC.ctoListAgentRuns, args),
      ),
    listAgentSessionLogs: async (
      args: CtoListAgentSessionLogsArgs,
    ): Promise<AgentSessionLogEntry[]> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "listSessionLogs",
        { argsList: [args.agentId, args.limit ?? 40] },
        () => ipcRenderer.invoke(IPC.ctoListAgentSessionLogs, args),
      ),
    getLinearConnectionStatus: async (): Promise<LinearConnectionStatus> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "getConnectionStatus",
        {},
        () => ipcRenderer.invoke(IPC.ctoGetLinearConnectionStatus),
      ),
    setLinearToken: async (
      args: CtoSetLinearTokenArgs,
    ): Promise<LinearConnectionStatus> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "linear_credentials",
        "setToken",
        { arg: args.token },
      );
      if (runtime.handled) {
        return callProjectRuntimeActionOr(
          "linear_issue_tracker",
          "getConnectionStatus",
          {},
          () => ipcRenderer.invoke(IPC.ctoSetLinearToken, args),
        );
      }
      return ipcRenderer.invoke(IPC.ctoSetLinearToken, args);
    },
    clearLinearToken: async (): Promise<LinearConnectionStatus> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "linear_credentials",
        "clearToken",
        {},
      );
      if (runtime.handled) {
        return callProjectRuntimeActionOr(
          "linear_issue_tracker",
          "getConnectionStatus",
          {},
          () => ipcRenderer.invoke(IPC.ctoClearLinearToken),
        );
      }
      return ipcRenderer.invoke(IPC.ctoClearLinearToken);
    },
    getFlowPolicy: async (): Promise<LinearWorkflowConfig> =>
      callProjectRuntimeActionOr("flow_policy", "getPolicy", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetFlowPolicy),
      ),
    saveFlowPolicy: async (
      args: CtoSaveFlowPolicyArgs,
    ): Promise<LinearWorkflowConfig> =>
      callProjectRuntimeActionOr(
        "flow_policy",
        "savePolicy",
        { argsList: [args.policy, args.actor ?? "user"] },
        () => ipcRenderer.invoke(IPC.ctoSaveFlowPolicy, args),
      ),
    listFlowPolicyRevisions: async (): Promise<CtoFlowPolicyRevision[]> =>
      callProjectRuntimeActionOr(
        "flow_policy",
        "listRevisions",
        { arg: 50 },
        () => ipcRenderer.invoke(IPC.ctoListFlowPolicyRevisions),
      ),
    rollbackFlowPolicyRevision: async (
      args: CtoRollbackFlowPolicyRevisionArgs,
    ): Promise<LinearWorkflowConfig> =>
      callProjectRuntimeActionOr(
        "flow_policy",
        "rollbackRevision",
        { argsList: [args.revisionId, args.actor ?? "user"] },
        () => ipcRenderer.invoke(IPC.ctoRollbackFlowPolicyRevision, args),
      ),
    simulateFlowRoute: async (
      args: CtoSimulateFlowRouteArgs,
    ): Promise<LinearRouteDecision> =>
      callProjectRuntimeActionOr(
        "linear_routing",
        "simulateRoute",
        { args },
        () => ipcRenderer.invoke(IPC.ctoSimulateFlowRoute, args),
      ),
    getLinearWorkflowCatalog: async (): Promise<LinearWorkflowCatalog> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "getWorkflowCatalog",
        {},
        () => ipcRenderer.invoke(IPC.ctoGetLinearWorkflowCatalog),
      ),
    getLinearSyncDashboard: async (): Promise<LinearSyncDashboard> =>
      callProjectRuntimeActionOr("linear_sync", "getDashboard", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetLinearSyncDashboard),
      ),
    runLinearSyncNow: async (): Promise<LinearSyncDashboard> =>
      callProjectRuntimeActionOr("linear_sync", "runSyncNow", {}, () =>
        ipcRenderer.invoke(IPC.ctoRunLinearSyncNow),
      ),
    listLinearSyncQueue: async (): Promise<LinearSyncQueueItem[]> =>
      callProjectRuntimeActionOr(
        "linear_sync",
        "listQueue",
        { args: { limit: 300 } },
        () => ipcRenderer.invoke(IPC.ctoListLinearSyncQueue),
      ),
    getLinearWorkflowRunDetail: async (
      args: CtoGetLinearWorkflowRunDetailArgs,
    ): Promise<LinearWorkflowRunDetail | null> =>
      callProjectRuntimeActionOr("linear_sync", "getRunDetail", { args }, () =>
        ipcRenderer.invoke(IPC.ctoGetLinearWorkflowRunDetail, args),
      ),
    resolveLinearSyncQueueItem: async (
      args: CtoResolveLinearSyncQueueItemArgs,
    ): Promise<LinearSyncQueueItem | null> =>
      callProjectRuntimeActionOr(
        "linear_sync",
        "resolveQueueItem",
        { args },
        () => ipcRenderer.invoke(IPC.ctoResolveLinearSyncQueueItem, args),
      ),
    getLinearIngressStatus: async (): Promise<LinearIngressStatus> =>
      callProjectRuntimeActionOr("linear_ingress", "getStatus", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetLinearIngressStatus),
      ),
    listLinearIngressEvents: async (
      args: CtoListLinearIngressEventsArgs = {},
    ): Promise<LinearIngressEventRecord[]> =>
      callProjectRuntimeActionOr(
        "linear_ingress",
        "listRecentEvents",
        { arg: args.limit ?? 20 },
        () => ipcRenderer.invoke(IPC.ctoListLinearIngressEvents, args),
      ),
    ensureLinearWebhook: async (
      args: CtoEnsureLinearWebhookArgs = {},
    ): Promise<LinearIngressStatus> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "linear_ingress",
        "ensureRelayWebhook",
        { arg: args.force === true },
      );
      if (runtime.handled) {
        return callProjectRuntimeActionOr(
          "linear_ingress",
          "getStatus",
          {},
          () => ipcRenderer.invoke(IPC.ctoEnsureLinearWebhook, args),
        );
      }
      return ipcRenderer.invoke(IPC.ctoEnsureLinearWebhook, args);
    },
    onLinearWorkflowEvent: (
      cb: (event: LinearWorkflowEventPayload) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LinearWorkflowEventPayload,
      ) => cb(payload);
      ipcRenderer.on(IPC.ctoLinearWorkflowEvent, listener);
      const removeRemote = subscribeRemoteLinearWorkflowEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.ctoLinearWorkflowEvent, listener);
      };
    },
    listAgentTaskSessions: async (
      args: CtoListAgentTaskSessionsArgs,
    ): Promise<AgentTaskSession[]> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "listAgentTaskSessions",
        { args },
        () => ipcRenderer.invoke(IPC.ctoListAgentTaskSessions, args),
      ),
    clearAgentTaskSession: async (
      args: CtoClearAgentTaskSessionArgs,
    ): Promise<void> =>
      callProjectRuntimeActionOr(
        "worker_agent",
        "clearAgentTaskSession",
        { args },
        () => ipcRenderer.invoke(IPC.ctoClearAgentTaskSession, args),
      ),
    getOnboardingState: async (): Promise<CtoOnboardingState> =>
      callProjectRuntimeActionOr("cto_state", "getOnboardingState", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetOnboardingState),
      ),
    completeOnboardingStep: async (args: {
      stepId: string;
    }): Promise<CtoOnboardingState> =>
      callProjectRuntimeActionOr(
        "cto_state",
        "completeOnboardingStep",
        { arg: args.stepId },
        () => ipcRenderer.invoke(IPC.ctoCompleteOnboardingStep, args),
      ),
    dismissOnboarding: async (): Promise<CtoOnboardingState> =>
      callProjectRuntimeActionOr("cto_state", "dismissOnboarding", {}, () =>
        ipcRenderer.invoke(IPC.ctoDismissOnboarding),
      ),
    resetOnboarding: async (): Promise<CtoOnboardingState> =>
      callProjectRuntimeActionOr("cto_state", "resetOnboarding", {}, () =>
        ipcRenderer.invoke(IPC.ctoResetOnboarding),
      ),
    previewSystemPrompt: async (
      args: { identityOverride?: Record<string, unknown> } = {},
    ): Promise<CtoSystemPromptPreview> =>
      callProjectRuntimeActionOr(
        "cto_state",
        "previewSystemPrompt",
        { arg: args.identityOverride },
        () => ipcRenderer.invoke(IPC.ctoPreviewSystemPrompt, args),
      ),
    getLinearProjects: async (): Promise<CtoLinearProject[]> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "listProjects",
        {},
        () => ipcRenderer.invoke(IPC.ctoGetLinearProjects),
      ),
    getLinearQuickView: async (): Promise<CtoLinearQuickView> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "getQuickView",
        {},
        () => ipcRenderer.invoke(IPC.ctoGetLinearQuickView),
      ),
    getLinearIssuePickerData:
      async (): Promise<CtoGetLinearIssuePickerDataResult> =>
        callProjectRuntimeActionOr(
          "linear_issue_tracker",
          "getIssuePickerData",
          {},
          () => ipcRenderer.invoke(IPC.ctoGetLinearIssuePickerData),
        ),
    searchLinearIssues: async (
      args: CtoSearchLinearIssuesArgs = {},
    ): Promise<CtoSearchLinearIssuesResult> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "searchIssues",
        { args },
        () => ipcRenderer.invoke(IPC.ctoSearchLinearIssues, args),
      ),
    setLinearOAuthClient: async (
      args: CtoSetLinearOAuthClientArgs,
    ): Promise<LinearConnectionStatus> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "linear_credentials",
        "setOAuthClientCredentials",
        { args },
      );
      if (runtime.handled) {
        return callProjectRuntimeActionOr(
          "linear_issue_tracker",
          "getConnectionStatus",
          {},
          () => ipcRenderer.invoke(IPC.ctoSetLinearOAuthClient, args),
        );
      }
      return ipcRenderer.invoke(IPC.ctoSetLinearOAuthClient, args);
    },
    clearLinearOAuthClient: async (): Promise<LinearConnectionStatus> => {
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "linear_credentials",
        "clearOAuthClientCredentials",
        {},
      );
      if (runtime.handled) {
        return callProjectRuntimeActionOr(
          "linear_issue_tracker",
          "getConnectionStatus",
          {},
          () => ipcRenderer.invoke(IPC.ctoClearLinearOAuthClient),
        );
      }
      return ipcRenderer.invoke(IPC.ctoClearLinearOAuthClient);
    },
    startLinearOAuth: async (): Promise<CtoStartLinearOAuthResult> =>
      callProjectRuntimeActionOr("linear_oauth", "startSession", {}, () =>
        ipcRenderer.invoke(IPC.ctoStartLinearOAuth),
      ),
    getLinearOAuthSession: async (
      args: CtoGetLinearOAuthSessionArgs,
    ): Promise<CtoGetLinearOAuthSessionResult> =>
      callProjectRuntimeActionOr(
        "linear_oauth",
        "getSession",
        { arg: args.sessionId },
        () => ipcRenderer.invoke(IPC.ctoGetLinearOAuthSession, args),
      ),
    runProjectScan: async (): Promise<CtoRunProjectScanResult> =>
      callProjectRuntimeActionOr("cto_state", "runProjectScan", {}, () =>
        ipcRenderer.invoke(IPC.ctoRunProjectScan),
      ),
  },
  updateCheckForUpdates: () => ipcRenderer.invoke(IPC.updateCheckForUpdates),
  updateGetState: (): Promise<AutoUpdateSnapshot> =>
    ipcRenderer.invoke(IPC.updateGetState),
  updateQuitAndInstall: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.updateQuitAndInstall),
  updateDismissInstalledNotice: () =>
    ipcRenderer.invoke(IPC.updateDismissInstalledNotice),
  onUpdateEvent: (cb: (snapshot: AutoUpdateSnapshot) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AutoUpdateSnapshot,
    ) => cb(payload);
    ipcRenderer.on(IPC.updateEvent, listener);
    return () => ipcRenderer.removeListener(IPC.updateEvent, listener);
  },
  perf: {
    getConfig: () => ipcRenderer.invoke(IPC.perfGetConfig),
    recordEvent: (event: { kind: string; ts?: number; [k: string]: unknown }) =>
      ipcRenderer.invoke(IPC.perfRecordEvent, event),
    scenarioComplete: (args: {
      scenario: string;
      ok: boolean;
      smokeFailures?: string[];
    }) => ipcRenderer.invoke(IPC.perfScenarioComplete, args),
    finalize: () => ipcRenderer.invoke(IPC.perfFinalize),
  },
});
