import type { RendererMemorySnapshot } from "../shared/types/rendererMemory";
import type { AccountProjectChangeResult, AccountProjectListResult } from "../shared/accountProject";
import type { SavedWindowRepositoryTabs } from "../shared/windowRepositoryTabs";
import type { DeeplinkOwnership } from "../shared/deeplinks";
import type { MachineAddress, MachineConnectOptions, MachineConnectResult } from "../shared/machineAddress";
import type {
  ProjectRemovalOutcome,
  ProjectRemovalReport,
  ProjectRemovalRequest,
  RemoteProjectRemovalInspection,
} from "../shared/projectRemoval";
import type { CloudAccountState, CloudAgentLimits, CloudCreateProgress, CloudInviteRedeemOutcome, CloudMachineActionArgs, CloudMachineActionResult, CloudMachinesResult, CloudOpenCheckoutResult, CloudPaidPlanId, CloudPlanCleanupPick, CloudPlanId, CloudStatus } from "../shared/adeCloud";
import type { CloudSignInEnd, CloudSignInClaudeStartArgs, CloudSignInId, CloudSignInStatus } from "../shared/cloudSignIns";
import type { CloudGitPreflight } from "../shared/cloudGitCredential";
import type { CloudSavedChatDeleteArgs, CloudSavedChatList, CloudSavedChatPage, CloudSavedChatReadArgs, CloudSavedChatsListArgs } from "../shared/cloudSavedChats";
import type { RemoteWorkCopyListing } from "../shared/types/remoteWork";
import type {
  LaneShareGuestBridge,
  LaneShareCreateArgs,
  LaneShareCreateResult,
  LaneShareEvent,
  LaneShareLeaveResult,
  LaneShareMoveAction,
  LaneShareListArgs,
  LaneShareListResult,
  LaneShareReceivedResult,
  LaneShareResendResult,
  LaneShareRevokeResult,
  LaneShareUpdateRightsArgs,
  LaneShareUpdateRightsResult,
} from "../shared/types/laneShare";
import type { ProviderLoginProvider, ProviderLoginStatus as ProviderLoginSyncStatus } from "../shared/types/providerLogins";
import type {
  PasswordImportResult,
  PasswordItemSummary,
  PasswordLoginSaveInput,
  PasswordSecretSaveInput,
  PasswordsStatus,
} from "../shared/types/passwords";
import type { MachineStats } from "../shared/types/machineStats";
import type { NewLaneDefaults } from "../shared/laneStart";
import type { UpdateTrack } from "../shared/updateTrack";
import type { MuseBinaryStatus } from "../shared/museBinary";
import type { JevAnswers, JevDecideRequest, JevQuestions, JevStatus } from "../shared/types/jev";
import type { MuseSettingsRequest, MuseSettingsResult, MuseSettingsRunArgs } from "../shared/museSettings";
import type { HomeWidgetsBridge } from "../shared/types/homeWidgets";
import type { AndroidEmulatorPreloadApi } from "../shared/types/androidEmulator";
import type { AppBundleOwnershipBridge } from "../shared/types/appBundleOwnership";
import type { DatabaseCopiesBridge } from "../shared/types/startupRecovery";
import type { ProductSurveyBridge } from "../shared/types/productSurveys";
import type { MusicBridge } from "../shared/types/music";
import type { SetDefaultTerminalShellArgs, TerminalShellSettings } from "../shared/types/terminalShells";
import type { SmartLinkPreview } from "../shared/smartLinks";
import type { GitHubIssueTemplateSet } from "../shared/githubIssueTemplates";
import type {
  JiraComment,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraCreateMeta,
  JiraIssueDetail,
  JiraIssuePage,
  JiraListIssuesArgs,
  JiraProject,
  JiraTransition,
  LaneJiraIssue,
  JiraUpdateIssueArgs,
  JiraUser,
} from "../shared/types/jira";
import type { McpRegistryServer } from "../shared/mcpRegistry";
import type { McpRegistryChatStatus } from "../shared/mcpServerRequest";
import type { GetPrChatWatchArgs, PrChatWatchSummary, SetPrChatWatchArgs } from "../shared/prWatch";
import type { ResolvePrMediaArgs, ResolvePrMediaResult } from "../shared/githubMedia";
import type {
  TerminalListWatchesArgs,
  TerminalUnwatchArgs,
  TerminalUnwatchResult,
  TerminalWatchArgs,
  TerminalWatchResult,
  TerminalWatchSummary,
} from "../shared/terminalWatch";
import type {
  ChatThreadComment,
  ChatThreadCommentCreateArgs,
  ChatThreadCommentDeleteArgs,
  ChatThreadCommentListArgs,
  ChatThreadCommentUpdateArgs,
} from "../shared/threadComments";
import type {
  ClaudePluginUiActArgs,
  ClaudePluginUiActResult,
  ClaudePluginUiGetArgs,
  ClaudePluginUiSnapshot,
} from "../shared/claudePluginUi";
import type {
  AppleDeviceAttachArgs,
  AppleDeviceStartArgs,
  AppleDeviceStopArgs,
  AppleDeviceStopResult,
  AppleScrollArgs,
  AppleScrollResult,
  AppleDeviceCreateArgs,
  AppleDeviceDeleteArgs,
  AppleDeviceDeleteResult,
  AppleDeviceDetachArgs,
  AppleDeviceCleanupArgs,
  AppleDeviceCleanupResult,
  AppleDevicePosture,
  AppleDuoAppStoreScreenshotsResult,
  AppleRenderProofResult,
  AppleAddDuoSkillResult,
  AppleDuoModelResult,
  AppleSetPostureArgs,
  AppleSetPostureResult,
  AppleRuntimeDeleteArgs,
  AppleRuntimeDeleteResult,
  AppleRuntimeInstallArgs,
  AppleRuntimeScope,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimePruneArgs,
  AppleXcodeStatus,
  AppleDeviceDeleteInstalledArgs,
  AppleDeviceListArgs,
  AppleDeviceListResult,
  AppleFrameArgs,
  AppleFrameResult,
  ApplePressButtonArgs,
  ApplePressButtonResult,
  AppleRotateArgs,
  AppleRotateResult,
  AppleLaneDevice,
  AppleRecordDeleteArgs,
  AppleRecordListArgs,
  AppleRecordStartArgs,
  AppleRecordStopArgs,
} from "../shared/types/iosSimulator";
import type { SimRecording } from "../main/services/ios/recording/simRecordingService";
import type {
  AppOpenSystemSettingsPaneResult,
  SystemSettingsPaneId,
} from "../shared/types/systemSettings";
import type { LocalizedRemoteUrl } from "../shared/remoteLoopbackUrl";
import type {
  MacDesktopActionResult,
  MacDesktopClaimArgs,
  MacDesktopClickArgs,
  MacDesktopDragArgs,
  MacDesktopEventPayload,
  MacDesktopGetStatusArgs,
  MacDesktopInputResult,
  MacDesktopLeaseState,
  MacDesktopMoveArgs,
  MacDesktopObservation,
  MacDesktopObserveArgs,
  MacDesktopOpenArgs,
  MacDesktopOpenResult,
  MacDesktopPermissions,
  MacDesktopPressArgs,
  MacDesktopPresentArgs,
  MacDesktopRecordStartArgs,
  MacDesktopRecordingStatus,
  MacDesktopRecheckPermissionsArgs,
  MacDesktopReleaseArgs,
  MacDesktopWindowActionArgs,
  MacDesktopWindowActionResult,
  MacDesktopRequestPermissionArgs,
  MacDesktopScreenshotArgs,
  MacDesktopScreenshotResult,
  MacDesktopScrollArgs,
  MacDesktopStartArgs,
  MacDesktopStartStreamArgs,
  MacDesktopStopStreamArgs,
  MacDesktopStatus,
  MacDesktopStopArgs,
  MacDesktopStopResult,
  MacDesktopStreamStatus,
  MacDesktopTakeoverArgs,
  MacDesktopTypeArgs,
  MacDesktopWaitArgs,
  MacDesktopWaitResult,
  MacDesktopWindow,
  WindowsDesktopSetupArgs,
  WindowsDesktopSetupResult,
  WindowsDesktopTakeoverArgs,
} from "../shared/types/macDesktop";
import type {
  BuiltInBrowserRemoteCall,
  BuiltInBrowserRemoteAgentCallOutcome,
  BuiltInBrowserRemoteCallReply,
  BuiltInBrowserRemoteRequest,
  BuiltInBrowserRemoteRequestAck,
} from "../shared/types/builtInBrowserRemote";
import type { EditorTarget, OpenPathInEditorRemote, OpenPathTarget } from "../shared/editorTargets";
import type { InstalledBrowser } from "../shared/browserTargets";
import type { MachineInventoryDetail } from "../shared/types/machineInventory";
import type { MachineConnectionRoutes } from "../shared/types/account";
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
  ProjectSecretPullResult,
  ProjectSecretsExportResult,
  ProjectSecretsImportArgs,
  ProjectSecretsImportPreview,
  ProjectSecretsImportResult,
  ProjectSecretsListResult,
  ProjectSecretSetArgs,
  ProjectSecretSummary,
  ProjectSecretValueResult,
  ProviderInstance,
  ProviderInstanceCreateArgs,
  ProviderInstanceCreateResult,
  ProviderInstanceGetSettingsArgs,
  ProviderInstanceListArgs,
  ProviderInstanceLoginCommand,
  ProviderInstanceLoginCommandArgs,
  ProviderInstanceRefreshArgs,
  ProviderInstanceRemoveArgs,
  ProviderInstanceRemoveResult,
  ProviderInstanceSetAccentArgs,
  ProviderInstanceDismissReplacedArgs,
  ProviderLoginRefArgs,
  ProviderLoginStartArgs,
  ProviderLoginStatus,
  ProviderLoginSubmitCodeArgs,
  ProviderInstanceSetDefaultArgs,
  ProviderInstanceSetSettingsArgs,
  ProviderInstanceSettings,
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AppInfo,
  LocalRuntimeStatus,
  BackgroundServiceSummary,
  QuitPromptAnswer,
  QuitPromptRepairResult,
  QuitPromptRequest,
  StopBackgroundServiceRequest,
  StopBackgroundServiceResult,
  AppWelcomeVideoState,
  OnboardingProjectCandidate,
  OnboardingProjectChat,
  OnboardingProjectDiscovery,
  AppResourceUsageSnapshot,
  LatestReleaseInfo,
  AppNavigationRequest,
  AppMenuCommand,
  AppZoomCommand,
  AutoUpdatePreferences,
  KeepAwakeFixResult,
  KeepAwakeLevel,
  KeepAwakeSnapshot,
  RemoteMcpAction,
  AutoUpdateSnapshot,
  TrackSwitchCheckResult,
  UpdateTrackSwitchResult,
  UpdateImpact,
  UpdateInstallImpact,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationDeleteRuleRequest,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationLinearIngressStatus,
  AutomationScheduledCleanup,
  AutomationWebhookTestRequest,
  AutomationWebhookListEntry,
  AutomationWebhookTriggerConfig,
  AutomationWebhookEndpoint,
  AutomationWebhookDeliverySummary,
  AutomationWebhookDelivery,
  AutomationWebhookTestResult,
  AutomationWebhookGatewayStatus,
  ConflictProposal,
  ConflictProposalPreview,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CancelLaneGitWriteArgs,
  CancelLaneGitWriteResult,
  CreateLaneArgs,
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
  DeletedChatDetailArgs,
  DeletedChatListArgs,
  DeletedChatListResult,
  DeletedChatRemoveArgs,
  DeletedChatRemoveResult,
  DeletedChatReopenArgs,
  DeletedChatReopenResult,
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
  AgentChatCodexRealtimeStartArgs,
  AgentChatCodexRealtimeStartResult,
  AgentChatCodexRealtimeStopArgs,
  AgentChatCodexRealtimeState,
  AgentChatCodexRealtimeStateArgs,
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
  AgentChatDeleteResult,
  AgentChatSuggestLaneNameArgs,
  AutoLaneIdentitySuggestion,
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatGetSummaryArgs,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatStartSideChatArgs,
  AgentChatStartSideChatResult,
  AgentChatEndSideChatArgs,
  AgentChatEndSideChatResult,
  AgentChatMarkCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatAcknowledgeCrossMachineHandoffArgs,
  AgentChatCrossMachineHandoffSessionArgs,
  AgentChatRetryCrossMachineHandoffArgs,
  AgentChatPreviewCrossMachineHandoffArgs,
  AgentChatPreviewCrossMachineHandoffResult,
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatResolveCrossMachineHandoffApprovalArgs,
  AgentChatStartCrossMachineHandoffArgs,
  AgentChatCrossMachineBatchMoveArgs,
  AgentChatGetCrossMachineBatchMoveArgs,
  AgentChatRetryCrossMachineBatchMoveArgs,
  AgentChatResolveCrossMachineBatchMoveApprovalArgs,
  AgentChatCrossMachineBatchMoveRecord,
  AgentChatValidateCrossMachineSourceArgs,
  AgentChatInterruptArgs,
  AgentChatInterruptResult,
  AgentChatStopTaskArgs,
  AgentChatStopTaskResult,
  AgentChatMessageSubagentArgs,
  AgentChatMessageSubagentResult,
  AgentChatControlSubagentArgs,
  AgentChatControlSubagentResult,
  AgentChatRestartSessionArgs,
  AgentChatRestartSessionResult,
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
  AgentChatDismissPendingInputArgs,
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
  AgentChatResumeUsageLimitNowArgs,
  AgentChatResumeUsageLimitNowResult,
  AgentChatContinueUsageLimitOnAlternateArgs,
  AgentChatContinueUsageLimitOnAlternateResult,
  AgentChatSwitchAccountArgs,
  AgentChatSwitchAccountResult,
  AgentChatCancelScheduledWorkResult,
  AgentChatClaudePlugin,
  AgentChatClaudePluginsArgs,
  AgentChatCodexPlugin,
  AgentChatCodexPluginsArgs,
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
  AgentChatClaudeUsageArgs,
  ClaudeUsageReport,
  AgentChatRewindFilesArgs,
  AgentChatRewindFilesResult,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  ChatMentionSuggestArgs,
  ChatMentionSuggestResult,
  DraftClaimArgs,
  DraftCreateArgs,
  DraftDeleteArgs,
  DraftEntry,
  DraftUpdateArgs,
  AgentChatGetTurnFileDiffArgs,
  AgentChatSession,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSessionSummary,
  CodexThreadGoal,
  AgentChatSteerArgs,
  AgentChatSteerResult,
  AgentCliTypeArgs,
  AgentCliTypeResult,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatMoveSteerArgs,
  AgentChatLaunchDefaults,
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
  AutomationTestCleanupResult,
  AutomationTestPlan,
  AutomationTestRequest,
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
  PinnedProviderToolStatus,
  AntigravitySignInCancelArgs,
  AntigravitySignInCompleteArgs,
  AntigravitySignInStartArgs,
  AntigravitySignInState,
  AgentCliLoginRefArgs,
  AgentCliLoginStartArgs,
  AgentCliLoginStatus,
  AgentCliLoginSubmitCodeArgs,
  AiApiKeyVerificationResult,
  AiProviderSignInCheck,
  AiVerifyProviderSignInArgs,
  AiConfig,
  AiSettingsStatus,
  OpenCodeOAuthStartResult,
  OpenCodeOAuthStatusEvent,
  OpenCodeProviderAuthMethods,
  OpenCodeAccountActionResult,
  OpenCodeAccountsResult,
  OpenCodeCloudConnectResult,
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
  CloudAgentArchiveArgs,
  CloudAgentLaunchArgs,
  CloudAgentList,
  CloudAgentListArgs,
  CloudAgentOpenResult,
  CloudAgentRef,
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
  CtoStartFreshSessionResult,
  CtoThreadHealth,
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
  CtoCountLinearIssuesArgs,
  CtoCountLinearIssuesResult,
  CtoGetLinearIssueArgs,
  CtoCreateLinearIssueCommentArgs,
  LinearIssueCreateInput,
  LinearIssueCreateOptions,
  LinearProjectMilestone,
  LinearUploadResult,
  CtoLinearCustomView,
  LinearAgentOverview,
  LinearInboxNotification,
  NormalizedLinearIssue as LinearAgentNormalizedIssue,
  CtoStartLinearOAuthResult as LinearAgentInstallStart,
  CtoGetLinearOAuthSessionResult as LinearAgentInstallSession,
  CtoUpdateLinearIssueArgs,
  NormalizedLinearIssue,
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
  GitListBranchesArgs,
  GitGetUserIdentityArgs,
  GitUserIdentity,
  GitListCommitFilesArgs,
  GitListRecentCommitsArgs,
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
  GitSyncStatuses,
  GitSyncStatusesArgs,
  GitUpstreamSyncStatus,
  GitSyncArgs,
  GitMergeBaseInArgs,
  GitMergeBaseInResult,
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppInstallationStatus,
  GitHubRepoIssueSummary,
  GitHubIssueWriteAccess,
  GitHubIssueCreateInput,
  GitHubIssueCreateResult,
  GitHubIssueTypeOption,
  GitHubAppUserAuthStatus,
  GitHubAccountAppAccountStatus,
  GitHubAccountAppSignInReadResult,
  GitHubAccountAppSignInStartResult,
  GitHubAccountAppSignOutResult,
  GithubDirectClientState,
  GithubDirectData,
  GithubDirectOp,
  GithubDirectRequest,
  GithubDirectRequestOptions,
  GithubDirectResult,
  GitHubAutolink,
  GitHubRemoteStatus,
  GitHubRepoStarState,
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
  AdeAccountSyncHostStartResult,
  AdeAccountSessionRepairResult,
  AccountSettingRow,
  AccountSettingsResult,
  McpRegistryCheck,
  McpRegistryContext,
  McpRegistryImportResult,
  McpRegistryResult,
  McpRegistryScan,
  McpRegistrySecretRef,
  McpRegistrySignInResult,
  AccountSettingsWriteOptions,
  AdeAccountMachinesResult,
  AdeAccountMachinePairResult,
  AdeAccountPairMachineProgress,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  CreatePrFromLaneArgs,
  AddGitHubPrStackPullRequestsArgs,
  CreateGitHubPrStackArgs,
  PrHealth,
  RebaseNeed,
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
  GitHubPrSnapshot,
  GitHubPrStack,
  LandPrArgs,
  LandResult,
  UpdateBranchArgs,
  UpdateBranchResult,
  LinkPrToLaneArgs,
  ListGitHubPrStacksArgs,
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
  PrDetailBundle,
  PrEventPayload,
  PrFile,
  PrReview,
  PrReviewThread,
  PrReviewThreadComment,
  PrSnapshotHydration,
  PrStatus,
  PrListConditionalReply,
  PrSummary,
  PrWithConflicts,
  UnstackGitHubPrStackArgs,
  LinkPrChatSessionArgs,
  LinkPrChatStackArgs,
  UnlinkPrChatSessionArgs,
  ListPrChatSessionsArgs,
  PrChatSessionLink,
  StackLinkOffer,
  PrDeployment,
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
  SetPrAssigneesArgs,
  SetPrAssigneesResult,
  ListGitHubPrFilterOptionsArgs,
  ListGitHubPrFilterOptionsResult,
  SearchGitHubPrsArgs,
  SearchGitHubPrsResult,
  RequestPrReviewersArgs,
  SubmitPrReviewArgs,
  ClosePrArgs,
  ReopenPrArgs,
  SetPrAutoMergeArgs,
  SetPrDraftArgs,
  RerunPrChecksArgs,
  UpdatePrDescriptionArgs,
  GetPrRepoReferencesArgs,
  PrRepoReference,
  SearchPrMentionablesArgs,
  SearchPrMentionablesResult,
  ListOverlapsArgs,
  LaneGitHubIssue,
  LaneLinearIssue,
  LaneSummary,
  ImportBranchLaneArgs,
  ListLanesArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  ListSessionsOptions,
  GetSessionOptions,
  DeleteSessionArgs,
  ListTestRunsArgs,
  OperationRecord,
  BrowserLoginImportArgs,
  BrowserLoginImportCapabilities,
  BrowserLoginImportListDomainsArgs,
  BrowserLoginImportListDomainsResult,
  BrowserLoginImportListSourcesResult,
  BrowserLoginImportResult,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  OpenProjectBinding,
  ProjectTabAdoptRequest,
  CreateProjectInput,
  CreateProjectResult,
  CloneProjectInput,
  CloneProjectResult,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  PublishProjectInput,
  PublishProjectResult,
  ProjectFindForRepoResult,
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
  RenameLaneBranchArgs,
  RenameLaneBranchResult,
  LaneBranchNameCheck,
  RiskMatrixEntry,
  RunTestSuiteArgs,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  RunConflictPredictionArgs,
  SessionDeltaSummary,
  SessionLifecycleSettings,
  SessionGitHubIssueLink,
  SessionJiraIssueLink,
  SessionLinearIssueLink,
  SessionBoardMoveResult,
  SessionBoardMoveUndoResult,
  SessionSettleOverride,
  SessionWakeReason,
  TerminalSessionChangedEvent,
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
  DeletedLaneSnapshot,
  RemoveDeletedLaneArgs,
  RestoreDeletedLaneArgs,
  RestoreDeletedLaneResult,
  LaneReclaimRisk,
  RestoreLaneResult,
  LaneEnvInitProgress,
  LaneEnvInitEvent,
  ChatLaunchArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchQueueMessageArgs,
  ChatLaunchSnapshot,
  LaneOverlayOverrides,
  LaneTemplate,
  LaneListSnapshot,
  GetLaneTemplateArgs,
  SetDefaultLaneTemplateArgs,
  NewLaneDefaultsSnapshot,
  ApplyLaneTemplateArgs,
  SaveLaneTemplateArgs,
  GetLaneDependencyStatusArgs,
  AcknowledgeLaneDependencyStatusArgs,
  LaneDependencyStatus,
  DeleteLaneTemplateArgs,
  GetPortLeaseArgs,
  AcquirePortLeaseArgs,
  ReleasePortLeaseArgs,
  PortLease,
  PortConflict,
  PortAllocationEvent,
  ProxyStatus,
  SubscriptionProxyStatus,
  SubscriptionProxySignInArgs,
  SubscriptionProxySignInResult,
  SubscriptionProxySignOutArgs,
  SubscriptionProxySetDisabledArgs,
  SubscriptionProxyMutationResult,
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
  IosSimulatorLongPressArgs,
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
  IosSimulatorScreenshot,
  IosSimulatorScreenshotArgs,
  IosSimulatorSelectResult,
  IosSimulatorSession,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
  IosSimulatorStartStreamArgs,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
  IosSimulatorAppLifecycleArgs,
  IosSimulatorRelaunchArgs,
  IosSimulatorAppState,
  IosSimulatorForegroundApp,
  IosSimulatorAssertVisibleArgs,
  IosSimulatorCloseDeviceArgs,
  IosSimulatorCloseDeviceResult,
  IosSimulatorDeviceArgs,
  IosSimulatorDeviceSession,
  IosSimulatorDeviceSettings,
  IosSimulatorElementActionResult,
  IosSimulatorEventLogArgs,
  IosSimulatorEventLogPage,
  IosSimulatorFillElementArgs,
  IosSimulatorFindElementArgs,
  IosSimulatorOpenDeviceArgs,
  IosSimulatorOpenUrlArgs,
  IosSimulatorProofBundle,
  IosSimulatorProofBundleArgs,
  IosSimulatorPushArgs,
  IosSimulatorSetAccessibilityArgs,
  IosSimulatorSetAppearanceArgs,
  IosSimulatorSetContentSizeArgs,
  IosSimulatorSetLocationArgs,
  IosSimulatorSetPermissionArgs,
  IosSimulatorStartEventLogArgs,
  IosSimulatorStopEventLogArgs,
  IosSimulatorStatusBarArgs,
  IosSimulatorTapElementArgs,
  IosSimulatorUninstallAppArgs,
  IosSimulatorWaitForElementArgs,
  AppControlAttachToTargetArgs,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlDispatchKeyArgs,
  AppControlDriversResult,
  AppControlEventPayload,
  AppControlInspectPointArgs,
  AppControlInspectResult,
  AppControlLaneArgs,
  AppControlLaunchArgs,
  AppControlObservation,
  AppControlObservationArgs,
  AppControlCaptureProofArgs,
  AppControlCaptureProofResult,
  AppControlRecordStartArgs,
  AppControlRecordStopArgs,
  AppControlRecordingStatus,
  AppControlRecordingStatusArgs,
  AppControlScreencastFrame,
  AppControlScreenshot,
  AppControlScrollArgs,
  AppControlSelectResult,
  AppControlSession,
  AppControlSessionTargetArgs,
  AppControlSnapshot,
  AppControlSnapshotArgs,
  AppControlStatus,
  AppControlStopArgs,
  AppControlSwitchWindowArgs,
  AppControlTarget,
  AppControlTraceArgs,
  AppControlTraceResult,
  AppControlTypeTextArgs,
  AppControlWindowsResult,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserScreenshotResult,
  BuiltInBrowserClearPermissionsArgs,
  BuiltInBrowserClearPermissionsResult,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserOriginAccessResult,
  BuiltInBrowserPermissionsResult,
  BuiltInBrowserAgentAccessAnswer,
  BuiltInBrowserAgentAccessMode,
  BuiltInBrowserAgentAccessRevokeArgs,
  BuiltInBrowserAgentAccessSnapshot,
  BuiltInBrowserSettings,
  BuiltInBrowserSettingsPatch,
  BuiltInBrowserRevokeCertificatesArgs,
  BuiltInBrowserTrustCertificateArgs,
  BuiltInBrowserTrustedCertificatesResult,
  BuiltInBrowserProfileDiagnostics,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserRequestOriginAccessArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserDevToolsResult,
  BuiltInBrowserEmulationResult,
  BuiltInBrowserEndHandoffArgs,
  BuiltInBrowserHandoffResult,
  BuiltInBrowserExportHarArgs,
  BuiltInBrowserExportHarResult,
  BuiltInBrowserFindInPageArgs,
  DevServerEvent,
  DevServersArgs,
  DevServersResult,
  DevServerStopArgs,
  DevServerStopResult,
  BuiltInBrowserFindInPageResult,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserNetworkLoggingResult,
  BuiltInBrowserNetworkLogResult,
  BuiltInBrowserSetDevToolsArgs,
  BuiltInBrowserSetEmulationArgs,
  BuiltInBrowserSetNetworkLoggingArgs,
  BuiltInBrowserSetZoomArgs,
  BuiltInBrowserStartRecordingArgs,
  BuiltInBrowserStartRecordingResult,
  BuiltInBrowserStopFindInPageArgs,
  BuiltInBrowserStopFindInPageResult,
  BuiltInBrowserStopRecordingArgs,
  BuiltInBrowserPreviewStreamResult,
  BuiltInBrowserStartPreviewStreamArgs,
  BuiltInBrowserStopPreviewStreamArgs,
  BuiltInBrowserStopRecordingResult,
  BuiltInBrowserZoomResult,
  BuiltInBrowserSelectResult,
  BuiltInBrowserAgentPresence,
  BuiltInBrowserStatus,
  BuiltInBrowserTabArgs,
  BuiltInBrowserTabTargetArgs,
  PersonalChatCallArgs,
  PersonalChatMachineTarget,
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
  SearchIndexStatus,
  SearchQueryArgs,
  SearchQueryResult,
  SearchRebuildResult,
  AdeUsagePriceOverrides,
} from "../shared/types";
import type {
  ApiCredentialGetArgs,
  ApiCredentialListArgs,
  ApiCredentialRemoveArgs,
  ApiCredentialStoreArgs,
  ApiCredentialSummary,
} from "../shared/types/apiCredentials";
import type { GitHubIssueCommentLike, GitHubIssueLike, GitHubIssuePatch } from "../shared/laneGitHubIssue";
import type {
  AgentChatCopyTempAttachmentArgs,
  ChatAttachmentStagingMode,
  ConvertImageToJpegResult,
  WorkBoardMoveTarget,
} from "../shared/types/chat";
import type { DiskPressureSnapshot } from "../main/services/storage/diskPressure";
import type {
  ArchiveActionArgs,
  ArchiveActionResult,
  ArchiveListArgs,
  ArchiveListResult,
  ArchiveSummary,
  ArchiveSummaryArgs,
} from "../shared/types/archive";
import type {
  MaintenanceRunReport,
  DeletedLaneChatsSummary,
  RuntimeHealthSnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageCompressionResult,
  StorageSnapshot,
} from "../shared/types/storage";
import type { ProjectHealthFixArgs, ProjectHealthFixResult, ProjectHealthReport } from "../shared/types/projectHealth";
import type { ProjectDataProblem, ProjectDataRestoreResult, ProjectDataStatus, ProjectRecoveryDiagnosis, ProjectRepairReport, RepairStepResult } from "../shared/types/recovery";
import type {
  ProjectMoveAttention,
  ProjectMoveCleanupArgs,
  ProjectMovePreflight,
  ProjectMoveProgress,
  ProjectMoveRecord,
  ProjectMoveResult,
  ProjectMoveStartArgs,
  ProjectMoveVolume,
} from "../shared/types/projectMove";
import type { MachineResetOptions, MachineResetPlan } from "../shared/types/machineReset";
import type {
  WorkToolId,
  WorkToolsLaneState,
  WorkToolsObservationPreview,
} from "../shared/types/workTools";
import type { WorkToolShowAck, WorkToolShowRequest } from "../shared/types/workToolShow";
import type {
  DiagnosticReportPayload,
  DiagnosticReportRequestPayload,
  DiagnosticsAutoSentPayload,
  DiagnosticsManualSendOptions,
  DiagnosticsManualSendResult,
  DiagnosticsSharingStatus,
} from "../shared/types/diagnostics";
import type { AppPackageChannel } from "../shared/packageChannel";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
  ProductAnalyticsReplayConfig,
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
        /** This desktop app's in-app survey. Absent on the web client, which shows none. */
        surveys?: ProductSurveyBridge;
        /**
         * Session replay settings for this desktop window, null while analytics
         * is off. Absent on the web client, which records no replay.
         */
        getReplayConfig?: () => Promise<ProductAnalyticsReplayConfig | null>;
      };
      app: {
        /**
         * Host platform/arch, captured in preload so the renderer can gate
         * synchronously at first paint. `app.getInfo()` carries the same values
         * but is an async IPC round trip, which is too late for module-scope
         * and first-render decisions.
         */
        runtimeTarget: { platform: string; arch: string };
        /** This desktop install's id; absent on the web client. See `shared/sessionInputOrigin.ts`. */
        desktopClientId?: string;
        /**
         * Release channel of this build, captured in preload from the argv the
         * main process injects. Synchronous for the same reason as
         * `runtimeTarget`: the shell header gates the channel badge at first
         * paint. `app.getInfo().packageChannel`
         * carries the same value for callers that already await it.
         */
        packageChannel: AppPackageChannel;
        /** The running build's update track (Stable or Beta). Synchronous, like `packageChannel`. */
        updateTrack: UpdateTrack;
        ping: () => Promise<"pong">;
        setDockBadgeCount: (count: number) => Promise<{ ok: true }>;
        /** Swallow this window's menu accelerators while a takeover drives. */
        setIgnoreMenuShortcuts: (ignore: boolean) => Promise<{ ok: true }>;
        getInfo: () => Promise<AppInfo>;
        /**
         * Probes the background service now if its cached installed/running
         * answer is older than two seconds, and resolves once it has landed.
         * Call it when a surface that shows that answer opens; `getInfo` itself
         * answers from cache. Absent on the hosted-web client.
         */
        refreshServiceHealth?: () => Promise<void>;
        getInstalledEditors: () => Promise<EditorTarget[]>;
        /**
         * The browsers this machine can open a link in, each with its app icon
         * as a data URL. Desktop only — the hosted-web client has no OS apps to
         * detect, so callers feature-detect before offering the choice.
         */
        getInstalledBrowsers?: () => Promise<InstalledBrowser[]>;
        /** Open a URL in one of the browsers `getInstalledBrowsers` returned. */
        openInBrowser?: (args: { url: string; browserId: string }) => Promise<void>;
        /**
         * An installed app's icon by its name ("Xcode", "Notes"), as a data
         * URL, or null. macOS only; elsewhere, and on the hosted-web client,
         * the method is absent or answers null, and callers draw a glyph.
         */
        getAppIcon?: (args: { name: string }) => Promise<string | null>;
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
        /**
         * The quit confirmation main asks this window to show. Call
         * `quitPromptShown` once it is on screen, then answer. Native desktop
         * only; absent on the hosted-web client and browser mock.
         */
        onQuitPrompt?: (cb: (request: QuitPromptRequest) => void) => () => void;
        /** Main is asking natively instead; drop the prompt with this id. */
        onQuitPromptDismiss?: (cb: (requestId: string) => void) => () => void;
        quitPromptShown?: (requestId: string) => void;
        /** Resolves with the repair outcome for a "repair" choice, else null. */
        answerQuitPrompt?: (answer: QuitPromptAnswer) => Promise<QuitPromptRepairResult | null>;
        /** Whether ADE confirms before quitting; "Don't ask again" turns it off. */
        getAskBeforeQuit?: () => Promise<boolean>;
        setAskBeforeQuit?: (ask: boolean) => Promise<boolean>;
        /** What runs agents on this computer, and what stopping would end. */
        getBackgroundService?: () => Promise<BackgroundServiceSummary>;
        /** Stops the background service and every agent in it, then quits ADE. */
        stopBackgroundServiceAndQuit?: (request: StopBackgroundServiceRequest) => Promise<StopBackgroundServiceResult>;
        getLatestRelease: () => Promise<LatestReleaseInfo | null>;
        getProject: () => Promise<ProjectInfo | null>;
        getWindowSession: () => Promise<{
          windowId: number | null;
          project: ProjectInfo | null;
          binding: OpenProjectBinding | null;
          openProjectTabs: ProjectInfo[];
          /** Every local tab root, including ones whose project is not loaded. */
          openProjectTabRoots?: string[];
          /** Hosted web persists remote machine/project tabs in this browser. */
          openProjectBindings?: OpenProjectBinding[];
          /** Desktop: the saved repository tabs this window reopens after a launch (S5). */
          repositoryTabs?: SavedWindowRepositoryTabs | null;
        }>;
        getWelcomeVideoState: () => Promise<AppWelcomeVideoState>;
        markWelcomeVideoSeen: (
          reason: "completed" | "dismissed",
        ) => Promise<AppWelcomeVideoState>;
        /** First-run setup: git projects Claude Code and Codex used on this computer. Desktop only. */
        discoverOnboardingProjects?: () => Promise<OnboardingProjectDiscovery>;
        /** First-run setup: add these checkouts as project tabs without opening them. Desktop only. */
        addOnboardingProjects?: (rootPaths: string[]) => Promise<RecentProjectSummary[]>;
        /** First-run setup: one project's chats from the last `ONBOARDING_CHAT_WINDOW_DAYS` days on this computer, for the import picker. Desktop only. */
        listOnboardingProjectChats?: (rootPath: string) => Promise<OnboardingProjectChat[]>;
        /** First-run setup: a chosen folder as the project it belongs to, or null outside a git checkout. Desktop only. */
        resolveOnboardingFolder?: (folder: string) => Promise<OnboardingProjectCandidate | null>;
        getLaunchGateState: () => Promise<{ resolved: boolean }>;
        resolveLaunchGate: () => Promise<{ resolved: true }>;
        setWindowProjectTabs: (
          rootPaths: string[],
        ) => Promise<{ openProjectTabs: ProjectInfo[] }>;
        /** Desktop: the window's repository tabs, which main saves and reopens on the next launch (S5). Absent on web. */
        setWindowRepositoryTabs?: (tabs: SavedWindowRepositoryTabs) => Promise<{ ok: true }>;
        /** Hosted-web-only retained binding persistence; absent on native desktop. */
        setWindowProjectBindings?: (
          bindings: OpenProjectBinding[],
        ) => Promise<{ openProjectBindings: OpenProjectBinding[] }>;
        newWindow: () => Promise<{ windowId: number | null }>;
        openProjectInNewWindow: (
          binding: OpenProjectBinding,
        ) => Promise<{ windowId: number | null; project: ProjectInfo | null }>;
        projectTabDragStart: (args: {
          binding: OpenProjectBinding;
          grab: { x: number; y: number };
          moveSource: boolean;
          /** The pointer, in screen coordinates. */
          point: { x: number; y: number };
        }) => Promise<{ windowId: number | null }>;
        projectTabDragMove: (point: { x: number; y: number }) => void;
        /**
         * Ends the drag at `point`; null cancels it without a drop.
         * `intoSender` is true when the tab was dropped back on its own window.
         */
        projectTabDragEnd: (
          point: { x: number; y: number } | null,
        ) => Promise<{ merged: boolean; intoSender: boolean }>;
        onAdoptProjectTab: (cb: (request: ProjectTabAdoptRequest) => void) => () => void;
        closeWindow: (windowId?: number | null) => Promise<{ closed: boolean }>;
        requestWindowClose: () => Promise<{ requested: boolean }>;
        onMenuCommand: (cb: (command: AppMenuCommand) => void) => () => void;
        onProjectChanged: (
          cb: (project: ProjectInfo | null) => void,
        ) => () => void;
        onProjectBindingChanged: (
          cb: (binding: OpenProjectBinding | null) => void,
        ) => () => void;
        /** Route a link that names its computer and project through the owner (desktop only). */
        openOwnedDeeplink?: (url: string) => Promise<boolean>;
        onNavigate: (cb: (request: AppNavigationRequest) => void) => () => void;
        openExternal: (url: string) => Promise<void>;
        openSystemSettingsPane: (
          paneId: SystemSettingsPaneId,
        ) => Promise<AppOpenSystemSettingsPaneResult>;
        revealPath: (path: string, pin?: OpenProjectBinding | null) => Promise<void>;
        openPath: (path: string, pin?: OpenProjectBinding | null) => Promise<void>;
        writeClipboardText: (text: string) => Promise<void>;
        readClipboardText: () => Promise<string>;
        getElevatedDesktop: () => Promise<boolean>;
        onElevatedDesktopChanged: (cb: (elevated: boolean) => void) => () => void;
        onWindowFocusChanged?: (cb: (focused: boolean) => void) => () => void;
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
        getImageDataUrl: (path: string, pin?: OpenProjectBinding | null) => Promise<{ dataUrl: string }>;
        writeClipboardImage: (path: string, pin?: OpenProjectBinding | null) => Promise<void>;
        openPathInEditor: (args: {
          rootPath: string;
          relativePath?: string;
          target: OpenPathTarget;
          remote?: OpenPathInEditorRemote;
        }, pin?: OpenProjectBinding | null) => Promise<void>;
        logDebugEvent: (
          event: string,
          payload?: Record<string, unknown>,
        ) => void;
        /** This window's memory snapshot (`renderer/lib/rendererMemorySnapshot.ts`). */
        reportRendererMemory?: (snapshot: RendererMemorySnapshot) => void;
      };
      /**
       * One copy's storage (Settings › Storage & cleanup): `pin` names the
       * copy, and it is required. `getPressure` is this computer's disk.
       */
      storage: {
        getPressure: () => Promise<DiskPressureSnapshot>;
        getSnapshot: (args: { forceRefresh?: boolean; measureLanes?: boolean } | undefined, pin: OpenProjectBinding) => Promise<StorageSnapshot>;
        compressNow: (pin: OpenProjectBinding) => Promise<StorageCompressionResult>;
        runMaintenanceNow: (pin: OpenProjectBinding) => Promise<MaintenanceRunReport>;
        deletedLaneChatsSummary: (pin: OpenProjectBinding) => Promise<DeletedLaneChatsSummary>;
        laneBuildOutputRemoved?: (
          laneId: string,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/types/storage").StorageItem["buildOutputRemoved"] | null>;
        cleanupPreview: (targets: StorageCleanupTarget[], pin: OpenProjectBinding) => Promise<StorageCleanupPreview>;
        cleanup: (
          targets: StorageCleanupTarget[],
          opts: { preview: StorageCleanupPreview },
          pin: OpenProjectBinding,
        ) => Promise<StorageCleanupResult>;
      };
      /** Project health: issues with a fix each, from the copy `pin` names (required). */
      projectHealth: {
        getReport: (args: { forceRefresh?: boolean } | undefined, pin: OpenProjectBinding) => Promise<ProjectHealthReport>;
        fix: (args: ProjectHealthFixArgs, pin: OpenProjectBinding) => Promise<ProjectHealthFixResult>;
      };
      /**
       * One archive across lanes, chats, and shells. Every call takes an
       * optional machine pin, like `storage`, so Settings → Archive reaches
       * the machine it is showing.
       */
      archive: {
        list: (args: ArchiveListArgs | undefined, pin: OpenProjectBinding) => Promise<ArchiveListResult>;
        summary: (args: ArchiveSummaryArgs | undefined, pin: OpenProjectBinding) => Promise<ArchiveSummary>;
        restore: (args: ArchiveActionArgs, pin: OpenProjectBinding) => Promise<ArchiveActionResult>;
        delete: (args: ArchiveActionArgs, pin: OpenProjectBinding) => Promise<ArchiveActionResult>;
      };
      project: {
        openRepo: (args?: { rootPath?: string; trustGitOwnership?: boolean }) => Promise<ProjectInfo | null>;
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
          args: ClearLocalAdeDataArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ClearLocalAdeDataResult>;
        listRecent: () => Promise<RecentProjectSummary[]>;
        /** This computer's folders as its brain registers them; empty while the brain is not connected. Optional: the hosted web client has none. */
        listThisComputer?: () => Promise<RecentProjectSummary[]>;
        /** The account's project list as this computer (or the pinned machine) last read it. Optional: the hosted web client has none yet. */
        accountList?: (pin?: OpenProjectBinding | null) => Promise<AccountProjectListResult>;
        /** Adds a GitHub repository (URL or origin) to the account's project list, with no copy anywhere (S13). Desktop only. */
        accountAdd?: (origin: string) => Promise<AccountProjectChangeResult>;
        /** Removes a project from the account's project list (S13). Folders on machines stay. Desktop only. */
        accountRemove?: (projectId: string) => Promise<AccountProjectChangeResult>;
        findForRepo: (args: {
          repoOwner: string;
          repoName: string;
        }) => Promise<ProjectFindForRepoResult>;
        closeCurrent: () => Promise<void>;
        switchToPath: (rootPath: string) => Promise<ProjectInfo>;
        /** The state of this computer's copy, for the remove dialog. */
        inspectRemoval?: (rootPath: string) => Promise<ProjectRemovalReport>;
        /** Removes this computer's entry for a project and, when asked, moves its folder to the Trash. */
        removeCopy?: (rootPath: string, request: ProjectRemovalRequest) => Promise<ProjectRemovalOutcome>;
        forgetRecent: (keyOrRootPath: string) => Promise<RecentProjectSummary[]>;
        /**
         * Forget the refusal of a project this computer's ADE stopped opening
         * because its folder is too slow (`project_folder_too_slow`), so the
         * next open really tries. Resolves false when the refusal could not be
         * cleared (no brain, a root ADE does not know). Local projects only: a project on another
         * machine is retried there (`ade projects retry --machine`).
         */
        retryOpen: (rootPath: string) => Promise<boolean>;
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
        getSnapshot: (pin: OpenProjectBinding) => Promise<AdeProjectSnapshot>;
        initializeOrRepair: (pin: OpenProjectBinding) => Promise<AdeCleanupResult>;
        runIntegrityCheck: (pin: OpenProjectBinding) => Promise<AdeCleanupResult>;
        onMissing: (cb: (data: { rootPath: string }) => void) => () => void;
        onStateEvent: (cb: (event: AdeProjectEvent) => void, pin: OpenProjectBinding) => () => void;
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
         * a button that cannot work, and "Report issue" falls back to
         * `openIssue`. Pass an error screen's context to report about it.
         */
        sendManual?: (
          context?: DiagnosticReportRequestPayload,
          options?: DiagnosticsManualSendOptions,
        ) => Promise<DiagnosticsManualSendResult>;
        /**
         * True when a `userMessage` sent with a report reaches ADE (as Sentry
         * User Feedback). Absent on older preloads and false where Sentry is off.
         */
        userFeedbackAvailable?: boolean;
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
      /**
       * Moving a project to a new folder on this Mac. Optional: older preloads
       * lack it, and the Settings row hides itself then. Local only: the
       * project must live on the machine this window runs on.
       */
      projectMove?: {
        listVolumes: () => Promise<ProjectMoveVolume[]>;
        preflight: (args: { projectRoot: string; destinationRoot: string }) => Promise<ProjectMovePreflight>;
        start: (args: ProjectMoveStartArgs) => Promise<ProjectMoveResult>;
        status: (projectRoot: string) => Promise<ProjectMoveRecord | null>;
        attention: () => Promise<ProjectMoveAttention>;
        cleanup: (args: ProjectMoveCleanupArgs) => Promise<ProjectMoveRecord>;
        reveal: (args: { moveId: string; which: "original" | "moved" }) => Promise<void>;
        chooseFolder: (defaultPath?: string) => Promise<string | null>;
        onProgress: (cb: (progress: ProjectMoveProgress) => void) => () => void;
      };
      recovery: {
        diagnose: (projectRoot: string) => Promise<ProjectRecoveryDiagnosis>;
        repair: (projectRoot: string) => Promise<ProjectRepairReport>;
        /** Opens System Settings at Login Items (macOS). Optional: older preloads lack it. */
        openBackgroundSettings?: () => Promise<{ opened: boolean }>;
        /** Optional: older preloads lack the missing-data recovery calls. */
        restoreProjectData?: (projectRoot: string) => Promise<ProjectDataRestoreResult>;
        startFresh?: (projectRoot: string) => Promise<void>;
        /** Whether a project's ADE data is missing or swapped; no root asks about the project that failed to reopen at launch. */
        projectDataStatus?: (projectRoot?: string) => Promise<ProjectDataStatus | null>;
        /** An open project's .ade folder or database was moved or deleted. */
        onProjectDataMissing?: (cb: (payload: { projectRoot: string; status: ProjectDataProblem }) => void) => () => void;
        /**
         * Live repair steps for the window that started the repair. Optional
         * for the same reason `diagnostics` is: an older preload does not have
         * it, and every call site already guards before calling.
         */
        onRepairStep?: (
          cb: (payload: { projectRoot: string; step: RepairStepResult }) => void,
        ) => () => void;
      };
      /** The hard reset. Optional: older preloads do not have it. */
      machineReset?: {
        plan: () => Promise<MachineResetPlan>;
        start: (options: MachineResetOptions) => Promise<{ started: boolean; cancelled?: boolean; error?: string }>;
        chooseRescueDir: () => Promise<string | null>;
      };
      remoteRuntime: {
        listTargets: () => Promise<RemoteRuntimeTarget[]>;
        /** The account computer and project a link to something in `binding` names. */
        linkOwnership: (binding: OpenProjectBinding | null) => Promise<DeeplinkOwnership | null>;
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
        checkReachability?: (id: string) => Promise<import("../shared/connectionDiagnosis").HostReachabilityReport>;
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
        /**
         * What "Update & restart" would stop on that machine right now. Never
         * rejects: a machine that cannot answer comes back `checked: false`.
         */
        getUpdateImpact: (id: string) => Promise<UpdateImpact>;
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
        /**
         * Pick an image on this machine and store it as the icon of a project
         * on the remote host (every device then sees it). Resolves null when
         * the user cancels; rejects with "Update ADE on <machine> to change its
         * icon." when the host is too old.
         */
        chooseProjectIcon: (
          id: string,
          rootPath: string,
        ) => Promise<ProjectIcon | null>;
        /** Clear the host project's custom icon; resolves the fallback icon, if any. */
        removeProjectIcon: (
          id: string,
          rootPath: string,
        ) => Promise<ProjectIcon | null>;
        /** The state of the host's copy, for the remove dialog. Only for a connected machine; never wakes one. */
        inspectProjectRemoval?: (
          id: string,
          projectId: string,
        ) => Promise<RemoteProjectRemovalInspection>;
        /** Removes the host's entry for a project and, when asked, deletes its folder there for good. */
        removeProjectCopy?: (
          id: string,
          projectId: string,
          request: ProjectRemovalRequest,
        ) => Promise<ProjectRemovalOutcome>;
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
        /** `target` names the machine; left out, the window's bound machine. */
        call: (
          request: PersonalChatCallArgs,
          target?: PersonalChatMachineTarget | null,
        ) => Promise<PersonalChatCallResponse>;
        streamEvents: (
          request?: PersonalChatStreamEventsArgs,
          target?: PersonalChatMachineTarget | null,
        ) => Promise<PersonalChatStreamEventsResult>;
      };
      keybindings: {
        get: (pin?: OpenProjectBinding | null) => Promise<KeybindingsSnapshot>;
        set: (overrides: KeybindingOverride[], pin?: OpenProjectBinding | null) => Promise<KeybindingsSnapshot>;
      };
      projectSecrets: {
        list: (pin: OpenProjectBinding) => Promise<ProjectSecretsListResult>;
        get: (args: ProjectSecretGetArgs, pin: OpenProjectBinding) => Promise<ProjectSecretValueResult>;
        set: (args: ProjectSecretSetArgs, pin: OpenProjectBinding) => Promise<ProjectSecretSummary>;
        delete: (args: ProjectSecretDeleteArgs, pin: OpenProjectBinding) => Promise<{ deleted: boolean; name: string }>;
        pullFromAccount: (pin: OpenProjectBinding) => Promise<ProjectSecretPullResult>;
        chooseEnvFile: (pin: OpenProjectBinding) => Promise<ProjectSecretsImportPreview | null>;
        importEnv: (args: ProjectSecretsImportArgs, pin: OpenProjectBinding) => Promise<ProjectSecretsImportResult>;
        exportEnv: (pin: OpenProjectBinding) => Promise<ProjectSecretsExportResult>;
      };
      ai: {
        /**
         * Ask Jev (OpenCode Zen's free decision model) on the machine `pin`
         * names. `null` on any failure: not signed in, turned off, rate
         * limited, slow, or an unusable answer. Use your existing logic then.
         */
        jevDecide: <Q extends JevQuestions>(request: JevDecideRequest<Q>, pin?: OpenProjectBinding | null) => Promise<JevAnswers<Q> | null>;
        /** The helper's availability, breaker and counts; `null` when that machine cannot say. */
        jevStatus: (pin?: OpenProjectBinding | null) => Promise<JevStatus | null>;
        /**
         * "Continue chats after restarts", one value per machine. Unpinned:
         * This computer; with a pin, that machine's brain.
         */
        getContinueAfterRestart: (pin?: OpenProjectBinding | null) => Promise<{ enabled: boolean }>;
        setContinueAfterRestart: (enabled: boolean, pin?: OpenProjectBinding | null) => Promise<{ enabled: boolean }>;
        /**
         * The update track a machine saved (`~/.ade/update-track.json`), or
         * null when it follows its build. Unpinned: This computer.
         */
        getMachineUpdateTrack: (pin?: OpenProjectBinding | null) => Promise<{ track: "stable" | "beta" | null }>;
        getStatus: (args?: {
          force?: boolean;
          refreshOpenCodeInventory?: boolean;
        }, pin?: OpenProjectBinding | null) => Promise<AiSettingsStatus>;
        getOpenCodeRuntimeDiagnostics: (pin?: OpenProjectBinding | null) => Promise<OpenCodeRuntimeSnapshot>;
        isOpenCodeInstalled: (pin?: OpenProjectBinding | null) => Promise<{ installed: boolean; source: "user-installed" | "tools-cache" | "bundled" | "missing" }>;
        museBinaryStatus: (pin?: OpenProjectBinding | null) => Promise<MuseBinaryStatus>;
        ensureMuseBinary: (pin?: OpenProjectBinding | null) => Promise<MuseBinaryStatus>;
        /**
         * ADE's pinned copy of a provider's tool on the machine `pin` names.
         * Optional: an older preload predates it, so callers guard.
         */
        pinnedToolStatus?: (args: { provider: string }, pin?: OpenProjectBinding | null) => Promise<PinnedProviderToolStatus>;
        /**
         * What a provider's agent receives when a lane chat starts on the
         * machine `pin` names. Optional: an older preload predates it.
         */
        getProviderContextInventory?: (
          args: import("../shared/types/providerContext").GetProviderContextInventoryArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types/providerContext").ProviderContextInventory | null>;
        /**
         * Show one of the Initial context window card's files in Finder, on
         * This computer only. Refuses paths outside the providers' config
         * homes, the project and ADE's folders.
         */
        revealProviderContextPath?: (path: string) => Promise<void>;
        /** Start (or join) that copy's download there and return at once; poll `pinnedToolStatus`. */
        pinnedToolDownload?: (args: { provider: string }, pin?: OpenProjectBinding | null) => Promise<PinnedProviderToolStatus>;
        /**
         * Antigravity sign-in on the machine `pin` names (the ACP `authenticate`
         * request). Optional: an older preload or brain predates it.
         */
        antigravitySignInStatus?: (pin?: OpenProjectBinding | null) => Promise<AntigravitySignInState>;
        antigravitySignInStart?: (args: AntigravitySignInStartArgs, pin?: OpenProjectBinding | null) => Promise<AntigravitySignInState>;
        /** Forward a pasted 127.0.0.1 return URL to that machine's agent. */
        antigravitySignInComplete?: (args: AntigravitySignInCompleteArgs, pin?: OpenProjectBinding | null) => Promise<AntigravitySignInState>;
        antigravitySignInCancel?: (args: AntigravitySignInCancelArgs, pin?: OpenProjectBinding | null) => Promise<AntigravitySignInState>;
        /**
         * An agent CLI's own sign-in (Grok, Devin, Muse, Copilot, Droid, Kimi)
         * on the machine `pin` names: ADE's copy of the CLI runs there in a
         * private PTY; poll `cliLoginStatus` with the same pin. Optional: an
         * older preload or brain predates it.
         */
        cliLoginStart?: (args: AgentCliLoginStartArgs, pin?: OpenProjectBinding | null) => Promise<AgentCliLoginStatus>;
        cliLoginStatus?: (args: AgentCliLoginRefArgs, pin?: OpenProjectBinding | null) => Promise<AgentCliLoginStatus>;
        /** Type a code pasted from the browser into the CLI (Devin). */
        cliLoginSubmitCode?: (args: AgentCliLoginSubmitCodeArgs, pin?: OpenProjectBinding | null) => Promise<AgentCliLoginStatus>;
        cliLoginCancel?: (args: AgentCliLoginRefArgs, pin?: OpenProjectBinding | null) => Promise<AgentCliLoginStatus>;
        /** Settings > Muse Code on the machine `pin` names: a Settings-owned `muse serve` host per `handleId`. */
        museSettings: <R extends MuseSettingsRequest>(
          args: MuseSettingsRunArgs<R>,
          pin?: OpenProjectBinding | null,
        ) => Promise<MuseSettingsResult<R["kind"]>>;
        museSettingsClose: (args: { handleId: string }, pin?: OpenProjectBinding | null) => Promise<{ ok: true }>;
        getToolsCache: () => Promise<AgentToolsCacheSnapshot>;
        ensureToolsCache: () => Promise<AgentToolsCacheSnapshot>;
        onToolsCacheEvent: (cb: (snapshot: AgentToolsCacheSnapshot) => void) => () => void;
        storeApiKey: (provider: string, key: string, pin?: OpenProjectBinding | null) => Promise<void>;
        deleteApiKey: (provider: string, pin?: OpenProjectBinding | null) => Promise<void>;
        listApiKeys: (pin?: OpenProjectBinding | null) => Promise<string[]>;
        verifyApiKey: (provider: string, pin?: OpenProjectBinding | null) => Promise<AiApiKeyVerificationResult>;
        /**
         * Runs one provider's own sign-in check (up to 20 s): right after a
         * sign-in and on Re-check only. A remote ADE older than this action
         * rejects it; callers read that as "unknown".
         */
        verifyProviderSignIn: (args: AiVerifyProviderSignInArgs, pin?: OpenProjectBinding | null) => Promise<AiProviderSignInCheck>;
        updateConfig: (config: Partial<AiConfig>, pin?: OpenProjectBinding | null) => Promise<void>;
        /**
         * Optional: shipped after this group did, so an older preload will not
         * have it and callers must guard before reaching for it.
         */
        acpProviderDiagnostics?: (args: {
          provider: "qwen" | "kimi" | "grok" | "copilot" | "devin" | "antigravity";
          runDoctor?: boolean;
        }, pin?: OpenProjectBinding | null) => Promise<AcpProviderDiagnostics>;
        opencodeAuthMethods: (pin?: OpenProjectBinding | null) => Promise<{ methods: OpenCodeProviderAuthMethods }>;
        opencodeOAuthStart: (args: {
          providerId: string;
          methodIndex: number;
          inputs?: Record<string, string>;
        }, pin?: OpenProjectBinding | null) => Promise<OpenCodeOAuthStartResult>;
        opencodeOAuthCancel: (args: { providerId: string }, pin?: OpenProjectBinding | null) => Promise<void>;
        setOpencodeProviderKey: (args: {
          providerId: string;
          key: string;
        }, pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error?: string }>;
        clearOpencodeProviderKey: (args: {
          providerId: string;
        }, pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error?: string }>;
        /** OpenCode logins on the pinned machine, one provider's or all; never a secret. */
        opencodeAccounts: (args: { providerId?: string | null }, pin?: OpenProjectBinding | null) => Promise<OpenCodeAccountsResult>;
        /** Make one login the one every chat on that machine uses for its provider. */
        opencodeAccountActivate: (args: { id: string }, pin?: OpenProjectBinding | null) => Promise<OpenCodeAccountActionResult>;
        opencodeAccountRename: (args: { id: string; label: string }, pin?: OpenProjectBinding | null) => Promise<OpenCodeAccountActionResult>;
        opencodeAccountRemove: (args: { id: string }, pin?: OpenProjectBinding | null) => Promise<OpenCodeAccountActionResult>;
        /** Add a cloud login (gcloud, an AWS profile) and save it to the ADE account. */
        opencodeCloudConnect: (args: {
          providerId: string;
          methodIndex: number;
          inputs?: Record<string, string>;
          label?: string;
        }, pin?: OpenProjectBinding | null) => Promise<OpenCodeCloudConnectResult>;
        refreshModelsDev: (pin?: OpenProjectBinding | null) => Promise<{ lastFetchedAt: number | null }>;
        /** Every model a harness can reach outside its own sign-in (Custom providers). */
        listHarnessRoutes: (pin?: OpenProjectBinding | null) => Promise<import("../shared/harnessRoutes").HarnessRouteCatalog>;
        /** One-token live check of a harness + source + model; records the verdict for routing. */
        testHarnessRoute: (
          args: {
            harness: string;
            source: import("../shared/harnessRoutes").HarnessRouteSource["source"];
            model: string;
          },
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/harnessRoutes").HarnessRouteTestResult>;
        onOpencodeOAuthStatus: (cb: (event: OpenCodeOAuthStatusEvent) => void, pin?: OpenProjectBinding | null) => () => void;
        piLoginProviders: (pin?: OpenProjectBinding | null) => Promise<PiLoginProvider[]>;
        piLoginStart: (args: {
          providerId: string;
          method?: PiLoginMethod;
        }, pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error?: string }>;
        piLoginSubmit: (args: {
          providerId: string;
          requestId: string;
          value: string;
        }, pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error?: string }>;
        piLoginCancel: (args: { providerId: string }, pin?: OpenProjectBinding | null) => Promise<void>;
        onPiAuthStatus: (cb: (event: PiAuthStatusEvent) => void, pin?: OpenProjectBinding | null) => () => void;
        cursorAuthStatus: (pin?: OpenProjectBinding | null) => Promise<CursorSdkAuthStatus>;
        cursorAuthLogin: (pin?: OpenProjectBinding | null) => Promise<CursorSdkLoginResult>;
        cursorAuthLogout: (pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error?: string }>;
        cursorAuthCancel: (pin?: OpenProjectBinding | null) => Promise<void>;
        onCursorAuthStatus: (cb: (event: CursorSdkAuthEvent) => void, pin?: OpenProjectBinding | null) => () => void;
        /** `refresh` skips the host's few-minute cache (Retry). */
        cursorCloudListRepositories: (args: { refresh?: boolean } | undefined, pin: OpenProjectBinding) => Promise<CursorCloudRepository[]>;
        cursorCloudListAgents: (args: {
          includeArchived?: boolean;
          limit?: number;
          cursor?: string | null;
        } | undefined, pin: OpenProjectBinding) => Promise<CursorCloudListAgentsResult>;
        cursorCloudListRuns: (args: {
          agentId: string;
          limit?: number;
          cursor?: string | null;
        }, pin: OpenProjectBinding) => Promise<CursorCloudListRunsResult>;
        cursorCloudCreateRun: (
          args: CursorCloudCreateRunRequest,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudCreateRunResult>;
        cursorCloudGetLaneSecretNames: (laneId: string, pin: OpenProjectBinding) => Promise<string[]>;
        cursorCloudArchiveAgent: (agentId: string, pin: OpenProjectBinding) => Promise<void>;
        cursorCloudUnarchiveAgent: (agentId: string, pin: OpenProjectBinding) => Promise<void>;
        cursorCloudDeleteAgent: (agentId: string, pin: OpenProjectBinding) => Promise<void>;
        cursorCloudGetAgent: (
          agentId: string,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudAgentSummary | null>;
        cursorCloudGetUsage: (
          args: CursorAgentUsageRequest,
          pin: OpenProjectBinding,
        ) => Promise<CursorAgentUsage>;
        cursorCloudStreamRun: (
          args: CursorCloudStreamRunRequest,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudStreamRunResult>;
        cursorCloudCancelRun: (args: {
          agentId: string;
          runId: string;
        }, pin: OpenProjectBinding) => Promise<void>;
        cursorCloudFollowUp: (
          args: CursorCloudFollowUpRequest,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudFollowUpResult>;
        cursorCloudListArtifacts: (
          agentId: string,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudArtifactSummary[]>;
        cursorCloudDownloadArtifact: (args: {
          agentId: string;
          path: string;
        }, pin?: OpenProjectBinding | null) => Promise<CursorCloudArtifactDownload>;
        cursorCloudOpenChat: (
          args: CursorCloudOpenChatRequest,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudOpenChatResult>;
        cursorCloudWatchMirror: (
          args: CursorCloudWatchMirrorRequest,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        cursorCloudFleet: (args: {
          includeArchived?: boolean;
          limit?: number;
        } | undefined, pin: OpenProjectBinding) => Promise<CursorCloudFleetResult>;
        cursorCloudPullIntoLane: (
          agentId: string,
          pin: OpenProjectBinding,
        ) => Promise<CursorCloudPullIntoLaneResult>;
        cursorCloudResolveLane: (
          agentId: string,
          pin: OpenProjectBinding,
        ) => Promise<{ laneId: string; laneName: string; created: boolean }>;
        cursorCloudStopRun: (
          agentId: string,
          pin: OpenProjectBinding,
        ) => Promise<{ stopped: boolean }>;
        onCursorCloudFleetEvent: (
          cb: (event: CursorCloudFleetEvent) => void,
        ) => () => void;
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
          handler: (progress: { receivedBytes: number; totalBytes: number | null; stage?: "warmup" }) => void,
        ) => () => void;
        requestMicAccess: () => Promise<{
          status: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
          /** Why it was refused, when it was. Absent on older hosts. */
          block?: "os-denied" | "dev-build" | "no-device" | "in-use" | "unavailable" | null;
          /** What a later `NotAllowedError` would mean on this build. */
          deniedBlock?: "os-denied" | "dev-build" | "no-device" | "in-use" | "unavailable";
        }>;
      };
      modelPicker: {
        getFavorites: (pin?: OpenProjectBinding | null) => Promise<{ favorites: string[] }>;
        setFavorites: (favorites: string[], pin?: OpenProjectBinding | null) => Promise<{ favorites: string[] }>;
        toggleFavorite: (
          modelId: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ favorites: string[]; isFavorite: boolean }>;
        getRecents: (pin?: OpenProjectBinding | null) => Promise<{ recents: string[] }>;
        pushRecent: (modelId: string, pin?: OpenProjectBinding | null) => Promise<{ recents: string[] }>;
      };
      sync: {
        getStatus: (args?: SyncGetStatusArgs, pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        /** Always reads this physical machine's local ADE brain, even in a remote-bound window. */
        getLocalStatus: (args?: SyncGetStatusArgs) => Promise<SyncRoleSnapshot>;
        /**
         * "Can my other devices reach this computer?", answered by this
         * computer's own brain. Always this physical machine; absent on the
         * web client.
         */
        checkLocalReachability?: () => Promise<import("../shared/connectionDiagnosis").HostReachabilityReport>;
        refreshDiscovery: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        listDevices: (pin?: OpenProjectBinding | null) => Promise<SyncDeviceRuntimeState[]>;
        updateLocalDevice: (args: {
          name?: string;
          deviceType?: SyncPeerDeviceType;
        }, pin?: OpenProjectBinding | null) => Promise<SyncDeviceRecord>;
        connectToBrain: (
          draft: SyncDesktopConnectionDraft,
          pin?: OpenProjectBinding | null,
        ) => Promise<SyncRoleSnapshot>;
        disconnectFromBrain: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        forgetDevice: (deviceId: string, pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        getTransferReadiness: (pin?: OpenProjectBinding | null) => Promise<SyncTransferReadiness>;
        transferBrainToLocal: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        getPin: (pin?: OpenProjectBinding | null) => Promise<{ pin: string | null }>;
        setPin: (code: string, pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        generatePin: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        clearPin: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        getRuntimeName: (pin?: OpenProjectBinding | null) => Promise<{ runtimeName: string | null }>;
        setRuntimeName: (name: string, pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        clearRuntimeName: (pin?: OpenProjectBinding | null) => Promise<SyncRoleSnapshot>;
        setActiveLanePresence: (args: { laneIds: string[] }, pin: OpenProjectBinding) => Promise<void>;
        getCloudRelayStatus: (pin?: OpenProjectBinding | null) => Promise<SyncCloudRelayStatus>;
        onEvent: (cb: (event: SyncStatusEventPayload) => void, pin?: OpenProjectBinding | null) => () => void;
      };
      /** Devin Cloud sessions and Cursor Cloud agents, one contract for both panels. */
      cloudAgents: {
        list: (args: CloudAgentListArgs, pin: OpenProjectBinding) => Promise<CloudAgentList>;
        open: (args: CloudAgentRef, pin: OpenProjectBinding) => Promise<CloudAgentOpenResult>;
        stop: (args: CloudAgentRef, pin: OpenProjectBinding) => Promise<{ stopped: true }>;
        archive: (args: CloudAgentArchiveArgs, pin: OpenProjectBinding) => Promise<{ archived: boolean }>;
        launch: (args: CloudAgentLaunchArgs, pin: OpenProjectBinding) => Promise<CloudAgentOpenResult>;
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
        getStatus: (pin: OpenProjectBinding) => Promise<OnboardingStatus>;
        detectDefaults: (pin: OpenProjectBinding) => Promise<OnboardingDetectionResult>;
        setDismissed: (dismissed: boolean, pin: OpenProjectBinding) => Promise<OnboardingStatus>;
        complete: (pin: OpenProjectBinding) => Promise<OnboardingStatus>;
      };
      automations: {
        list: (pin: OpenProjectBinding) => Promise<AutomationRuleSummary[]>;
        toggle: (
          args: {
            id: string;
            enabled: boolean;
          },
          pin: OpenProjectBinding,
        ) => Promise<AutomationRuleSummary[]>;
        deleteRule: (
          args: AutomationDeleteRuleRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationRuleSummary[]>;
        triggerManually: (
          args: AutomationManualTriggerRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationRun>;
        planTest: (
          args: AutomationTestRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationTestPlan>;
        runTest: (
          args: AutomationTestRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationRun>;
        cleanUpTestRun: (
          args: { runId: string },
          pin: OpenProjectBinding,
        ) => Promise<AutomationTestCleanupResult>;
        getHistory: (
          args: {
            id: string;
            limit?: number;
          },
          pin: OpenProjectBinding,
        ) => Promise<AutomationRun[]>;
        listRuns: (
          args: AutomationRunListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AutomationRun[]>;
        getRunDetail: (
          runId: string,
          pin: OpenProjectBinding,
        ) => Promise<AutomationRunDetail | null>;
        getIngressStatus: (pin: OpenProjectBinding) => Promise<AutomationIngressStatus>;
        refreshWebhookGatewayStatus: (pin: OpenProjectBinding) => Promise<AutomationWebhookGatewayStatus>;
        setWebhookGatewayPublicUrl: (args: {
          publicUrl?: string | null;
        }, pin: OpenProjectBinding) => Promise<AutomationWebhookGatewayStatus>;
        listIngressEvents: (args: {
          limit?: number;
        } | undefined, pin: OpenProjectBinding) => Promise<AutomationIngressEventRecord[]>;
        parseNaturalLanguage: (
          req: AutomationParseNaturalLanguageRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationParseNaturalLanguageResult>;
        validateDraft: (
          req: AutomationValidateDraftRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationValidateDraftResult>;
        saveDraft: (
          req: AutomationSaveDraftRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationSaveDraftResult>;
        simulate: (
          req: AutomationSimulateRequest,
          pin: OpenProjectBinding,
        ) => Promise<AutomationSimulateResult>;
        listScheduledCleanups: (pin: OpenProjectBinding) => Promise<AutomationScheduledCleanup[]>;
        cancelScheduledCleanup: (id: string, pin: OpenProjectBinding) => Promise<boolean>;
        linearIngress: {
          getStatus: (pin: OpenProjectBinding) => Promise<AutomationLinearIngressStatus>;
          setup: (pin: OpenProjectBinding) => Promise<AutomationLinearIngressStatus>;
          teardown: (pin: OpenProjectBinding) => Promise<AutomationLinearIngressStatus>;
          pollNow: (pin: OpenProjectBinding) => Promise<AutomationLinearIngressStatus>;
        };
        /** Custom webhook URLs. `pin` targets the machine the rule runs on. */
        webhooks: {
          /** Every webhook automation with its URL, secret state and last delivery. */
          list: (pin: OpenProjectBinding) => Promise<AutomationWebhookListEntry[]>;
          createEndpoint: (args: { label?: string | null } | undefined, pin: OpenProjectBinding) => Promise<AutomationWebhookEndpoint>;
          getEndpoint: (args: { hookId: string }, pin: OpenProjectBinding) => Promise<AutomationWebhookEndpoint>;
          rotateEndpoint: (args: { hookId: string }, pin: OpenProjectBinding) => Promise<AutomationWebhookEndpoint>;
          listDeliveries: (args: { hookId: string; limit?: number }, pin: OpenProjectBinding) => Promise<AutomationWebhookDeliverySummary[]>;
          getDelivery: (args: { id: string }, pin: OpenProjectBinding) => Promise<AutomationWebhookDelivery | null>;
          replayDelivery: (args: { id: string }, pin: OpenProjectBinding) => Promise<AutomationWebhookDeliverySummary | null>;
          sendTest: (
            args: AutomationWebhookTestRequest & { config?: AutomationWebhookTriggerConfig | null },
            pin: OpenProjectBinding,
          ) => Promise<AutomationWebhookTestResult>;
        };
        onEvent: (cb: (ev: AutomationsEventPayload) => void, pin: OpenProjectBinding) => () => void;
      };
      actions: {
        listRegistry: (pin: OpenProjectBinding) => Promise<AdeActionRegistryEntry[]>;
      };
      attention: {
        /**
         * Sends a notification to the phones on the ADE account through the
         * project's runtime (`attention.sendNotification`). The automation
         * editor's "Send a test" uses it. Absent where no runtime can send.
         */
        sendNotification?: (
          args: { title: string; body?: string | null; open?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types").CustomNotificationResult>;
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
        /** Older hosts and the web client resolve `void`: activity unknown. */
        reportPresence: (
          presence: import("../shared/types").AttentionPresence,
        ) => Promise<import("../shared/types").AttentionPresenceReceipt | void>;
        /** `null` = the account service is unreachable right now; keep the current preferences. */
        getPreferences: (accountOwnerId: string) => Promise<
          import("../shared/types").AttentionPreferences | null
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
        /**
         * Mute one chat's notifications on every device. Account-scoped, so it
         * takes no pin: the chat's machine is not involved.
         */
        setSessionMuted?: (
          accountOwnerId: string,
          sessionId: string,
          muted: boolean,
        ) => Promise<void>;
        openItem: (
          item: import("../shared/types").AttentionItem,
        ) => Promise<void>;
        /**
         * An agent's message to show as a toast in this (focused) window. Desktop
         * only: the hosted web client has no main process to raise it.
         */
        onAlert?: (
          cb: (alert: import("../shared/types").AttentionDesktopAlert) => void,
        ) => () => void;
        openAlert?: (alert: import("../shared/types").AttentionDesktopAlert) => Promise<void>;
      };
      /**
       * The global capture gesture. Optional on the whole namespace, like
       * `cto`: the hosted web client has no main process to run a native helper
       * in, so every call site must optional-chain through it rather than
       * assume a desktop bridge.
       */
      captureGesture?: {
        updateSettings: (
          settings: import("../shared/types/captureGesture").CaptureGestureSettings,
        ) => Promise<import("../shared/types/captureGesture").CaptureGestureHealth>;
        getHealth: () => Promise<
          import("../shared/types/captureGesture").CaptureGestureHealth
        >;
        retry: () => Promise<
          import("../shared/types/captureGesture").CaptureGestureHealth
        >;
        /**
         * Take a shot now, without a chord. `started: false` means the request
         * was refused (gesture off, helper not up, capture already running) and
         * a `onFailure` event carries the reason.
         */
        captureNow: () => Promise<{ started: boolean }>;
        onShot: (
          cb: (shot: import("../shared/types/captureGesture").CaptureGestureShot) => void,
        ) => () => void;
        onFailure: (
          cb: (
            failure: import("../shared/types/captureGesture").CaptureGestureFailure,
          ) => void,
        ) => () => void;
      };
      usage: {
        /** `pin` reads that machine's usage; without it the tab's own binding answers. */
        getAdeStats: (args?: GetAdeUsageStatsArgs, pin?: OpenProjectBinding | null) => Promise<AdeUsageStats | null>;
        getSnapshot: (pin?: OpenProjectBinding | null) => Promise<UsageSnapshot | null>;
        refresh: (pin?: OpenProjectBinding | null) => Promise<UsageSnapshot | null>;
        refreshHistory: (pin?: OpenProjectBinding | null) => Promise<UsageSnapshot | null>;
        noteDemand: (pin?: OpenProjectBinding | null) => Promise<UsageSnapshot | null>;
        /**
         * Spend one banked reset credit for an account.
         *
         * Optional on the bridge: the web client and older preloads do not
         * expose it, and the row that offers "Use reset" checks for it rather
         * than assuming every host can.
         */
        consumeResetCredit?: (args: {
          accountId: string;
        }, pin?: OpenProjectBinding | null) => Promise<import("../shared/types").UsageResetCreditResult>;
        /**
         * Spend by chat, lane, or account, and one model's detail and price.
         * Optional on the bridge: an older preload or web host may not expose
         * them, and the Usage page hides what it cannot read.
         */
        getCostBreakdown?: (
          args: import("../shared/types").GetAdeUsageCostBreakdownArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types").AdeUsageCostBreakdown | null>;
        getModelDetail?: (
          args: import("../shared/types").GetAdeUsageModelDetailArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types").AdeUsageModelDetail | null>;
        /**
         * Every model the machine `pin` names can run, with its registry
         * profile. Null without a runtime. Optional on the bridge: an older
         * preload or web host may not expose it.
         */
        getModelCatalog?: (
          args?: { provider?: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ catalog: import("../main/services/router/modelCatalog").UserModelCatalog } | null>;
        getModelPriceOverrides?: (pin?: OpenProjectBinding | null) => Promise<AdeUsagePriceOverrides | null>;
        /**
         * This machine's GitHub contribution calendar (the profile's year of
         * green squares), read with its `gh` login; null without one.
         * Optional on the bridge: the web client does not expose it, and the
         * home page's Contributions card falls back to the usage stats.
         */
        getGithubContributions?: () => Promise<import("../shared/types").GithubContributionCalendar | null>;
        setModelPriceOverride?: (
          args: import("../shared/types").SetAdeUsageModelPriceArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types").AdeUsagePriceOverrides>;
        checkBudget: (args: BudgetCheckArgs, pin?: OpenProjectBinding | null) => Promise<BudgetCheckResult>;
        getCumulativeUsage: (args: {
          scope: BudgetCapScope;
          scopeId?: string;
          provider?: BudgetCapProvider;
        }, pin?: OpenProjectBinding | null) => Promise<{
          totalTokens: number;
          totalCostUsd: number;
          weekKey: string;
        }>;
        getBudgetConfig: (pin?: OpenProjectBinding | null) => Promise<BudgetCapConfig>;
        saveBudgetConfig: (config: BudgetCapConfig, pin?: OpenProjectBinding | null) => Promise<BudgetCapConfig>;
        onUpdate: (cb: (snapshot: UsageSnapshot) => void, pin?: OpenProjectBinding | null) => () => void;
      };
      lanes: {
        list: (
          args: ListLanesArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<LaneSummary[]>;
        listSnapshots: (args: ListLanesArgs | undefined, pin: OpenProjectBinding) => Promise<LaneListSnapshot[]>;
        create: (args: CreateLaneArgs, pin: OpenProjectBinding) => Promise<LaneSummary>;
        importBranch: (args: ImportBranchLaneArgs, pin: OpenProjectBinding) => Promise<LaneSummary>;
        previewBranchSwitch: (
          args: LaneBranchSwitchArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneBranchSwitchPreview>;
        switchBranch: (
          args: LaneBranchSwitchArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneBranchSwitchResult>;
        getBranchDrift: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<LaneBranchDrift | null>;
        resolveBranchDrift: (
          args: ResolveLaneBranchDriftArgs,
          pin: OpenProjectBinding,
        ) => Promise<ResolveLaneBranchDriftResult>;
        rename: (args: RenameLaneArgs, pin: OpenProjectBinding) => Promise<void>;
        /** Rename the lane's branch while it is unpushed, untracked and has no PR; `dryRun` only checks. */
        renameBranch: (args: RenameLaneBranchArgs, pin: OpenProjectBinding) => Promise<RenameLaneBranchResult>;
        /** Whether a new lane's branch can have this name on the lane's machine. */
        checkBranchName: (args: { name: string }, pin: OpenProjectBinding) => Promise<LaneBranchNameCheck>;
        updateAppearance: (
          args: UpdateLaneAppearanceArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        archive: (
          args: ArchiveLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        archiveAndReclaim: (
          args: ArchiveAndReclaimLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<ArchiveAndReclaimLaneResult>;
        unarchive: (args: ArchiveLaneArgs, pin: OpenProjectBinding) => Promise<RestoreLaneResult>;
        delete: (args: DeleteLaneArgs, pin: OpenProjectBinding) => Promise<void>;
        revealWorktree: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<void>;
        /** `rootPath` names a project on this machine; `pin` a project on another one. */
        revealLeftoverWorktree: (
          args: { laneId: string; rootPath?: string },
          pin: OpenProjectBinding,
        ) => Promise<void>;
        deleteLeftoverWorktree: (
          args: { laneId: string; rootPath?: string },
          pin: OpenProjectBinding,
        ) => Promise<{ removed: boolean }>;
        cancelDelete: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<{ cancelled: boolean; reason?: string }>;
        /** Stops the git checkout of a create, child create, import or branch switch started with this `operationId`. */
        cancelGitWrite: (
          args: CancelLaneGitWriteArgs,
          pin: OpenProjectBinding,
        ) => Promise<CancelLaneGitWriteResult>;
        listDeleteProgress: (pin: OpenProjectBinding) => Promise<LaneDeleteProgress[]>;
        /** Deleted lanes whose unsaved work ADE kept (30 days), newest first. */
        listDeleted: (pin: OpenProjectBinding) => Promise<DeletedLaneSnapshot[]>;
        /** Brings a deleted lane back as a new lane, with its uncommitted files. */
        restoreDeleted: (args: RestoreDeletedLaneArgs, pin: OpenProjectBinding) => Promise<RestoreDeletedLaneResult>;
        /** Drops a deleted lane's saved work for good. */
        removeDeleted: (args: RemoveDeletedLaneArgs, pin: OpenProjectBinding) => Promise<{ removed: boolean }>;
        /** "Push this branch?" before an ADE Cloud launch: is the start branch on GitHub? Runs on the pin's machine. */
        cloudStartBranch?: (
          args: import("../shared/types").CloudStartBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/types").CloudStartBranchCheck>;
        /** Pushes that start branch to origin, then answers the check again. */
        pushCloudStartBranch?: (
          args: import("../shared/types").CloudStartBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/types").CloudStartBranchCheck>;
        getDeleteRisk: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<LaneDeleteRisk>;
        getReclaimRisk: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<LaneReclaimRisk>;
        onDeleteEvent: (
          cb: (ev: LaneDeleteEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        onLifecycleEvent: (cb: (ev: LaneLifecycleEvent) => void, pin: OpenProjectBinding) => () => void;
        attachLinearIssueToSession: (args: {
          chatSessionId: string;
          issues: LaneLinearIssue[];
          role?: string;
          source?: string;
          includeInPr?: boolean;
          closeOnMerge?: boolean;
        }, pin: OpenProjectBinding) => Promise<SessionLinearIssueLink[]>;
        detachLinearIssueFromSession: (args: { chatSessionId: string; issueId?: string }, pin: OpenProjectBinding) => Promise<boolean>;
        listLinearIssuesForSession: (args: { chatSessionId: string }, pin: OpenProjectBinding) => Promise<SessionLinearIssueLink[]>;
        listLinearIssuesForLaneSessions: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<SessionLinearIssueLink[]>;
        attachGitHubIssueToSession: (args: {
          chatSessionId: string;
          issues: LaneGitHubIssue[];
          role?: string;
          source?: string;
          includeInPr?: boolean;
          closeOnMerge?: boolean;
        }, pin: OpenProjectBinding) => Promise<SessionGitHubIssueLink[]>;
        detachGitHubIssueFromSession: (args: { chatSessionId: string; issueId?: string }, pin: OpenProjectBinding) => Promise<boolean>;
        listGitHubIssuesForSession: (args: { chatSessionId: string }, pin: OpenProjectBinding) => Promise<SessionGitHubIssueLink[]>;
        listGitHubIssuesForLaneSessions: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<SessionGitHubIssueLink[]>;
        attachJiraIssueToSession: (args: {
          chatSessionId: string;
          issues: LaneJiraIssue[];
          role?: string;
          source?: string;
          includeInPr?: boolean;
          closeOnMerge?: boolean;
        }, pin: OpenProjectBinding) => Promise<SessionJiraIssueLink[]>;
        detachJiraIssueFromSession: (args: { chatSessionId: string; issueId?: string }, pin: OpenProjectBinding) => Promise<boolean>;
        listJiraIssuesForSession: (args: { chatSessionId: string }, pin: OpenProjectBinding) => Promise<SessionJiraIssueLink[]>;
        listJiraIssuesForLaneSessions: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<SessionJiraIssueLink[]>;
        unlinkLinearIssues: (args: { laneId: string; issueId?: string }, pin: OpenProjectBinding) => Promise<boolean>;
        rebaseStart: (args: RebaseStartArgs, pin: OpenProjectBinding) => Promise<RebaseStartResult>;
        rebasePush: (args: RebasePushArgs, pin: OpenProjectBinding) => Promise<RebaseRun>;
        rebaseRollback: (args: RebaseRollbackArgs, pin: OpenProjectBinding) => Promise<RebaseRun>;
        rebaseAbort: (args: RebaseAbortArgs, pin: OpenProjectBinding) => Promise<RebaseRun>;
        rebaseSubscribe: (
          cb: (ev: RebaseRunEventPayload) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        openFolder: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<void>;
        initEnv: (args: InitLaneEnvArgs, pin: OpenProjectBinding) => Promise<LaneEnvInitProgress>;
        getEnvStatus: (
          args: GetLaneEnvStatusArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneEnvInitProgress | null>;
        getOverlay: (args: GetLaneOverlayArgs, pin: OpenProjectBinding) => Promise<LaneOverlayOverrides>;
        onEnvEvent: (cb: (ev: LaneEnvInitEvent) => void, pin: OpenProjectBinding) => () => void;
        listTemplates: (pin: OpenProjectBinding) => Promise<LaneTemplate[]>;
        /** Lockfiles in the main checkout of the pinned (or tab's) machine and whether each install is current. */
        getDependencyStatus: (
          args: GetLaneDependencyStatusArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<LaneDependencyStatus>;
        acknowledgeDependencyStatus: (
          args: AcknowledgeLaneDependencyStatusArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<LaneDependencyStatus>;
        getTemplate: (
          args: GetLaneTemplateArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneTemplate | null>;
        getNewLaneDefaults: (pin: OpenProjectBinding) => Promise<NewLaneDefaultsSnapshot>;
        setNewLaneDefaults: (
          args: { defaults: Partial<NewLaneDefaults> },
          pin: OpenProjectBinding,
        ) => Promise<NewLaneDefaultsSnapshot>;
        getDefaultTemplate: (pin: OpenProjectBinding) => Promise<string | null>;
        setDefaultTemplate: (args: SetDefaultLaneTemplateArgs, pin: OpenProjectBinding) => Promise<void>;
        applyTemplate: (
          args: ApplyLaneTemplateArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneEnvInitProgress>;
        saveTemplate: (args: SaveLaneTemplateArgs, pin: OpenProjectBinding) => Promise<void>;
        deleteTemplate: (args: DeleteLaneTemplateArgs, pin: OpenProjectBinding) => Promise<void>;
        portGetLease: (args: GetPortLeaseArgs, pin: OpenProjectBinding) => Promise<PortLease | null>;
        portListLeases: (pin: OpenProjectBinding) => Promise<PortLease[]>;
        portAcquire: (args: AcquirePortLeaseArgs, pin: OpenProjectBinding) => Promise<PortLease>;
        portRelease: (args: ReleasePortLeaseArgs, pin: OpenProjectBinding) => Promise<void>;
        portListConflicts: (pin: OpenProjectBinding) => Promise<PortConflict[]>;
        portRecoverOrphans: (pin: OpenProjectBinding) => Promise<PortLease[]>;
        onPortEvent: (cb: (ev: PortAllocationEvent) => void, pin: OpenProjectBinding) => () => void;
        proxyGetStatus: (pin: OpenProjectBinding) => Promise<ProxyStatus>;
        proxyStart: (args: StartProxyArgs | undefined, pin: OpenProjectBinding) => Promise<ProxyStatus>;
        proxyStop: (pin: OpenProjectBinding) => Promise<void>;
        proxyAddRoute: (args: AddProxyRouteArgs, pin: OpenProjectBinding) => Promise<ProxyRoute>;
        proxyRemoveRoute: (args: RemoveProxyRouteArgs, pin: OpenProjectBinding) => Promise<void>;
        proxyGetPreviewInfo: (
          args: GetPreviewInfoArgs,
          pin: OpenProjectBinding,
        ) => Promise<LanePreviewInfo | null>;
        proxyOpenPreview: (args: OpenPreviewArgs, pin: OpenProjectBinding) => Promise<void>;
        onProxyEvent: (cb: (ev: LaneProxyEvent) => void, pin: OpenProjectBinding) => () => void;
        oauthGetStatus: (pin: OpenProjectBinding) => Promise<OAuthRedirectStatus>;
        oauthUpdateConfig: (
          args: UpdateOAuthRedirectConfigArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        oauthGenerateRedirectUris: (
          args: GenerateRedirectUrisArgs,
          pin: OpenProjectBinding,
        ) => Promise<RedirectUriInfo[]>;
        oauthEncodeState: (args: EncodeOAuthStateArgs, pin: OpenProjectBinding) => Promise<string>;
        oauthDecodeState: (
          args: DecodeOAuthStateArgs,
          pin: OpenProjectBinding,
        ) => Promise<DecodeOAuthStateResult>;
        oauthListSessions: (pin: OpenProjectBinding) => Promise<OAuthSession[]>;
        onOAuthEvent: (cb: (ev: OAuthRedirectEvent) => void, pin: OpenProjectBinding) => () => void;
        diagnosticsGetStatus: (pin: OpenProjectBinding) => Promise<RuntimeDiagnosticsStatus>;
        diagnosticsGetLaneHealth: (
          args: GetLaneHealthArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneHealthCheck | null>;
        diagnosticsRunHealthCheck: (
          args: RunHealthCheckArgs,
          pin: OpenProjectBinding,
        ) => Promise<LaneHealthCheck>;
        diagnosticsRunFullCheck: (pin: OpenProjectBinding) => Promise<LaneHealthCheck[]>;
        diagnosticsActivateFallback: (
          args: ActivateFallbackArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        diagnosticsDeactivateFallback: (
          args: DeactivateFallbackArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        onDiagnosticsEvent: (
          cb: (ev: RuntimeDiagnosticsEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
      };
      sessions: {
        list: (
          args: ListSessionsArgs | undefined,
          pin: OpenProjectBinding,
          options?: ListSessionsOptions,
        ) => Promise<TerminalSessionSummary[]>;
        get: (
          sessionId: string,
          pin: OpenProjectBinding,
          options?: GetSessionOptions,
        ) => Promise<TerminalSessionDetail | null>;
        delete: (
          args: DeleteSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        updateMeta: (
          args: UpdateSessionMetaArgs,
          pin: OpenProjectBinding,
        ) => Promise<TerminalSessionSummary | null>;
        settle: (
          sessionId: string,
          opts: { outcome?: string; dismissPendingInput?: boolean } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        unsettle: (
          sessionId: string,
          pin: OpenProjectBinding,
        ) => Promise<void>;
         settleMany: (sessionIds: string[], pin: OpenProjectBinding) => Promise<string[]>;
         unsettleMany: (sessionIds: string[], pin: OpenProjectBinding) => Promise<void>;
        snoozeSession: (
          sessionId: string,
          untilIso: string,
          pin: OpenProjectBinding,
        ) => Promise<boolean>;
        wakeSession: (
          sessionId: string,
          reason: SessionWakeReason | undefined,
          pin: OpenProjectBinding,
        ) => Promise<boolean>;
        snoozeSessions: (
          sessionIds: string[],
          untilIso: string,
          pin: OpenProjectBinding,
        ) => Promise<string[]>;
        wakeSessions: (
          sessionIds: string[],
          reason: SessionWakeReason | undefined,
          pin: OpenProjectBinding,
        ) => Promise<string[]>;
        setSettleOverride: (
          sessionId: string,
          override: SessionSettleOverride | null,
          pin: OpenProjectBinding,
        ) => Promise<boolean>;
        moveOnBoard: (
          sessionId: string,
          to: WorkBoardMoveTarget,
          pin: OpenProjectBinding,
        ) => Promise<SessionBoardMoveResult>;
        undoBoardMove: (
          sessionId: string,
          moveId: string,
          pin: OpenProjectBinding,
        ) => Promise<SessionBoardMoveUndoResult>;
        clearWokeMarker: (
          sessionId: string,
          pin: OpenProjectBinding,
        ) => Promise<boolean>;
        getLifecycleSettings: (pin: OpenProjectBinding) => Promise<SessionLifecycleSettings>;
        updateLifecycleSettings: (
          settings: SessionLifecycleSettings,
          pin: OpenProjectBinding,
        ) => Promise<SessionLifecycleSettings>;
        readTranscriptTail: (
          args: ReadTranscriptTailArgs,
          pin: OpenProjectBinding,
        ) => Promise<string>;
        getDelta: (
          sessionId: string,
          pin: OpenProjectBinding,
        ) => Promise<SessionDeltaSummary | null>;
        onChanged: (
          cb: (ev: TerminalSessionChangedEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
      };
      chatLaunch: {
        start: (args: ChatLaunchArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot>;
        get: (args: ChatLaunchIdArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot | null>;
        list: (pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot[]>;
        cancel: (args: ChatLaunchIdArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot | null>;
        retry: (args: ChatLaunchIdArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot | null>;
        startNow: (args: ChatLaunchIdArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot | null>;
        queueMessage: (args: ChatLaunchQueueMessageArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot>;
        completeClient: (args: ChatLaunchCompleteClientArgs, pin: OpenProjectBinding) => Promise<ChatLaunchSnapshot | null>;
        /** `onResync`: the event stream may have dropped events (gap, runtime restart, reconnect); re-read `list`. */
        onEvent: (
          cb: (event: ChatLaunchEvent) => void,
          pin: OpenProjectBinding,
          onResync?: () => void,
        ) => () => void;
      };
      agentChat: {
        list: (args: AgentChatListArgs | undefined, pin: OpenProjectBinding) => Promise<AgentChatSessionSummary[]>;
        getSummary: (
          args: AgentChatGetSummaryArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSessionSummary | null>;
        create: (args: AgentChatCreateArgs, pin: OpenProjectBinding) => Promise<AgentChatSession>;
        launch: (args: AgentChatLaunchArgs, pin: OpenProjectBinding) => Promise<AgentChatSession>;
        launchCli: (
          args: AgentChatLaunchCliArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatLaunchCliResult>;
        suggestLaneName: (
          args: AgentChatSuggestLaneNameArgs,
          pin: OpenProjectBinding,
        ) => Promise<string>;
        generateAutoLaneIdentity: (
          args: AgentChatSuggestLaneNameArgs,
          pin: OpenProjectBinding,
        ) => Promise<AutoLaneIdentitySuggestion>;
        parallelLaunchState: {
          get: (
            args: AgentChatParallelLaunchStateArgs,
            pin: OpenProjectBinding,
          ) => Promise<AgentChatParallelLaunchState | null>;
          set: (
            args: AgentChatSetParallelLaunchStateArgs,
            pin: OpenProjectBinding,
          ) => Promise<void>;
        };
        /**
         * The account's Fast-mode permission, for hosts with no account-settings
         * bridge (the hosted web client). The desktop preload leaves it absent
         * and the renderer writes the account store directly; the web adapter
         * forwards it to the host's `chat.*FastModeEnabled` commands.
         */
        fastModePolicy?: {
          get: () => Promise<boolean>;
          set: (enabled: boolean) => Promise<boolean>;
        };
        handoff: (
          args: AgentChatHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatHandoffResult>;
        startSideChat: (
          args: AgentChatStartSideChatArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatStartSideChatResult>;
        endSideChat: (
          args: AgentChatEndSideChatArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatEndSideChatResult>;
        prepareCrossMachineHandoff: (
          args: AgentChatPrepareCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatPrepareCrossMachineHandoffResult>;
        validateCrossMachineSource: (
          args: AgentChatValidateCrossMachineSourceArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        markCrossMachineHandoff: (
          args: AgentChatMarkCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        getCrossMachineHandoffOptions: (
          args: AgentChatCrossMachineHandoffSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffOptionsResult>;
        previewCrossMachineHandoff: (
          args: AgentChatPreviewCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatPreviewCrossMachineHandoffResult>;
        startCrossMachineHandoff: (
          args: AgentChatStartCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffRecord>;
        cancelCrossMachineHandoff: (
          args: AgentChatCrossMachineHandoffSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffRecord | null>;
        retryCrossMachineHandoff: (
          args: AgentChatRetryCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffRecord>;
        startCrossMachineBatchMove: (
          args: AgentChatCrossMachineBatchMoveArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineBatchMoveRecord>;
        getCrossMachineBatchMove: (
          args: AgentChatGetCrossMachineBatchMoveArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineBatchMoveRecord | null>;
        retryCrossMachineBatchMove: (
          args: AgentChatRetryCrossMachineBatchMoveArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineBatchMoveRecord>;
        resolveCrossMachineBatchMoveApproval: (
          args: AgentChatResolveCrossMachineBatchMoveApprovalArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineBatchMoveRecord>;
        resolveCrossMachineHandoffApproval: (
          args: AgentChatResolveCrossMachineHandoffApprovalArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffRecord | null>;
        acknowledgeCrossMachineHandoff: (
          args: AgentChatAcknowledgeCrossMachineHandoffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCrossMachineHandoffRecord | null>;
        send: (args: AgentChatSendArgs, pin: OpenProjectBinding) => Promise<void>;
        /** Text for a running agent CLI, typed only at a free prompt (`AgentCliTypeArgs`). */
        typeIntoCli: (
          args: AgentCliTypeArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentCliTypeResult>;
        steer: (
          args: AgentChatSteerArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSteerResult>;
        cancelSteer: (
          args: AgentChatCancelSteerArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        editSteer: (args: AgentChatEditSteerArgs, pin: OpenProjectBinding) => Promise<void>;
        moveSteer: (
          args: AgentChatMoveSteerArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        dispatchSteer: (
          args: AgentChatDispatchSteerArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatDispatchSteerResult>;
        cancelDispatchedSteer: (
          args: AgentChatCancelDispatchedSteerArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCancelDispatchedSteerResult>;
        interrupt: (
          args: AgentChatInterruptArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatInterruptResult>;
        stopTask: (
          args: AgentChatStopTaskArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatStopTaskResult>;
        /** Note or follow-up task to one subagent (Muse: `subagent/sendMessage` / `followupTask`). */
        messageSubagent: (
          args: AgentChatMessageSubagentArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatMessageSubagentResult>;
        /** Interrupt/resume/reopen/close a subagent, pause/resume a workflow, skip/retry a workflow child. */
        controlSubagent: (
          args: AgentChatControlSubagentArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatControlSubagentResult>;
        /** Stop the provider process, keep the conversation; the next message starts fresh. */
        restartSession: (
          args: AgentChatRestartSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRestartSessionResult>;
        restoreCancelledQueue: (
          args: AgentChatRestoreCancelledQueueArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRestoreCancelledQueueResult>;
        recoverTurn: (
          args: AgentChatRecoverTurnArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRecoverTurnResult>;
        recoverCodexTurn: (
          args: AgentChatRecoverCodexTurnArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRecoverCodexTurnResult>;
        resolveUnprocessedMessage: (
          args: AgentChatResolveUnprocessedMessageArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatResolveUnprocessedMessageResult>;
        recoverContinuity: (
          args: AgentChatRecoverContinuityArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatContinuityRecoveryResult>;
        approve: (
          args: AgentChatApproveArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        respondToInput: (
          args: AgentChatRespondToInputArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        /**
         * Throw away a non-blocking provider question. Rejects for any card the
         * provider is actually waiting on — see the host's
         * `dismissPendingInput`.
         */
        dismissPendingInput: (
          args: AgentChatDismissPendingInputArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        launchDefaults: (pin: OpenProjectBinding) => Promise<AgentChatLaunchDefaults | null>;
        models: (
          args: AgentChatModelsArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatModelInfo[]>;
        modelCatalog: (
          args: AgentChatModelCatalogArgs | undefined,
          pin?: OpenProjectBinding | null,
        ) => Promise<AgentChatModelCatalog>;
        archive: (
          args: AgentChatArchiveArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        unarchive: (
          args: AgentChatArchiveArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        delete: (args: AgentChatDeleteArgs, pin: OpenProjectBinding) => Promise<AgentChatDeleteResult | null>;
        listDeleted: (args: DeletedChatListArgs | undefined, pin: OpenProjectBinding) => Promise<DeletedChatListResult>;
        getDeletedDetail: (args: DeletedChatDetailArgs, pin: OpenProjectBinding) => Promise<ExternalSessionDetail>;
        reopenDeleted: (args: DeletedChatReopenArgs, pin: OpenProjectBinding) => Promise<DeletedChatReopenResult>;
        removeDeleted: (args: DeletedChatRemoveArgs, pin: OpenProjectBinding) => Promise<DeletedChatRemoveResult>;
        updateSession: (
          args: AgentChatUpdateSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSession>;
        regenerateSessionMetadata: (
          args: AgentChatRegenerateSessionMetadataArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRegenerateSessionMetadataResult>;
        createScheduledWork: (
          args: AgentChatCreateScheduledWorkArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCreateScheduledWorkResult>;
        listScheduledWork: (
          args: AgentChatListScheduledWorkArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatScheduledWorkItem[]>;
        cancelScheduledWork: (
          args: AgentChatCancelScheduledWorkArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCancelScheduledWorkResult>;
        resumeUsageLimitNow: (
          args: AgentChatResumeUsageLimitNowArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatResumeUsageLimitNowResult>;
        continueUsageLimitOnAlternate: (
          args: AgentChatContinueUsageLimitOnAlternateArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatContinueUsageLimitOnAlternateResult>;
        switchAccount: (
          args: AgentChatSwitchAccountArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSwitchAccountResult>;
        setScheduledWorkPaused: (
          args: AgentChatSetScheduledWorkPausedArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSetScheduledWorkPausedResult>;
        warmupModel: (
          args: {
            sessionId: string;
            modelId: string;
          },
          pin: OpenProjectBinding,
        ) => Promise<void>;
        onEvent: (
          cb: (ev: AgentChatEventEnvelope) => void,
          pin: OpenProjectBinding,
          options?: { forcePinned?: boolean },
        ) => () => void;
        slashCommands: (
          args: AgentChatSlashCommandsArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSlashCommand[]>;
        listClaudePlugins: (
          args: AgentChatClaudePluginsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatClaudePlugin[]>;
        listCodexPlugins: (
          args: AgentChatCodexPluginsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatCodexPlugin[]>;
        reloadClaudePlugins: (
          args: AgentChatReloadClaudePluginsArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatReloadClaudePluginsResult>;
        listClaudeOutputStyles: (
          args: AgentChatClaudeOutputStylesArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatClaudeOutputStyle[]>;
        setClaudeOutputStyle: (
          args: AgentChatSetClaudeOutputStyleArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSession>;
        listClaudeSessions: (
          args: AgentChatClaudeSessionListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatClaudeSessionInfo[]>;
        getClaudeSessionInfo: (
          args: AgentChatClaudeSessionInfoArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatClaudeSessionInfo | null>;
        getClaudeSessionMessages: (
          args: AgentChatClaudeSessionMessagesArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatClaudeSessionMessage[]>;
        getMainTranscript: (
          args: AgentChatMainTranscriptArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSubagentTranscriptMessage[] | null>;
        getSubagentTranscript: (
          args: AgentChatSubagentTranscriptArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSubagentTranscriptMessage[] | null>;
        getContextUsage: (
          args: AgentChatContextUsageArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatContextUsage | null>;
        getClaudeUsage: (
          args: AgentChatClaudeUsageArgs,
          pin: OpenProjectBinding,
        ) => Promise<ClaudeUsageReport>;
        rewindFiles: (
          args: AgentChatRewindFilesArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatRewindFilesResult>;
        fileSearch: (
          args: AgentChatFileSearchArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatFileSearchResult[]>;
        // Optional: the webclient adapter's agentChat surface does not
        // implement it, and callers must degrade to an empty menu section.
        listMentionSuggestions?: (
          args: ChatMentionSuggestArgs,
          pin: OpenProjectBinding,
        ) => Promise<ChatMentionSuggestResult>;
        drafts: {
          list: (
            pin: OpenProjectBinding,
          ) => Promise<DraftEntry[]>;
          create: (
            args: DraftCreateArgs,
            pin: OpenProjectBinding,
          ) => Promise<DraftEntry>;
          update: (
            args: DraftUpdateArgs,
            pin: OpenProjectBinding,
          ) => Promise<DraftEntry | null>;
          claim: (
            args: DraftClaimArgs,
            pin: OpenProjectBinding,
          ) => Promise<DraftEntry | null>;
          delete: (
            args: DraftDeleteArgs,
            pin: OpenProjectBinding,
          ) => Promise<boolean>;
          /** Deliver now, whatever the fire time; keeps the schedule armed. */
          sendNow: (
            args: DraftDeleteArgs,
            pin: OpenProjectBinding,
          ) => Promise<{ ok: boolean; error?: string }>;
        };
        /** Claude mod UI. Absent in a client that draws none (the hosted web client). */
        claudePluginUi?: {
          get: (args: ClaudePluginUiGetArgs, pin: OpenProjectBinding) => Promise<ClaudePluginUiSnapshot>;
          act: (args: ClaudePluginUiActArgs, pin: OpenProjectBinding) => Promise<ClaudePluginUiActResult>;
        };
        threadComments: {
          list: (args: ChatThreadCommentListArgs, pin: OpenProjectBinding) => Promise<ChatThreadComment[]>;
          create: (args: ChatThreadCommentCreateArgs, pin: OpenProjectBinding) => Promise<ChatThreadComment>;
          update: (args: ChatThreadCommentUpdateArgs, pin: OpenProjectBinding) => Promise<ChatThreadComment>;
          delete: (args: ChatThreadCommentDeleteArgs, pin: OpenProjectBinding) => Promise<{ deleted: boolean }>;
        };
        getTurnFileDiff: (
          args: AgentChatGetTurnFileDiffArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatTurnFileDiff | null>;
        listSubagents: (
          args: AgentChatSubagentListArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSubagentSnapshot[]>;
        /** The open cards of a chat, or of a tracked agent CLI (ADE's cards and the CLI's own prompt). */
        listPendingInputs: (
          args: { sessionId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ requests: import("../shared/types").PendingInputRequest[] }>;
        killDroidWorker: (
          args: AgentChatKillDroidWorkerArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        getSessionCapabilities: (
          args: AgentChatSessionCapabilitiesArgs,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSessionCapabilities>;
        saveTempAttachment: (
          args: {
            data: string;
            filename: string;
          },
          pin: OpenProjectBinding,
        ) => Promise<{ path: string }>;
        getAttachmentStagingMode: (
          pin: OpenProjectBinding,
        ) => Promise<ChatAttachmentStagingMode>;
        stageFileAttachment: (
          args: AgentChatCopyTempAttachmentArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ path: string }>;
        getImageDataUrl: (
          path: string,
          pin: OpenProjectBinding,
        ) => Promise<{ dataUrl: string }>;
        resolveSmartLinkPreview: (args: { url: string }, pin?: OpenProjectBinding | null) => Promise<SmartLinkPreview | null>;
        /** A preview's og:image as a data URL (null: unavailable). Fetched lazily by the hover card. */
        resolveSmartLinkImage: (args: { url: string }, pin?: OpenProjectBinding | null) => Promise<{ dataUrl: string | null }>;
        /** The MCP App a tool call produced, from the machine that owns the chat. */
        getMcpApp: (
          args: import("../shared/mcpApp").McpAppGetArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/mcpApp").McpAppGetResult>;
        /** One call from an MCP App's frame, to the server the app came from. */
        mcpAppRequest: (
          args: import("../shared/mcpApp").McpAppRequestArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/mcpApp").McpAppRequestResult>;
        /** The tools the user always allows for the server an app came from. */
        listMcpAppGrants: (
          args: import("../shared/mcpApp").McpAppGrantsArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/mcpApp").McpAppGrantsResult>;
        /** Take one "always allow" back; answers the grants that are left. */
        revokeMcpAppGrant: (
          args: import("../shared/mcpApp").McpAppRevokeGrantArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/mcpApp").McpAppGrantsResult>;
        /** Sources favicons as data URLs (null: the site has none), keyed by each domain as given. */
        resolveSourceFavicons: (args: { domains: string[] }, pin?: OpenProjectBinding | null) => Promise<{ icons: Record<string, string | null> }>;
        getEventHistory: (
          args: {
            sessionId: string;
            maxEvents?: number;
            maxBytes?: number;
          },
          pin: OpenProjectBinding,
        ) => Promise<AgentChatEventHistorySnapshot>;
        getEventHistoryPage: (
          args: {
            sessionId: string;
            beforeOffset: number;
            maxBytes?: number;
          },
          pin: OpenProjectBinding,
        ) => Promise<AgentChatEventHistoryPage>;
        codex: {
          getGoal: (
            args: AgentChatCodexGetGoalArgs,
            pin: OpenProjectBinding,
          ) => Promise<CodexThreadGoal | null>;
          setGoal: (
            args: AgentChatCodexSetGoalArgs,
            pin: OpenProjectBinding,
          ) => Promise<CodexThreadGoal | null>;
          setGoalStatus: (
            args: AgentChatCodexSetGoalStatusArgs,
            pin: OpenProjectBinding,
          ) => Promise<CodexThreadGoal | null>;
          clearGoal: (
            args: AgentChatCodexClearGoalArgs,
            pin: OpenProjectBinding,
          ) => Promise<CodexThreadGoal | null>;
          /** Experimental: relay a WebRTC offer for Codex voice; returns the SDP answer. */
          realtimeStart: (
            args: AgentChatCodexRealtimeStartArgs,
            pin: OpenProjectBinding,
          ) => Promise<AgentChatCodexRealtimeStartResult>;
          realtimeStop: (
            args: AgentChatCodexRealtimeStopArgs,
            pin: OpenProjectBinding,
          ) => Promise<void>;
          realtimeState: (
            args: AgentChatCodexRealtimeStateArgs,
            pin: OpenProjectBinding,
          ) => Promise<AgentChatCodexRealtimeState>;
          resetMemory: (
            args: AgentChatCodexResetMemoryArgs,
            pin: OpenProjectBinding,
          ) => Promise<void>;
          terminateBackgroundTerminal: (
            args: AgentChatCodexTerminateBackgroundTerminalArgs,
            pin: OpenProjectBinding,
          ) => Promise<void>;
        };
        readTranscript: (args: {
          sessionId: string;
          limit?: number;
          since?: string;
        }) => Promise<unknown>;
      };
      /**
       * Agent-authored scenes. Local-only; see `shared/chatScene.ts`.
       * Absent on a host without the scene protocol; SceneFrame falls back.
       */
      scene?: {
        /** Store a scene document; resolves an `ade-scene://view/<id>` URL. */
        prepare: (html: string) => Promise<string>;
        /** PNG data URL of the frame's rect, or null when it cannot be captured. */
        snapshot: (rect: {
          x: number;
          y: number;
          width: number;
          height: number;
        }) => Promise<string | null>;
        /** File a snapshot in the proof drawer. False when there was nothing to file. */
        attachProof: (args: {
          dataUrl?: string | null;
          title: string;
          /** The chat that drew the scene; proof is chat-scoped. */
          sessionId?: string | null;
        }) => Promise<boolean>;
        /**
         * Keep the settle-time still. Resolves the stored record, or null when
         * there is no project, no bytes, or no capture route.
         */
        storeStill: (args: {
          dataUrl: string;
          title: string;
          sessionId?: string | null;
          /**
           * Identity of the scene this is a picture of. One still is kept per
           * key — a scene that settles again supersedes its own picture — and
           * it is how a reopened window finds the bytes back.
           */
          scopeKey?: string | null;
        }) => Promise<import("../shared/chatScene").SceneStillRecord | null>;
        /** The URL an MCP App's frame loads its page from; main builds the page's policy. */
        prepareApp: (args: { html: string; csp: import("../shared/mcpApp").McpAppCsp }) => Promise<string>;
      };
      computerUse: {
        listArtifacts: (
          args: ComputerUseArtifactListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ComputerUseArtifactView[]>;
        getOwnerSnapshot: (
          args: ComputerUseOwnerSnapshotArgs,
          pin: OpenProjectBinding,
        ) => Promise<ComputerUseOwnerSnapshot>;
        deleteArtifacts: (
          args: ComputerUseArtifactDeleteArgs,
          pin: OpenProjectBinding,
        ) => Promise<ComputerUseArtifactDeleteResult>;
        listBrokenArtifacts: (args?: {
          limit?: number;
        }, pin?: OpenProjectBinding | null) => Promise<ComputerUseArtifactBrokenRecord[]>;
        pruneBrokenArtifacts: (pin?: OpenProjectBinding | null) => Promise<ComputerUseArtifactDeleteResult>;
        recoverArtifact: (
          args: { artifactId: string },
          pin: OpenProjectBinding,
        ) => Promise<ComputerUseArtifactView>;
        updateArtifactReview: (
          args: ComputerUseArtifactReviewArgs,
          pin: OpenProjectBinding,
        ) => Promise<ComputerUseArtifactView>;
        readArtifactPreview: (
          args: { uri: string },
          pin: OpenProjectBinding,
        ) => Promise<string | null>;
        /** `http://127.0.0.1:<port>/<token>` for proof videos, or null when main has none. */
        mediaBaseUrl: () => Promise<string | null>;
        /** Desktop only; absent in the web client. */
        saveMediaAs?: (args: { url: string; fileName?: string }) => Promise<{ saved: boolean; path?: string }>;
        onEvent: (
          cb: (ev: ComputerUseEventPayload) => void,
          pin: OpenProjectBinding,
        ) => () => void;
      };
      /**
       * The lane's Apple simulator. Lane members take a required pin: the
       * simulator lives on the lane's machine, the tab's own copy included.
       * Machine members (status, the device list and admin, runtimes, Xcode)
       * and `onEvent` keep an optional pin: null is this window's fanout.
       */
      iosSimulator: {
        getStatus: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorStatus>;
        listDevices: (
          pin?: OpenProjectBinding | null,
        ) => Promise<IosSimulatorDevice[]>;
        listLaunchTargets: (
          args: IosSimulatorListLaunchTargetsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorLaunchTarget[]>;
        launch: (
          args: IosSimulatorLaunchArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorLaunchResult>;
        attachToChatSession: (
          args: {
            chatSessionId: string | null;
            callerChatSessionId?: string | null;
            takeOver?: boolean;
          },
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorSession | null>;
        shutdown: (
          args: IosSimulatorShutdownArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorShutdownResult>;
        screenshot: (
          args: IosSimulatorScreenshotArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorScreenshot>;
        getScreenSnapshot: (
          args: IosScreenSnapshotArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosScreenSnapshot>;
        getInspectorSnapshot: (
          args: { deviceUdid?: string | null } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosInspectorSnapshot | null>;
        inspectPoint: (
          args: IosSimulatorInspectPointArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorInspectResult>;
        getPreviewCapability: (
          args: IosSimulatorListPreviewsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorPreviewCapability>;
        listPreviewTargets: (
          args: IosSimulatorListPreviewsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorPreviewTarget[]>;
        resolvePreviewMatch: (
          args: IosSimulatorListPreviewsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorPreviewMatch>;
        ensurePreviewWorkspace: (
          args: IosSimulatorEnsurePreviewWorkspaceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorEnsurePreviewWorkspaceResult>;
        renderCurrentPreview: (
          args: IosSimulatorRenderCurrentPreviewArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorRenderCurrentPreviewResult>;
        renderPreview: (
          args: IosSimulatorRenderPreviewArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorRenderPreviewResult>;
        openPreviewWorkspace: (
          args: IosSimulatorOpenPreviewWorkspaceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true; path: string }>;
        startStream: (
          args: IosSimulatorStartStreamArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorStreamStatus>;
        stopStream: (
          pin: OpenProjectBinding,
          args?: { laneId?: string | null; chatSessionId?: string | null },
        ) => Promise<IosSimulatorStreamStatus>;
        getStreamStatus: (
          pin: OpenProjectBinding,
          args?: { laneId?: string | null; chatSessionId?: string | null },
        ) => Promise<IosSimulatorStreamStatus>;
        deviceCreate: (
          args: AppleDeviceCreateArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleLaneDevice>;
        deviceAttach: (
          args: AppleDeviceAttachArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppleLaneDevice>;
        /**
         * Attach (or create, with `create.sourceUdid`) if the lane owns no
         * device, boot it if it is off, wait for `bootstatus`, then start the
         * live view. Progress arrives on `onEvent` as `apple.device.state`.
         */
        deviceStart: (
          args: AppleDeviceStartArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorStreamStatus>;
        /**
         * Power the lane's simulator OFF, leaving it registered.
         *
         * `deviceStart`'s opposite. NOT `shutdown`, which ends this chat's
         * session and leaves the device booted (round 5 §S1).
         */
        deviceStop: (
          args: AppleDeviceStopArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleDeviceStopResult>;
        /**
         * What this Mac has, what this lane owns, and who holds the rest.
         *
         * `owners` carries every lane's binding with the owning lane's display
         * name, so the picker can partition the installed list into mine /
         * free / in use elsewhere instead of offering Open on a device another
         * lane is mid-test in. `disk` is measured only when `args.disk` asks
         * for it — the picker calls twice, cheap first.
         */
        deviceList: (
          args?: AppleDeviceListArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleDeviceListResult>;
        deviceDelete: (
          args: AppleDeviceDeleteArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleDeviceDeleteResult>;
        /** The lane gives up its device and the simulator stays installed. */
        deviceDetach: (
          args: AppleDeviceDetachArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleLaneDevice | null>;
        deviceDeleteInstalled: (
          args: AppleDeviceDeleteInstalledArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<void>;
        /** Delete leftover ADE devices and release ended lanes' devices, now. */
        deviceCleanup: (
          args?: AppleDeviceCleanupArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleDeviceCleanupResult>;
        runtimeList: (pin?: OpenProjectBinding | null) => Promise<AppleRuntimeInventory>;
        runtimeInstall: (
          args?: AppleRuntimeInstallArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleRuntimeInstallState>;
        runtimeInstallCancel: (
          args?: AppleRuntimeScope,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleRuntimeInstallState | null>;
        runtimeDelete: (
          args: AppleRuntimeDeleteArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleRuntimeDeleteResult>;
        runtimePrune: (
          args: AppleRuntimePruneArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleRuntimeDeleteResult>;
        xcodeRunFirstLaunch: (
          args?: AppleRuntimeScope & { confirmedByUser?: boolean },
          pin?: OpenProjectBinding | null,
        ) => Promise<AppleXcodeStatus>;
        frame: (
          args: AppleFrameArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleFrameResult>;
        recordStart: (
          args: AppleRecordStartArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<SimRecording>;
        recordStop: (
          args: AppleRecordStopArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<SimRecording | null>;
        recordList: (
          args: AppleRecordListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<SimRecording[]>;
        recordDelete: (
          args: AppleRecordDeleteArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        /**
         * Bytes of Apple recordings on disk. Lane-optional: the Diagnostics
         * row is project-wide, and the recorder already knows the answer from
         * its own sidecars.
         */
        recordingsTotalBytes: (
          args?: { laneId?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<number>;
        // No projectRoot: tapping drives the booted device, and the service
        // never resolves a build root for it.
        tap: (
          args: { deviceUdid?: string | null; x: number; y: number },
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        /** A press held at one point (a context menu). */
        longPress: (
          args: IosSimulatorLongPressArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true; action: "long-press"; durationMs: number }>;
        pressButton: (
          args: ApplePressButtonArgs,
          pin: OpenProjectBinding,
        ) => Promise<ApplePressButtonResult>;
        rotate: (
          args: AppleRotateArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppleRotateResult>;
        setPosture: (
          args: AppleSetPostureArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppleSetPostureResult>;
        getPosture: (
          args: { laneId?: string | null; chatSessionId?: string | null; deviceUdid?: string | null } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleDevicePosture>;
        getDuoModel: (pin?: OpenProjectBinding | null) => Promise<AppleDuoModelResult>;
        renderAck: (args: { requestId: string }, pin: OpenProjectBinding) => Promise<{ ok: boolean }>;
        renderComplete: (
          args: { requestId: string; filed: number; error: string | null; proofArtifactIds?: string[] },
          pin: OpenProjectBinding,
        ) => Promise<{ ok: boolean }>;
        duoAppStoreScreenshots: (
          args: { laneId?: string | null; chatSessionId?: string | null; deviceUdid?: string | null } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleDuoAppStoreScreenshotsResult>;
        attachRenderProof: (
          args: { laneId?: string | null; chatSessionId?: string | null; dataUrl: string; title: string },
          pin: OpenProjectBinding,
        ) => Promise<AppleRenderProofResult>;
        addDuoSkill: (
          args: { laneId?: string | null; chatSessionId?: string | null } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppleAddDuoSkillResult>;
        /** The helper's re-anchoring scroll gesture, by viewport direction. */
        scroll: (
          args: AppleScrollArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppleScrollResult>;
        typeText: (
          args: { deviceUdid?: string | null; text: string },
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        drag: (
          args: IosSimulatorDragArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        swipe: (
          args: IosSimulatorDragArgs,
          pin: OpenProjectBinding,
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
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorSelectResult>;
        // Device hub: a booted device, its typed settings, its log, and
        // element-named actions. Every one takes the same pin as the calls
        // above, because the simulator lives on the machine that owns the lane.
        openDevice: (
          args: IosSimulatorOpenDeviceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSession>;
        closeDevice: (
          args: IosSimulatorCloseDeviceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorCloseDeviceResult>;
        getDeviceSettings: (
          args: IosSimulatorDeviceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        setAppearance: (
          args: IosSimulatorSetAppearanceArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        setContentSize: (
          args: IosSimulatorSetContentSizeArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        setAccessibilityOption: (
          args: IosSimulatorSetAccessibilityArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        setLocation: (
          args: IosSimulatorSetLocationArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        clearLocation: (
          args: IosSimulatorDeviceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorDeviceSettings>;
        setPermission: (
          args: IosSimulatorSetPermissionArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        sendPushNotification: (
          args: IosSimulatorPushArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        openUrl: (
          args: IosSimulatorOpenUrlArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        relaunchApp: (
          args: IosSimulatorRelaunchArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorAppState>;
        terminateApp: (
          args: IosSimulatorAppLifecycleArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        uninstallApp: (
          args: IosSimulatorUninstallAppArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        setStatusBar: (
          args: IosSimulatorStatusBarArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        clearStatusBar: (
          args: IosSimulatorDeviceArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        getAppState: (
          args: IosSimulatorAppLifecycleArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorAppState>;
        getForegroundApp: (
          args: { deviceUdid?: string | null; laneId?: string | null; waitMs?: number | null } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorForegroundApp>;
        startEventLog: (
          args: IosSimulatorStartEventLogArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorEventLogPage>;
        stopEventLog: (
          args: IosSimulatorStopEventLogArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorEventLogPage>;
        getEventLog: (
          args: IosSimulatorEventLogArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorEventLogPage>;
        findElement: (
          args: IosSimulatorFindElementArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorElementActionResult>;
        tapElement: (
          args: IosSimulatorTapElementArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorElementActionResult>;
        fillElement: (
          args: IosSimulatorFillElementArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorElementActionResult>;
        waitForElement: (
          args: IosSimulatorWaitForElementArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorElementActionResult>;
        assertVisible: (
          args: IosSimulatorAssertVisibleArgs,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorElementActionResult>;
        captureProofBundle: (
          args: IosSimulatorProofBundleArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<IosSimulatorProofBundle>;
        // The stream URL names loopback on the simulator's own machine, so a
        // remote binding has to tunnel it before a player can open it. Resolves
        // to a message instead of rejecting: the caller renders it in a card.
        resolveStreamUrl: (
          streamUrl: string | null,
          pin: OpenProjectBinding,
        ) => Promise<{ url: string | null; forwarded: boolean; error: string | null }>;
        onEvent: (
          cb: (ev: IosSimulatorEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      /**
       * The lane's Android emulator. Every method takes an optional pin, because
       * the emulator belongs to the lane's machine rather than to this window.
       */
      androidEmulator: AndroidEmulatorPreloadApi;
      /**
       * The lane's private macOS screen. Mirrors `iosSimulator`: every method
       * takes an optional pin, because the display belongs to the lane's host
       * rather than to this window.
       */
      macDesktop: {
        getStatus: (
          args?: MacDesktopGetStatusArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStatus>;
        recheckPermissions: (
          args?: MacDesktopRecheckPermissionsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopPermissions>;
        requestPermission: (
          args: MacDesktopRequestPermissionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopPermissions>;
        setupWindows: (
          args: WindowsDesktopSetupArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<WindowsDesktopSetupResult>;
        takeoverWindows: (
          args: WindowsDesktopTakeoverArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStatus>;
        useSharedDesktop: (
          args: { laneId: string; chatSessionId?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStatus>;
        start: (
          args: MacDesktopStartArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStatus>;
        stop: (
          args: MacDesktopStopArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStopResult>;
        listWindows: (
          args?: { laneId?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopWindow[]>;
        open: (
          args: MacDesktopOpenArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopOpenResult>;
        claimWindow: (
          args: MacDesktopClaimArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopWindow>;
        releaseWindow: (
          args: MacDesktopReleaseArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ released: number }>;
        closeWindow: (
          args: MacDesktopWindowActionArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopWindowActionResult>;
        observe: (
          args: MacDesktopObserveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopObservation>;
        click: (
          args: MacDesktopClickArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopActionResult>;
        type: (
          args: MacDesktopTypeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopActionResult>;
        press: (
          args: MacDesktopPressArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopActionResult>;
        scroll: (
          args: MacDesktopScrollArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopActionResult>;
        drag: (
          args: MacDesktopDragArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopActionResult>;
        move: (
          args: MacDesktopMoveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopInputResult>;
        wait: (
          args: MacDesktopWaitArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopWaitResult>;
        screenshot: (
          args: MacDesktopScreenshotArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopScreenshotResult>;
        startRecording: (
          args: MacDesktopRecordStartArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopRecordingStatus>;
        stopRecording: (
          args: { laneId: string; chatSessionId?: string | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopRecordingStatus>;
        startStream: (
          args: MacDesktopStartStreamArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStreamStatus>;
        stopStream: (
          args: MacDesktopStopStreamArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStreamStatus>;
        getStreamStatus: (
          args: { laneId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopStreamStatus>;
        takeControl: (
          args: MacDesktopTakeoverArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopLeaseState>;
        returnControl: (
          args: { laneId: string; controllerId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopLeaseState | null>;
        renewLease: (
          args: { laneId: string; holderId: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<MacDesktopLeaseState | null>;
        present: (
          args: MacDesktopPresentArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ moved: number }>;
        resolveStreamUrl: (
          streamUrl: string | null,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ url: string | null; forwarded: boolean; error: string | null }>;
        /**
         * Escape while a takeover holds THIS Mac, caught before the app that
         * has the keyboard. No pin: the accelerator belongs to the Electron
         * app the person is sitting at, never to the lane's host.
         */
        setEscapeHotkey: (args: { laneId: string; armed: boolean }) => Promise<{ armed: boolean }>;
        onEscapeHotkey: (cb: () => void) => () => void;
        onEvent: (
          cb: (ev: MacDesktopEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      appControl: {
        /**
         * App Control keeps one session per lane. Every call names its lane
         * (`laneId`, or a `chatSessionId`/`sessionId` that resolves to one);
         * a call that names none is refused. `getStatus` with no lane answers
         * `activeSession: null` and lists every lane's session in `sessions`.
         */
        getStatus: (
          args: AppControlLaneArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppControlStatus>;
        launch: (
          args: AppControlLaunchArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSession>;
        launchInTerminal: (
          args: AppControlLaunchArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSession>;
        connect: (
          args: AppControlConnectArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSession>;
        /** Quits an app ADE launched (whole process tree); detaches an attached one. */
        stop: (
          args: AppControlStopArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true; previousSession: AppControlSession | null }>;
        focusWindow: (
          args: AppControlLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        minimizeWindow: (
          args: AppControlLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        screenshot: (
          args: AppControlLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlScreenshot>;
        getSnapshot: (
          args: AppControlSnapshotArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSnapshot>;
        inspectPoint: (
          args: AppControlInspectPointArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlInspectResult>;
        selectPoint: (
          args: AppControlInspectPointArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSelectResult>;
        click: (
          args: AppControlClickArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        typeText: (
          args: AppControlTypeTextArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        scroll: (
          args: AppControlScrollArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        dispatchKey: (
          args: AppControlDispatchKeyArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        listTargets: (
          args: AppControlLaneArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlTarget[]>;
        attachToTarget: (
          args: AppControlAttachToTargetArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlSession>;
        /**
         * Records the lane's app: its window on macOS (needs Screen
         * Recording), the CDP screencast on Windows and Linux. Same rules as
         * Mac Desktop's recording: ten-minute cap for a chat's recording, idle
         * cut unless `keepIdle`, a caption files it as proof.
         */
        startRecording: (
          args: AppControlRecordStartArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlRecordingStatus>;
        stopRecording: (
          args: AppControlRecordStopArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlRecordingStatus>;
        getRecordingStatus: (
          args: AppControlRecordingStatusArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlRecordingStatus>;
        /**
         * The lane's current picture for a viewer that just mounted. The
         * screencast sends frames only when the page paints, so a still app
         * would leave a new viewer blank: this answers with the newest frame,
         * or one fresh capture (also published as a `frame` event). Null with
         * no connected session.
         */
        getLatestFrame?: (
          args: AppControlRecordingStatusArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlScreencastFrame | null>;
        /** One still of the lane's app, filed as proof (Mac Desktop's Save screenshot). */
        captureProof: (
          args: AppControlCaptureProofArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlCaptureProofResult>;
        /**
         * Agent action model, read side only. `agentClick`/`agentFill`/… are
         * deliberately absent: the panel reports what an agent did, it does not
         * drive agent actions, so those stay behind the action registry.
         *
         * All five reject when no project runtime is bound — they have no IPC
         * channel to fall back to.
         */
        listDrivers: (
          args: AppControlLaneArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AppControlDriversResult>;
        /** Writes an observation record and prunes older ones — never poll it. */
        observe: (
          args: AppControlObservationArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlObservation>;
        getTrace: (
          args: AppControlTraceArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlTraceResult>;
        windows: (
          args: AppControlSessionTargetArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlWindowsResult>;
        /** Re-attaches CDP and clears the trace, like `attachToTarget`. */
        switchWindow: (
          args: AppControlSwitchWindowArgs,
          pin: OpenProjectBinding,
        ) => Promise<AppControlWindowsResult>;
        onEvent: (
          cb: (ev: AppControlEventPayload) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        /**
         * A view that shows live frames holds this while it is on screen.
         * Status-only `onEvent` listeners do not keep frames flowing: the web
         * client streams them over the relay, and the desktop sends a window
         * frames, only while a view holds them. On the desktop the hold is for
         * `laneId`, and omitting it holds every lane; the web client ignores
         * the lane. Returns the release.
         */
        holdFrames?: (laneId?: string | null) => () => void;
      };
      /**
       * Always local IPC scoped by `projectRoot`; the optional `pin` only
       * localizes loopback URLs for a remote machine (see preload).
       */
      builtInBrowser: {
        getStatus: (
          args?: BuiltInBrowserProjectScopeArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        /**
         * Who is driving the browser right now, scoped to this window's
         * projects. Side-effect-free: unlike `getStatus` it constructs no
         * window service and restores no tabs, which is why the presence badge
         * seeds from it.
         */
        getAgentPresence: () => Promise<BuiltInBrowserAgentPresence[]>;
        requestOriginAccess: (
          args?: BuiltInBrowserRequestOriginAccessArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserOriginAccessResult>;
        getProfileDiagnostics: () => Promise<BuiltInBrowserProfileDiagnostics>;
        listPermissions: () => Promise<BuiltInBrowserPermissionsResult>;
        /**
         * Trust the local HTTPS certificate a tab's page failed on, and list or
         * revoke those approvals. Human-only and machine-local, like
         * `browserSettings`: no `pin` overload.
         */
        trustCertificate: (args: BuiltInBrowserTrustCertificateArgs) => Promise<BuiltInBrowserStatus>;
        listTrustedCertificates: () => Promise<BuiltInBrowserTrustedCertificatesResult>;
        revokeTrustedCertificates: (
          args?: BuiltInBrowserRevokeCertificatesArgs,
        ) => Promise<BuiltInBrowserTrustedCertificatesResult>;
        /**
         * "Agents can use the ADE browser": the setting, the saved lane and
         * chat grants, and the open prompts. Machine-local and human-only.
         */
        browserSettings: {
          get: () => Promise<BuiltInBrowserSettings>;
          set: (patch: BuiltInBrowserSettingsPatch) => Promise<BuiltInBrowserSettings>;
          onChange: (cb: (settings: BuiltInBrowserSettings) => void) => () => void;
        };
        agentAccess: {
          get: () => Promise<BuiltInBrowserAgentAccessSnapshot>;
          setEnabled: (enabled: boolean) => Promise<BuiltInBrowserAgentAccessSnapshot>;
          setMode: (mode: BuiltInBrowserAgentAccessMode) => Promise<BuiltInBrowserAgentAccessSnapshot>;
          answer: (
            promptId: string,
            answer: BuiltInBrowserAgentAccessAnswer,
          ) => Promise<BuiltInBrowserAgentAccessSnapshot>;
          revoke: (args: BuiltInBrowserAgentAccessRevokeArgs) => Promise<BuiltInBrowserAgentAccessSnapshot>;
          onChange: (cb: (snapshot: BuiltInBrowserAgentAccessSnapshot) => void) => () => void;
        };
        clearPermissions: (
          args?: BuiltInBrowserClearPermissionsArgs,
        ) => Promise<BuiltInBrowserClearPermissionsResult>;
        /**
         * Human-only login import. No `pin` overload anywhere in this group:
         * an agent must not be able to hand itself a logged-in identity.
         */
        loginImport: {
          capabilities: () => Promise<BrowserLoginImportCapabilities>;
          listSources: () => Promise<BrowserLoginImportListSourcesResult>;
          listDomains: (
            args: BrowserLoginImportListDomainsArgs,
          ) => Promise<BrowserLoginImportListDomainsResult>;
          import: (args: BrowserLoginImportArgs) => Promise<BrowserLoginImportResult>;
        };
        showPanel: (
          args?: BuiltInBrowserOpenPanelArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        setBounds: (
          args: BuiltInBrowserBoundsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        /** Resolve a loopback URL onto a forward to the pinned machine. */
        localizeRemoteUrl: (
          args: { url: string },
          pin?: OpenProjectBinding | null,
        ) => Promise<LocalizedRemoteUrl>;
        /** Tell the pinned machine this desktop took its browser-open request. */
        acknowledgeRemoteRequest: (
          args: BuiltInBrowserRemoteRequestAck,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: boolean }>;
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
        /** "Attach to chat": move a tab's lease to one chat (or drop it). Optional for older preloads. */
        keepTab?: (args: BuiltInBrowserTabArgs) => Promise<BuiltInBrowserStatus>;
        handTabToChat?: (args: BuiltInBrowserTabArgs) => Promise<BuiltInBrowserStatus>;
        closeTab: (
          args: BuiltInBrowserTabArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStatus>;
        /** Passwords for the person (the key button, "Save to Passwords?"). Optional for older preloads. Never a value. */
        savedLoginsForTab?: (args: { tabId: string }) => Promise<Array<{ id: string; username: string | null; sites: string[] }>>;
        /** The Messages integration on this Mac. Optional for older preloads. */
        messagesIntegrationStatus?: () => Promise<import("../shared/types/messagesIntegration").MessagesIntegrationStatus>;
        messagesIntegrationSet?: (next: Partial<import("../shared/types/messagesIntegration").MessagesIntegrationSettings>) => Promise<import("../shared/types/messagesIntegration").MessagesIntegrationStatus>;
        fillSavedLogin?: (args: { tabId: string; itemId: string }) => Promise<{ filled: string[] }>;
        loginOfferForTab?: (args: { tabId: string }) => Promise<import("../shared/types/builtInBrowserLoginCapture").BuiltInBrowserSaveLoginOffer | null>;
        acceptLoginOffer?: (args: { offerId: string }) => Promise<{ saved: boolean }>;
        dismissLoginOffer?: (args: { offerId: string }) => Promise<null>;
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
        ) => Promise<BuiltInBrowserScreenshotResult>;
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
        /** Human hand-back of a login handoff; gated to user clients in the runtime. */
        endHandoff: (
          args?: BuiltInBrowserEndHandoffArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserHandoffResult>;
        setEmulation: (
          args?: BuiltInBrowserSetEmulationArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserEmulationResult>;
        setZoom: (
          args?: BuiltInBrowserSetZoomArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserZoomResult>;
        /** The lane machine's running dev servers (see `workTools.listDevServers`); feature-detect before use. */
        getDevServers: (args?: DevServersArgs, pin?: OpenProjectBinding | null) => Promise<DevServersResult>;
        findInPage: (
          args: BuiltInBrowserFindInPageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserFindInPageResult>;
        stopFindInPage: (
          args?: BuiltInBrowserStopFindInPageArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStopFindInPageResult>;
        /**
         * Hand the OS keyboard back from the page's `WebContentsView` to this
         * window's own renderer. Always local; feature-detect before use.
         */
        focusHost: () => Promise<{ focused: boolean }>;
        /**
         * First panel to claim a forwarded `ade browser open` acts on it; every
         * other window's panel is told no. Always local; feature-detect before use.
         */
        claimRemoteRequest: (args: { requestId: string }) => Promise<{ claimed: boolean }>;
        /**
         * Run a browser command an agent on another machine sent to this
         * desktop, in this desktop's browser. Always local.
         */
        runRemoteAgentCall: (
          args: { method: string; input: Record<string, unknown> },
        ) => Promise<BuiltInBrowserRemoteAgentCallOutcome>;
        /** Answer a browser command on the pinned runtime that sent it. */
        replyRemoteCall: (
          args: BuiltInBrowserRemoteCallReply,
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: boolean }>;
        setDevTools: (
          args: BuiltInBrowserSetDevToolsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserDevToolsResult>;
        setNetworkLogging: (
          args: BuiltInBrowserSetNetworkLoggingArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserNetworkLoggingResult>;
        getNetworkLog: (
          args?: BuiltInBrowserNetworkLogArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserNetworkLogResult>;
        exportHar: (
          args?: BuiltInBrowserExportHarArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserExportHarResult>;
        startRecording: (
          args?: BuiltInBrowserStartRecordingArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStartRecordingResult>;
        stopRecording: (
          args?: BuiltInBrowserStopRecordingArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<BuiltInBrowserStopRecordingResult>;
        /**
         * Refcounted live thumbnail frames, delivered as `preview-frame` on
         * `onEvent`. Local-only by design: the previewed view belongs to this
         * window's main process, so there is no `pin` parameter.
         */
        startPreviewStream: (
          args?: BuiltInBrowserStartPreviewStreamArgs,
        ) => Promise<BuiltInBrowserPreviewStreamResult>;
        stopPreviewStream: (
          args?: BuiltInBrowserStopPreviewStreamArgs,
        ) => Promise<BuiltInBrowserPreviewStreamResult>;
        onEvent: (
          cb: (ev: BuiltInBrowserEventPayload) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
        /**
         * Browser-open requests forwarded from a headless machine the chat is
         * pinned to. A no-op unsubscribe for any non-remote pin.
         */
        onRemoteRequest: (
          cb: (ev: BuiltInBrowserRemoteRequest) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
        /**
         * Browser commands of an agent on the pinned machine, to run in this
         * desktop's browser. A no-op unsubscribe for any non-remote pin.
         */
        onRemoteCall: (
          cb: (ev: BuiltInBrowserRemoteCall) => void,
          pin?: OpenProjectBinding | null,
        ) => () => void;
      };
      /** Work copies on a machine for chats on other machines (Settings › Machines). */
      remoteWork: {
        list: (pin?: OpenProjectBinding | null) => Promise<RemoteWorkCopyListing[]>;
        delete: (args: { owner: string; projectId?: string | null }, pin?: OpenProjectBinding | null) => Promise<{ deleted: boolean }>;
      };
      /** A machine's load and capabilities, read by its own brain (Settings › Machines, "Least loaded"). */
      machineStats?: {
        get: (pin?: OpenProjectBinding | null) => Promise<MachineStats | null>;
      };
      terminal: {
        list: (
          args: ChatTerminalListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ChatTerminalSession[]>;
        read: (
          args: ChatTerminalReadArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ChatTerminalReadResult>;
        preview: (
          args: ChatTerminalPreviewArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ChatTerminalPreviewResult>;
        write: (
          args: ChatTerminalWriteArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        signal: (
          args: ChatTerminalSignalArgs,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: true }>;
        activeForChat: (
          args: ChatTerminalActiveForChatArgs,
          pin: OpenProjectBinding,
        ) => Promise<ChatTerminalSession | null>;
        reattachChatCli: (
          args: ChatTerminalReattachArgs,
          pin: OpenProjectBinding,
        ) => Promise<ChatTerminalReattachResult>;
        /** Absent on hosts without terminal watches (the web client). */
        watch?: (
          args: TerminalWatchArgs,
          pin: OpenProjectBinding,
        ) => Promise<TerminalWatchResult>;
        unwatch?: (
          args: TerminalUnwatchArgs,
          pin: OpenProjectBinding,
        ) => Promise<TerminalUnwatchResult>;
        listWatches?: (
          args: TerminalListWatchesArgs,
          pin: OpenProjectBinding,
        ) => Promise<TerminalWatchSummary[]>;
      };
      localhost: {
        probePort: (port: number, pin: OpenProjectBinding) => Promise<boolean>;
      };
      search: {
        query: (args: SearchQueryArgs, pin: OpenProjectBinding) => Promise<SearchQueryResult>;
        indexStatus: (pin?: OpenProjectBinding | null) => Promise<SearchIndexStatus | null>;
        rebuildIndex: (pin?: OpenProjectBinding | null) => Promise<SearchRebuildResult>;
      };
      externalSessions: {
        list: (
          args: ExternalSessionListArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<ExternalSessionSummary[]>;
        import: (
          args: ExternalSessionImportArgs,
          pin: OpenProjectBinding,
        ) => Promise<ExternalSessionImportResult>;
        getDetail: (
          args: ExternalSessionDetailArgs,
          pin: OpenProjectBinding,
        ) => Promise<ExternalSessionDetail>;
        watchDetail: (args: ExternalSessionDetailWatchArgs) => Promise<ExternalSessionDetail>;
        unwatchDetail: (args: { watchId: string }) => Promise<{ ok: true }>;
        onDetailUpdated: (cb: (ev: ExternalSessionDetailUpdatedEvent) => void) => () => void;
      };
      /**
       * Provider API keys, several per provider. Local IPC only, and never a
       * read path for the secret — `get` answers with the same non-secret
       * summary `list` does.
       */
      apiCredentials: {
        list: (args?: ApiCredentialListArgs, pin?: OpenProjectBinding | null) => Promise<ApiCredentialSummary[]>;
        get: (args: ApiCredentialGetArgs, pin?: OpenProjectBinding | null) => Promise<ApiCredentialSummary | null>;
        store: (args: ApiCredentialStoreArgs, pin?: OpenProjectBinding | null) => Promise<ApiCredentialSummary | null>;
        remove: (args: ApiCredentialRemoveArgs, pin?: OpenProjectBinding | null) => Promise<void>;
      };
      proxy?: {
        status: (pin?: OpenProjectBinding | null) => Promise<SubscriptionProxyStatus>;
        ensureRunning: (pin?: OpenProjectBinding | null) => Promise<SubscriptionProxyStatus>;
        signIn: (args: SubscriptionProxySignInArgs, pin?: OpenProjectBinding | null) => Promise<SubscriptionProxySignInResult>;
        signOut: (args: SubscriptionProxySignOutArgs, pin?: OpenProjectBinding | null) => Promise<SubscriptionProxyMutationResult>;
        setDisabled: (args: SubscriptionProxySetDisabledArgs, pin?: OpenProjectBinding | null) => Promise<SubscriptionProxyMutationResult>;
      };
      /**
       * The account's provider sign-ins for ADE Cloud (P5). `status` reads (any
       * caller); the rest are the person's, and the brain refuses them to
       * anything but this desktop. Pass the machine's pin from
       * `useSettingsMachineScope().pin` for its "this computer" part; the
       * account part is the same from any brain of the person's.
       */
      providerLogins: {
        status: (args?: { provider?: ProviderLoginProvider | null }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        captureNow: (args?: { provider?: ProviderLoginProvider | null }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        /**
         * Copy Antigravity's agy CLI sign-in from this computer's OS keyring, once (macOS, or a
         * locked Linux keyring, asks first). Refused on a cloud computer and for another
         * computer's pin or binding ("Run this on that computer").
         */
        allowKeychain: (args: { provider: "antigravity"; slot?: "personal" | "business" | null }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        /**
         * Copilot's GitHub CLI login (github.com) for ADE Cloud on one computer, off at the start.
         * `on: true` runs one `gh auth token` there at once and returns what it found in
         * `providers[copilot].ghCli`; refused for another computer's pin or binding.
         * `on: false` removes that computer's copy from the account; pass the computer's pin.
         */
        allowGitHubCli: (args: { on: boolean }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        use: (args: { provider: ProviderLoginProvider; key: string | null; slot?: string | null }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        setCloud: (args: { key: string; on: boolean }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        setCloudAll: (args: { on: boolean }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        /** Claude's smart balance on ADE Cloud: one switch for ADE Cloud, apart from each computer's own. */
        setCloudBalance: (args: { provider: "claude"; on: boolean }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        remove: (args: { key: string }, pin?: OpenProjectBinding | null) => Promise<ProviderLoginSyncStatus>;
        /** A capture, an apply or a setting change on the bound or pinned brain. */
        onChanged: (cb: () => void, pin?: OpenProjectBinding | null) => () => void;
      };
      /**
       * Settings › Passwords: the account's saved logins and secrets.
       *
       * Every method takes the machine's pin from
       * `useSettingsMachineScope().pin`; with none it reaches the tab's bound
       * runtime, or this computer's brain through `passwords.call`. Only
       * summaries cross this boundary. No method returns a saved value, and
       * `resolveForFill` is not exposed to a renderer.
       */
      passwords: {
        status: (args?: Record<string, never>, pin?: OpenProjectBinding | null) => Promise<PasswordsStatus>;
        setEnabled: (args: { enabled: boolean }, pin?: OpenProjectBinding | null) => Promise<PasswordsStatus>;
        setCloudEnabled: (args: { enabled: boolean }, pin?: OpenProjectBinding | null) => Promise<PasswordsStatus>;
        /** Wipes every saved item on every computer. The person types `reset` first. */
        reset: (args: { confirm: "reset" }, pin?: OpenProjectBinding | null) => Promise<PasswordsStatus>;
        list: (args?: Record<string, never>, pin?: OpenProjectBinding | null) => Promise<PasswordItemSummary[]>;
        activity: (args?: Record<string, never>, pin?: OpenProjectBinding | null) => Promise<import("../shared/types/passwords").PasswordUseRecord[]>;
        code?: (args: { itemId: string }, pin?: OpenProjectBinding | null) => Promise<{ code: string; secondsLeft: number } | null>;
        reveal?: (args: { itemId: string; field: "password" | "username" | "value" | "notes"; copy?: boolean; label?: string }) => Promise<{ value?: string; copied?: true }>;
        saveLogin: (args: PasswordLoginSaveInput, pin?: OpenProjectBinding | null) => Promise<PasswordItemSummary>;
        saveSecret: (args: PasswordSecretSaveInput, pin?: OpenProjectBinding | null) => Promise<PasswordItemSummary>;
        remove: (args: { id: string }, pin?: OpenProjectBinding | null) => Promise<boolean>;
        importCsv: (args: { text: string }, pin?: OpenProjectBinding | null) => Promise<PasswordImportResult>;
        sync: (args?: Record<string, never>, pin?: OpenProjectBinding | null) => Promise<void>;
      };
      providerInstances: {
        list: (
          args?: ProviderInstanceListArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance[]>;
        create: (
          args: ProviderInstanceCreateArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstanceCreateResult>;
        remove: (
          args: ProviderInstanceRemoveArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstanceRemoveResult>;
        setDefault: (
          args: ProviderInstanceSetDefaultArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance>;
        setAccent: (
          args: ProviderInstanceSetAccentArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance>;
        dismissReplaced: (
          args: ProviderInstanceDismissReplacedArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance>;
        /** Signs the account out with the provider CLI; refused for the default. */
        signOut: (
          args: ProviderInstanceDismissReplacedArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance | null>;
        loginStart: (args: ProviderLoginStartArgs, pin?: OpenProjectBinding | null) => Promise<ProviderLoginStatus>;
        loginStatus: (args: ProviderLoginRefArgs, pin?: OpenProjectBinding | null) => Promise<ProviderLoginStatus>;
        loginSubmitCode: (args: ProviderLoginSubmitCodeArgs, pin?: OpenProjectBinding | null) => Promise<ProviderLoginStatus>;
        loginCancel: (args: ProviderLoginRefArgs, pin?: OpenProjectBinding | null) => Promise<ProviderLoginStatus>;
        getSettings: (
          args: ProviderInstanceGetSettingsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstanceSettings>;
        setSettings: (
          args: ProviderInstanceSetSettingsArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstanceSettings>;
        loginCommand: (
          args: ProviderInstanceLoginCommandArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstanceLoginCommand>;
        refresh: (
          args?: ProviderInstanceRefreshArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<ProviderInstance[]>;
      };
      pty: {
        create: (args: PtyCreateArgs, pin: OpenProjectBinding) => Promise<PtyCreateResult>;
        resumeSession: (
          args: PtyResumeSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<PtyResumeSessionResult>;
        sendToSession: (
          args: PtySendToSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<PtySendToSessionResult>;
        write: (
          args: { ptyId: string; data: string },
          pin: OpenProjectBinding,
        ) => Promise<void>;
        resize: (
          args: {
            ptyId: string;
            cols: number;
            rows: number;
          },
          pin: OpenProjectBinding,
        ) => Promise<void>;
        dispose: (args: { ptyId: string; sessionId?: string }, pin: OpenProjectBinding) => Promise<PtyDisposeResult>;
        /** The terminal machine's installed shells and its default for new shells. */
        getShellSettings: (pin?: OpenProjectBinding | null) => Promise<TerminalShellSettings>;
        /** Save that machine's default shell: a reported id, or null for Automatic. */
        setDefaultShell: (
          args: SetDefaultTerminalShellArgs,
          pin?: OpenProjectBinding | null,
        ) => Promise<TerminalShellSettings>;
        setDataSubscriptions: (
          args: { ptyIds: string[] },
          pin: OpenProjectBinding,
        ) => Promise<void>;
        onData: (
          cb: (ev: PtyDataEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        onExit: (
          cb: (ev: PtyExitEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
      };
      diff: {
        getChanges: (
          args: GetDiffChangesArgs,
          pin: OpenProjectBinding,
        ) => Promise<DiffChanges>;
        /**
         * Every file the lane's commits changed since its base (uncommitted
         * edits are `getChanges`). Rejects when the base cannot be resolved; null, or a
         * rejection naming an unknown action, from a host that predates it.
         */
        getBranchChanges?: (
          args: GetDiffChangesArgs,
          pin: OpenProjectBinding,
        ) => Promise<import("../shared/types").BranchDiffChanges | null>;
        getFile: (
          args: GetFileDiffArgs,
          pin: OpenProjectBinding,
        ) => Promise<FileDiff>;
        getFilePatch: (
          args: GetFilePatchArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilePatch>;
      };
      // `pin` addresses one machine explicitly: omitted or null means "the
      // machine this project tab is bound to" (today's behavior, including the
      // local IPC fallback), a binding means "that machine, regardless of what
      // the tab is bound to". Writes honour it too — a file on another
      // connected machine is fully editable. `external-local:*` workspaces are
      // local-only by construction and ignore the pin.
      /**
       * Files of one copy. Every member takes a required pin (the copy that
       * owns the workspace, the tab's own included), except `openExternalPath`,
       * which opens a path from this computer's Finder.
       */
      files: {
        writeTextAtomic: (
          args: WriteTextAtomicArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        listWorkspaces: (
          args: FilesListWorkspacesArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<FilesWorkspace[]>;
        listTree: (
          args: FilesListTreeArgs,
          pin: OpenProjectBinding,
        ) => Promise<FileTreeNode[]>;
        listTreeChildren: (
          args: FilesListTreeChildrenArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesListTreeChildrenResult>;
        refreshGitDecorations: (
          args: FilesRefreshGitDecorationsArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesGitStatusEvent>;
        /** Local-only: the path comes from this machine's Finder/drag-drop, so it takes no pin. */
        openExternalPath: (
          args: FilesOpenExternalPathArgs,
        ) => Promise<FilesOpenExternalPathResult>;
        readFile: (
          args: FilesReadFileArgs,
          pin: OpenProjectBinding,
        ) => Promise<FileContent>;
        readFileRange: (
          args: FilesReadFileRangeArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesReadFileRangeResult>;
        gitBlame: (
          args: FilesGitBlameArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesGitBlameResult>;
        writeText: (
          args: FilesWriteTextArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        createFile: (
          args: FilesCreateFileArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        createDirectory: (
          args: FilesCreateDirectoryArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        rename: (
          args: FilesRenameArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        delete: (
          args: FilesDeleteArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        watchChanges: (
          args: FilesWatchArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        stopWatching: (
          args: FilesWatchArgs,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        quickOpen: (
          args: FilesQuickOpenArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesQuickOpenItem[]>;
        searchText: (
          args: FilesSearchTextArgs,
          pin: OpenProjectBinding,
        ) => Promise<FilesSearchTextMatch[]>;
        onChange: (cb: (ev: FileChangeEvent) => void, pin: OpenProjectBinding) => () => void;
      };
      git: {
        stageFile: (
          args: GitFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stageAll: (
          args: GitBatchFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        unstageFile: (
          args: GitFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        unstageAll: (
          args: GitBatchFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        discardFile: (
          args: GitFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        restoreStagedFile: (
          args: GitFileActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        commit: (
          args: GitCommitArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        listRecentCommits: (
          args: GitListRecentCommitsArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitCommitSummary[]>;
        listCommitFiles: (
          args: GitListCommitFilesArgs,
          pin: OpenProjectBinding,
        ) => Promise<string[]>;
        getCommitMessage: (
          args: GitGetCommitMessageArgs,
          pin: OpenProjectBinding,
        ) => Promise<string>;
        getCommit: (
          args: { laneId: string; commitSha: string },
          pin: OpenProjectBinding,
        ) => Promise<GitCommitSummary | null>;
        isCommitInLaneHistory: (
          args: { laneId: string; commitSha: string },
          pin: OpenProjectBinding,
        ) => Promise<boolean>;
        revertCommit: (
          args: GitRevertArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        cherryPickCommit: (
          args: GitCherryPickArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        createTag: (
          args: GitCreateTagArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        resetToCommit: (
          args: GitResetCommitArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stashPush: (
          args: GitStashPushArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stashList: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitStashSummary[]>;
        stashApply: (
          args: GitStashRefArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stashPop: (
          args: GitStashRefArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stashDrop: (
          args: GitStashRefArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        stashClear: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        fetch: (args: { laneId: string }, pin: OpenProjectBinding) => Promise<GitActionResult>;
        pull: (
          args: GitPullArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        undoLastHeadChange: (
          args: GitHeadChangeActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        redoLastHeadChange: (
          args: GitHeadChangeActionArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        getSyncStatus: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitUpstreamSyncStatus>;
        getSyncStatuses: (
          args: GitSyncStatusesArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitSyncStatuses>;
        getOriginRemote: (
          args: { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<{ remoteUrl: string | null; branch: string | null }>;
        getOpenPrForBranch: (
          args: { laneId: string; branch?: string },
          pin: OpenProjectBinding,
        ) => Promise<{
          prUrl: string | null;
          prNumber: number | null;
          title: string | null;
          headRefName: string | null;
        }>;
        sync: (
          args: GitSyncArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        push: (
          args: GitPushArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        getConflictState: (
          laneId: string,
          pin: OpenProjectBinding,
        ) => Promise<GitConflictState>;
        rebaseContinue: (
          args: string | { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        rebaseAbort: (
          args: string | { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        mergeContinue: (
          args: string | { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        mergeAbort: (
          args: string | { laneId: string },
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
        /**
         * Merge the lane's compare base (`origin/<base>`, fetched first) into
         * the lane. On a conflict or any failure it aborts and throws, leaving
         * the lane as it was.
         */
        mergeBaseIn: (
          args: GitMergeBaseInArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitMergeBaseInResult>;
        listBranches: (
          args: GitListBranchesArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitBranchSummary[]>;
        getUserIdentity: (
          args: GitGetUserIdentityArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitUserIdentity>;
        checkoutBranch: (
          args: GitCheckoutBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitActionResult>;
      };
      conflicts: {
        getLaneStatus: (
          args: GetLaneConflictStatusArgs,
          pin: OpenProjectBinding,
        ) => Promise<ConflictStatus>;
        listOverlaps: (args: ListOverlapsArgs, pin: OpenProjectBinding) => Promise<ConflictOverlap[]>;
        getRiskMatrix: (pin: OpenProjectBinding) => Promise<RiskMatrixEntry[]>;
        runPrediction: (
          args: RunConflictPredictionArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<BatchAssessmentResult>;
        listProposals: (laneId: string, pin: OpenProjectBinding) => Promise<ConflictProposal[]>;
        prepareProposal: (
          args: PrepareConflictProposalArgs,
          pin: OpenProjectBinding,
        ) => Promise<ConflictProposalPreview>;
        requestProposal: (
          args: RequestConflictProposalArgs,
          pin: OpenProjectBinding,
        ) => Promise<ConflictProposal>;
        applyProposal: (
          args: ApplyConflictProposalArgs,
          pin: OpenProjectBinding,
        ) => Promise<ConflictProposal>;
        undoProposal: (
          args: UndoConflictProposalArgs,
          pin: OpenProjectBinding,
        ) => Promise<ConflictProposal>;
        onEvent: (cb: (ev: ConflictEventPayload) => void, pin: OpenProjectBinding) => () => void;
      };
      /**
       * Direct GitHub reads with the ADE account's GitHub App sign-in
       * (`shared/github/directClient.ts`). Account-scoped: no machine, so no
       * pin. Optional: an older ADE does not have it.
       */
      githubDirect?: {
        request: <O extends GithubDirectOp>(
          request: Extract<GithubDirectRequest, { op: O }>,
          options?: GithubDirectRequestOptions,
        ) => Promise<GithubDirectResult<GithubDirectData[O]>>;
        getState: () => Promise<GithubDirectClientState>;
      };
      github: {
        getStatus: (opts?: { forceRefresh?: boolean }, pin?: OpenProjectBinding | null) => Promise<GitHubStatus>;
        getRemoteStatus: (opts: {
          forceRefresh?: boolean;
        } | undefined, pin: OpenProjectBinding) => Promise<GitHubRemoteStatus>;
        setToken: (token: string, pin?: OpenProjectBinding | null) => Promise<GitHubSetTokenResult>;
        clearToken: (pin?: OpenProjectBinding | null) => Promise<GitHubStatus>;
        /**
         * Optional: an older ADE does not have it. `enabled: false` takes the
         * gh login off the ADE account; `enabled: true` shares this machine's.
         */
        setGhAccountSharing?: (args: { enabled: boolean }, pin?: OpenProjectBinding | null) => Promise<GitHubStatus>;
        getAppUserAuthStatus: (pin?: OpenProjectBinding | null) => Promise<GitHubAppUserAuthStatus>;
        startAppUserDeviceAuth: (pin?: OpenProjectBinding | null) => Promise<GitHubAppDeviceAuthStartResult>;
        pollAppUserDeviceAuth: (args: {
          sessionId: string;
        }, pin?: OpenProjectBinding | null) => Promise<GitHubAppDeviceAuthPollResult>;
        clearAppUserAuth: (pin?: OpenProjectBinding | null) => Promise<GitHubAppUserAuthStatus>;
        /**
         * The ADE account's GitHub App sign-in. Account-scoped (no pin): it
         * lives in the account directory, not on a machine. Optional: an older
         * ADE, and the web client before it has them, do not.
         */
        getAccountAppStatus?: () => Promise<GitHubAccountAppAccountStatus>;
        startAccountAppSignIn?: () => Promise<GitHubAccountAppSignInStartResult>;
        readAccountAppSignIn?: (args: { signInId: string }) => Promise<GitHubAccountAppSignInReadResult>;
        signOutAccountApp?: () => Promise<GitHubAccountAppSignOutResult>;
        // Optional: an older remote runtime does not implement the budget read.
        // Callers must feature-detect and fall back to their own local backoff.
        getRequestBudget?: (pin: OpenProjectBinding) => Promise<GitHubRequestBudget>;
        // Optional for the same reason: an older runtime lacks the star check.
        isRepoStarred?: (pin: OpenProjectBinding) => Promise<GitHubRepoStarState>;
        detectRepo: (pin: OpenProjectBinding) => Promise<{ owner: string; name: string } | null>;
        listRepoIssues: (args: {
          owner?: string;
          name?: string;
          state?: "open" | "closed" | "all";
          since?: string;
        } | undefined, pin: OpenProjectBinding) => Promise<GitHubIssueLike[]>;
        getIssue: (args: {
          owner?: string;
          name?: string;
          number: number;
        }, pin: OpenProjectBinding) => Promise<GitHubIssueLike | null>;
        /** Issues enabled + open count, one GraphQL point. */
        getRepoIssueSummary: (args: { owner: string; name: string }, pin: OpenProjectBinding) => Promise<GitHubRepoIssueSummary>;
        listIssueComments: (args: { owner: string; name: string; number: number }, pin: OpenProjectBinding) => Promise<GitHubIssueCommentLike[]>;
        createIssue: (args: { owner: string; name: string; input: GitHubIssueCreateInput }, pin: OpenProjectBinding) => Promise<GitHubIssueCreateResult>;
        listIssueTemplates: (args: { owner: string; name: string }, pin: OpenProjectBinding) => Promise<GitHubIssueTemplateSet>;
        listIssueTypes: (args: { owner: string; name: string }, pin: OpenProjectBinding) => Promise<GitHubIssueTypeOption[]>;
        /** Which credential an issue edit would use, and the App's issues permission. */
        getIssueWriteAccess: (args: { owner: string; name: string; force?: boolean }, pin: OpenProjectBinding) => Promise<GitHubIssueWriteAccess>;
        updateIssue: (args: { owner: string; name: string; number: number; patch: GitHubIssuePatch }, pin: OpenProjectBinding) => Promise<GitHubIssueLike | null>;
        commentOnIssue: (args: { owner: string; name: string; number: number; body: string }, pin: OpenProjectBinding) => Promise<GitHubIssueCommentLike | null>;
        listRepoMilestones: (args: { owner: string; name: string }, pin: OpenProjectBinding) => Promise<Array<{ number: number; title: string }>>;
        /** Issues only (no pull requests), newest activity first, one GraphQL page. */
        listRepoIssueList: (args: { owner: string; name: string; state: "open" | "closed" | "all" }, pin: OpenProjectBinding) => Promise<GitHubIssueLike[]>;
        listRepoAutolinks: (args: {
          owner?: string;
          name?: string;
        } | undefined, pin: OpenProjectBinding) => Promise<GitHubAutolink[]>;
        getAppInstallationStatus: (args?: {
          owner?: string;
          name?: string;
          forceRefresh?: boolean;
          /** A person pressed Refresh: implies `forceRefresh`. */
          userRequested?: boolean;
        }, pin?: OpenProjectBinding | null) => Promise<GitHubAppInstallationStatus>;
        createRepoAutolink: (args: {
          owner?: string;
          name?: string;
          keyPrefix: string;
          urlTemplate: string;
          isAlphanumeric?: boolean;
        }, pin: OpenProjectBinding) => Promise<GitHubAutolink>;
        listRepoLabels: (args: {
          owner: string;
          name: string;
        }, pin: OpenProjectBinding) => Promise<Array<{ name: string; color?: string }>>;
        listRepoCollaborators: (args: {
          owner: string;
          name: string;
        }, pin: OpenProjectBinding) => Promise<Array<{ login: string; avatarUrl?: string }>>;
        listMyRepos: (
          input?: ListMyGitHubReposInput,
          pin?: OpenProjectBinding | null,
        ) => Promise<ListMyGitHubReposResult>;
        publishCurrentProject: (
          input: PublishProjectInput,
          pin: OpenProjectBinding,
        ) => Promise<PublishProjectResult>;
        onStatusChanged: (cb: (status: GitHubStatus) => void, pin?: OpenProjectBinding | null) => () => void;
      };
      jira: {
        getConnectionStatus: (pin?: OpenProjectBinding | null) => Promise<JiraConnectionStatus>;
        connect: (args: JiraConnectArgs, pin?: OpenProjectBinding | null) => Promise<JiraConnectionStatus>;
        disconnect: (pin?: OpenProjectBinding | null) => Promise<JiraConnectionStatus>;
        listProjects: (args?: { query?: string }, pin?: OpenProjectBinding | null) => Promise<JiraProject[]>;
        listIssues: (args: JiraListIssuesArgs | undefined, pin: OpenProjectBinding) => Promise<JiraIssuePage>;
        // Issue reads and writes (class A) go to the repository reader. The
        // connection members above are machine-global (D); `listProjects` and
        // `listIssues` keep an optional pin until Settings and the chat
        // composer pass one (see the PRs and issues report).
        getIssue: (args: { key: string }, pin: OpenProjectBinding) => Promise<JiraIssueDetail>;
        listComments: (args: { key: string; cursor: string | null }, pin: OpenProjectBinding) => Promise<{ comments: JiraComment[]; nextCursor: string | null }>;
        addComment: (args: { key: string; body: string }, pin: OpenProjectBinding) => Promise<JiraComment>;
        updateIssue: (args: JiraUpdateIssueArgs, pin: OpenProjectBinding) => Promise<void>;
        listTransitions: (args: { key: string }, pin: OpenProjectBinding) => Promise<JiraTransition[]>;
        transitionIssue: (args: { key: string; transitionId: string }, pin: OpenProjectBinding) => Promise<void>;
        listAssignableUsers: (args: { projectKey?: string; key?: string; query?: string } | undefined, pin: OpenProjectBinding) => Promise<JiraUser[]>;
        listLabels: (args: { query?: string } | undefined, pin: OpenProjectBinding) => Promise<string[]>;
        getCreateMeta: (args: { projectKey: string }, pin: OpenProjectBinding) => Promise<JiraCreateMeta>;
        createIssue: (args: JiraCreateIssueArgs, pin: OpenProjectBinding) => Promise<JiraCreateIssueResult>;
      };
      /**
       * Contract C2 (shared/machineAddress.ts): an address for one machine of
       * the account, by machine key. Pairs through the account when this
       * computer has no saved connection; `connect: false` leaves a sleeping
       * cloud computer asleep. Never reads or changes the tab's machine.
       */
      machines: {
        connect: (machineKey: string, options?: MachineConnectOptions) => Promise<MachineConnectResult>;
        /** From saved connections only; no network. */
        addressFor: (machineKey: string) => Promise<MachineAddress | null>;
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
        getMachineInventory?: (
          machineKey?: string,
          pin?: OpenProjectBinding | null,
        ) => Promise<MachineInventoryDetail>;
        /** The signed-in account's own profile picture, as a data URL (for reading its colours). */
        getAvatarDataUrl?: () => Promise<string | null>;
        getConnectionRoutes?: (args?: {
          machineKey?: string | null;
          refresh?: boolean;
        }) => Promise<MachineConnectionRoutes>;
        setRelayEnabled?: (args: {
          machineKey?: string | null;
          enabled: boolean;
        }) => Promise<MachineConnectionRoutes>;
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
        /** Starts (or re-hosts) mobile sync on THIS machine. Optional: older preloads lack it. */
        startSyncHost?: () => Promise<AdeAccountSyncHostStartResult>;
        /**
         * Repairs the stored sign-in on THIS Mac: converge the credential
         * file's key binding, restore anything set aside, then restart the
         * background service. Optional because older preloads lack it.
         */
        repairSession?: () => Promise<AdeAccountSessionRepairResult>;
      };
      /**
       * Whether ADE Cloud exists for this account: the desktop's own answer, or
       * on the web, a connected machine's through `cloud.read`. No answer yet
       * reads as no. Account-wide, so no pin.
       */
      cloudAccess?: {
        /** `signInEnd`: the sign-in the end warning names (a Claude pass or a key), only while ADE Cloud is on (desktop only). */
        read: () => Promise<{ enabled: boolean; signInEnd?: CloudSignInEnd | null }>;
        onChanged: (cb: () => void) => () => void;
      };
      /**
       * ADE Cloud, account-wide: the machines and
       * new machines made on it. No pin: nothing here acts on a lane, chat or
       * another machine. Optional because the web client does not expose it.
       */
      cloud?: {
        /** Saved chats: account-level. Reads a computer's copy while it can't answer. */
        savedChats?: {
          list: (args: CloudSavedChatsListArgs) => Promise<CloudSavedChatList | null>;
          read: (args: CloudSavedChatReadArgs) => Promise<CloudSavedChatPage | null>;
          delete: (args: CloudSavedChatDeleteArgs) => Promise<void>;
        };
        getStatus: () => Promise<CloudStatus | null>;
        /** A copy or move reports through `onCreateProgress`, ending in `done` or `failed`. */
        onCreateProgress: (cb: (progress: CloudCreateProgress) => void) => () => void;
        /** Stops a create and deletes the box it made, unless it already signed in. */
        cancelCreate: (requestId: string) => Promise<{ cancelled: boolean }>;
        /**
         * The account's boxes with state, size, price and spend. Account-level
         * (cloud access is the account's), so no pin: it answers the same on
         * every computer.
         */
        listMachines?: () => Promise<CloudMachinesResult | null>;
        /** Sleep, wake, resize, back up or delete one box, on the provider. No pin, as above. */
        machineAction?: (args: CloudMachineActionArgs) => Promise<CloudMachineActionResult | null>;
        onStatusChanged?: (cb: () => void) => () => void;
        /**
         * C4: can a new cloud computer clone this repository? The account's
         * GitHub sign-in, else the repository is public. Account-level, so
         * no pin. Null from an untrusted sender. The lane launch runs the
         * same check at its start; no renderer surface calls this yet.
         */
        gitPreflight?: (args: { originUrl: string }) => Promise<CloudGitPreflight | null>;
        /**
         * Sign-ins for cloud machines: the provider sign-ins every new cloud
         * machine starts with. Kept in the account vault and run on this
         * computer's brain, so no pin: every computer answers the same.
         */
        cloudSignInStatus?: () => Promise<CloudSignInStatus | null>;
        cloudSignInClaudeStart?: (args?: CloudSignInClaudeStartArgs) => Promise<CloudSignInStatus | null>;
        cloudSignInClaudeKeep?: () => Promise<CloudSignInStatus | null>;
        cloudSignInClaudeCode?: (code: string) => Promise<CloudSignInStatus | null>;
        cloudSignInClaudeCancel?: () => Promise<CloudSignInStatus | null>;
        cloudSignInSaveKey?: (id: CloudSignInId, key: string) => Promise<CloudSignInStatus | null>;
        cloudSignInRemove?: (id: CloudSignInId) => Promise<CloudSignInStatus | null>;
        onCloudSignInChanged?: (cb: () => void) => () => void;
        /** What unattended agents may do on ADE Cloud (account vault; no pin). */
        getAgentLimits?: () => Promise<CloudAgentLimits | null>;
        setAgentLimits?: (limits: Partial<CloudAgentLimits>) => Promise<CloudAgentLimits | null>;
        /** The account's plan (no pin): extra hours and extra disk for paid accounts, and Stripe's pages in the browser. */
        setExtraHours?: (enabled: boolean) => Promise<CloudAccountState | null>;
        /** Extra disk on with a monthly limit in whole dollars (1 to 1,000), or off. */
        setExtraDisk?: (choice: { enabled: true; monthlyLimitUsd: number } | { enabled: false }) => Promise<CloudAccountState | null>;
        /**
         * Enters a friend's invite: the pasted link (https or ade://) or the bare
         * code (no pin: account level). Once per account, never changed, within
         * `CLOUD_REFERRAL_ENTER_DAYS` of making it. The account read
         * (`CloudAccountState.referral`) carries the invite link and what it earned.
         * A refusal is `{ ok: false, reason, message }` (show `message`); after a
         * success ADE Cloud's status changes, so the account reads again.
         * Optional: the web client has no code box.
         */
        redeemInvite?: (code: string) => Promise<CloudInviteRedeemOutcome>;
        /**
         * Checkout for Plus (the default) or Pro. A paid account asking for its
         * other plan changes it in place: nothing opens and `change` says when
         * it applies (`now` for Pro, `next_period` for Plus). A downgrade over
         * Plus's limits carries the person's pick (`cleanup`): the server
         * frees exactly those computers once the plan changed.
         */
        openCheckout?: (plan?: CloudPaidPlanId, cleanup?: CloudPlanCleanupPick) => Promise<CloudOpenCheckoutResult>;
        /**
         * The person's pick for an account already over a cheaper plan (a
         * cancel in the billing portal, a plan that ended). Account level: the
         * server frees the account's computers itself, so no pin.
         */
        pickPlanCleanup?: (input: { planId: CloudPlanId } & CloudPlanCleanupPick) => Promise<CloudAccountState | null>;
        openBillingPortal?: () => Promise<{ opened: boolean }>;
        /**
         * Copy (fork) or move (box ↔ VM) one box. Both answer at once and
         * report through `onCreateProgress` with this request id. Account
         * level (they act on the account's cloud machines), so no pin.
         */
        copyMachine?: (args: { requestId: string; instanceId: string; name?: string | null; shape?: string | null }) => Promise<{ started: boolean }>;
        moveMachine?: (args: { requestId: string; instanceId: string; machineKey?: string | null; to: "box" | "vm"; shape?: string | null }) => Promise<{ started: boolean }>;
        /** Signs a box that was removed from the account ("Not in ADE") back in, as the same machine. Reports like a copy. */
        reconnectMachine?: (args: { requestId: string; instanceId: string }) => Promise<{ started: boolean }>;
        personIsHere?: () => Promise<boolean>;
        pushAllWork?: (instanceId: string) => Promise<CloudMachineActionResult>;
        /**
         * The life of a lane's computer: work check, delete lane, keep the
         * lane on a fresh computer, lanes without a computer, tier changes
         * (`shared/cloudLaneLife.ts` has each method's args and answer).
         * Account level: it names a computer of the account, so no pin.
         */
        laneLife?: <M extends import("../shared/cloudLaneLife").CloudLaneLifeMethod>(
          request: import("../shared/cloudLaneLife").CloudLaneLifeCallRequest<M>,
        ) => Promise<import("../shared/cloudLaneLife").CloudLaneLifeResults[M]>;
        /** A tier change's steps as they move. */
        onLaneJob?: (cb: (job: import("../shared/cloudLaneLife").CloudLaneJobSnapshot) => void) => () => void;
        /** Contract C3 (shared/laneComputer.ts): the computer a lane is on now, by lane id. Account level. */
        laneComputer?: (laneId: string) => Promise<import("../shared/laneComputer").LaneComputer | null>;
        /** The lane's computer and an address for it; pairs, and connects (which wakes it) unless `connect: false`. */
        followLane?: (laneId: string, options?: { connect?: boolean }) => Promise<import("../shared/laneComputer").LaneFollowResult>;
        /** A lane's computer changed: same lane id and chat ids, a new machine key. */
        onLaneMoved?: (cb: (move: import("../shared/laneComputer").LaneMovedEvent) => void) => () => void;
        /**
         * Clears a lane computer's caches (`cloud.clear_caches`) on THAT
         * computer: `pin` is the lane's machine binding, `instanceId` its
         * ADE Cloud id (the brain refuses a call that reached another one).
         */
        clearCaches?: (pin: OpenProjectBinding, instanceId: string) => Promise<{ freedGb: number }>;
      };
      /**
       * The account settings store (the `account_settings` action domain),
       * which is what makes "stored in your ADE account" true for the
       * account-scoped preferences in Settings.
       *
       * Optional because the hosted web client and older preloads do not
       * expose it; callers treat its absence exactly like an unavailable
       * result and keep the machine-local copy.
       */
      accountSettings?: {
        list: (args?: { scope?: string | null }) => Promise<AccountSettingsResult<AccountSettingRow[]>>;
        get: (args: { scope: string; key: string }) => Promise<AccountSettingsResult<unknown>>;
        set: (
          args: { scope: string; key: string; value: unknown } & AccountSettingsWriteOptions,
        ) => Promise<AccountSettingsResult<null>>;
        /** Deletes a key on every machine of the account; a reader then sees it as never set. */
        remove?: (
          args: { scope: string; key: string } & AccountSettingsWriteOptions,
        ) => Promise<AccountSettingsResult<null>>;
        sync: () => Promise<AccountSettingsResult<null>>;
        onChanged?: (listener: () => void) => () => void;
      };
      /**
       * Settings > Integrations > MCP servers: this computer's view of the registry, and the
       * one path that writes a registry secret to the account vault. No call
       * returns a secret value.
       *
       * Optional because the hosted web client does not expose it; the page
       * is hidden there.
       */
      mcpRegistry?: {
        context: (args: { projectRoot: string | null }) => Promise<McpRegistryContext>;
        check: (args: { servers: McpRegistryServer[] }) => Promise<McpRegistryResult<McpRegistryCheck>>;
        setSecret: (args: McpRegistrySecretRef & { value: string }) => Promise<McpRegistryResult<null>>;
        removeSecret: (args: McpRegistrySecretRef) => Promise<McpRegistryResult<null>>;
        /** Drops the vault items `server` no longer names; all of them when `keep` is null. */
        pruneSecrets: (args: { server: string; keep: McpRegistryServer | null }) => Promise<McpRegistryResult<null>>;
        scan: (args: { projectRoot: string | null }) => Promise<McpRegistryScan>;
        import: (args: { name: string; projectRoot: string | null }) => Promise<McpRegistryImportResult>;
        /**
         * Browser sign-in, run on this computer; the token goes to the account
         * vault. Resolves when the browser comes back, or on cancel / timeout.
         */
        signIn: (args: { server: McpRegistryServer }) => Promise<McpRegistrySignInResult>;
        cancelSignIn: (args: { server: string }) => Promise<boolean>;
        signOut: (args: { server: string }) => Promise<McpRegistryResult<null>>;
        /**
         * Registry servers a chat's running agent did not start with, read on
         * the chat's machine: `pin`, else the tab's runtime.
         */
        chatStatus?: (args: { chatSessionId: string }, pin: OpenProjectBinding) => Promise<McpRegistryChatStatus>;
      };
      prs: {
        createFromLane: (args: CreatePrFromLaneArgs, pin: OpenProjectBinding) => Promise<PrSummary>;
        linkToLane: (args: LinkPrToLaneArgs, pin: OpenProjectBinding) => Promise<PrSummary>;
        preflightCreateLaneFromPrBranch: (
          args: CreateLaneFromPrBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<CreateLaneFromPrBranchPreflightResult>;
        createLaneFromPrBranch: (
          args: CreateLaneFromPrBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<CreateLaneFromPrBranchResult>;
        /**
         * `pin` routes the read to the machine that owns the lane. A PR row
         * lives in that machine's database, so an unpinned read only ever
         * answers for the machine the project tab is bound to. The PRs tab
         * (which IS bound-machine-scoped) simply omits it.
         */
        getForLane: (
          laneId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrSummary | null>;
        syncLanePr: (
          laneId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrSummary | null>;
        reconcileNow: (pin: OpenProjectBinding) => Promise<void>;
        /** Throttled catch-up reconcile on the machine `pin` names (bound machine when omitted). */
        reconcileOnFocus: (pin: OpenProjectBinding) => Promise<void>;
        listAll: (pin: OpenProjectBinding) => Promise<PrSummary[]>;
        /** See preload `listAllConditional`; optional so bridges that predate it type-check. */
        listAllConditional?: (ifNoneMatch: string | null, pin: OpenProjectBinding) => Promise<PrSummary[] | PrListConditionalReply>;
        listOpenForRepo: (pin: OpenProjectBinding) => Promise<BranchPullRequest[]>;
        refresh: (
          args: {
            prId?: string;
            prIds?: string[];
          } | undefined,
          pin: OpenProjectBinding,
        ) => Promise<PrSummary[]>;
        getStatus: (
          prId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrStatus | null>;
        getChecks: (
          prId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrCheck[]>;
        getComments: (
          prId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrComment[]>;
        getReviews: (
          prId: string,
          pin: OpenProjectBinding,
        ) => Promise<PrReview[]>;
        getReviewThreads: (prId: string, pin: OpenProjectBinding) => Promise<PrReviewThread[]>;
        updateDescription: (args: UpdatePrDescriptionArgs, pin: OpenProjectBinding) => Promise<void>;
        searchMentionables: (args: SearchPrMentionablesArgs, pin: OpenProjectBinding) => Promise<SearchPrMentionablesResult>;
        getRepoReferences: (args: GetPrRepoReferencesArgs, pin: OpenProjectBinding) => Promise<PrRepoReference[]>;
        delete: (args: DeletePrArgs, pin: OpenProjectBinding) => Promise<DeletePrResult>;
        land: (args: LandPrArgs, pin: OpenProjectBinding) => Promise<LandResult>;
        updateBranch: (args: UpdateBranchArgs, pin: OpenProjectBinding) => Promise<UpdateBranchResult>;
        retargetBase: (args: {
          prId: string;
          baseBranch: string;
        }, pin: OpenProjectBinding) => Promise<void>;
        openInGitHub: (prId: string, pin: OpenProjectBinding) => Promise<void>;
        getHealth: (prId: string, pin: OpenProjectBinding) => Promise<PrHealth>;
        getConflictAnalysis: (prId: string, pin: OpenProjectBinding) => Promise<PrConflictAnalysis | null>;
        listWithConflicts: (args: {
          includeConflictAnalysis?: boolean;
        } | undefined, pin: OpenProjectBinding) => Promise<PrWithConflicts[]>;
        listSnapshots: (args: {
          prId?: string;
          /** Only these PRs; an empty list returns none. */
          prIds?: string[];
        } | undefined, pin: OpenProjectBinding) => Promise<PrSnapshotHydration[]>;
        getGitHubSnapshot: (args: {
          force?: boolean;
          includeExternalClosed?: boolean;
          historyPageLimit?: number;
        } | undefined, pin: OpenProjectBinding) => Promise<GitHubPrSnapshot>;
        listGitHubStacks: (
          args: ListGitHubPrStacksArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<GitHubPrStack[]>;
        syncGitHubStacks: (
          args: ListGitHubPrStacksArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<GitHubPrStack[]>;
        createGitHubStack: (
          args: CreateGitHubPrStackArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitHubPrStack>;
        addGitHubStackPullRequests: (
          args: AddGitHubPrStackPullRequestsArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitHubPrStack>;
        unstackGitHubStack: (
          args: UnstackGitHubPrStackArgs,
          pin: OpenProjectBinding,
        ) => Promise<GitHubPrStack | null>;
        linkChatSession: (args: LinkPrChatSessionArgs, pin: OpenProjectBinding) => Promise<{ ok: boolean }>;
        unlinkChatSession: (args: UnlinkPrChatSessionArgs, pin: OpenProjectBinding) => Promise<{ ok: boolean }>;
        /** PR Watch / Ship for one chat; `mode: null` stops it. */
        setChatWatch: (args: SetPrChatWatchArgs, pin: OpenProjectBinding) => Promise<PrChatWatchSummary | null>;
        getChatWatches: (args: GetPrChatWatchArgs, pin: OpenProjectBinding) => Promise<PrChatWatchSummary[]>;
        /** A private repo PR attachment as a signed URL, resolved on the machine `pin` names. */
        resolveMedia: (args: ResolvePrMediaArgs, pin: OpenProjectBinding) => Promise<ResolvePrMediaResult>;
        linkChatStack: (args: LinkPrChatStackArgs, pin: OpenProjectBinding) => Promise<{ ok: boolean; linked: number }>;
        listChatSessionsForPr: (
          args: ListPrChatSessionsArgs,
          pin: OpenProjectBinding,
        ) => Promise<PrChatSessionLink[]>;
        getStackLinkOffer: (args: {
          sessionId: string;
          prId?: string | null;
        }, pin: OpenProjectBinding) => Promise<StackLinkOffer | null>;
        onEvent: (
          cb: (ev: PrEventPayload) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        getDetail: (prId: string, pin: OpenProjectBinding) => Promise<PrDetail>;
        getDetailBundle: (prId: string, pin: OpenProjectBinding) => Promise<PrDetailBundle>;
        getFiles: (prId: string, pin: OpenProjectBinding) => Promise<PrFile[]>;
        getCommits: (prId: string, pin: OpenProjectBinding) => Promise<PrCommit[]>;
        getActionRuns: (prId: string, pin: OpenProjectBinding) => Promise<PrActionRun[]>;
        getActivity: (prId: string, pin: OpenProjectBinding) => Promise<PrActivityEvent[]>;
        getWorkflowGraph: (
          args: GetPrWorkflowGraphArgs,
          pin: OpenProjectBinding,
        ) => Promise<PrWorkflowGraph>;
        getCheckLog: (args: GetPrCheckLogArgs, pin: OpenProjectBinding) => Promise<PrCheckLogExcerpt>;
        getDetailByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrDetail>;
        getFilesByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrFile[]>;
        getCommitsByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrCommit[]>;
        getActionRunsByGithub: (
          coords: PrGithubCoords,
          pin: OpenProjectBinding,
        ) => Promise<PrActionRun[]>;
        getActivityByGithub: (
          coords: PrGithubCoords,
          pin: OpenProjectBinding,
        ) => Promise<PrActivityEvent[]>;
        getStatusByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrStatus | null>;
        getChecksByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrCheck[]>;
        getReviewsByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrReview[]>;
        getCommentsByGithub: (coords: PrGithubCoords, pin: OpenProjectBinding) => Promise<PrComment[]>;
        getReviewThreadsByGithub: (
          coords: PrGithubCoords,
          pin: OpenProjectBinding,
        ) => Promise<PrReviewThread[]>;
        addComment: (args: AddPrCommentArgs, pin: OpenProjectBinding) => Promise<PrComment>;
        updateComment: (args: UpdatePrCommentArgs, pin: OpenProjectBinding) => Promise<PrComment>;
        replyToReviewThread: (
          args: ReplyToPrReviewThreadArgs,
          pin: OpenProjectBinding,
        ) => Promise<PrReviewThreadComment>;
        resolveReviewThread: (args: ResolvePrReviewThreadArgs, pin: OpenProjectBinding) => Promise<void>;
        updateTitle: (args: UpdatePrTitleArgs, pin: OpenProjectBinding) => Promise<void>;
        updateBody: (args: UpdatePrBodyArgs, pin: OpenProjectBinding) => Promise<void>;
        setLabels: (args: SetPrLabelsArgs, pin: OpenProjectBinding) => Promise<void>;
        /** Optional: an older remote runtime cannot assign; the UI hides the editor. */
        setAssignees?: (args: SetPrAssigneesArgs, pin: OpenProjectBinding) => Promise<SetPrAssigneesResult>;
        /** Optional: absent on older hosts; the filter pickers then show loaded rows only. */
        listGitHubFilterOptions?: (args: ListGitHubPrFilterOptionsArgs, pin: OpenProjectBinding) => Promise<ListGitHubPrFilterOptionsResult>;
        /** Optional: absent on older hosts; filters then apply to loaded rows only. */
        searchGitHubPrs?: (args: SearchGitHubPrsArgs, pin: OpenProjectBinding) => Promise<SearchGitHubPrsResult>;
        requestReviewers: (args: RequestPrReviewersArgs, pin: OpenProjectBinding) => Promise<void>;
        submitReview: (
          args: SubmitPrReviewArgs,
          pin: OpenProjectBinding,
        ) => Promise<SubmitPrReviewResult>;
        close: (args: ClosePrArgs, pin: OpenProjectBinding) => Promise<void>;
        reopen: (args: ReopenPrArgs, pin: OpenProjectBinding) => Promise<void>;
        setDraft: (args: SetPrDraftArgs, pin: OpenProjectBinding) => Promise<void>;
        setAutoMerge: (args: SetPrAutoMergeArgs, pin: OpenProjectBinding) => Promise<void>;
        rerunChecks: (args: RerunPrChecksArgs, pin: OpenProjectBinding) => Promise<void>;
        getDeployments: (prId: string, pin: OpenProjectBinding) => Promise<PrDeployment[]>;
        postReviewComment: (
          args: PostPrReviewCommentArgs,
          pin: OpenProjectBinding,
        ) => Promise<PrReviewThreadComment>;
        setReviewThreadResolved: (
          args: SetPrReviewThreadResolvedArgs,
          pin: OpenProjectBinding,
        ) => Promise<SetPrReviewThreadResolvedResult>;
        reactToComment: (args: ReactToPrCommentArgs, pin: OpenProjectBinding) => Promise<void>;
        cleanupBranch: (
          args: CleanupPrBranchArgs,
          pin: OpenProjectBinding,
        ) => Promise<CleanupPrBranchResult>;
      };
      rebase: {
        scanNeeds: (pin: OpenProjectBinding) => Promise<RebaseNeed[]>;
        getNeed: (laneId: string, pin: OpenProjectBinding) => Promise<RebaseNeed | null>;
        onEvent: (cb: (ev: RebaseEventPayload) => void, pin: OpenProjectBinding) => () => void;
      };
      history: {
        listOperations: (
          args: ListOperationsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<OperationRecord[]>;
        exportOperations: (
          args: ExportHistoryArgs,
          pin: OpenProjectBinding,
        ) => Promise<ExportHistoryResult>;
      };
      layout: {
        get: (layoutId: string, pin?: OpenProjectBinding | null) => Promise<DockLayout | null>;
        set: (layoutId: string, layout: DockLayout, pin?: OpenProjectBinding | null) => Promise<void>;
      };
      tilingTree: {
        get: (layoutId: string, pin?: OpenProjectBinding | null) => Promise<unknown>;
        set: (layoutId: string, tree: unknown, pin?: OpenProjectBinding | null) => Promise<void>;
      };
      /** Read-only Work tools-pane mirror; `null` when no runtime is bound. */
      workTools: {
        getLaneState: (laneId: string, pin: OpenProjectBinding) => Promise<WorkToolsLaneState | null>;
        noteWatching?: (pin: OpenProjectBinding) => Promise<void>;
        /**
         * `openTools` is the pane's whole tab strip in order; `tool` is the one
         * on screen. Defaulted so an older caller still publishes coherently.
         */
        setActiveTool: (
          laneId: string,
          tool: WorkToolId | null,
          openTools: WorkToolId[] | undefined,
          pin: OpenProjectBinding,
        ) => Promise<void>;
        readObservationPreview: (
          observationPath: string,
          pin: OpenProjectBinding,
        ) => Promise<WorkToolsObservationPreview | null>;
        /** A browser tab's newest frame on the pinned machine; renews a short watch there. */
        readBrowserTabFrame: (
          args: { tabId: string; maxWidth?: number | null },
          pin?: OpenProjectBinding | null,
        ) => Promise<import("../shared/types").BuiltInBrowserRemoteTabFrame | null>;
        /** A person's click, scroll or typing into that tab (Take control). */
        sendBrowserTabInput: (
          args: { tabId: string; event: import("../shared/types").BuiltInBrowserRemoteInputEvent },
          pin?: OpenProjectBinding | null,
        ) => Promise<{ ok: boolean }>;
        /** Dev servers on the lane's machine, for the Browser on any machine. */
        listDevServers: (args: DevServersArgs | undefined, pin: OpenProjectBinding) => Promise<DevServersResult>;
        /**
         * Stop a dev server one chat's agent started, on the chat's machine
         * (pass the row's pin). Refused unless the process on the port is still
         * that chat's; feature-detect before use.
         */
        stopDevServer?: (args: DevServerStopArgs, pin: OpenProjectBinding) => Promise<DevServerStopResult>;
        /** A dev server started or stopped on the lane's machine. */
        onDevServer: (
          cb: (event: DevServerEvent) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        /** `ade ui show`: an agent asking this desktop to show a surface of its chat. */
        onShowRequest: (
          cb: (request: WorkToolShowRequest) => void,
          pin: OpenProjectBinding,
        ) => () => void;
        /** Answer a show request on the runtime it came from. */
        acknowledgeShow: (
          ack: WorkToolShowAck,
          pin: OpenProjectBinding,
        ) => Promise<{ ok: boolean }>;
      };
      tests: {
        listSuites: (pin: OpenProjectBinding) => Promise<TestSuiteDefinition[]>;
        run: (args: RunTestSuiteArgs, pin: OpenProjectBinding) => Promise<TestRunSummary>;
        stop: (args: StopTestRunArgs, pin: OpenProjectBinding) => Promise<void>;
        listRuns: (args: ListTestRunsArgs | undefined, pin: OpenProjectBinding) => Promise<TestRunSummary[]>;
        getLogTail: (args: GetTestLogTailArgs, pin: OpenProjectBinding) => Promise<string>;
        onEvent: (cb: (ev: TestEvent) => void, pin: OpenProjectBinding) => () => void;
      };
      projectConfig: {
        get: (pin: OpenProjectBinding) => Promise<ProjectConfigSnapshot>;
        validate: (
          candidate: ProjectConfigCandidate,
          pin: OpenProjectBinding,
        ) => Promise<ProjectConfigValidationResult>;
        save: (
          candidate: ProjectConfigCandidate,
          pin: OpenProjectBinding,
        ) => Promise<ProjectConfigSnapshot>;
        diffAgainstDisk: (pin: OpenProjectBinding) => Promise<ProjectConfigDiff>;
        /**
         * Answer the notice of a setting that moved to the account with a
         * different value on that computer. Pass the pin of the computer
         * whose notice it is.
         */
        resolveAccountSettingNotice: (
          args: { key: string; choice: "use_local" | "keep" },
          pin: OpenProjectBinding,
        ) => Promise<ProjectConfigSnapshot>;
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
        // CTO calls take the CTO home machine's pin; null = the tab's binding.
        getState: (args: CtoGetStateArgs | undefined, pin: OpenProjectBinding) => Promise<CtoSnapshot>;
        ensureSession: (
          args: CtoEnsureSessionArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<AgentChatSession>;
        startFreshSession: (pin: OpenProjectBinding) => Promise<CtoStartFreshSessionResult>;
        getThreadHealth: (pin: OpenProjectBinding) => Promise<CtoThreadHealth>;
        listSessionLogs: (
          args: CtoListSessionLogsArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<CtoSessionLogEntry[]>;
        updateIdentity: (args: CtoUpdateIdentityArgs, pin: OpenProjectBinding) => Promise<CtoSnapshot>;
        getMemory: (pin: OpenProjectBinding) => Promise<CtoMemorySnapshot>;
        updateMemory: (args: CtoUpdateMemoryArgs, pin: OpenProjectBinding) => Promise<CtoMemorySnapshot>;
        searchMemory: (args: CtoSearchMemoryArgs, pin: OpenProjectBinding) => Promise<CtoSearchMemoryResult>;
        getLinearConnectionStatus: (pin: OpenProjectBinding) => Promise<LinearConnectionStatus>;
        setLinearToken: (
          args: CtoSetLinearTokenArgs,
          pin: OpenProjectBinding,
        ) => Promise<LinearConnectionStatus>;
        clearLinearToken: (pin: OpenProjectBinding) => Promise<LinearConnectionStatus>;
        getOnboardingState: (pin: OpenProjectBinding) => Promise<CtoOnboardingState>;
        completeOnboardingStep: (args: {
          stepId: string;
        }, pin: OpenProjectBinding) => Promise<CtoOnboardingState>;
        previewSystemPrompt: (args: {
          identityOverride?: Record<string, unknown>;
        } | undefined, pin: OpenProjectBinding) => Promise<CtoSystemPromptPreview>;
        getLinearProjects: (pin: OpenProjectBinding) => Promise<CtoLinearProject[]>;
        getLinearQuickView: (pin: OpenProjectBinding) => Promise<CtoLinearQuickView>;
        getLinearIssuePickerData: (pin: OpenProjectBinding) => Promise<CtoGetLinearIssuePickerDataResult>;
        searchLinearIssues: (
          args: CtoSearchLinearIssuesArgs | undefined,
          pin: OpenProjectBinding,
        ) => Promise<CtoSearchLinearIssuesResult>;
        getLinearIssueComments: (
          args: { issueId: string },
          pin: OpenProjectBinding,
        ) => Promise<CtoLinearIssueComment[]>;
        createLinearIssueComment: (args: CtoCreateLinearIssueCommentArgs, pin: OpenProjectBinding) => Promise<{ commentId: string }>;
        createLinearIssue: (args: LinearIssueCreateInput, pin: OpenProjectBinding) => Promise<NormalizedLinearIssue>;
        getLinearIssueCreateOptions: (args: { teamKey: string }, pin: OpenProjectBinding) => Promise<LinearIssueCreateOptions>;
        listLinearProjectMilestones: (args: { projectId: string }, pin: OpenProjectBinding) => Promise<LinearProjectMilestone[]>;
        uploadLinearFile: (args: { filename: string; contentType: string; dataBase64: string }, pin: OpenProjectBinding) => Promise<LinearUploadResult>;
        /** Full detail read (relations, parent, sub-issues). */
        getLinearIssue: (
          args: CtoGetLinearIssueArgs,
          pin: OpenProjectBinding,
        ) => Promise<NormalizedLinearIssue | null>;
        /** One Linear `issueUpdate`; resolves to the refreshed issue. */
        updateLinearIssue: (
          args: CtoUpdateLinearIssueArgs,
          pin: OpenProjectBinding,
        ) => Promise<NormalizedLinearIssue | null>;
        /** Moves the issue to its team's Canceled state unless it is already done or canceled. */
        cancelLinearIssue: (issueId: string, pin: OpenProjectBinding) => Promise<{ canceled: boolean; issue: NormalizedLinearIssue | null }>;
        countLinearIssues: (
          args: CtoCountLinearIssuesArgs,
          pin: OpenProjectBinding,
        ) => Promise<CtoCountLinearIssuesResult>;
        getLinearCustomViews: (pin: OpenProjectBinding) => Promise<CtoLinearCustomView[]>;
        getLinearAgentOverview: (pin: OpenProjectBinding) => Promise<LinearAgentOverview>;
        startLinearAgentInstall: (pin: OpenProjectBinding) => Promise<LinearAgentInstallStart>;
        getLinearAgentInstallSession: (sessionId: string, pin: OpenProjectBinding) => Promise<LinearAgentInstallSession>;
        registerLinearAgentMember: (args: { replace?: boolean } | undefined, pin: OpenProjectBinding) => Promise<LinearAgentOverview>;
        unregisterLinearAgentMember: (pin: OpenProjectBinding) => Promise<LinearAgentOverview>;
        updateLinearAgentSettings: (args: { fallbackMode: "reply" | "runner"; runner: "self" | null }, pin: OpenProjectBinding) => Promise<LinearAgentOverview>;
        uninstallLinearAgent: (pin: OpenProjectBinding) => Promise<LinearAgentOverview>;
        getLinearInbox: (args: { first?: number; includeRead?: boolean } | undefined, pin: OpenProjectBinding) => Promise<LinearInboxNotification[]>;
        markLinearNotification: (args: { notificationId: string; action: "read" | "archive" }, pin: OpenProjectBinding) => Promise<void>;
        getLinearIssueRelationsIssue: (issueId: string, pin: OpenProjectBinding) => Promise<LinearAgentNormalizedIssue | null>;
        setLinearOAuthClient: (
          args: CtoSetLinearOAuthClientArgs,
          pin: OpenProjectBinding,
        ) => Promise<LinearConnectionStatus>;
        clearLinearOAuthClient: (pin: OpenProjectBinding) => Promise<LinearConnectionStatus>;
        startLinearOAuth: (pin: OpenProjectBinding) => Promise<CtoStartLinearOAuthResult>;
        getLinearOAuthSession: (
          args: CtoGetLinearOAuthSessionArgs,
          pin: OpenProjectBinding,
        ) => Promise<CtoGetLinearOAuthSessionResult>;
        runProjectScan: (pin: OpenProjectBinding) => Promise<CtoRunProjectScanResult>;
        getAttention: (pin: OpenProjectBinding) => Promise<CtoAttentionState>;
      };
      /**
       * The owner's lane sharing (`lane_share` runtime actions, user-only).
       * A share lives on the lane's own machine: pass that machine's pin.
       * No pin: the machine the project tab is bound to.
       */
      laneShare: {
        list: (args: LaneShareListArgs | undefined, pin: OpenProjectBinding) => Promise<LaneShareListResult>;
        create: (args: LaneShareCreateArgs, pin: OpenProjectBinding) => Promise<LaneShareCreateResult>;
        updateRights: (args: LaneShareUpdateRightsArgs, pin: OpenProjectBinding) => Promise<LaneShareUpdateRightsResult>;
        revoke: (args: { grantId: string }, pin: OpenProjectBinding) => Promise<LaneShareRevokeResult>;
        resendInvite: (args: { grantId: string }, pin: OpenProjectBinding) => Promise<LaneShareResendResult>;
        listReceived: (pin: OpenProjectBinding) => Promise<LaneShareReceivedResult>;
        leave: (args: { grantId: string }, pin: OpenProjectBinding) => Promise<LaneShareLeaveResult>;
        /** A step of a chat move (`LaneShareMoveAction`), on the pinned machine. */
        move: <T = unknown>(action: LaneShareMoveAction, args: Record<string, unknown>, pin: OpenProjectBinding) => Promise<T>;
        /** `lane_share_event` from the pinned machine, else the bound one. */
        onEvent: (cb: (event: LaneShareEvent) => void, pin: OpenProjectBinding) => () => void;
      };
      /**
       * Lane sharing, the guest's side: this account's calls to the account
       * directory (shares given TO it). Account scope, no pin: desktop asks
       * from main with its own token, the web client from its account session.
       */
      laneShareGuest: LaneShareGuestBridge;
      remoteMcpCall: <T = unknown>(
        action: RemoteMcpAction,
        args?: Record<string, unknown>,
        pin?: OpenProjectBinding | null,
      ) => Promise<T>;
      keepAwakeGet: (pin?: OpenProjectBinding | null) => Promise<KeepAwakeSnapshot>;
      keepAwakeSetLevel: (level: KeepAwakeLevel, pin?: OpenProjectBinding | null) => Promise<KeepAwakeSnapshot>;
      keepAwakeFixSystemSleep: (pin?: OpenProjectBinding | null) => Promise<KeepAwakeFixResult>;
      keepAwakeApplyLidClosed: (disabled: boolean, pin?: OpenProjectBinding | null) => Promise<{ ok: boolean; error: string | null }>;
      updateCheckForUpdates: () => Promise<void>;
      /** Can this computer move to `target`? Reads the target build and the local databases. */
      updateCheckTrackSwitch: (target: UpdateTrack) => Promise<TrackSwitchCheckResult>;
      /** Saves the choice and starts the download. Checks again before it does. */
      updateSwitchTrack: (target: UpdateTrack) => Promise<UpdateTrackSwitchResult>;
      updateGetState: () => Promise<AutoUpdateSnapshot>;
      updateGetPreferences: () => Promise<AutoUpdatePreferences>;
      updateSetPreferences: (preferences: AutoUpdatePreferences) => Promise<AutoUpdatePreferences>;
      updateGetInstallImpact: () => Promise<UpdateInstallImpact>;
      updateQuitAndInstall: (options?: { resumeChats?: boolean }) => Promise<boolean>;
      updateCancelAutoApply: () => Promise<boolean>;
      updateDismissInstalledNotice: () => Promise<void>;
      /** Quits and reopens ADE after the usual quit warnings. False when unavailable. */
      updateRelaunchApp: () => Promise<boolean>;
      onUpdateEvent: (cb: (snapshot: AutoUpdateSnapshot) => void) => () => void;
      /** Whether this computer's ADE.app needs a password on every update, and the one-click fix. Absent on the web client. */
      appBundleOwnership?: AppBundleOwnershipBridge;
      /** The database copies ADE took on this computer before updates. Absent on the web client. */
      databaseCopies?: DatabaseCopiesBridge;
      /** Home page widgets backed by the desktop main process. Absent on the web client. */
      home?: HomeWidgetsBridge;
      /** Desktop-local Music: Apple Music playback and Spotify Connect, with catalog and library browsing. */
      music?: MusicBridge;
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
