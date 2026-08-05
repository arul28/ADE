import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { IPC } from "../shared/ipc";
import { isSyncServiceUnavailableError } from "../shared/runtimeErrors";
import { resolvePackageChannelFromProcess } from "../shared/packageChannel";
import { EXTERNAL_FILES_WORKSPACE_ID_PREFIX } from "../shared/types/files";
import {
  type AttentionItem,
  type AttentionNotchAcknowledgeRequest,
  type AttentionNotchSettings,
  type AttentionPreferenceScope,
  type AttentionPreferences,
  type AttentionPresence,
  type AttentionSnapshot,
} from "../shared/types/attention";
import { deriveSmartLinkPreview, type SmartLinkPreview } from "../shared/smartLinks";
import { sessionLifecycleApplied } from "../shared/sessionLifecycleResult";
import { createOrchestrationBridge } from "./orchestrationBridge";
import {
  createPinnedRuntimeEvents,
  isPinnedRuntimeEventStale,
  normalizePinnedRuntimeEventEpoch,
  rememberPinnedRuntimeEventId,
  REMOTE_RUNTIME_EVENT_ACTIVE_POLL_MS,
  REMOTE_RUNTIME_EVENT_CATCH_UP_POLL_MS,
  REMOTE_RUNTIME_EVENT_IDLE_POLL_MS,
} from "./pinnedRuntimeEvents";
import type { OrchestrationEventPayload } from "../shared/types/orchestration";
import type { ProjectRecoveryDiagnosis, ProjectRepairReport } from "../shared/types/recovery";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
  ProductAnalyticsStatus,
} from "../shared/types/productAnalytics";
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
} from "../shared/types";
import type {
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
  OpenCodeRuntimeSnapshot,
  SyncDesktopConnectionDraft,
  SyncCloudRelayStatus,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncStatusEventPayload,
  SyncTransferReadiness,
  DraftPrDescriptionArgs,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateIdentityArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  CtoMemorySnapshot,
  CtoUpdateMemoryArgs,
  CtoSearchMemoryArgs,
  CtoSearchMemoryResult,
  CtoOnboardingState,
  CtoSystemPromptPreview,
  CtoLinearIssueComment,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoGetLinearIssuePickerDataResult,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  CtoStartLinearOAuthResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoAttentionState,
  CtoRunProjectScanResult,
  LinearConnectionStatus,
  CtoSetLinearOAuthClientArgs,
  CtoSetLinearTokenArgs,
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
  LaneBranchDrift,
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
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubAutolink,
  GitHubRepoRef,
  GitHubSetTokenResult,
  GitHubStatus,
  AdeAccountStatus,
  AdeAccountLoginStart,
  AdeAccountLoginPoll,
  AdeAccountLocalMachineIdentity,
  AdeAccountMachine,
  AdeAccountMachineRemovalResult,
  AdeAccountMachinesResult,
  AdeAccountMachinePairResult,
  AdeAccountPairMachineProgress,
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
  PrWorkflowGraph,
  GetPrWorkflowGraphArgs,
  PrCheckLogExcerpt,
  GetPrCheckLogArgs,
  PrGithubCoords,
  CleanupPrBranchArgs,
  CleanupPrBranchResult,
  AddPrCommentArgs,
  UpdatePrCommentArgs,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
  PrDeployment,
  PrAiSummary,
  PostPrReviewCommentArgs,
  SetPrReviewThreadResolvedArgs,
  SetPrReviewThreadResolvedResult,
  ReactToPrCommentArgs,
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
  UpdateIntegrationProposalArgs,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  LandResult,
  UpdateBranchArgs,
  UpdateBranchResult,
  GetDiffChangesArgs,
  GetLaneConflictStatusArgs,
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
  AgentChatCodexGetGoalArgs,
  AgentChatCreateArgs,
  AgentChatLaunchArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
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
  AgentChatUpdateSessionArgs,
  KeybindingOverride,
  KeybindingsSnapshot,
  OnboardingDetectionResult,
  OnboardingHelpState,
  OnboardingStatus,
  LaneLinearIssue,
  LaneListSnapshot,
  LaneSummary,
  SessionLinearIssueLink,
  ListOverlapsArgs,
  ListLanesArgs,
  ImportBranchLaneArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  DeleteSessionArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
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
  AddGitHubPrStackPullRequestsArgs,
  CreateGitHubPrStackArgs,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  SimulateIntegrationArgs,
  IntegrationProposal,
  IntegrationResolutionState,
  ListGitHubPrStacksArgs,
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
  PrAiResolutionGetSessionArgs,
  PrAiResolutionGetSessionResult,
  PrAiResolutionInputArgs,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
  CommitIntegrationArgs,
  GitHubPrSnapshot,
  GitHubPrStack,
  UnstackGitHubPrStackArgs,
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
  LaneLifecycleEvent,
  LaneDeleteProgress,
  LaneDeleteRisk,
  LaneReclaimRisk,
  RestoreLaneResult,
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
  SessionLifecycleSettings,
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
  WriteTextAtomicArgs,
  AdeUsageStats,
  GetAdeUsageStatsArgs,
  UsageSnapshot,
  BudgetCheckResult,
  BudgetCheckArgs,
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapConfig,
  RuntimeDiagnosticsStatus,
  RuntimeDiagnosticsEvent,
  LaneHealthCheck,
  GetLaneHealthArgs,
  RunHealthCheckArgs,
  ActivateFallbackArgs,
  DeactivateFallbackArgs,
  ComputerUseArtifactListArgs,
  ComputerUseArtifactReviewArgs,
  ComputerUseArtifactBrokenRecord,
  ComputerUseArtifactDeleteArgs,
  ComputerUseArtifactDeleteResult,
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
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeDoctorResult,
  RemoteRuntimeEventCategory,
  RemoteRuntimeEventNotificationPayload,
  RemoteRuntimeLocalWorkCheckResult,
  RemoteRuntimeLocalPairingInfo,
  RemoteRuntimePairWithMachineArgs,
  RemoteRuntimePairWithMachineResult,
  RemoteRuntimeParsedPairingInput,
  RemoteRuntimePortForward,
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
const githubAppInstallationStatusCache = createKeyedShortIpcCache<GitHubAppInstallationStatus>(
  (key) => ipcRenderer.invoke(
    IPC.githubGetAppInstallationStatus,
    parseIpcCacheArgs<{ owner?: string; name?: string }>(key, {}),
  ),
  30_000,
  { maxEntries: 32 },
);

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

const builtInBrowserStatusCache = createKeyedShortIpcCache<BuiltInBrowserStatus>(
  (key) => {
    const args = parseIpcCacheArgs<BuiltInBrowserProjectScopeArgs>(key, {});
    return ipcRenderer.invoke(IPC.builtInBrowserGetStatus, args);
  },
  500,
);

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

let currentProjectBinding: OpenProjectBinding | null = null;
let projectBindingGeneration = 0;
let projectBindingVersion = 0;
let projectBindingRefreshPromise: Promise<OpenProjectBinding | null> | null = null;
let projectRuntimeTransitionDepth = 0;
let activeRemoteProjectOpenPromise: Promise<OpenProjectBinding> | null = null;
/**
 * Kind of the binding this window was attached to when the in-flight project
 * transition began. `currentProjectBinding` is deliberately nulled for the
 * duration of a transition, so during a switch it cannot answer "was I attached
 * to a remote runtime?". This value can — it is only ever consulted while a
 * transition is in flight (see `isRemoteProjectRuntimeContext`).
 *
 * It must be snapshotted at DETACH time (`detachProjectBindingForTransition`),
 * not merely left at the last non-null binding: a window that closed a remote
 * project and is now projectless would otherwise keep reporting "remote"
 * forever, and every later local transition (open repo, close) would answer
 * "runtime unreachable" for projectless chats the local service can legitimately
 * serve.
 */
let lastProjectRuntimeBindingKind: OpenProjectBinding["kind"] | null = null;
const projectBindingChangedCallbacks = new Set<
  (binding: OpenProjectBinding | null) => void
>();

function rememberProjectBinding(binding: OpenProjectBinding | null): void {
  const previousKey = currentProjectBinding?.key ?? null;
  const nextKey = binding?.key ?? null;
  projectBindingVersion += 1;
  currentProjectBinding = binding;
  if (binding) lastProjectRuntimeBindingKind = binding.kind;
  if (previousKey !== nextKey) {
    projectBindingGeneration += 1;
    resetRemoteRuntimeEventDedup(nextKey);
    clearPendingRemoteRuntimeEventPoll();
  }
  if (binding) {
    ensureRemoteRuntimeEventPump();
  }
}

/**
 * Detach the current binding at the start of a project transition.
 *
 * Records the kind we are LEAVING before nulling, so `isRemoteProjectRuntimeContext`
 * answers for this transition rather than for whatever project was bound last.
 * Detaching from nothing (a projectless/machine-tab window) clears the value:
 * there is no remote runtime to protect, so chat reads must fall through to the
 * local service.
 */
function detachProjectBindingForTransition(): void {
  lastProjectRuntimeBindingKind = currentProjectBinding?.kind ?? null;
  rememberProjectBinding(null);
}

function notifyProjectBindingChangedCallbacks(
  binding: OpenProjectBinding | null,
): void {
  rememberProjectBinding(binding);
  clearProjectScopedReadCaches();
  for (const callback of [...projectBindingChangedCallbacks]) {
    try {
      callback(binding);
    } catch (error) {
      console.warn(
        "[preload] project binding listener failed",
        error instanceof Error ? error.message : String(error),
      );
    }
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

/**
 * Synchronous, transition-safe answer to "is the project runtime this window
 * talks to a REMOTE one?".
 *
 * Unlike `getRemoteProjectBinding()` this never refreshes and never awaits, so
 * it stays valid inside the window where a project switch has intentionally
 * nulled `currentProjectBinding`. Three signals, in precedence order:
 *  1. A live binding answers for itself.
 *  2. A remote `openProject` in flight means we are switching TO a remote
 *     runtime (that path nulls the binding for the whole open).
 *  3. Otherwise, only while a transition is in flight, fall back to the kind of
 *     the binding we were attached to when the switch began.
 */
function isRemoteProjectRuntimeContext(): boolean {
  if (currentProjectBinding) return currentProjectBinding.kind === "remote";
  if (activeRemoteProjectOpenGeneration !== null) return true;
  return (
    projectRuntimeTransitionDepth > 0 &&
    lastProjectRuntimeBindingKind === "remote"
  );
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

async function requireLocalProjectHostBinding(action: string): Promise<Extract<
  OpenProjectBinding,
  { kind: "local" }
>> {
  const binding = await getProjectRuntimeBinding({ fresh: true });
  if (binding?.kind === "local") return binding;
  if (binding?.kind === "remote") {
    throw new Error(`${action} is only available on the local project host.`);
  }
  throw new Error(`${action} requires an open local project.`);
}

async function callRemoteProjectActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
  options?: { freshBinding?: boolean },
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (shouldBypassProjectRuntimeDuringTransition(domain, action)) {
    return { handled: false };
  }
  const binding = await getRemoteProjectBinding(options?.freshBinding ? { fresh: true } : undefined);
  if (!binding) return { handled: false };
  const response = (await ipcRenderer.invoke(IPC.remoteRuntimeCallAction, {
    id: binding.targetId,
    projectId: binding.projectId,
    request: { domain, action, ...request },
  })) as RemoteRuntimeActionResult;
  return { handled: true, result: response.result as T };
}

function isValidPreviewTargetPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

async function localizeRemoteLanePreviewInfo(
  binding: Extract<OpenProjectBinding, { kind: "remote" }>,
  info: LanePreviewInfo | null,
): Promise<LanePreviewInfo | null> {
  if (!info) return null;
  if (!isValidPreviewTargetPort(info.targetPort)) return info;
  const forward = (await ipcRenderer.invoke(IPC.remoteRuntimeEnsurePortForward, {
    id: binding.targetId,
    request: {
      remoteHost: "127.0.0.1",
      remotePort: info.targetPort,
      label: `${binding.displayName}:${info.laneId}`,
    },
  })) as RemoteRuntimePortForward;
  return {
    ...info,
    hostname: forward.localHost,
    previewUrl: forward.localUrl,
    proxyPort: forward.localPort,
    active: true,
  };
}

async function callLocalProjectActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
  options?: { freshBinding?: boolean },
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (shouldBypassProjectRuntimeDuringTransition(domain, action)) {
    return { handled: false };
  }
  const binding = await getLocalProjectBinding(options?.freshBinding ? { fresh: true } : undefined);
  if (!binding) return { handled: false };
  const response = (await ipcRenderer.invoke(IPC.localRuntimeCallAction, {
    rootPath: binding.rootPath,
    request: { domain, action, ...request },
  })) as RemoteRuntimeActionResult;
  return { handled: true, result: response.result as T };
}

async function callLocalProjectActionStrictIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (shouldBypassProjectRuntimeDuringTransition(domain, action)) {
    return { handled: false };
  }
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
  "restoreCancelledQueue",
  "recoverTurn",
  "recoverCodexTurn",
  "resolveUnprocessedMessage",
  "recoverContinuity",
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
  "prepareCrossMachineHandoff",
  "validateCrossMachineSource",
  "markCrossMachineHandoff",
  "launchCli",
  "launchHeadless",
  "setClaudeOutputStyle",
  "reloadClaudePlugins",
  "setParallelLaunchState",
  "createScheduledWork",
  "cancelScheduledWork",
  "setScheduledWorkPaused",
  "ensureCtoSession",
  "warmupModel",
  "rewindFiles",
  "saveTempAttachment",
  "setCodexGoal",
  "setCodexGoalStatus",
  "clearCodexGoal",
  // Private draft state must never fall through to the process-global IPC
  // database while the owning project binding is changing.
  "listPromptStashes",
  "createPromptStash",
  "deletePromptStash",
]);

const READ_ONLY_RUNTIME_ACTION_PREFIXES = [
  "diagnosticsGet",
  "get",
  "list",
  "oauthGet",
  "oauthList",
  "portList",
  "proxyGet",
  "read",
  "search",
] as const;

const READ_ONLY_RUNTIME_ACTIONS = new Set([
  "chat.codexFuzzyFileSearch",
  "chat.fileSearch",
  "chat.listMentionSuggestions",
  "chat.modelCatalog",
  "chat.resolveSmartLinkPreview",
  "file.quickOpen",
  "ios_simulator.resolvePreviewMatch",
  "terminal.activeForChat",
  "terminal.preview",
]);

const MUTATING_SYNC_METHODS = new Set([
  "sync.connectToBrain",
  "sync.disconnectFromBrain",
  "sync.forgetDevice",
  "sync.transferBrainToLocal",
  "sync.setPin",
  "sync.generatePin",
  "sync.clearPin",
  "sync.setRuntimeName",
  "sync.clearRuntimeName",
  "sync.updateLocalDevice",
  "sync.setActiveLanePresence",
  "modelPicker.setFavorites",
  "modelPicker.toggleFavorite",
  "modelPicker.pushRecent",
]);

const PROJECT_SWITCHING_MESSAGE =
  "Project is switching. Wait for the current project to finish loading before changing project state.";

let openRemoteProjectGeneration = 0;
let activeRemoteProjectOpenGeneration: number | null = null;
const MAX_REMOTE_PROJECT_OPEN_REBIND_ATTEMPTS = 5;

function isReadOnlyRuntimeAction(domain: string, action: string): boolean {
  const key = `${domain}.${action}`;
  if (READ_ONLY_RUNTIME_ACTIONS.has(key)) return true;
  return READ_ONLY_RUNTIME_ACTION_PREFIXES.some(
    (prefix) =>
      action === prefix ||
      (action.startsWith(prefix) && /^[A-Z]/.test(action.slice(prefix.length))),
  );
}

function isMutatingRuntimeAction(domain: string, action: string): boolean {
  if (domain === "chat") return MUTATING_CHAT_ACTIONS.has(action);
  return !isReadOnlyRuntimeAction(domain, action);
}

function assertProjectRuntimeNotTransitioningForMutation(label: string): void {
  if (projectRuntimeTransitionDepth > 0) {
    throw new Error(PROJECT_SWITCHING_MESSAGE.replace("changing project state", label));
  }
}

function shouldBypassProjectRuntimeDuringTransition(domain: string, action: string): boolean {
  if (projectRuntimeTransitionDepth <= 0) return false;
  if (isMutatingRuntimeAction(domain, action)) {
    const label =
      domain === "chat" && MUTATING_CHAT_ACTIONS.has(action)
        ? "sending chat messages"
        : "changing project state";
    throw new Error(PROJECT_SWITCHING_MESSAGE.replace("changing project state", label));
  }
  return false;
}

async function waitForRemoteProjectOpenIfActive(): Promise<boolean> {
  const generation = activeRemoteProjectOpenGeneration;
  const promise = activeRemoteProjectOpenPromise;
  if (generation == null || !promise) return false;
  try {
    await promise;
  } catch {
    return false;
  }
  return activeRemoteProjectOpenGeneration !== generation;
}

async function callProjectRuntimeActionIfBound<T>(
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
): Promise<{ handled: true; result: T } | { handled: false }> {
  const freshBinding = domain === "chat";
  const isMutatingChatAction =
    freshBinding && MUTATING_CHAT_ACTIONS.has(action);
  if (isMutatingRuntimeAction(domain, action) && projectRuntimeTransitionDepth > 0) {
    const label =
      isMutatingChatAction
        ? "sending chat messages"
        : "changing project state";
    throw new Error(PROJECT_SWITCHING_MESSAGE.replace("changing project state", label));
  }
  // During a project transition, let read-only chat calls fall through to
  // their IPC fallback instead of binding to a possibly-stale runtime.
  if (freshBinding && !isMutatingChatAction && projectRuntimeTransitionDepth > 0) {
    return { handled: false };
  }
  let rebindAttempts = 0;
  while (
    activeRemoteProjectOpenGeneration !== null &&
    !isMutatingRuntimeAction(domain, action) &&
    await waitForRemoteProjectOpenIfActive()
  ) {
    rebindAttempts += 1;
    if (rebindAttempts >= MAX_REMOTE_PROJECT_OPEN_REBIND_ATTEMPTS) {
      throw new Error(
        PROJECT_SWITCHING_MESSAGE.replace("changing project state", "reading project state"),
      );
    }
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

// Route a runtime action to an EXPLICIT project binding, bypassing the mutable
// module-level `currentProjectBinding` and the project-transition guard. The
// target runtime is addressed directly by id/projectId (remote) or rootPath
// (local), exactly as the bound helpers do — the only difference is the binding
// is supplied by the caller instead of resolved from global state. Used to pin
// in-flight work (e.g. draft-launch rollback) to the project that started it so
// a concurrent project switch cannot misroute the call to the now-active
// project. Callers only pass a pin for explicitly-targeted, intentional work,
// so the transition guard (which protects the ambiguous *active* binding) does
// not apply.
async function callPinnedRuntimeAction<T>(
  pin: OpenProjectBinding,
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action"> = {},
): Promise<T> {
  if (pin.kind === "remote") {
    const response = (await ipcRenderer.invoke(IPC.remoteRuntimeCallAction, {
      id: pin.targetId,
      projectId: pin.projectId,
      request: { domain, action, ...request },
    })) as RemoteRuntimeActionResult;
    return response.result as T;
  }
  const response = (await ipcRenderer.invoke(IPC.localRuntimeCallAction, {
    rootPath: pin.rootPath,
    request: { domain, action, ...request },
  })) as RemoteRuntimeActionResult;
  return response.result as T;
}

// Per-session runtime routing: a chat, CLI, or shell inherits its machine from
// its lane, so a session on another machine carries an explicit pin and must
// reach THAT runtime without rebinding this window's project tab. Without a pin
// the call uses the active bound runtime and the existing local IPC fallback.
function callPinnedOrBoundRuntimeActionOr<T>(
  pin: OpenProjectBinding | null | undefined,
  domain: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  if (pin) return callPinnedRuntimeAction<T>(pin, domain, action, request);
  return callProjectRuntimeActionOr<T>(domain, action, request, local);
}

// A lane's PR record lives in the `.ade` database of the machine that owns the
// lane, so a PR read is a per-lane fact exactly like a chat or a terminal — and
// takes a pin for the same reason. Without one, every PR read resolves against
// whichever machine the project tab happens to be bound to, so a session on
// another machine showed no PR badge on its card and no PR pill in its header
// until the tab was rebound to that machine.
//
// `pin: null` is not "no opinion" — it means "the machine the project tab is
// bound to", which is exactly right for the PRs tab, the global execution
// context. Every call site states which of the two it wants.
function callPrReadRuntimeActionOr<T>(
  pin: OpenProjectBinding | null | undefined,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  return callPinnedOrBoundRuntimeActionOr(pin, "pr", action, request, local);
}

async function callProjectFileRuntimeActionOr<T>(
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  if (shouldBypassProjectRuntimeDuringTransition("file", action)) {
    return local();
  }
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

function isExternalFilesWorkspaceId(workspaceId: string | null | undefined): boolean {
  return typeof workspaceId === "string" && workspaceId.startsWith(EXTERNAL_FILES_WORKSPACE_ID_PREFIX);
}

function callFilesWorkspaceActionOr<T>(
  workspaceId: string,
  action: string,
  request: Omit<RemoteRuntimeActionRequest, "domain" | "action">,
  local: () => Promise<T>,
): Promise<T> {
  if (isExternalFilesWorkspaceId(workspaceId)) {
    return local();
  }
  return callProjectFileRuntimeActionOr<T>(action, request, local);
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
  const binding = await getLocalProjectBinding();
  if (!binding) return { handled: false };
  const result = (await ipcRenderer.invoke(IPC.localRuntimeCallSync, {
    rootPath: binding.rootPath,
    method,
    params,
  })) as T;
  return { handled: true, result };
}

async function callProjectRuntimeSyncOr<T>(
  method: string,
  params: Record<string, unknown>,
  local: () => Promise<T>,
): Promise<T> {
  if (MUTATING_SYNC_METHODS.has(method) && projectRuntimeTransitionDepth > 0) {
    assertProjectRuntimeNotTransitioningForMutation("changing sync state");
  }
  const remote = await callRemoteProjectSyncIfBound<T>(method, params);
  if (remote.handled) return remote.result;
  let localRuntime: Awaited<ReturnType<typeof callLocalProjectSyncIfBound<T>>>;
  try {
    localRuntime = await callLocalProjectSyncIfBound<T>(method, params);
  } catch (error) {
    if (!isSyncServiceUnavailableError(error)) {
      throw error;
    }
    // A packaged desktop can temporarily use a project-capable isolated
    // no-sync brain while its channel-owned primary brain is being repaired.
    // Route machine/mobile sync through main IPC so it can resolve the
    // authoritative sync service instead of surfacing the isolated RPC error.
    return await local();
  }
  return localRuntime.handled ? localRuntime.result : local();
}

const remoteAgentChatEventCallbacks = new Set<
  (payload: AgentChatEventEnvelope) => void
>();
const pinnedLocalAgentChatEventCallbacks = new Map<
  string,
  Set<(event: RemoteRuntimeBufferedEvent) => void>
>();
const remoteSessionChangedCallbacks = new Set<
  (payload: TerminalSessionChangedEvent) => void
>();
const remoteLaneDeleteEventCallbacks = new Set<
  (payload: LaneDeleteEvent) => void
>();
const remoteLaneLifecycleEventCallbacks = new Set<
  (payload: LaneLifecycleEvent) => void
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
const remoteOpenCodeOAuthStatusCallbacks = new Set<
  (payload: OpenCodeOAuthStatusEvent) => void
>();
const remoteLaneDiagnosticsEventCallbacks = new Set<
  (payload: RuntimeDiagnosticsEvent) => void
>();
const remotePtyDataEventCallbacks = new Set<(payload: PtyDataEvent) => void>();
const remotePtyExitEventCallbacks = new Set<(payload: PtyExitEvent) => void>();
let ptyDataSubscriptionsConfigured = false;
let subscribedPtyDataIds = new Set<string>();
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
const remoteSyncStatusEventCallbacks = new Set<
  (payload: SyncStatusEventPayload) => void
>();
const remoteReviewEventCallbacks = new Set<
  (payload: ReviewEventPayload) => void
>();
const remoteUsageUpdateEventCallbacks = new Set<
  (payload: UsageSnapshot) => void
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
const remoteOrchestrationEventCallbacks = new Set<
  (payload: OrchestrationEventPayload) => void
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
const subscribeLocalOpenCodeOAuthStatusEvents =
  createLocalIpcEventSubscription<OpenCodeOAuthStatusEvent>(
    IPC.aiOpencodeOAuthStatus,
    "OpenCode OAuth status",
  );

let remoteRuntimeEventTimer: ReturnType<typeof setTimeout> | null = null;
let remoteRuntimeEventInFlight = false;
let remoteRuntimeEventCursor = 0;
let remoteRuntimeEventBindingKey: string | null = null;
// The binding the pump is currently subscribed to, kept alongside its key so a
// switch can tell main which subscription to drop.
let remoteRuntimeEventBinding: OpenProjectBinding | null = null;
let remoteRuntimeEventGeneration = -1;
let remoteRuntimeEventEpoch: string | null = null;
let remoteRuntimeEventStartedAtMs = 0;
let remoteRuntimeEventReplaySuppressed = false;
let remoteRuntimeEmptyPollCount = 0;
let remoteRuntimeSeenEventBindingKey: string | null = null;
const remoteRuntimeSeenEventIds = new Set<number>();
const LOCAL_RUNTIME_EVENT_IDLE_POLL_MS = 750;
const REMOTE_RUNTIME_EVENT_INITIAL_IDLE_POLL_MS = 2_500;

// Every pump that reads a binding the window is not bound to lives in this
// subsystem; the active-binding pump below stays here and shares its helpers.
const pinnedRuntimeEvents = createPinnedRuntimeEvents({
  ipcRenderer,
  toWrappedEvent,
  syncPtyDataSubscriptions: () => syncPtyDataSubscriptions(),
  isPtyDataFilteringConfigured: () => ptyDataSubscriptionsConfigured,
});
const startPinnedRuntimeEventPump =
  pinnedRuntimeEvents.startPinnedRuntimeEventPump;

function clearPendingRemoteRuntimeEventPoll(): void {
  if (!remoteRuntimeEventTimer) return;
  clearTimeout(remoteRuntimeEventTimer);
  remoteRuntimeEventTimer = null;
}

function resetRemoteRuntimeEventDedup(bindingKey: string | null): void {
  remoteRuntimeSeenEventBindingKey = bindingKey;
  remoteRuntimeSeenEventIds.clear();
}

function resetRemoteRuntimeEmptyPolls(): void {
  remoteRuntimeEmptyPollCount = 0;
}

function shouldDispatchRemoteRuntimeEvent(
  bindingKey: string,
  event: RemoteRuntimeBufferedEvent,
): boolean {
  if (remoteRuntimeSeenEventBindingKey !== bindingKey) {
    resetRemoteRuntimeEventDedup(bindingKey);
  }
  if (!rememberPinnedRuntimeEventId(remoteRuntimeSeenEventIds, event.id)) {
    return false;
  }
  remoteRuntimeEventCursor = Math.max(remoteRuntimeEventCursor, event.id);
  return true;
}

function hasRemoteRuntimeEventSubscribers(): boolean {
  return (
    remoteAgentChatEventCallbacks.size > 0 ||
    remoteSyncStatusEventCallbacks.size > 0 ||
    remoteReviewEventCallbacks.size > 0 ||
    remoteSessionChangedCallbacks.size > 0 ||
    remoteLaneDeleteEventCallbacks.size > 0 ||
    remoteLaneLifecycleEventCallbacks.size > 0 ||
    remoteLaneRebaseEventCallbacks.size > 0 ||
    remoteLaneRebaseSuggestionsEventCallbacks.size > 0 ||
    remoteLaneAutoRebaseEventCallbacks.size > 0 ||
    remoteLaneEnvEventCallbacks.size > 0 ||
    remoteLanePortEventCallbacks.size > 0 ||
    remoteLaneProxyEventCallbacks.size > 0 ||
    remoteLaneOAuthEventCallbacks.size > 0 ||
    remoteOpenCodeOAuthStatusCallbacks.size > 0 ||
    remoteLaneDiagnosticsEventCallbacks.size > 0 ||
    remotePtyDataEventCallbacks.size > 0 ||
    remotePtyExitEventCallbacks.size > 0 ||
    remoteTestEventCallbacks.size > 0 ||
    remoteFileChangeEventCallbacks.size > 0 ||
    remotePrEventCallbacks.size > 0 ||
    remoteProjectStateEventCallbacks.size > 0 ||
    remoteUsageUpdateEventCallbacks.size > 0 ||
    remoteAutomationsEventCallbacks.size > 0 ||
    remoteConflictEventCallbacks.size > 0 ||
    remoteGitHubStatusChangedCallbacks.size > 0 ||
    remoteFeedbackEventCallbacks.size > 0 ||
    remoteComputerUseEventCallbacks.size > 0 ||
    remoteIosSimulatorEventCallbacks.size > 0 ||
    remoteAppControlEventCallbacks.size > 0 ||
    remoteOrchestrationEventCallbacks.size > 0 ||
    remotePrAiResolutionEventCallbacks.size > 0
  );
}

function registerRemoteOrchestrationEventCallback(
  cb: (payload: OrchestrationEventPayload) => void,
): () => void {
  remoteOrchestrationEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteOrchestrationEventCallbacks.delete(cb);
  };
}

function normalizePtyDataSubscriptionIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function shouldDispatchPtyDataEvent(payload: PtyDataEvent): boolean {
  if (!ptyDataSubscriptionsConfigured) return true;
  return subscribedPtyDataIds.has(payload.ptyId);
}

function collectPtyDataSubscriptionIds(): string[] {
  const ids = new Set(subscribedPtyDataIds);
  for (const ptyId of pinnedRuntimeEvents.collectPinnedPtyDataSubscriptionIds()) {
    ids.add(ptyId);
  }
  return [...ids];
}

function syncPtyDataSubscriptions(): Promise<void> {
  // Until the active path opts into filtering, main-process delivery is
  // intentionally unrestricted. A pinned view must not narrow that legacy
  // stream merely by mounting; its own filter still applies in preload.
  if (!ptyDataSubscriptionsConfigured) return Promise.resolve();
  return ipcRenderer.invoke(IPC.ptyDataSubscriptions, {
    ptyIds: collectPtyDataSubscriptionIds(),
  });
}

async function setPtyDataSubscriptions(
  args: { ptyIds?: string[] },
  pin?: OpenProjectBinding | null,
): Promise<void> {
  const ptyIds = normalizePtyDataSubscriptionIds(args?.ptyIds);
  if (pin) {
    await pinnedRuntimeEvents.setPinnedPtyDataSubscriptions(pin, ptyIds);
    return;
  }
  ptyDataSubscriptionsConfigured = true;
  subscribedPtyDataIds = ptyIds;
  ensureRemoteRuntimeEventPump();
  await syncPtyDataSubscriptions();
}

function ensureRemoteRuntimeEventPump(): void {
  if (!hasRemoteRuntimeEventSubscribers()) return;
  if (remoteRuntimeEventTimer || remoteRuntimeEventInFlight) return;
  remoteRuntimeEventTimer = setTimeout(() => {
    remoteRuntimeEventTimer = null;
    void pollRemoteRuntimeEvents();
  }, 0);
}

// The active pump owns exactly one main-side subscription at a time. Without an
// explicit release, a binding the window switched away from keeps streaming
// orchestrator/dag_mutation/runtime events into a preload that discards them all,
// for up to the idle-expiry window, once per switch.
function releaseRuntimeEventSubscriptionForPreviousBinding(
  nextBinding: OpenProjectBinding | null,
): void {
  const previous = remoteRuntimeEventBinding;
  remoteRuntimeEventBinding = nextBinding;
  if (!previous || previous.key === nextBinding?.key) return;
  pinnedRuntimeEvents.releaseRuntimeEventSubscriptionIfUnpinned(previous);
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
  let pollingBindingKey: string | null = null;
  let pollingGeneration = projectBindingGeneration;
  try {
    const binding = await getProjectRuntimeBinding();
    if (!binding) {
      releaseRuntimeEventSubscriptionForPreviousBinding(null);
      remoteRuntimeEventCursor = 0;
      remoteRuntimeEventBindingKey = null;
      remoteRuntimeEventGeneration = projectBindingGeneration;
      remoteRuntimeEventEpoch = null;
      remoteRuntimeEventStartedAtMs = 0;
      remoteRuntimeEventReplaySuppressed = false;
      resetRemoteRuntimeEmptyPolls();
      resetRemoteRuntimeEventDedup(null);
      return;
    }

    if (
      remoteRuntimeEventBindingKey !== binding.key ||
      remoteRuntimeEventGeneration !== projectBindingGeneration
    ) {
      releaseRuntimeEventSubscriptionForPreviousBinding(binding);
      remoteRuntimeEventCursor = 0;
      remoteRuntimeEventBindingKey = binding.key;
      remoteRuntimeEventGeneration = projectBindingGeneration;
      remoteRuntimeEventEpoch = null;
      remoteRuntimeEventStartedAtMs =
        binding.kind === "local" ? Date.now() : 0;
      remoteRuntimeEventReplaySuppressed = binding.kind === "remote";
      resetRemoteRuntimeEmptyPolls();
      resetRemoteRuntimeEventDedup(binding.key);
    }

    pollingBindingKey = binding.key;
    pollingGeneration = projectBindingGeneration;
    const request = {
      cursor: remoteRuntimeEventCursor,
      limit: 100,
      ...(binding.kind === "remote" && remoteRuntimeEventReplaySuppressed && remoteRuntimeEventCursor === 0
        ? { replay: false }
        : {}),
    } satisfies RemoteRuntimeStreamEventsRequest;
    const suppressingInitialRemoteReplay =
      binding.kind === "remote" && request.replay === false;
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

    const batchEpoch = normalizePinnedRuntimeEventEpoch(batch.eventEpoch);
    if (batchEpoch) {
      const epochChanged = remoteRuntimeEventEpoch
        ? batchEpoch !== remoteRuntimeEventEpoch
        : remoteRuntimeEventCursor > 0;
      remoteRuntimeEventEpoch = batchEpoch;
      if (epochChanged) {
        remoteRuntimeEventCursor = 0;
        remoteRuntimeEventReplaySuppressed = binding.kind === "remote";
        resetRemoteRuntimeEmptyPolls();
        resetRemoteRuntimeEventDedup(binding.key);
        nextDelayMs = 0;
        return;
      }
    }
    if (batch.gap === true) {
      resetRemoteRuntimeEventDedup(binding.key);
      resetRemoteRuntimeEmptyPolls();
    }

    remoteRuntimeEventCursor = Number.isFinite(batch.nextCursor)
      ? Math.max(0, Math.floor(batch.nextCursor))
      : remoteRuntimeEventCursor;
    if (suppressingInitialRemoteReplay) {
      remoteRuntimeEventReplaySuppressed = false;
    }

    for (const event of batch.events) {
      // `remoteRuntimeEventStartedAtMs` is 0 for remote bindings, so the shared
      // helper's zero guard already restricts this to local ones.
      if (isPinnedRuntimeEventStale(remoteRuntimeEventStartedAtMs, event.timestamp)) {
        continue;
      }
      if (!shouldDispatchRemoteRuntimeEvent(binding.key, event)) continue;
      dispatchRemoteRuntimeEventPayload(event.payload);
    }
    if (batch.hasMore) {
      resetRemoteRuntimeEmptyPolls();
      nextDelayMs = REMOTE_RUNTIME_EVENT_CATCH_UP_POLL_MS;
    } else if (batch.events.length > 0) {
      resetRemoteRuntimeEmptyPolls();
      nextDelayMs =
        binding.kind === "remote"
          ? REMOTE_RUNTIME_EVENT_ACTIVE_POLL_MS
          : LOCAL_RUNTIME_EVENT_IDLE_POLL_MS;
    } else if (binding.kind === "remote") {
      remoteRuntimeEmptyPollCount += 1;
      nextDelayMs =
        remoteRuntimeEmptyPollCount <= 1
          ? REMOTE_RUNTIME_EVENT_INITIAL_IDLE_POLL_MS
          : REMOTE_RUNTIME_EVENT_IDLE_POLL_MS;
    } else {
      nextDelayMs = LOCAL_RUNTIME_EVENT_IDLE_POLL_MS;
    }
  } catch (error) {
    const stalePoll =
      pollingBindingKey != null &&
      (currentProjectBinding?.key !== pollingBindingKey ||
        projectBindingGeneration !== pollingGeneration);
    if (stalePoll) {
      nextDelayMs = 0;
    } else {
      console.warn("ADE runtime event polling failed", error);
      nextDelayMs = 2_000;
    }
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
  if (!payload) return;
  pinnedRuntimeEvents.handlePinnedPtyRuntimeEventNotification(
    payload.bindingKey,
    payload.eventEpoch,
    payload.event,
  );
  const pinnedLocalCallbacks = pinnedLocalAgentChatEventCallbacks.get(
    payload.bindingKey,
  );
  if (pinnedLocalCallbacks?.size) {
    for (const dispatch of [...pinnedLocalCallbacks]) {
      try {
        dispatch(payload.event);
      } catch (error) {
        console.error("preload pinned local agent chat listener failed", error);
      }
    }
  }
  const binding = currentProjectBinding;
  if (!binding || payload.bindingKey !== binding.key) return;
  resetRemoteRuntimeEmptyPolls();
  const notificationEpoch = normalizePinnedRuntimeEventEpoch(payload.eventEpoch);
  if (notificationEpoch) {
    const epochChanged = remoteRuntimeEventEpoch
      ? notificationEpoch !== remoteRuntimeEventEpoch
      : remoteRuntimeEventCursor > 0 || remoteRuntimeSeenEventIds.size > 0;
    remoteRuntimeEventEpoch = notificationEpoch;
    if (epochChanged) {
      remoteRuntimeEventCursor = 0;
      remoteRuntimeEventReplaySuppressed = binding.kind === "remote";
      resetRemoteRuntimeEventDedup(binding.key);
    }
  }
  if (isPinnedRuntimeEventStale(remoteRuntimeEventStartedAtMs, payload.event.timestamp)) {
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
  const eventEpoch =
    typeof value.eventEpoch === "string" && value.eventEpoch.trim()
      ? value.eventEpoch.trim()
      : null;
  if (!bindingKey || !event) return null;
  return { bindingKey, event, ...(eventEpoch ? { eventEpoch } : {}) };
}

function isRemoteRuntimeEventCategory(
  value: unknown,
): value is RemoteRuntimeEventCategory {
  return (
    value === "orchestrator" ||
    value === "dag_mutation" ||
    value === "runtime" ||
    value === "pty"
  );
}

function toRemoteRuntimeBufferedEvent(
  value: unknown,
): RemoteRuntimeBufferedEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "number" || !Number.isFinite(value.id)) return null;
  if (typeof value.timestamp !== "string") return null;
  const category = value.category;
  if (!isRemoteRuntimeEventCategory(category)) {
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
  if (payload.kind === "opencodeOAuthStatus" && isRecord(payload.event)) {
    const event = payload.event;
    if (typeof event.providerId === "string" && typeof event.state === "string") {
      for (const cb of [...remoteOpenCodeOAuthStatusCallbacks]) {
        try {
          cb(event as unknown as OpenCodeOAuthStatusEvent);
        } catch (error) {
          console.error("preload remote OpenCode OAuth status listener failed", error);
        }
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

  const orchestrationEvent = toOrchestrationRuntimeEvent(payload);
  if (orchestrationEvent) {
    for (const cb of [...remoteOrchestrationEventCallbacks]) {
      try {
        cb(orchestrationEvent);
      } catch (error) {
        console.error("preload remote orchestration listener failed", error);
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
    githubAppInstallationStatusCache.clear();
    for (const cb of [...remoteGitHubStatusChangedCallbacks]) {
      try {
        cb(githubStatus);
      } catch (error) {
        console.error("preload remote GitHub status listener failed", error);
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

  const laneLifecycleEvent = toWrappedEvent<LaneLifecycleEvent>(
    payload,
    "lane_lifecycle_event",
  );
  if (laneLifecycleEvent) {
    clearGitReadCaches();
    for (const cb of [...remoteLaneLifecycleEventCallbacks]) {
      try {
        cb(laneLifecycleEvent);
      } catch (error) {
        console.error("preload remote lane lifecycle listener failed", error);
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
    if (!shouldDispatchPtyDataEvent(ptyDataEvent)) return;
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

function subscribeRemoteLaneLifecycleEvents(
  cb: (payload: LaneLifecycleEvent) => void,
): () => void {
  remoteLaneLifecycleEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteLaneLifecycleEventCallbacks.delete(cb);
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

function subscribeRemoteOpenCodeOAuthStatusEvents(
  cb: (payload: OpenCodeOAuthStatusEvent) => void,
): () => void {
  remoteOpenCodeOAuthStatusCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteOpenCodeOAuthStatusCallbacks.delete(cb);
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

function subscribeRemoteUsageUpdateEvents(
  cb: (payload: UsageSnapshot) => void,
): () => void {
  remoteUsageUpdateEventCallbacks.add(cb);
  ensureRemoteRuntimeEventPump();
  return () => {
    remoteUsageUpdateEventCallbacks.delete(cb);
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
  pin?: OpenProjectBinding | null,
  options?: { forcePinned?: boolean },
): () => void {
  const forcePinned = Boolean(pin && options?.forcePinned === true);
  const removeLocal = forcePinned ? () => undefined : agentChatEventFanout(cb);
  if (pin && (forcePinned || pin.key !== currentProjectBinding?.key)) {
    const startedAtMs = pin.kind === "local" ? Date.now() : 0;
    const seenLocalEventIds = new Set<number>();
    const dispatchPinnedLocalEvent = (event: RemoteRuntimeBufferedEvent): void => {
      if (isPinnedRuntimeEventStale(startedAtMs, event.timestamp)) return;
      if (!rememberPinnedRuntimeEventId(seenLocalEventIds, event.id)) return;
      const envelope = toAgentChatEventEnvelope(event.payload);
      if (!envelope) return;
      agentChatSummaryCache.clear();
      cb(envelope);
    };
    const pinnedLocalCallbacks =
      pin.kind === "local"
        ? pinnedLocalAgentChatEventCallbacks.get(pin.key) ??
          new Set<(event: RemoteRuntimeBufferedEvent) => void>()
        : null;
    if (pinnedLocalCallbacks) {
      pinnedLocalCallbacks.add(dispatchPinnedLocalEvent);
      pinnedLocalAgentChatEventCallbacks.set(pin.key, pinnedLocalCallbacks);
    }
    const stopPump = startPinnedRuntimeEventPump({
      pin,
      label: "chat",
      suppressReplay: pin.kind === "remote",
      dispatch: (event) => {
        if (pin.kind === "local") {
          // Shared with the push-notification path, so it owns dedup itself.
          dispatchPinnedLocalEvent(event);
          return;
        }
        const envelope = toAgentChatEventEnvelope(event.payload);
        if (envelope) cb(envelope);
      },
    });
    return () => {
      stopPump();
      if (pinnedLocalCallbacks) {
        pinnedLocalCallbacks.delete(dispatchPinnedLocalEvent);
        if (pinnedLocalCallbacks.size === 0) {
          pinnedLocalAgentChatEventCallbacks.delete(pin.key);
        }
      }
      removeLocal();
    };
  }
  const removeRemote = subscribeRemoteAgentChatEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribePtyDataEvents(
  cb: (payload: PtyDataEvent) => void,
  pin?: OpenProjectBinding | null,
): () => void {
  if (pin) return pinnedRuntimeEvents.subscribePinnedPtyDataEvents(pin, cb);
  const filteredCb = (payload: PtyDataEvent) => {
    if (shouldDispatchPtyDataEvent(payload)) cb(payload);
  };
  const removeLocal = ptyDataEventFanout(filteredCb);
  const removeRemote = subscribeRemotePtyDataEvents(filteredCb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribePtyExitEvents(
  cb: (payload: PtyExitEvent) => void,
  pin?: OpenProjectBinding | null,
): () => void {
  if (pin) return pinnedRuntimeEvents.subscribePinnedPtyExitEvents(pin, cb);
  const removeLocal = ptyExitEventFanout(cb);
  const removeRemote = subscribeRemotePtyExitEvents(cb);
  return () => {
    removeRemote();
    removeLocal();
  };
}

function subscribeUsageUpdateEvents(
  cb: (payload: UsageSnapshot) => void,
): () => void {
  const removeLocal = subscribeLocalUsageUpdateEvents((payload) => {
    if (!currentProjectBinding) cb(payload);
  });
  const removeRemote = subscribeRemoteUsageUpdateEvents((payload) => {
    if (currentProjectBinding) cb(payload);
  });
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

function subscribePinnedProjectRuntimeEvents<T>(
  pin: OpenProjectBinding | null | undefined,
  decode: (payload: unknown) => T | null,
  cb: (payload: T) => void,
  label: string,
  onPayload?: () => void,
): (() => void) | null {
  if (!pin || pin.key === currentProjectBinding?.key) return null;
  return startPinnedRuntimeEventPump({
    pin,
    label,
    suppressReplay: true,
    dispatch: (event) => {
      const payload = decode(event.payload);
      if (!payload) return;
      onPayload?.();
      cb(payload);
    },
  });
}

function subscribeComputerUseEvents(
  cb: (payload: ComputerUseEventPayload) => void,
  pin?: OpenProjectBinding | null,
): () => void {
  const removePinned = subscribePinnedProjectRuntimeEvents(
    pin,
    (payload) => toWrappedEvent<ComputerUseEventPayload>(
      payload,
      "computer_use_event",
    ),
    cb,
    "computer use",
    () => computerUseOwnerSnapshotCache.clear(),
  );
  if (removePinned) return removePinned;
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

const ORCHESTRATION_EVENT_KINDS = new Set([
  "manifest",
  "plan",
  "asset",
  "heartbeat",
  "lifecycle",
]);

function toOrchestrationRuntimeEvent(
  payload: unknown,
): OrchestrationEventPayload | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.runId !== "string" || !payload.runId) return null;
  if (typeof payload.etag !== "string") return null;
  if (typeof payload.kind !== "string" || !ORCHESTRATION_EVENT_KINDS.has(payload.kind)) {
    return null;
  }
  if (payload.kind === "heartbeat") {
    if (typeof payload.sessionId !== "string" || !payload.sessionId) return null;
    if (typeof payload.lastHeartbeatAt !== "string" || !payload.lastHeartbeatAt)
      return null;
  }
  if (
    payload.kind === "lifecycle" &&
    payload.status !== "suspended" &&
    payload.status !== "resumed" &&
    payload.status !== "deleted"
  ) {
    return null;
  }
  return payload as unknown as OrchestrationEventPayload;
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
  githubAppInstallationStatusCache.clear();
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
const projectStateEventFanout = createIpcEventFanout<AdeProjectEvent>(
  IPC.projectStateEvent,
);
const ptyDataEventFanout = createIpcEventFanout<PtyDataEvent>(IPC.ptyData);
const ptyExitEventFanout = createIpcEventFanout<PtyExitEvent>(IPC.ptyExit);

contextBridge.exposeInMainWorld("ade", {
  analytics: {
    capture: async (
      input: Omit<ProductAnalyticsCapture, "surface">,
    ): Promise<ProductAnalyticsCaptureResult> =>
      ipcRenderer.invoke(IPC.analyticsCapture, input),
    getStatus: async (): Promise<ProductAnalyticsStatus> =>
      ipcRenderer.invoke(IPC.analyticsGetStatus),
    setEnabled: async (enabled: boolean): Promise<ProductAnalyticsStatus> =>
      ipcRenderer.invoke(IPC.analyticsSetEnabled, enabled),
  },
  app: {
    // Synchronous so renderer platform gates (renderer/lib/platform.ts) can run
    // at module scope. navigator.platform cannot report the CPU architecture —
    // Chromium reports "Win32" on Windows on ARM too — and app.getInfo() only
    // answers after an IPC round trip.
    runtimeTarget: { platform: process.platform, arch: process.arch },
    // Also synchronous, and for the same reason: the shell header decides
    // whether to draw a channel badge (and whether to raise the early-build
    // notice) at first paint. Stable is the overwhelmingly common answer and
    // must not cost an IPC round trip to learn.
    packageChannel: resolvePackageChannelFromProcess({
      argv: process.argv,
      env: process.env,
    }),
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    setDockBadgeCount: async (count: number): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.appSetDockBadgeCount, { count }),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    onRuntimeStatusChanged: (cb: (status: LocalRuntimeStatus) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LocalRuntimeStatus,
      ) => cb(payload);
      ipcRenderer.on(IPC.appRuntimeStatusChanged, listener);
      return () => ipcRenderer.removeListener(IPC.appRuntimeStatusChanged, listener);
    },
    getResourceUsage: async (): Promise<AppResourceUsageSnapshot> =>
      ipcRenderer.invoke(IPC.appGetResourceUsage),
    getRuntimeHealth: async (): Promise<RuntimeHealthSnapshot> =>
      ipcRenderer.invoke(IPC.appGetRuntimeHealth),
    restartBackgroundService: async (): Promise<void> =>
      ipcRenderer.invoke(IPC.appRestartBackgroundService),
    getLatestRelease: async (): Promise<LatestReleaseInfo | null> =>
      ipcRenderer.invoke(IPC.appGetLatestRelease),
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
    getWelcomeVideoState: async (): Promise<AppWelcomeVideoState> =>
      ipcRenderer.invoke(IPC.appGetWelcomeVideoState),
    markWelcomeVideoSeen: async (
      reason: "completed" | "dismissed",
    ): Promise<AppWelcomeVideoState> =>
      ipcRenderer.invoke(IPC.appMarkWelcomeVideoSeen, { reason }),
    getLaunchGateState: async (): Promise<{ resolved: boolean }> =>
      ipcRenderer.invoke(IPC.appGetLaunchGateState),
    resolveLaunchGate: async (): Promise<{ resolved: true }> =>
      ipcRenderer.invoke(IPC.appResolveLaunchGate),
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
      projectBindingChangedCallbacks.add(cb);
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: OpenProjectBinding | null,
      ) => {
        rememberProjectBinding(payload);
        clearProjectScopedReadCaches();
        cb(payload);
      };
      ipcRenderer.on(IPC.appProjectBindingChanged, listener);
      return () => {
        projectBindingChangedCallbacks.delete(cb);
        ipcRenderer.removeListener(IPC.appProjectBindingChanged, listener);
      };
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
  storage: {
    getPressure: async (): Promise<DiskPressureSnapshot> =>
      ipcRenderer.invoke(IPC.storageGetPressure),
    getSnapshot: async (args: { forceRefresh?: boolean } = {}): Promise<StorageSnapshot> =>
      callProjectRuntimeActionOr("storage", "getSnapshot", { args }, () =>
        ipcRenderer.invoke(IPC.storageGetSnapshot, args),
      ),
    compressNow: async (): Promise<StorageCompressionResult> =>
      callProjectRuntimeActionOr("storage", "compressNow", { args: {} }, () =>
        ipcRenderer.invoke(IPC.storageCompressNow),
      ),
    runMaintenanceNow: async (): Promise<MaintenanceRunReport> =>
      callProjectRuntimeActionOr("storage", "runMaintenanceNow", { args: {} }, () =>
        ipcRenderer.invoke(IPC.storageRunMaintenanceNow),
      ),
    cleanupPreview: async (targets: StorageCleanupTarget[]): Promise<StorageCleanupPreview> =>
      callProjectRuntimeActionOr("storage", "cleanupPreview", { args: { targets } }, () =>
        ipcRenderer.invoke(IPC.storageCleanupPreview, targets),
      ),
    cleanup: async (
      targets: StorageCleanupTarget[],
      opts: { preview: StorageCleanupPreview },
    ): Promise<StorageCleanupResult> =>
      callProjectRuntimeActionOr("storage", "cleanup", { args: { targets, preview: opts.preview } }, () =>
        ipcRenderer.invoke(IPC.storageCleanup, { targets, preview: opts.preview }),
      ),
  },
  project: {
    openRepo: async (args?: { rootPath?: string }): Promise<ProjectInfo | null> => {
      // `clearAround` runs its cleanup callback both before AND after the
      // action. Nulling the binding inside that callback meant a successful
      // open clobbered the freshly-published binding (set by the
      // appProjectBindingChanged listener) and disabled runtime routing /
      // event pumping until another refresh restored it. Null once up front;
      // the listener handles the post-action update.
      const previousBinding = currentProjectBinding;
      detachProjectBindingForTransition();
      try {
        const project = await clearAround(
          () => {
            clearProjectScopedReadCaches();
          },
          () => runProjectRuntimeTransition(() =>
            ipcRenderer.invoke(IPC.projectOpenRepo, args ?? {}),
          ),
        );
        if (!project) {
          rememberProjectBinding(previousBinding);
        }
        return project;
      } catch (error) {
        rememberProjectBinding(previousBinding);
        throw error;
      }
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
    inspectPath: async (
      path: string,
      opts?: { fresh?: boolean },
    ): Promise<ProjectPathInspection> =>
      ipcRenderer.invoke(IPC.projectInspectPath, { path, fresh: opts?.fresh }),
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
    findForRepo: async (args: {
      repoOwner: string;
      repoName: string;
    }): Promise<{ rootPath: string; displayName: string } | null> =>
      ipcRenderer.invoke(IPC.projectFindForRepo, args),
    closeCurrent: async (): Promise<void> =>
      clearAround(
        () => {
          detachProjectBindingForTransition();
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
      const nextBinding = localProjectBindingForRoot(normalizedRootPath);
      rememberProjectBinding(nextBinding);
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
          project?.rootPath === nextBinding.rootPath
            ? nextBinding
            : localProjectBindingForRoot(project?.rootPath ?? normalizedRootPath),
        );
        return project;
      } catch (error) {
        rememberProjectBinding(previousBinding);
        throw error;
      }
    },
    forgetRecent: async (keyOrRootPath: string): Promise<RecentProjectSummary[]> =>
      // For local recents the key equals the root path; for remote recents the
      // caller passes the remote key. Send both so the handler can match either.
      ipcRenderer.invoke(IPC.projectForgetRecent, {
        key: keyOrRootPath,
        rootPath: keyOrRootPath,
      }),
    reorderRecent: async (
      orderedKeys: string[],
    ): Promise<RecentProjectSummary[]> =>
      ipcRenderer.invoke(IPC.projectReorderRecent, { orderedPaths: orderedKeys }),
    setRecentPinned: async (
      key: string,
      pinned: boolean,
    ): Promise<RecentProjectSummary[]> =>
      ipcRenderer.invoke(IPC.projectSetRecentPinned, { key, pinned }),
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
  recovery: {
    diagnose: (projectRoot: string): Promise<ProjectRecoveryDiagnosis> =>
      ipcRenderer.invoke(IPC.recoveryDiagnose, { projectRoot }),
    repair: (projectRoot: string): Promise<ProjectRepairReport> =>
      ipcRenderer.invoke(IPC.recoveryRepair, { projectRoot }),
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
    parsePairingInput: async (
      text: string,
    ): Promise<RemoteRuntimeParsedPairingInput> =>
      ipcRenderer.invoke(IPC.remoteRuntimeParsePairingInput, { text }),
    pairWithMachine: async (
      args: RemoteRuntimePairWithMachineArgs,
    ): Promise<RemoteRuntimePairWithMachineResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimePairWithMachine, args),
    getLocalPairingInfo: async (): Promise<RemoteRuntimeLocalPairingInfo> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetLocalPairingInfo),
    runDoctor: async (id: string): Promise<RemoteRuntimeDoctorResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeRunDoctor, { id }),
    saveTarget: async (
      input: RemoteRuntimeTargetInput,
    ): Promise<RemoteRuntimeTarget> =>
      ipcRenderer.invoke(IPC.remoteRuntimeSaveTarget, input),
    setAutoConnect: async (
      id: string,
      enabled: boolean,
    ): Promise<RemoteRuntimeTarget> =>
      ipcRenderer.invoke(IPC.remoteRuntimeSetAutoConnect, { id, enabled }),
    removeTarget: async (id: string): Promise<{ removed: boolean }> =>
      ipcRenderer.invoke(IPC.remoteRuntimeRemoveTarget, { id }),
    getSshHostKeyTrust: async (
      id: string,
    ): Promise<RemoteRuntimeSshHostKeyTrustStatus> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetSshHostKeyTrust, { id }),
    trustSshHostKey: async (
      id: string,
      fingerprintSha256: string,
    ): Promise<RemoteRuntimeTrustSshHostKeyResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeTrustSshHostKey, {
        id,
        fingerprintSha256,
      }),
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
    getHandoffStoragePreflight: async (
      id: string,
      input: RemoteRuntimeHandoffStoragePreflightArgs,
    ): Promise<RemoteRuntimeHandoffStoragePreflightResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeGetHandoffStoragePreflight, { id, input }),
    createProject: async (
      id: string,
      input: CreateProjectInput,
    ): Promise<RemoteRuntimeProjectRecord> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCreateProject, { id, input }),
    cloneProject: async (
      id: string,
      input: CloneProjectInput,
      options?: RemoteRuntimeCloneProjectOptions,
    ): Promise<RemoteRuntimeProjectRecord> =>
      ipcRenderer.invoke(IPC.remoteRuntimeCloneProject, { id, input, options }),
    listMyGitHubRepos: async (
      id: string,
      input: ListMyGitHubReposInput = {},
    ): Promise<ListMyGitHubReposResult> =>
      ipcRenderer.invoke(IPC.remoteRuntimeListMyGitHubRepos, { id, input }),
    openProject: async (
      id: string,
      projectId: string,
    ): Promise<OpenProjectBinding> => {
      return runProjectRuntimeTransition(async () => {
        const generation = ++openRemoteProjectGeneration;
        activeRemoteProjectOpenGeneration = generation;
        rememberProjectBinding(null);
        const openPromise = ipcRenderer.invoke(IPC.remoteRuntimeOpenProject, {
          id,
          projectId,
        }) as Promise<OpenProjectBinding>;
        activeRemoteProjectOpenPromise = openPromise;
        try {
          const binding = await openPromise;
          if (generation === openRemoteProjectGeneration) {
            rememberProjectBinding(binding);
            activeRemoteProjectOpenGeneration = null;
          }
          return binding;
        } catch (error) {
          if (generation === openRemoteProjectGeneration) {
            await refreshProjectBinding().catch(() => {});
            activeRemoteProjectOpenGeneration = null;
          }
          throw error;
        } finally {
          if (generation === openRemoteProjectGeneration) {
            activeRemoteProjectOpenPromise = null;
          }
        }
      });
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
    disconnect: async (
      id: string,
      options: { manual?: boolean } = {},
    ): Promise<{ disconnected: boolean }> => {
      const trimmedId = typeof id === "string" ? id.trim() : "";
      const manual = options.manual !== false;
      const result = (await ipcRenderer.invoke(IPC.remoteRuntimeDisconnect, {
        id: trimmedId,
        manual,
      })) as { disconnected: boolean };
      if (
        manual &&
        result.disconnected &&
        currentProjectBinding?.kind === "remote" &&
        currentProjectBinding.targetId === trimmedId
      ) {
        rememberProjectBinding(null);
        clearProjectScopedReadCaches();
      }
      return result;
    },
  },
  personalChats: {
    call: async (
      request: PersonalChatCallArgs,
    ): Promise<PersonalChatCallResponse> =>
      ipcRenderer.invoke(IPC.personalChatsCall, request),
    streamEvents: async (
      request: PersonalChatStreamEventsArgs = {},
    ): Promise<PersonalChatStreamEventsResult> =>
      ipcRenderer.invoke(IPC.personalChatsStreamEvents, request),
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
  projectSecrets: {
    list: async (): Promise<ProjectSecretsListResult> =>
      callProjectRuntimeActionOr("project_secret", "list", {}, () =>
        ipcRenderer.invoke(IPC.projectSecretsList),
      ),
    get: async (args: ProjectSecretGetArgs): Promise<ProjectSecretValueResult> =>
      callProjectRuntimeActionOr("project_secret", "get", { args }, () =>
        ipcRenderer.invoke(IPC.projectSecretsGet, args),
      ),
    set: async (args: ProjectSecretSetArgs): Promise<ProjectSecretSummary> =>
      callProjectRuntimeActionOr("project_secret", "set", { args }, () =>
        ipcRenderer.invoke(IPC.projectSecretsSet, args),
      ),
    delete: async (args: ProjectSecretDeleteArgs): Promise<{ deleted: boolean; name: string }> =>
      callProjectRuntimeActionOr("project_secret", "delete", { args }, () =>
        ipcRenderer.invoke(IPC.projectSecretsDelete, args),
      ),
    chooseEnvFile: async (): Promise<ProjectSecretsImportPreview | null> => {
      const file = await ipcRenderer.invoke(IPC.projectSecretsChooseEnvFile) as ProjectSecretEnvFile | null;
      if (!file) return null;
      return callProjectRuntimeActionOr("project_secret", "previewEnvImport", { args: file }, () =>
        ipcRenderer.invoke(IPC.projectSecretsPreviewEnvImport, file),
      );
    },
    importEnv: async (args: ProjectSecretsImportArgs): Promise<ProjectSecretsImportResult> =>
      callProjectRuntimeActionOr("project_secret", "importEnv", { args }, () =>
        ipcRenderer.invoke(IPC.projectSecretsImportEnv, args),
      ),
    exportEnv: async (): Promise<ProjectSecretsExportResult> =>
      callProjectRuntimeActionOr("project_secret", "exportEnv", {}, () =>
        ipcRenderer.invoke(IPC.projectSecretsExportEnv),
      ),
  },
  ai: {
    getStatus: async (args?: {
      force?: boolean;
      refreshOpenCodeInventory?: boolean;
    }, pin?: OpenProjectBinding | null): Promise<AiSettingsStatus> => {
      if (pin) {
        return callPinnedRuntimeAction<AiSettingsStatus>(
          pin,
          "ai",
          "getStatus",
          { args },
        );
      }
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
    isOpenCodeInstalled: async (): Promise<{ installed: boolean; source: "user-installed" | "tools-cache" | "bundled" | "missing" }> =>
      callProjectRuntimeActionOr("ai", "isOpenCodeInstalled", {}, () =>
        ipcRenderer.invoke(IPC.aiIsOpenCodeInstalled),
      ),
    // Machine-local, not project-scoped: the tools cache lives beside this
    // install, so these bypass the runtime-action routing above.
    getToolsCache: (): Promise<AgentToolsCacheSnapshot> =>
      ipcRenderer.invoke(IPC.aiGetToolsCache),
    ensureToolsCache: (): Promise<AgentToolsCacheSnapshot> =>
      ipcRenderer.invoke(IPC.aiEnsureToolsCache),
    onToolsCacheEvent: (cb: (snapshot: AgentToolsCacheSnapshot) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: AgentToolsCacheSnapshot,
      ) => cb(payload);
      ipcRenderer.on(IPC.aiToolsCacheEvent, listener);
      return () => ipcRenderer.removeListener(IPC.aiToolsCacheEvent, listener);
    },
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
    opencodeAuthMethods: async (): Promise<{ methods: OpenCodeProviderAuthMethods }> =>
      callProjectRuntimeActionOr("ai", "opencodeAuthMethods", {}, () =>
        ipcRenderer.invoke(IPC.aiOpencodeAuthMethods),
      ),
    opencodeOAuthStart: async (args: {
      providerId: string;
      methodIndex: number;
      inputs?: Record<string, string>;
    }): Promise<OpenCodeOAuthStartResult> =>
      callProjectRuntimeActionOr("ai", "opencodeOAuthStart", { args }, () =>
        ipcRenderer.invoke(IPC.aiOpencodeOAuthStart, args),
      ),
    opencodeOAuthCancel: async (args: { providerId: string }): Promise<void> =>
      callProjectRuntimeActionOr("ai", "opencodeOAuthCancel", { args }, () =>
        ipcRenderer.invoke(IPC.aiOpencodeOAuthCancel, args),
      ),
    setOpencodeProviderKey: async (args: {
      providerId: string;
      key: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("ai", "setOpencodeProviderKey", { args }, () =>
            ipcRenderer.invoke(IPC.aiSetOpencodeProviderKey, args),
          ),
      ),
    clearOpencodeProviderKey: async (args: {
      providerId: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("ai", "clearOpencodeProviderKey", { args }, () =>
            ipcRenderer.invoke(IPC.aiClearOpencodeProviderKey, args),
          ),
      ),
    refreshModelsDev: async (): Promise<{ lastFetchedAt: number | null }> =>
      clearAround(
        () => aiStatusCache.clear(),
        () =>
          callProjectRuntimeActionOr("ai", "refreshModelsDev", {}, () =>
            ipcRenderer.invoke(IPC.aiRefreshModelsDev),
          ),
      ),
    onOpencodeOAuthStatus: (cb: (event: OpenCodeOAuthStatusEvent) => void) => {
      const removeLocal = subscribeLocalOpenCodeOAuthStatusEvents(cb);
      const removeRemote = subscribeRemoteOpenCodeOAuthStatusEvents(cb);
      return () => {
        removeRemote();
        removeLocal();
      };
    },
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
  transcription: {
    // Hand the captured 16 kHz mono PCM to the main process as a transferable
    // ArrayBuffer. Returns the raw + deterministically-cleaned transcript.
    transcribe: async (
      pcm: ArrayBuffer,
      options?: { sampleRate?: number; format?: "int16" | "float32" },
    ): Promise<{ raw: string; cleaned: string }> =>
      ipcRenderer.invoke(IPC.transcriptionTranscribe, {
        pcm,
        sampleRate: options?.sampleRate,
        format: options?.format ?? "int16",
      }),
    status: async (): Promise<{
      installed: boolean;
      binaryInstalled: boolean;
      modelInstalled: boolean;
      downloading: boolean;
      binaryPath: string | null;
      modelPath: string | null;
    }> => ipcRenderer.invoke(IPC.transcriptionStatus),
    // Download the ~141 MB speech model on demand (first dictation). Resolves
    // with the post-download status. Subscribe to progress via onModelDownloadProgress.
    downloadModel: async (): Promise<{
      installed: boolean;
      binaryInstalled: boolean;
      modelInstalled: boolean;
      downloading: boolean;
      binaryPath: string | null;
      modelPath: string | null;
    }> => ipcRenderer.invoke(IPC.transcriptionDownloadModel),
    onModelDownloadProgress: (
      handler: (progress: { receivedBytes: number; totalBytes: number | null }) => void,
    ): (() => void) => {
      const listener = (
        _event: unknown,
        progress: { receivedBytes: number; totalBytes: number | null },
      ) => handler(progress);
      ipcRenderer.on(IPC.transcriptionModelDownloadProgress, listener);
      return () => ipcRenderer.removeListener(IPC.transcriptionModelDownloadProgress, listener);
    },
    // Check/request macOS microphone permission before capturing. Electron
    // returns a silent track instead of throwing when access is missing, so the
    // renderer must gate getUserMedia on this.
    requestMicAccess: async (): Promise<{
      status: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
    }> => ipcRenderer.invoke(IPC.transcriptionRequestMicAccess),
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
    getLocalStatus: async (args?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> =>
      ipcRenderer.invoke(IPC.syncGetLocalStatus, args),
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
    getRuntimeName: async (): Promise<{ runtimeName: string | null }> =>
      callProjectRuntimeSyncOr("sync.getRuntimeName", {}, () =>
        ipcRenderer.invoke(IPC.syncGetRuntimeName),
      ),
    setRuntimeName: async (name: string): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.setRuntimeName", { name }, () =>
        ipcRenderer.invoke(IPC.syncSetRuntimeName, name),
      ),
    clearRuntimeName: async (): Promise<SyncRoleSnapshot> =>
      callProjectRuntimeSyncOr("sync.clearRuntimeName", {}, () =>
        ipcRenderer.invoke(IPC.syncClearRuntimeName),
      ),
    setActiveLanePresence: async (args: { laneIds: string[] }): Promise<void> =>
      callProjectRuntimeSyncOr("sync.setActiveLanePresence", args, () =>
        ipcRenderer.invoke(IPC.syncSetActiveLanePresence, args),
      ),
    getCloudRelayStatus: async (): Promise<SyncCloudRelayStatus> =>
      callProjectRuntimeSyncOr("sync.getCloudRelayStatus", {}, () =>
        ipcRenderer.invoke(IPC.syncGetCloudRelayStatus),
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
    markGlossaryTermSeen: async (
      termId: string,
    ): Promise<OnboardingHelpState> =>
      callProjectRuntimeActionOr(
        "onboarding",
        "markGlossaryTermSeen",
        { arg: termId },
        () =>
          ipcRenderer.invoke(IPC.onboardingMarkGlossaryTermSeen, { termId }),
      ),
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
    refreshWebhookGatewayStatus: async (): Promise<AutomationWebhookGatewayStatus> =>
      callProjectRuntimeActionOr("automations", "refreshWebhookGatewayStatus", {}, () =>
        ipcRenderer.invoke(IPC.automationsRefreshWebhookGatewayStatus),
      ),
    setWebhookGatewayPublicUrl: async (args: {
      publicUrl?: string | null;
    }): Promise<AutomationWebhookGatewayStatus> =>
      callProjectRuntimeActionOr(
        "automations",
        "setWebhookGatewayPublicUrl",
        { args },
        () => ipcRenderer.invoke(IPC.automationsSetWebhookGatewayPublicUrl, args),
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
    listScheduledCleanups: async (): Promise<AutomationScheduledCleanup[]> =>
      callProjectRuntimeActionOr(
        "automations",
        "listScheduledCleanups",
        {},
        () => ipcRenderer.invoke(IPC.automationsListScheduledCleanups),
      ),
    cancelScheduledCleanup: async (id: string): Promise<boolean> =>
      callProjectRuntimeActionOr(
        "automations",
        "cancelScheduledCleanup",
        { args: { id } },
        () => ipcRenderer.invoke(IPC.automationsCancelScheduledCleanup, { id }),
      ),
    linearIngress: {
      getStatus: async (): Promise<AutomationLinearIngressStatus> =>
        callProjectRuntimeActionOr(
          "automations",
          "linearIngressGetStatus",
          {},
          () => ipcRenderer.invoke(IPC.automationsLinearIngressGetStatus),
        ),
      setup: async (): Promise<AutomationLinearIngressStatus> =>
        callProjectRuntimeActionOr(
          "automations",
          "linearIngressSetup",
          {},
          () => ipcRenderer.invoke(IPC.automationsLinearIngressSetup),
        ),
      teardown: async (): Promise<AutomationLinearIngressStatus> =>
        callProjectRuntimeActionOr(
          "automations",
          "linearIngressTeardown",
          {},
          () => ipcRenderer.invoke(IPC.automationsLinearIngressTeardown),
        ),
      pollNow: async (): Promise<AutomationLinearIngressStatus> =>
        callProjectRuntimeActionOr(
          "automations",
          "linearIngressPollNow",
          {},
          () => ipcRenderer.invoke(IPC.automationsLinearIngressPollNow),
        ),
    },
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
      const localBinding = await getLocalProjectBinding({ fresh: true });
      if (localBinding) {
        return ipcRenderer.invoke(IPC.localRuntimeListActionRegistry, {
          rootPath: localBinding.rootPath,
        });
      }
      return ipcRenderer.invoke(IPC.adeActionsListRegistry);
    },
  },
  attention: {
    getSnapshot: async (
      since = 0,
      streamId?: string | null,
    ): Promise<AttentionSnapshot> =>
      ipcRenderer.invoke(IPC.attentionGetSnapshot, {
        since,
        streamId: streamId?.trim() || null,
      }),
    acknowledge: async (args: {
      itemIds: string[];
      sourceRevisions?: Record<string, number>;
      expectedAccountOwnerId?: string | null;
      seenAt?: string;
      dismissedAt?: string | null;
    }): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionAcknowledge, args),
    reportPresence: async (presence: AttentionPresence): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionReportPresence, presence),
    getPreferences: async (accountOwnerId: string): Promise<AttentionPreferences> =>
      ipcRenderer.invoke(IPC.attentionGetPreferences, { accountOwnerId }),
    putPreferences: async (
      accountOwnerId: string,
      preferences: AttentionPreferences,
    ): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionPutPreferences, {
        accountOwnerId,
        preferences,
      }),
    putMachinePreferences: async (
      accountOwnerId: string,
      machineKey: string,
      preferences: Partial<AttentionPreferenceScope>,
    ): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionPutMachinePreferences, {
        accountOwnerId,
        machineKey,
        preferences,
      }),
    openItem: async (item: AttentionItem): Promise<void> => {
      await ipcRenderer.invoke(IPC.attentionOpenItem, item);
    },
  },
  attentionNotch: {
    publishSnapshot: async (snapshot: AttentionSnapshot): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionNotchPublishSnapshot, snapshot),
    publishToast: async (
      toast: import("../shared/types").AttentionNotchToast,
    ): Promise<void> => ipcRenderer.invoke(IPC.attentionNotchPublishToast, toast),
    updateSettings: async (settings: AttentionNotchSettings): Promise<void> =>
      ipcRenderer.invoke(IPC.attentionNotchUpdateSettings, settings),
    getHealth: async (): Promise<import("../shared/types").AttentionNotchHealth> =>
      ipcRenderer.invoke(IPC.attentionNotchGetHealth),
    retry: async (): Promise<import("../shared/types").AttentionNotchHealth> =>
      ipcRenderer.invoke(IPC.attentionNotchRetry),
    onAcknowledgeRequested: (
      cb: (request: AttentionNotchAcknowledgeRequest) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        request: AttentionNotchAcknowledgeRequest,
      ) => cb(request);
      ipcRenderer.on(IPC.attentionNotchAcknowledgeRequested, listener);
      return () =>
        ipcRenderer.removeListener(IPC.attentionNotchAcknowledgeRequested, listener);
    },
    onRefreshRequested: (cb: (request?: { force?: boolean }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        request?: { force?: boolean },
      ) => cb(request);
      ipcRenderer.on(IPC.attentionNotchRefreshRequested, listener);
      return () =>
        ipcRenderer.removeListener(IPC.attentionNotchRefreshRequested, listener);
    },
    onSettingsChanged: (cb: (settings: AttentionNotchSettings) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        settings: AttentionNotchSettings,
      ) => cb(settings);
      ipcRenderer.on(IPC.attentionNotchSettingsChanged, listener);
      return () =>
        ipcRenderer.removeListener(IPC.attentionNotchSettingsChanged, listener);
    },
  },
  usage: {
    getAdeStats: async (args: GetAdeUsageStatsArgs = {}): Promise<AdeUsageStats | null> => {
      const normalizedArgs: GetAdeUsageStatsArgs = { ...args, scope: args.scope ?? "machine" };
      return callProjectRuntimeActionOr("usage", "getAdeUsageStats", { args: normalizedArgs }, () =>
        ipcRenderer.invoke(IPC.usageGetAdeStats, normalizedArgs),
      );
    },
    getSnapshot: async (): Promise<UsageSnapshot | null> =>
      callProjectRuntimeActionOr("usage", "getUsageSnapshot", {}, () =>
        ipcRenderer.invoke(IPC.usageGetSnapshot),
      ),
    refresh: async (): Promise<UsageSnapshot | null> =>
      callProjectRuntimeActionOr("usage", "forceRefresh", {}, () =>
        ipcRenderer.invoke(IPC.usageRefresh),
      ),
    refreshHistory: async (): Promise<UsageSnapshot | null> =>
      callProjectRuntimeActionOr("usage", "refreshHistory", {}, () =>
        ipcRenderer.invoke(IPC.usageRefreshHistory),
      ),
    noteDemand: async (): Promise<UsageSnapshot | null> =>
      callProjectRuntimeActionOr("usage", "noteQuotaDemand", {}, () =>
        ipcRenderer.invoke(IPC.usageNoteDemand),
      ),
    checkBudget: async (args: BudgetCheckArgs): Promise<BudgetCheckResult> =>
      callProjectRuntimeActionOr("budget", "checkBudget", { args }, () =>
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
      callProjectRuntimeActionOr("budget", "getCumulativeUsage", { args }, () =>
        ipcRenderer.invoke(IPC.usageGetCumulativeUsage, args),
      ),
    getBudgetConfig: async (): Promise<BudgetCapConfig> =>
      callProjectRuntimeActionOr("budget", "getConfig", {}, () =>
        ipcRenderer.invoke(IPC.usageGetBudgetConfig),
      ),
    saveBudgetConfig: async (
      config: BudgetCapConfig,
    ): Promise<BudgetCapConfig> =>
      callProjectRuntimeActionOr(
        "budget",
        "updateConfig",
        { args: config },
        () => ipcRenderer.invoke(IPC.usageSaveBudgetConfig, config),
      ),
    onUpdate: subscribeUsageUpdateEvents,
  },
  lanes: {
    list: async (
      args: ListLanesArgs = {},
      pin?: OpenProjectBinding | null,
    ): Promise<LaneSummary[]> => {
      if (pin) {
        return callPinnedRuntimeAction<LaneSummary[]>(pin, "lane", "list", { args });
      }
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
    create: async (args: CreateLaneArgs, pin?: OpenProjectBinding | null): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = pin
        ? await callPinnedRuntimeAction<LaneSummary>(pin, "lane", "create", { args })
        : await callProjectRuntimeActionOr<LaneSummary>(
            "lane",
            "create",
            { args },
            () => ipcRenderer.invoke(IPC.lanesCreate, args),
          );
      clearGitReadCaches();
      return lane as LaneSummary;
    },
    createChild: async (
      args: CreateChildLaneArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<LaneSummary> => {
      clearGitReadCaches();
      const lane = await callPinnedOrBoundRuntimeActionOr<LaneSummary>(
        pin,
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
    getBranchDrift: async (args: { laneId: string }): Promise<LaneBranchDrift | null> =>
      callProjectRuntimeActionOr("lane", "getBranchDrift", { args }, () =>
        ipcRenderer.invoke(IPC.lanesGetBranchDrift, args),
      ),
    resolveBranchDrift: async (
      args: ResolveLaneBranchDriftArgs,
    ): Promise<ResolveLaneBranchDriftResult> => {
      clearGitReadCaches();
      const result = await callProjectRuntimeActionOr<ResolveLaneBranchDriftResult>(
        "lane",
        "resolveBranchDrift",
        { args },
        () => ipcRenderer.invoke(IPC.lanesResolveBranchDrift, args),
      );
      clearGitReadCaches();
      return result as ResolveLaneBranchDriftResult;
    },
    rename: async (args: RenameLaneArgs, pin?: OpenProjectBinding | null): Promise<void> => {
      clearGitReadCaches();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "lane", "rename", { args });
      } else {
        await callProjectRuntimeActionOr("lane", "rename", { args }, () =>
          ipcRenderer.invoke(IPC.lanesRename, args),
        );
      }
      clearGitReadCaches();
    },
    reparent: async (
      args: ReparentLaneArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<ReparentLaneResult> => {
      clearGitReadCaches();
      const result = await callPinnedOrBoundRuntimeActionOr<ReparentLaneResult>(
        pin,
        "lane",
        "reparent",
        { args },
        () => ipcRenderer.invoke(IPC.lanesReparent, args),
      );
      clearGitReadCaches();
      return result as ReparentLaneResult;
    },
    updateAppearance: async (
      args: UpdateLaneAppearanceArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      clearGitReadCaches();
      await callPinnedOrBoundRuntimeActionOr(
        pin,
        "lane",
        "updateAppearance",
        { args },
        () => ipcRenderer.invoke(IPC.lanesUpdateAppearance, args),
      );
      clearGitReadCaches();
    },
    archive: async (
      args: ArchiveLaneArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      clearGitReadCaches();
      await callPinnedOrBoundRuntimeActionOr(pin, "lane", "archive", { args }, () =>
        ipcRenderer.invoke(IPC.lanesArchive, args),
      );
      clearGitReadCaches();
    },
    archiveAndReclaim: async (
      args: ArchiveAndReclaimLaneArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<ArchiveAndReclaimLaneResult> => {
      clearGitReadCaches();
      const result = await callPinnedOrBoundRuntimeActionOr<ArchiveAndReclaimLaneResult>(
        pin,
        "lane",
        "archiveAndReclaim",
        { args },
        () => ipcRenderer.invoke(IPC.lanesArchiveAndReclaim, args),
      );
      clearGitReadCaches();
      return result;
    },
    unarchive: async (args: ArchiveLaneArgs): Promise<RestoreLaneResult> => {
      clearGitReadCaches();
      const result = await callProjectRuntimeActionOr<RestoreLaneResult>(
        "lane",
        "unarchive",
        { args },
        () => ipcRenderer.invoke(IPC.lanesUnarchive, args),
      );
      clearGitReadCaches();
      return result;
    },
    delete: async (args: DeleteLaneArgs, pin?: OpenProjectBinding | null): Promise<void> => {
      clearGitReadCaches();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "lane", "delete", { args });
      } else {
        await callProjectRuntimeActionOr("lane", "delete", { args }, () =>
          ipcRenderer.invoke(IPC.lanesDelete, args),
        );
      }
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
    getDeleteRisk: async (
      args: { laneId: string },
      pin?: OpenProjectBinding | null,
    ): Promise<LaneDeleteRisk> =>
      callPinnedOrBoundRuntimeActionOr(
        pin,
        "lane",
        "getDeleteRisk",
        { arg: args.laneId },
        () => ipcRenderer.invoke(IPC.lanesGetDeleteRisk, args),
      ),
    getReclaimRisk: async (
      args: { laneId: string },
      pin?: OpenProjectBinding | null,
    ): Promise<LaneReclaimRisk> =>
      callPinnedOrBoundRuntimeActionOr(
        pin,
        "lane",
        "getReclaimRisk",
        { args },
        () => ipcRenderer.invoke(IPC.lanesGetReclaimRisk, args),
      ),
    onDeleteEvent: (
      cb: (ev: LaneDeleteEvent) => void,
      pin?: OpenProjectBinding | null,
    ) => {
      const removePinned = subscribePinnedProjectRuntimeEvents(
        pin,
        (payload) => toWrappedEvent<LaneDeleteEvent>(
          payload,
          "lane_delete_event",
        ),
        cb,
        "lane delete",
        clearGitReadCaches,
      );
      if (removePinned) return removePinned;
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
    onLifecycleEvent: (cb: (ev: LaneLifecycleEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LaneLifecycleEvent,
      ) => cb(payload);
      ipcRenderer.on(IPC.lanesLifecycleEvent, listener);
      const removeRemote = subscribeRemoteLaneLifecycleEvents(cb);
      return () => {
        removeRemote();
        ipcRenderer.removeListener(IPC.lanesLifecycleEvent, listener);
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
    attachLinearIssueToSession: async (args: {
      chatSessionId: string;
      issues: LaneLinearIssue[];
      role?: string;
      source?: string;
      includeInPr?: boolean;
      closeOnMerge?: boolean;
    }): Promise<SessionLinearIssueLink[]> =>
      callProjectRuntimeActionOr("lane", "attachLinearIssueToSession", { args }, () =>
        ipcRenderer.invoke(IPC.lanesAttachLinearIssueToSession, args),
      ),
    detachLinearIssueFromSession: async (args: { chatSessionId: string; issueId?: string }): Promise<boolean> =>
      callProjectRuntimeActionOr("lane", "detachLinearIssueFromSession", { args }, () =>
        ipcRenderer.invoke(IPC.lanesDetachLinearIssueFromSession, args),
      ),
    listLinearIssuesForSession: async (args: { chatSessionId: string }): Promise<SessionLinearIssueLink[]> =>
      callProjectRuntimeActionOr("lane", "listLinearIssuesForSession", { args }, () =>
        ipcRenderer.invoke(IPC.lanesListLinearIssuesForSession, args),
      ),
    listLinearIssuesForLaneSessions: async (args: { laneId: string }): Promise<SessionLinearIssueLink[]> =>
      callProjectRuntimeActionOr("lane", "listLinearIssuesForLaneSessions", { args }, () =>
        ipcRenderer.invoke(IPC.lanesListLinearIssuesForLaneSessions, args),
      ),
    unlinkLinearIssues: async (args: { laneId: string; issueId?: string }): Promise<boolean> =>
      callProjectRuntimeActionOr("lane", "unlinkLinearIssues", { args }, () =>
        ipcRenderer.invoke(IPC.lanesUnlinkLinearIssues, args),
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
    ): Promise<LanePreviewInfo | null> => {
      const binding = await getProjectRuntimeBinding();
      if (binding?.kind === "remote") {
        const runtime =
          await callProjectRuntimeActionIfBound<LanePreviewInfo | null>(
            "lane",
            "proxyGetPreviewInfo",
            { args },
          );
        if (runtime.handled) {
          const activeBinding = await getProjectRuntimeBinding();
          if (activeBinding?.kind !== "remote") {
            return ipcRenderer.invoke(IPC.lanesProxyGetPreviewInfo, args);
          }
          return localizeRemoteLanePreviewInfo(activeBinding, runtime.result);
        }
      }
      return ipcRenderer.invoke(IPC.lanesProxyGetPreviewInfo, args);
    },
    proxyOpenPreview: async (args: OpenPreviewArgs): Promise<void> => {
      const binding = await getProjectRuntimeBinding();
      if (binding?.kind === "remote") {
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
        const activeBinding = await getProjectRuntimeBinding();
        if (activeBinding?.kind !== "remote") {
          await ipcRenderer.invoke(IPC.lanesProxyOpenPreview, args);
          return;
        }
        const info = await localizeRemoteLanePreviewInfo(activeBinding, runtime.result);
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
      pin?: OpenProjectBinding | null,
    ): Promise<TerminalSessionSummary[]> => {
      if (pin) {
        return callPinnedRuntimeAction<TerminalSessionSummary[]>(pin, "session", "list", { args });
      }
      const runtime = await callProjectRuntimeActionIfBound<
        TerminalSessionSummary[]
      >("session", "list", { args });
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.sessionsList, args);
    },
    get: async (
      sessionId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<TerminalSessionDetail | null> => {
      if (pin) {
        return callPinnedRuntimeAction<TerminalSessionDetail | null>(pin, "session", "get", {
          arg: sessionId,
        });
      }
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
    delete: async (
      args: DeleteSessionArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      sessionDeltaCache.clear();
      await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "deleteSession",
        {
          arg: args.sessionId,
        },
        () => ipcRenderer.invoke(IPC.sessionsDelete, args),
      );
      sessionDeltaCache.clear();
    },
    updateMeta: async (
      args: UpdateSessionMetaArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<TerminalSessionSummary | null> => {
      sessionDeltaCache.clear();
      const updated = await callPinnedOrBoundRuntimeActionOr<TerminalSessionSummary | null>(
        pin,
        "session",
        "updateMeta",
        { args },
        () => ipcRenderer.invoke(IPC.sessionsUpdateMeta, args),
      );
      sessionDeltaCache.clear();
      return updated;
    },
    settle: async (
      sessionId: string,
      opts?: { outcome?: string; dismissPendingInput?: boolean },
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      const args = {
        sessionId,
        ...(opts?.outcome ? { outcome: opts.outcome } : {}),
        ...(opts?.dismissPendingInput ? { dismissPendingInput: true } : {}),
      };
      await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "settleSession",
        { args },
        () => ipcRenderer.invoke(IPC.sessionsSettle, { sessionId, opts }),
      );
    },
    unsettle: async (
      sessionId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "unsettleSession",
        { args: { sessionId } },
        () => ipcRenderer.invoke(IPC.sessionsUnsettle, { sessionId }),
      );
    },
    settleMany: async (sessionIds: string[]): Promise<string[]> => {
      const runtime = await callProjectRuntimeActionIfBound<string[]>(
        "session",
        "settleSessions",
        { args: { sessionIds } },
      );
      return runtime.handled
        ? runtime.result ?? []
        : ipcRenderer.invoke(IPC.sessionsSettleMany, { sessionIds });
    },
    unsettleMany: async (sessionIds: string[]): Promise<void> => {
      const runtime = await callProjectRuntimeActionIfBound<unknown>(
        "session",
        "unsettleSessions",
        { args: { sessionIds } },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.sessionsUnsettleMany, { sessionIds });
    },
    snoozeSession: async (
      sessionId: string,
      untilIso: string,
      pin?: OpenProjectBinding | null,
    ): Promise<boolean> => {
      const result = await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "snoozeSession",
        { args: { sessionId, untilIso } },
        () => ipcRenderer.invoke(IPC.sessionsSnooze, { sessionId, untilIso }),
      );
      return sessionLifecycleApplied(result);
    },
    wakeSession: async (
      sessionId: string,
      reason?: SessionWakeReason,
      pin?: OpenProjectBinding | null,
    ): Promise<boolean> => {
      const args = { sessionId, ...(reason ? { reason } : {}) };
      const result = await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "wakeSession",
        { args },
        () => ipcRenderer.invoke(IPC.sessionsWake, args),
      );
      return sessionLifecycleApplied(result);
    },
    snoozeSessions: async (
      sessionIds: string[],
      untilIso: string,
    ): Promise<string[]> => {
      const runtime = await callProjectRuntimeActionIfBound<string[]>(
        "session",
        "snoozeSessions",
        { args: { sessionIds, untilIso } },
      );
      return runtime.handled
        ? runtime.result ?? []
        : ipcRenderer.invoke(IPC.sessionsSnoozeMany, { sessionIds, untilIso });
    },
    wakeSessions: async (
      sessionIds: string[],
      reason?: SessionWakeReason,
    ): Promise<string[]> => {
      const runtime = await callProjectRuntimeActionIfBound<string[]>(
        "session",
        "wakeSessions",
        { args: { sessionIds, ...(reason ? { reason } : {}) } },
      );
      return runtime.handled
        ? runtime.result ?? []
        : ipcRenderer.invoke(IPC.sessionsWakeMany, { sessionIds, ...(reason ? { reason } : {}) });
    },
    setSettleOverride: async (
      sessionId: string,
      override: SessionSettleOverride | null,
      pin?: OpenProjectBinding | null,
    ): Promise<boolean> => {
      const args = { sessionId, override };
      const result = await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "setSettleOverride",
        { args },
        () => ipcRenderer.invoke(IPC.sessionsSetSettleOverride, args),
      );
      return sessionLifecycleApplied(result);
    },
    clearWokeMarker: async (
      sessionId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<boolean> => {
      const args = { sessionId };
      const result = await callPinnedOrBoundRuntimeActionOr<unknown>(
        pin,
        "session",
        "clearWokeMarker",
        { args },
        () => ipcRenderer.invoke(IPC.sessionsClearWokeMarker, args),
      );
      return sessionLifecycleApplied(result);
    },
    getLifecycleSettings: async (): Promise<SessionLifecycleSettings> => {
      const runtime = await callProjectRuntimeActionIfBound<SessionLifecycleSettings>(
        "session",
        "getLifecycleSettings",
      );
      return runtime.handled
        ? runtime.result!
        : ipcRenderer.invoke(IPC.sessionsLifecycleSettingsGet);
    },
    updateLifecycleSettings: async (
      settings: SessionLifecycleSettings,
    ): Promise<SessionLifecycleSettings> => {
      const runtime = await callProjectRuntimeActionIfBound<SessionLifecycleSettings>(
        "session",
        "updateLifecycleSettings",
        { args: settings },
      );
      return runtime.handled
        ? runtime.result!
        : ipcRenderer.invoke(IPC.sessionsLifecycleSettingsUpdate, settings);
    },
    readTranscriptTail: async (
      args: ReadTranscriptTailArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<string> => {
      if (pin) {
        return callPinnedRuntimeAction<string>(pin, "session", "readTranscriptTail", { args });
      }
      const runtime = await callProjectRuntimeActionIfBound<string>(
        "session",
        "readTranscriptTail",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.sessionsReadTranscriptTail, args);
    },
    getDelta: async (
      sessionId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<SessionDeltaSummary | null> =>
      pin
        ? callPinnedRuntimeAction<SessionDeltaSummary | null>(
            pin,
            "session",
            "getDelta",
            { args: { sessionId } },
          )
        : sessionDeltaCache.get(sessionId),
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
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSessionSummary | null> => {
      const sessionId =
        typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return ipcRenderer.invoke(IPC.agentChatGetSummary, args);
      if (pin) {
        return callPinnedRuntimeAction<AgentChatSessionSummary | null>(
          pin,
          "chat",
          "getSessionSummary",
          { arg: sessionId },
        );
      }
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
    create: async (args: AgentChatCreateArgs, pin?: OpenProjectBinding | null): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const session = pin
        ? await callPinnedRuntimeAction<AgentChatSession>(pin, "chat", "createSession", { args })
        : await (async () => {
            const runtime = await callProjectRuntimeActionIfBound<AgentChatSession>(
              "chat",
              "createSession",
              { args },
            );
            return runtime.handled
              ? runtime.result
              : await ipcRenderer.invoke(IPC.agentChatCreate, args);
          })();
      agentChatSummaryCache.clear();
      return session as AgentChatSession;
    },
    launch: async (args: AgentChatLaunchArgs): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const runtime = await callProjectRuntimeActionIfBound<AgentChatSession>(
        "chat",
        "launchHeadless",
        { args },
      );
      const session = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.agentChatLaunch, args);
      agentChatSummaryCache.clear();
      return session as AgentChatSession;
    },
    launchCli: async (
      args: AgentChatLaunchCliArgs,
    ): Promise<AgentChatLaunchCliResult> => {
      agentChatSummaryCache.clear();
      const runtime =
        await callProjectRuntimeActionIfBound<AgentChatLaunchCliResult>(
          "chat",
          "launchCli",
          { args },
        );
      const result = runtime.handled
        ? runtime.result
        : await ipcRenderer.invoke(IPC.agentChatLaunchCli, args);
      agentChatSummaryCache.clear();
      return result as AgentChatLaunchCliResult;
    },
    suggestLaneName: async (
      args: AgentChatSuggestLaneNameArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<string> =>
      pin
        ? callPinnedRuntimeAction<string>(pin, "chat", "suggestLaneNameFromPrompt", { args })
        : callProjectRuntimeActionOr(
            "chat",
            "suggestLaneNameFromPrompt",
            { args },
            () => ipcRenderer.invoke(IPC.agentChatSuggestLaneName, args),
          ),
    generateAutoLaneIdentity: async (
      args: AgentChatSuggestLaneNameArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AutoLaneIdentitySuggestion> =>
      pin
        ? callPinnedRuntimeAction<AutoLaneIdentitySuggestion>(pin, "chat", "generateAutoLaneIdentity", { args })
        : callProjectRuntimeActionOr(
            "chat",
            "generateAutoLaneIdentity",
            { args },
            () => ipcRenderer.invoke(IPC.agentChatGenerateAutoLaneIdentity, args),
          ),
    parallelLaunchState: {
      get: async (
        args: AgentChatParallelLaunchStateArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<AgentChatParallelLaunchState | null> =>
        callPinnedOrBoundRuntimeActionOr(
          pin,
          "chat",
          "getParallelLaunchState",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatParallelLaunchStateGet, args),
        ),
      set: async (
        args: AgentChatSetParallelLaunchStateArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<void> =>
        callPinnedOrBoundRuntimeActionOr(
          pin,
          "chat",
          "setParallelLaunchState",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatParallelLaunchStateSet, args),
        ),
    },
    handoff: async (
      args: AgentChatHandoffArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatHandoffResult> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "handoffSession", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatHandoff, args),
      ),
    prepareCrossMachineHandoff: async (
      args: AgentChatPrepareCrossMachineHandoffArgs,
    ): Promise<AgentChatPrepareCrossMachineHandoffResult> =>
      callProjectRuntimeActionOr("chat", "prepareCrossMachineHandoff", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatPrepareCrossMachineHandoff, args),
      ),
    validateCrossMachineSource: async (
      args: AgentChatValidateCrossMachineSourceArgs,
    ): Promise<void> =>
      callProjectRuntimeActionOr("chat", "validateCrossMachineSource", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatValidateCrossMachineSource, args),
      ),
    markCrossMachineHandoff: async (
      args: AgentChatMarkCrossMachineHandoffArgs,
    ): Promise<void> =>
      callProjectRuntimeActionOr("chat", "markCrossMachineHandoff", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatMarkCrossMachineHandoff, args),
      ),
    send: async (args: AgentChatSendArgs, pin?: OpenProjectBinding | null): Promise<void> => {
      agentChatSummaryCache.clear();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "chat", "sendMessage", { args });
      } else {
        const runtime = await callProjectRuntimeActionIfBound<void>(
          "chat",
          "sendMessage",
          { args },
        );
        if (!runtime.handled) await ipcRenderer.invoke(IPC.agentChatSend, args);
      }
      agentChatSummaryCache.clear();
    },
    steer: async (
      args: AgentChatSteerArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSteerResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatSteerResult>(pin, "chat", "steer", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatSteer, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    cancelSteer: async (
      args: AgentChatCancelSteerArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      await callPinnedOrBoundRuntimeActionOr(pin, "chat", "cancelSteer", { args }, () =>
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
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatDispatchSteerResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatDispatchSteerResult>(
        pin,
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
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatCancelDispatchedSteerResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "cancelDispatchedSteer",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatCancelDispatchedSteer, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    interrupt: async (
      args: AgentChatInterruptArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatInterruptResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatInterruptResult>(
        pin,
        "chat",
        "interrupt",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatInterrupt, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    restoreCancelledQueue: async (
      args: AgentChatRestoreCancelledQueueArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatRestoreCancelledQueueResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatRestoreCancelledQueueResult>(
        pin,
        "chat",
        "restoreCancelledQueue",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatRestoreCancelledQueue, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    recoverTurn: async (
      args: AgentChatRecoverTurnArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatRecoverTurnResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatRecoverTurnResult>(
        pin,
        "chat",
        "recoverTurn",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatRecoverTurn, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    recoverCodexTurn: async (
      args: AgentChatRecoverCodexTurnArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatRecoverCodexTurnResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatRecoverCodexTurnResult>(
        pin,
        "chat",
        "recoverCodexTurn",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatRecoverCodexTurn, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    resolveUnprocessedMessage: async (
      args: AgentChatResolveUnprocessedMessageArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatResolveUnprocessedMessageResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatResolveUnprocessedMessageResult>(
        pin,
        "chat",
        "resolveUnprocessedMessage",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatResolveUnprocessedMessage, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    recoverContinuity: async (
      args: AgentChatRecoverContinuityArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatContinuityRecoveryResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr<AgentChatContinuityRecoveryResult>(
        pin,
        "chat",
        "recoverContinuity",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatRecoverContinuity, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    approve: async (
      args: AgentChatApproveArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "chat", "approveToolUse", { args });
        agentChatSummaryCache.clear();
        return;
      }
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
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "chat", "respondToInput", { args });
        agentChatSummaryCache.clear();
        return;
      }
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
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatModelInfo[]> => {
      if (pin) {
        return callPinnedRuntimeAction<AgentChatModelInfo[]>(
          pin,
          "chat",
          "getAvailableModels",
          { args },
        );
      }
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
    archive: async (
      args: AgentChatArchiveArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "chat", "archiveSession", { args });
        agentChatSummaryCache.clear();
        return;
      }
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "archiveSession",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatArchive, args);
      agentChatSummaryCache.clear();
    },
    unarchive: async (
      args: AgentChatArchiveArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      agentChatSummaryCache.clear();
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "chat", "unarchiveSession", { args });
        agentChatSummaryCache.clear();
        return;
      }
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "chat",
        "unarchiveSession",
        { args },
      );
      if (!runtime.handled)
        await ipcRenderer.invoke(IPC.agentChatUnarchive, args);
      agentChatSummaryCache.clear();
    },
    delete: async (args: AgentChatDeleteArgs, pin?: OpenProjectBinding | null): Promise<void> => {
      agentChatSummaryCache.clear();
      await callPinnedOrBoundRuntimeActionOr<void>(
        pin,
        "chat",
        "deleteSession",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatDelete, args),
      );
      agentChatSummaryCache.clear();
    },
    updateSession: async (
      args: AgentChatUpdateSessionArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSession> => {
      agentChatSummaryCache.clear();
      const session = await callPinnedOrBoundRuntimeActionOr<AgentChatSession>(
        pin,
        "chat",
        "updateSession",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatUpdateSession, args),
      );
      agentChatSummaryCache.clear();
      return session;
    },
    createScheduledWork: async (
      args: AgentChatCreateScheduledWorkArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatCreateScheduledWorkResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "createScheduledWork",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatCreateScheduledWork, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    listScheduledWork: async (
      args: AgentChatListScheduledWorkArgs = {},
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatScheduledWorkItem[]> =>
      callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "listScheduledWork",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatListScheduledWork, args),
      ),
    cancelScheduledWork: async (
      args: AgentChatCancelScheduledWorkArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatCancelScheduledWorkResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "cancelScheduledWork",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatCancelScheduledWork, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    setScheduledWorkPaused: async (
      args: AgentChatSetScheduledWorkPausedArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSetScheduledWorkPausedResult> => {
      agentChatSummaryCache.clear();
      const result = await callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "setScheduledWorkPaused",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatSetScheduledWorkPaused, args),
      );
      agentChatSummaryCache.clear();
      return result;
    },
    warmupModel: async (
      args: {
        sessionId: string;
        modelId: string;
      },
      pin?: OpenProjectBinding | null,
    ): Promise<void> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "warmupModel", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatWarmupModel, args),
      ),
    onEvent: subscribeAgentChatEvents,
    slashCommands: async (
      args: AgentChatSlashCommandsArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSlashCommand[]> => {
      if (pin) {
        const pinned = await callPinnedRuntimeAction<AgentChatSlashCommand[]>(
          pin,
          "chat",
          "getSlashCommands",
          { args },
        );
        return Array.isArray(pinned) ? pinned : [];
      }
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
    getMainTranscript: async (
      args: AgentChatMainTranscriptArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSubagentTranscriptMessage[] | null> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "getMainTranscript", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetMainTranscript, args),
      ),
    getSubagentTranscript: async (
      args: AgentChatSubagentTranscriptArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSubagentTranscriptMessage[] | null> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "getSubagentTranscript", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetSubagentTranscript, args),
      ),
    getContextUsage: async (
      args: AgentChatContextUsageArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatContextUsage | null> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "getContextUsage", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetContextUsage, args),
      ),
    rewindFiles: async (
      args: AgentChatRewindFilesArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatRewindFilesResult> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "rewindFiles", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatRewindFiles, args),
      ),
    fileSearch: async (
      args: AgentChatFileSearchArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatFileSearchResult[]> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "fileSearch", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatFileSearch, args),
      ),
    // Composer @-mention suggestions. Daemon-routed by design (same rule as
    // universal search): there is no in-process IPC fallback, so packaged and
    // remote-bound windows behave identically. An unbound runtime yields an
    // empty menu section rather than a hard error.
    listMentionSuggestions: async (
      args: ChatMentionSuggestArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<ChatMentionSuggestResult> =>
      callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "listMentionSuggestions",
        { args },
        async () => ({ suggestions: [] }),
      ),
    promptStashes: {
      list: async (
        pin?: OpenProjectBinding | null,
      ): Promise<PromptStashEntry[]> =>
        callPinnedOrBoundRuntimeActionOr(
          pin,
          "chat",
          "listPromptStashes",
          {},
          () => ipcRenderer.invoke(IPC.agentChatPromptStashesList),
        ),
      create: async (
        args: PromptStashCreateArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<PromptStashEntry> =>
        callPinnedOrBoundRuntimeActionOr(
          pin,
          "chat",
          "createPromptStash",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatPromptStashesCreate, args),
        ),
      delete: async (
        args: PromptStashDeleteArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<boolean> =>
        callPinnedOrBoundRuntimeActionOr(
          pin,
          "chat",
          "deletePromptStash",
          { args },
          () => ipcRenderer.invoke(IPC.agentChatPromptStashesDelete, args),
        ),
    },
    getTurnFileDiff: async (
      args: AgentChatGetTurnFileDiffArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatTurnFileDiff | null> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "getTurnFileDiff", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatGetTurnFileDiff, args),
      ),
    listSubagents: async (
      args: AgentChatSubagentListArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSubagentSnapshot[]> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "listSubagents", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatListSubagents, args),
      ),
    killDroidWorker: async (
      args: AgentChatKillDroidWorkerArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<void> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "killDroidWorker", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatKillDroidWorker, args),
      ),
    getSessionCapabilities: async (
      args: AgentChatSessionCapabilitiesArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatSessionCapabilities> =>
      callPinnedOrBoundRuntimeActionOr(
        pin,
        "chat",
        "getSessionCapabilities",
        { args },
        () => ipcRenderer.invoke(IPC.agentChatGetSessionCapabilities, args),
      ),
    saveTempAttachment: async (
      args: {
        data: string;
        filename: string;
      },
      pin?: OpenProjectBinding | null,
    ): Promise<{ path: string }> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "saveTempAttachment", { args }, () =>
        ipcRenderer.invoke(IPC.agentChatSaveTempAttachment, args),
      ),
    getImageDataUrl: async (
      path: string,
      pin?: OpenProjectBinding | null,
    ): Promise<{ dataUrl: string }> =>
      callPinnedOrBoundRuntimeActionOr(pin, "chat", "getImageDataUrl", { args: { path } }, () =>
        ipcRenderer.invoke(IPC.appGetImageDataUrl, { path }),
      ),
    resolveSmartLinkPreview: async (args: { url: string }): Promise<SmartLinkPreview | null> =>
      callProjectRuntimeActionOr("chat", "resolveSmartLinkPreview", { args }, async () =>
        deriveSmartLinkPreview(args.url),
      ),
    getEventHistory: async (
      args: {
        sessionId: string;
        maxEvents?: number;
        maxBytes?: number;
      },
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatEventHistorySnapshot> => {
      const historyOptions = {
        ...(args.maxEvents != null ? { maxEvents: args.maxEvents } : {}),
        ...(args.maxBytes != null ? { maxBytes: args.maxBytes } : {}),
      };
      if (pin) {
        return callPinnedRuntimeAction<AgentChatEventHistorySnapshot>(pin, "chat", "getChatEventHistory", {
          args: { sessionId: args.sessionId, ...historyOptions },
        });
      }
      const runtime = await callProjectRuntimeActionIfBound<AgentChatEventHistorySnapshot>("chat", "getChatEventHistory", {
        args: { sessionId: args.sessionId, ...historyOptions },
      });
      if (runtime.handled) return runtime.result;
      // Read-only chat calls are intentionally left unhandled while a project
      // transition is in flight. For a REMOTE runtime we must not fall through
      // to the local main-process chat service: it has never heard of the
      // remote session id, so it answers `sessionFound: false` — a FALSE
      // "this session does not exist" that the renderer treats as
      // authoritative and uses to wipe the transcript and its cache. Report
      // "runtime temporarily unreachable" instead so the renderer keeps what
      // it has and re-queries once the switch settles. Local bindings keep the
      // IPC fallback below: there the local service IS the right answer.
      if (isRemoteProjectRuntimeContext()) {
        return {
          sessionId: args.sessionId,
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: false,
          hasOlderHistory: false,
          unavailable: true,
        };
      }
      return ipcRenderer.invoke(IPC.agentChatGetEventHistory, args);
    },
    getEventHistoryPage: async (
      args: {
        sessionId: string;
        beforeOffset: number;
        maxBytes?: number;
      },
      pin?: OpenProjectBinding | null,
    ): Promise<AgentChatEventHistoryPage> => {
      const historyPageArgs = {
        sessionId: args.sessionId,
        beforeOffset: args.beforeOffset,
        ...(args.maxBytes != null ? { maxBytes: args.maxBytes } : {}),
      };
      if (pin) {
        return callPinnedRuntimeAction<AgentChatEventHistoryPage>(pin, "chat", "getChatEventHistoryPage", {
          args: historyPageArgs,
        });
      }
      const runtime = await callProjectRuntimeActionIfBound<AgentChatEventHistoryPage>("chat", "getChatEventHistoryPage", {
        args: historyPageArgs,
      });
      if (runtime.handled) return runtime.result;
      // See getEventHistory: answering a REMOTE session from the local
      // main-process service yields a FALSE `sessionFound: false` that the
      // renderer acts on destructively. Return an unreachable-runtime page and
      // keep the caller's cursor (`startOffset: args.beforeOffset`) so we do
      // not also claim the head of the transcript was reached. Local bindings
      // still fall through to IPC.
      if (isRemoteProjectRuntimeContext()) {
        return {
          sessionId: args.sessionId,
          events: [],
          startOffset: args.beforeOffset,
          hasMore: false,
          sessionFound: false,
          unavailable: true,
        };
      }
      return ipcRenderer.invoke(IPC.agentChatGetEventHistoryPage, args);
    },
    codex: {
      getGoal: (
        args: AgentChatCodexGetGoalArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<CodexThreadGoal | null> =>
        callPinnedOrBoundRuntimeActionOr(pin, "chat", "getCodexGoal", { args }, () =>
          ipcRenderer.invoke(IPC.agentChatCodexGetGoal, args),
        ),
      setGoal: async (
        args: AgentChatCodexSetGoalArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<CodexThreadGoal | null> => {
        agentChatSummaryCache.clear();
        const goal = await callPinnedOrBoundRuntimeActionOr(pin, "chat", "setCodexGoal", { args }, () =>
          ipcRenderer.invoke(IPC.agentChatCodexSetGoal, args),
        );
        agentChatSummaryCache.clear();
        return goal as CodexThreadGoal | null;
      },
      setGoalStatus: async (
        args: AgentChatCodexSetGoalStatusArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<CodexThreadGoal | null> => {
        agentChatSummaryCache.clear();
        const goal = await callPinnedOrBoundRuntimeActionOr(pin, "chat", "setCodexGoalStatus", { args }, () =>
          ipcRenderer.invoke(IPC.agentChatCodexSetGoalStatus, args),
        );
        agentChatSummaryCache.clear();
        return goal as CodexThreadGoal | null;
      },
      clearGoal: async (
        args: AgentChatCodexClearGoalArgs,
        pin?: OpenProjectBinding | null,
      ): Promise<CodexThreadGoal | null> => {
        agentChatSummaryCache.clear();
        const goal = await callPinnedOrBoundRuntimeActionOr(pin, "chat", "clearCodexGoal", { args }, () =>
          ipcRenderer.invoke(IPC.agentChatCodexClearGoal, args),
        );
        agentChatSummaryCache.clear();
        return goal as CodexThreadGoal | null;
      },
    },
    readTranscript: (args: {
      sessionId: string;
      limit?: number;
      since?: string;
    }) => ipcRenderer.invoke(IPC.agentChatReadTranscript, args),
  },
  orchestration: createOrchestrationBridge({
    callAction: (action, args, ipcChannel, pin) => {
      const request = { args: args as Record<string, unknown> | undefined };
      return pin
        ? callPinnedRuntimeAction(pin, "orchestration", action, request)
        : callProjectRuntimeActionOr(
            "orchestration",
            action,
            request,
            () => ipcRenderer.invoke(ipcChannel, args),
          );
    },
    subscribeRuntimeOrchestrationEvents: registerRemoteOrchestrationEventCallback,
    parseLegacyEvent: toOrchestrationRuntimeEvent,
    ipcRenderer,
  }),
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
      pin?: OpenProjectBinding | null,
    ): Promise<ComputerUseOwnerSnapshot> =>
      pin
        ? callPinnedRuntimeAction<ComputerUseOwnerSnapshot>(
            pin,
            "computer_use_artifacts",
            "getOwnerSnapshot",
            { args },
          )
        : computerUseOwnerSnapshotCache.get(serializeIpcCacheArgs(args)),
    deleteArtifacts: async (
      args: ComputerUseArtifactDeleteArgs,
    ): Promise<ComputerUseArtifactDeleteResult> =>
      clearAround(
        () => computerUseOwnerSnapshotCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "computer_use_artifacts",
            "deleteArtifacts",
            { args },
            () => ipcRenderer.invoke(IPC.computerUseDeleteArtifacts, args),
          ),
      ),
    listBrokenArtifacts: async (
      args: { limit?: number } = {},
    ): Promise<ComputerUseArtifactBrokenRecord[]> =>
      callProjectRuntimeActionOr(
        "computer_use_artifacts",
        "listBrokenArtifacts",
        { args },
        () => ipcRenderer.invoke(IPC.computerUseListBrokenArtifacts, args),
      ),
    pruneBrokenArtifacts: async (): Promise<ComputerUseArtifactDeleteResult> =>
      clearAround(
        () => computerUseOwnerSnapshotCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "computer_use_artifacts",
            "pruneBrokenArtifacts",
            { args: {} },
            () => ipcRenderer.invoke(IPC.computerUsePruneBrokenArtifacts),
          ),
      ),
    recoverArtifact: async (
      args: { artifactId: string },
    ): Promise<ComputerUseArtifactView> =>
      clearAround(
        () => computerUseOwnerSnapshotCache.clear(),
        () =>
          callProjectRuntimeActionOr(
            "computer_use_artifacts",
            "recoverArtifact",
            { args },
            () => ipcRenderer.invoke(IPC.computerUseRecoverArtifact, args),
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
    resolvePreviewMatch: async (
      args: IosSimulatorListPreviewsArgs = {},
    ): Promise<IosSimulatorPreviewMatch> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "resolvePreviewMatch",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorResolvePreviewMatch, args),
      ),
    ensurePreviewWorkspace: async (
      args: IosSimulatorEnsurePreviewWorkspaceArgs = {},
    ): Promise<IosSimulatorEnsurePreviewWorkspaceResult> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "ensurePreviewWorkspace",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorEnsurePreviewWorkspace, args),
      ),
    renderCurrentPreview: async (
      args: IosSimulatorRenderCurrentPreviewArgs = {},
    ): Promise<IosSimulatorRenderCurrentPreviewResult> =>
      callProjectRuntimeActionOr(
        "ios_simulator",
        "renderCurrentPreview",
        { args },
        () => ipcRenderer.invoke(IPC.iosSimulatorRenderCurrentPreview, args),
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
      const binding = await requireLocalProjectHostBinding("iOS Simulator window sources");
      return ipcRenderer.invoke(IPC.iosSimulatorListWindowSources, {
        projectRoot: binding.rootPath,
      });
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
    focusWindow: async (): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "focusWindow", {}, () =>
        ipcRenderer.invoke(IPC.appControlFocusWindow),
      ),
    minimizeWindow: async (): Promise<{ ok: true }> =>
      callProjectRuntimeActionOr("app_control", "minimizeWindow", {}, () =>
        ipcRenderer.invoke(IPC.appControlMinimizeWindow),
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
      coordinateSpace?: "screenshot" | "viewport" | null;
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
    getStatus: async (
      args: BuiltInBrowserProjectScopeArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      builtInBrowserStatusCache.get(serializeIpcCacheArgs(args)),
    requestOriginAccess: async (
      args: BuiltInBrowserRequestOriginAccessArgs = {},
    ): Promise<BuiltInBrowserOriginAccessResult> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserRequestOriginAccess, args),
      ),
    getProfileDiagnostics: async (): Promise<BuiltInBrowserProfileDiagnostics> =>
      ipcRenderer.invoke(IPC.builtInBrowserGetProfileDiagnostics),
    listPermissions: async (): Promise<BuiltInBrowserPermissionsResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserListPermissions),
    clearPermissions: async (
      args: BuiltInBrowserClearPermissionsArgs = {},
    ): Promise<BuiltInBrowserClearPermissionsResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserClearPermissions, args),
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
    reload: async (
      args: BuiltInBrowserTabTargetArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserReload, args),
      ),
    goBack: async (
      args: BuiltInBrowserTabTargetArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserGoBack, args),
      ),
    goForward: async (
      args: BuiltInBrowserTabTargetArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserGoForward, args),
      ),
    stop: async (
      args: BuiltInBrowserTabTargetArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStop, args),
      ),
    startInspect: async (
      args: BuiltInBrowserProjectScopeArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStartInspect, args),
      ),
    stopInspect: async (
      args: BuiltInBrowserProjectScopeArgs = {},
    ): Promise<BuiltInBrowserStatus> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserStopInspect, args),
      ),
    captureScreenshot: async (
      args: BuiltInBrowserTabTargetArgs = {},
    ): Promise<BuiltInBrowserScreenshot> =>
      ipcRenderer.invoke(IPC.builtInBrowserCaptureScreenshot, args),
    selectPoint: async (
      args: BuiltInBrowserSelectPointArgs,
    ): Promise<BuiltInBrowserSelectResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserSelectPoint, args),
    selectCurrent: async (
      args: BuiltInBrowserProjectScopeArgs = {},
    ): Promise<BuiltInBrowserSelectResult> =>
      ipcRenderer.invoke(IPC.builtInBrowserSelectCurrent, args),
    clearSelection: async (
      args: BuiltInBrowserProjectScopeArgs = {},
    ): Promise<{ ok: true }> =>
      clearAround(
        () => builtInBrowserStatusCache.clear(),
        () => ipcRenderer.invoke(IPC.builtInBrowserClearSelection, args),
      ),
    onEvent: builtInBrowserEventFanout,
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
      pin?: OpenProjectBinding | null,
    ): Promise<ChatTerminalPreviewResult> =>
      callPinnedOrBoundRuntimeActionOr<ChatTerminalPreviewResult>(
        pin,
        "terminal",
        "preview",
        { args },
        () => ipcRenderer.invoke(IPC.terminalPreview, args),
      ),
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
  // Universal search is daemon-only by design: it always routes through the
  // ADE runtime action bridge (never an in-process IPC fallback) so packaged
  // and remote-bound windows behave identically.
  search: {
    query: async (args: SearchQueryArgs): Promise<SearchQueryResult> => {
      const outcome = await callProjectRuntimeActionIfBound<SearchQueryResult>("search", "query", { args });
      if (outcome.handled && outcome.result) return outcome.result;
      return { results: [], totalByKind: {}, nextCursor: null };
    },
    indexStatus: async (): Promise<SearchIndexStatus | null> => {
      const outcome = await callProjectRuntimeActionIfBound<SearchIndexStatus>("search", "indexStatus", {});
      return outcome.handled ? outcome.result ?? null : null;
    },
    rebuildIndex: async (): Promise<SearchRebuildResult> => {
      const outcome = await callProjectRuntimeActionIfBound<SearchRebuildResult>("search", "rebuildIndex", {});
      if (outcome.handled && outcome.result) return outcome.result;
      return { started: false };
    },
  },
  externalSessions: {
    list: async (args: ExternalSessionListArgs = {}): Promise<ExternalSessionSummary[]> => {
      const runtime = await callProjectRuntimeActionIfBound<ExternalSessionSummary[]>(
        "external-sessions",
        "list",
        { args: { ...args } },
      );
      return runtime.handled
        ? runtime.result ?? []
        : ipcRenderer.invoke(IPC.externalSessionsList, args);
    },
    import: async (args: ExternalSessionImportArgs): Promise<ExternalSessionImportResult> => {
      const runtime = await callProjectRuntimeActionIfBound<ExternalSessionImportResult>(
        "external-sessions",
        "import",
        { args: { ...args } },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.externalSessionsImport, args);
    },
  },
  pty: {
    create: async (args: PtyCreateArgs, pin?: OpenProjectBinding | null): Promise<PtyCreateResult> => {
      if (pin) {
        return callPinnedRuntimeAction<PtyCreateResult>(pin, "pty", "create", { args });
      }
      const runtime = await callProjectRuntimeActionIfBound<PtyCreateResult>(
        "pty",
        "create",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.ptyCreate, args);
    },
    resumeSession: async (
      args: PtyResumeSessionArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<PtyResumeSessionResult> =>
      callPinnedOrBoundRuntimeActionOr<PtyResumeSessionResult>(
        pin,
        "pty",
        "resumeSession",
        { args },
        () => ipcRenderer.invoke(IPC.ptyResumeSession, args),
      ),
    sendToSession: async (
      args: PtySendToSessionArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<PtySendToSessionResult> => {
      if (pin) {
        return callPinnedRuntimeAction<PtySendToSessionResult>(pin, "pty", "sendToSession", { args });
      }
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
    write: async (
      arg: { ptyId: string; data: string },
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "pty", "write", { args: arg });
        return;
      }
      const runtime = await callProjectRuntimeActionIfBound<void>(
        "pty",
        "write",
        { args: arg },
      );
      if (!runtime.handled) await ipcRenderer.invoke(IPC.ptyWrite, arg);
    },
    resize: async (
      arg: {
        ptyId: string;
        cols: number;
        rows: number;
      },
      pin?: OpenProjectBinding | null,
    ): Promise<void> => {
      if (pin) {
        await callPinnedRuntimeAction<void>(pin, "pty", "resize", { args: arg });
        return;
      }
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
    }, pin?: OpenProjectBinding | null): Promise<PtyDisposeResult> => {
      if (pin) {
        return callPinnedRuntimeAction<PtyDisposeResult>(pin, "pty", "dispose", { args: arg });
      }
      const runtime = await callProjectRuntimeActionIfBound<PtyDisposeResult>(
        "pty",
        "dispose",
        { args: arg },
      );
      if (runtime.handled) return runtime.result;
      return await ipcRenderer.invoke(IPC.ptyDispose, arg);
    },
    setDataSubscriptions: setPtyDataSubscriptions,
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
      return callFilesWorkspaceActionOr<FileTreeNode[]>(
        args.workspaceId,
        "listTree",
        { args },
        () => ipcRenderer.invoke(IPC.filesListTree, args),
      );
    },
    listTreeChildren: async (
      args: FilesListTreeChildrenArgs,
    ): Promise<FilesListTreeChildrenResult> => {
      return callFilesWorkspaceActionOr<FilesListTreeChildrenResult>(
        args.workspaceId,
        "listTreeChildren",
        { args },
        () => ipcRenderer.invoke(IPC.filesListTreeChildren, args),
      );
    },
    refreshGitDecorations: async (
      args: FilesRefreshGitDecorationsArgs,
    ): Promise<FilesGitStatusEvent> => {
      return callFilesWorkspaceActionOr<FilesGitStatusEvent>(
        args.workspaceId,
        "refreshGitDecorations",
        { args },
        () => ipcRenderer.invoke(IPC.filesRefreshGitDecorations, args),
      );
    },
    openExternalPath: async (args: FilesOpenExternalPathArgs): Promise<FilesOpenExternalPathResult> => {
      return ipcRenderer.invoke(IPC.filesOpenExternalPath, args);
    },
    readFile: async (args: FilesReadFileArgs): Promise<FileContent> => {
      return callFilesWorkspaceActionOr<FileContent>(
        args.workspaceId,
        "readFile",
        { args },
        () => ipcRenderer.invoke(IPC.filesReadFile, args),
      );
    },
    readFileRange: async (args: FilesReadFileRangeArgs): Promise<FilesReadFileRangeResult> => {
      return callFilesWorkspaceActionOr<FilesReadFileRangeResult>(
        args.workspaceId,
        "readFileRange",
        { args },
        () => ipcRenderer.invoke(IPC.filesReadFileRange, args),
      );
    },
    gitBlame: async (args: FilesGitBlameArgs): Promise<FilesGitBlameResult> => {
      return callFilesWorkspaceActionOr<FilesGitBlameResult>(
        args.workspaceId,
        "blame",
        { args },
        () => ipcRenderer.invoke(IPC.filesGitBlame, args),
      );
    },
    writeText: async (args: FilesWriteTextArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "writeWorkspaceText",
        { args },
        () => ipcRenderer.invoke(IPC.filesWriteText, args),
      );
    },
    createFile: async (args: FilesCreateFileArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "createFile",
        { args },
        () => ipcRenderer.invoke(IPC.filesCreateFile, args),
      );
    },
    createDirectory: async (args: FilesCreateDirectoryArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "createDirectory",
        { args },
        () => ipcRenderer.invoke(IPC.filesCreateDirectory, args),
      );
    },
    rename: async (args: FilesRenameArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "rename",
        { args },
        () => ipcRenderer.invoke(IPC.filesRename, args),
      );
    },
    delete: async (args: FilesDeleteArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "deletePath",
        { args },
        () => ipcRenderer.invoke(IPC.filesDelete, args),
      );
    },
    watchChanges: async (args: FilesWatchArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "watchWorkspace",
        { args },
        () => ipcRenderer.invoke(IPC.filesWatchChanges, args),
      );
    },
    stopWatching: async (args: FilesWatchArgs): Promise<void> => {
      await callFilesWorkspaceActionOr<void>(
        args.workspaceId,
        "stopWatching",
        { args },
        () => ipcRenderer.invoke(IPC.filesStopWatching, args),
      );
    },
    quickOpen: async (
      args: FilesQuickOpenArgs,
      pin?: OpenProjectBinding | null,
    ): Promise<FilesQuickOpenItem[]> => {
      if (pin) {
        return callPinnedRuntimeAction<FilesQuickOpenItem[]>(
          pin,
          "file",
          "quickOpen",
          { args },
        );
      }
      return callFilesWorkspaceActionOr<FilesQuickOpenItem[]>(
        args.workspaceId,
        "quickOpen",
        { args },
        () => ipcRenderer.invoke(IPC.filesQuickOpen, args),
      );
    },
    searchText: async (
      args: FilesSearchTextArgs,
    ): Promise<FilesSearchTextMatch[]> => {
      return callFilesWorkspaceActionOr<FilesSearchTextMatch[]>(
        args.workspaceId,
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
    isCommitInLaneHistory: async (
      args: { laneId: string; commitSha: string },
    ): Promise<boolean> => {
      const runtime = await callProjectRuntimeActionIfBound<boolean>(
        "git",
        "isCommitInLaneHistory",
        { args },
      );
      return runtime.handled
        ? runtime.result
        : ipcRenderer.invoke(IPC.gitIsCommitInLaneHistory, args);
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
    fetch: async (args: { laneId: string }, pin?: OpenProjectBinding | null): Promise<GitActionResult> => {
      clearGitReadCaches();
      const result = pin
        ? await callPinnedRuntimeAction<GitActionResult>(pin, "git", "fetch", { args })
        : await (async () => {
            const runtime = await callProjectRuntimeActionIfBound<GitActionResult>(
              "git",
              "fetch",
              { args },
            );
            return runtime.handled
              ? runtime.result
              : await ipcRenderer.invoke(IPC.gitFetch, args);
          })();
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
      pin?: OpenProjectBinding | null,
    ): Promise<GitBranchSummary[]> => {
      if (pin) {
        return callPinnedRuntimeAction<GitBranchSummary[]>(pin, "git", "listBranches", { args });
      }
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
    setToken: async (token: string): Promise<GitHubSetTokenResult> =>
      clearAround(
        () => {
          githubStatusCache.clear();
          githubRemoteStatusCache.clear();
          githubAppInstallationStatusCache.clear();
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
          githubAppInstallationStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr("github", "clearToken", {}, () =>
            ipcRenderer.invoke(IPC.githubClearToken),
          ),
      ),
    getAppUserAuthStatus: async (): Promise<GitHubAppUserAuthStatus> =>
      callProjectRuntimeActionOr("github", "getAppUserAuthStatus", {}, () =>
        ipcRenderer.invoke(IPC.githubGetAppUserAuthStatus),
      ),
    startAppUserDeviceAuth: async (): Promise<GitHubAppDeviceAuthStartResult> =>
      callProjectRuntimeActionOr("github", "startAppUserDeviceAuth", {}, () =>
        ipcRenderer.invoke(IPC.githubStartAppUserDeviceAuth),
      ),
    pollAppUserDeviceAuth: async (args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult> =>
      clearAround(
        () => {
          githubAppInstallationStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr("github", "pollAppUserDeviceAuth", { args }, () =>
            ipcRenderer.invoke(IPC.githubPollAppUserDeviceAuth, args),
          ),
      ),
    clearAppUserAuth: async (): Promise<GitHubAppUserAuthStatus> =>
      clearAround(
        () => {
          githubAppInstallationStatusCache.clear();
        },
        () =>
          callProjectRuntimeActionOr("github", "clearAppUserAuth", {}, () =>
            ipcRenderer.invoke(IPC.githubClearAppUserAuth),
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
    getAppInstallationStatus: async (args: {
      owner?: string;
      name?: string;
      forceRefresh?: boolean;
    } = {}): Promise<GitHubAppInstallationStatus> => {
      const cacheArgs = { owner: args.owner, name: args.name };
      const cacheKey = serializeIpcCacheArgs(cacheArgs);
      if (args.forceRefresh) githubAppInstallationStatusCache.clear(cacheKey);
      const requestArgs = args.forceRefresh ? { ...cacheArgs, forceRefresh: true } : cacheArgs;
      if (args.forceRefresh) {
        return callProjectRuntimeActionOr(
          "github",
          "getAppInstallationStatus",
          { args: requestArgs },
          () => ipcRenderer.invoke(IPC.githubGetAppInstallationStatus, requestArgs),
        );
      }
      return callProjectRuntimeActionOr(
        "github",
        "getAppInstallationStatus",
        { args: requestArgs },
        () => githubAppInstallationStatusCache.get(cacheKey),
      );
    },
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
          githubAppInstallationStatusCache.clear();
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
        githubAppInstallationStatusCache.clear();
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
  // Machine-owned ADE account (Clerk identity). Token-free surface only — the
  // raw bearer stays in the main process and is never exposed here.
  account: {
    status: (): Promise<AdeAccountStatus> =>
      ipcRenderer.invoke(IPC.accountStatus),
    startLogin: (): Promise<AdeAccountLoginStart> =>
      ipcRenderer.invoke(IPC.accountStartLogin),
    pollLogin: (args: { sessionId: string }): Promise<AdeAccountLoginPoll> =>
      ipcRenderer.invoke(IPC.accountPollLogin, args),
    cancelLogin: (args: { sessionId: string }): Promise<AdeAccountStatus> =>
      ipcRenderer.invoke(IPC.accountCancelLogin, args),
    signOut: (): Promise<AdeAccountStatus> =>
      ipcRenderer.invoke(IPC.accountSignOut),
    listMachines: (): Promise<AdeAccountMachinesResult> =>
      ipcRenderer.invoke(IPC.accountListMachines),
    renameMachine: (machineKey: string, customName: string | null): Promise<AdeAccountMachine> =>
      ipcRenderer.invoke(IPC.accountRenameMachine, { machineKey, customName }),
    getLocalMachineIdentity: (): Promise<AdeAccountLocalMachineIdentity> =>
      ipcRenderer.invoke(IPC.accountGetLocalMachineIdentity),
    pairMachine: (machineKey: string): Promise<AdeAccountMachinePairResult> =>
      ipcRenderer.invoke(IPC.accountPairMachine, { machineKey }),
    onPairMachineProgress: (
      cb: (progress: AdeAccountPairMachineProgress) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        progress: AdeAccountPairMachineProgress,
      ) => cb(progress);
      ipcRenderer.on(IPC.accountPairMachineProgress, listener);
      return () =>
        ipcRenderer.removeListener(IPC.accountPairMachineProgress, listener);
    },
    removeMachine: (machineKey: string): Promise<AdeAccountMachineRemovalResult> =>
      ipcRenderer.invoke(IPC.accountRemoveMachine, { machineKey }),
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
    getForLane: async (
      laneId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrSummary | null> =>
      callPrReadRuntimeActionOr(pin, "getForLane", { arg: laneId }, () =>
        ipcRenderer.invoke(IPC.prsGetForLane, { laneId }),
      ),
    syncLanePr: async (
      laneId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrSummary | null> =>
      callPrReadRuntimeActionOr(pin, "syncLanePr", { arg: laneId }, () =>
        ipcRenderer.invoke(IPC.prsSyncLanePr, { laneId }),
      ),
    reconcileNow: async (): Promise<void> =>
      callPrReadRuntimeActionOr(null, "reconcileOnFocus", { args: { force: true } }, () =>
        ipcRenderer.invoke(IPC.prsReconcileNow),
      ),
    listAll: async (pin?: OpenProjectBinding | null): Promise<PrSummary[]> =>
      callPrReadRuntimeActionOr(pin, "listAll", { args: {} }, () =>
        ipcRenderer.invoke(IPC.prsListAll),
      ),
    listOpenForRepo: async (): Promise<BranchPullRequest[]> =>
      callPrReadRuntimeActionOr(null, "listOpenPullRequests", {}, () =>
        ipcRenderer.invoke(IPC.prsListOpenForRepo),
      ),
    refresh: async (
      args: { prId?: string; prIds?: string[] } = {},
      pin?: OpenProjectBinding | null,
    ): Promise<PrSummary[]> =>
      callPrReadRuntimeActionOr(pin, "refresh", { args }, () =>
        ipcRenderer.invoke(IPC.prsRefresh, args),
      ),
    getStatus: async (
      prId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrStatus | null> =>
      callPrReadRuntimeActionOr(pin, "getStatus", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetStatus, { prId }),
      ),
    getChecks: async (
      prId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrCheck[]> =>
      callPrReadRuntimeActionOr(pin, "getChecks", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetChecks, { prId }),
      ),
    getComments: async (
      prId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrComment[]> =>
      callPrReadRuntimeActionOr(pin, "getComments", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetComments, { prId }),
      ),
    getReviews: async (
      prId: string,
      pin?: OpenProjectBinding | null,
    ): Promise<PrReview[]> =>
      callPrReadRuntimeActionOr(pin, "getReviews", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetReviews, { prId }),
      ),
    getReviewThreads: async (prId: string): Promise<PrReviewThread[]> =>
      callPrReadRuntimeActionOr(null, "getReviewThreads", { arg: prId }, () =>
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
    updateBranch: async (args: UpdateBranchArgs): Promise<UpdateBranchResult> =>
      callProjectRuntimeActionOr("pr", "updateBranch", { args }, () =>
        ipcRenderer.invoke(IPC.prsUpdateBranch, args),
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
    getHealth: (prId: string): Promise<PrHealth> =>
      callProjectRuntimeActionOr("pr", "getPrHealth", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetHealth, { prId }),
      ),
    getConflictAnalysis: (prId: string): Promise<PrConflictAnalysis | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "getConflictAnalysis",
        { arg: prId },
        () => ipcRenderer.invoke(IPC.prsGetConflictAnalysis, { prId }),
      ),
    getMergeContext: (prId: string): Promise<PrMergeContext> =>
      callPrReadRuntimeActionOr(null, "getMergeContext", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetMergeContext, { prId }),
      ),
    getMergeContexts: (prIds: string[]): Promise<Record<string, PrMergeContext>> =>
      callPrReadRuntimeActionOr(
        null,
        "getMergeContexts",
        { argsList: [prIds] },
        () => ipcRenderer.invoke(IPC.prsGetMergeContexts, { prIds }),
      ),
    listWithConflicts: (args: { includeConflictAnalysis?: boolean } = {}): Promise<PrWithConflicts[]> =>
      callPrReadRuntimeActionOr(null, "listWithConflicts", { args }, () =>
        ipcRenderer.invoke(IPC.prsListWithConflicts, args),
      ),
    listSnapshots: (args: { prId?: string } = {}): Promise<PrSnapshotHydration[]> =>
      callPrReadRuntimeActionOr(
        null,
        "listSnapshots",
        { args },
        () => ipcRenderer.invoke(IPC.prsListSnapshots, args),
      ),
    getGitHubSnapshot: (args?: {
      force?: boolean;
      includeExternalClosed?: boolean;
      historyPageLimit?: number;
    }): Promise<GitHubPrSnapshot> =>
      callPrReadRuntimeActionOr(
        null,
        "getGithubSnapshot",
        { args: args ?? {} },
        () => ipcRenderer.invoke(IPC.prsGetGitHubSnapshot, args ?? {}),
      ),
    listGitHubStacks: (
      args: ListGitHubPrStacksArgs = {},
    ): Promise<GitHubPrStack[]> =>
      callProjectRuntimeActionOr(
        "pr",
        "listGithubStacks",
        { args },
        () => ipcRenderer.invoke(IPC.prsListGitHubStacks, args),
      ),
    syncGitHubStacks: (
      args: ListGitHubPrStacksArgs = {},
    ): Promise<GitHubPrStack[]> =>
      callProjectRuntimeActionOr(
        "pr",
        "syncGithubStacks",
        { args },
        () => ipcRenderer.invoke(IPC.prsSyncGitHubStacks, args),
      ),
    createGitHubStack: (args: CreateGitHubPrStackArgs): Promise<GitHubPrStack> =>
      callProjectRuntimeActionOr(
        "pr",
        "createGithubStack",
        { args },
        () => ipcRenderer.invoke(IPC.prsCreateGitHubStack, args),
      ),
    addGitHubStackPullRequests: (
      args: AddGitHubPrStackPullRequestsArgs,
    ): Promise<GitHubPrStack> =>
      callProjectRuntimeActionOr(
        "pr",
        "addGithubStackPullRequests",
        { args },
        () => ipcRenderer.invoke(IPC.prsAddGitHubStackPullRequests, args),
      ),
    unstackGitHubStack: (
      args: UnstackGitHubPrStackArgs,
    ): Promise<GitHubPrStack | null> =>
      callProjectRuntimeActionOr(
        "pr",
        "unstackGithubStack",
        { args },
        () => ipcRenderer.invoke(IPC.prsUnstackGitHubStack, args),
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
    onEvent: (cb: (ev: PrEventPayload) => void, pin?: OpenProjectBinding | null) => {
      // A pinned surface reads its PRs from the lane's machine, so it must hear
      // that machine's `prs-updated` too — the bound runtime's feed describes a
      // different database and would leave the pinned pill permanently stale.
      const removePinned = subscribePinnedProjectRuntimeEvents(
        pin,
        (payload) => toWrappedEvent<PrEventPayload>(payload, "pr_event"),
        cb,
        "PR event",
      );
      if (removePinned) return removePinned;
      const unsubscribeLocal = subscribeLocalPrEvents(cb);
      const unsubscribeRemote = subscribeRemotePrEvents(cb);
      return () => {
        unsubscribeRemote();
        unsubscribeLocal();
      };
    },
    getDetail: async (prId: string): Promise<PrDetail> =>
      callPrReadRuntimeActionOr(null, "getDetail", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetDetail, { prId }),
      ),
    getFiles: async (prId: string): Promise<PrFile[]> =>
      callPrReadRuntimeActionOr(null, "getFiles", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetFiles, { prId }),
      ),
    getCommits: async (prId: string): Promise<PrCommit[]> =>
      callPrReadRuntimeActionOr(null, "getCommits", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetCommits, { prId }),
      ),
    getActionRuns: async (prId: string): Promise<PrActionRun[]> =>
      callPrReadRuntimeActionOr(null, "getActionRuns", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetActionRuns, { prId }),
      ),
    getActivity: async (prId: string): Promise<PrActivityEvent[]> =>
      callPrReadRuntimeActionOr(null, "getActivity", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetActivity, { prId }),
      ),
    getWorkflowGraph: async (args: GetPrWorkflowGraphArgs): Promise<PrWorkflowGraph> =>
      callPrReadRuntimeActionOr(null, "getWorkflowGraph", { args }, () =>
        ipcRenderer.invoke(IPC.prsGetWorkflowGraph, args),
      ),
    getCheckLog: async (args: GetPrCheckLogArgs): Promise<PrCheckLogExcerpt> =>
      callPrReadRuntimeActionOr(null, "getCheckLog", { args }, () =>
        ipcRenderer.invoke(IPC.prsGetCheckLog, args),
      ),
    getDetailByGithub: async (coords: PrGithubCoords): Promise<PrDetail> =>
      callPrReadRuntimeActionOr(null, "getDetailByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetDetailByGithub, coords),
      ),
    getFilesByGithub: async (coords: PrGithubCoords): Promise<PrFile[]> =>
      callPrReadRuntimeActionOr(null, "getFilesByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetFilesByGithub, coords),
      ),
    getCommitsByGithub: async (coords: PrGithubCoords): Promise<PrCommit[]> =>
      callPrReadRuntimeActionOr(null, "getCommitsByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetCommitsByGithub, coords),
      ),
    getActionRunsByGithub: async (coords: PrGithubCoords): Promise<PrActionRun[]> =>
      callPrReadRuntimeActionOr(null, "getActionRunsByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetActionRunsByGithub, coords),
      ),
    getActivityByGithub: async (coords: PrGithubCoords): Promise<PrActivityEvent[]> =>
      callPrReadRuntimeActionOr(null, "getActivityByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetActivityByGithub, coords),
      ),
    getStatusByGithub: async (coords: PrGithubCoords): Promise<PrStatus | null> =>
      callPrReadRuntimeActionOr(null, "getStatusByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetStatusByGithub, coords),
      ),
    getChecksByGithub: async (coords: PrGithubCoords): Promise<PrCheck[]> =>
      callPrReadRuntimeActionOr(null, "getChecksByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetChecksByGithub, coords),
      ),
    getReviewsByGithub: async (coords: PrGithubCoords): Promise<PrReview[]> =>
      callPrReadRuntimeActionOr(null, "getReviewsByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetReviewsByGithub, coords),
      ),
    getCommentsByGithub: async (coords: PrGithubCoords): Promise<PrComment[]> =>
      callPrReadRuntimeActionOr(null, "getCommentsByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetCommentsByGithub, coords),
      ),
    getReviewThreadsByGithub: async (coords: PrGithubCoords): Promise<PrReviewThread[]> =>
      callPrReadRuntimeActionOr(null, "getReviewThreadsByGithub", { arg: coords }, () =>
        ipcRenderer.invoke(IPC.prsGetReviewThreadsByGithub, coords),
      ),
    addComment: async (args: AddPrCommentArgs): Promise<PrComment> =>
      callProjectRuntimeActionOr("pr", "addComment", { args }, () =>
        ipcRenderer.invoke(IPC.prsAddComment, args),
      ),
    updateComment: async (args: UpdatePrCommentArgs): Promise<PrComment> =>
      callProjectRuntimeActionOr("pr", "updateComment", { args }, () =>
        ipcRenderer.invoke(IPC.prsUpdateComment, args),
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
      callPrReadRuntimeActionOr(null, "getDeployments", { arg: prId }, () =>
        ipcRenderer.invoke(IPC.prsGetDeployments, { prId }),
      ),
    getAiSummary: async (prId: string): Promise<PrAiSummary | null> =>
      callPrReadRuntimeActionOr(null, "getAiSummary", { arg: prId }, () =>
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
    get: async (pin?: OpenProjectBinding | null): Promise<ProjectConfigSnapshot> => {
      if (pin) {
        return callPinnedRuntimeAction<ProjectConfigSnapshot>(pin, "project_config", "get");
      }
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
    /**
     * Resize/recolour the Windows caption strip so it tracks the renderer's own
     * header. Windows-only in the main process; on macOS the OS owns traffic
     * light layout and colour, so this resolves `{ applied: false }`.
     */
    setTitleBarOverlay: async (arg: {
      theme?: "dark" | "light";
      zoomFactor?: number;
    }): Promise<{ applied: boolean }> =>
      ipcRenderer.invoke(IPC.appSetTitleBarOverlay, arg),
    onCommand: (cb: (command: AppZoomCommand) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: AppZoomCommand,
      ) => cb(payload);
      ipcRenderer.on(IPC.appZoomCommand, listener);
      return () => ipcRenderer.removeListener(IPC.appZoomCommand, listener);
    },
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
    getMemory: async (): Promise<CtoMemorySnapshot> =>
      callProjectRuntimeActionOr("cto_memory", "getSnapshot", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetMemory, {}),
      ),
    updateMemory: async (args: CtoUpdateMemoryArgs): Promise<CtoMemorySnapshot> =>
      callProjectRuntimeActionOr("cto_memory", "updateMemory", { args }, () =>
        ipcRenderer.invoke(IPC.ctoUpdateMemory, args),
      ),
    searchMemory: async (args: CtoSearchMemoryArgs): Promise<CtoSearchMemoryResult> =>
      callProjectRuntimeActionOr("cto_memory", "searchMemory", { args }, () =>
        ipcRenderer.invoke(IPC.ctoSearchMemory, args),
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
    getLinearIssueComments: async (
      args: { issueId: string },
    ): Promise<CtoLinearIssueComment[]> =>
      callProjectRuntimeActionOr(
        "linear_issue_tracker",
        "fetchIssueComments",
        { args },
        () => ipcRenderer.invoke(IPC.ctoGetLinearIssueComments, args),
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
    getAttention: async (): Promise<CtoAttentionState> =>
      callProjectRuntimeActionOr("cto_state", "getAttention", {}, () =>
        ipcRenderer.invoke(IPC.ctoGetAttention),
      ),
  },
  updateCheckForUpdates: () => ipcRenderer.invoke(IPC.updateCheckForUpdates),
  updateGetState: (): Promise<AutoUpdateSnapshot> =>
    ipcRenderer.invoke(IPC.updateGetState),
  updateGetPreferences: (): Promise<AutoUpdatePreferences> =>
    ipcRenderer.invoke(IPC.updateGetPreferences),
  updateSetPreferences: (preferences: AutoUpdatePreferences): Promise<AutoUpdatePreferences> =>
    ipcRenderer.invoke(IPC.updateSetPreferences, preferences),
  updateGetInstallImpact: (): Promise<UpdateInstallImpact> =>
    ipcRenderer.invoke(IPC.updateGetInstallImpact),
  updateQuitAndInstall: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.updateQuitAndInstall),
  updateCancelAutoApply: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.updateCancelAutoApply),
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
