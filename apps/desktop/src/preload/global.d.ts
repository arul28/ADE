import type { SmartLinkPreview } from "../shared/smartLinks";
import type { EditorTarget, OpenPathInEditorRemote, OpenPathTarget } from "../shared/editorTargets";
import type {
  AdeCleanupResult,
  AdeProjectEvent,
  AdeProjectSnapshot,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectPathInspection,
  ProjectIcon,
  ProjectSecretDeleteArgs,
  ProjectSecretEnvFile,
  ProjectSecretGetArgs,
  ProjectSecretsExportResult,
  ProjectSecretsImportArgs,
  ProjectSecretsImportPreview,
  ProjectSecretsImportResult,
  ProjectSecretsListResult,
  ProjectSecretSetArgs,
  ProjectSecretSummary,
  ProjectSecretValueResult,
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AppInfo,
  LocalRuntimeStatus,
  AppWelcomeVideoState,
  AppResourceUsageSnapshot,
  LatestReleaseInfo,
  AppNavigationRequest,
  AppZoomCommand,
  AutoUpdatePreferences,
  KeepAwakeFixResult,
  KeepAwakeLevel,
  KeepAwakeSnapshot,
  AutoUpdateSnapshot,
  UpdateInstallImpact,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationDeleteRuleRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationLinearIngressStatus,
  AutomationScheduledCleanup,
  AutomationWebhookGatewayStatus,
  ConflictProposal,
  ConflictExternalResolverRunSummary,
  ConflictProposalPreview,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  CreateLaneFromUnstagedArgs,
  LaneBranchDrift,
  LaneBranchSwitchArgs,
  LaneBranchSwitchPreview,
  LaneBranchSwitchResult,
  ResolveLaneBranchDriftArgs,
  ResolveLaneBranchDriftResult,
  ArchiveAndReclaimLaneArgs,
  ArchiveAndReclaimLaneResult,
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
  FilesGitBlameArgs,
  FilesGitBlameResult,
  FilesGitStatusEvent,
  FilesListTreeArgs,
  FilesListTreeChildrenArgs,
  FilesListTreeChildrenResult,
  FilesListWorkspacesArgs,
  FilesOpenExternalPathArgs,
  FilesOpenExternalPathResult,
  FilesQuickOpenArgs,
  FilesQuickOpenItem,
  FilesReadFileArgs,
  FilesReadFileRangeArgs,
  FilesReadFileRangeResult,
  FilesRefreshGitDecorationsArgs,
  FilesRenameArgs,
  FilesSearchTextArgs,
  FilesSearchTextMatch,
  FilesWatchArgs,
  FilesWorkspace,
  FilesWriteTextArgs,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionSummary,
  ExternalSessionDetail,
  ExternalSessionDetailArgs,
  ExternalSessionDetailUpdatedEvent,
  ExternalSessionDetailWatchArgs,
  GetLaneConflictStatusArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetFilePatchArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentTool,
  AgentToolsCacheSnapshot,
  AgentChatApproveArgs,
  AgentChatArchiveArgs,
  AgentChatCodexClearGoalArgs,
  AgentChatCodexResetMemoryArgs,
  AgentChatCodexTerminateBackgroundTerminalArgs,
  AgentChatCodexGetGoalArgs,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
  AgentChatCreateArgs,
  AgentChatLaunchArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatDeleteArgs,
  AgentChatSuggestLaneNameArgs,
  AutoLaneIdentitySuggestion,
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatGetSummaryArgs,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatMarkCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatValidateCrossMachineSourceArgs,
  AgentChatInterruptArgs,
  AgentChatInterruptResult,
  AgentChatStopTaskArgs,
  AgentChatStopTaskResult,
  AgentChatRestoreCancelledQueueArgs,
  AgentChatRestoreCancelledQueueResult,
  AgentChatRecoverTurnArgs,
  AgentChatRecoverTurnResult,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  AgentChatResolveUnprocessedMessageArgs,
  AgentChatResolveUnprocessedMessageResult,
  AgentChatRecoverContinuityArgs,
  AgentChatContinuityRecoveryResult,
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
  AgentChatSetScheduledWorkPausedArgs,
  AgentChatSetScheduledWorkPausedResult,
  AgentChatCreateScheduledWorkArgs,
  AgentChatCreateScheduledWorkResult,
  AgentChatListScheduledWorkArgs,
  AgentChatScheduledWorkItem,
  AgentChatCancelScheduledWorkArgs,
  AgentChatCancelScheduledWorkResult,
  AgentChatClaudePlugin,
  AgentChatClaudePluginsArgs,
  AgentChatReloadClaudePluginsArgs,
  AgentChatReloadClaudePluginsResult,
  AgentChatClaudeSessionInfo,
  AgentChatClaudeSessionInfoArgs,
  AgentChatClaudeSessionListArgs,
  AgentChatClaudeSessionMessage,
  AgentChatClaudeSessionMessagesArgs,
  AgentChatMainTranscriptArgs,
  AgentChatSubagentTranscriptArgs,
  AgentChatSubagentTranscriptMessage,
  AgentChatContextUsage,
  AgentChatContextUsageArgs,
  AgentChatRewindFilesArgs,
  AgentChatRewindFilesResult,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  ChatMentionSuggestArgs,
  ChatMentionSuggestResult,
  PromptStashCreateArgs,
  PromptStashDeleteArgs,
  PromptStashEntry,
  AgentChatGetTurnFileDiffArgs,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSessionSummary,
  CodexThreadGoal,
  AgentChatSteerArgs,
  AgentChatSteerResult,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatDispatchSteerArgs,
  AgentChatDispatchSteerResult,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatCancelDispatchedSteerResult,
  AgentChatTurnFileDiff,
  AgentChatSubagentSnapshot,
  AgentChatSubagentListArgs,
  AgentChatKillDroidWorkerArgs,
  AgentChatRegenerateSessionMetadataArgs,
  AgentChatRegenerateSessionMetadataResult,
  AgentChatUpdateSessionArgs,
  AutomationsEventPayload,
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
  ReviewLaunchContext,
  ReviewListRunsArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewStartRunArgs,
  AdeActionRegistryEntry,
  AdeUsageStats,
  GetAdeUsageStatsArgs,
  UsageSnapshot,
  BudgetCheckResult,
  BudgetCheckArgs,
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapConfig,
  AcpProviderDiagnostics,
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
  PiAuthStatusEvent,
  PiLoginMethod,
  PiLoginProvider,
  CursorSdkAuthEvent,
  CursorSdkAuthStatus,
  CursorSdkLoginResult,
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
  CursorCloudWatchMirrorRequest,
  CursorCloudFleetResult,
  CursorCloudFleetEvent,
  CursorCloudPullIntoLaneResult,
  CursorAgentUsage,
  CursorAgentUsageRequest,
  CursorCloudStreamRunRequest,
  CursorCloudStreamRunResult,
  AdeCliInstallResult,
  AdeCliStatus,
  OpenCodeRuntimeSnapshot,
  SyncCloudRelayStatus,
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncStatusEventPayload,
  SyncTransferReadiness,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  CtoUpdateIdentityArgs,
  CtoMemorySnapshot,
  CtoUpdateMemoryArgs,
  CtoSearchMemoryArgs,
  CtoSearchMemoryResult,
  CtoOnboardingState,
  CtoSystemPromptPreview,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoGetLinearIssuePickerDataResult,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  CtoLinearIssueComment,
  CtoSetLinearOAuthClientArgs,
  CtoStartLinearOAuthResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoAttentionState,
  CtoRunProjectScanResult,
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingStatus,
  GitActionResult,
  GitBranchSummary,
  GitCheckoutBranchArgs,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitCreateTagArgs,
  GitConflictState,
  GitGetCommitMessageArgs,
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
  GitListBranchesArgs,
  GitGetUserIdentityArgs,
  GitUserIdentity,
  GitListCommitFilesArgs,
  BranchPullRequest,
  GitFileActionArgs,
  GitBatchFileActionArgs,
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
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubAutolink,
  GitHubRepoRef,
  GitHubRequestBudget,
  GitHubSetTokenResult,
  GitHubStatus,
  AdeAccountStatus,
  AdeAccountLoginStart,
  AdeAccountLoginPoll,
  AdeAccountDeviceLoginStart,
  AdeAccountDeviceLoginPoll,
  AdeAccountLocalMachineIdentity,
  AdeAccountMachine,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinePairingRepairResult,
  AdeAccountSessionRepairResult,
  AdeAccountMachinesResult,
  AdeAccountMachinePairResult,
  AdeAccountPairMachineProgress,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  CreatePrFromLaneArgs,
  AddGitHubPrStackPullRequestsArgs,
  CreateGitHubPrStackArgs,
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
  CleanupIntegrationWorkflowArgs,
  CleanupIntegrationWorkflowResult,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  DeleteIntegrationProposalArgs,
  DeleteIntegrationProposalResult,
  DeletePrArgs,
  DeletePrResult,
  DismissIntegrationCleanupArgs,
  DraftPrDescriptionArgs,
  GitHubPrSnapshot,
  GitHubPrStack,
  LandPrArgs,
  LandResult,
  UpdateBranchArgs,
  UpdateBranchResult,
  LinkPrToLaneArgs,
  ListGitHubPrStacksArgs,
  ListIntegrationWorkflowsArgs,
  PrActionRun,
  PrActivityEvent,
  PrWorkflowGraph,
  GetPrWorkflowGraphArgs,
  PrCheckLogExcerpt,
  GetPrCheckLogArgs,
  PrCheck,
  PrCommit,
  PrComment,
  PrGithubCoords,
  CleanupPrBranchArgs,
  CleanupPrBranchResult,
  PrConflictAnalysis,
  PrDetail,
  PrEventPayload,
  PrFile,
  PrMergeContext,
  PrReview,
  PrReviewThread,
  PrReviewThreadComment,
  PrSnapshotHydration,
  PrStatus,
  PrSummary,
  PrWithConflicts,
  UnstackGitHubPrStackArgs,
  PrDeployment,
  PrAiSummary,
  PostPrReviewCommentArgs,
  SetPrReviewThreadResolvedArgs,
  SetPrReviewThreadResolvedResult,
  ReactToPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
  AddPrCommentArgs,
  UpdatePrCommentArgs,
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
  PrAgentPermissionMode,
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs,
  ListOverlapsArgs,
  LaneGitHubIssue,
  LaneLinearIssue,
  LaneSummary,
  ImportBranchLaneArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  ListLanesArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  DeleteSessionArgs,
  ListTestRunsArgs,
  OperationRecord,
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
  PtyDisposeResult,
  PtyResumeSessionArgs,
  PtyResumeSessionResult,
  PtySendToSessionArgs,
  PtySendToSessionResult,
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
  PrepareResolverSessionArgs,
  PrepareResolverSessionResult,
  AttachResolverSessionArgs,
  FinalizeResolverSessionArgs,
  CancelResolverSessionArgs,
  SuggestResolverTargetArgs,
  SuggestResolverTargetResult,
  SessionDeltaSummary,
  SessionLifecycleSettings,
  SessionGitHubIssueLink,
  SessionLinearIssueLink,
  SessionSettleOverride,
  SessionWakeReason,
  TerminalSessionChangedEvent,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  UpdateSessionMetaArgs,
  TestEvent,
  TestRunSummary,
  TestSuiteDefinition,
  UpdateLaneAppearanceArgs,
  UndoConflictProposalArgs,
  WriteTextAtomicArgs,
  InitLaneEnvArgs,
  GetLaneEnvStatusArgs,
  GetLaneOverlayArgs,
  LaneDeleteEvent,
  LaneLifecycleEvent,
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneReclaimRisk,
  RestoreLaneResult,
  LaneEnvInitProgress,
  LaneEnvInitEvent,
  LaneOverlayOverrides,
  LaneTemplate,
  LaneListSnapshot,
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
  RuntimeDiagnosticsStatus,
  RuntimeDiagnosticsEvent,
  LaneHealthCheck,
  GetLaneHealthArgs,
  RunHealthCheckArgs,
  ActivateFallbackArgs,
  DeactivateFallbackArgs,
  ComputerUseArtifactBrokenRecord,
  ComputerUseArtifactDeleteArgs,
  ComputerUseArtifactDeleteResult,
  ComputerUseArtifactListArgs,
  ComputerUseArtifactReviewArgs,
  ComputerUseArtifactView,
  ComputerUseEventPayload,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
  IosSimulatorDevice,
  IosSimulatorDragArgs,
  IosSimulatorEventPayload,
  IosSimulatorListPreviewsArgs,
  IosSimulatorEnsurePreviewWorkspaceArgs,
  IosSimulatorEnsurePreviewWorkspaceResult,
  IosSimulatorOpenPreviewWorkspaceArgs,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorRenderCurrentPreviewArgs,
  IosSimulatorRenderCurrentPreviewResult,
  IosSimulatorRenderPreviewArgs,
  IosSimulatorRenderPreviewResult,
  IosScreenSnapshot,
  IosScreenSnapshotArgs,
  IosInspectorSnapshot,
  IosSimulatorInspectPointArgs,
  IosSimulatorInspectResult,
  IosSimulatorLaunchArgs,
  IosSimulatorLaunchResult,
  IosSimulatorLaunchTarget,
  IosSimulatorListLaunchTargetsArgs,
  IosSimulatorPrivacyPane,
  IosSimulatorScreenshot,
  IosSimulatorScreenshotArgs,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
  IosSimulatorStartStreamArgs,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
  IosSimulatorWindowCaptureSessionHint,
  IosSimulatorWindowSourcesResult,
  IosSimulatorWindowState,
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
  BuiltInBrowserClearPermissionsArgs,
  BuiltInBrowserClearPermissionsResult,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserOriginAccessResult,
  BuiltInBrowserPermissionsResult,
  BuiltInBrowserProfileDiagnostics,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserRequestOriginAccessArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserSelectResult,
  BuiltInBrowserStatus,
  BuiltInBrowserTabArgs,
  BuiltInBrowserTabTargetArgs,
  PersonalChatCallArgs,
  PersonalChatCallResponse,
  PersonalChatStreamEventsArgs,
  PersonalChatStreamEventsResult,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeDoctorResult,
  RemoteRuntimeLocalWorkCheckResult,
  RemoteRuntimeLocalPairingInfo,
  RemoteRuntimePairWithMachineArgs,
  RemoteRuntimePairWithMachineResult,
  RemoteRuntimeParsedPairingInput,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeHandoffStoragePreflightArgs,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeCloneProjectOptions,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTrustSshHostKeyResult,
  RemoteRuntimeUpdateAndRestartResult,
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
  SearchIndexStatus,
  SearchQueryArgs,
  SearchQueryResult,
  SearchRebuildResult,
} from "../shared/types";
import type { GitHubIssueLike } from "../shared/laneGitHubIssue";
import type {
  AgentChatCopyTempAttachmentArgs,
  ChatAttachmentStagingMode,
  ConvertImageToJpegResult,
} from "../shared/types/chat";
import type { DiskPressureSnapshot } from "../main/services/storage/diskPressure";
import type {
  MaintenanceRunReport,
  RuntimeHealthSnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageCompressionResult,
  StorageSnapshot,
} from "../shared/types/storage";
import type { ProjectRecoveryDiagnosis, ProjectRepairReport, RepairStepResult } from "../shared/types/recovery";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsAutoSentPayload,
  DiagnosticsManualSendResult,
  DiagnosticsSharingStatus,
} from "../shared/types/diagnostics";
import type { AppPackageChannel } from "../shared/packageChannel";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
  ProductAnalyticsStatus,
} from "../shared/types/productAnalytics";
import type {
  PluginClientInstalled as InstalledPlugin,
  PluginClientMarketplaceIndex as MarketplaceIndexPayload,
  PluginClientChangeEvent as PluginChangeEvent,
  PluginClientCollectionRow as PluginCollectionRow,
  PluginClientInstallRequest as PluginInstallRequest,
  PluginClientInstallResult as PluginInstallResult,
  PluginClientPresenceRow as PluginPresenceRow,
  PluginContributionRecord,
  PluginLogEntry,
  PluginPanelRecord,
  PluginSourceInspection,
  PluginClientUsageRow as PluginUsageRow,
  PluginWebhookIngressStatus,
} from "../shared/plugins/sdk";
import type {
  PluginWebviewChatTurn,
  PluginWebviewSurfaceState,
  PluginWebviewThemeSnapshot,
  PluginWebviewUiResponse,
} from "../shared/plugins/webviewBridge";

export {};

declare global {
  interface Window {
    ade: {
      analytics: {
        capture: (
          input: Omit<ProductAnalyticsCapture, "surface">,
        ) => Promise<ProductAnalyticsCaptureResult>;
        getStatus: () => Promise<ProductAnalyticsStatus>;
        setEnabled: (enabled: boolean) => Promise<ProductAnalyticsStatus>;
      };
      app: {
        /**
         * Host platform/arch, captured in preload so the renderer can gate
         * synchronously at first paint. `app.getInfo()` carries the same values
         * but is an async IPC round trip, which is too late for module-scope
         * and first-render decisions.
         */
        runtimeTarget: { platform: string; arch: string };
        /**
         * Release channel of this build, captured in preload from the argv the
         * main process injects. Synchronous for the same reason as
         * `runtimeTarget`: the shell header gates the channel badge at first
         * paint. `app.getInfo().packageChannel`
         * carries the same value for callers that already await it.
         */
        packageChannel: AppPackageChannel;
        ping: () => Promise<"pong">;
        setDockBadgeCount: (count: number) => Promise<{ ok: true }>;
        getInfo: () => Promise<AppInfo>;
        getInstalledEditors: () => Promise<EditorTarget[]>;
        onRuntimeStatusChanged: (
          cb: (status: LocalRuntimeStatus) => void,
        ) => () => void;
        getResourceUsage: () => Promise<AppResourceUsageSnapshot>;
        getRuntimeHealth: () => Promise<RuntimeHealthSnapshot>;
        /**
         * Restarts this Mac's ADE brain (com.ade.runtime) and resolves once the
         * replacement answers a ping; rejects when it does not come back.
         * Native desktop only — the hosted-web adapter and browser mock cannot
         * touch a launch agent, so callers must feature-detect before offering it.
         */
        restartBackgroundService?: () => Promise<void>;
        getLatestRelease: () => Promise<LatestReleaseInfo | null>;
        getProject: () => Promise<ProjectInfo | null>;
        getWindowSession: () => Promise<{
          windowId: number | null;
          project: ProjectInfo | null;
          binding: OpenProjectBinding | null;
          openProjectTabs: ProjectInfo[];
          /** Hosted web persists remote machine/project tabs in this browser. */
          openProjectBindings?: OpenProjectBinding[];
        }>;
        getWelcomeVideoState: () => Promise<AppWelcomeVideoState>;
        markWelcomeVideoSeen: (
          reason: "completed" | "dismissed",
        ) => Promise<AppWelcomeVideoState>;
        getLaunchGateState: () => Promise<{ resolved: boolean }>;
        resolveLaunchGate: () => Promise<{ resolved: true }>;
        setWindowProjectTabs: (
          rootPaths: string[],
        ) => Promise<{ openProjectTabs: ProjectInfo[] }>;
        /** Hosted-web-only retained binding persistence; absent on native desktop. */
        setWindowProjectBindings?: (
          bindings: OpenProjectBinding[],
        ) => Promise<{ openProjectBindings: OpenProjectBinding[] }>;
        newWindow: () => Promise<{ windowId: number | null }>;
        openProjectInNewWindow: (
          rootPath: string,
        ) => Promise<{ windowId: number | null; project: ProjectInfo | null }>;
        closeWindow: (windowId?: number | null) => Promise<{ closed: boolean }>;
        onProjectChanged: (
          cb: (project: ProjectInfo | null) => void,
        ) => () => void;
        onProjectBindingChanged: (
          cb: (binding: OpenProjectBinding | null) => void,
        ) => () => void;
        onNavigate: (cb: (request: AppNavigationRequest) => void) => () => void;
        openExternal: (url: string) => Promise<void>;
        revealPath: (path: string) => Promise<void>;
        openPath: (path: string) => Promise<void>;
        writeClipboardText: (text: string) => Promise<void>;
        readClipboardText: () => Promise<string>;
        hasClipboardImage: () => Promise<boolean>;
        readClipboardImage: () => Promise<{
          data: string;
          filename: string;
          mimeType: string;
        } | null>;
        /** Convert a HEIC/HEIF upload locally before it is sent to any runtime. */
        convertImageToJpeg?: (args: {
          data: string;
          filename: string;
          mimeType?: string | null;
        }) => Promise<ConvertImageToJpegResult>;
        saveClipboardImageAttachment: () => Promise<{
          path: string;
          mimeType: string;
          previewDataUrl: string | null;
        } | null>;
        getImageDataUrl: (path: string) => Promise<{ dataUrl: string }>;
        writeClipboardImage: (path: string) => Promise<void>;
        openPathInEditor: (args: {
          rootPath: string;
          relativePath?: string;
          target: OpenPathTarget;
          remote?: OpenPathInEditorRemote;
        }) => Promise<void>;
        logDebugEvent: (
          event: string,
          payload?: Record<string, unknown>,
        ) => void;
      };
      storage: {
        getPressure: () => Promise<DiskPressureSnapshot>;
        getSnapshot: (args?: { forceRefresh?: boolean }) => Promise<StorageSnapshot>;
        compressNow: () => Promise<StorageCompressionResult>;
        runMaintenanceNow: () => Promise<MaintenanceRunReport>;
        cleanupPreview: (targets: StorageCleanupTarget[]) => Promise<StorageCleanupPreview>;
        cleanup: (
          targets: StorageCleanupTarget[],
          opts: { preview: StorageCleanupPreview },
        ) => Promise<StorageCleanupResult>;
      };
      project: {
        openRepo: (args?: { rootPath?: string }) => Promise<ProjectInfo | null>;
        chooseDirectory: (args?: {
          title?: string;
          defaultPath?: string;
        }) => Promise<string | null>;
        browseDirectories: (
          args?: ProjectBrowseInput,
        ) => Promise<ProjectBrowseResult>;
        getDetail: (rootPath: string) => Promise<ProjectDetail>;
        inspectPath: (
          path: string,
          opts?: { fresh?: boolean },
        ) => Promise<ProjectPathInspection>;
        resolveIcon: (rootPath: string) => Promise<ProjectIcon>;
        chooseIcon: (rootPath: string) => Promise<ProjectIcon | null>;
        removeIcon: (rootPath: string) => Promise<ProjectIcon>;
        getDroppedPath: (file: File) => string;
        openAdeFolder: () => Promise<void>;
        clearLocalData: (
          args?: ClearLocalAdeDataArgs,
        ) => Promise<ClearLocalAdeDataResult>;
        listRecent: () => Promise<RecentProjectSummary[]>;
        findForRepo: (args: {
          repoOwner: string;
          repoName: string;
        }) => Promise<{ rootPath: string; displayName: string } | null>;
        closeCurrent: () => Promise<void>;
        switchToPath: (rootPath: string) => Promise<ProjectInfo>;
        forgetRecent: (keyOrRootPath: string) => Promise<RecentProjectSummary[]>;
        reorderRecent: (
          orderedKeys: string[],
        ) => Promise<RecentProjectSummary[]>;
        setRecentPinned: (
          key: string,
          pinned: boolean,
        ) => Promise<RecentProjectSummary[]>;
        createLocal: (
          input: CreateProjectInput,
        ) => Promise<CreateProjectResult>;
        clone: (input: CloneProjectInput) => Promise<CloneProjectResult>;
        getDefaultParentDir: () => Promise<string>;
        getSnapshot: () => Promise<AdeProjectSnapshot>;
        initializeOrRepair: () => Promise<AdeCleanupResult>;
        runIntegrityCheck: () => Promise<AdeCleanupResult>;
        onMissing: (cb: (data: { rootPath: string }) => void) => () => void;
        onStateEvent: (cb: (event: AdeProjectEvent) => void) => () => void;
      };
      /**
       * Optional as a GROUP, because an older preload has no `diagnostics` at
       * all: every call site must tolerate `undefined` and simply not offer the
       * button. The members inside are not optional — they all shipped
       * together, so a build that exposes the group exposes all of them, and
       * marking them individually optional would only teach call sites to write
       * `?.()` chains that can never fire.
       */
      diagnostics?: {
        openIssue: (context: DiagnosticReportRequestPayload) => Promise<DiagnosticReportPayload>;
        /**
         * Ask main to consider ONE automatic send for a failure the renderer
         * detected. Main owns the setting and the budget, so this is a request,
         * not an instruction, and its answer is deliberately uninteresting.
         */
        autoReport: (context: DiagnosticReportRequestPayload) => Promise<void>;
        /**
         * The one member here that IS individually optional, and the exception
         * proves the group's rule: `diagnostics` shipped before this existed,
         * so a preload that exposes the group need not expose this. The
         * settings control checks for it and hides itself rather than offering
         * a button that cannot work.
         */
        sendManual?: () => Promise<DiagnosticsManualSendResult>;
        getSharing: () => Promise<DiagnosticsSharingStatus>;
        setSharing: (enabled: boolean) => Promise<DiagnosticsSharingStatus>;
        revealReport: (reportPath: string) => Promise<void>;
        onAutoSent: (cb: (payload: DiagnosticsAutoSentPayload) => void) => () => void;
        /**
         * Confirms these references reached the screen, so main stops offering
         * them on the next subscribe. Called after the toast is rendered.
         */
        ackAutoSent: (references: string[]) => Promise<void>;
      };
      recovery: {
        diagnose: (projectRoot: string) => Promise<ProjectRecoveryDiagnosis>;
        repair: (projectRoot: string) => Promise<ProjectRepairReport>;
        /**
         * Live repair steps for the window that started the repair. Optional
         * for the same reason `diagnostics` is: an older preload does not have
         * it, and every call site already guards before calling.
         */
        onRepairStep?: (
          cb: (payload: { projectRoot: string; step: RepairStepResult }) => void,
        ) => () => void;
      };
      remoteRuntime: {
        listTargets: () => Promise<RemoteRuntimeTarget[]>;
        getConnectionSnapshot: () => Promise<RemoteRuntimeConnectionSnapshot>;
        onConnectionSnapshotChanged: (
          cb: (snapshot: RemoteRuntimeConnectionSnapshot) => void,
        ) => () => void;
        listDiscoveredMachines: () => Promise<RemoteRuntimeDiscoveryResult>;
        parsePairingInput: (
          text: string,
        ) => Promise<RemoteRuntimeParsedPairingInput>;
        pairWithMachine: (
          args: RemoteRuntimePairWithMachineArgs,
        ) => Promise<RemoteRuntimePairWithMachineResult>;
        getLocalPairingInfo: () => Promise<RemoteRuntimeLocalPairingInfo>;
        runDoctor: (id: string) => Promise<RemoteRuntimeDoctorResult>;
        saveTarget: (
          input: RemoteRuntimeTargetInput,
        ) => Promise<RemoteRuntimeTarget>;
        setAutoConnect: (
          id: string,
          enabled: boolean,
        ) => Promise<RemoteRuntimeTarget>;
        removeTarget: (id: string) => Promise<{ removed: boolean }>;
        getSshHostKeyTrust: (
          id: string,
        ) => Promise<RemoteRuntimeSshHostKeyTrustStatus>;
        trustSshHostKey: (
          id: string,
          fingerprintSha256: string,
        ) => Promise<RemoteRuntimeTrustSshHostKeyResult>;
        connect: (id: string) => Promise<RemoteRuntimeConnectResult>;
        /**
         * Asks a connected machine to install the newest ADE build and restart
         * itself. Always user-initiated. `targetVersion` is what this desktop
         * believes is newest; the machine refuses to "update" to the version it
         * already runs and just restarts.
         */
        updateAndRestart: (
          id: string,
          targetVersion?: string | null,
        ) => Promise<RemoteRuntimeUpdateAndRestartResult>;
        listProjects: (id: string) => Promise<RemoteRuntimeProjectRecord[]>;
        addProject: (
          id: string,
          rootPath: string,
        ) => Promise<RemoteRuntimeProjectRecord>;
        browseDirectories: (
          id: string,
          args?: ProjectBrowseInput,
        ) => Promise<ProjectBrowseResult>;
        getProjectDetail: (
          id: string,
          rootPath: string,
        ) => Promise<ProjectDetail>;
        getDefaultParentDir: (id: string) => Promise<string>;
        getHandoffStoragePreflight: (
          id: string,
          input: RemoteRuntimeHandoffStoragePreflightArgs,
        ) => Promise<RemoteRuntimeHandoffStoragePreflightResult>;
        createProject: (
          id: string,
          input: CreateProjectInput,
        ) => Promise<RemoteRuntimeProjectRecord>;
        cloneProject: (
          id: string,
          input: CloneProjectInput,
          options?: RemoteRuntimeCloneProjectOptions,
        ) => Promise<RemoteRuntimeProjectRecord>;
        listMyGitHubRepos: (
          id: string,
          input?: ListMyGitHubReposInput,
        ) => Promise<ListMyGitHubReposResult>;
        openProject: (
          id: string,
          projectId: string,
        ) => Promise<OpenProjectBinding>;
        callAction: (
          id: string,
          projectId: string,
          request: RemoteRuntimeActionRequest,
        ) => Promise<RemoteRuntimeActionResult>;
        streamEvents: (
          id: string,
          projectId: string,
          request?: RemoteRuntimeStreamEventsRequest,
        ) => Promise<RemoteRuntimeStreamEventsResult>;
        disconnect: (
          id: string,
          options?: { manual?: boolean },
        ) => Promise<{ disconnected: boolean }>;
      };
      personalChats: {
        call: (
          request: PersonalChatCallArgs,
        ) => Promise<PersonalChatCallResponse>;
        streamEvents: (
          request?: PersonalChatStreamEventsArgs,
        ) => Promise<PersonalChatStreamEventsResult>;
      };
      keybindings: {
        get: () => Promise<KeybindingsSnapshot>;
        set: (overrides: KeybindingOverride[]) => Promise<KeybindingsSnapshot>;
      };
      projectSecrets: {
        list: () => Promise<ProjectSecretsListResult>;
        get: (args: ProjectSecretGetArgs) => Promise<ProjectSecretValueResult>;
        set: (args: ProjectSecretSetArgs) => Promise<ProjectSecretSummary>;
        delete: (args: ProjectSecretDeleteArgs) => Promise<{ deleted: boolean; name: string }>;
        chooseEnvFile: () => Promise<ProjectSecretsImportPreview | null>;
        importEnv: (args: ProjectSecretsImportArgs) => Promise<ProjectSecretsImportResult>;
        exportEnv: () => Promise<ProjectSecretsExportResult>;
      };
      ai: {
        getStatus: (args?: {
          force?: boolean;
          refreshOpenCodeInventory?: boolean;
        }, pin?: OpenProjectBinding | null) => Promise<AiSettingsStatus>;
        getOpenCodeRuntimeDiagnostics: () => Promise<OpenCodeRuntimeSnapshot>;
        isOpenCodeInstalled: (pin?: OpenProjectBinding | null) => Promise<{ installed: boolean; source: "user-installed" | "tools-cache" | "bundled" | "missing" }>;
        getToolsCache: () => Promise<AgentToolsCacheSnapshot>;
        ensureToolsCache: () => Promise<AgentToolsCacheSnapshot>;
        onToolsCacheEvent: (cb: (snapshot: AgentToolsCacheSnapshot) => void) => () => void;
        storeApiKey: (provider: string, key: string) => Promise<void>;
        deleteApiKey: (provider: string) => Promise<void>;
        listApiKeys: () => Promise<string[]>;
        verifyApiKey: (provider: string) => Promise<AiApiKeyVerificationResult>;
        updateConfig: (config: Partial<AiConfig>) => Promise<void>;
        /**
         * Optional: shipped after this group did, so an older preload will not
         * have it and callers must guard before reaching for it.
         */
        acpProviderDiagnostics?: (args: {
          provider: "qwen" | "kimi" | "grok" | "copilot";
          runDoctor?: boolean;
        }) => Promise<AcpProviderDiagnostics>;
        opencodeAuthMethods: () => Promise<{ methods: OpenCodeProviderAuthMethods }>;
        opencodeOAuthStart: (args: {
          providerId: string;
          methodIndex: number;
          inputs?: Record<string, string>;
        }) => Promise<OpenCodeOAuthStartResult>;
        opencodeOAuthCancel: (args: { providerId: string }) => Promise<void>;
        setOpencodeProviderKey: (args: {
          providerId: string;
          key: string;
        }) => Promise<{ ok: boolean; error?: string }>;
        clearOpencodeProviderKey: (args: {
          providerId: string;
        }) => Promise<{ ok: boolean; error?: string }>;
        refreshModelsDev: () => Promise<{ lastFetchedAt: number | null }>;
        onOpencodeOAuthStatus: (cb: (event: OpenCodeOAuthStatusEvent) => void) => () => void;
        piLoginProviders: () => Promise<PiLoginProvider[]>;
        piLoginStart: (args: {
          providerId: string;
          method?: PiLoginMethod;
        }) => Promise<{ ok: boolean; error?: string }>;
        piLoginSubmit: (args: {
          providerId: string;
          requestId: string;
          value: string;
        }) => Promise<{ ok: boolean; error?: string }>;
        piLoginCancel: (args: { providerId: string }) => Promise<void>;
        onPiAuthStatus: (cb: (event: PiAuthStatusEvent) => void) => () => void;
        cursorAuthStatus: () => Promise<CursorSdkAuthStatus>;
        cursorAuthLogin: () => Promise<CursorSdkLoginResult>;
        cursorAuthLogout: () => Promise<{ ok: boolean; error?: string }>;
        cursorAuthCancel: () => Promise<void>;
        onCursorAuthStatus: (cb: (event: CursorSdkAuthEvent) => void) => () => void;
        cursorCloudListRepositories: () => Promise<CursorCloudRepository[]>;
        cursorCloudListAgents: (args?: {
          includeArchived?: boolean;
          limit?: number;
          cursor?: string | null;
        }) => Promise<CursorCloudListAgentsResult>;
        cursorCloudListRuns: (args: {
          agentId: string;
          limit?: number;
          cursor?: string | null;
        }) => Promise<CursorCloudListRunsResult>;
        cursorCloudCreateRun: (
          args: CursorCloudCreateRunRequest,
        ) => Promise<CursorCloudCreateRunResult>;
        cursorCloudGetLaneSecretNames: (laneId: string) => Promise<string[]>;
        cursorCloudArchiveAgent: (agentId: string) => Promise<void>;
        cursorCloudUnarchiveAgent: (agentId: string) => Promise<void>;
        cursorCloudDeleteAgent: (agentId: string) => Promise<void>;
        cursorCloudGetAgent: (
          agentId: string,
        ) => Promise<CursorCloudAgentSummary | null>;
        cursorCloudGetUsage: (
          args: CursorAgentUsageRequest,
        ) => Promise<CursorAgentUsage>;
        cursorCloudStreamRun: (
          args: CursorCloudStreamRunRequest,
        ) => Promise<CursorCloudStreamRunResult>;
        cursorCloudCancelRun: (args: {
          agentId: string;
          runId: string;
        }) => Promise<void>;
        cursorCloudFollowUp: (
          args: CursorCloudFollowUpRequest,
        ) => Promise<CursorCloudFollowUpResult>;
        cursorCloudListArtifacts: (
          agentId: string,
        ) => Promise<CursorCloudArtifactSummary[]>;
        cursorCloudDownloadArtifact: (args: {
          agentId: string;
          path: string;
        }) => Promise<CursorCloudArtifactDownload>;
        cursorCloudOpenChat: (
          args: CursorCloudOpenChatRequest,
        ) => Promise<CursorCloudOpenChatResult>;
        cursorCloudWatchMirror: (
          args: CursorCloudWatchMirrorRequest,
        ) => Promise<void>;
        cursorCloudFleet: (args?: {
          includeArchived?: boolean;
          limit?: number;
        }) => Promise<CursorCloudFleetResult>;
        cursorCloudPullIntoLane: (
          agentId: string,
        ) => Promise<CursorCloudPullIntoLaneResult>;
        cursorCloudResolveLane: (
          agentId: string,
        ) => Promise<{ laneId: string; laneName: string; created: boolean }>;
        cursorCloudStopRun: (
          agentId: string,
        ) => Promise<{ stopped: boolean }>;
        onCursorCloudFleetEvent: (
          cb: (event: CursorCloudFleetEvent) => void,
        ) => () => void;
      };
      audio: {
        writeClip: (
          pcm: ArrayBuffer,
          options?: { sampleRate?: number; format?: "int16" | "float32" },
        ) => Promise<{ audioPath: string; durationMs: number }>;
        discardClip: (audioPath: string) => Promise<void>;
        requestMicAccess: () => Promise<{
          status: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
        }>;
        onCaptureRequest: (
          handler: (request: { requestId: string; label: string; maxDurationMs?: number }) => void,
        ) => () => void;
        settleCaptureRequest: (
          outcome:
            | { requestId: string; ok: true; clip: { audioPath: string; durationMs: number } }
            | { requestId: string; ok: false; code: string; message: string },
        ) => Promise<void>;
      };
      modelPicker: {
        getFavorites: () => Promise<{ favorites: string[] }>;
        setFavorites: (favorites: string[]) => Promise<{ favorites: string[] }>;
        toggleFavorite: (
          modelId: string,
        ) => Promise<{ favorites: string[]; isFavorite: boolean }>;
        getRecents: () => Promise<{ recents: string[] }>;
        pushRecent: (modelId: string) => Promise<{ recents: string[] }>;
      };
      sync: {
        getStatus: (args?: SyncGetStatusArgs) => Promise<SyncRoleSnapshot>;
        /** Always reads this physical machine's local ADE brain, even in a remote-bound window. */
        getLocalStatus: (args?: SyncGetStatusArgs) => Promise<SyncRoleSnapshot>;
        refreshDiscovery: () => Promise<SyncRoleSnapshot>;
        listDevices: () => Promise<SyncDeviceRuntimeState[]>;
        updateLocalDevice: (args: {
          name?: string;
          deviceType?: SyncPeerDeviceType;
        }) => Promise<SyncDeviceRecord>;
        connectToBrain: (
          draft: SyncDesktopConnectionDraft,
        ) => Promise<SyncRoleSnapshot>;
        disconnectFromBrain: () => Promise<SyncRoleSnapshot>;
        forgetDevice: (deviceId: string) => Promise<SyncRoleSnapshot>;
        getTransferReadiness: () => Promise<SyncTransferReadiness>;
        transferBrainToLocal: () => Promise<SyncRoleSnapshot>;
        getPin: () => Promise<{ pin: string | null }>;
        setPin: (pin: string) => Promise<SyncRoleSnapshot>;
        generatePin: () => Promise<SyncRoleSnapshot>;
        clearPin: () => Promise<SyncRoleSnapshot>;
        getRuntimeName: () => Promise<{ runtimeName: string | null }>;
        setRuntimeName: (name: string) => Promise<SyncRoleSnapshot>;
        clearRuntimeName: () => Promise<SyncRoleSnapshot>;
        setActiveLanePresence: (args: { laneIds: string[] }) => Promise<void>;
        getCloudRelayStatus: () => Promise<SyncCloudRelayStatus>;
        onEvent: (cb: (event: SyncStatusEventPayload) => void) => () => void;
      };
      agentTools: {
        detect: () => Promise<AgentTool[]>;
      };
      adeCli: {
        getStatus: () => Promise<AdeCliStatus>;
        installForUser: () => Promise<AdeCliInstallResult>;
      };
      devTools: {
        detect: (force?: boolean) => Promise<DevToolsCheckResult>;
      };
      onboarding: {
        getStatus: () => Promise<OnboardingStatus>;
        detectDefaults: () => Promise<OnboardingDetectionResult>;
        setDismissed: (dismissed: boolean) => Promise<OnboardingStatus>;
        complete: () => Promise<OnboardingStatus>;
      };
      automations: {
        list: () => Promise<AutomationRuleSummary[]>;
        toggle: (args: {
          id: string;
          enabled: boolean;
        }) => Promise<AutomationRuleSummary[]>;
        deleteRule: (
          args: AutomationDeleteRuleRequest,
        ) => Promise<AutomationRuleSummary[]>;
        triggerManually: (
          args: AutomationManualTriggerRequest,
        ) => Promise<AutomationRun>;
        getHistory: (args: {
          id: string;
          limit?: number;
        }) => Promise<AutomationRun[]>;
        listRuns: (args?: AutomationRunListArgs) => Promise<AutomationRun[]>;
        getRunDetail: (runId: string) => Promise<AutomationRunDetail | null>;
        getIngressStatus: () => Promise<AutomationIngressStatus>;
        refreshWebhookGatewayStatus: () => Promise<AutomationWebhookGatewayStatus>;
        setWebhookGatewayPublicUrl: (args: {
          publicUrl?: string | null;
        }) => Promise<AutomationWebhookGatewayStatus>;
        listIngressEvents: (args?: {
          limit?: number;
        }) => Promise<AutomationIngressEventRecord[]>;
        parseNaturalLanguage: (
          req: AutomationParseNaturalLanguageRequest,
        ) => Promise<AutomationParseNaturalLanguageResult>;
        validateDraft: (
          req: AutomationValidateDraftRequest,
        ) => Promise<AutomationValidateDraftResult>;
        saveDraft: (
          req: AutomationSaveDraftRequest,
        ) => Promise<AutomationSaveDraftResult>;
        simulate: (
          req: AutomationSimulateRequest,
        ) => Promise<AutomationSimulateResult>;
        listScheduledCleanups: () => Promise<AutomationScheduledCleanup[]>;
        cancelScheduledCleanup: (id: string) => Promise<boolean>;
        linearIngress: {
          getStatus: () => Promise<AutomationLinearIngressStatus>;
          setup: () => Promise<AutomationLinearIngressStatus>;
          teardown: () => Promise<AutomationLinearIngressStatus>;
          pollNow: () => Promise<AutomationLinearIngressStatus>;
        };
        onEvent: (cb: (ev: AutomationsEventPayload) => void) => () => void;
      };
      review: {
        listLaunchContext: () => Promise<ReviewLaunchContext>;
        listRuns: (args?: ReviewListRunsArgs) => Promise<ReviewRun[]>;
        getRunDetail: (runId: string) => Promise<ReviewRunDetail | null>;
        startRun: (args: ReviewStartRunArgs) => Promise<ReviewRun>;
        rerun: (runId: string) => Promise<ReviewRun>;
        cancelRun: (runId: string) => Promise<ReviewRun | null>;
        recordFeedback: (
          args: import("../shared/types").ReviewRecordFeedbackArgs,
        ) => Promise<import("../shared/types").ReviewFeedbackRecord>;
        listSuppressions: (
          args?: import("../shared/types").ReviewListSuppressionsArgs,
        ) => Promise<import("../shared/types").ReviewSuppression[]>;
        deleteSuppression: (suppressionId: string) => Promise<boolean>;
        qualityReport: () => Promise<
          import("../shared/types").ReviewQualityReport
        >;
        onEvent: (cb: (ev: ReviewEventPayload) => void) => () => void;
      };
      actions: {
        listRegistry: () => Promise<AdeActionRegistryEntry[]>;
      };
      attention: {
        getSnapshot: (
          since?: number,
          streamId?: string | null,
        ) => Promise<import("../shared/types").AttentionSnapshot>;
        /**
         * Resolves with the per-item outcome so a bulk acknowledgment can roll
         * back only the rows the host could not apply. A batch that applies
         * nothing rejects instead, so an empty `acknowledged` never reads as
         * success. `stale` and `unreached` both roll back; they differ in why,
         * and the caller's copy has to differ with them.
         */
        acknowledge: (args: {
          itemIds: string[];
          sourceRevisions?: Record<string, number>;
          /**
           * The `alertFingerprint` each item carried when the user acted on it.
           * The host refuses an item only when its stored fingerprint differs,
           * so a row whose alert identity changed between the poll and the
           * click cannot be silently marked seen. Absent for items published
           * without one.
           */
          alertFingerprints?: Record<string, string>;
          expectedAccountOwnerId?: string | null;
          seenAt?: string;
          dismissedAt?: string | null;
        }) => Promise<import("../shared/types").AttentionAcknowledgmentOutcome>;
        reportPresence: (
          presence: import("../shared/types").AttentionPresence,
        ) => Promise<void>;
        getPreferences: (accountOwnerId: string) => Promise<
          import("../shared/types").AttentionPreferences
        >;
        putPreferences: (
          accountOwnerId: string,
          preferences: import("../shared/types").AttentionPreferences,
        ) => Promise<void>;
        putMachinePreferences?: (
          accountOwnerId: string,
          machineKey: string,
          preferences: Partial<import("../shared/types").AttentionPreferenceScope>,
        ) => Promise<void>;
        openItem: (
          item: import("../shared/types").AttentionItem,
        ) => Promise<void>;
      };
      attentionNotch: {
        publishSnapshot: (
          snapshot: import("../shared/types").AttentionSnapshot,
        ) => Promise<void>;
        // Optional like `onRefreshRequested`: the web adapter has no notch at
        // all, so every call site must optional-chain through it.
        publishToast?: (
          toast: import("../shared/types").AttentionNotchToast,
        ) => Promise<void>;
        updateSettings: (
          settings: import("../shared/types").AttentionNotchSettings,
        ) => Promise<void>;
        getHealth: () => Promise<
          import("../shared/types").AttentionNotchHealth
        >;
        retry: () => Promise<
          import("../shared/types").AttentionNotchHealth
        >;
        onAcknowledgeRequested: (
          cb: (
            request: import("../shared/types").AttentionNotchAcknowledgeRequest,
          ) => void,
        ) => () => void;
        onRefreshRequested?: (
          cb: (request?: { force?: boolean }) => void,
        ) => () => void;
        onSettingsChanged?: (
          cb: (
            settings: import("../shared/types").AttentionNotchSettings,
          ) => void,
        ) => () => void;
      };
      usage: {
        getAdeStats: (args?: GetAdeUsageStatsArgs) => Promise<AdeUsageStats | null>;
        getSnapshot: () => Promise<UsageSnapshot | null>;
        refresh: () => Promise<UsageSnapshot | null>;
        refreshHistory: () => Promise<UsageSnapshot | null>;
        noteDemand: () => Promise<UsageSnapshot | null>;
        checkBudget: (args: BudgetCheckArgs) => Promise<BudgetCheckResult>;
        getCumulativeUsage: (args: {
          scope: BudgetCapScope;
          scopeId?: string;
          provider?: BudgetCapProvider;
        }) => Promise<{
          totalTokens: number;
          totalCostUsd: number;
          weekKey: string;
        }>;
        getBudgetConfig: () => Promise<BudgetCapConfig>;
        saveBudgetConfig: (config: BudgetCapConfig) => Promise<BudgetCapConfig>;
        onUpdate: (cb: (snapshot: UsageSnapshot) => void) => () => void;
      };
      orchestration: {
        runCreate: (args: {
          laneId: string;
          leadSessionId: string;
          title?: string;
          goalSummary?: string;
        }, pin?: OpenProjectBinding | null) => Promise<{
          runId: string;
          manifest: import("../shared/types/orchestration").OrchestrationManifest;
          etag: string;
        }>;
        bundleRead: (args: { runId: string; laneId: string }) => Promise<{
          manifest: import("../shared/types/orchestration").OrchestrationManifest;
          planMd: string;
          etag: string;
        }>;
        manifestReadSection: (args: {
          runId: string;
          laneId: string;
          section: import("../shared/types/orchestration").ManifestSection;
        }) => Promise<{
          section: import("../shared/types/orchestration").ManifestSection;
          data: unknown;
          etag: string;
        }>;
        manifestPatch: (
          args: import("../shared/types/orchestration").OrchestrationManifestPatchRequest & {
            laneId: string;
          },
        ) => Promise<import("../shared/types/orchestration").OrchestrationManifestPatchResponse>;
        planAppend: (
          args: import("../shared/types/orchestration").OrchestrationPlanAppendRequest & {
            laneId: string;
          },
        ) => Promise<{ planMd: string; etag: string }>;
        planWrite: (
          args: import("../shared/types/orchestration").OrchestrationPlanWriteRequest & {
            laneId: string;
          },
        ) => Promise<{ planMd: string; etag: string } | { error: "etag_conflict"; etag: string }>;
        spawnAgent: (
          args: import("../shared/types/orchestration").OrchestrationSpawnAgentRequest & {
            laneId: string;
            leadSessionId: string;
          },
        ) => Promise<{ sessionId: string; etag: string }>;
        agentInject: (
          args: import("../shared/types/orchestration").OrchestrationAgentInjectRequest,
        ) => Promise<void>;
        assetRegister: (
          args: import("../shared/types/orchestration").OrchestrationAssetRegisterRequest & {
            laneId: string;
          },
        ) => Promise<{
          asset: import("../shared/types/orchestration").OrchestrationAsset;
          etag: string;
        }>;
        claimTask: (
          args: import("../shared/types/orchestration").OrchestrationClaimTaskRequest & {
            laneId: string;
          },
        ) => Promise<
          | {
              ok: true;
              manifest: import("../shared/types/orchestration").OrchestrationManifest;
              etag: string;
            }
          | {
              ok: false;
              reason: string;
              manifest: import("../shared/types/orchestration").OrchestrationManifest;
              etag: string;
            }
        >;
        releaseTask: (
          args: import("../shared/types/orchestration").OrchestrationReleaseTaskRequest & {
            laneId: string;
          },
        ) => Promise<{
          manifest: import("../shared/types/orchestration").OrchestrationManifest;
          etag: string;
        }>;
        runList: (args?: {
          laneId?: string;
        }) => Promise<
          import("../shared/types/orchestration").OrchestrationRunSummary[]
        >;
        subscribe: (
          args: { runId: string; laneId?: string },
          callback: (
            payload: import("../shared/types/orchestration").OrchestrationEventPayload,
          ) => void,
        ) => () => void;
      };
      lanes: {
        list: (
          args?: ListLanesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<LaneSummary[]>;
        listSnapshots: (args?: ListLanesArgs) => Promise<LaneListSnapshot[]>;
        create: (args: CreateLaneArgs, pin?: OpenProjectBinding | null) => Promise<LaneSummary>;
        createChild: (
          args: CreateChildLaneArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<LaneSummary>;
        createFromUnstaged: (
          args: CreateLaneFromUnstagedArgs,
        ) => Promise<LaneSummary>;
        importBranch: (args: ImportBranchLaneArgs) => Promise<LaneSummary>;
        previewBranchSwitch: (
          args: LaneBranchSwitchArgs,
        ) => Promise<LaneBranchSwitchPreview>;
        switchBranch: (
          args: LaneBranchSwitchArgs,
        ) => Promise<LaneBranchSwitchResult>;
        getBranchDrift: (args: { laneId: string }) => Promise<LaneBranchDrift | null>;
        resolveBranchDrift: (
          args: ResolveLaneBranchDriftArgs,
        ) => Promise<ResolveLaneBranchDriftResult>;
        rename: (args: RenameLaneArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        reparent: (
          args: ReparentLaneArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ReparentLaneResult>;
        updateAppearance: (
          args: UpdateLaneAppearanceArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        archive: (
          args: ArchiveLaneArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        archiveAndReclaim: (
          args: ArchiveAndReclaimLaneArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ArchiveAndReclaimLaneResult>;
        unarchive: (args: ArchiveLaneArgs) => Promise<RestoreLaneResult>;
        delete: (args: DeleteLaneArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        cancelDelete: (args: {
          laneId: string;
        }) => Promise<{ cancelled: boolean; reason?: string }>;
        listDeleteProgress: () => Promise<LaneDeleteProgress[]>;
        getDeleteRisk: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<LaneDeleteRisk>;
        getReclaimRisk: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<LaneReclaimRisk>;
        onDeleteEvent: (
          cb: (ev: LaneDeleteEvent) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
        onLifecycleEvent: (cb: (ev: LaneLifecycleEvent) => void) => () => void;
        getStackChain: (laneId: string) => Promise<StackChainItem[]>;
        getChildren: (laneId: string) => Promise<LaneSummary[]>;
        attachLinearIssueToSession: (args: {
          chatSessionId: string;
          issues: LaneLinearIssue[];
          role?: string;
          source?: string;
          includeInPr?: boolean;
          closeOnMerge?: boolean;
        }) => Promise<SessionLinearIssueLink[]>;
        detachLinearIssueFromSession: (args: { chatSessionId: string; issueId?: string }) => Promise<boolean>;
        listLinearIssuesForSession: (args: { chatSessionId: string }) => Promise<SessionLinearIssueLink[]>;
        listLinearIssuesForLaneSessions: (args: { laneId: string }) => Promise<SessionLinearIssueLink[]>;
        attachGitHubIssueToSession: (args: {
          chatSessionId: string;
          issues: LaneGitHubIssue[];
          role?: string;
          source?: string;
          includeInPr?: boolean;
          closeOnMerge?: boolean;
        }) => Promise<SessionGitHubIssueLink[]>;
        detachGitHubIssueFromSession: (args: { chatSessionId: string; issueId?: string }) => Promise<boolean>;
        listGitHubIssuesForSession: (args: { chatSessionId: string }) => Promise<SessionGitHubIssueLink[]>;
        listGitHubIssuesForLaneSessions: (args: { laneId: string }) => Promise<SessionGitHubIssueLink[]>;
        unlinkLinearIssues: (args: { laneId: string; issueId?: string }) => Promise<boolean>;
        rebaseStart: (args: RebaseStartArgs) => Promise<RebaseStartResult>;
        rebasePush: (args: RebasePushArgs) => Promise<RebaseRun>;
        rebaseRollback: (args: RebaseRollbackArgs) => Promise<RebaseRun>;
        rebaseAbort: (args: RebaseAbortArgs) => Promise<RebaseRun>;
        rebaseSubscribe: (
          cb: (ev: RebaseRunEventPayload) => void,
        ) => () => void;
        listRebaseSuggestions: () => Promise<RebaseSuggestion[]>;
        dismissRebaseSuggestion: (args: { laneId: string }) => Promise<void>;
        deferRebaseSuggestion: (args: {
          laneId: string;
          minutes: number;
        }) => Promise<void>;
        onRebaseSuggestionsEvent: (
          cb: (ev: RebaseSuggestionsEventPayload) => void,
        ) => () => void;
        listAutoRebaseStatuses: () => Promise<AutoRebaseLaneStatus[]>;
        dismissAutoRebaseStatus: (args: { laneId: string }) => Promise<void>;
        onAutoRebaseEvent: (
          cb: (ev: AutoRebaseEventPayload) => void,
        ) => () => void;
        openFolder: (args: { laneId: string }) => Promise<void>;
        initEnv: (args: InitLaneEnvArgs) => Promise<LaneEnvInitProgress>;
        getEnvStatus: (
          args: GetLaneEnvStatusArgs,
        ) => Promise<LaneEnvInitProgress | null>;
        getOverlay: (args: GetLaneOverlayArgs) => Promise<LaneOverlayOverrides>;
        onEnvEvent: (cb: (ev: LaneEnvInitEvent) => void) => () => void;
        listTemplates: () => Promise<LaneTemplate[]>;
        getTemplate: (
          args: GetLaneTemplateArgs,
        ) => Promise<LaneTemplate | null>;
        getDefaultTemplate: () => Promise<string | null>;
        setDefaultTemplate: (args: SetDefaultLaneTemplateArgs) => Promise<void>;
        applyTemplate: (
          args: ApplyLaneTemplateArgs,
        ) => Promise<LaneEnvInitProgress>;
        saveTemplate: (args: SaveLaneTemplateArgs) => Promise<void>;
        deleteTemplate: (args: DeleteLaneTemplateArgs) => Promise<void>;
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
        proxyGetPreviewInfo: (
          args: GetPreviewInfoArgs,
        ) => Promise<LanePreviewInfo | null>;
        proxyOpenPreview: (args: OpenPreviewArgs) => Promise<void>;
        onProxyEvent: (cb: (ev: LaneProxyEvent) => void) => () => void;
        oauthGetStatus: () => Promise<OAuthRedirectStatus>;
        oauthUpdateConfig: (
          args: UpdateOAuthRedirectConfigArgs,
        ) => Promise<void>;
        oauthGenerateRedirectUris: (
          args: GenerateRedirectUrisArgs,
        ) => Promise<RedirectUriInfo[]>;
        oauthEncodeState: (args: EncodeOAuthStateArgs) => Promise<string>;
        oauthDecodeState: (
          args: DecodeOAuthStateArgs,
        ) => Promise<DecodeOAuthStateResult>;
        oauthListSessions: () => Promise<OAuthSession[]>;
        onOAuthEvent: (cb: (ev: OAuthRedirectEvent) => void) => () => void;
        diagnosticsGetStatus: () => Promise<RuntimeDiagnosticsStatus>;
        diagnosticsGetLaneHealth: (
          args: GetLaneHealthArgs,
        ) => Promise<LaneHealthCheck | null>;
        diagnosticsRunHealthCheck: (
          args: RunHealthCheckArgs,
        ) => Promise<LaneHealthCheck>;
        diagnosticsRunFullCheck: () => Promise<LaneHealthCheck[]>;
        diagnosticsActivateFallback: (
          args: ActivateFallbackArgs,
        ) => Promise<void>;
        diagnosticsDeactivateFallback: (
          args: DeactivateFallbackArgs,
        ) => Promise<void>;
        onDiagnosticsEvent: (
          cb: (ev: RuntimeDiagnosticsEvent) => void,
        ) => () => void;
      };
      sessions: {
        list: (
          args?: ListSessionsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<TerminalSessionSummary[]>;
        get: (
          sessionId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<TerminalSessionDetail | null>;
        delete: (
          args: DeleteSessionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        updateMeta: (
          args: UpdateSessionMetaArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<TerminalSessionSummary | null>;
        settle: (
          sessionId: string,
          opts?: { outcome?: string; dismissPendingInput?: boolean },
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        unsettle: (
          sessionId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
         settleMany: (sessionIds: string[]) => Promise<string[]>;
         unsettleMany: (sessionIds: string[]) => Promise<void>;
        snoozeSession: (
          sessionId: string,
          untilIso: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<boolean>;
        wakeSession: (
          sessionId: string,
          reason?: SessionWakeReason,
          pin?: OpenProjectBinding | null,
        ) => Promise<boolean>;
        snoozeSessions: (
          sessionIds: string[],
          untilIso: string,
        ) => Promise<string[]>;
        wakeSessions: (
          sessionIds: string[],
          reason?: SessionWakeReason,
        ) => Promise<string[]>;
        setSettleOverride: (
          sessionId: string,
          override: SessionSettleOverride | null,
          pin?: OpenProjectBinding | null,
        ) => Promise<boolean>;
        clearWokeMarker: (
          sessionId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<boolean>;
        getLifecycleSettings: () => Promise<SessionLifecycleSettings>;
        updateLifecycleSettings: (
          settings: SessionLifecycleSettings,
        ) => Promise<SessionLifecycleSettings>;
        readTranscriptTail: (
          args: ReadTranscriptTailArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<string>;
        getDelta: (
          sessionId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<SessionDeltaSummary | null>;
        onChanged: (
          cb: (ev: TerminalSessionChangedEvent) => void,
        ) => () => void;
      };
      agentChat: {
        list: (args?: AgentChatListArgs) => Promise<AgentChatSessionSummary[]>;
        getSummary: (
          args: AgentChatGetSummaryArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSessionSummary | null>;
        create: (args: AgentChatCreateArgs, pin?: OpenProjectBinding | null) => Promise<AgentChatSession>;
        launch: (args: AgentChatLaunchArgs) => Promise<AgentChatSession>;
        launchCli: (
          args: AgentChatLaunchCliArgs,
        ) => Promise<AgentChatLaunchCliResult>;
        suggestLaneName: (
          args: AgentChatSuggestLaneNameArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<string>;
        generateAutoLaneIdentity: (
          args: AgentChatSuggestLaneNameArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AutoLaneIdentitySuggestion>;
        parallelLaunchState: {
          get: (
            args: AgentChatParallelLaunchStateArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<AgentChatParallelLaunchState | null>;
          set: (
            args: AgentChatSetParallelLaunchStateArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<void>;
        };
        handoff: (
          args: AgentChatHandoffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatHandoffResult>;
        prepareCrossMachineHandoff: (
          args: AgentChatPrepareCrossMachineHandoffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatPrepareCrossMachineHandoffResult>;
        validateCrossMachineSource: (
          args: AgentChatValidateCrossMachineSourceArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        markCrossMachineHandoff: (
          args: AgentChatMarkCrossMachineHandoffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        send: (args: AgentChatSendArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        steer: (
          args: AgentChatSteerArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSteerResult>;
        cancelSteer: (
          args: AgentChatCancelSteerArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        editSteer: (args: AgentChatEditSteerArgs) => Promise<void>;
        dispatchSteer: (
          args: AgentChatDispatchSteerArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatDispatchSteerResult>;
        cancelDispatchedSteer: (
          args: AgentChatCancelDispatchedSteerArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatCancelDispatchedSteerResult>;
        interrupt: (
          args: AgentChatInterruptArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatInterruptResult>;
        stopTask: (
          args: AgentChatStopTaskArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatStopTaskResult>;
        restoreCancelledQueue: (
          args: AgentChatRestoreCancelledQueueArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatRestoreCancelledQueueResult>;
        recoverTurn: (
          args: AgentChatRecoverTurnArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatRecoverTurnResult>;
        recoverCodexTurn: (
          args: AgentChatRecoverCodexTurnArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatRecoverCodexTurnResult>;
        resolveUnprocessedMessage: (
          args: AgentChatResolveUnprocessedMessageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatResolveUnprocessedMessageResult>;
        recoverContinuity: (
          args: AgentChatRecoverContinuityArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatContinuityRecoveryResult>;
        approve: (
          args: AgentChatApproveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        respondToInput: (
          args: AgentChatRespondToInputArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        models: (
          args: AgentChatModelsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatModelInfo[]>;
        modelCatalog: (
          args?: AgentChatModelCatalogArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatModelCatalog>;
        archive: (
          args: AgentChatArchiveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        unarchive: (
          args: AgentChatArchiveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        delete: (args: AgentChatDeleteArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        updateSession: (
          args: AgentChatUpdateSessionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSession>;
        regenerateSessionMetadata: (
          args: AgentChatRegenerateSessionMetadataArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatRegenerateSessionMetadataResult>;
        createScheduledWork: (
          args: AgentChatCreateScheduledWorkArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatCreateScheduledWorkResult>;
        listScheduledWork: (
          args?: AgentChatListScheduledWorkArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatScheduledWorkItem[]>;
        cancelScheduledWork: (
          args: AgentChatCancelScheduledWorkArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatCancelScheduledWorkResult>;
        setScheduledWorkPaused: (
          args: AgentChatSetScheduledWorkPausedArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSetScheduledWorkPausedResult>;
        warmupModel: (
          args: {
            sessionId: string;
            modelId: string;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        onEvent: (
          cb: (ev: AgentChatEventEnvelope) => void,
          pin?: OpenProjectBinding | null,
          options?: { forcePinned?: boolean },
        ) => () => void;
        slashCommands: (
          args: AgentChatSlashCommandsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSlashCommand[]>;
        listClaudePlugins: (
          args?: AgentChatClaudePluginsArgs,
        ) => Promise<AgentChatClaudePlugin[]>;
        reloadClaudePlugins: (
          args: AgentChatReloadClaudePluginsArgs,
        ) => Promise<AgentChatReloadClaudePluginsResult>;
        listClaudeOutputStyles: (
          args?: AgentChatClaudeOutputStylesArgs,
        ) => Promise<AgentChatClaudeOutputStyle[]>;
        setClaudeOutputStyle: (
          args: AgentChatSetClaudeOutputStyleArgs,
        ) => Promise<AgentChatSession>;
        listClaudeSessions: (
          args?: AgentChatClaudeSessionListArgs,
        ) => Promise<AgentChatClaudeSessionInfo[]>;
        getClaudeSessionInfo: (
          args: AgentChatClaudeSessionInfoArgs,
        ) => Promise<AgentChatClaudeSessionInfo | null>;
        getClaudeSessionMessages: (
          args: AgentChatClaudeSessionMessagesArgs,
        ) => Promise<AgentChatClaudeSessionMessage[]>;
        getMainTranscript: (
          args: AgentChatMainTranscriptArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSubagentTranscriptMessage[] | null>;
        getSubagentTranscript: (
          args: AgentChatSubagentTranscriptArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSubagentTranscriptMessage[] | null>;
        getContextUsage: (
          args: AgentChatContextUsageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatContextUsage | null>;
        rewindFiles: (
          args: AgentChatRewindFilesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatRewindFilesResult>;
        fileSearch: (
          args: AgentChatFileSearchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatFileSearchResult[]>;
        // Optional: the webclient adapter's agentChat surface does not
        // implement it, and callers must degrade to an empty menu section.
        listMentionSuggestions?: (
          args: ChatMentionSuggestArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatMentionSuggestResult>;
        promptStashes: {
          list: (
            pin?: OpenProjectBinding | null,
          ) => Promise<PromptStashEntry[]>;
          create: (
            args: PromptStashCreateArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<PromptStashEntry>;
          delete: (
            args: PromptStashDeleteArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<boolean>;
        };
        getTurnFileDiff: (
          args: AgentChatGetTurnFileDiffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatTurnFileDiff | null>;
        listSubagents: (
          args: AgentChatSubagentListArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSubagentSnapshot[]>;
        killDroidWorker: (
          args: AgentChatKillDroidWorkerArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        getSessionCapabilities: (
          args: AgentChatSessionCapabilitiesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatSessionCapabilities>;
        saveTempAttachment: (
          args: {
            data: string;
            filename: string;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ path: string }>;
        getAttachmentStagingMode: (
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatAttachmentStagingMode>;
        stageFileAttachment: (
          args: AgentChatCopyTempAttachmentArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ path: string }>;
        getImageDataUrl: (
          path: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ dataUrl: string }>;
        resolveSmartLinkPreview: (args: { url: string }) => Promise<SmartLinkPreview | null>;
        getEventHistory: (
          args: {
            sessionId: string;
            maxEvents?: number;
            maxBytes?: number;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatEventHistorySnapshot>;
        getEventHistoryPage: (
          args: {
            sessionId: string;
            beforeOffset: number;
            maxBytes?: number;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatEventHistoryPage>;
        codex: {
          getGoal: (
            args: AgentChatCodexGetGoalArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<CodexThreadGoal | null>;
          setGoal: (
            args: AgentChatCodexSetGoalArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<CodexThreadGoal | null>;
          setGoalStatus: (
            args: AgentChatCodexSetGoalStatusArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<CodexThreadGoal | null>;
          clearGoal: (
            args: AgentChatCodexClearGoalArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<CodexThreadGoal | null>;
          resetMemory: (
            args: AgentChatCodexResetMemoryArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<void>;
          terminateBackgroundTerminal: (
            args: AgentChatCodexTerminateBackgroundTerminalArgs,
            pin?: OpenProjectBinding | null,
          ) => Promise<void>;
        };
        readTranscript: (args: {
          sessionId: string;
          limit?: number;
          since?: string;
        }) => Promise<unknown>;
      };
      computerUse: {
        listArtifacts: (
          args?: ComputerUseArtifactListArgs,
        ) => Promise<ComputerUseArtifactView[]>;
        getOwnerSnapshot: (
          args: ComputerUseOwnerSnapshotArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ComputerUseOwnerSnapshot>;
        deleteArtifacts: (
          args: ComputerUseArtifactDeleteArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ComputerUseArtifactDeleteResult>;
        listBrokenArtifacts: (args?: {
          limit?: number;
        }) => Promise<ComputerUseArtifactBrokenRecord[]>;
        pruneBrokenArtifacts: () => Promise<ComputerUseArtifactDeleteResult>;
        recoverArtifact: (
          args: { artifactId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<ComputerUseArtifactView>;
        updateArtifactReview: (
          args: ComputerUseArtifactReviewArgs,
        ) => Promise<ComputerUseArtifactView>;
        readArtifactPreview: (
          args: { uri: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<string | null>;
        onEvent: (
          cb: (ev: ComputerUseEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      iosSimulator: {
        getStatus: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorStatus>;
        listDevices: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorDevice[]>;
        listLaunchTargets: (
          args?: IosSimulatorListLaunchTargetsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorLaunchTarget[]>;
        launch: (
          args?: IosSimulatorLaunchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorLaunchResult>;
        attachToChatSession: (
          args: {
            chatSessionId: string | null;
            callerChatSessionId?: string | null;
            takeOver?: boolean;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorSession | null>;
        shutdown: (
          args?: IosSimulatorShutdownArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorShutdownResult>;
        screenshot: (
          args?: IosSimulatorScreenshotArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorScreenshot>;
        getScreenSnapshot: (
          args?: IosScreenSnapshotArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosScreenSnapshot>;
        getInspectorSnapshot: (
          args?: { deviceUdid?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<IosInspectorSnapshot | null>;
        inspectPoint: (
          args: IosSimulatorInspectPointArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorInspectResult>;
        getPreviewCapability: (
          args?: IosSimulatorListPreviewsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorPreviewCapability>;
        listPreviewTargets: (
          args?: IosSimulatorListPreviewsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorPreviewTarget[]>;
        resolvePreviewMatch: (
          args?: IosSimulatorListPreviewsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorPreviewMatch>;
        ensurePreviewWorkspace: (
          args?: IosSimulatorEnsurePreviewWorkspaceArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorEnsurePreviewWorkspaceResult>;
        renderCurrentPreview: (
          args?: IosSimulatorRenderCurrentPreviewArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorRenderCurrentPreviewResult>;
        renderPreview: (
          args: IosSimulatorRenderPreviewArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorRenderPreviewResult>;
        openPreviewWorkspace: (
          args?: IosSimulatorOpenPreviewWorkspaceArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true; path: string }>;
        startStream: (
          args?: IosSimulatorStartStreamArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorStreamStatus>;
        stopStream: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorStreamStatus>;
        getStreamStatus: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorStreamStatus>;
        getSimulatorWindowState: () => Promise<IosSimulatorWindowState>;
        listSimulatorWindowSources: (opts?: {
          session?: IosSimulatorWindowCaptureSessionHint | null;
        }) => Promise<IosSimulatorWindowSourcesResult>;
        /**
         * Registers one capture surface as depending on the parking claim.
         * Resolves whether the host counted the holder — it refuses one from a
         * window that does not own the claim — so only a `true` may be paired
         * with a later release. Never throws; a failure resolves `false`.
         */
        retainWindowParking: () => Promise<boolean>;
        /** Drops one holder of the window-parking follow. Never throws. */
        releaseWindowParking: () => Promise<void>;
        openSystemSettings: (args: {
          pane: IosSimulatorPrivacyPane;
        }) => Promise<{ ok: boolean }>;
        revealSimulator: () => Promise<{ ok: boolean; message: string | null }>;
        // No projectRoot: tapping drives the booted device, and the service
        // never resolves a build root for it.
        tap: (
          args: { deviceUdid?: string | null; x: number; y: number },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        typeText: (
          args: { deviceUdid?: string | null; text: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        drag: (
          args: IosSimulatorDragArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        swipe: (
          args: IosSimulatorDragArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        // Mirrors the shared IosSimulatorPoint: selection matches source
        // against the caller's tree, so the lane has to ride the wire.
        selectPoint: (
          args: {
            deviceUdid?: string | null;
            projectRoot?: string | null;
            laneId?: string | null;
            x: number;
            y: number;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorSelectResult>;
        onEvent: (
          cb: (ev: IosSimulatorEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      appControl: {
        getStatus: (
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlStatus>;
        launch: (
          args?: AppControlLaunchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSession>;
        launchInTerminal: (
          args?: AppControlLaunchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSession>;
        connect: (
          args: AppControlConnectArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSession>;
        stop: (
          args?: AppControlStopArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true; previousSession: AppControlSession | null }>;
        focusWindow: (
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        minimizeWindow: (
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        screenshot: (
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlScreenshot>;
        getSnapshot: (
          args?: AppControlSnapshotArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSnapshot>;
        inspectPoint: (
          args: AppControlInspectPointArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlInspectResult>;
        selectPoint: (
          args: AppControlInspectPointArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSelectResult>;
        click: (
          args: AppControlClickArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        typeText: (
          args: AppControlTypeTextArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        scroll: (
          args: { x: number; y: number; deltaX: number; deltaY: number; scale?: number | null; coordinateSpace?: "screenshot" | "viewport" | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        dispatchKey: (
          args: { type: "keyDown" | "keyUp" | "rawKeyDown" | "char"; key?: string | null; code?: string | null; text?: string | null; modifiers?: number | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        listTargets: (
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlTarget[]>;
        attachToTarget: (
          args: { targetId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<AppControlSession>;
        onEvent: (
          cb: (ev: AppControlEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      builtInBrowser: {
        getStatus: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        requestOriginAccess: (
          args?: BuiltInBrowserRequestOriginAccessArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserOriginAccessResult>;
        getProfileDiagnostics: () => Promise<BuiltInBrowserProfileDiagnostics>;
        listPermissions: () => Promise<BuiltInBrowserPermissionsResult>;
        clearPermissions: (
          args?: BuiltInBrowserClearPermissionsArgs,
        ) => Promise<BuiltInBrowserClearPermissionsResult>;
        showPanel: (
          args?: BuiltInBrowserOpenPanelArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        setBounds: (
          args: BuiltInBrowserBoundsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        attachWebview: (
          args: BuiltInBrowserAttachWebviewArgs,
        ) => Promise<BuiltInBrowserStatus>;
        navigate: (
          args: BuiltInBrowserNavigateArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        createTab: (
          args?: BuiltInBrowserCreateTabArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        switchTab: (
          args: BuiltInBrowserTabArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        closeTab: (
          args: BuiltInBrowserTabArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        reload: (
          args?: BuiltInBrowserTabTargetArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        goBack: (
          args?: BuiltInBrowserTabTargetArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        goForward: (
          args?: BuiltInBrowserTabTargetArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        stop: (
          args?: BuiltInBrowserTabTargetArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        startInspect: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        stopInspect: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        captureScreenshot: (
          args?: BuiltInBrowserTabTargetArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserScreenshot>;
        selectPoint: (
          args: BuiltInBrowserSelectPointArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserSelectResult>;
        selectCurrent: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserSelectResult>;
        clearSelection: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        onEvent: (
          cb: (ev: BuiltInBrowserEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      terminal: {
        list: (
          args?: ChatTerminalListArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatTerminalSession[]>;
        read: (
          args?: ChatTerminalReadArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatTerminalReadResult>;
        preview: (
          args?: ChatTerminalPreviewArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatTerminalPreviewResult>;
        write: (
          args: ChatTerminalWriteArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        signal: (
          args: ChatTerminalSignalArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: true }>;
        activeForChat: (
          args: ChatTerminalActiveForChatArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatTerminalSession | null>;
        reattachChatCli: (
          args: ChatTerminalReattachArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ChatTerminalReattachResult>;
      };
      localhost: {
        probePort: (port: number) => Promise<boolean>;
      };
      search: {
        query: (args: SearchQueryArgs) => Promise<SearchQueryResult>;
        indexStatus: () => Promise<SearchIndexStatus | null>;
        rebuildIndex: () => Promise<SearchRebuildResult>;
      };
      externalSessions: {
        list: (
          args?: ExternalSessionListArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ExternalSessionSummary[]>;
        import: (
          args: ExternalSessionImportArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ExternalSessionImportResult>;
        getDetail: (
          args: ExternalSessionDetailArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ExternalSessionDetail>;
        watchDetail: (args: ExternalSessionDetailWatchArgs) => Promise<ExternalSessionDetail>;
        unwatchDetail: (args: { watchId: string }) => Promise<{ ok: true }>;
        onDetailUpdated: (cb: (ev: ExternalSessionDetailUpdatedEvent) => void) => () => void;
      };
      /**
       * Shaped by type-only imports from `shared/plugins/sdk`, and the preload's
       * own `pluginBridge.ts` is written `satisfies` this type — so drift
       * between what preload publishes and what the UI calls is a compile error
       * rather than a runtime empty state. One name, no alias.
       *
       * A member with no action behind it is absent rather than stubbed: the
       * bridge reads a missing member as "this host cannot do it", and a stub
       * would read as "supported".
       */
      plugins: {
        list: () => Promise<InstalledPlugin[]>;
        getPanel: (args: {
          pluginId: string;
          panelId: string;
        }) => Promise<PluginPanelRecord | null>;
        getCollection: (args: {
          pluginId: string;
          collection: string;
          keyPrefix?: string;
          limit?: number;
        }) => Promise<PluginCollectionRow[]>;
        invoke: (args: {
          pluginId: string;
          action: string;
          args?: Record<string, unknown>;
        }) => Promise<unknown>;
        restart: (args: { pluginId: string }) => Promise<void>;
        install: (args: PluginInstallRequest) => Promise<PluginInstallResult>;
        uninstall: (args: { pluginId: string; machineKey?: string }) => Promise<void>;
        setEnabled: (args: {
          pluginId: string;
          enabled: boolean;
          machineKey?: string;
        }) => Promise<void>;
        getConfig: (args: {
          pluginId: string;
        }) => Promise<Record<string, string | number | boolean | null>>;
        /** A PATCH: absent keys keep their value, null resets to the default. */
        setConfig: (args: {
          pluginId: string;
          values: Record<string, string | number | boolean | null>;
        }) => Promise<void>;
        setContributionEnabled: (args: {
          pluginId: string;
          socketId: string;
          enabled: boolean;
        }) => Promise<void>;
        marketplaceIndex: (args?: { refresh?: boolean }) => Promise<MarketplaceIndexPayload | null>;
        /** A repository's live star count. Null means unknown, never zero. */
        repoStars: (args: { repo: string }) => Promise<number | null>;
        presence: () => Promise<PluginPresenceRow[]>;
        getReadme: (args: { pluginId: string }) => Promise<string | null>;
        /** Raw manifest object; the renderer parses it. */
        getManifest: (args: { pluginId: string }) => Promise<unknown | null>;
        /** Recent lines from the plugin's child-process log ring. */
        openLogs: (args: { pluginId: string }) => Promise<PluginLogEntry[]>;
        /** The dynamic half of the socket taxonomy — per-entity contributions. */
        listContributions: (args: {
          surface: string;
          entityKind?: string;
          entityIds?: string[];
        }) => Promise<PluginContributionRecord[]>;
        inspectSource: (args: { source: string }) => Promise<PluginSourceInspection | null>;
        usageSummary: (args?: { pluginId?: string }) => Promise<PluginUsageRow[]>;
        /** Webhook ingress health. Never carries the relay secret. */
        webhookIngress: (args?: { pluginId?: string }) => Promise<PluginWebhookIngressStatus[]>;
        /**
         * Whether this host can act on a machine other than this one. A plain
         * value, not a shape probe: `install` and `presence` are both present
         * here and both refuse a `machineKey`.
         */
        remoteInstall: boolean;
        onChanged: (cb: (event: PluginChangeEvent) => void) => () => void;
        /**
         * The plugin-page relay. Absent on a host from before the page tier,
         * which is what lets the renderer degrade honestly instead of drawing a
         * page whose buttons can never reach ADE's own UI.
         *
         * Payloads arrive as `unknown` on purpose — see the note in
         * `preload/pluginBridge.ts`.
         */
        webview: {
          onUiRequest: (cb: (request: unknown) => void) => () => void;
          respondUi: (response: PluginWebviewUiResponse) => void;
          publishTheme: (snapshot: PluginWebviewThemeSnapshot) => void;
          /**
           * One chat turn's move, for the guests of THIS window that follow the
           * `chat` host kind. Published by the renderer because it is the only
           * party that sees a turn start or die.
           */
          publishChatTurn: (turn: PluginWebviewChatTurn) => void;
          /**
           * One `operation` / `conflict` / `review` move for guests of THIS
           * window that follow those host kinds. Main refuses any other kind
           * so a family with its own producer cannot fire twice.
           */
          publishHostChange: (change: { kind: string; ids: string[] }) => void;
          setSurfaceState: (state: PluginWebviewSurfaceState) => void;
          onReload: (cb: (event: unknown) => void) => () => void;
        };
      };
      pty: {
        create: (args: PtyCreateArgs, pin?: OpenProjectBinding | null) => Promise<PtyCreateResult>;
        resumeSession: (
          args: PtyResumeSessionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<PtyResumeSessionResult>;
        sendToSession: (
          args: PtySendToSessionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<PtySendToSessionResult>;
        write: (
          args: { ptyId: string; data: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        resize: (
          args: {
            ptyId: string;
            cols: number;
            rows: number;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        dispose: (args: { ptyId: string; sessionId?: string }, pin?: OpenProjectBinding | null) => Promise<PtyDisposeResult>;
        setDataSubscriptions: (
          args: { ptyIds: string[] },
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        onData: (
          cb: (ev: PtyDataEvent) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
        onExit: (
          cb: (ev: PtyExitEvent) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      diff: {
        getChanges: (
          args: GetDiffChangesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<DiffChanges>;
        getFile: (
          args: GetFileDiffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FileDiff>;
        getFilePatch: (
          args: GetFilePatchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilePatch>;
      };
      // `pin` addresses one machine explicitly: omitted or null means "the
      // machine this project tab is bound to" (today's behavior, including the
      // local IPC fallback), a binding means "that machine, regardless of what
      // the tab is bound to". Writes honour it too — a file on another
      // connected machine is fully editable. `external-local:*` workspaces are
      // local-only by construction and ignore the pin.
      files: {
        writeTextAtomic: (
          args: WriteTextAtomicArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        listWorkspaces: (
          args?: FilesListWorkspacesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesWorkspace[]>;
        listTree: (
          args: FilesListTreeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FileTreeNode[]>;
        listTreeChildren: (
          args: FilesListTreeChildrenArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesListTreeChildrenResult>;
        refreshGitDecorations: (
          args: FilesRefreshGitDecorationsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesGitStatusEvent>;
        /** Local-only: the path comes from this machine's Finder/drag-drop, so it takes no pin. */
        openExternalPath: (
          args: FilesOpenExternalPathArgs,
        ) => Promise<FilesOpenExternalPathResult>;
        readFile: (
          args: FilesReadFileArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FileContent>;
        readFileRange: (
          args: FilesReadFileRangeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesReadFileRangeResult>;
        gitBlame: (
          args: FilesGitBlameArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesGitBlameResult>;
        writeText: (
          args: FilesWriteTextArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        createFile: (
          args: FilesCreateFileArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        createDirectory: (
          args: FilesCreateDirectoryArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        rename: (
          args: FilesRenameArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        delete: (
          args: FilesDeleteArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        watchChanges: (
          args: FilesWatchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        stopWatching: (
          args: FilesWatchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        quickOpen: (
          args: FilesQuickOpenArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesQuickOpenItem[]>;
        searchText: (
          args: FilesSearchTextArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<FilesSearchTextMatch[]>;
        onChange: (cb: (ev: FileChangeEvent) => void) => () => void;
      };
      git: {
        stageFile: (
          args: GitFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stageAll: (
          args: GitBatchFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        unstageFile: (
          args: GitFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        unstageAll: (
          args: GitBatchFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        discardFile: (
          args: GitFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        restoreStagedFile: (
          args: GitFileActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        commit: (
          args: GitCommitArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        generateCommitMessage: (
          args: GitGenerateCommitMessageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitGenerateCommitMessageResult>;
        listRecentCommits: (
          args: { laneId: string; limit?: number },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitCommitSummary[]>;
        listCommitFiles: (
          args: GitListCommitFilesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<string[]>;
        getCommitMessage: (
          args: GitGetCommitMessageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<string>;
        getCommit: (
          args: { laneId: string; commitSha: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitCommitSummary | null>;
        isCommitInLaneHistory: (
          args: { laneId: string; commitSha: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<boolean>;
        revertCommit: (
          args: GitRevertArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        cherryPickCommit: (
          args: GitCherryPickArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        createTag: (
          args: GitCreateTagArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        resetToCommit: (
          args: GitResetCommitArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stashPush: (
          args: GitStashPushArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stashList: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitStashSummary[]>;
        stashApply: (
          args: GitStashRefArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stashPop: (
          args: GitStashRefArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stashDrop: (
          args: GitStashRefArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        stashClear: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        fetch: (args: { laneId: string }, pin?: OpenProjectBinding | null) => Promise<GitActionResult>;
        pull: (
          args: GitPullArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        undoLastHeadChange: (
          args: GitHeadChangeActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        redoLastHeadChange: (
          args: GitHeadChangeActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        getSyncStatus: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitUpstreamSyncStatus>;
        getOriginRemote: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ remoteUrl: string | null; branch: string | null }>;
        getOpenPrForBranch: (
          args: { laneId: string; branch?: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<{
          prUrl: string | null;
          prNumber: number | null;
          title: string | null;
          headRefName: string | null;
        }>;
        sync: (
          args: GitSyncArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        push: (
          args: GitPushArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        getConflictState: (
          laneId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitConflictState>;
        rebaseContinue: (
          args: string | { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        rebaseAbort: (
          args: string | { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        mergeContinue: (
          args: string | { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        mergeAbort: (
          args: string | { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
        listBranches: (
          args: GitListBranchesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitBranchSummary[]>;
        getUserIdentity: (
          args: GitGetUserIdentityArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitUserIdentity>;
        checkoutBranch: (
          args: GitCheckoutBranchArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitActionResult>;
      };
      conflicts: {
        getLaneStatus: (
          args: GetLaneConflictStatusArgs,
        ) => Promise<ConflictStatus>;
        listOverlaps: (args: ListOverlapsArgs) => Promise<ConflictOverlap[]>;
        getRiskMatrix: () => Promise<RiskMatrixEntry[]>;
        simulateMerge: (
          args: MergeSimulationArgs,
        ) => Promise<MergeSimulationResult>;
        runPrediction: (
          args?: RunConflictPredictionArgs,
        ) => Promise<BatchAssessmentResult>;
        getBatchAssessment: () => Promise<BatchAssessmentResult>;
        listProposals: (laneId: string) => Promise<ConflictProposal[]>;
        prepareProposal: (
          args: PrepareConflictProposalArgs,
        ) => Promise<ConflictProposalPreview>;
        requestProposal: (
          args: RequestConflictProposalArgs,
        ) => Promise<ConflictProposal>;
        applyProposal: (
          args: ApplyConflictProposalArgs,
        ) => Promise<ConflictProposal>;
        undoProposal: (
          args: UndoConflictProposalArgs,
        ) => Promise<ConflictProposal>;
        runExternalResolver: (
          args: RunExternalConflictResolverArgs,
        ) => Promise<ConflictExternalResolverRunSummary>;
        listExternalResolverRuns: (
          args?: ListExternalConflictResolverRunsArgs,
        ) => Promise<ConflictExternalResolverRunSummary[]>;
        commitExternalResolverRun: (
          args: CommitExternalConflictResolverRunArgs,
        ) => Promise<CommitExternalConflictResolverRunResult>;
        prepareResolverSession: (
          args: PrepareResolverSessionArgs,
        ) => Promise<PrepareResolverSessionResult>;
        attachResolverSession: (
          args: AttachResolverSessionArgs,
        ) => Promise<ConflictExternalResolverRunSummary>;
        finalizeResolverSession: (
          args: FinalizeResolverSessionArgs,
        ) => Promise<ConflictExternalResolverRunSummary>;
        cancelResolverSession: (
          args: CancelResolverSessionArgs,
        ) => Promise<ConflictExternalResolverRunSummary>;
        suggestResolverTarget: (
          args: SuggestResolverTargetArgs,
        ) => Promise<SuggestResolverTargetResult>;
        onEvent: (cb: (ev: ConflictEventPayload) => void) => () => void;
      };
      feedback: {
        prepareDraft: (
          args: FeedbackPrepareDraftArgs,
        ) => Promise<FeedbackPreparedDraft>;
        submitDraft: (
          args: FeedbackSubmitDraftArgs,
        ) => Promise<FeedbackSubmission>;
        list: () => Promise<FeedbackSubmission[]>;
        onUpdate: (cb: (event: FeedbackSubmissionEvent) => void) => () => void;
      };
      github: {
        getStatus: (opts?: { forceRefresh?: boolean }) => Promise<GitHubStatus>;
        getRemoteStatus: (opts?: {
          forceRefresh?: boolean;
        }) => Promise<{ repo: GitHubRepoRef | null; hasOrigin: boolean }>;
        setToken: (token: string) => Promise<GitHubSetTokenResult>;
        clearToken: () => Promise<GitHubStatus>;
        getAppUserAuthStatus: () => Promise<GitHubAppUserAuthStatus>;
        startAppUserDeviceAuth: () => Promise<GitHubAppDeviceAuthStartResult>;
        pollAppUserDeviceAuth: (args: {
          sessionId: string;
        }) => Promise<GitHubAppDeviceAuthPollResult>;
        clearAppUserAuth: () => Promise<GitHubAppUserAuthStatus>;
        // Optional: an older remote runtime does not implement the budget read.
        // Callers must feature-detect and fall back to their own local backoff.
        getRequestBudget?: () => Promise<GitHubRequestBudget>;
        detectRepo: () => Promise<{ owner: string; name: string } | null>;
        listRepoIssues: (args?: {
          owner?: string;
          name?: string;
          state?: "open" | "closed" | "all";
          since?: string;
        }) => Promise<GitHubIssueLike[]>;
        getIssue: (args: {
          owner?: string;
          name?: string;
          number: number;
        }) => Promise<GitHubIssueLike | null>;
        listRepoAutolinks: (args?: {
          owner?: string;
          name?: string;
        }) => Promise<GitHubAutolink[]>;
        getAppInstallationStatus: (args?: {
          owner?: string;
          name?: string;
          forceRefresh?: boolean;
        }) => Promise<GitHubAppInstallationStatus>;
        createRepoAutolink: (args: {
          owner?: string;
          name?: string;
          keyPrefix: string;
          urlTemplate: string;
          isAlphanumeric?: boolean;
        }) => Promise<GitHubAutolink>;
        listRepoLabels: (args: {
          owner: string;
          name: string;
        }) => Promise<Array<{ name: string; color?: string }>>;
        listRepoCollaborators: (args: {
          owner: string;
          name: string;
        }) => Promise<Array<{ login: string; avatarUrl?: string }>>;
        /**
         * Star state for an arbitrary repository (a Marketplace plugin's, not
         * necessarily the project's own). `stars` is null when the count could
         * not be read.
         */
        getRepoStarState: (args: {
          owner: string;
          name: string;
        }) => Promise<{ starred: boolean; stars: number | null }>;
        /** Stars or unstars a repository for the signed-in GitHub user. */
        setRepoStarred: (args: {
          owner: string;
          name: string;
          starred: boolean;
        }) => Promise<void>;
        listMyRepos: (
          input?: ListMyGitHubReposInput,
        ) => Promise<ListMyGitHubReposResult>;
        publishCurrentProject: (
          input: PublishProjectInput,
        ) => Promise<PublishProjectResult>;
        onStatusChanged: (cb: (status: GitHubStatus) => void) => () => void;
      };
      account: {
        status: () => Promise<AdeAccountStatus>;
        startLogin: () => Promise<AdeAccountLoginStart>;
        pollLogin: (args: { sessionId: string }) => Promise<AdeAccountLoginPoll>;
        cancelLogin: (args: { sessionId: string }) => Promise<AdeAccountStatus>;
        /**
         * Device-authorization sign-in, run inside the brain so the account
         * directory observes it and can mint the pairing grant a removed
         * machine needs. The loopback `startLogin` above stays the normal
         * sign-in path.
         */
        startDeviceLogin: () => Promise<AdeAccountDeviceLoginStart>;
        pollDeviceLogin: (args: { sessionId: string }) => Promise<AdeAccountDeviceLoginPoll>;
        cancelDeviceLogin: (args: { sessionId: string }) => Promise<AdeAccountStatus>;
        signOut: () => Promise<AdeAccountStatus>;
        listMachines: () => Promise<AdeAccountMachinesResult>;
        renameMachine: (
          machineKey: string,
          customName: string | null,
        ) => Promise<AdeAccountMachine>;
        getLocalMachineIdentity: () => Promise<AdeAccountLocalMachineIdentity>;
        pairMachine: (machineKey: string) => Promise<AdeAccountMachinePairResult>;
        onPairMachineProgress: (
          cb: (progress: AdeAccountPairMachineProgress) => void,
        ) => () => void;
        removeMachine: (machineKey: string) => Promise<AdeAccountMachineRemovalResult>;
        /** Re-pairs THIS machine after an account-side removal. */
        repairMachinePairing: () => Promise<AdeAccountMachinePairingRepairResult>;
        /**
         * Repairs the stored sign-in on THIS Mac: converge the credential
         * file's key binding, restore anything set aside, then restart the
         * background service. Optional because older preloads lack it.
         */
        repairSession?: () => Promise<AdeAccountSessionRepairResult>;
      };
      prs: {
        createFromLane: (args: CreatePrFromLaneArgs) => Promise<PrSummary>;
        linkToLane: (args: LinkPrToLaneArgs) => Promise<PrSummary>;
        preflightCreateLaneFromPrBranch: (
          args: CreateLaneFromPrBranchArgs,
        ) => Promise<CreateLaneFromPrBranchPreflightResult>;
        createLaneFromPrBranch: (
          args: CreateLaneFromPrBranchArgs,
        ) => Promise<CreateLaneFromPrBranchResult>;
        /**
         * `pin` routes the read to the machine that owns the lane. A PR row
         * lives in that machine's database, so an unpinned read only ever
         * answers for the machine the project tab is bound to. The PRs tab
         * (which IS bound-machine-scoped) simply omits it.
         */
        getForLane: (
          laneId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrSummary | null>;
        syncLanePr: (
          laneId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrSummary | null>;
        reconcileNow: () => Promise<void>;
        listAll: (pin?: OpenProjectBinding | null) => Promise<PrSummary[]>;
        listOpenForRepo: () => Promise<BranchPullRequest[]>;
        refresh: (
          args?: {
            prId?: string;
            prIds?: string[];
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<PrSummary[]>;
        getStatus: (
          prId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrStatus | null>;
        getChecks: (
          prId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrCheck[]>;
        getComments: (
          prId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrComment[]>;
        getReviews: (
          prId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<PrReview[]>;
        getReviewThreads: (prId: string) => Promise<PrReviewThread[]>;
        updateDescription: (args: UpdatePrDescriptionArgs) => Promise<void>;
        delete: (args: DeletePrArgs) => Promise<DeletePrResult>;
        draftDescription: (
          args: DraftPrDescriptionArgs,
        ) => Promise<{ title: string; body: string }>;
        land: (args: LandPrArgs) => Promise<LandResult>;
        updateBranch: (args: UpdateBranchArgs) => Promise<UpdateBranchResult>;
        retargetBase: (args: {
          prId: string;
          baseBranch: string;
        }) => Promise<void>;
        openInGitHub: (prId: string) => Promise<void>;
        createIntegration: (
          args: CreateIntegrationPrArgs,
        ) => Promise<CreateIntegrationPrResult>;
        simulateIntegration: (
          args: SimulateIntegrationArgs,
        ) => Promise<IntegrationProposal>;
        commitIntegration: (
          args: CommitIntegrationArgs,
        ) => Promise<CreateIntegrationPrResult>;
        listProposals(): Promise<IntegrationProposal[]>;
        updateProposal(args: UpdateIntegrationProposalArgs): Promise<void>;
        deleteProposal(
          args: DeleteIntegrationProposalArgs,
        ): Promise<DeleteIntegrationProposalResult>;
        createIntegrationLaneForProposal(
          args: CreateIntegrationLaneForProposalArgs,
        ): Promise<CreateIntegrationLaneForProposalResult>;
        startIntegrationResolution(
          args: StartIntegrationResolutionArgs,
        ): Promise<StartIntegrationResolutionResult>;
        recheckIntegrationStep(
          args: RecheckIntegrationStepArgs,
        ): Promise<RecheckIntegrationStepResult>;
        getIntegrationResolutionState(
          proposalId: string,
        ): Promise<IntegrationResolutionState | null>;
        aiResolutionStart(
          args: PrAiResolutionStartArgs,
        ): Promise<PrAiResolutionStartResult>;
        aiResolutionGetSession(
          args: PrAiResolutionGetSessionArgs,
        ): Promise<PrAiResolutionGetSessionResult>;
        aiResolutionInput(args: PrAiResolutionInputArgs): Promise<void>;
        aiResolutionStop(args: PrAiResolutionStopArgs): Promise<void>;
        onAiResolutionEvent: (
          cb: (ev: PrAiResolutionEventPayload) => void,
        ) => () => void;
        getHealth: (prId: string) => Promise<PrHealth>;
        getConflictAnalysis: (prId: string) => Promise<PrConflictAnalysis | null>;
        getMergeContext: (prId: string) => Promise<PrMergeContext>;
        getMergeContexts: (
          prIds: string[],
        ) => Promise<Record<string, PrMergeContext>>;
        listWithConflicts: (args?: {
          includeConflictAnalysis?: boolean;
        }) => Promise<PrWithConflicts[]>;
        listSnapshots: (args?: {
          prId?: string;
        }) => Promise<PrSnapshotHydration[]>;
        getGitHubSnapshot: (args?: {
          force?: boolean;
          includeExternalClosed?: boolean;
          historyPageLimit?: number;
        }) => Promise<GitHubPrSnapshot>;
        listGitHubStacks: (
          args?: ListGitHubPrStacksArgs,
        ) => Promise<GitHubPrStack[]>;
        syncGitHubStacks: (
          args?: ListGitHubPrStacksArgs,
        ) => Promise<GitHubPrStack[]>;
        createGitHubStack: (
          args: CreateGitHubPrStackArgs,
        ) => Promise<GitHubPrStack>;
        addGitHubStackPullRequests: (
          args: AddGitHubPrStackPullRequestsArgs,
        ) => Promise<GitHubPrStack>;
        unstackGitHubStack: (
          args: UnstackGitHubPrStackArgs,
        ) => Promise<GitHubPrStack | null>;
        listIntegrationWorkflows: (
          args?: ListIntegrationWorkflowsArgs,
        ) => Promise<IntegrationProposal[]>;
        onEvent: (
          cb: (ev: PrEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
        getDetail: (prId: string) => Promise<PrDetail>;
        getFiles: (prId: string) => Promise<PrFile[]>;
        getCommits: (prId: string) => Promise<PrCommit[]>;
        getActionRuns: (prId: string) => Promise<PrActionRun[]>;
        getActivity: (prId: string) => Promise<PrActivityEvent[]>;
        getWorkflowGraph: (
          args: GetPrWorkflowGraphArgs,
        ) => Promise<PrWorkflowGraph>;
        getCheckLog: (args: GetPrCheckLogArgs) => Promise<PrCheckLogExcerpt>;
        getDetailByGithub: (coords: PrGithubCoords) => Promise<PrDetail>;
        getFilesByGithub: (coords: PrGithubCoords) => Promise<PrFile[]>;
        getCommitsByGithub: (coords: PrGithubCoords) => Promise<PrCommit[]>;
        getActionRunsByGithub: (
          coords: PrGithubCoords,
        ) => Promise<PrActionRun[]>;
        getActivityByGithub: (
          coords: PrGithubCoords,
        ) => Promise<PrActivityEvent[]>;
        getStatusByGithub: (coords: PrGithubCoords) => Promise<PrStatus | null>;
        getChecksByGithub: (coords: PrGithubCoords) => Promise<PrCheck[]>;
        getReviewsByGithub: (coords: PrGithubCoords) => Promise<PrReview[]>;
        getCommentsByGithub: (coords: PrGithubCoords) => Promise<PrComment[]>;
        getReviewThreadsByGithub: (
          coords: PrGithubCoords,
        ) => Promise<PrReviewThread[]>;
        addComment: (args: AddPrCommentArgs) => Promise<PrComment>;
        updateComment: (args: UpdatePrCommentArgs) => Promise<PrComment>;
        replyToReviewThread: (
          args: ReplyToPrReviewThreadArgs,
        ) => Promise<PrReviewThreadComment>;
        resolveReviewThread: (args: ResolvePrReviewThreadArgs) => Promise<void>;
        updateTitle: (args: UpdatePrTitleArgs) => Promise<void>;
        updateBody: (args: UpdatePrBodyArgs) => Promise<void>;
        setLabels: (args: SetPrLabelsArgs) => Promise<void>;
        requestReviewers: (args: RequestPrReviewersArgs) => Promise<void>;
        submitReview: (
          args: SubmitPrReviewArgs,
        ) => Promise<SubmitPrReviewResult>;
        close: (args: ClosePrArgs) => Promise<void>;
        reopen: (args: ReopenPrArgs) => Promise<void>;
        rerunChecks: (args: RerunPrChecksArgs) => Promise<void>;
        aiReviewSummary: (
          args: AiReviewSummaryArgs,
        ) => Promise<AiReviewSummary>;
        dismissIntegrationCleanup: (
          args: DismissIntegrationCleanupArgs,
        ) => Promise<IntegrationProposal>;
        cleanupIntegrationWorkflow: (
          args: CleanupIntegrationWorkflowArgs,
        ) => Promise<CleanupIntegrationWorkflowResult>;
        getDeployments: (prId: string) => Promise<PrDeployment[]>;
        getAiSummary: (prId: string) => Promise<PrAiSummary | null>;
        regenerateAiSummary: (prId: string) => Promise<PrAiSummary>;
        postReviewComment: (
          args: PostPrReviewCommentArgs,
        ) => Promise<PrReviewThreadComment>;
        setReviewThreadResolved: (
          args: SetPrReviewThreadResolvedArgs,
        ) => Promise<SetPrReviewThreadResolvedResult>;
        reactToComment: (args: ReactToPrCommentArgs) => Promise<void>;
        cleanupBranch: (
          args: CleanupPrBranchArgs,
        ) => Promise<CleanupPrBranchResult>;
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
        listOperations: (
          args?: ListOperationsArgs,
        ) => Promise<OperationRecord[]>;
        exportOperations: (
          args: ExportHistoryArgs,
        ) => Promise<ExportHistoryResult>;
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
      tests: {
        listSuites: () => Promise<TestSuiteDefinition[]>;
        run: (args: RunTestSuiteArgs) => Promise<TestRunSummary>;
        stop: (args: StopTestRunArgs) => Promise<void>;
        listRuns: (args?: ListTestRunsArgs) => Promise<TestRunSummary[]>;
        getLogTail: (args: GetTestLogTailArgs) => Promise<string>;
        onEvent: (cb: (ev: TestEvent) => void) => () => void;
      };
      projectConfig: {
        get: (pin?: OpenProjectBinding | null) => Promise<ProjectConfigSnapshot>;
        validate: (
          candidate: ProjectConfigCandidate,
        ) => Promise<ProjectConfigValidationResult>;
        save: (
          candidate: ProjectConfigCandidate,
        ) => Promise<ProjectConfigSnapshot>;
        diffAgainstDisk: () => Promise<ProjectConfigDiff>;
        confirmTrust: (arg?: {
          sharedHash?: string;
        }) => Promise<ProjectConfigTrust>;
      };
      zoom: {
        getLevel: () => number;
        setLevel: (level: number) => void;
        getFactor: () => number;
        setTitleBarOverlay: (arg: {
          theme?: "dark" | "light";
          zoomFactor?: number;
        }) => Promise<{ applied: boolean }>;
        onCommand: (cb: (command: AppZoomCommand) => void) => () => void;
      };
      cto?: {
        getState: (args?: CtoGetStateArgs) => Promise<CtoSnapshot>;
        ensureSession: (
          args?: CtoEnsureSessionArgs,
        ) => Promise<AgentChatSession>;
        listSessionLogs: (
          args?: CtoListSessionLogsArgs,
        ) => Promise<CtoSessionLogEntry[]>;
        updateIdentity: (args: CtoUpdateIdentityArgs) => Promise<CtoSnapshot>;
        getMemory: () => Promise<CtoMemorySnapshot>;
        updateMemory: (args: CtoUpdateMemoryArgs) => Promise<CtoMemorySnapshot>;
        searchMemory: (args: CtoSearchMemoryArgs) => Promise<CtoSearchMemoryResult>;
        getLinearConnectionStatus: () => Promise<LinearConnectionStatus>;
        setLinearToken: (
          args: CtoSetLinearTokenArgs,
        ) => Promise<LinearConnectionStatus>;
        clearLinearToken: () => Promise<LinearConnectionStatus>;
        getOnboardingState: () => Promise<CtoOnboardingState>;
        completeOnboardingStep: (args: {
          stepId: string;
        }) => Promise<CtoOnboardingState>;
        dismissOnboarding: () => Promise<CtoOnboardingState>;
        resetOnboarding: () => Promise<CtoOnboardingState>;
        previewSystemPrompt: (args?: {
          identityOverride?: Record<string, unknown>;
        }) => Promise<CtoSystemPromptPreview>;
        getLinearProjects: () => Promise<CtoLinearProject[]>;
        getLinearQuickView: () => Promise<CtoLinearQuickView>;
        getLinearIssuePickerData: () => Promise<CtoGetLinearIssuePickerDataResult>;
        searchLinearIssues: (
          args?: CtoSearchLinearIssuesArgs,
        ) => Promise<CtoSearchLinearIssuesResult>;
        getLinearIssueComments: (
          args: { issueId: string },
        ) => Promise<CtoLinearIssueComment[]>;
        setLinearOAuthClient: (
          args: CtoSetLinearOAuthClientArgs,
        ) => Promise<LinearConnectionStatus>;
        clearLinearOAuthClient: () => Promise<LinearConnectionStatus>;
        startLinearOAuth: () => Promise<CtoStartLinearOAuthResult>;
        getLinearOAuthSession: (
          args: CtoGetLinearOAuthSessionArgs,
        ) => Promise<CtoGetLinearOAuthSessionResult>;
        runProjectScan: () => Promise<CtoRunProjectScanResult>;
        getAttention: () => Promise<CtoAttentionState>;
      };
      keepAwakeGet: () => Promise<KeepAwakeSnapshot>;
      keepAwakeSetLevel: (level: KeepAwakeLevel) => Promise<KeepAwakeSnapshot>;
      keepAwakeFixSystemSleep: () => Promise<KeepAwakeFixResult>;
      updateCheckForUpdates: () => Promise<void>;
      updateGetState: () => Promise<AutoUpdateSnapshot>;
      updateGetPreferences: () => Promise<AutoUpdatePreferences>;
      updateSetPreferences: (preferences: AutoUpdatePreferences) => Promise<AutoUpdatePreferences>;
      updateGetInstallImpact: () => Promise<UpdateInstallImpact>;
      updateQuitAndInstall: () => Promise<boolean>;
      updateCancelAutoApply: () => Promise<boolean>;
      updateDismissInstalledNotice: () => Promise<void>;
      onUpdateEvent: (cb: (snapshot: AutoUpdateSnapshot) => void) => () => void;
      perf: {
        getConfig: () => Promise<{
          active: boolean;
          runId: string | null;
          scenario: string | null;
          initialRoute: string | null;
          projectRoot: string | null;
          allowClaude: boolean;
          modelOverride: string | null;
        }>;
        recordEvent: (event: {
          kind: string;
          ts?: number;
          [key: string]: unknown;
        }) => Promise<{ ok: boolean; reason?: string }>;
        scenarioComplete: (args: {
          scenario: string;
          ok: boolean;
          smokeFailures?: string[];
        }) => Promise<{ ok: boolean; reason?: string }>;
        finalize: () => Promise<{ ok: boolean; reason?: string; summary?: unknown }>;
      };
    };
  }
}
