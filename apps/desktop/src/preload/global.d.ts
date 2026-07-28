import type { SmartLinkPreview } from "../shared/smartLinks";
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
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  UnregisteredLaneCandidate,
  AppInfo,
  LocalRuntimeStatus,
  AppWelcomeVideoState,
  AppResourceUsageSnapshot,
  LatestReleaseInfo,
  AppNavigationRequest,
  AppZoomCommand,
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
  GetLaneConflictStatusArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetFilePatchArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentTool,
  AgentChatApproveArgs,
  AgentChatArchiveArgs,
  AgentChatCodexClearGoalArgs,
  AgentChatCodexGetGoalArgs,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
  AgentChatCreateArgs,
  AgentChatLaunchArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatDeleteArgs,
  AgentChatSuggestLaneNameArgs,
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
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
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
  CtoSetLinearOAuthClientArgs,
  CtoStartLinearOAuthResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoRunProjectScanResult,
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingHelpState,
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
  GitHubStatus,
  AdeAccountStatus,
  AdeAccountLoginStart,
  AdeAccountLoginPoll,
  AdeAccountLocalMachineIdentity,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
  AdeAccountMachinePairResult,
  AdeAccountPairMachineProgress,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
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
  ReorderQueuePrsArgs,
  QueueLandingState,
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
  LandPrArgs,
  LandResult,
  UpdateBranchArgs,
  UpdateBranchResult,
  LandStackArgs,
  LandStackEnhancedArgs,
  LinkPrToLaneArgs,
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
  PrDeployment,
  PrAiSummary,
  PostPrReviewCommentArgs,
  SetPrReviewThreadResolvedArgs,
  SetPrReviewThreadResolvedResult,
  ReactToPrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
  ResumeQueueAutomationArgs,
  StartQueueAutomationArgs,
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
import type { ProjectRecoveryDiagnosis, ProjectRepairReport } from "../shared/types/recovery";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
  ProductAnalyticsStatus,
} from "../shared/types/productAnalytics";

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
        ping: () => Promise<"pong">;
        setDockBadgeCount: (count: number) => Promise<{ ok: true }>;
        getInfo: () => Promise<AppInfo>;
        onRuntimeStatusChanged: (
          cb: (status: LocalRuntimeStatus) => void,
        ) => () => void;
        getResourceUsage: () => Promise<AppResourceUsageSnapshot>;
        getRuntimeHealth: () => Promise<RuntimeHealthSnapshot>;
        getLatestRelease: () => Promise<LatestReleaseInfo | null>;
        getProject: () => Promise<ProjectInfo | null>;
        getWindowSession: () => Promise<{
          windowId: number | null;
          project: ProjectInfo | null;
          binding: OpenProjectBinding | null;
          openProjectTabs: ProjectInfo[];
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
          target: "default" | "finder" | "vscode" | "cursor" | "zed";
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
      recovery: {
        diagnose: (projectRoot: string) => Promise<ProjectRecoveryDiagnosis>;
        repair: (projectRoot: string) => Promise<ProjectRepairReport>;
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
        }) => Promise<AiSettingsStatus>;
        getOpenCodeRuntimeDiagnostics: () => Promise<OpenCodeRuntimeSnapshot>;
        isOpenCodeInstalled: () => Promise<{ installed: boolean; source: "user-installed" | "bundled" | "missing" }>;
        storeApiKey: (provider: string, key: string) => Promise<void>;
        deleteApiKey: (provider: string) => Promise<void>;
        listApiKeys: () => Promise<string[]>;
        verifyApiKey: (provider: string) => Promise<AiApiKeyVerificationResult>;
        updateConfig: (config: Partial<AiConfig>) => Promise<void>;
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
        cursorCloudArchiveAgent: (agentId: string) => Promise<void>;
        cursorCloudUnarchiveAgent: (agentId: string) => Promise<void>;
        cursorCloudDeleteAgent: (agentId: string) => Promise<void>;
        cursorCloudGetAgent: (
          agentId: string,
        ) => Promise<CursorCloudAgentSummary | null>;
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
      };
      transcription: {
        transcribe: (
          pcm: ArrayBuffer,
          options?: { sampleRate?: number; format?: "int16" | "float32" },
        ) => Promise<{ raw: string; cleaned: string }>;
        status: () => Promise<{
          installed: boolean;
          binaryInstalled: boolean;
          modelInstalled: boolean;
          downloading: boolean;
          binaryPath: string | null;
          modelPath: string | null;
        }>;
        downloadModel: () => Promise<{
          installed: boolean;
          binaryInstalled: boolean;
          modelInstalled: boolean;
          downloading: boolean;
          binaryPath: string | null;
          modelPath: string | null;
        }>;
        onModelDownloadProgress: (
          handler: (progress: { receivedBytes: number; totalBytes: number | null }) => void,
        ) => () => void;
        requestMicAccess: () => Promise<{
          status: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
        }>;
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
        detectExistingLanes: () => Promise<OnboardingExistingLaneCandidate[]>;
        setDismissed: (dismissed: boolean) => Promise<OnboardingStatus>;
        complete: () => Promise<OnboardingStatus>;
        markGlossaryTermSeen: (
          termId: string,
        ) => Promise<OnboardingHelpState>;
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
        acknowledge: (args: {
          itemIds: string[];
          seenAt?: string;
          dismissedAt?: string | null;
        }) => Promise<void>;
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
        openItem: (
          item: import("../shared/types").AttentionItem,
        ) => Promise<void>;
      };
      attentionNotch: {
        publishSnapshot: (
          snapshot: import("../shared/types").AttentionSnapshot,
        ) => Promise<void>;
        updateSettings: (
          settings: import("../shared/types").AttentionNotchSettings,
        ) => Promise<void>;
        onAcknowledgeRequested: (
          cb: (
            request: import("../shared/types").AttentionNotchAcknowledgeRequest,
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
        createChild: (args: CreateChildLaneArgs) => Promise<LaneSummary>;
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
        attach: (args: AttachLaneArgs) => Promise<LaneSummary>;
        listUnregisteredWorktrees: () => Promise<UnregisteredLaneCandidate[]>;
        adoptAttached: (args: AdoptAttachedLaneArgs) => Promise<LaneSummary>;
        rename: (args: RenameLaneArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        reparent: (args: ReparentLaneArgs) => Promise<ReparentLaneResult>;
        updateAppearance: (args: UpdateLaneAppearanceArgs) => Promise<void>;
        archive: (args: ArchiveLaneArgs) => Promise<void>;
        delete: (args: DeleteLaneArgs, pin?: OpenProjectBinding | null) => Promise<void>;
        cancelDelete: (args: {
          laneId: string;
        }) => Promise<{ cancelled: boolean; reason?: string }>;
        listDeleteProgress: () => Promise<LaneDeleteProgress[]>;
        getDeleteRisk: (args: { laneId: string }) => Promise<LaneDeleteRisk>;
        onDeleteEvent: (cb: (ev: LaneDeleteEvent) => void) => () => void;
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
        getDelta: (sessionId: string) => Promise<SessionDeltaSummary | null>;
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
        parallelLaunchState: {
          get: (
            args: AgentChatParallelLaunchStateArgs,
          ) => Promise<AgentChatParallelLaunchState | null>;
          set: (args: AgentChatSetParallelLaunchStateArgs) => Promise<void>;
        };
        handoff: (
          args: AgentChatHandoffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatHandoffResult>;
        prepareCrossMachineHandoff: (
          args: AgentChatPrepareCrossMachineHandoffArgs,
        ) => Promise<AgentChatPrepareCrossMachineHandoffResult>;
        validateCrossMachineSource: (
          args: AgentChatValidateCrossMachineSourceArgs,
        ) => Promise<void>;
        markCrossMachineHandoff: (
          args: AgentChatMarkCrossMachineHandoffArgs,
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
        models: (args: AgentChatModelsArgs) => Promise<AgentChatModelInfo[]>;
        modelCatalog: (args?: AgentChatModelCatalogArgs) => Promise<AgentChatModelCatalog>;
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
        promptStashes: {
          list: () => Promise<PromptStashEntry[]>;
          create: (args: PromptStashCreateArgs) => Promise<PromptStashEntry>;
          delete: (args: PromptStashDeleteArgs) => Promise<boolean>;
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
        };
      };
      computerUse: {
        listArtifacts: (
          args?: ComputerUseArtifactListArgs,
        ) => Promise<ComputerUseArtifactView[]>;
        getOwnerSnapshot: (
          args: ComputerUseOwnerSnapshotArgs,
        ) => Promise<ComputerUseOwnerSnapshot>;
        routeArtifact: (
          args: ComputerUseArtifactRouteArgs,
        ) => Promise<ComputerUseArtifactView>;
        updateArtifactReview: (
          args: ComputerUseArtifactReviewArgs,
        ) => Promise<ComputerUseArtifactView>;
        readArtifactPreview: (args: { uri: string }) => Promise<string | null>;
        onEvent: (cb: (ev: ComputerUseEventPayload) => void) => () => void;
      };
      iosSimulator: {
        getStatus: () => Promise<IosSimulatorStatus>;
        listDevices: () => Promise<IosSimulatorDevice[]>;
        listLaunchTargets: (
          args?: IosSimulatorListLaunchTargetsArgs,
        ) => Promise<IosSimulatorLaunchTarget[]>;
        launch: (args?: IosSimulatorLaunchArgs) => Promise<IosSimulatorSession>;
        attachToChatSession: (args: {
          chatSessionId: string | null;
          callerChatSessionId?: string | null;
        }) => Promise<IosSimulatorSession | null>;
        shutdown: (
          args?: IosSimulatorShutdownArgs,
        ) => Promise<IosSimulatorShutdownResult>;
        screenshot: (args?: {
          deviceUdid?: string | null;
        }) => Promise<IosSimulatorScreenshot>;
        getScreenSnapshot: (
          args?: IosScreenSnapshotArgs,
        ) => Promise<IosScreenSnapshot>;
        getInspectorSnapshot: (args?: {
          deviceUdid?: string | null;
        }) => Promise<IosInspectorSnapshot | null>;
        inspectPoint: (
          args: IosSimulatorInspectPointArgs,
        ) => Promise<IosSimulatorInspectResult>;
        getPreviewCapability: (
          args?: IosSimulatorListPreviewsArgs,
        ) => Promise<IosSimulatorPreviewCapability>;
        listPreviewTargets: (
          args?: IosSimulatorListPreviewsArgs,
        ) => Promise<IosSimulatorPreviewTarget[]>;
        resolvePreviewMatch: (
          args?: IosSimulatorListPreviewsArgs,
        ) => Promise<IosSimulatorPreviewMatch>;
        ensurePreviewWorkspace: (
          args?: IosSimulatorEnsurePreviewWorkspaceArgs,
        ) => Promise<IosSimulatorEnsurePreviewWorkspaceResult>;
        renderCurrentPreview: (
          args?: IosSimulatorRenderCurrentPreviewArgs,
        ) => Promise<IosSimulatorRenderCurrentPreviewResult>;
        renderPreview: (
          args: IosSimulatorRenderPreviewArgs,
        ) => Promise<IosSimulatorRenderPreviewResult>;
        openPreviewWorkspace: (
          args?: IosSimulatorOpenPreviewWorkspaceArgs,
        ) => Promise<{ ok: true; path: string }>;
        startStream: (
          args?: IosSimulatorStartStreamArgs,
        ) => Promise<IosSimulatorStreamStatus>;
        stopStream: () => Promise<IosSimulatorStreamStatus>;
        getStreamStatus: () => Promise<IosSimulatorStreamStatus>;
        getSimulatorWindowState: () => Promise<IosSimulatorWindowState>;
        listSimulatorWindowSources: () => Promise<IosSimulatorWindowSource[]>;
        tap: (args: {
          deviceUdid?: string | null;
          projectRoot?: string | null;
          x: number;
          y: number;
        }) => Promise<{ ok: true }>;
        typeText: (args: {
          deviceUdid?: string | null;
          projectRoot?: string | null;
          text: string;
        }) => Promise<{ ok: true }>;
        drag: (args: IosSimulatorDragArgs) => Promise<{ ok: true }>;
        swipe: (args: IosSimulatorDragArgs) => Promise<{ ok: true }>;
        selectPoint: (args: {
          deviceUdid?: string | null;
          projectRoot?: string | null;
          x: number;
          y: number;
        }) => Promise<IosSimulatorSelectResult>;
        onEvent: (cb: (ev: IosSimulatorEventPayload) => void) => () => void;
      };
      appControl: {
        getStatus: () => Promise<AppControlStatus>;
        launch: (args?: AppControlLaunchArgs) => Promise<AppControlSession>;
        launchInTerminal: (
          args?: AppControlLaunchArgs,
        ) => Promise<AppControlSession>;
        connect: (args: AppControlConnectArgs) => Promise<AppControlSession>;
        stop: (
          args?: AppControlStopArgs,
        ) => Promise<{ ok: true; previousSession: AppControlSession | null }>;
        focusWindow: () => Promise<{ ok: true }>;
        minimizeWindow: () => Promise<{ ok: true }>;
        screenshot: () => Promise<AppControlScreenshot>;
        getSnapshot: (
          args?: AppControlSnapshotArgs,
        ) => Promise<AppControlSnapshot>;
        inspectPoint: (
          args: AppControlInspectPointArgs,
        ) => Promise<AppControlInspectResult>;
        selectPoint: (
          args: AppControlInspectPointArgs,
        ) => Promise<AppControlSelectResult>;
        click: (args: AppControlClickArgs) => Promise<{ ok: true }>;
        typeText: (args: AppControlTypeTextArgs) => Promise<{ ok: true }>;
        scroll: (args: {
          x: number;
          y: number;
          deltaX: number;
          deltaY: number;
          scale?: number | null;
          coordinateSpace?: "screenshot" | "viewport" | null;
        }) => Promise<{ ok: true }>;
        dispatchKey: (args: {
          type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
          key?: string | null;
          code?: string | null;
          text?: string | null;
          modifiers?: number | null;
        }) => Promise<{ ok: true }>;
        listTargets: () => Promise<AppControlTarget[]>;
        attachToTarget: (args: {
          targetId: string;
        }) => Promise<AppControlSession>;
        onEvent: (cb: (ev: AppControlEventPayload) => void) => () => void;
      };
      builtInBrowser: {
        getStatus: (args?: BuiltInBrowserProjectScopeArgs) => Promise<BuiltInBrowserStatus>;
        requestOriginAccess: (
          args?: BuiltInBrowserRequestOriginAccessArgs,
        ) => Promise<BuiltInBrowserOriginAccessResult>;
        getProfileDiagnostics: () => Promise<BuiltInBrowserProfileDiagnostics>;
        listPermissions: () => Promise<BuiltInBrowserPermissionsResult>;
        clearPermissions: (
          args?: BuiltInBrowserClearPermissionsArgs,
        ) => Promise<BuiltInBrowserClearPermissionsResult>;
        showPanel: (
          args?: BuiltInBrowserOpenPanelArgs,
        ) => Promise<BuiltInBrowserStatus>;
        setBounds: (
          args: BuiltInBrowserBoundsArgs,
        ) => Promise<BuiltInBrowserStatus>;
        attachWebview: (
          args: BuiltInBrowserAttachWebviewArgs,
        ) => Promise<BuiltInBrowserStatus>;
        navigate: (
          args: BuiltInBrowserNavigateArgs,
        ) => Promise<BuiltInBrowserStatus>;
        createTab: (
          args?: BuiltInBrowserCreateTabArgs,
        ) => Promise<BuiltInBrowserStatus>;
        switchTab: (
          args: BuiltInBrowserTabArgs,
        ) => Promise<BuiltInBrowserStatus>;
        closeTab: (
          args: BuiltInBrowserTabArgs,
        ) => Promise<BuiltInBrowserStatus>;
        reload: (args?: BuiltInBrowserTabTargetArgs) => Promise<BuiltInBrowserStatus>;
        goBack: (args?: BuiltInBrowserTabTargetArgs) => Promise<BuiltInBrowserStatus>;
        goForward: (args?: BuiltInBrowserTabTargetArgs) => Promise<BuiltInBrowserStatus>;
        stop: (args?: BuiltInBrowserTabTargetArgs) => Promise<BuiltInBrowserStatus>;
        startInspect: (args?: BuiltInBrowserProjectScopeArgs) => Promise<BuiltInBrowserStatus>;
        stopInspect: (args?: BuiltInBrowserProjectScopeArgs) => Promise<BuiltInBrowserStatus>;
        captureScreenshot: (
          args?: BuiltInBrowserTabTargetArgs,
        ) => Promise<BuiltInBrowserScreenshot>;
        selectPoint: (
          args: BuiltInBrowserSelectPointArgs,
        ) => Promise<BuiltInBrowserSelectResult>;
        selectCurrent: (args?: BuiltInBrowserProjectScopeArgs) => Promise<BuiltInBrowserSelectResult>;
        clearSelection: (args?: BuiltInBrowserProjectScopeArgs) => Promise<{ ok: true }>;
        onEvent: (cb: (ev: BuiltInBrowserEventPayload) => void) => () => void;
      };
      terminal: {
        list: (args?: ChatTerminalListArgs) => Promise<ChatTerminalSession[]>;
        read: (args?: ChatTerminalReadArgs) => Promise<ChatTerminalReadResult>;
        preview: (
          args?: ChatTerminalPreviewArgs,
        ) => Promise<ChatTerminalPreviewResult>;
        write: (args: ChatTerminalWriteArgs) => Promise<{ ok: true }>;
        signal: (args: ChatTerminalSignalArgs) => Promise<{ ok: true }>;
        activeForChat: (
          args: ChatTerminalActiveForChatArgs,
        ) => Promise<ChatTerminalSession | null>;
        reattachChatCli: (
          args: ChatTerminalReattachArgs,
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
        list: (args?: ExternalSessionListArgs) => Promise<ExternalSessionSummary[]>;
        import: (args: ExternalSessionImportArgs) => Promise<ExternalSessionImportResult>;
      };
      pty: {
        create: (args: PtyCreateArgs, pin?: OpenProjectBinding | null) => Promise<PtyCreateResult>;
        resumeSession: (
          args: PtyResumeSessionArgs,
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
        setDataSubscriptions: (args: { ptyIds: string[] }) => Promise<void>;
        onData: (cb: (ev: PtyDataEvent) => void) => () => void;
        onExit: (cb: (ev: PtyExitEvent) => void) => () => void;
      };
      diff: {
        getChanges: (args: GetDiffChangesArgs) => Promise<DiffChanges>;
        getFile: (args: GetFileDiffArgs) => Promise<FileDiff>;
        getFilePatch: (args: GetFilePatchArgs) => Promise<FilePatch>;
      };
      files: {
        writeTextAtomic: (args: WriteTextAtomicArgs) => Promise<void>;
        listWorkspaces: (
          args?: FilesListWorkspacesArgs,
        ) => Promise<FilesWorkspace[]>;
        listTree: (args: FilesListTreeArgs) => Promise<FileTreeNode[]>;
        listTreeChildren: (
          args: FilesListTreeChildrenArgs,
        ) => Promise<FilesListTreeChildrenResult>;
        refreshGitDecorations: (
          args: FilesRefreshGitDecorationsArgs,
        ) => Promise<FilesGitStatusEvent>;
        openExternalPath: (
          args: FilesOpenExternalPathArgs,
        ) => Promise<FilesOpenExternalPathResult>;
        readFile: (args: FilesReadFileArgs) => Promise<FileContent>;
        readFileRange: (
          args: FilesReadFileRangeArgs,
        ) => Promise<FilesReadFileRangeResult>;
        gitBlame: (args: FilesGitBlameArgs) => Promise<FilesGitBlameResult>;
        writeText: (args: FilesWriteTextArgs) => Promise<void>;
        createFile: (args: FilesCreateFileArgs) => Promise<void>;
        createDirectory: (args: FilesCreateDirectoryArgs) => Promise<void>;
        rename: (args: FilesRenameArgs) => Promise<void>;
        delete: (args: FilesDeleteArgs) => Promise<void>;
        watchChanges: (args: FilesWatchArgs) => Promise<void>;
        stopWatching: (args: FilesWatchArgs) => Promise<void>;
        quickOpen: (args: FilesQuickOpenArgs) => Promise<FilesQuickOpenItem[]>;
        searchText: (
          args: FilesSearchTextArgs,
        ) => Promise<FilesSearchTextMatch[]>;
        onChange: (cb: (ev: FileChangeEvent) => void) => () => void;
      };
      git: {
        stageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        stageAll: (args: GitBatchFileActionArgs) => Promise<GitActionResult>;
        unstageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        unstageAll: (args: GitBatchFileActionArgs) => Promise<GitActionResult>;
        discardFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        restoreStagedFile: (
          args: GitFileActionArgs,
        ) => Promise<GitActionResult>;
        commit: (args: GitCommitArgs) => Promise<GitActionResult>;
        generateCommitMessage: (
          args: GitGenerateCommitMessageArgs,
        ) => Promise<GitGenerateCommitMessageResult>;
        listRecentCommits: (args: {
          laneId: string;
          limit?: number;
        }) => Promise<GitCommitSummary[]>;
        listCommitFiles: (args: GitListCommitFilesArgs) => Promise<string[]>;
        getCommitMessage: (args: GitGetCommitMessageArgs) => Promise<string>;
        getCommit: (args: {
          laneId: string;
          commitSha: string;
        }) => Promise<GitCommitSummary | null>;
        isCommitInLaneHistory: (args: {
          laneId: string;
          commitSha: string;
        }) => Promise<boolean>;
        revertCommit: (args: GitRevertArgs) => Promise<GitActionResult>;
        cherryPickCommit: (args: GitCherryPickArgs) => Promise<GitActionResult>;
        createTag: (args: GitCreateTagArgs) => Promise<GitActionResult>;
        resetToCommit: (args: GitResetCommitArgs) => Promise<GitActionResult>;
        stashPush: (args: GitStashPushArgs) => Promise<GitActionResult>;
        stashList: (args: { laneId: string }) => Promise<GitStashSummary[]>;
        stashApply: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashPop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashDrop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashClear: (args: { laneId: string }) => Promise<GitActionResult>;
        fetch: (args: { laneId: string }, pin?: OpenProjectBinding | null) => Promise<GitActionResult>;
        pull: (args: GitPullArgs) => Promise<GitActionResult>;
        undoLastHeadChange: (args: GitHeadChangeActionArgs) => Promise<GitActionResult>;
        redoLastHeadChange: (args: GitHeadChangeActionArgs) => Promise<GitActionResult>;
        getSyncStatus: (args: {
          laneId: string;
        }) => Promise<GitUpstreamSyncStatus>;
        getOriginRemote: (args: {
          laneId: string;
        }) => Promise<{ remoteUrl: string | null; branch: string | null }>;
        getOpenPrForBranch: (args: {
          laneId: string;
          branch?: string;
        }) => Promise<{
          prUrl: string | null;
          prNumber: number | null;
          title: string | null;
          headRefName: string | null;
        }>;
        sync: (args: GitSyncArgs) => Promise<GitActionResult>;
        push: (args: GitPushArgs) => Promise<GitActionResult>;
        getConflictState: (laneId: string) => Promise<GitConflictState>;
        rebaseContinue: (args: string | { laneId: string }) => Promise<GitActionResult>;
        rebaseAbort: (args: string | { laneId: string }) => Promise<GitActionResult>;
        mergeContinue: (args: string | { laneId: string }) => Promise<GitActionResult>;
        mergeAbort: (args: string | { laneId: string }) => Promise<GitActionResult>;
        listBranches: (
          args: GitListBranchesArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<GitBranchSummary[]>;
        getUserIdentity: (
          args: GitGetUserIdentityArgs,
        ) => Promise<GitUserIdentity>;
        checkoutBranch: (
          args: GitCheckoutBranchArgs,
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
        setToken: (token: string) => Promise<GitHubStatus>;
        clearToken: () => Promise<GitHubStatus>;
        getAppUserAuthStatus: () => Promise<GitHubAppUserAuthStatus>;
        startAppUserDeviceAuth: () => Promise<GitHubAppDeviceAuthStartResult>;
        pollAppUserDeviceAuth: (args: {
          sessionId: string;
        }) => Promise<GitHubAppDeviceAuthPollResult>;
        clearAppUserAuth: () => Promise<GitHubAppUserAuthStatus>;
        detectRepo: () => Promise<{ owner: string; name: string } | null>;
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
        signOut: () => Promise<AdeAccountStatus>;
        listMachines: () => Promise<AdeAccountMachinesResult>;
        getLocalMachineIdentity: () => Promise<AdeAccountLocalMachineIdentity>;
        pairMachine: (machineKey: string) => Promise<AdeAccountMachinePairResult>;
        onPairMachineProgress: (
          cb: (progress: AdeAccountPairMachineProgress) => void,
        ) => () => void;
        removeMachine: (machineKey: string) => Promise<AdeAccountMachineRemovalResult>;
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
        getForLane: (laneId: string) => Promise<PrSummary | null>;
        syncLanePr: (laneId: string) => Promise<PrSummary | null>;
        reconcileNow: () => Promise<void>;
        listAll: () => Promise<PrSummary[]>;
        listOpenForRepo: () => Promise<BranchPullRequest[]>;
        refresh: (args?: {
          prId?: string;
          prIds?: string[];
        }) => Promise<PrSummary[]>;
        getStatus: (prId: string) => Promise<PrStatus | null>;
        getChecks: (prId: string) => Promise<PrCheck[]>;
        getComments: (prId: string) => Promise<PrComment[]>;
        getReviews: (prId: string) => Promise<PrReview[]>;
        getReviewThreads: (prId: string) => Promise<PrReviewThread[]>;
        updateDescription: (args: UpdatePrDescriptionArgs) => Promise<void>;
        delete: (args: DeletePrArgs) => Promise<DeletePrResult>;
        draftDescription: (
          args: DraftPrDescriptionArgs,
        ) => Promise<{ title: string; body: string }>;
        land: (args: LandPrArgs) => Promise<LandResult>;
        updateBranch: (args: UpdateBranchArgs) => Promise<UpdateBranchResult>;
        landStack: (args: LandStackArgs) => Promise<LandResult[]>;
        retargetBase: (args: {
          prId: string;
          baseBranch: string;
        }) => Promise<void>;
        openInGitHub: (prId: string) => Promise<void>;
        createQueue: (
          args: CreateQueuePrsArgs,
        ) => Promise<CreateQueuePrsResult>;
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
        landStackEnhanced: (
          args: LandStackEnhancedArgs,
        ) => Promise<LandResult[]>;
        landQueueNext: (args: LandQueueNextArgs) => Promise<LandResult>;
        startQueueAutomation: (
          args: StartQueueAutomationArgs,
        ) => Promise<QueueLandingState>;
        pauseQueueAutomation: (
          queueId: string,
        ) => Promise<QueueLandingState | null>;
        resumeQueueAutomation: (
          args: ResumeQueueAutomationArgs,
        ) => Promise<QueueLandingState | null>;
        cancelQueueAutomation: (
          queueId: string,
        ) => Promise<QueueLandingState | null>;
        reorderQueuePrs: (args: ReorderQueuePrsArgs) => Promise<void>;
        getHealth: (prId: string) => Promise<PrHealth>;
        getQueueState: (groupId: string) => Promise<QueueLandingState | null>;
        listQueueStates: (args?: {
          includeCompleted?: boolean;
          limit?: number;
        }) => Promise<QueueLandingState[]>;
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
        listIntegrationWorkflows: (
          args?: ListIntegrationWorkflowsArgs,
        ) => Promise<IntegrationProposal[]>;
        onEvent: (cb: (ev: PrEventPayload) => void) => () => void;
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
        setLinearOAuthClient: (
          args: CtoSetLinearOAuthClientArgs,
        ) => Promise<LinearConnectionStatus>;
        clearLinearOAuthClient: () => Promise<LinearConnectionStatus>;
        startLinearOAuth: () => Promise<CtoStartLinearOAuthResult>;
        getLinearOAuthSession: (
          args: CtoGetLinearOAuthSessionArgs,
        ) => Promise<CtoGetLinearOAuthSessionResult>;
        runProjectScan: () => Promise<CtoRunProjectScanResult>;
      };
      updateCheckForUpdates: () => Promise<void>;
      updateGetState: () => Promise<AutoUpdateSnapshot>;
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
